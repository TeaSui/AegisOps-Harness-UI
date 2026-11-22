// Session list, search and summary queries.
import type { Db } from './db.ts';
import { badRequest, notFound } from './http.ts';
import { SEVERITY_RANK, severityOfRank, type Severity } from './rules.ts';

export const MARK_OPEN = '\u0002';
export const MARK_CLOSE = '\u0003';

export type SessionFilter = {
  q: string | null;
  project: string | null;
  model: string | null;
  entrypoint: string | null;
  from: number | null;
  to: number | null;
  errors: boolean;
  risk: Severity | null;
  ids: string[] | null;
  sort: 'last' | 'cost' | 'duration';
  limit: number;
  offset: number;
};

const usageOf = (r: any) => ({ input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite5m: r.cache_w5, cacheWrite1h: r.cache_w1 });

export function sessionRow(r: any) {
  return {
    id: r.id,
    project: r.project,
    cwd: r.cwd,
    title: r.title ?? '(untitled)',
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    durationMs: r.first_ts !== null && r.last_ts !== null ? r.last_ts - r.first_ts : null,
    version: r.version,
    entrypoint: r.entrypoint,
    gitBranch: r.git_branch,
    permissionMode: r.permission_mode,
    hasMain: r.has_main === 1,
    prompts: r.prompts,
    models: JSON.parse(r.models) as string[],
    apiCalls: r.api_calls,
    usage: usageOf(r),
    cost: r.cost,
    unpricedCalls: r.unpriced,
    reportedCost: r.reported_cost,
    toolCalls: r.tool_calls,
    toolErrors: r.tool_errors,
    toolDenied: r.tool_denied,
    apiErrors: r.api_errors,
    hookFailures: r.hook_failures,
    compactions: r.compactions,
    subagents: r.subagents,
    risk: severityOfRank(r.risk),
    findings: r.findings,
    openFindings: r.open_findings ?? 0,
  };
}

/** Words of a user query as an FTS expression: every word required, each matched as a prefix. */
export function ftsExpression(q: string): string {
  const words = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (q.trim().length < 2 || words.length === 0) throw badRequest('q must be at least 2 characters');
  if (words.length > 12) throw badRequest('q has too many words');
  return words.map((w) => `"${w.slice(0, 60)}"*`).join(' ');
}

const OPEN_FINDINGS = `(SELECT COUNT(*) FROM findings f LEFT JOIN triage t ON t.finding_id = f.id
  WHERE f.session_id = s.id AND COALESCE(t.status, 'open') = 'open') AS open_findings`;

export function listSessions(db: Db, f: SessionFilter) {
  const where: string[] = [];
  const args: any[] = [];
  let fts: string | null = null;
  if (f.q) {
    fts = ftsExpression(f.q);
    where.push('s.id IN (SELECT session_id FROM search WHERE search MATCH ?)');
    args.push(fts);
  }
  if (f.project) {
    where.push('s.project = ?');
    args.push(f.project);
  }
  if (f.model) {
    where.push('EXISTS (SELECT 1 FROM json_each(s.models) WHERE value = ?)');
    args.push(f.model);
  }
  if (f.entrypoint) {
    where.push('s.entrypoint = ?');
    args.push(f.entrypoint);
  }
  if (f.from !== null) {
    where.push('s.last_ts >= ?');
    args.push(f.from);
  }
  if (f.to !== null) {
    where.push('s.first_ts <= ?');
    args.push(f.to);
  }
  if (f.errors) where.push('(s.tool_errors > 0 OR s.api_errors > 0 OR s.hook_failures > 0)');
  if (f.risk) {
    where.push('s.risk >= ?');
    args.push(SEVERITY_RANK[f.risk]);
  }
  if (f.ids) {
    if (f.ids.length === 0) return { items: [], total: 0, limit: f.limit, offset: f.offset };
    where.push(`s.id IN (${f.ids.map(() => '?').join(', ')})`);
    args.push(...f.ids);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = f.sort === 'cost' ? 's.cost DESC, s.last_ts DESC' : f.sort === 'duration' ? '(s.last_ts - s.first_ts) DESC' : 's.last_ts DESC, s.id';
  const total = (db.prepare(`SELECT COUNT(*) n FROM sessions s ${clause}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT s.*, ${OPEN_FINDINGS} FROM sessions s ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, f.limit, f.offset) as any[];
  const items = rows.map(sessionRow) as Array<ReturnType<typeof sessionRow> & { snippets?: Array<{ kind: string; text: string; file: number; line: number }> }>;
  if (fts && items.length) {
    const wanted = new Map(items.map((s) => [s.id, s]));
    const hits = db
      .prepare(`SELECT session_id, file_id, line, kind, snippet(search, 0, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 14) AS text FROM search WHERE search MATCH ? LIMIT 20000`)
      .all(fts) as any[];
    for (const h of hits) {
      const s = wanted.get(h.session_id);
      if (!s) continue;
      s.snippets ??= [];
      if (s.snippets.length < 3) s.snippets.push({ kind: h.kind, text: h.text, file: h.file_id, line: h.line });
    }
  }
  return { items, total, limit: f.limit, offset: f.offset };
}

export function getSession(db: Db, id: string) {
  const r = db.prepare(`SELECT s.*, ${OPEN_FINDINGS} FROM sessions s WHERE s.id = ?`).get(id) as any;
  if (!r) throw notFound();
  const files = db.prepare('SELECT id, agent_id, agent_type, missing, lines, skipped, first_ts, last_ts FROM files WHERE session_id = ? ORDER BY agent_id IS NOT NULL, first_ts').all(id) as any[];
  const perAgent = db
    .prepare(
      `SELECT file_id, COUNT(*) n, COALESCE(SUM(input), 0) input, COALESCE(SUM(output), 0) output, COALESCE(SUM(cache_read), 0) cache_read,
         COALESCE(SUM(cache_w5), 0) cache_w5, COALESCE(SUM(cache_w1), 0) cache_w1, COALESCE(SUM(cost), 0) cost, COALESCE(SUM(cost IS NULL), 0) unpriced
       FROM api_calls WHERE session_id = ? GROUP BY file_id`,
    )
    .all(id) as any[];
  const toolsPerFile = db.prepare('SELECT file_id, COUNT(*) n FROM tool_calls WHERE session_id = ? GROUP BY file_id').all(id) as any[];
  const byFile = new Map(perAgent.map((a) => [a.file_id, a]));
  const toolsByFile = new Map(toolsPerFile.map((a) => [a.file_id, a.n]));
  const zero = { n: 0, input: 0, output: 0, cache_read: 0, cache_w5: 0, cache_w1: 0, cost: 0, unpriced: 0 };
  const agents = files.map((f) => {
    const a = byFile.get(f.id) ?? zero;
    return {
      file: f.id,
      agentId: f.agent_id,
      agentType: f.agent_id === null ? 'main' : (f.agent_type ?? 'subagent'),
      firstTs: f.first_ts,
      lastTs: f.last_ts,
      apiCalls: a.n,
      toolCalls: toolsByFile.get(f.id) ?? 0,
      usage: usageOf(a),
      cost: a.cost,
      unpricedCalls: a.unpriced,
      sourceRemoved: f.missing === 1,
    };
  });
  const links = db.prepare('SELECT url, label FROM links WHERE session_id = ? ORDER BY url').all(id);
  const row = sessionRow(r);
  return {
    ...row,
    cost: {
      estimated: r.cost,
      unpricedCalls: r.unpriced,
      basis: 'estimated from tokens',
      reported: r.reported_cost,
      reportedRuns: r.reported_runs,
      reportedBasis: 'harness-reported, a lower bound: a killed process writes no total',
    },
    agents,
    links,
    sourceRemoved: files.some((f) => f.missing === 1),
    skippedLines: files.reduce((n, f) => n + f.skipped, 0),
    resumeCommand: row.hasMain ? `claude --resume ${id}` : null,
  };
}

export function projects(db: Db) {
  return db
    .prepare(
      `SELECT project AS id, MAX(cwd) AS cwd, COUNT(*) AS sessions, MAX(last_ts) AS lastTs, COALESCE(SUM(cost), 0) AS cost
       FROM sessions GROUP BY project ORDER BY lastTs DESC`,
    )
    .all();
}

export function facets(db: Db) {
  const models = (db.prepare('SELECT DISTINCT value AS model FROM sessions, json_each(sessions.models) ORDER BY 1').all() as any[]).map((r) => r.model);
  const entrypoints = (db.prepare('SELECT DISTINCT entrypoint FROM sessions WHERE entrypoint IS NOT NULL ORDER BY 1').all() as any[]).map((r) => r.entrypoint);
  return { models, entrypoints };
}
