import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Home, PRICES, rec, start, type Client } from './fixture.ts';

const at = (iso: string) => Date.parse(iso);
const near = (a: number, b: number, what = '') => assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} != ${b}`);

function costHome(): Home {
  const home = new Home();
  const a = (iso: string) => ({ sid: 'A', at: at(iso) });
  home.transcript('-work-alpha', 'A', [
    rec.title('A', 'Session A'),
    rec.assistant(a('2026-11-20T10:00:00Z'), {
      id: 'a1',
      usage: { input: 1000, output: 2000, cacheRead: 10000, w5: 400, w1: 600 },
      extra: { attributionSkill: 'aegisops-harness:build', attributionPlugin: 'aegisops-harness' },
    }),
    rec.assistant(a('2026-11-20T18:30:00Z'), { id: 'a2', model: 'm-cheap', usage: { input: 1_000_000 } }),
    rec.assistant(a('2026-11-21T02:00:00Z'), { id: 'a3', model: 'mystery-9', usage: { input: 50 } }),
  ]);
  home.transcript(
    '-work-alpha',
    'A',
    [rec.assistant({ sid: 'A', at: at('2026-11-20T11:00:00Z'), agentId: 'r1' }, { id: 's1', model: 'm-cheap', usage: { output: 1_000_000 } })],
    { agent: 'r1', agentType: 'code-reviewer' },
  );
  home.transcript('-work-beta', 'B', [
    rec.title('B', 'Session B'),
    rec.assistant({ sid: 'B', cwd: '/work/beta', at: at('2026-11-21T09:00:00Z') }, { id: 'b1', usage: { output: 1000 } }),
  ]);
  return home;
}

// a1 = 0.137, a2 = 1.0, a3 unpriced, s1 = 5.0, b1 = 0.05
const RANGE = `from=${at('2026-11-20T00:00:00Z')}&to=${at('2026-11-21T23:59:59Z')}`;

async function withCost(fn: (c: Client, home: Home) => Promise<void>) {
  const home = costHome();
  const c = await start(home, { now: () => at('2026-11-22T00:00:00Z') });
  try {
    await fn(c, home);
  } finally {
    await c.close();
    home.destroy();
  }
}

test('AEGIS-24 day buckets follow the client offset and groups sum to the hand-computed totals', () =>
  withCost(async (c) => {
    const utc = await c.get(`/api/cost/series?${RANGE}&bucket=day&group=model&tz=0`);
    assert.deepEqual(utc.buckets.map((b: any) => b.start), [at('2026-11-20T00:00:00Z'), at('2026-11-21T00:00:00Z')]);
    near(utc.buckets[0].cost, 6.137);
    near(utc.buckets[1].cost, 0.05);
    assert.equal(utc.buckets[0].calls, 3);
    assert.equal(utc.buckets[0].unpriced, 0);
    assert.equal(utc.buckets[1].unpriced, 1);
    near(utc.buckets[0].groups['m-priced'].cost, 0.137);
    near(utc.buckets[0].groups['m-cheap'].cost, 6.0);
    near(utc.totals.cost, 6.187);
    assert.equal(utc.totals.calls, 5);
    assert.equal(utc.totals.unpriced, 1);
    assert.equal(utc.totals.input, 1_001_050);
    assert.equal(utc.totals.output, 1_003_000);
    assert.deepEqual(utc.groups.map((g: any) => g.key), ['m-cheap', 'm-priced', 'mystery-9']); // by cost
    const mystery = utc.groups[2];
    assert.deepEqual({ calls: mystery.calls, cost: mystery.cost, unpriced: mystery.unpriced, input: mystery.input }, { calls: 1, cost: 0, unpriced: 1, input: 50 });

    // UTC+7: the local day starts at 17:00Z, so the evening call moves to the next day
    const plus7 = await c.get(`/api/cost/series?from=${at('2026-11-19T17:00:00Z')}&to=${at('2026-11-21T16:59:59Z')}&bucket=day&group=model&tz=420`);
    assert.deepEqual(plus7.buckets.map((b: any) => b.start), [at('2026-11-19T17:00:00Z'), at('2026-11-20T17:00:00Z')]);
    near(plus7.buckets[0].cost, 5.137);
    near(plus7.buckets[1].cost, 1.05);

    const sum = async (group: string) =>
      Object.fromEntries((await c.get(`/api/cost/series?${RANGE}&group=${group}&tz=0`)).groups.map((g: any) => [g.key, Math.round(g.cost * 1e6) / 1e6]));
    assert.deepEqual(await sum('project'), { '-work-alpha': 6.137, '-work-beta': 0.05 });
    assert.deepEqual(await sum('skill'), { '(none)': 6.05, 'aegisops-harness:build': 0.137 });
    assert.deepEqual(await sum('plugin'), { '(none)': 6.05, 'aegisops-harness': 0.137 });
    assert.deepEqual(await sum('agent'), { 'code-reviewer': 5, main: 1.187 });

    const hours = await c.get(`/api/cost/series?from=${at('2026-11-20T10:00:00Z')}&to=${at('2026-11-20T11:59:59Z')}&bucket=hour&group=model&tz=0`);
    assert.deepEqual(
      hours.buckets.map((b: any) => [b.start, Math.round(b.cost * 1000) / 1000]),
      [[at('2026-11-20T10:00:00Z'), 0.137], [at('2026-11-20T11:00:00Z'), 5]],
    );

    const bad = [
      'group=colour',
      'bucket=week',
      'tz=9999',
      `from=${at('2026-11-21T00:00:00Z')}&to=${at('2026-11-20T00:00:00Z')}`,
      `bucket=hour&from=0&to=${at('2026-11-21T00:00:00Z')}`,
    ];
    for (const q of bad) assert.equal((await c.getRes(`/api/cost/series?${q}`)).status, 400, q);
    // with no range the last 30 days are served
    const dflt = await c.get('/api/cost/series');
    assert.equal(dflt.buckets.length, 31);
    near(dflt.totals.cost, 6.187);
  }));

test('AEGIS-24 the cache share is cache read over all input, and empty when there is no input', () =>
  withCost(async (c) => {
    const s = await c.get(`/api/cost/series?from=${at('2026-11-20T00:00:00Z')}&to=${at('2026-11-22T23:59:59Z')}&bucket=day&group=model&tz=0`);
    near(s.buckets[0].cacheShare, 10000 / (1_001_000 + 10000 + 1000));
    near(s.totals.cacheShare, 10000 / (1_001_050 + 10000 + 1000));
    assert.equal(s.buckets[2].calls, 0);
    assert.equal(s.buckets[2].cacheShare, null); // the client shows "n/a"
    assert.equal(s.buckets[2].cost, 0);
  }));

test('AEGIS-25 the most expensive sessions of a period', () =>
  withCost(async (c) => {
    const all = await c.get(`/api/cost/top?${RANGE}`);
    assert.deepEqual(
      all.items.map((s: any) => [s.session, s.title, Math.round(s.cost * 1000) / 1000, s.calls, s.unpriced]),
      [['A', 'Session A', 6.137, 4, 1], ['B', 'Session B', 0.05, 1, 0]],
    );
    assert.deepEqual((await c.get(`/api/cost/top?${RANGE}&limit=1`)).items.map((s: any) => s.session), ['A']);
    // only the second day: A's priced calls are outside the range
    const day2 = await c.get(`/api/cost/top?from=${at('2026-11-21T00:00:00Z')}&to=${at('2026-11-21T23:59:59Z')}`);
    assert.deepEqual(day2.items.map((s: any) => [s.session, s.cost, s.unpriced]), [['B', 0.05, 0], ['A', 0, 1]]);
    assert.equal((await c.getRes('/api/cost/top?limit=101')).status, 400);
  }));

test('AEGIS-4 a changed price table re-prices stored costs and records the event', () =>
  withCost(async (c, home) => {
    near((await c.get('/api/sessions/A')).cost.estimated, 6.137);
    assert.deepEqual((await c.get(`/api/cost/series?${RANGE}`)).repricing, []);
    home.config({
      additionalModelCostsCache: { ...PRICES, 'm-cheap': { ...PRICES['m-cheap'], inputTokens: 2 }, 'mystery-9': { inputTokens: 100, outputTokens: 100, promptCacheReadTokens: 10, promptCacheWriteTokens: 125 } },
    });
    await c.app.index();
    // a2 doubles to 2.0; a3 is now priced: 50 x 100 / 1e6 = 0.005
    const s = await c.get('/api/sessions/A');
    near(s.cost.estimated, 0.137 + 2.0 + 5.0 + 0.005);
    assert.equal(s.cost.unpricedCalls, 0);
    const series = await c.get(`/api/cost/series?${RANGE}&tz=0`);
    near(series.totals.cost, 7.192);
    assert.equal(series.repricing.length, 1);
    assert.equal(series.repricing[0].at, at('2026-11-22T00:00:00Z'));
    // LOG-01: only the models whose price changed, with the rates before and after
    assert.deepEqual(series.repricing[0].models, ['m-cheap', 'mystery-9']);
    const [cheap, mystery] = series.repricing[0].changes;
    assert.deepEqual({ model: cheap.model, before: cheap.before.input, after: cheap.after.input }, { model: 'm-cheap', before: 1, after: 2 });
    assert.deepEqual({ model: mystery.model, before: mystery.before, after: mystery.after.input }, { model: 'mystery-9', before: null, after: 100 });
    // an unchanged table is not an event
    await c.app.index();
    assert.equal((await c.get(`/api/cost/series?${RANGE}`)).repricing.length, 1);
    // a table that loses a model un-prices it instead of keeping a stale figure
    home.config({ additionalModelCostsCache: { 'm-priced': PRICES['m-priced'] } });
    await c.app.index();
    const after = await c.get('/api/sessions/A');
    near(after.cost.estimated, 0.137);
    assert.equal(after.cost.unpricedCalls, 3);
    assert.equal((await c.get('/api/overview')).prices.models.length, 1);
    const events = (await c.get(`/api/cost/series?${RANGE}`)).repricing.length;
    // a table that cannot be read changes nothing: the last good prices stand and no event is written
    writeFileSync(home.configFile, '{ not json');
    await c.app.index();
    near((await c.get('/api/sessions/A')).cost.estimated, 0.137);
    assert.equal((await c.get(`/api/cost/series?${RANGE}`)).repricing.length, events);
    // an entry without its cache rates is not a price
    home.config({ additionalModelCostsCache: { 'm-priced': { inputTokens: 10, outputTokens: 50 } } });
    await c.app.index();
    assert.equal((await c.get('/api/sessions/A')).cost.unpricedCalls, 4);
  }));

test('AEGIS-4 an unreadable price table changes nothing, also across a restart', async () => {
  const home = costHome();
  const now = () => at('2026-11-22T00:00:00Z');
  let c = await start(home, { now });
  near((await c.get('/api/sessions/A')).cost.estimated, 6.137);
  await c.close();
  writeFileSync(home.configFile, '{ not json');
  c = await start(home, { now });
  try {
    // during the outage a new response is still priced at the last good rates
    home.transcript('-work-beta', 'N', [rec.assistant({ sid: 'N', cwd: '/work/beta', at: at('2026-11-21T10:00:00Z') }, { id: 'n1', usage: { output: 1000 } })]);
    await c.app.index();
    near((await c.get('/api/sessions/N')).cost.estimated, 0.05);
    assert.equal((await c.get('/api/sessions/N')).cost.unpricedCalls, 0);
    near((await c.get('/api/sessions/A')).cost.estimated, 6.137);
    assert.equal((await c.get('/api/ops/doctor')).checks.find((x: any) => x.id === 'sources.unreadable').status, 'warn');
    // the same table comes back: nothing changed, so there is no re-pricing event
    home.config({ additionalModelCostsCache: PRICES });
    await c.app.index();
    assert.deepEqual((await c.get(`/api/cost/series?${RANGE}`)).repricing, []);
    near((await c.get('/api/sessions/A')).cost.estimated, 6.137);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-24 a group named like an object property cannot corrupt the totals', async () => {
  const home = new Home();
  const b = { sid: 'p', at: at('2026-11-20T10:00:00Z') };
  home.transcript('-work-alpha', 'p', [
    rec.assistant(b, { id: 'x1', model: '__proto__', usage: { input: 5 } }),
    rec.assistant(b, { id: 'x2', model: 'constructor', usage: { input: 7 }, extra: { attributionSkill: '__proto__', attributionPlugin: 'toString' } }),
  ]);
  const c = await start(home, { now: () => at('2026-11-22T00:00:00Z') });
  try {
    for (const group of ['model', 'skill', 'plugin']) {
      const s = await c.get(`/api/cost/series?${RANGE}&group=${group}&tz=0`);
      assert.equal(s.totals.calls, 2);
      assert.equal(s.totals.input, 12);
      assert.equal(s.groups.reduce((n: number, g: any) => n + g.calls, 0), 2);
    }
    assert.equal(({} as any).cost, undefined);
    assert.equal(({} as any).calls, undefined);
  } finally {
    await c.close();
    home.destroy();
  }
});
