import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Home, rec, start, T0, lines } from './fixture.ts';

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('AEGIS-1 every transcript is listed as a session with no configuration', async () => {
  const home = new Home();
  home.transcript('-work-alpha', 'sess-a', [
    rec.title('sess-a', 'Refund flow'),
    rec.prompt({ sid: 'sess-a', at: T0 }, 'add the refund endpoint'),
    rec.assistant({ sid: 'sess-a', at: T0 + 5000 }, { id: 'msg_a1', usage: { input: 10, output: 20 } }),
  ]);
  home.transcript('-work-beta', 'sess-b', [
    rec.prompt({ sid: 'sess-b', cwd: '/work/beta', at: T0 + 60_000, entrypoint: 'sdk-cli' }, 'run the nightly check'),
  ]);
  const c = await start(home);
  try {
    const list = await c.get('/api/sessions');
    assert.equal(list.total, 2);
    assert.deepEqual(list.items.map((s: any) => s.id), ['sess-b', 'sess-a']);
    const a = list.items[1];
    assert.equal(a.title, 'Refund flow');
    assert.equal(a.cwd, '/work/alpha');
    assert.equal(a.project, '-work-alpha');
    assert.equal(a.entrypoint, 'cli');
    assert.equal(a.firstTs, T0);
    assert.equal(a.lastTs, T0 + 5000);
    assert.equal(a.prompts, 1);
    assert.equal(list.items[0].entrypoint, 'sdk-cli');
    // a session with no title falls back to its first prompt
    assert.equal(list.items[0].title, 'run the nightly check');
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-2 a pass after an append reads only the appended bytes', async () => {
  const home = new Home();
  const first = [
    rec.prompt({ sid: 's', at: T0 }, 'hello'),
    rec.apiRequest('s'),
    rec.assistant({ sid: 's', at: T0 + 1000 }, { id: 'msg_1', usage: { input: 100, output: 10 } }),
  ];
  const p = home.transcript('-work-alpha', 's', first);
  const c = await start(home);
  try {
    const before = await c.get('/api/overview');
    assert.equal(before.index.lastPass.bytesRead, Buffer.byteLength(lines(first)));
    const more = [rec.assistant({ sid: 's', at: T0 + 2000 }, { id: 'msg_2', usage: { input: 7, output: 3 } })];
    home.append(p, more);
    await c.app.index();
    const after = await c.get('/api/overview');
    assert.equal(after.index.lastPass.bytesRead, Buffer.byteLength(lines(more)));
    const s = await c.get('/api/sessions/s');
    assert.equal(s.usage.input, 107);
    assert.equal(s.usage.output, 13);
    assert.equal(s.apiCalls, 2);
    // an unchanged home costs nothing to re-check
    await c.app.index();
    assert.equal((await c.get('/api/overview')).index.lastPass.bytesRead, 0);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-3 usage is counted once per response, with the last record winning', async () => {
  const home = new Home();
  const b = { sid: 's', at: T0 };
  home.transcript('-work-alpha', 's', [
    rec.prompt(b, 'go'),
    // one API response written as three records (thinking, text, tool_use), usage repeated on each
    rec.assistant(b, { id: 'msg_x', usage: { input: 1000, output: 5 }, content: [{ type: 'thinking', thinking: '' }] }),
    rec.assistant(b, { id: 'msg_x', usage: { input: 1000, output: 90 }, content: [rec.text('working')] }),
    rec.assistant(b, {
      id: 'msg_x',
      usage: { input: 1000, output: 2000, cacheRead: 10000, w5: 400, w1: 600 },
      content: [rec.toolUse('toolu_1', 'Bash', { command: 'ls' })],
    }),
    rec.toolResult(b, 'toolu_1'),
    // a synthetic response and a response with no id carry no usage
    rec.assistant(b, { id: 'syn', model: '<synthetic>', usage: { input: 999, output: 999 } }),
  ]);
  const c = await start(home);
  try {
    const s = await c.get('/api/sessions/s');
    assert.equal(s.apiCalls, 1);
    assert.deepEqual(s.usage, { input: 1000, output: 2000, cacheRead: 10000, cacheWrite5m: 400, cacheWrite1h: 600 });
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-4 cost uses the harness price table with a rate per token class', async () => {
  const home = new Home();
  const b = { sid: 's', at: T0 };
  home.transcript('-work-alpha', 's', [
    rec.assistant(b, { id: 'm1', usage: { input: 1000, output: 2000, cacheRead: 10000, w5: 400, w1: 600 } }),
    // no cache-write split: all of it is priced at the 5-minute rate
    rec.assistant(b, { id: 'm2', usage: { input: 0, output: 0, w5: 1000, split: false } }),
    // a dated id resolves to the longest priced id it starts with; no 1-hour rate falls back to the 5-minute rate
    rec.assistant(b, { id: 'm3', model: 'm-cheap-20261101', usage: { input: 1_000_000, w1: 1_000_000 } }),
  ]);
  const c = await start(home);
  try {
    const s = await c.get('/api/sessions/s');
    // m1: (1000*10 + 2000*50 + 10000*1 + 400*12.5 + 600*20) / 1e6 = 0.137
    // m2: 1000*12.5 / 1e6 = 0.0125
    // m3: (1e6*1 + 1e6*1.25) / 1e6 = 2.25
    near(s.cost.estimated, 0.137 + 0.0125 + 2.25);
    assert.equal(s.cost.unpricedCalls, 0);
    assert.equal(s.cost.basis, 'estimated from tokens');
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-5 an unpriced model adds tokens, no cost, and is counted', async () => {
  const home = new Home();
  const b = { sid: 's', at: T0 };
  home.transcript('-work-alpha', 's', [
    rec.assistant(b, { id: 'm1', usage: { input: 1000, output: 2000, cacheRead: 10000, w5: 400, w1: 600 } }),
    rec.assistant(b, { id: 'm2', model: 'mystery-9', usage: { input: 50, output: 60 } }),
  ]);
  const c = await start(home);
  try {
    const s = await c.get('/api/sessions/s');
    near(s.cost.estimated, 0.137);
    assert.equal(s.cost.unpricedCalls, 1);
    assert.equal(s.usage.input, 1050);
    assert.equal(s.usage.output, 2060);
    const row = (await c.get('/api/sessions')).items[0];
    assert.equal(row.unpricedCalls, 1);
    near(row.cost, 0.137);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-6 the harness-reported cost sums the last total of each process run', async () => {
  const home = new Home();
  const b = { sid: 's', at: T0 };
  home.transcript('-work-alpha', 's', [
    rec.assistant(b, { id: 'm1', usage: { input: 1000 } }),
    rec.costState('s', 111, 1.0),
    rec.costState('s', 111, 2.5),
    rec.costState('s', 222, 0),
    rec.costState('s', 222, 4.25),
  ]);
  home.transcript('-work-alpha', 'none', [rec.assistant({ sid: 'none', at: T0 }, { id: 'n1', usage: { input: 1 } })]);
  const c = await start(home);
  try {
    const s = await c.get('/api/sessions/s');
    near(s.cost.reported, 6.75);
    assert.equal(s.cost.reportedRuns, 2);
    const none = await c.get('/api/sessions/none');
    assert.equal(none.cost.reported, null);
    assert.equal(none.cost.reportedRuns, 0);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-7 subagent usage rolls into the parent with a per-agent breakdown', async () => {
  const home = new Home();
  const b = { sid: 'parent', at: T0 };
  home.transcript('-work-alpha', 'parent', [
    rec.prompt(b, 'delegate it'),
    rec.assistant(b, { id: 'p1', usage: { input: 100, output: 10 } }),
  ]);
  home.transcript(
    '-work-alpha',
    'parent',
    [rec.assistant({ ...b, agentId: 'a1', at: T0 + 9000 }, { id: 'c1', usage: { input: 1000, output: 2000, cacheRead: 10000, w5: 400, w1: 600 } })],
    { agent: 'a1', agentType: 'code-reviewer' },
  );
  // a subagent whose parent transcript is absent still produces a session
  home.transcript('-work-alpha', 'orphan', [rec.assistant({ sid: 'orphan', at: T0, agentId: 'z9' }, { id: 'o1', usage: { input: 5 } })], {
    agent: 'z9',
  });
  const c = await start(home);
  try {
    const s = await c.get('/api/sessions/parent');
    assert.equal(s.usage.input, 1100);
    assert.equal(s.usage.output, 2010);
    assert.equal(s.subagents, 1);
    assert.equal(s.lastTs, T0 + 9000);
    const main = s.agents.find((a: any) => a.agentId === null);
    const sub = s.agents.find((a: any) => a.agentId === 'a1');
    assert.equal(main.agentType, 'main');
    assert.equal(main.usage.input, 100);
    assert.equal(sub.agentType, 'code-reviewer');
    assert.equal(sub.usage.input, 1000);
    near(sub.cost, 0.137);
    const orphan = await c.get('/api/sessions/orphan');
    assert.equal(orphan.hasMain, false);
    assert.equal(orphan.usage.input, 5);
    assert.equal((await c.get('/api/sessions')).total, 2);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-8 a truncated last line waits for the next pass; a corrupt line is counted and skipped', async () => {
  const home = new Home();
  const b = { sid: 's', at: T0 };
  const whole = JSON.stringify(rec.assistant(b, { id: 'm2', usage: { input: 30 } }));
  const p = home.transcript('-work-alpha', 's', [rec.assistant(b, { id: 'm1', usage: { input: 10 } })]);
  home.append(p, '{"type":"assistant", this is not json}\n');
  home.append(p, whole.slice(0, 40)); // still being written: no newline yet
  const c = await start(home);
  try {
    let s = await c.get('/api/sessions/s');
    assert.equal(s.usage.input, 10);
    assert.equal(s.apiCalls, 1);
    home.append(p, whole.slice(40) + '\n');
    await c.app.index();
    s = await c.get('/api/sessions/s');
    assert.equal(s.usage.input, 40);
    assert.equal(s.apiCalls, 2);
    const records = await c.get('/api/ops/records');
    assert.equal(records.skippedLines, 1);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-35 the Claude home is byte-identical after indexing and reading', async () => {
  const home = new Home();
  const b = { sid: 's', at: T0 };
  home.transcript('-work-alpha', 's', [
    rec.prompt(b, 'do it'),
    rec.assistant(b, { id: 'm1', usage: { input: 10 }, content: [rec.toolUse('toolu_1', 'Bash', { command: 'git push --force' })] }),
    rec.toolResult(b, 'toolu_1'),
  ]);
  home.file('settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
  const before = home.snapshot();
  const c = await start(home);
  try {
    for (const path of ['/api/overview', '/api/sessions', '/api/sessions/s', '/api/ops/records']) {
      await c.get(path);
    }
    await c.app.index();
  } finally {
    await c.close();
  }
  assert.equal(home.snapshot(), before);
  // and the state directory is refused inside the Claude home
  await assert.rejects(start(home, { stateDir: home.claudeHome + '/aegis' }), /inside the Claude home/);
  home.destroy();
});
