// Session timelines and raw records, read from the transcript on demand (the index holds only
// pointers). Everything returned is masked; the one exception is the explicit per-record reveal.
import { relative } from 'node:path';
import type { Db } from './db.ts';
import { notFound } from './http.ts';
import { MAX_LINE, promptOrigin, shapeTool } from './indexer.ts';
import { forEachLine, realPathInside } from './lines.ts';
import { mask, maskDeep } from './redact.ts';

const TEXT_MAX = 4000;
const RECORD_MAX = 256 * 1024;
const REQUEST_LOG_PREFIX = Buffer.from('{"type":"api-request');

type FileRef = { id: number; path: string; offset: number; lines: number; session_id: string; agent_id: string | null; missing: number };

export type Item = { kind: string; ts: number; file: number; line: number } & Record<string, unknown>;

function cut(text: string, max = TEXT_MAX): { text: string; truncated: boolean } {
  const masked = mask(text.length > max * 4 ? text.slice(0, max * 4) : text);
  return masked.length > max || text.length > max * 4 ? { text: masked.slice(0, max), truncated: true } : { text: masked, truncated: false };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

export class Timelines {
  private db: Db;
  private claudeHome: string;
  private projectsDir: string;
  private cache = new Map<string, Item[]>();

  private maxLine: number;

  constructor(db: Db, claudeHome: string, projectsDir: string, maxLine = MAX_LINE) {
    this.db = db;
    this.maxLine = maxLine;
    this.claudeHome = claudeHome;
    this.projectsDir = projectsDir;
  }

  /** Resolves a session (and optionally one of its agents) to an indexed file. Request values never become paths. */
  fileOf(sessionId: string, agentId: string | null): FileRef {
    const row = (
      agentId === null
        ? this.db.prepare('SELECT * FROM files WHERE session_id = ? AND agent_id IS NULL').get(sessionId)
        : this.db.prepare('SELECT * FROM files WHERE session_id = ? AND agent_id = ?').get(sessionId, agentId)
    ) as FileRef | undefined;
    if (row) return row;
    if (agentId === null) {
      // a session with no main transcript: fall back to its first subagent file
      const any = this.db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY first_ts LIMIT 1').get(sessionId) as FileRef | undefined;
      if (any) return any;
    }
    throw notFound();
  }

  private fileById(id: number): FileRef {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRef | undefined;
    if (!row) throw notFound();
    return row;
  }

  private readable(file: FileRef) {
    if (file.missing || !realPathInside(file.path, this.projectsDir)) throw notFound();
  }

  timeline(sessionId: string, agentId: string | null, offset: number, limit: number) {
    const file = this.fileOf(sessionId, agentId);
    this.readable(file);
    const key = `${file.id}:${file.offset}`;
    let items = this.cache.get(key);
    if (!items) {
      items = this.build(file);
      this.cache.set(key, items);
      if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
    }
    return { file: file.id, agentId: file.agent_id, total: items.length, offset, limit, items: items.slice(offset, offset + limit) };
  }

  private build(file: FileRef): Item[] {
    const items: Item[] = [];
    const tools = new Map<string, Item>();
    let lastTs = 0;
    let mode: string | null = null;
    forEachLine(file.path, file.offset, this.maxLine, (buf, line) => {
      if (!buf || buf.length === 0) return;
      if (buf.length >= REQUEST_LOG_PREFIX.length && buf.subarray(0, REQUEST_LOG_PREFIX.length).equals(REQUEST_LOG_PREFIX)) return;
      let rec: any;
      try {
        rec = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (!rec || typeof rec !== 'object') return;
      try {
        const parsed = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
        const ts = Number.isFinite(parsed) ? parsed : lastTs;
        lastTs = ts;
        const at = { ts, file: file.id, line };
        const newMode = rec.type === 'permission-mode' || rec.type === 'user' ? rec.permissionMode : undefined;
        if (typeof newMode === 'string' && newMode !== mode) {
          items.push({ kind: 'permission_mode', ...at, mode: newMode, from: mode });
          mode = newMode;
        }
        if (rec.type === 'assistant') this.assistant(rec, at, items, tools);
        else if (rec.type === 'user') this.user(rec, at, items, tools);
        else if (rec.type === 'system') this.system(rec, at, items);
        else if (rec.type === 'attachment') this.attachment(rec, at, items);
      } catch {
        /* a record of an unexpected shape is left out of the timeline */
      }
    });
    // a stable number per row: several blocks of one response share a line, a time and a response id
    items.forEach((item, i) => (item.seq = i));
    return items;
  }

  private assistant(rec: any, at: { ts: number; file: number; line: number }, items: Item[], tools: Map<string, Item>) {
    const m = rec.message;
    if (rec.isApiErrorMessage || rec.apiErrorStatus) {
      items.push({ kind: 'api_error', ...at, error: String(rec.error ?? 'api_error'), status: String(rec.apiErrorStatus ?? ''), ...cut(resultText(m?.content), 600) });
      return;
    }
    if (!m || !Array.isArray(m.content)) return;
    const messageId = typeof m.id === 'string' ? m.id : null;
    const model = typeof m.model === 'string' ? m.model : null;
    for (const block of m.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        items.push({ kind: 'reply', ...at, messageId, model, ...cut(block.text) });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        items.push({ kind: 'thinking', ...at, messageId, ...cut(block.thinking, 2000) });
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        if (tools.has(block.id)) continue;
        const shape = shapeTool(block.name, block.input);
        let input = '';
        try {
          input = JSON.stringify(maskDeep(block.input), null, 2) ?? '';
        } catch {
          input = '';
        }
        const item: Item = {
          kind: 'tool',
          ...at,
          id: block.id,
          messageId,
          name: block.name,
          category: shape.category,
          mcpServer: shape.mcpServer,
          target: cut(shape.target, 4000).text,
          input: input.length > TEXT_MAX ? input.slice(0, TEXT_MAX) : input,
          inputTruncated: input.length > TEXT_MAX,
          status: 'pending',
          durationMs: null,
          denialKind: null,
          allowedBy: null,
          result: null,
          subagent: null,
          skill: typeof rec.attributionSkill === 'string' ? rec.attributionSkill : null,
        };
        tools.set(block.id, item);
        items.push(item);
      }
    }
  }

  private user(rec: any, at: { ts: number; file: number; line: number }, items: Item[], tools: Map<string, Item>) {
    const content = rec.message?.content;
    const texts: string[] = [];
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const item = tools.get(block.tool_use_id);
          if (!item || item.status !== 'pending') continue;
          const perm = rec.permissionDecision && typeof rec.permissionDecision === 'object' ? rec.permissionDecision : null;
          const denial = typeof rec.toolDenialKind === 'string' ? rec.toolDenialKind : null;
          item.status = denial || perm?.decision === 'reject' ? 'denied' : block.is_error ? 'error' : 'ok';
          item.denialKind = denial;
          item.allowedBy = perm ? { decision: String(perm.decision ?? ''), source: String(perm.source ?? ''), reason: String(perm.reasonType ?? perm.reasonCode ?? '') } : null;
          item.durationMs = Math.max(0, at.ts - item.ts);
          item.result = { line: at.line, ts: at.ts, ...cut(resultText(block.content)) };
          const spawned = rec.toolUseResult?.agentId;
          if (typeof spawned === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(spawned)) item.subagent = spawned;
        }
      }
    }
    if (rec.isMeta || rec.isCompactSummary || texts.length === 0) return;
    const text = texts.join('\n').trim();
    if (!text) return;
    items.push({ kind: 'prompt', ...at, origin: promptOrigin(rec, text), ...cut(text) });
  }

  private system(rec: any, at: { ts: number; file: number; line: number }, items: Item[]) {
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
    if (rec.subtype === 'compact_boundary') {
      const m = rec.compactMetadata ?? {};
      const pre = n(m.preTokens);
      const post = n(m.postTokens);
      items.push({ kind: 'compaction', ...at, trigger: String(m.trigger ?? ''), preTokens: pre, postTokens: post, freed: pre !== null && post !== null ? pre - post : null, durationMs: n(m.durationMs) });
    } else if (rec.subtype === 'turn_duration') {
      items.push({ kind: 'turn', ...at, durationMs: n(rec.durationMs), messages: n(rec.messageCount) });
    } else if (rec.subtype === 'stop_hook_summary' && Array.isArray(rec.hookInfos) && rec.hookInfos.length) {
      items.push({
        kind: 'stop_hooks',
        ...at,
        hooks: rec.hookInfos.slice(0, 50).map((h: any) => ({ command: cut(String(h?.command ?? ''), 300).text, durationMs: n(h?.durationMs) })),
        errors: Array.isArray(rec.hookErrors) ? rec.hookErrors.length : 0,
        prevented: rec.preventedContinuation === true,
      });
    } else if (rec.subtype === 'local_command' && rec.commandRun) {
      items.push({ kind: 'command', ...at, name: String(rec.commandRun.command ?? '').slice(0, 100), args: cut(String(rec.commandRun.args ?? ''), 300).text });
    }
  }

  private attachment(rec: any, at: { ts: number; file: number; line: number }, items: Item[]) {
    const a = rec.attachment;
    const kind = a?.type;
    if (kind !== 'hook_success' && kind !== 'hook_non_blocking_error' && kind !== 'hook_blocking_error') return;
    const event = String(a.hookEvent ?? a.hookName ?? 'hook');
    const status = kind === 'hook_success' ? 'success' : kind === 'hook_blocking_error' ? 'blocked' : 'error';
    if (status === 'success' && (event === 'Stop' || event === 'SubagentStop')) return; // shown by the stop summary
    const detail = [a.stderr, a.blockingError?.blockingError, status === 'success' ? '' : a.stdout].filter((s) => typeof s === 'string' && s.trim()).join('\n');
    items.push({
      kind: 'hook',
      ...at,
      event,
      name: String(a.hookName ?? event).slice(0, 200),
      status,
      command: cut(String(a.command ?? a.blockingError?.command ?? ''), 400).text,
      durationMs: typeof a.durationMs === 'number' ? Math.trunc(a.durationMs) : null,
      exitCode: typeof a.exitCode === 'number' ? a.exitCode : null,
      detail: cut(detail, 1500).text,
    });
  }

  /** One transcript line, masked unless reveal is set. Served only for an indexed file and a line inside its indexed range. */
  record(fileId: number, line: number, reveal: boolean) {
    const file = this.fileById(fileId);
    if (!Number.isInteger(line) || line < 1 || line > file.lines) throw notFound();
    this.readable(file);
    let found: Buffer | null | undefined;
    forEachLine(file.path, file.offset, this.maxLine, (buf, n) => {
      if (n === line) {
        found = buf ? Buffer.from(buf) : null;
        return false;
      }
    });
    if (found === undefined) throw notFound();
    const base = { file: file.id, line, session: file.session_id, agentId: file.agent_id, path: relative(this.claudeHome, file.path) };
    if (found === null) return { ...base, text: '', truncated: true, masked: !reveal, note: 'This line is larger than the line limit and is not shown.' };
    const raw = found.toString('utf8');
    let text = raw;
    try {
      const value = JSON.parse(raw);
      text = JSON.stringify(reveal ? value : maskDeep(value), null, 2);
    } catch {
      text = reveal ? raw : mask(raw);
    }
    const truncated = text.length > RECORD_MAX;
    return { ...base, text: truncated ? text.slice(0, RECORD_MAX) : text, truncated, masked: !reveal };
  }
}

export function contextSeries(db: Db, file: { id: number }) {
  const calls = (
    db
      .prepare('SELECT message_id, ts, model, input, output, cache_read, cache_w5, cache_w1, cost, line FROM api_calls WHERE file_id = ? ORDER BY ts, line')
      .all(file.id) as any[]
  ).map((r) => ({
    messageId: r.message_id,
    ts: r.ts,
    model: r.model,
    context: r.input + r.cache_read + r.cache_w5 + r.cache_w1,
    input: r.input,
    output: r.output,
    cacheRead: r.cache_read,
    cacheWrite: r.cache_w5 + r.cache_w1,
    cost: r.cost,
    file: file.id,
    line: r.line,
  }));
  const compactions = (db.prepare("SELECT ts, name, a, b, line FROM events WHERE file_id = ? AND kind = 'compaction' ORDER BY ts, line").all(file.id) as any[]).map((r) => ({
    ts: r.ts,
    trigger: r.name,
    preTokens: r.a,
    postTokens: r.b,
    freed: r.a !== null && r.b !== null ? r.a - r.b : null,
    line: r.line,
    file: file.id,
  }));
  return { calls, compactions };
}

export function filesTouched(db: Db, sessionId: string) {
  const rows = db
    .prepare(
      `SELECT path, COALESCE(SUM(CASE WHEN op = 'read' THEN n END), 0) read, COALESCE(SUM(CASE WHEN op = 'edit' THEN n END), 0) edit,
         COALESCE(SUM(CASE WHEN op = 'write' THEN n END), 0) write FROM file_touch WHERE session_id = ? GROUP BY path ORDER BY path LIMIT 5000`,
    )
    .all(sessionId) as any[];
  return { items: rows.map((r) => ({ path: mask(r.path), read: r.read, edit: r.edit, write: r.write })), total: rows.length };
}
