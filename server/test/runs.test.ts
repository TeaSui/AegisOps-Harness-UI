import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Home, rec, start, T0, type Client } from './fixture.ts';

// A stand-in for the harness binary: records how it was started, writes a transcript for its session
// like the real one would, and keeps running when the prompt says so. No test spends tokens.
const STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const out = process.env.STUB_OUT;
  const argv = process.argv.slice(2);
  const sid = argv[argv.indexOf('--session-id') + 1];
  fs.writeFileSync(path.join(out, sid + '.invocation.json'), JSON.stringify({ argv, cwd: process.cwd(), stdin: input, env: Object.keys(process.env) }));
  const dir = path.join(process.env.STUB_CLAUDE_HOME, 'projects', '-launched');
  fs.mkdirSync(dir, { recursive: true });
  const rec = { type: 'user', uuid: 'u1', sessionId: sid, cwd: process.cwd(), timestamp: '${new Date(T0).toISOString()}', entrypoint: 'sdk-cli', promptSource: 'sdk', message: { role: 'user', content: input } };
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify(rec) + '\\n');
  if (input.includes('fail')) { console.error('stub: something went wrong, password=stubsecret99'); process.exit(3); }
  if (input.includes('register')) {
    const reg = path.join(process.env.STUB_CLAUDE_HOME, 'sessions');
    fs.mkdirSync(reg, { recursive: true });
    fs.writeFileSync(path.join(reg, process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: process.cwd(), status: 'busy', kind: 'headless', startedAt: Date.now() }));
  }
  if (input.includes('stubborn')) process.on('SIGINT', () => {});
  if (input.includes('sleep')) setInterval(() => {}, 1000); else process.exit(0);
});
`;

type Ctx = { c: Client; home: Home; project: string; out: string; invocation: (sid: string) => any };

async function withControl(fn: (x: Ctx) => Promise<void>, control = true) {
  const home = new Home();
  const project = realpathSync(home.root) + '/repo';
  mkdirSync(project);
  const out = join(home.root, 'out');
  mkdirSync(out);
  const bin = join(home.root, 'claude-stub');
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  home.transcript('-repo', 'known', [rec.prompt({ sid: 'known', cwd: project, at: T0 }, 'earlier work')]);
  home.transcript('-gone', 'gone', [rec.prompt({ sid: 'gone', cwd: join(home.root, 'deleted-dir'), at: T0 }, 'earlier work')]);
  process.env.STUB_OUT = out;
  process.env.STUB_CLAUDE_HOME = home.claudeHome;
  process.env.AEGIS_INTERNAL_THING = 'must-not-reach-the-child';
  const c = await start(home, { control, claudeBin: bin });
  try {
    await fn({ c, home, project, out, invocation: (sid) => JSON.parse(readFileSync(join(out, `${sid}.invocation.json`), 'utf8')) });
  } finally {
    await c.close();
    delete process.env.AEGIS_INTERNAL_THING;
    home.destroy();
  }
}

async function until<T>(read: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const runState = async (c: Client, id: string) => (await c.get('/api/runs')).items.find((r: any) => r.id === id);

test('AEGIS-31 a launch starts the harness with an exact argument list, the prompt on stdin, and appears as a session', () =>
  withControl(async ({ c, project, out, invocation }) => {
    const prompt = '--dangerously-skip-permissions\nsummarise "the" repo; $(rm -rf /) `id`';
    const res = await c.post('/api/runs', { project: '-repo', prompt, model: 'sonnet', permissionMode: 'plan' });
    assert.equal(res.status, 200);
    const run: any = await res.json();
    assert.match(run.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(run.project, '-repo');
    assert.ok(['starting', 'running', 'exited'].includes(run.state));
    await until(() => existsSync(join(out, `${run.sessionId}.invocation.json`)), 'the stub to start');
    const inv = invocation(run.sessionId);
    // AUTHZ-03, INPUT-07: fixed flags plus validated fields; the prompt is not an argument
    assert.deepEqual(inv.argv, ['-p', '--session-id', run.sessionId, '--permission-mode', 'plan', '--model', 'sonnet']);
    assert.equal(inv.stdin, prompt);
    assert.equal(inv.cwd, project);
    assert.deepEqual(inv.env.filter((k: string) => k.startsWith('AEGIS_')), []);
    assert.ok(inv.env.includes('PATH') && inv.env.includes('STUB_OUT'));
    const done = await until(async () => {
      const r = await runState(c, run.id);
      return r.state === 'exited' ? r : undefined;
    }, 'the run to exit');
    assert.equal(done.exitCode, 0);
    // it is observed through its transcript like any other session
    await c.app.index();
    const session = await c.get(`/api/sessions/${run.sessionId}`);
    assert.equal(session.cwd, project);
    assert.equal(session.entrypoint, 'sdk-cli');
    // no model is no --model flag
    const plain: any = await (await c.post('/api/runs', { project: '-repo', prompt: 'hello', permissionMode: 'acceptEdits' })).json();
    await until(() => existsSync(join(out, `${plain.sessionId}.invocation.json`)), 'the second stub');
    assert.deepEqual(invocation(plain.sessionId).argv, ['-p', '--session-id', plain.sessionId, '--permission-mode', 'acceptEdits']);
    // LOG-02: the launch is logged with the prompt's length and hash, never its text
    const logged = (await c.get('/api/audit/activity')).items.find((a: any) => a.action === 'run-launch' && a.run === run.id);
    assert.deepEqual({ project: logged.project, model: logged.model, mode: logged.mode, length: logged.promptLength }, { project: '-repo', model: 'sonnet', mode: 'plan', length: prompt.length });
    assert.match(logged.promptHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(await c.get('/api/audit/activity')).includes('summarise'));
    assert.ok(!JSON.stringify(await c.get('/api/runs')).includes('summarise'));
    assert.equal((await c.get('/api/overview')).control, true);
  }));

test('AEGIS-31 a run that fails keeps its exit code and the end of its error output', () =>
  withControl(async ({ c }) => {
    const run: any = await (await c.post('/api/runs', { project: '-repo', prompt: 'please fail', permissionMode: 'manual' })).json();
    const done = await until(async () => {
      const r = await runState(c, run.id);
      return r.state === 'exited' ? r : undefined;
    }, 'the run to exit');
    assert.equal(done.exitCode, 3);
    assert.match(done.stderrTail, /something went wrong, password=\[masked:value\]/); // child output is masked like any text
  }));

test('AEGIS-32 a launched run can be stopped; an unknown run cannot', () =>
  withControl(async ({ c, out }) => {
    const run: any = await (await c.post('/api/runs', { project: '-repo', prompt: 'sleep for a long time', permissionMode: 'auto' })).json();
    await until(() => existsSync(join(out, `${run.sessionId}.invocation.json`)), 'the stub to start');
    assert.equal((await runState(c, run.id)).state, 'running');
    const stop = await c.post(`/api/runs/${run.id}/stop`);
    assert.equal(stop.status, 200);
    const ended = await until(async () => {
      const r = await runState(c, run.id);
      return r.state === 'exited' ? r : undefined;
    }, 'the run to stop');
    assert.equal(ended.signal, 'SIGINT');
    assert.ok(ended.stopRequestedAt > 0);
    // stopping a finished run returns its state; an unknown id is 404; a process id is not an id
    assert.equal(((await (await c.post(`/api/runs/${run.id}/stop`)).json()) as any).state, 'exited');
    assert.equal((await c.post('/api/runs/does-not-exist/stop')).status, 404);
    assert.equal((await c.post(`/api/runs/${process.pid}/stop`)).status, 404);
    assert.ok((await c.get('/api/audit/activity')).items.some((a: any) => a.action === 'run-stop' && a.run === run.id));
  }));

test('AEGIS-31 AEGIS-32 a launched run shows among the live sessions, and one that ignores the interrupt is killed', () =>
  withControl(async ({ c, out, project }) => {
    const run: any = await (await c.post('/api/runs', { project: '-repo', prompt: 'register, be stubborn and sleep', permissionMode: 'plan' })).json();
    await until(() => existsSync(join(out, `${run.sessionId}.invocation.json`)), 'the stub to start');
    await c.app.index();
    const live = await c.get('/api/live');
    const mine = live.sessions.find((s: any) => s.id === run.sessionId);
    assert.deepEqual({ status: mine.status, cwd: mine.cwd, entrypoint: mine.entrypoint }, { status: 'busy', cwd: project, entrypoint: 'sdk-cli' });
    const asked = Date.now();
    await c.post(`/api/runs/${run.id}/stop`);
    const ended = await until(async () => {
      const r = await runState(c, run.id);
      return r.state === 'exited' ? r : undefined;
    }, 'the stubborn run to be killed', 12_000);
    assert.equal(ended.signal, 'SIGKILL');
    assert.ok(Date.now() - asked >= 4500, 'the kill came before the 5 second grace');
    assert.equal((await c.get('/api/live')).sessions.some((s: any) => s.id === run.sessionId), false);
  }));

test('AEGIS-31 a run starts in the project folder even when the latest session had moved into a subfolder', () =>
  withControl(async ({ c, home, out, project, invocation }) => {
    home.transcript('-repo', 'moved', [rec.prompt({ sid: 'moved', cwd: project + '/packages/deep', at: T0 + 9_000_000 }, 'later work in a subfolder')]);
    await c.app.index();
    const run: any = await (await c.post('/api/runs', { project: '-repo', prompt: 'hello', permissionMode: 'plan' })).json();
    await until(() => existsSync(join(out, `${run.sessionId}.invocation.json`)), 'the stub to start');
    assert.equal(invocation(run.sessionId).cwd, project);
  }));

test('AEGIS-33 a bypass mode, a bad model, an unknown project and a bad prompt are refused and nothing starts', () =>
  withControl(async ({ c, out }) => {
    const ok = { project: '-repo', prompt: 'hello', permissionMode: 'plan' };
    const bad: Array<[string, Record<string, unknown>]> = [
      ['bypass mode', { ...ok, permissionMode: 'bypassPermissions' }],
      ['unknown mode', { ...ok, permissionMode: 'default' }],
      ['missing mode', { project: '-repo', prompt: 'hello' }],
      ['mode with a flag', { ...ok, permissionMode: 'plan --dangerously-skip-permissions' }],
      ['model with a space', { ...ok, model: 'sonnet --dangerously-skip-permissions' }],
      ['model that is a flag', { ...ok, model: '--dangerously-skip-permissions' }],
      ['model with shell characters', { ...ok, model: 'sonnet;id' }],
      ['model too long', { ...ok, model: 'a'.repeat(101) }],
      ['model not text', { ...ok, model: 5 }],
      ['unknown project', { ...ok, project: '-nope' }],
      ['project as a path', { ...ok, project: '/tmp' }],
      ['project whose directory is gone', { ...ok, project: '-gone' }],
      ['empty prompt', { ...ok, prompt: '' }],
      ['prompt too long', { ...ok, prompt: 'x'.repeat(100_001) }],
      ['prompt not text', { ...ok, prompt: ['hello'] }],
      ['extra arguments', { ...ok, args: ['--dangerously-skip-permissions'] }],
    ];
    for (const [what, body] of bad) assert.equal((await c.post('/api/runs', body)).status, 400, what);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual((await c.get('/api/runs')).items, []);
    assert.deepEqual(readdirSync(out), []); // the stub never ran
    assert.deepEqual((await c.get('/api/runs')).modes, ['plan', 'manual', 'acceptEdits', 'auto', 'dontAsk']);
  }));

test('AEGIS-31 at most 4 runs are active', () =>
  withControl(async ({ c }) => {
    const launch = () => c.post('/api/runs', { project: '-repo', prompt: 'sleep', permissionMode: 'plan' });
    const first = await Promise.all([launch(), launch(), launch(), launch()]);
    assert.deepEqual(first.map((r) => r.status), [200, 200, 200, 200]);
    assert.equal((await launch()).status, 429);
    const ids = (await Promise.all(first.map((r) => r.json()))).map((r: any) => r.id);
    await c.post(`/api/runs/${ids[0]}/stop`);
    await until(async () => (await runState(c, ids[0])).state === 'exited', 'a slot to free up');
    assert.equal((await launch()).status, 200);
  }));

test('AEGIS-33 without control mode the run routes do not exist', () =>
  withControl(async ({ c }) => {
    assert.equal((await c.post('/api/runs', { project: '-repo', prompt: 'hello', permissionMode: 'plan' })).status, 404);
    assert.equal((await c.getRes('/api/runs')).status, 404);
    assert.equal((await c.post('/api/runs/x/stop')).status, 404);
    assert.equal((await c.get('/api/overview')).control, false);
  }, false));

test('AEGIS-33 control mode without a harness binary fails the start', async () => {
  const home = new Home();
  await assert.rejects(start(home, { control: true, claudeBin: join(home.root, 'no-such-binary') }), /harness binary/);
  home.destroy();
});
