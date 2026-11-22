// The audit views: a cross-session ledger of what ran, risk findings with triage, integrity alerts
// and exports. Everything served here was masked when it was indexed.
import type { ServerResponse } from 'node:http';
import { relative } from 'node:path';
import type { Db } from './db.ts';
import { badRequest, notFound } from './http.ts';
import { mask } from './redact.ts';
import { RULES, ruleById, SEVERITY_RANK, type Severity } from './rules.ts';

export const LEDGER_CATEGORIES = ['exec', 'write', 'fetch', 'mcp', 'agent'] as const;
export const OUTCOMES = ['ok', 'error', 'denied', 'pending'] as const;
export const EXPORT_MAX = 100_000;

export type LedgerFilter = {
  tool: string | null;
  category: (typeof LEDGER_CATEGORIES)[number] | null;
  project: string | null;
  session: string | null;
  outcome: (typeof OUTCOMES)[number] | null;
  from: number | null;
  to: number | null;
  q: string | null;
};

const allowedBy = (r: any) => (r.perm_decision === null ? 'not recorded' : [r.perm_decision, r.perm_source, r.perm_reason].filter((v) => v !== null && v !== '').join(' · '));
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => '\\' + ch);

function ledgerWhere(f: LedgerFilter) {
  const where = [`c.category IN (${LEDGER_CATEGORIES.map((c) => `'${c}'`).join(', ')})`];
  const args: any[] = [];
  const eq = (column: string, value: string | number | null) => {
    if (value === null) return;
    where.push(`${column} = ?`);
    args.push(value);
  };
  eq('c.name', f.tool);
  eq('c.category', f.category);
  eq('s.project', f.project);
  eq('c.session_id', f.session);
  eq('c.status', f.outcome);
  if (f.from !== null) {
    where.push('c.ts >= ?');
    args.push(f.from);
  }
  if (f.to !== null) {
    where.push('c.ts <= ?');
    args.push(f.to);
  }
  if (f.q) {
    where.push("c.target LIKE ? ESCAPE '\\'");
    args.push(`%${likeEscape(f.q)}%`);
  }
  return { clause: `FROM tool_calls c JOIN sessions s ON s.id = c.session_id WHERE ${where.join(' AND ')}`, args };
}

const LEDGER_COLUMNS = `c.id, c.ts, c.session_id, s.project, s.cwd AS session_cwd, s.title, c.agent_id, c.name, c.category, c.mcp_server, c.target, c.status, c.denial_kind,
  c.perm_decision, c.perm_source, c.perm_reason, c.duration_ms, c.file_id, c.line,
  (SELECT group_concat(rule_id) FROM findings WHERE tool_call_id = c.id) AS rules`;

const ledgerRow = (r: any) => ({
  id: r.id,
  ts: r.ts,
  session: r.session_id,
  sessionTitle: r.title,
  project: r.project,
  cwd: r.session_cwd,
  agentId: r.agent_id,
  tool: r.name,
  category: r.category,
  mcpServer: r.mcp_server,
  target: r.target,
  outcome: r.status,
  denialKind: r.denial_kind,
  allowedBy: allowedBy(r),
  durationMs: r.duration_ms,
  file: r.file_id,
  line: r.line,
  findings: r.rules ? String(r.rules).split(',').sort() : [],
});

export function ledger(db: Db, f: LedgerFilter, limit: number, offset: number) {
  const { clause, args } = ledgerWhere(f);
  const total = (db.prepare(`SELECT COUNT(*) n ${clause}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT ${LEDGER_COLUMNS} ${clause} ORDER BY c.ts DESC, c.line DESC, c.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
  const tools = (db.prepare(`SELECT name, COUNT(*) n FROM tool_calls WHERE category IN (${LEDGER_CATEGORIES.map((c) => `'${c}'`).join(', ')}) GROUP BY name ORDER BY n DESC LIMIT 200`).all() as any[]).map((t) => t.name);
  return { items: rows.map(ledgerRow), total, limit, offset, tools };
}

export type FindingFilter = {
  severity: Severity | null;
  state: 'open' | 'acknowledged' | null;
  rule: string | null;
  project: string | null;
  session: string | null;
  from: number | null;
  to: number | null;
};

function findingWhere(f: FindingFilter) {
  const where: string[] = ['1 = 1'];
  const args: any[] = [];
  if (f.severity) {
    where.push('f.rank >= ?');
    args.push(SEVERITY_RANK[f.severity]);
  }
  if (f.state) {
    where.push("COALESCE(t.status, 'open') = ?");
    args.push(f.state);
  }
  if (f.rule) {
    where.push('f.rule_id = ?');
    args.push(f.rule);
  }
  if (f.project) {
    where.push('s.project = ?');
    args.push(f.project);
  }
  if (f.session) {
    where.push('f.session_id = ?');
    args.push(f.session);
  }
  if (f.from !== null) {
    where.push('f.ts >= ?');
    args.push(f.from);
  }
  if (f.to !== null) {
    where.push('f.ts <= ?');
    args.push(f.to);
  }
  return {
    clause: `FROM findings f JOIN sessions s ON s.id = f.session_id LEFT JOIN triage t ON t.finding_id = f.id
             LEFT JOIN tool_calls c ON c.id = f.tool_call_id WHERE ${where.join(' AND ')}`,
    args,
  };
}

const FINDING_COLUMNS = `f.id, f.ts, f.severity, f.rule_id, f.evidence, f.session_id, s.project, s.cwd, s.title AS session_title, f.tool_call_id, c.name AS tool,
  c.status AS outcome, f.file_id, f.line, COALESCE(t.status, 'open') AS state, COALESCE(t.note, '') AS note, t.at AS noted_at`;

const findingRow = (r: any) => ({
  id: r.id,
  ts: r.ts,
  severity: r.severity,
  rule: r.rule_id,
  title: ruleById(r.rule_id)?.title ?? r.rule_id,
  evidence: r.evidence,
  state: r.state,
  note: r.note,
  notedAt: r.noted_at ?? null,
  session: r.session_id,
  sessionTitle: r.session_title,
  project: r.project,
  cwd: r.cwd,
  toolCall: r.tool_call_id,
  tool: r.tool ?? null,
  outcome: r.outcome ?? null,
  file: r.file_id,
  line: r.line,
});

export function findings(db: Db, f: FindingFilter, limit: number, offset: number) {
  const { clause, args } = findingWhere(f);
  const total = (db.prepare(`SELECT COUNT(*) n ${clause}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT ${FINDING_COLUMNS} ${clause} ORDER BY f.ts DESC, f.rank DESC, f.id LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
  const summary = db
    .prepare(
      `SELECT f.severity, COUNT(*) total, COALESCE(SUM(COALESCE(t.status, 'open') = 'open'), 0) open
       FROM findings f LEFT JOIN triage t ON t.finding_id = f.id GROUP BY f.severity`,
    )
    .all() as any[];
  const byRule = db
    .prepare(
      `SELECT f.rule_id rule, COUNT(*) total, COALESCE(SUM(COALESCE(t.status, 'open') = 'open'), 0) open
       FROM findings f LEFT JOIN triage t ON t.finding_id = f.id GROUP BY f.rule_id`,
    )
    .all() as any[];
  const counts = new Map(byRule.map((r) => [r.rule, r]));
  return {
    items: rows.map(findingRow),
    total,
    limit,
    offset,
    summary,
    rules: RULES.map((r) => ({ ...r, total: counts.get(r.id)?.total ?? 0, open: counts.get(r.id)?.open ?? 0 })),
  };
}

/** Sets a finding's triage state. The note is masked and capped before it is stored. */
export function triage(db: Db, id: string, body: any, now: number) {
  const state = body?.state;
  if (state !== 'open' && state !== 'acknowledged') throw badRequest('state must be open or acknowledged');
  const note = body?.note ?? '';
  if (typeof note !== 'string' || note.length > 2000) throw badRequest('note must be text of at most 2000 characters');
  if (!db.prepare('SELECT 1 FROM findings WHERE id = ?').get(id)) throw notFound();
  db.prepare('INSERT INTO triage(finding_id, status, note, at) VALUES(?, ?, ?, ?) ON CONFLICT(finding_id) DO UPDATE SET status = excluded.status, note = excluded.note, at = excluded.at').run(
    id,
    state,
    mask(note),
    now,
  );
  return { id, state, note: mask(note), notedAt: now };
}

export function integrity(db: Db, claudeHome: string) {
  const items = (db.prepare('SELECT * FROM integrity_alerts ORDER BY at DESC, id DESC LIMIT 1000').all() as any[]).map((a) => ({
    id: a.id,
    path: relative(claudeHome, a.path),
    session: a.session_id,
    at: a.at,
    reason: a.reason,
    oldSize: a.old_size,
    newSize: a.new_size,
    ackAt: a.ack_at,
    ackNote: a.ack_note,
  }));
  const sourceRemoved = (db.prepare('SELECT path, session_id, agent_id FROM files WHERE missing = 1 ORDER BY session_id LIMIT 1000').all() as any[]).map((f) => ({
    path: relative(claudeHome, f.path),
    session: f.session_id,
    agentId: f.agent_id,
  }));
  const checked = db.prepare('SELECT COUNT(*) files, COALESCE(SUM(deep_offset), 0) bytes FROM files WHERE missing = 0').get() as any;
  return { items, open: items.filter((a) => a.ackAt === null).length, sourceRemoved, verified: { files: checked.files, bytes: checked.bytes } };
}

export function ackIntegrity(db: Db, id: number, body: any, now: number) {
  const note = body?.note ?? '';
  if (typeof note !== 'string' || note.length > 2000) throw badRequest('note must be text of at most 2000 characters');
  // the first acknowledgement stands: acknowledging again changes nothing
  db.prepare('UPDATE integrity_alerts SET ack_at = ?, ack_note = ? WHERE id = ? AND ack_at IS NULL').run(now, mask(note), id);
  const row = db.prepare('SELECT ack_at FROM integrity_alerts WHERE id = ?').get(id) as { ack_at: number } | undefined;
  if (!row) throw notFound();
  return { id, ackAt: row.ack_at };
}

// ---- exports ----------------------------------------------------------------------------------------

/** RFC 4180 cell, with spreadsheet formulas neutralised. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Column = { header: string; key: string; get: (row: any) => unknown };
const iso = (ms: number | null) => (typeof ms === 'number' ? new Date(ms).toISOString() : '');

const LEDGER_EXPORT: Column[] = [
  { header: 'time', key: 'time', get: (r) => iso(r.ts) },
  { header: 'session', key: 'session', get: (r) => r.session },
  { header: 'project', key: 'project', get: (r) => r.project },
  { header: 'agent', key: 'agent', get: (r) => r.agentId ?? '' },
  { header: 'tool', key: 'tool', get: (r) => r.tool },
  { header: 'category', key: 'category', get: (r) => r.category },
  { header: 'target', key: 'target', get: (r) => r.target },
  { header: 'outcome', key: 'outcome', get: (r) => r.outcome },
  { header: 'denial kind', key: 'denialKind', get: (r) => r.denialKind ?? '' },
  { header: 'allowed by', key: 'allowedBy', get: (r) => r.allowedBy },
  { header: 'duration ms', key: 'durationMs', get: (r) => r.durationMs ?? '' },
  { header: 'file', key: 'file', get: (r) => r.file },
  { header: 'line', key: 'line', get: (r) => r.line },
];

const FINDING_EXPORT: Column[] = [
  { header: 'time', key: 'time', get: (r) => iso(r.ts) },
  { header: 'severity', key: 'severity', get: (r) => r.severity },
  { header: 'rule', key: 'rule', get: (r) => r.rule },
  { header: 'title', key: 'title', get: (r) => r.title },
  { header: 'evidence', key: 'evidence', get: (r) => r.evidence },
  { header: 'state', key: 'state', get: (r) => r.state },
  { header: 'note', key: 'note', get: (r) => r.note },
  { header: 'session', key: 'session', get: (r) => r.session },
  { header: 'project', key: 'project', get: (r) => r.project },
  { header: 'tool call', key: 'toolCall', get: (r) => r.toolCall ?? '' },
  { header: 'file', key: 'file', get: (r) => r.file },
  { header: 'line', key: 'line', get: (r) => r.line },
];

/** Streams a list as CSV or JSON Lines. Returns the number of rows written. */
function stream(res: ServerResponse, name: string, format: 'csv' | 'jsonl', columns: Column[], total: number, rows: Iterable<any>, now: number): number {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  res.writeHead(200, {
    'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    'Content-Disposition': `attachment; filename="aegis-${name}-${stamp}.${format}"`,
    'X-Aegis-Export-Rows': String(Math.min(total, EXPORT_MAX)),
    'X-Aegis-Export-Truncated': total > EXPORT_MAX ? '1' : '0',
  });
  if (format === 'csv') res.write(columns.map((c) => csvCell(c.header)).join(',') + '\r\n');
  let n = 0;
  try {
    for (const row of rows) {
      if (format === 'csv') res.write(columns.map((c) => csvCell(c.get(row))).join(',') + '\r\n');
      else res.write(JSON.stringify(Object.fromEntries(columns.map((c) => [c.key, c.get(row)]))) + '\n');
      n++;
    }
  } catch (e) {
    // a file that stops half-way must not look complete: the connection is cut instead of ended
    res.destroy();
    throw e;
  }
  res.end();
  return n;
}

export function exportLedger(db: Db, f: LedgerFilter, format: 'csv' | 'jsonl', res: ServerResponse, now: number): number {
  const { clause, args } = ledgerWhere(f);
  const total = (db.prepare(`SELECT COUNT(*) n ${clause}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT ${LEDGER_COLUMNS} ${clause} ORDER BY c.ts DESC, c.line DESC, c.id DESC LIMIT ${EXPORT_MAX}`).iterate(...args);
  return stream(res, 'ledger', format, LEDGER_EXPORT, total, mapIter(rows, ledgerRow), now);
}

export function exportFindings(db: Db, f: FindingFilter, format: 'csv' | 'jsonl', res: ServerResponse, now: number): number {
  const { clause, args } = findingWhere(f);
  const total = (db.prepare(`SELECT COUNT(*) n ${clause}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT ${FINDING_COLUMNS} ${clause} ORDER BY f.ts DESC, f.rank DESC, f.id LIMIT ${EXPORT_MAX}`).iterate(...args);
  return stream(res, 'findings', format, FINDING_EXPORT, total, mapIter(rows, findingRow), now);
}

function* mapIter<T, U>(it: Iterable<T>, fn: (x: T) => U): Iterable<U> {
  for (const x of it) yield fn(x);
}
