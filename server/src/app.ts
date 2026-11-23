// Composition root: wires the index, the queries and the HTTP front door together.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lockStateDir, openDb, prepareStateDir, type Db } from './db.ts';
import { Indexer, KNOWN_TYPES } from './indexer.ts';
import { loadPrices } from './pricing.ts';
import { FrontDoor, Router, enumParam, optEnumParam, optIntParam, page, strParam } from './http.ts';
import { facets, getSession, listSessions, projects, sessionShapes } from './sessions.ts';
import { Timelines, contextSeries, fileHeat, filesTouched } from './timeline.ts';
import { Activity } from './activity.ts';
import { LEDGER_CATEGORIES, OUTCOMES, ackIntegrity, exportFindings, exportLedger, findings, integrity, ledger, triage, type FindingFilter, type LedgerFilter } from './audit.ts';
import { rebuild } from './db.ts';
import { Live } from './live.ts';
import { Runs, resolveBinary } from './runs.ts';
import { doctor, hookStats, inventory, opsSeries, toolStats } from './inventory.ts';
import { GROUPS, costFlow, costSeries, resolveRange, topSessions } from './cost.ts';
import { harnessMap } from './map.ts';
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
  /** Largest transcript line that is read; longer lines are skipped and counted (default 32 MB). */
  maxLineBytes?: number;
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
  /** Checks the live-session registry now (the server also does this on a timer when watching). */
  pollLive: () => Promise<void>;
  close: () => Promise<void>;
};

export type Deps = { db: Db; indexer: Indexer; options: AppOptions; now: () => number; stateDir: string; activity: Activity; timelines: Timelines };

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export async function createApp(options: AppOptions): Promise<App> {
  // Control mode needs the harness binary; find it before anything is opened.
  const bin = options.control ? resolveBinary(options.claudeBin) : null;
  const stateDir = prepareStateDir(options.stateDir, options.claudeHome);
  const unlock = lockStateDir(stateDir);
  const db = openDb(stateDir);
  const clock = options.now ?? Date.now;
  const indexer = new Indexer(db, options.claudeHome, () => loadPrices(options.configFile), clock, options.maxLineBytes);
  const now = clock;
  const activity = new Activity(stateDir, now);
  const timelines = new Timelines(db, options.claudeHome, join(options.claudeHome, 'projects'), options.maxLineBytes);
  const deps: Deps = { db, indexer, options, now, stateDir, activity, timelines };
  const live = new Live(db, options.claudeHome, now);
  indexer.onChange = (ids) => live.notifyIndex(ids);
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
      prices: { readable: indexer.priceSourceReadable, models: [...prices.models.keys()].sort(), source: 'additionalModelCostsCache in the user configuration file' },
      totals,
      facets: facets(db),
    };
  });

  router.get('/api/projects', () => ({ items: projects(db) }));

  router.get('/api/live', () => live.snapshot());
  router.get('/api/events', ({ res }) => {
    live.open(res);
    return HANDLED;
  });

  router.get('/api/sessions', ({ query }) => {
    const running = live.runningIds();
    const result = listSessions(db, {
      q: strParam(query, 'q', 200),
      project: strParam(query, 'project'),
      model: strParam(query, 'model'),
      entrypoint: strParam(query, 'entrypoint'),
      from: optIntParam(query, 'from'),
      to: optIntParam(query, 'to'),
      callsFrom: optIntParam(query, 'callsFrom'),
      callsTo: optIntParam(query, 'callsTo'),
      errors: query.get('errors') === '1',
      risk: optEnumParam(query, 'risk', SEVERITIES),
      ids: query.get('live') === '1' ? [...running] : null,
      sort: enumParam(query, 'sort', ['last', 'cost', 'duration'] as const, 'last'),
      ...page(query),
    });
    const shapes = query.get('shape') === '1' ? sessionShapes(db, result.items.map((s) => ({ id: s.id, stamp: [s.lastTs, s.apiCalls, s.toolCalls, s.toolErrors, s.toolDenied, s.apiErrors, s.hookFailures, s.prompts].join(':') }))) : null;
    return { ...result, items: result.items.map((s) => ({ ...s, live: running.has(s.id), ...(shapes ? { shape: shapes.get(s.id) ?? [] } : {}) })) };
  });

  router.get('/api/sessions/:id', ({ params }) => ({ ...getSession(db, params.id), live: live.runningIds().has(params.id) }));

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
  router.get('/api/sessions/:id/path', ({ params, query }) =>
    timelines.path(params.id, agentParam(query), intParam(query, 'offset', 0, 0, 100_000_000), intParam(query, 'limit', 1000, 1, 2000)),
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

  const rangeOf = (query: URLSearchParams) =>
    resolveRange(optIntParam(query, 'from'), optIntParam(query, 'to'), enumParam(query, 'bucket', ['day', 'hour'] as const, 'day'), intParam(query, 'tz', 0, -840, 840), now());

  router.get('/api/cost/series', ({ query }) => costSeries(db, rangeOf(query), enumParam(query, 'group', GROUPS, 'model')));
  router.get('/api/cost/flow', ({ query }) => {
    const range = rangeOf(query);
    return costFlow(db, range.from, range.to);
  });
  router.get('/api/cost/top', ({ query }) => {
    const range = rangeOf(query);
    return topSessions(db, range.from, range.to, intParam(query, 'limit', 10, 1, 100));
  });

  const span = (query: URLSearchParams) => ({ from: optIntParam(query, 'from') ?? 0, to: optIntParam(query, 'to') ?? Number.MAX_SAFE_INTEGER });
  router.get('/api/ops/hooks', ({ query }) => {
    const { from, to } = span(query);
    return { items: hookStats(db, from, to) };
  });
  router.get('/api/ops/tools', ({ query }) => {
    const { from, to } = span(query);
    return toolStats(db, from, to);
  });
  router.get('/api/files/heat', ({ query }) => {
    const { from, to } = span(query);
    return fileHeat(db, from, to, { project: strParam(query, 'project'), under: strParam(query, 'under', 1000), folders: query.get('group') === 'folder', limit: intParam(query, 'limit', 150, 1, 500) });
  });
  router.get('/api/map', ({ query }) => {
    const { from, to } = span(query);
    return harnessMap(db, from, to);
  });
  router.get('/api/ops/series', ({ query }) => opsSeries(db, rangeOf(query)));
  router.get('/api/ops/inventory', () => {
    const { settings, plugins, mcpServers } = inventory(db, options.claudeHome, options.configFile);
    return { settings, plugins, mcpServers };
  });
  router.get('/api/ops/doctor', () => doctor(db, options.claudeHome, options.configFile, indexer.priceSourceReadable, now()));

  router.get('/api/ops/records', () => {
    const types = (db.prepare('SELECT type, SUM(n) count FROM type_counts GROUP BY type ORDER BY count DESC').all() as any[]).map((t) => ({
      type: t.type,
      count: t.count,
      known: t.type === 'api-request*' || KNOWN_TYPES.has(t.type),
    }));
    const skipped = db.prepare('SELECT COALESCE(SUM(skipped), 0) n, COALESCE(SUM(lines), 0) lines, COUNT(*) files, COALESCE(SUM(missing), 0) missing FROM files').get() as any;
    return { skippedLines: skipped.n, lines: skipped.lines, files: skipped.files, sourceRemoved: skipped.missing, types, unknownTypes: types.filter((t) => !t.known) };
  });

  // The run routes exist only in control mode (AUTHZ-02).
  const runs = bin ? new Runs(db, bin, activity, now) : null;
  if (runs) {
    router.get('/api/runs', () => runs.list());
    router.post('/api/runs', ({ body }) => runs.launch(body));
    router.post('/api/runs/:id/stop', ({ params }) => runs.stop(params.id));
  }

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

  if (options.watch) live.watch(indexer);

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
    pollLive: async () => live.poll(),
    close: async () => {
      await runs?.close();
      live.close();
      await door.close();
      await indexer.pass([]).catch(() => undefined);
      db.close();
      unlock();
    },
  };
}
