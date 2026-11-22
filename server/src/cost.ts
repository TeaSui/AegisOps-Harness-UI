// Where the money goes: spend and tokens over time by model, project, skill, plugin or agent type.
import type { Db } from './db.ts';
import { badRequest } from './http.ts';

export const GROUPS = ['model', 'project', 'skill', 'plugin', 'agent'] as const;
export type Group = (typeof GROUPS)[number];
export type Bucket = 'hour' | 'day';
const MAX_BUCKETS = 1000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

const GROUP_SQL: Record<Group, string> = {
  model: "COALESCE(c.model, '(none)')",
  project: 's.project',
  skill: "COALESCE(c.skill, '(none)')",
  plugin: "COALESCE(c.plugin, '(none)')",
  agent: "CASE WHEN f.agent_id IS NULL THEN 'main' ELSE COALESCE(f.agent_type, 'subagent') END",
};

type Sum = { cost: number; calls: number; unpriced: number; input: number; output: number; cacheRead: number; cacheWrite: number };
const zero = (): Sum => ({ cost: 0, calls: 0, unpriced: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const add = (a: Sum, r: any) => {
  a.cost += r.cost;
  a.calls += r.calls;
  a.unpriced += r.unpriced;
  a.input += r.input;
  a.output += r.output;
  a.cacheRead += r.cache_read;
  a.cacheWrite += r.cache_write;
};
/** Share of input served from cache; null (shown as "n/a") when there was no input at all. */
const cacheShare = (s: Sum) => {
  const all = s.input + s.cacheRead + s.cacheWrite;
  return all > 0 ? s.cacheRead / all : null;
};

export type Range = { from: number; to: number; bucket: Bucket; tz: number };

/** The time range of a series: defaults to the last 30 local days; bucket starts follow the client's UTC offset. */
export function resolveRange(from: number | null, to: number | null, bucket: Bucket, tz: number, now: number): Range & { starts: number[] } {
  const size = bucket === 'day' ? DAY : HOUR;
  const shift = tz * 60_000;
  const floor = (t: number) => Math.floor((t + shift) / size) * size - shift;
  const end = to ?? now;
  const start = from ?? floor(end) - (bucket === 'day' ? 30 * DAY : 47 * HOUR);
  if (start > end) throw badRequest('from must not be after to');
  const first = floor(start);
  const count = Math.floor((floor(end) - first) / size) + 1;
  if (count > MAX_BUCKETS) throw badRequest(`The range has ${count} ${bucket} buckets; the maximum is ${MAX_BUCKETS}`);
  return { from: start, to: end, bucket, tz, starts: Array.from({ length: count }, (_, i) => first + i * size) };
}

export function costSeries(db: Db, range: ReturnType<typeof resolveRange>, group: Group) {
  const size = range.bucket === 'day' ? DAY : HOUR;
  const shift = range.tz * 60_000;
  const rows = db
    .prepare(
      `SELECT ((c.ts + CAST(? AS INTEGER)) / ${size}) * ${size} - CAST(? AS INTEGER) AS start, ${GROUP_SQL[group]} AS key, COALESCE(SUM(c.cost), 0) cost, COUNT(*) calls,
         COALESCE(SUM(c.cost IS NULL), 0) unpriced, SUM(c.input) input, SUM(c.output) output, SUM(c.cache_read) cache_read, SUM(c.cache_w5 + c.cache_w1) cache_write
       FROM api_calls c JOIN sessions s ON s.id = c.session_id JOIN files f ON f.id = c.file_id
       WHERE c.ts >= ? AND c.ts <= ? GROUP BY 1, 2`,
    )
    .all(shift, shift, range.from, range.to) as any[];
  // Group keys come from transcripts (a model could be named __proto__): keyed objects have no prototype.
  const byStart = new Map<number, { total: Sum; groups: Record<string, Sum> }>(range.starts.map((s) => [s, { total: zero(), groups: Object.create(null) }]));
  const groups = new Map<string, Sum>();
  const totals = zero();
  for (const r of rows) {
    const b = byStart.get(r.start);
    if (!b) continue;
    add(b.total, r);
    add((b.groups[r.key] ??= zero()), r);
    if (!groups.has(r.key)) groups.set(r.key, zero());
    add(groups.get(r.key)!, r);
    add(totals, r);
  }
  const repricing = (db.prepare('SELECT at, detail FROM price_events ORDER BY at DESC, id DESC LIMIT 50').all() as any[]).map((e) => {
    let models: string[] = [];
    let changes: unknown[] = [];
    try {
      const d = JSON.parse(e.detail);
      models = d.models ?? [];
      changes = d.changes ?? [];
    } catch {
      /* keep empty */
    }
    return { at: e.at, models, changes };
  });
  return {
    bucket: range.bucket,
    group,
    tz: range.tz,
    from: range.from,
    to: range.to,
    basis: 'estimated from tokens at the harness price table; unpriced responses are counted, never priced',
    buckets: range.starts.map((start) => {
      const b = byStart.get(start)!;
      return { start, ...b.total, cacheShare: cacheShare(b.total), groups: b.groups };
    }),
    groups: [...groups.entries()].map(([key, s]) => ({ key, ...s, cacheShare: cacheShare(s) })).sort((a, b) => b.cost - a.cost || b.calls - a.calls || a.key.localeCompare(b.key)),
    totals: { ...totals, cacheShare: cacheShare(totals) },
    repricing,
  };
}

export function topSessions(db: Db, from: number, to: number, limit: number) {
  const rows = db
    .prepare(
      `SELECT c.session_id session, s.title, s.project, s.cwd, COALESCE(SUM(c.cost), 0) cost, COUNT(*) calls, COALESCE(SUM(c.cost IS NULL), 0) unpriced,
         SUM(c.input + c.cache_read + c.cache_w5 + c.cache_w1) input, SUM(c.output) output, MIN(c.ts) firstTs, MAX(c.ts) lastTs, s.reported_cost reportedCost
       FROM api_calls c JOIN sessions s ON s.id = c.session_id WHERE c.ts >= ? AND c.ts <= ?
       GROUP BY c.session_id ORDER BY cost DESC, calls DESC, c.session_id LIMIT ?`,
    )
    .all(from, to, limit) as any[];
  return { from, to, items: rows.map((r) => ({ ...r, title: r.title ?? '(untitled)' })) };
}
