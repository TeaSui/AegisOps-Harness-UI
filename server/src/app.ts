// Composition root: wires the index, the queries and the HTTP front door together.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lockStateDir, openDb, prepareStateDir, type Db } from './db.ts';
import { Indexer, KNOWN_TYPES } from './indexer.ts';
import { loadPrices } from './pricing.ts';
import { FrontDoor, Router, enumParam, optEnumParam, optIntParam, page, strParam } from './http.ts';
import { facets, getSession, listSessions, projects } from './sessions.ts';
import { Timelines, contextSeries, filesTouched } from './timeline.ts';
import { Activity } from './activity.ts';
import { LEDGER_CATEGORIES, OUTCOMES, ackIntegrity, exportFindings, exportLedger, findings, integrity, ledger, triage, type FindingFilter, type LedgerFilter } from './audit.ts';
import { rebuild } from './db.ts';
import { HANDLED } from './http.ts';
import { intParam, notFound } from './http.ts';

export const VERSION = '0.1.0';

export type AppOptions = {
  claudeHome: string;
  configFile: string;
  stateDir: string;
  port: number;
  /** Watch the Claude home and index on change. Tests turn this off and call index() themselves. */
  watch: boolean;
  quiet: boolean;
  control?: boolean;
  claudeBin?: string;
  staticDir?: string;
  now?: () => number;
};

export type App = {
  port: number;
  /** The address the listener is bound to: always loopback. */
  address: string;
  token: string;
  url: string;
  index: (options?: { deep?: boolean }) => Promise<void>;
  /** Drops the derived tables and indexes everything again. Triage and alerts are kept. */
  rebuild: () => Promise<void>;
  close: () => Promise<void>;
};

export type Deps = { db: Db; indexer: Indexer; options: AppOptions; now: () => number; stateDir: string; activity: Activity; timelines: Timelines };

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export async function createApp(options: AppOptions): Promise<App> {
  const stateDir = prepareStateDir(options.stateDir, options.claudeHome);
  const unlock = lockStateDir(stateDir);
  const db = openDb(stateDir);
  const indexer = new Indexer(db, options.claudeHome, () => loadPrices(options.configFile));
  const now = options.now ?? Date.now;
  const activity = new Activity(stateDir, now);
  const timelines = new Timelines(db, options.claudeHome, join(options.claudeHome, 'projects'));
  const deps: Deps = { db, indexer, options, now, stateDir, activity, timelines };
  const router = new Router();

  router.get('/api/overview', () => {
    const totals = db
      .prepare(
        `SELECT COUNT(*) sessions, COALESCE(SUM(cost), 0) cost, COALESCE(SUM(unpriced), 0) unpricedCalls, COALESCE(SUM(api_calls), 0) apiCalls,
           COALESCE(SUM(tool_calls), 0) toolCalls, MIN(first_ts) firstTs, MAX(last_ts) lastTs FROM sessions`,
      )
      .get();
    const prices = indexer.priceTable;
    return {
      version: VERSION,
      control: options.control === true,
      now: deps.now(),
      index: indexer.getStatus(),
      prices: { readable: prices.readable, models: [...prices.models.keys()].sort(), source: 'additionalModelCostsCache in the user configuration file' },
      totals,
      facets: facets(db),
    };
  });

  router.get('/api/projects', () => ({ items: projects(db) }));

  router.get('/api/sessions', ({ query }) =>
    listSessions(db, {
      q: strParam(query, 'q', 200),
      project: strParam(query, 'project'),
      model: strParam(query, 'model'),
      entrypoint: strParam(query, 'entrypoint'),
      from: optIntParam(query, 'from'),
      to: optIntParam(query, 'to'),
      errors: query.get('errors') === '1',
      risk: optEnumParam(query, 'risk', SEVERITIES),
      ids: null,
      sort: enumParam(query, 'sort', ['last', 'cost', 'duration'] as const, 'last'),
      ...page(query),
    }),
  );

  router.get('/api/sessions/:id', ({ params }) => getSession(db, params.id));

  const agentParam = (query: URLSearchParams) => {
    const agent = strParam(query, 'agent', 100);
    if (agent !== null && !/^[A-Za-z0-9_-]+$/.test(agent)) throw notFound();
    return agent;
  };
  // Ids in the path are integers; anything else is not a record.
  const recordRef = (params: Record<string, string>) => {
    if (!/^\d{1,12}$/.test(params.file) || !/^\d{1,12}$/.test(params.line)) throw notFound();
    return { file: Number(params.file), line: Number(params.line) };
  };

  router.get('/api/sessions/:id/timeline', ({ params, query }) =>
    timelines.timeline(params.id, agentParam(query), intParam(query, 'offset', 0, 0, 100_000_000), intParam(query, 'limit', 300, 1, 1000)),
  );
  router.get('/api/sessions/:id/context', ({ params, query }) => contextSeries(db, timelines.fileOf(params.id, agentParam(query))));
  router.get('/api/sessions/:id/files', ({ params }) => {
    getSession(db, params.id);
    return filesTouched(db, params.id);
  });
  router.get('/api/records/:file/:line', ({ params }) => {
    const ref = recordRef(params);
    return timelines.record(ref.file, ref.line, false);
  });
  router.post('/api/records/:file/:line/reveal', ({ params }) => {
    const ref = recordRef(params);
    const record = timelines.record(ref.file, ref.line, true);
    activity.record('reveal', { file: ref.file, line: ref.line, session: record.session });
    return record;
  });
  router.get('/api/audit/activity', ({ query }) => ({ items: activity.list(intParam(query, 'limit', 200, 1, 1000)) }));

  const ledgerFilter = (query: URLSearchParams): LedgerFilter => ({
    tool: strParam(query, 'tool', 200),
    category: optEnumParam(query, 'category', LEDGER_CATEGORIES),
    project: strParam(query, 'project'),
    session: strParam(query, 'session'),
    outcome: optEnumParam(query, 'outcome', OUTCOMES),
    from: optIntParam(query, 'from'),
    to: optIntParam(query, 'to'),
    q: strParam(query, 'q', 200),
  });
  const findingFilter = (query: URLSearchParams): FindingFilter => ({
    severity: optEnumParam(query, 'severity', SEVERITIES),
    state: optEnumParam(query, 'state', ['open', 'acknowledged'] as const),
    rule: strParam(query, 'rule', 100),
    project: strParam(query, 'project'),
    session: strParam(query, 'session'),
    from: optIntParam(query, 'from'),
    to: optIntParam(query, 'to'),
  });
  const filterSummary = (f: Record<string, unknown>) =>
    Object.entries(f)
      .filter(([k, v]) => v !== null && k !== 'q')
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
      .slice(0, 300);

  router.get('/api/audit/ledger', ({ query }) => {
    const p = page(query);
    return ledger(db, ledgerFilter(query), p.limit, p.offset);
  });
  router.get('/api/audit/ledger/export', ({ query, res }) => {
    const format = enumParam(query, 'format', ['csv', 'jsonl'] as const, 'csv');
    const f = ledgerFilter(query);
    const rows = exportLedger(db, f, format, res, now());
    activity.record('export', { list: 'ledger', format, rows, filter: filterSummary(f) });
    return HANDLED;
  });
  router.get('/api/audit/findings', ({ query }) => {
    const p = page(query);
    return findings(db, findingFilter(query), p.limit, p.offset);
  });
  router.get('/api/audit/findings/export', ({ query, res }) => {
    const format = enumParam(query, 'format', ['csv', 'jsonl'] as const, 'csv');
    const f = findingFilter(query);
    const rows = exportFindings(db, f, format, res, now());
    activity.record('export', { list: 'findings', format, rows, filter: filterSummary(f) });
    return HANDLED;
  });
  router.post('/api/audit/findings/:id/triage', ({ params, body }) => {
    const result = triage(db, params.id, body, now());
    activity.record('triage', { finding: params.id, state: result.state });
    return result;
  });
  router.get('/api/audit/integrity', () => integrity(db, options.claudeHome));
  router.post('/api/audit/integrity/:id/ack', ({ params, body }) => {
    if (!/^\d{1,12}$/.test(params.id)) throw notFound();
    const result = ackIntegrity(db, Number(params.id), body, now());
    activity.record('integrity-ack', { alert: result.id });
    return result;
  });

  router.post('/api/audit/verify', async () => {
    const stats = await indexer.pass(undefined, { deep: true });
    return { files: stats.files, at: stats.at };
  });

  router.get('/api/ops/records', () => {
    const types = (db.prepare('SELECT type, SUM(n) count FROM type_counts GROUP BY type ORDER BY count DESC').all() as any[]).map((t) => ({
      type: t.type,
      count: t.count,
      known: t.type === 'api-request*' || KNOWN_TYPES.has(t.type),
    }));
    const skipped = db.prepare('SELECT COALESCE(SUM(skipped), 0) n, COALESCE(SUM(lines), 0) lines, COUNT(*) files, COALESCE(SUM(missing), 0) missing FROM files').get() as any;
    return { skippedLines: skipped.n, lines: skipped.lines, files: skipped.files, sourceRemoved: skipped.missing, types, unknownTypes: types.filter((t) => !t.known) };
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const door = new FrontDoor({ port: options.port, staticDir: options.staticDir ?? join(here, '..', '..', 'web', 'dist'), quiet: options.quiet, router });
  let port: number;
  try {
    port = await door.listen();
  } catch (e) {
    db.close();
    unlock();
    throw e;
  }

  return {
    port,
    address: (door.server.address() as { address: string }).address,
    token: door.token,
    url: `http://127.0.0.1:${port}/?token=${door.token}`,
    index: async (o) => {
      await indexer.pass(undefined, o);
    },
    rebuild: async () => {
      await indexer.pass([]);
      rebuild(db);
      indexer.reset();
      await indexer.pass();
    },
    close: async () => {
      await door.close();
      await indexer.pass([]).catch(() => undefined);
      db.close();
      unlock();
    },
  };
}
