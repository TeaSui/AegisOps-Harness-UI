// What is running now, what needs the operator, and the push channel that tells the open console
// when to look again. The live-session registry and the transcripts are only ever read.
import { readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';
import type { Indexer } from './indexer.ts';
import { preview } from './redact.ts';
import { sessionRow } from './sessions.ts';

export const TOOL_PENDING_MS = 60_000;
export const RATE_LIMIT_WINDOW_MS = 15 * 60_000;
export const FINDING_WINDOW_MS = 24 * 3600_000;
const MAX_STREAMS = 8;
const PUSH_INTERVAL_MS = 1000;

export type Running = {
  pid: number;
  sessionId: string;
  cwd: string | null;
  status: string;
  statusSince: number | null;
  startedAt: number | null;
  name: string | null;
  kind: string | null;
  entrypoint: string | null;
  version: string | null;
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const str = (v: unknown, max = 300) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Registry entries whose process exists. A missing, malformed or dead process id is not running. */
export function readRunning(claudeHome: string): Running[] {
  const dir = join(claudeHome, 'sessions');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = new Map<string, Running>();
  for (const name of names) {
    if (!/^[^.]+\.json$/.test(name)) continue;
    let entry: any;
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const pid = entry?.pid;
    const sessionId = str(entry?.sessionId, 200);
    if (!Number.isInteger(pid) || pid <= 0 || !sessionId || !processExists(pid)) continue;
    out.set(sessionId, {
      pid,
      sessionId,
      cwd: str(entry.cwd, 1000),
      status: str(entry.status, 60) ?? 'unknown',
      statusSince: num(entry.statusUpdatedAt),
      startedAt: num(entry.startedAt),
      name: str(entry.name),
      kind: str(entry.kind, 60),
      entrypoint: str(entry.entrypoint, 60),
      version: str(entry.version, 60),
    });
  }
  return [...out.values()];
}

export type Attention = { reason: string; session: string; title: string; project: string | null; since: number | null; detail: string; count?: number };
const ORDER = ['integrity', 'question', 'blocked', 'tool_pending', 'rate_limited', 'finding'];

export class Live {
  private db: Db;
  private claudeHome: string;
  private now: () => number;
  private streams = new Set<ServerResponse>();
  private pendingSessions = new Set<string>();
  private pendingLive = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastFlush = 0;
  private signature = '';
  private watchers: FSWatcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private changed = new Set<string>();
  private debounce: NodeJS.Timeout | null = null;

  constructor(db: Db, claudeHome: string, now: () => number) {
    this.db = db;
    this.claudeHome = claudeHome;
    this.now = now;
    this.signature = this.registrySignature();
  }

  runningIds(): Set<string> {
    return new Set(readRunning(this.claudeHome).map((r) => r.sessionId));
  }

  private titleOf(sessionId: string): { title: string; project: string | null } {
    const s = this.db.prepare('SELECT title, project FROM sessions WHERE id = ?').get(sessionId) as { title: string | null; project: string } | undefined;
    return { title: s?.title ?? sessionId, project: s?.project ?? null };
  }

  private reasonsFor(sessionId: string, running: boolean, now: number): Attention[] {
    const db = this.db;
    const out: Attention[] = [];
    const meta = this.titleOf(sessionId);
    if (running) {
      const tool = db
        .prepare('SELECT c.name, c.status, c.ts, c.target FROM tool_calls c JOIN files f ON f.id = c.file_id WHERE c.session_id = ? AND f.agent_id IS NULL ORDER BY c.ts DESC, c.line DESC, c.rowid DESC LIMIT 1')
        .get(sessionId) as { name: string; status: string; ts: number; target: string } | undefined;
      if (tool && tool.status === 'pending') {
        if (tool.name === 'AskUserQuestion') out.push({ reason: 'question', session: sessionId, ...meta, since: tool.ts, detail: 'Waiting for your answer' });
        else if (now - tool.ts > TOOL_PENDING_MS) out.push({ reason: 'tool_pending', session: sessionId, ...meta, since: tool.ts, detail: `${tool.name}: ${preview(tool.target, 160)}` });
      }
      const hook = db.prepare("SELECT status, name, detail, ts FROM events WHERE session_id = ? AND kind = 'hook' ORDER BY ts DESC, id DESC LIMIT 1").get(sessionId) as
        | { status: string; name: string; detail: string | null; ts: number }
        | undefined;
      if (hook?.status === 'blocked') out.push({ reason: 'blocked', session: sessionId, ...meta, since: hook.ts, detail: `${hook.name} hook blocked: ${hook.detail ?? ''}`.trim() });
    }
    return out;
  }

  attention(running: Running[]): Attention[] {
    const db = this.db;
    const now = this.now();
    const out: Attention[] = [];
    for (const a of db.prepare('SELECT session_id, reason, MIN(at) at, COUNT(*) n FROM integrity_alerts WHERE ack_at IS NULL GROUP BY session_id').all() as any[]) {
      out.push({ reason: 'integrity', session: a.session_id, ...this.titleOf(a.session_id), since: a.at, detail: `Transcript ${a.reason}`, count: a.n });
    }
    for (const r of running) out.push(...this.reasonsFor(r.sessionId, true, now));
    const limited = db
      .prepare(
        `SELECT e.session_id, e.ts FROM (
           SELECT session_id, MAX(ts) ts FROM events WHERE kind = 'api_error' AND status = '429' AND ts >= ? GROUP BY session_id
         ) e WHERE NOT EXISTS (SELECT 1 FROM api_calls c WHERE c.session_id = e.session_id AND c.ts > e.ts)`,
      )
      .all(now - RATE_LIMIT_WINDOW_MS) as any[];
    for (const l of limited) {
      if (l.ts > now) continue;
      out.push({ reason: 'rate_limited', session: l.session_id, ...this.titleOf(l.session_id), since: l.ts, detail: 'Rate limited by the API (429), no successful response since' });
    }
    const risky = db
      .prepare(
        `SELECT f.session_id, COUNT(*) n, MAX(f.rank) rank, MIN(f.ts) ts FROM findings f LEFT JOIN triage t ON t.finding_id = f.id
         WHERE f.rank >= 3 AND f.ts >= ? AND COALESCE(t.status, 'open') = 'open' GROUP BY f.session_id`,
      )
      .all(now - FINDING_WINDOW_MS) as any[];
    for (const r of risky) {
      out.push({ reason: 'finding', session: r.session_id, ...this.titleOf(r.session_id), since: r.ts, detail: `${r.n} open ${r.rank >= 4 ? 'critical' : 'high'}-risk finding${r.n === 1 ? '' : 's'}`, count: r.n });
    }
    return out.sort((a, b) => ORDER.indexOf(a.reason) - ORDER.indexOf(b.reason) || (b.since ?? 0) - (a.since ?? 0));
  }

  snapshot() {
    const running = readRunning(this.claudeHome);
    const attention = this.attention(running);
    const sessions = running.map((r) => {
      const row = this.db
        .prepare(
          `SELECT s.*, (SELECT COUNT(*) FROM findings f LEFT JOIN triage t ON t.finding_id = f.id WHERE f.session_id = s.id AND COALESCE(t.status, 'open') = 'open') AS open_findings
           FROM sessions s WHERE s.id = ?`,
        )
        .get(r.sessionId) as any;
      const base = row
        ? sessionRow(row)
        : sessionRow({
            id: r.sessionId, project: '', cwd: r.cwd, title: r.name ?? r.sessionId, first_ts: r.startedAt, last_ts: r.startedAt, version: r.version, entrypoint: r.entrypoint,
            git_branch: null, permission_mode: null, has_main: 0, prompts: 0, models: '[]', api_calls: 0, input: 0, output: 0, cache_read: 0, cache_w5: 0, cache_w1: 0,
            cost: 0, unpriced: 0, reported_cost: null, tool_calls: 0, tool_errors: 0, tool_denied: 0, api_errors: 0, hook_failures: 0, compactions: 0, subagents: 0, risk: 0, findings: 0,
          });
      const lastCall = this.db
        .prepare('SELECT c.input + c.cache_read + c.cache_w5 + c.cache_w1 AS context, c.model, c.ts FROM api_calls c JOIN files f ON f.id = c.file_id WHERE c.session_id = ? AND f.agent_id IS NULL ORDER BY c.ts DESC, c.line DESC LIMIT 1')
        .get(r.sessionId) as { context: number; model: string | null; ts: number } | undefined;
      const lastTool = this.db.prepare('SELECT name, target, status, ts FROM tool_calls WHERE session_id = ? ORDER BY ts DESC, line DESC, rowid DESC LIMIT 1').get(r.sessionId) as any;
      const lastPrompt = this.db.prepare("SELECT text, ts FROM prompts WHERE session_id = ? AND origin IN ('human', 'sdk', 'command') ORDER BY ts DESC, line DESC LIMIT 1").get(r.sessionId) as any;
      return {
        ...base,
        cwd: base.cwd ?? r.cwd,
        live: true,
        pid: r.pid,
        status: r.status,
        statusSince: r.statusSince,
        startedAt: r.startedAt,
        name: r.name,
        kind: r.kind,
        contextTokens: lastCall?.context ?? null,
        currentModel: lastCall?.model ?? null,
        lastTool: lastTool ? { name: lastTool.name, target: preview(lastTool.target, 200), status: lastTool.status, ts: lastTool.ts } : null,
        lastPrompt: lastPrompt ? { text: preview(lastPrompt.text, 240), ts: lastPrompt.ts } : null,
        attention: attention.filter((a) => a.session === r.sessionId).map((a) => a.reason),
      };
    });
    sessions.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
    return { at: this.now(), sessions, attention };
  }

  // ---- push channel ------------------------------------------------------------------------------------

  /** Opens a server-sent event stream. At most 8 at a time. */
  open(res: ServerResponse) {
    if (this.streams.size >= MAX_STREAMS) throw new HttpError(429, 'too_many_streams', 'Too many open consoles');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    this.streams.add(res);
    res.on('close', () => this.streams.delete(res));
  }

  notifyIndex(sessionIds: string[]) {
    for (const id of sessionIds) this.pendingSessions.add(id);
    this.schedule();
  }

  notifyLive() {
    this.pendingLive = true;
    this.schedule();
  }

  private schedule() {
    if (this.flushTimer) return;
    const wait = Math.max(0, PUSH_INTERVAL_MS - (Date.now() - this.lastFlush));
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush() {
    this.flushTimer = null;
    this.lastFlush = Date.now();
    const blocks: string[] = [];
    if (this.pendingSessions.size) {
      blocks.push(`event: index\ndata: ${JSON.stringify({ sessions: [...this.pendingSessions].slice(0, 500), at: this.now() })}\n\n`);
      this.pendingSessions.clear();
    }
    if (this.pendingLive) {
      blocks.push(`event: live\ndata: ${JSON.stringify({ at: this.now() })}\n\n`);
      this.pendingLive = false;
    }
    for (const res of this.streams) for (const b of blocks) res.write(b);
  }

  private registrySignature(): string {
    const dir = join(this.claudeHome, 'sessions');
    try {
      return readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .sort()
        .map((n) => {
          try {
            const st = statSync(join(dir, n));
            return `${n}:${st.size}:${st.mtimeMs}`;
          } catch {
            return n;
          }
        })
        .join('|') + '#' + readRunning(this.claudeHome).map((r) => r.pid).sort().join(',');
    } catch {
      return '';
    }
  }

  /** Checks the registry and pushes a `live` event when it changed. */
  poll() {
    const next = this.registrySignature();
    if (next !== this.signature) {
      this.signature = next;
      this.notifyLive();
    }
  }

  /** Watches the Claude home: indexes changed transcripts and follows the registry. */
  watch(indexer: Indexer) {
    const projects = join(this.claudeHome, 'projects');
    const kick = () => {
      if (this.debounce) return;
      this.debounce = setTimeout(() => {
        this.debounce = null;
        const paths = [...this.changed];
        this.changed.clear();
        void indexer.pass(paths).catch(() => undefined);
      }, 1000);
    };
    try {
      this.watchers.push(
        watch(projects, { recursive: true }, (_event, filename) => {
          if (!filename || !String(filename).endsWith('.jsonl')) return;
          this.changed.add(join(projects, String(filename)));
          kick();
        }),
      );
    } catch {
      /* no recursive watching here: the periodic pass below covers it */
    }
    try {
      this.watchers.push(watch(join(this.claudeHome, 'sessions'), () => this.poll()));
    } catch {
      /* the periodic poll covers it */
    }
    for (const w of this.watchers) w.on('error', () => undefined);
    // Fallbacks for anything the watcher missed, and for processes that died without touching the registry.
    this.timers.push(setInterval(() => void indexer.pass().catch(() => undefined), 15_000));
    this.timers.push(setInterval(() => this.poll(), 3000));
    this.timers.push(setInterval(() => { for (const res of this.streams) res.write(': keep-alive\n\n'); }, 20_000));
    for (const t of this.timers) t.unref();
  }

  close() {
    for (const w of this.watchers) w.close();
    for (const t of this.timers) clearInterval(t);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const res of this.streams) res.end();
    this.streams.clear();
  }
}
