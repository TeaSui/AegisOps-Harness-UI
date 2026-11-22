import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { richHome, SECRETS, start, T0, type Client, type Home } from './fixture.ts';

async function withRich(fn: (c: Client, home: Home) => Promise<void>, o: { changesHome?: boolean } = {}) {
  const home = richHome();
  const before = home.snapshot();
  const c = await start(home);
  try {
    await fn(c, home);
  } finally {
    await c.close();
  }
  if (!o.changesHome) assert.equal(home.snapshot(), before, 'the Claude home changed');
  home.destroy();
}

const ids = (r: any) => r.items.map((s: any) => s.id);

test('AEGIS-12 filters combine with AND', () =>
  withRich(async (c) => {
    assert.deepEqual(ids(await c.get('/api/sessions')), ['plain', 'rich']);
    assert.deepEqual(ids(await c.get('/api/sessions?project=-work-alpha')), ['rich']);
    assert.deepEqual(ids(await c.get('/api/sessions?model=m-cheap')), ['plain']);
    assert.deepEqual(ids(await c.get('/api/sessions?entrypoint=sdk-cli')), ['plain']);
    assert.deepEqual(ids(await c.get('/api/sessions?errors=1')), ['rich']);
    assert.deepEqual(ids(await c.get('/api/sessions?risk=high')), ['rich']);
    assert.deepEqual(ids(await c.get('/api/sessions?risk=critical')), []);
    // the time range selects sessions whose activity overlaps it
    assert.deepEqual(ids(await c.get(`/api/sessions?from=${T0 + 20_000}&to=${T0 + 25_000}`)), ['rich']);
    assert.deepEqual(ids(await c.get(`/api/sessions?from=${T0 + 3_600_000}`)), ['plain']);
    assert.deepEqual(ids(await c.get(`/api/sessions?to=${T0 - 1}`)), []);
    assert.deepEqual(ids(await c.get('/api/sessions?project=-work-alpha&model=m-cheap')), []);
    assert.deepEqual(ids(await c.get('/api/sessions?project=-work-alpha&errors=1&risk=medium')), ['rich']);
    // plain: 1000 x 1 + 100 x 5 = 0.0015 USD; rich costs more than twice that in output tokens alone
    assert.deepEqual(ids(await c.get('/api/sessions?sort=cost')), ['rich', 'plain']);
    const paged = await c.get('/api/sessions?limit=1&offset=1');
    assert.deepEqual(ids(paged), ['rich']);
    assert.equal(paged.total, 2);
    assert.equal((await c.getRes('/api/sessions?limit=5000')).status, 400);
    assert.equal((await c.getRes('/api/sessions?risk=enormous')).status, 400);
  }));

test('AEGIS-12 text search finds a session by a word of its prompt, reply or command', () =>
  withRich(async (c) => {
    const byPrompt = await c.get('/api/sessions?q=zebra');
    assert.deepEqual(ids(byPrompt), ['rich']);
    const snippet = byPrompt.items[0].snippets[0];
    assert.match(snippet.text, /\u0002zebra\u0003/i);
    assert.ok(snippet.line > 0 && snippet.file > 0);
    assert.deepEqual(ids(await c.get('/api/sessions?q=giraffe+short')), ['plain']); // a reply, every word required
    assert.deepEqual(ids(await c.get('/api/sessions?q=giraffe+zebra')), []);
    assert.deepEqual(ids(await c.get('/api/sessions?q=push+force')), ['rich']); // a command
    assert.deepEqual(ids(await c.get('/api/sessions?q=gir')), ['plain']); // prefix
    assert.deepEqual(ids(await c.get('/api/sessions?q=zebra&project=-work-beta')), []);
    assert.equal((await c.getRes('/api/sessions?q=z')).status, 400);
    // operators of the search engine are plain text here
    assert.deepEqual(ids(await c.get('/api/sessions?q=' + encodeURIComponent('zebra" OR giraffe NEAR(*'))), []);
    // DATA-04: a secret cannot be found by searching for it
    assert.deepEqual(ids(await c.get('/api/sessions?q=' + SECRETS.password)), []);
    assert.deepEqual(ids(await c.get('/api/sessions?q=' + SECRETS.apiKey)), []);
  }));

test('AEGIS-13 a tool call appears once, paired with its result, duration, outcome and permission', () =>
  withRich(async (c) => {
    const t = await c.get('/api/sessions/rich/timeline');
    const tools = t.items.filter((i: any) => i.kind === 'tool');
    assert.deepEqual(tools.map((i: any) => i.id), ['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
    const [t1, t2, t3, t4, t5, t6] = tools;
    assert.equal(t1.name, 'Bash');
    assert.equal(t1.target, 'git push --force origin main');
    assert.equal(t1.status, 'ok');
    assert.equal(t1.durationMs, 3000);
    assert.deepEqual(t1.allowedBy, { decision: 'accept', source: 'config', reason: 'classifier' });
    assert.ok(t1.result.line > t1.line);
    assert.equal(t2.allowedBy, null); // not recorded
    assert.equal(t2.status, 'ok');
    assert.equal(t3.status, 'error');
    assert.equal(t3.result.text, 'String to replace not found');
    assert.equal(t4.status, 'denied');
    assert.equal(t4.denialKind, 'user-rejected');
    assert.deepEqual(t4.allowedBy, { decision: 'reject', source: 'config', reason: 'bashMiss:too-complex' });
    assert.equal(t5.status, 'pending');
    assert.equal(t5.durationMs, null);
    assert.equal(t5.result, null);
    assert.equal(t6.category, 'mcp');
    assert.equal(t6.mcpServer, 'github');
    // the same facts are on the session summary
    const s = await c.get('/api/sessions/rich');
    assert.equal(s.toolCalls, 7);
    assert.equal(s.toolErrors, 1);
    assert.equal(s.toolDenied, 1);
  }));

test('AEGIS-14 compactions, hooks, API errors and mode changes sit in place in the timeline', () =>
  withRich(async (c) => {
    const t = await c.get('/api/sessions/rich/timeline');
    const kinds = t.items.map((i: any) => (i.kind === 'tool' ? i.id : i.kind));
    assert.deepEqual(kinds, [
      'permission_mode', 'prompt', 'reply', 't1', 't2', 't3', 't4', 'compaction', 'hook', 'api_error', 'permission_mode', 't5', 't6', 't7', 'prompt', 'reply',
    ]);
    const item = (kind: string, nth = 0) => t.items.filter((i: any) => i.kind === kind)[nth];
    assert.deepEqual(
      { trigger: item('compaction').trigger, pre: item('compaction').preTokens, post: item('compaction').postTokens, freed: item('compaction').freed },
      { trigger: 'auto', pre: 150000, post: 30000, freed: 120000 },
    );
    assert.deepEqual(
      { event: item('hook').event, status: item('hook').status, command: item('hook').command, ms: item('hook').durationMs },
      { event: 'PostToolUse', status: 'error', command: 'python3 gate.py', ms: 120 },
    );
    assert.equal(item('api_error').status, '429');
    assert.equal(item('permission_mode', 0).mode, 'default');
    assert.deepEqual({ mode: item('permission_mode', 1).mode, from: item('permission_mode', 1).from }, { mode: 'acceptEdits', from: 'default' });
    assert.equal(item('prompt').text, 'please deploy the zebra service');
    assert.equal(item('prompt').origin, 'human');
    // paging
    const paged = await c.get('/api/sessions/rich/timeline?offset=1&limit=2');
    assert.deepEqual(paged.items.map((i: any) => i.kind), ['prompt', 'reply']);
    assert.equal(paged.total, t.total);
    assert.equal((await c.getRes('/api/sessions/rich/timeline?limit=1001')).status, 400);
    assert.equal((await c.getRes('/api/sessions/nope/timeline')).status, 404);
  }));

test('AEGIS-15 every item cites a transcript line whose raw record is that line', () =>
  withRich(async (c, home) => {
    const fileLines = readFileSync(home.path('-work-alpha', 'rich'), 'utf8').split('\n');
    const t = await c.get('/api/sessions/rich/timeline');
    for (const item of t.items) {
      assert.ok(Number.isInteger(item.file) && Number.isInteger(item.line) && item.line >= 1, `${item.kind} has no pointer`);
    }
    // a record with no secret comes back exactly as written
    const prompt = t.items.find((i: any) => i.kind === 'prompt');
    const record = await c.get(`/api/records/${prompt.file}/${prompt.line}`);
    assert.deepEqual(JSON.parse(record.text), JSON.parse(fileLines[prompt.line - 1]));
    assert.equal(record.path, 'projects/-work-alpha/rich.jsonl');
    assert.equal(record.line, prompt.line);
    const t1 = t.items.find((i: any) => i.id === 't1');
    assert.equal(JSON.parse((await c.get(`/api/records/${t1.file}/${t1.line}`)).text).message.content[1].input.command, 'git push --force origin main');
    assert.equal(JSON.parse((await c.get(`/api/records/${t1.file}/${t1.result.line}`)).text).message.content[0].tool_use_id, 't1');
    // ledger rows carry the same pointer (the audit view reads them)
    const s = await c.get('/api/sessions/rich');
    assert.equal(s.agents[0].file, prompt.file);
  }));

test('AEGIS-16 context size per response, and what each compaction freed', () =>
  withRich(async (c) => {
    const ctx = await c.get('/api/sessions/rich/context');
    assert.deepEqual(
      ctx.calls.map((x: any) => [x.messageId, x.context]),
      [['r1', 1000], ['r2', 2000], ['r3', 10], ['r4', 10], ['r5', 10]],
    );
    assert.equal(ctx.calls[0].ts, T0 + 1000);
    assert.ok(ctx.calls[0].line > 0);
    assert.deepEqual(ctx.compactions, [{ ts: T0 + 20_000, trigger: 'auto', preTokens: 150000, postTokens: 30000, freed: 120000, line: ctx.compactions[0].line, file: ctx.compactions[0].file }]);
  }));

test('AEGIS-17 files read, edited and written, with counts', () =>
  withRich(async (c) => {
    const f = await c.get('/api/sessions/rich/files');
    assert.deepEqual(f.items, [
      { path: '/etc/hosts', read: 0, edit: 0, write: 1 },
      { path: '/work/alpha/src/app.ts', read: 1, edit: 1, write: 0 },
    ]);
  }));

test('AEGIS-23 secrets are masked everywhere; one record can be revealed and the reveal is logged', () =>
  withRich(async (c, home) => {
    const t = await c.get('/api/sessions/rich/timeline');
    const seen: string[] = [JSON.stringify(t)];
    for (const path of ['/api/sessions', '/api/sessions/rich', '/api/sessions?q=key', '/api/sessions?q=curl', '/api/sessions/rich/context', '/api/sessions/rich/files']) {
      seen.push(JSON.stringify(await c.get(path)));
    }
    const lineCount = readFileSync(home.path('-work-alpha', 'rich'), 'utf8').trim().split('\n').length;
    for (let line = 1; line <= lineCount; line++) seen.push(JSON.stringify(await c.get(`/api/records/${t.file}/${line}`)));
    for (const name of readdirSync(home.stateDir)) seen.push(readFileSync(join(home.stateDir, name)).toString('latin1'));
    const all = seen.join('\n');
    for (const [name, secret] of Object.entries(SECRETS)) assert.ok(!all.includes(secret), `the ${name} secret leaked`);
    // the masks say what they hide
    assert.match(all, /\[masked:anthropic-key\]/);
    assert.match(all, /\[masked:private-key\]/);
    assert.match(all, /Bearer \[masked:auth\]/);
    assert.match(all, /\[masked:url-credential\]@example\.com/);
    const t4 = t.items.find((i: any) => i.id === 't4');
    assert.match(t4.target, /api_key=\[masked:value\]/);
    // no parameter turns masking off
    const secretPrompt = t.items.filter((i: any) => i.kind === 'prompt')[1];
    for (const suffix of ['?reveal=1', '?mask=0', '?raw=1']) {
      assert.ok(!JSON.stringify(await c.get(`/api/records/${secretPrompt.file}/${secretPrompt.line}${suffix}`)).includes(SECRETS.password));
    }
    // reveal: a state-changing request for one record
    assert.equal((await c.getRes(`/api/records/${secretPrompt.file}/${secretPrompt.line}/reveal`)).status, 404);
    const revealed = await c.post(`/api/records/${secretPrompt.file}/${secretPrompt.line}/reveal`);
    assert.equal(revealed.status, 200);
    assert.equal(revealed.headers.get('cache-control'), 'no-store');
    const body: any = await revealed.json();
    assert.ok(JSON.parse(body.text).message.content.includes(SECRETS.password));
    const activity = await c.get('/api/audit/activity');
    assert.equal(activity.items[0].action, 'reveal');
    assert.equal(activity.items[0].file, secretPrompt.file);
    assert.equal(activity.items[0].line, secretPrompt.line);
    assert.ok(activity.items[0].at > 0);
    assert.ok(!JSON.stringify(activity).includes(SECRETS.password));
  }));

test('AEGIS-15 record selectors outside the index are refused', () =>
  withRich(async (c, home) => {
    const t = await c.get('/api/sessions/rich/timeline');
    for (const path of [
      '/api/records/999/1',
      `/api/records/${t.file}/0`,
      `/api/records/${t.file}/99999`,
      `/api/records/${t.file}/-1`,
      `/api/records/${t.file}/1.5`,
      '/api/records/..%2F..%2Fetc%2Fpasswd/1',
      '/api/records/%2Fetc%2Fpasswd/1',
      `/api/records/${t.file}%00/1`,
      '/api/sessions/..%2F..%2F..%2Fetc%2Fpasswd',
      '/api/sessions/..%2Frich/timeline',
      '/api/sessions/rich/timeline?agent=..%2F..%2Fx',
    ]) {
      assert.equal((await c.getRes(path)).status, 404, path);
    }
    assert.equal((await c.post(`/api/records/999/1/reveal`)).status, 404);
    // a symbolic link that points out of the Claude home is never indexed or served
    const outside = join(home.root, 'outside.jsonl');
    writeFileSync(outside, JSON.stringify({ type: 'user', message: { role: 'user', content: 'escaped' }, timestamp: new Date(T0).toISOString() }) + '\n');
    symlinkSync(outside, join(home.claudeHome, 'projects', '-work-alpha', 'escape.jsonl'));
    await c.app.index();
    assert.deepEqual(ids(await c.get('/api/sessions')), ['plain', 'rich']);
    assert.equal((await c.getRes('/api/sessions/escape')).status, 404);
  }, { changesHome: true }));
