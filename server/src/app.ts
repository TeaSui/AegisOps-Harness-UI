// Composition root: wires the index, the queries and the HTTP front door together.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lockStateDir, openDb, prepareStateDir, type Db } from './db.ts';
import { Indexer, KNOWN_TYPES } from './indexer.ts';
import { loadPrices } from './pricing.ts';
import { FrontDoor, Router, enumParam, optEnumParam, optIntParam, page, strParam } from './http.ts';
import { facets, getSession, listSessions, projects } from './sessions.ts';

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
  token: string;
  url: string;
  index: (options?: { deep?: boolean }) => Promise<void>;
  close: () => Promise<void>;
};

export type Deps = { db: Db; indexer: Indexer; options: AppOptions; now: () => number; stateDir: string };

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export async function createApp(options: AppOptions): Promise<App> {
  const stateDir = prepareStateDir(options.stateDir, options.claudeHome);
  const unlock = lockStateDir(stateDir);
  const db = openDb(stateDir);
  const indexer = new Indexer(db, options.claudeHome, () => loadPrices(options.configFile));
  const deps: Deps = { db, indexer, options, now: options.now ?? Date.now, stateDir };
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
    token: door.token,
    url: `http://127.0.0.1:${port}/?token=${door.token}`,
    index: async (o) => {
      await indexer.pass(undefined, o);
    },
    close: async () => {
      await door.close();
      await indexer.pass([]).catch(() => undefined);
      db.close();
      unlock();
    },
  };
}
