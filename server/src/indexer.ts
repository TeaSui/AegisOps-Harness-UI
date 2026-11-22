// Incremental indexer. Reads transcripts read-only, from the byte offset reached by the last pass
// to the last complete line, and turns records into derived rows. Nothing here writes outside the
// index database.
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, constants as FS } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { getMeta, setMeta } from './db.ts';
import { maskDeep, preview } from './redact.ts';
import { costOf, resolveModel, type PriceTable, type Rates } from './pricing.ts';
import { matchRead, matchShell, matchWrite, SEVERITY_RANK, type Finding } from './rules.ts';

const CHUNK = 4 * 1024 * 1024;
export const MAX_LINE = 32 * 1024 * 1024;
const TAIL_WINDOW = 4096;
const REQUEST_LOG_PREFIX = Buffer.from('{"type":"api-request');

/** Record types the indexer knows. Anything else is counted as unknown so format drift is visible. */
export const KNOWN_TYPES = new Set([
  'assistant', 'user', 'system', 'attachment', 'api-request', 'api-request-blob', 'api-request-shape', 'last-prompt', 'session-owner',
  'atis-latch', 'mode', 'ai-title', 'queue-operation', 'permission-mode', 'bridge-session', 'pr-link', 'frame-link', 'tools-used',
  'file-history-snapshot', 'file-history-delta', 'cost-state', 'artifact-autoreact-ledger', 'artifact-comment-monitor', 'summary', 'custom-title',
]);

export type PassStats = { at: number; bytesRead: number; files: number; filesChanged: number; failed: number; durationMs: number };
export type IndexStatus = {
  state: 'idle' | 'indexing';
  files: number;
  sessions: number;
  progress: { done: number; total: number };
  lastPass: PassStats | null;
};

type FileRow = {
  id: number; path: string; project: string; session_id: string; agent_id: string | null; agent_type: string | null;
  size: number; mtime_ms: number; offset: number; lines: number; tail_hash: string; deep_offset: number; deep_hash: string;
  skipped: number; missing: number; cwd: string | null; title: string | null; version: string | null; entrypoint: string | null;
  git_branch: string | null; permission_mode: string | null; first_ts: number | null; last_ts: number | null;
};

type DeepMode = 'none' | 'changed' | 'all';
type Discovered = { path: string; project: string; sessionId: string; agentId: string | null };

export type ToolShape = { category: string; mcpServer: string | null; target: string };

/** Classifies a tool call and extracts the one field that says what it acted on. */
export function shapeTool(name: string, input: any): ToolShape {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (name.startsWith('mcp__')) {
    const end = name.lastIndexOf('__');
    return { category: 'mcp', mcpServer: end > 5 ? name.slice(5, end) : name.slice(5), target: compact(input) };
  }
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { category: 'exec', mcpServer: null, target: str(input?.command) };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return { category: 'write', mcpServer: null, target: str(input?.file_path) };
    case 'NotebookEdit':
      return { category: 'write', mcpServer: null, target: str(input?.notebook_path) || str(input?.file_path) };
    case 'Read':
      return { category: 'read', mcpServer: null, target: str(input?.file_path) };
    case 'Grep':
    case 'Glob':
      return { category: 'read', mcpServer: null, target: [str(input?.pattern), str(input?.path)].filter(Boolean).join('  in  ') };
    case 'WebFetch':
      return { category: 'fetch', mcpServer: null, target: str(input?.url) };
    case 'WebSearch':
      return { category: 'fetch', mcpServer: null, target: str(input?.query) };
    case 'Agent':
    case 'Task':
      return { category: 'agent', mcpServer: null, target: [str(input?.subagent_type), str(input?.description)].filter(Boolean).join(': ') };
    case 'Skill':
      return { category: 'other', mcpServer: null, target: str(input?.skill) };
    default:
      return { category: 'other', mcpServer: null, target: compact(input) };
  }
}

function compact(input: unknown): string {
  try {
    // masked with knowledge of the structure (a value nested under a credential-like key), then as text where it is stored
    return JSON.stringify(maskDeep(input)) ?? '';
  } catch {
    return '';
  }
}

const TOUCH_OP: Record<string, string> = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write' };

/** Where a user message came from, as the harness records it. */
export function promptOrigin(rec: any, text: string): string {
  const kind = rec?.origin?.kind;
  if (typeof kind === 'string') return kind;
  if (rec?.promptSource === 'sdk') return 'sdk';
  if (/^<(?:command-name|command-message)>/.test(text)) return 'command';
  if (/^<(?:local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr)>/.test(text)) return 'local';
  if (/^<task-notification>/.test(text)) return 'task-notification';
  return rec?.promptSource === 'system' ? 'system' : 'human';
}

export class Indexer {
  private db: Db;
  private claudeHome: string;
  private projectsDir: string;
  private prices: PriceTable;
  private loadPrices: () => PriceTable;
  private queue: Promise<unknown> = Promise.resolve();
  private status: IndexStatus = { state: 'idle', files: 0, sessions: 0, progress: { done: 0, total: 0 }, lastPass: null };
  private st: Record<string, any> = {};
  private deepPending = true;
  onChange: (sessionIds: string[]) => void = () => {};

  private now: () => number;

  private maxLine: number;
  /** Whether the price table could be read at the last pass (the prices in use may be older, kept ones). */
  priceSourceReadable = true;

  constructor(db: Db, claudeHome: string, loadPrices: () => PriceTable, now: () => number = Date.now, maxLine = MAX_LINE) {
    this.db = db;
    this.maxLine = maxLine;
    this.now = now;
    this.claudeHome = claudeHome;
    this.projectsDir = join(claudeHome, 'projects');
    this.loadPrices = loadPrices;
    this.prices = loadPrices();
    this.priceSourceReadable = this.prices.readable;
    this.prepare();
  }

  /** After the derived tables were recreated: prepared statements refer to the old tables. */
  reset() {
    this.prepare();
    this.deepPending = false;
  }

  get priceTable() {
    return this.prices;
  }

  getStatus(): IndexStatus {
    const files = (this.db.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n;
    const sessions = (this.db.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n;
    return { ...this.status, files, sessions };
  }

  /** Runs one pass over every transcript (or only the given paths). Passes never overlap. */
  pass(paths?: string[], options: { deep?: boolean } = {}): Promise<PassStats> {
    // deep: re-hash the whole indexed prefix of every file, changed or not (the on-request integrity check).
    const run = this.queue.then(() => this.runPass(paths, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private prepare() {
    const p = (sql: string) => this.db.prepare(sql);
    this.st = {
      fileByPath: p('SELECT * FROM files WHERE path = ?'),
      insertFile: p('INSERT INTO files(path, project, session_id, agent_id, agent_type) VALUES(?, ?, ?, ?, ?)'),
      updateFile: p(
        `UPDATE files SET size = ?, mtime_ms = ?, offset = ?, lines = ?, tail_hash = ?, deep_offset = ?, deep_hash = ?, skipped = ?, missing = 0,
           cwd = ?, title = ?, version = ?, entrypoint = ?, git_branch = ?, permission_mode = ?, first_ts = ?, last_ts = ?, agent_type = ? WHERE id = ?`,
      ),
      upsertCall: p(
        `INSERT INTO api_calls(message_id, file_id, session_id, agent_id, ts, model, input, output, cache_read, cache_w5, cache_w1, cost, skill, plugin, line)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET model = excluded.model, input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
           cache_w5 = excluded.cache_w5, cache_w1 = excluded.cache_w1, cost = excluded.cost,
           skill = COALESCE(excluded.skill, api_calls.skill), plugin = COALESCE(excluded.plugin, api_calls.plugin)
         WHERE api_calls.file_id = excluded.file_id`,
      ),
      insertTool: p(
        `INSERT OR IGNORE INTO tool_calls(id, file_id, session_id, agent_id, ts, name, category, mcp_server, target, cwd, line, skill)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      toolTs: p('SELECT ts FROM tool_calls WHERE id = ?'),
      finishTool: p(
        `UPDATE tool_calls SET status = ?, denial_kind = ?, perm_decision = ?, perm_source = ?, perm_reason = ?, result_ts = ?, duration_ms = ?, result_line = ?
         WHERE id = ? AND status = 'pending'`,
      ),
      insertEvent: p('INSERT INTO events(file_id, session_id, agent_id, ts, kind, name, status, duration_ms, detail, a, b, line) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      insertPrompt: p('INSERT INTO prompts(file_id, session_id, ts, line, origin, text) VALUES(?, ?, ?, ?, ?, ?)'),
      insertFinding: p(
        `INSERT INTO findings(id, file_id, session_id, tool_call_id, rule_id, severity, rank, evidence, ts, line) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ),
      bumpType: p('INSERT INTO type_counts(file_id, type, n) VALUES(?, ?, 1) ON CONFLICT(file_id, type) DO UPDATE SET n = n + 1'),
      touch: p('INSERT INTO file_touch(file_id, session_id, path, op, n) VALUES(?, ?, ?, ?, 1) ON CONFLICT(file_id, path, op) DO UPDATE SET n = n + 1'),
      costState: p('INSERT INTO cost_state(file_id, session_id, start_time, total) VALUES(?, ?, ?, ?) ON CONFLICT(file_id, start_time) DO UPDATE SET total = excluded.total'),
      link: p('INSERT OR IGNORE INTO links(file_id, session_id, url, label) VALUES(?, ?, ?, ?)'),
      search: p('INSERT INTO search(text, session_id, file_id, line, kind) VALUES(?, ?, ?, ?, ?)'),
      alert: p('INSERT INTO integrity_alerts(path, session_id, at, reason, old_size, new_size) VALUES(?, ?, ?, ?, ?, ?)'),
    };
  }

  private discover(): Discovered[] {
    const out: Discovered[] = [];
    let projects: string[] = [];
    try {
      projects = readdirSync(this.projectsDir).sort();
    } catch {
      return out;
    }
    for (const project of projects) {
      const dir = join(this.projectsDir, project);
      let entries: string[];
      try {
        if (!lstatSync(dir).isDirectory()) continue;
        entries = readdirSync(dir).sort(); // a stable order: a response id copied into a fork stays with the first file
      } catch {
        continue;
      }
      for (const name of entries) {
        const p = join(dir, name);
        if (name.endsWith('.jsonl')) {
          if (isRegularFile(p)) out.push({ path: p, project, sessionId: name.slice(0, -6), agentId: null });
          continue;
        }
        const sub = join(p, 'subagents');
        let agents: string[];
        try {
          if (!lstatSync(p).isDirectory() || !lstatSync(sub).isDirectory()) continue;
          agents = readdirSync(sub);
        } catch {
          continue;
        }
        for (const a of agents) {
          if (!a.endsWith('.jsonl')) continue;
          const ap = join(sub, a);
          if (isRegularFile(ap)) out.push({ path: ap, project, sessionId: name, agentId: a.slice(0, -6).replace(/^agent-/, '') });
        }
      }
    }
    return out;
  }

  private async runPass(paths: string[] | undefined, options: { deep?: boolean }): Promise<PassStats> {
    const started = Date.now();
    this.refreshPrices();
    const all = this.discover();
    const wanted = paths ? new Set(paths) : null;
    const targets = wanted ? all.filter((d) => wanted.has(d.path)) : all;
    // At start, files that changed while Aegis was not running get the deep check; on request, every file does.
    const deep: DeepMode = options.deep ? 'all' : this.deepPending && !wanted ? 'changed' : 'none';
    this.status = { ...this.status, state: 'indexing', progress: { done: 0, total: targets.length } };
    const dirty = new Set<string>();
    let bytesRead = 0;
    let filesChanged = 0;
    let failed = 0;
    try {
      for (const d of targets) {
        let read = 0;
        try {
          read = await this.indexFile(d, deep, dirty);
        } catch {
          // one unreadable file must not stop the pass, nor the summaries of the files already read
          failed++;
          dirty.add(d.sessionId);
        }
        if (read > 0) filesChanged++;
        bytesRead += read;
        this.status.progress.done++;
        if (read > 0) await yieldToLoop();
      }
      if (!wanted) {
        const seen = new Set(all.map((d) => d.path));
        const rows = this.db.prepare('SELECT id, path, session_id FROM files WHERE missing = 0').all() as Array<{ id: number; path: string; session_id: string }>;
        for (const row of rows) {
          if (!seen.has(row.path)) {
            this.db.prepare('UPDATE files SET missing = 1 WHERE id = ?').run(row.id);
            dirty.add(row.session_id);
          }
        }
        this.deepPending = false;
      }
      if (dirty.size) {
        this.rollup([...dirty]);
        this.savePriceState(this.prices);
      }
    } finally {
      this.status.state = 'idle';
    }
    const stats = { at: Date.now(), bytesRead, files: targets.length, filesChanged, failed, durationMs: Date.now() - started };
    this.status.lastPass = stats;
    if (dirty.size) this.onChange([...dirty]);
    return stats;
  }

  /**
   * Recomputes stored costs when the harness's price table changed, and records the event with the
   * rates before and after for each model whose price changed. An unreadable table changes nothing.
   */
  private refreshPrices() {
    const next = this.loadPrices();
    this.priceSourceReadable = next.readable;
    const stored = getMeta(this.db, 'price_hash');
    if (!next.readable) {
      // The last good prices stand, also across a restart: they are rebuilt from what was stored.
      if (stored !== undefined && this.prices.models.size === 0) this.prices = this.storedPrices(stored);
      return;
    }
    this.prices = next;
    if (stored === next.hash) return;
    const rates = (model: string | null) => {
      const id = resolveModel(next, model);
      return id === null ? null : next.models.get(id)!;
    };
    {
      let before: Record<string, unknown> = {};
      try {
        before = JSON.parse(getMeta(this.db, 'price_rates') ?? '{}');
      } catch {
        before = {};
      }
      const models = (this.db.prepare('SELECT DISTINCT model FROM api_calls').all() as Array<{ model: string | null }>).map((m) => m.model);
      const changes: Array<{ model: string; before: unknown; after: unknown }> = [];
      this.db.exec('BEGIN');
      try {
        for (const model of models) {
          const r = rates(model);
          const was = model !== null && Object.hasOwn(before, model) ? before[model] : null;
          if (JSON.stringify(was) === JSON.stringify(r)) continue;
          if (model) changes.push({ model, before: was, after: r });
          if (r === null) this.db.prepare('UPDATE api_calls SET cost = NULL WHERE model IS ?').run(model);
          else {
            this.db
              .prepare('UPDATE api_calls SET cost = (input * ? + output * ? + cache_read * ? + cache_w5 * ? + cache_w1 * ?) / 1e6 WHERE model IS ?')
              .run(r.input, r.output, r.cacheRead, r.cacheWrite5m, r.cacheWrite1h, model);
          }
        }
        if (changes.length) {
          changes.sort((a, b) => a.model.localeCompare(b.model));
          this.db.prepare('INSERT INTO price_events(at, detail) VALUES(?, ?)').run(this.now(), JSON.stringify({ models: changes.map((c) => c.model), changes }));
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
      if (changes.length) {
        const sessions = (this.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>).map((x) => x.id);
        if (sessions.length) this.rollup(sessions);
      }
    }
    this.savePriceState(next);
  }

  /** The prices in force when the table was last readable, as stored with the index. */
  private storedPrices(hash: string): PriceTable {
    const models = new Map<string, Rates>();
    try {
      for (const [model, r] of Object.entries(JSON.parse(getMeta(this.db, 'price_rates') ?? '{}') as Record<string, Rates | null>)) if (r) models.set(model, r);
    } catch {
      /* nothing stored: every model is unpriced until the table can be read */
    }
    return { models, hash, readable: false };
  }

  /** Remembers the rates each indexed model was priced at, so the next change can say what it was before. */
  private savePriceState(table: PriceTable) {
    if (!this.priceSourceReadable) return; // never overwrite the last good state with an outage
    const out: Record<string, unknown> = {};
    for (const { model } of this.db.prepare('SELECT DISTINCT model FROM api_calls WHERE model IS NOT NULL').all() as Array<{ model: string }>) {
      const id = resolveModel(table, model);
      out[model] = id === null ? null : table.models.get(id)!;
    }
    setMeta(this.db, 'price_rates', JSON.stringify(out));
    setMeta(this.db, 'price_hash', table.hash);
  }

  private purge(fileId: number) {
    for (const t of ['api_calls', 'tool_calls', 'events', 'prompts', 'findings', 'type_counts', 'file_touch', 'cost_state', 'links']) {
      this.db.prepare(`DELETE FROM ${t} WHERE file_id = ?`).run(fileId);
    }
    this.db.prepare('DELETE FROM search WHERE file_id = ?').run(fileId);
  }

  /** Indexes one file from its stored offset. Returns the bytes read. */
  private async indexFile(d: Discovered, deep: DeepMode, dirty: Set<string>): Promise<number> {
    let fd: number;
    try {
      fd = openSync(d.path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
    } catch {
      return 0;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return 0;
      let row = this.st.fileByPath.get(d.path) as FileRow | undefined;
      if (!row) {
        this.st.insertFile.run(d.path, d.project, d.sessionId, d.agentId, d.agentId ? this.agentType(d.path) : null);
        row = this.st.fileByPath.get(d.path) as FileRow;
        dirty.add(d.sessionId);
      }
      if (row.missing) dirty.add(d.sessionId);
      const size = stat.size;
      const unchanged = size === row.size && stat.mtimeMs === row.mtime_ms && !row.missing;
      if (unchanged && deep !== 'all') return 0;

      // Integrity: an indexed prefix must still be there, byte for byte.
      let reason: string | null = null;
      if (size < row.offset) reason = 'truncated';
      else if (row.offset > 0 && tailHash(fd, row.offset) !== row.tail_hash) reason = 'rewritten';
      else if (deep !== 'none' && row.deep_offset > 0 && hashRange(fd, 0, row.deep_offset) !== row.deep_hash) reason = 'rewritten';
      if (reason) {
        this.st.alert.run(d.path, d.sessionId, this.now(), reason, row.offset, size);
        this.db.exec('BEGIN');
        this.purge(row.id);
        this.db.exec('COMMIT');
        row = { ...row, offset: 0, lines: 0, skipped: 0, deep_offset: 0, deep_hash: '', tail_hash: '', cwd: null, title: null, version: null, entrypoint: null, git_branch: null, permission_mode: null, first_ts: null, last_ts: null };
        dirty.add(d.sessionId);
      }

      const start = row.offset;
      const ctx = { row: { ...row }, d, line: row.lines, skipped: row.skipped };
      // `committed` is the file position just after the last complete line that was ingested.
      let committed = start;
      let carry: Buffer[] = [];
      let carryLen = 0;
      let oversize = false;
      const buf = Buffer.allocUnsafe(CHUNK);
      let pos = start;
      let read = 0;
      const save = (deepOffset: number, deepHash: string) => {
        const r = ctx.row;
        this.st.updateFile.run(
          size, stat.mtimeMs, committed, ctx.line, tailHash(fd, committed), deepOffset, deepHash, ctx.skipped,
          r.cwd, r.title, r.version, r.entrypoint, r.git_branch, r.permission_mode, r.first_ts, r.last_ts,
          d.agentId ? (row!.agent_type ?? this.agentType(d.path)) : null, row!.id,
        );
      };

      while (pos < size) {
        const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
        if (n <= 0) break;
        read += n;
        // One transaction per chunk: the rows and the offset they were read up to commit together.
        this.db.exec('BEGIN');
        try {
          let lineStart = 0;
          for (;;) {
            const nl = buf.subarray(0, n).indexOf(0x0a, lineStart);
            if (nl === -1) break;
            ctx.line++;
            if (oversize) {
              oversize = false;
              ctx.skipped++;
            } else {
              const piece = buf.subarray(lineStart, nl);
              if (carryLen + piece.length > this.maxLine) ctx.skipped++;
              else this.ingestLine(ctx, carryLen ? Buffer.concat([...carry, piece]) : piece);
            }
            carry = [];
            carryLen = 0;
            lineStart = nl + 1;
            committed = pos + lineStart;
          }
          if (lineStart < n && !oversize) {
            if (carryLen + (n - lineStart) > this.maxLine) {
              // Too large to hold: drop what was buffered and skip to the line's end.
              oversize = true;
              carry = [];
              carryLen = 0;
            } else {
              carry.push(Buffer.from(buf.subarray(lineStart, n)));
              carryLen += n - lineStart;
            }
          }
          save(row.deep_offset, row.deep_hash);
          this.db.exec('COMMIT');
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        }
        pos += n;
        if (pos < size) await yieldToLoop();
      }

      // The deep hash covers the whole indexed prefix. It is taken on a first index and on a deep check.
      const deepNow = start === 0 || deep !== 'none';
      save(deepNow ? committed : row.deep_offset, deepNow ? hashRange(fd, 0, committed) : row.deep_hash);
      if (read > 0 || reason) dirty.add(d.sessionId);
      return read;
    } finally {
      closeSync(fd);
    }
  }

  private agentType(path: string): string | null {
    try {
      const meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      return typeof meta?.agentType === 'string' ? meta.agentType : null;
    } catch {
      return null;
    }
  }

  private ingestLine(ctx: { row: FileRow; d: Discovered; line: number; skipped: number }, lineBuf: Buffer) {
    if (lineBuf.length === 0) return;
    if (lineBuf.length >= REQUEST_LOG_PREFIX.length && lineBuf.subarray(0, REQUEST_LOG_PREFIX.length).equals(REQUEST_LOG_PREFIX)) {
      // The harness's API request log: large, and nothing Aegis derives comes from it.
      this.st.bumpType.run(ctx.row.id, 'api-request*');
      return;
    }
    let rec: any;
    try {
      rec = JSON.parse(lineBuf.toString('utf8'));
    } catch {
      ctx.skipped++;
      return;
    }
    if (rec === null || typeof rec !== 'object') {
      ctx.skipped++;
      return;
    }
    try {
      this.ingest(ctx, rec);
    } catch {
      // A record of an unexpected shape must never stop the pass.
      ctx.skipped++;
    }
  }

  private ingest(ctx: { row: FileRow; d: Discovered; line: number }, rec: any) {
    const row = ctx.row;
    const fileId = row.id;
    const sid = ctx.d.sessionId;
    const agentId = ctx.d.agentId;
    const line = ctx.line;
    const type = typeof rec.type === 'string' ? rec.type : '(none)';
    this.st.bumpType.run(fileId, type);

    let ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (row.first_ts === null || ts < row.first_ts) row.first_ts = ts;
      if (row.last_ts === null || ts > row.last_ts) row.last_ts = ts;
    } else {
      ts = row.last_ts ?? 0;
    }
    if (typeof rec.cwd === 'string') row.cwd = rec.cwd;
    if (typeof rec.version === 'string') row.version = rec.version;
    if (typeof rec.entrypoint === 'string') row.entrypoint = rec.entrypoint;
    if (typeof rec.gitBranch === 'string' && rec.gitBranch) row.git_branch = rec.gitBranch;
    const mode = type === 'permission-mode' ? rec.permissionMode : type === 'user' ? rec.permissionMode : undefined;
    if (typeof mode === 'string' && mode !== row.permission_mode) {
      this.st.insertEvent.run(fileId, sid, agentId, ts, 'permission_mode', mode, row.permission_mode, null, null, null, null, line);
      row.permission_mode = mode;
      if (mode === 'bypassPermissions') {
        this.st.insertFinding.run(`${sid}:perm.bypass-mode`, fileId, sid, null, 'perm.bypass-mode', 'high', SEVERITY_RANK.high, 'permission mode: bypassPermissions', ts, line);
      }
    }

    switch (type) {
      case 'assistant':
        this.ingestAssistant(ctx, rec, ts);
        break;
      case 'user':
        this.ingestUser(ctx, rec, ts);
        break;
      case 'system':
        if (rec.subtype === 'compact_boundary') {
          const m = rec.compactMetadata ?? {};
          this.st.insertEvent.run(fileId, sid, agentId, ts, 'compaction', String(m.trigger ?? ''), null, intOrNull(m.durationMs), null, intOrNull(m.preTokens), intOrNull(m.postTokens), line);
        } else if (rec.subtype === 'turn_duration') {
          this.st.insertEvent.run(fileId, sid, agentId, ts, 'turn', null, null, intOrNull(rec.durationMs), null, intOrNull(rec.messageCount), null, line);
        } else if (rec.subtype === 'stop_hook_summary' && Array.isArray(rec.hookInfos)) {
          // Stop hooks are recorded as one summary per stop; each entry is one run.
          for (const h of rec.hookInfos.slice(0, 50)) {
            this.st.insertEvent.run(fileId, sid, agentId, ts, 'hook', 'Stop', 'run', intOrNull(h?.durationMs), preview(String(h?.command ?? ''), 400), null, null, line);
          }
        }
        break;
      case 'attachment': {
        const a = rec.attachment;
        const kind = a?.type;
        if (kind === 'hook_success' || kind === 'hook_non_blocking_error' || kind === 'hook_blocking_error') {
          const event = String(a.hookEvent ?? a.hookName ?? 'hook');
          const status = kind === 'hook_success' ? 'success' : kind === 'hook_blocking_error' ? 'blocked' : 'error';
          // A successful Stop hook is already counted by its summary entry.
          if (!(status === 'success' && (event === 'Stop' || event === 'SubagentStop') )) {
            const command = String(a.command ?? a.blockingError?.command ?? '');
            this.st.insertEvent.run(fileId, sid, agentId, ts, 'hook', event, status, intOrNull(a.durationMs), preview(command, 400), null, null, line);
          }
        }
        break;
      }
      case 'ai-title':
      case 'custom-title':
        if (typeof (rec.aiTitle ?? rec.customTitle) === 'string') row.title = preview(rec.aiTitle ?? rec.customTitle, 200);
        break;
      case 'cost-state':
        if (Number.isFinite(rec.startTime) && Number.isFinite(rec.totalCostUSD)) this.st.costState.run(fileId, sid, Math.trunc(rec.startTime), rec.totalCostUSD);
        break;
      case 'pr-link':
        if (typeof rec.prUrl === 'string' && /^https?:\/\//.test(rec.prUrl)) {
          this.st.link.run(fileId, sid, preview(rec.prUrl, 500), preview(`${rec.prRepository ?? ''}#${rec.prNumber ?? ''}`, 200));
        }
        break;
      default:
        break;
    }
  }

  private ingestAssistant(ctx: { row: FileRow; d: Discovered; line: number }, rec: any, ts: number) {
    const { row, d, line } = ctx;
    const m = rec.message;
    if (rec.isApiErrorMessage || rec.apiErrorStatus) {
      this.st.insertEvent.run(row.id, d.sessionId, d.agentId, ts, 'api_error', String(rec.error ?? 'api_error'), String(rec.apiErrorStatus ?? ''), null, null, null, null, line);
      return;
    }
    if (!m || typeof m !== 'object') return;
    const skill = typeof rec.attributionSkill === 'string' ? rec.attributionSkill : null;
    const plugin = typeof rec.attributionPlugin === 'string' ? rec.attributionPlugin : null;
    if (typeof m.id === 'string' && m.id && m.model !== '<synthetic>' && m.usage && typeof m.usage === 'object') {
      const u = m.usage;
      const split = u.cache_creation && typeof u.cache_creation === 'object';
      const tokens = {
        input: int(u.input_tokens),
        output: int(u.output_tokens),
        cacheRead: int(u.cache_read_input_tokens),
        cacheWrite5m: split ? int(u.cache_creation.ephemeral_5m_input_tokens) : int(u.cache_creation_input_tokens),
        cacheWrite1h: split ? int(u.cache_creation.ephemeral_1h_input_tokens) : 0,
      };
      const model = typeof m.model === 'string' && m.model ? m.model : null;
      this.st.upsertCall.run(
        m.id, row.id, d.sessionId, d.agentId, ts, model, tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite5m, tokens.cacheWrite1h,
        costOf(this.prices, model, tokens), skill, plugin, line,
      );
    }
    if (!Array.isArray(m.content)) return;
    for (const block of m.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        this.st.search.run(preview(block.text, 8000), d.sessionId, row.id, line, 'reply');
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const shape = shapeTool(block.name, block.input);
        const cwd = typeof rec.cwd === 'string' ? rec.cwd : row.cwd;
        const target = preview(shape.target, 2000);
        this.st.insertTool.run(block.id, row.id, d.sessionId, d.agentId, ts, block.name.slice(0, 200), shape.category, shape.mcpServer, target, cwd, line, skill);
        // searchable targets are commands, file paths, URLs and patterns; the inputs of other tools are not indexed
        if (target && ['exec', 'write', 'read', 'fetch'].includes(shape.category)) this.st.search.run(target, d.sessionId, row.id, line, 'tool');
        const op = TOUCH_OP[block.name];
        if (op && shape.target) this.st.touch.run(row.id, d.sessionId, preview(shape.target, 1000), op);
        let findings: Finding[] = [];
        if (shape.category === 'exec') findings = matchShell(shape.target);
        else if (block.name === 'Read') findings = matchRead(shape.target);
        else if (shape.category === 'write') findings = matchWrite(shape.target, { cwd: cwd ?? '', claudeHome: this.claudeHome });
        for (const f of findings) {
          this.st.insertFinding.run(`${block.id}:${f.ruleId}`, row.id, d.sessionId, block.id, f.ruleId, f.severity, SEVERITY_RANK[f.severity], preview(f.evidence, 600), ts, line);
        }
      }
    }
  }

  private ingestUser(ctx: { row: FileRow; d: Discovered; line: number }, rec: any, ts: number) {
    const { row, d, line } = ctx;
    const content = rec.message?.content;
    const texts: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const perm = rec.permissionDecision && typeof rec.permissionDecision === 'object' ? rec.permissionDecision : null;
          const denial = typeof rec.toolDenialKind === 'string' ? rec.toolDenialKind : null;
          const status = denial || perm?.decision === 'reject' ? 'denied' : block.is_error ? 'error' : 'ok';
          const started = this.st.toolTs.get(block.tool_use_id) as { ts: number } | undefined;
          if (!started) continue; // a result with no call is ignored
          this.st.finishTool.run(
            status, denial, perm ? String(perm.decision ?? '') : null, perm ? String(perm.source ?? '') : null,
            perm ? String(perm.reasonType ?? perm.reasonCode ?? '') : null, ts, Math.max(0, ts - started.ts), line, block.tool_use_id,
          );
        }
      }
    }
    if (rec.isMeta || rec.isCompactSummary || texts.length === 0) return;
    const text = texts.join('\n').trim();
    if (!text) return;
    const origin = promptOrigin(rec, text);
    const shown = preview(text, 4000);
    this.st.insertPrompt.run(row.id, d.sessionId, ts, line, origin, shown);
    if (origin === 'human' || origin === 'sdk' || origin === 'command') this.st.search.run(shown, d.sessionId, row.id, line, 'prompt');
  }

  /** Recomputes the per-session summary rows from the derived tables. */
  rollup(sessionIds: string[]) {
    const db = this.db;
    db.exec('BEGIN');
    try {
      for (const sid of sessionIds) {
        const files = db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY agent_id IS NOT NULL, id').all(sid) as FileRow[];
        if (files.length === 0) {
          db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
          continue;
        }
        const main = files.find((f) => f.agent_id === null);
        const lead = main ?? files[0];
        const firstTs = minOf(files.map((f) => f.first_ts));
        const lastTs = maxOf(files.map((f) => f.last_ts));
        const calls = db
          .prepare(
            `SELECT COUNT(*) n, COALESCE(SUM(input), 0) input, COALESCE(SUM(output), 0) output, COALESCE(SUM(cache_read), 0) cache_read,
               COALESCE(SUM(cache_w5), 0) w5, COALESCE(SUM(cache_w1), 0) w1, COALESCE(SUM(cost), 0) cost, COALESCE(SUM(cost IS NULL), 0) unpriced
             FROM api_calls WHERE session_id = ?`,
          )
          .get(sid) as any;
        const models = (db.prepare('SELECT model, COUNT(*) n FROM api_calls WHERE session_id = ? AND model IS NOT NULL GROUP BY model ORDER BY n DESC').all(sid) as any[]).map((r) => r.model);
        // one figure per process run (its start time), whichever of the session's files recorded it
        const reported = db.prepare('SELECT COUNT(*) runs, SUM(total) total FROM (SELECT MAX(total) total FROM cost_state WHERE session_id = ? GROUP BY start_time)').get(sid) as any;
        const tools = db
          .prepare("SELECT COUNT(*) n, COALESCE(SUM(status = 'error'), 0) errors, COALESCE(SUM(status = 'denied'), 0) denied FROM tool_calls WHERE session_id = ?")
          .get(sid) as any;
        const ev = db
          .prepare(
            `SELECT COALESCE(SUM(kind = 'api_error'), 0) api_errors, COALESCE(SUM(kind = 'hook' AND status IN ('error', 'blocked')), 0) hook_failures,
               COALESCE(SUM(kind = 'compaction'), 0) compactions FROM events WHERE session_id = ?`,
          )
          .get(sid) as any;
        const prompts = db.prepare("SELECT COUNT(*) n FROM prompts WHERE session_id = ? AND origin IN ('human', 'sdk', 'command')").get(sid) as any;
        const firstPrompt = db.prepare("SELECT text FROM prompts WHERE session_id = ? AND origin IN ('human', 'sdk') ORDER BY ts, line LIMIT 1").get(sid) as any;
        const risk = db.prepare('SELECT COALESCE(MAX(rank), 0) risk, COUNT(*) n FROM findings WHERE session_id = ?').get(sid) as any;
        const title = lead.title ?? (firstPrompt ? oneLine(firstPrompt.text, 120) : null);
        db.prepare(
          `INSERT INTO sessions(id, project, cwd, title, first_ts, last_ts, version, entrypoint, git_branch, permission_mode, has_main, prompts, models,
             api_calls, input, output, cache_read, cache_w5, cache_w1, cost, unpriced, reported_cost, reported_runs, tool_calls, tool_errors, tool_denied,
             api_errors, hook_failures, compactions, subagents, risk, findings)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET project = excluded.project, cwd = excluded.cwd, title = excluded.title, first_ts = excluded.first_ts,
             last_ts = excluded.last_ts, version = excluded.version, entrypoint = excluded.entrypoint, git_branch = excluded.git_branch,
             permission_mode = excluded.permission_mode, has_main = excluded.has_main, prompts = excluded.prompts, models = excluded.models,
             api_calls = excluded.api_calls, input = excluded.input, output = excluded.output, cache_read = excluded.cache_read, cache_w5 = excluded.cache_w5,
             cache_w1 = excluded.cache_w1, cost = excluded.cost, unpriced = excluded.unpriced, reported_cost = excluded.reported_cost,
             reported_runs = excluded.reported_runs, tool_calls = excluded.tool_calls, tool_errors = excluded.tool_errors, tool_denied = excluded.tool_denied,
             api_errors = excluded.api_errors, hook_failures = excluded.hook_failures, compactions = excluded.compactions, subagents = excluded.subagents,
             risk = excluded.risk, findings = excluded.findings`,
        ).run(
          sid, lead.project, lead.cwd, title, firstTs, lastTs, lead.version, lead.entrypoint, lead.git_branch, lead.permission_mode, main ? 1 : 0, prompts.n,
          JSON.stringify(models), calls.n, calls.input, calls.output, calls.cache_read, calls.w5, calls.w1, calls.cost, calls.unpriced,
          reported.runs > 0 ? reported.total : null, reported.runs, tools.n, tools.errors, tools.denied, ev.api_errors, ev.hook_failures, ev.compactions,
          files.filter((f) => f.agent_id !== null).length, risk.risk, risk.n,
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
const intOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const minOf = (xs: Array<number | null>) => xs.reduce<number | null>((m, x) => (x === null ? m : m === null || x < m ? x : m), null);
const maxOf = (xs: Array<number | null>) => xs.reduce<number | null>((m, x) => (x === null ? m : m === null || x > m ? x : m), null);
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

function isRegularFile(p: string) {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function hashRange(fd: number, from: number, to: number): string {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let pos = from;
  while (pos < to) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, to - pos), pos);
    if (n <= 0) break;
    h.update(buf.subarray(0, n));
    pos += n;
  }
  return h.digest('hex');
}

function tailHash(fd: number, offset: number): string {
  if (offset <= 0) return '';
  return hashRange(fd, Math.max(0, offset - TAIL_WINDOW), offset);
}

