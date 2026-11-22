import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Home, rec, start, T0, lines, type Client } from './fixture.ts';

const DEAD_PID = 2_000_000_000; // above any pid the system hands out

function register(home: Home, name: string, entry: Record<string, unknown>) {
  home.file(`sessions/${name}.json`, JSON.stringify({ cwd: '/work/alpha', kind: 'interactive', entrypoint: 'cli', version: '2.1.319', startedAt: T0, updatedAt: T0 + 500, statusUpdatedAt: T0 + 500, ...entry }));
}

/** Reads server-sent events until `count` events named `name` arrived or the time is up. */
async function events(c: Client, name: string, count: number, trigger: () => Promise<void>, timeoutMs = 6000): Promise<any[]> {
  const ctl = new AbortController();
  const res = await c.getRes('/api/events', { signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
  const reader = res.body!.getReader();
  const out: any[] = [];
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let buffer = '';
  try {
    await trigger();
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event === name && data) out.push(JSON.parse(data));
      }
    }
  } catch {
    /* aborted */
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return out;
}

test('AEGIS-9 a registry entry with a live process is running; a dead or malformed one is not', async () => {
  const home = new Home();
  home.transcript('-work-alpha', 'alive', [rec.title('alive', 'Live work'), rec.prompt({ sid: 'alive', at: T0 }, 'go'), rec.assistant({ sid: 'alive', at: T0 + 1000 }, { id: 'a1', usage: { input: 500, cacheRead: 1500 } })]);
  home.transcript('-work-alpha', 'dead', [rec.prompt({ sid: 'dead', at: T0 }, 'go')]);
  home.transcript('-work-alpha', 'unregistered', [rec.prompt({ sid: 'unregistered', at: T0 }, 'go')]);
  register(home, '100', { pid: process.pid, sessionId: 'alive', status: 'busy', name: 'live-work' });
  register(home, '101', { pid: DEAD_PID, sessionId: 'dead', status: 'busy' });
  register(home, '102', { pid: 'abc', sessionId: 'dead', status: 'idle' });
  register(home, '103', { sessionId: 'dead', status: 'idle' });
  register(home, '104', { pid: process.pid, sessionId: 'fresh', status: 'weird-new-status', name: 'no transcript yet' });
  home.file('sessions/105.json', '{ not json');
  home.file('sessions/53045.abcdef.key', 'not a registry entry');
  const c = await start(home);
  try {
    const live = await c.get('/api/live');
    assert.deepEqual(live.sessions.map((s: any) => s.id).sort(), ['alive', 'fresh']);
    const alive = live.sessions.find((s: any) => s.id === 'alive');
    assert.deepEqual(
      { status: alive.status, pid: alive.pid, title: alive.title, name: alive.name, since: alive.statusSince, started: alive.startedAt, context: alive.contextTokens, calls: alive.apiCalls },
      { status: 'busy', pid: process.pid, title: 'Live work', name: 'live-work', since: T0 + 500, started: T0, context: 2000, calls: 1 },
    );
    // a status the console does not know is shown verbatim; a running entry with no transcript has zero counts
    const fresh = live.sessions.find((s: any) => s.id === 'fresh');
    assert.deepEqual({ status: fresh.status, calls: fresh.apiCalls, title: fresh.title, cwd: fresh.cwd }, { status: 'weird-new-status', calls: 0, title: 'no transcript yet', cwd: '/work/alpha' });
    // the session list can be narrowed to what is running
    assert.deepEqual((await c.get('/api/sessions?live=1')).items.map((s: any) => s.id), ['alive']);
    assert.equal((await c.get('/api/sessions')).items.find((s: any) => s.id === 'alive').live, true);
    assert.equal((await c.get('/api/sessions')).items.find((s: any) => s.id === 'dead').live, false);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-10 a growing transcript and a registry change are pushed to the open console', async () => {
  const home = new Home();
  const p = home.transcript('-work-alpha', 'grow', [rec.prompt({ sid: 'grow', at: T0 }, 'go')]);
  home.transcript('-work-alpha', 'still', [rec.prompt({ sid: 'still', at: T0 }, 'go')]);
  const c = await start(home);
  try {
    const pushed = await events(c, 'index', 1, async () => {
      home.append(p, [rec.assistant({ sid: 'grow', at: T0 + 1000 }, { id: 'g1', usage: { input: 1 } })]);
      await c.app.index();
    });
    assert.equal(pushed.length, 1);
    assert.deepEqual(pushed[0].sessions, ['grow']);
    const liveEvents = await events(c, 'live', 1, async () => {
      register(home, '200', { pid: process.pid, sessionId: 'grow', status: 'busy' });
      await c.app.pollLive();
    });
    assert.equal(liveEvents.length, 1);
    // the channel needs the session cookie like everything else
    assert.equal((await fetch(`${c.origin}/api/events`)).status, 401);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-10 with watching on, an append is indexed and pushed without anyone asking', async () => {
  const home = new Home();
  const p = home.transcript('-work-alpha', 'watched', [rec.prompt({ sid: 'watched', at: T0 }, 'go')]);
  const c = await start(home, { watch: true });
  try {
    const pushed = await events(c, 'index', 1, async () => {
      home.append(p, [rec.assistant({ sid: 'watched', at: T0 + 1000 }, { id: 'w1', usage: { input: 42 } })]);
    }, 20_000);
    assert.equal(pushed.length, 1);
    assert.deepEqual(pushed[0].sessions, ['watched']);
    assert.equal((await c.get('/api/sessions/watched')).usage.input, 42);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-10 the push channel accepts at most 8 connections', async () => {
  const home = new Home();
  const c = await start(home);
  const ctl = new AbortController();
  try {
    const open = await Promise.all(Array.from({ length: 8 }, () => c.getRes('/api/events', { signal: ctl.signal })));
    assert.ok(open.every((r) => r.status === 200));
    assert.equal((await c.getRes('/api/events')).status, 429);
  } finally {
    ctl.abort();
    await c.close();
    home.destroy();
  }
});

test('AEGIS-11 the attention queue names each session that needs the operator, and why', async () => {
  const home = new Home();
  const at = (sid: string, s: number) => ({ sid, at: T0 + s * 1000 });
  const session = (sid: string, records: unknown[]) => home.transcript('-work-alpha', sid, [rec.title(sid, `title of ${sid}`), ...records]);
  session('ask', [rec.assistant(at('ask', 0), { id: 'q1', content: [rec.toolUse('q-tool', 'AskUserQuestion', { questions: [] })] })]);
  session('pend', [rec.assistant(at('pend', 0), { id: 'p1', content: [rec.toolUse('p-tool', 'Bash', { command: 'npm test' })] })]);
  session('quick', [rec.assistant(at('quick', 80), { id: 'k1', content: [rec.toolUse('k-tool', 'Bash', { command: 'npm test' })] })]);
  session('blocked', [rec.assistant(at('blocked', 0), { id: 'b1' }), rec.hook(at('blocked', 1), 'hook_success', { event: 'PostToolUse', command: 'ok.py' }), rec.hook(at('blocked', 2), 'hook_blocking_error', { event: 'Stop', command: 'gate.py' })]);
  session('unblocked', [rec.hook(at('unblocked', 1), 'hook_blocking_error', { event: 'Stop', command: 'gate.py' }), rec.hook(at('unblocked', 2), 'hook_success', { event: 'PostToolUse', command: 'ok.py' })]);
  session('limited', [rec.assistant(at('limited', 0), { id: 'l1' }), rec.apiError(at('limited', 50))]);
  session('recovered', [rec.apiError(at('recovered', 50)), rec.assistant(at('recovered', 55), { id: 'r1' })]);
  session('risky', [
    rec.assistant(at('risky', 10), { id: 'x1', content: [rec.toolUse('x-a', 'Bash', { command: 'git push --force' }), rec.toolUse('x-b', 'Bash', { command: 'terraform destroy' }), rec.toolUse('x-c', 'Bash', { command: 'chmod 777 a' })] }),
    rec.toolResult(at('risky', 11), 'x-a'), rec.toolResult(at('risky', 11), 'x-b'), rec.toolResult(at('risky', 11), 'x-c'),
  ]);
  session('old-risk', [rec.assistant({ sid: 'old-risk', at: T0 - 25 * 3600_000 }, { id: 'o1', content: [rec.toolUse('o-a', 'Bash', { command: 'git push --force' })] }), rec.toolResult({ sid: 'old-risk', at: T0 - 25 * 3600_000 + 1 }, 'o-a')]);
  const tampered = session('tampered', [rec.assistant(at('tampered', 0), { id: 't1' }), rec.assistant(at('tampered', 1), { id: 't2' })]);
  session('calm', [rec.assistant(at('calm', 0), { id: 'c1', content: [rec.toolUse('c-tool', 'Bash', { command: 'ls' })] }), rec.toolResult(at('calm', 1), 'c-tool')]);
  for (const [i, sid] of ['ask', 'pend', 'quick', 'blocked', 'unblocked', 'calm'].entries()) register(home, String(300 + i), { pid: process.pid, sessionId: sid, status: 'busy' });
  // the same pending tool in a session that is not running needs nobody
  session('pend-dead', [rec.assistant(at('pend-dead', 0), { id: 'pd1', content: [rec.toolUse('pd-tool', 'Bash', { command: 'npm test' })] })]);

  const c = await start(home, { now: () => T0 + 120_000 });
  try {
    writeFileSync(tampered, lines([rec.assistant(at('tampered', 0), { id: 't1' })]));
    await c.app.index();
    const live = await c.get('/api/live');
    assert.deepEqual(
      live.attention.map((a: any) => [a.reason, a.session]),
      [['integrity', 'tampered'], ['question', 'ask'], ['blocked', 'blocked'], ['tool_pending', 'pend'], ['rate_limited', 'limited'], ['finding', 'risky']],
    );
    const by = (reason: string) => live.attention.find((a: any) => a.reason === reason);
    assert.equal(by('question').title, 'title of ask');
    assert.equal(by('tool_pending').since, T0);
    assert.match(by('tool_pending').detail, /Bash/);
    assert.equal(by('finding').count, 2); // high and critical only: the chmod is medium
    assert.equal(by('rate_limited').since, T0 + 50_000);
    assert.equal(by('blocked').project, '-work-alpha');
    // running sessions carry their own reasons
    assert.deepEqual(live.sessions.find((s: any) => s.id === 'ask').attention, ['question']);
    assert.deepEqual(live.sessions.find((s: any) => s.id === 'calm').attention, []);
    // acknowledging the findings and the alert clears their rows
    for (const id of ['x-a:git.force-push', 'x-b:infra.destroy']) assert.equal((await c.post(`/api/audit/findings/${encodeURIComponent(id)}/triage`, { state: 'acknowledged' })).status, 200);
    const alert = (await c.get('/api/audit/integrity')).items[0];
    assert.equal((await c.post(`/api/audit/integrity/${alert.id}/ack`, {})).status, 200);
    assert.deepEqual((await c.get('/api/live')).attention.map((a: any) => a.reason), ['question', 'blocked', 'tool_pending', 'rate_limited']);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-11 the thresholds: 60 seconds for a pending tool, 15 minutes for a rate limit', async () => {
  const home = new Home();
  home.transcript('-work-alpha', 'pend', [rec.assistant({ sid: 'pend', at: T0 }, { id: 'p1', content: [rec.toolUse('p-tool', 'Bash', { command: 'npm test' })] })]);
  home.transcript('-work-alpha', 'limited', [rec.apiError({ sid: 'limited', at: T0 })]);
  register(home, '400', { pid: process.pid, sessionId: 'pend', status: 'busy' });
  let now = T0 + 60_000;
  const c = await start(home, { now: () => now });
  try {
    const reasons = async () => (await c.get('/api/live')).attention.map((a: any) => a.reason);
    assert.deepEqual(await reasons(), ['rate_limited']); // exactly 60 s is not "more than a minute"
    now = T0 + 60_001;
    assert.deepEqual(await reasons(), ['tool_pending', 'rate_limited']);
    now = T0 + 15 * 60_000 + 1;
    assert.deepEqual(await reasons(), ['tool_pending']);
  } finally {
    await c.close();
    home.destroy();
  }
});
