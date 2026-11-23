import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Home, rec, richHome, SECRETS, start, T0, type Client } from './fixture.ts';

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

test('AEGIS-23 credential shapes: short, spaced, flagged, deeply nested and cut-off secrets are all masked', async () => {
  const home = new (await import('./fixture.ts')).Home();
  const { rec } = await import('./fixture.ts');
  const b = { sid: 'm', at: T0 };
  const secrets = ['kkk111', 'ttt222', 'tok999abc', 's3cr3tvalue', 'shorty', 'nestedhello', 'straddle' + 'Z'.repeat(40), 'abcdefgh', 'hunter', 'ab,cdefgh12', 'abc;defg1234', 'correct horse battery staple', 'my long pass phrase here', 'Sup3rSecret', 'Hunter2Pass', 'p%40ss/word', 'tinypw', 'lQIVBGZ1PGPKEYBODY', '987654321', 'ghp_deep' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4o5'];
  let nested: any = { k: secrets[12] };
  for (let i = 0; i < 70; i++) nested = { level: nested };
  const token = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
  home.transcript('-work-alpha', 'm', [
    rec.prompt(b, [
      '{"token":"abcdefgh"}', '--secret hunter', 'password=ab,cdefgh12', 'PASSWORD=abc;defg1234', 'password: correct horse battery staple',
      "passphrase='my long pass phrase here'", 'curl -u admin:Sup3rSecret https://x.example', 'mysql -u root -pHunter2Pass db', 'postgres://u:p%40ss/word@db.example/app',
      'db_pwd=tinypw', '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQIVBGZ1PGPKEYBODY\n-----END PGP PRIVATE KEY BLOCK-----',
      // not secrets: a count under a token name, and a word that merely starts like "password"
      'max_tokens=4096 and input_tokens: 862', 'passed: true', 'Authorization: Bearer abcdefghijklmnop1234',
      '{"max_tokens": 4096} {"usage":{"input_tokens":862,"output_tokens":5}}', 'API_KEY=kkk111;echo hi && TOKEN=ttt222&y=2', 'PWD=/Users/x and pwd: /tmp', 'see Basic authentication docs',
      'Authorization: Token tok999abc', 'Authorization: ApiKey s3cr3tvalue', 'Authorization: Bearer shorty',
    ].join('\n')),
    rec.assistant(b, {
      id: 'm1',
      content: [
        rec.toolUse('deep', 'mcp__x__call', { nested, password: 987654321, max_tokens: 4096, credentials: { user: { value: 'nestedhello' } }, usage_tokens: { input: 7 } }),
        // a secret that straddles character 16,000 of a long reply
        rec.text('y '.repeat(7990) + 'secret=straddle' + 'Z'.repeat(40) + ' tail'),
        // the secret sits just past where the evidence is cut
        rec.toolUse('cut', 'Bash', { command: `git push --force origin ${'x'.repeat(575)} ${token}` }),
      ],
    }),
  ]);
  const c = await start(home);
  try {
    const t = await c.get('/api/sessions/m/timeline');
    const all = [JSON.stringify(t), JSON.stringify(await c.get('/api/audit/findings')), JSON.stringify(await c.get('/api/audit/ledger')), JSON.stringify(await c.get(`/api/records/${t.file}/1`)), JSON.stringify(await c.get(`/api/records/${t.file}/2`)), await (await c.getRes('/api/audit/findings/export?format=csv')).text(), await (await c.getRes('/api/audit/ledger/export?format=jsonl')).text()];
    for (const name of readdirSync(home.stateDir)) all.push(readFileSync(join(home.stateDir, name)).toString('latin1'));
    const text = all.join('\n');
    for (const s of secrets) assert.ok(!text.includes(s), `leaked: ${s}`);
    for (let n = 8; n <= token.length; n++) assert.ok(!text.includes(token.slice(0, n)), `a ${n}-character prefix of the cut token leaked`);
    const prompt = t.items.find((i: any) => i.kind === 'prompt').text;
    assert.match(prompt, /max_tokens=4096 and input_tokens: 862/);
    assert.match(prompt, /passed: true/);
    // structure around a masked value survives, counts stay counts, and the working directory is not a password
    assert.match(prompt, /\{"max_tokens": 4096\} \{"usage":\{"input_tokens":862,"output_tokens":5\}\}/);
    assert.match(prompt, /API_KEY=\[masked:value\];echo hi && TOKEN=\[masked:value\]&y=2/);
    assert.match(prompt, /PWD=\/Users\/x and pwd: \/tmp/);
    assert.match(prompt, /see Basic authentication docs/);
    assert.match(prompt, /Authorization: Token \[masked:auth\]\nAuthorization: ApiKey \[masked:auth\]\nAuthorization: Bearer \[masked:auth\]/);
    assert.match(prompt, /Authorization: Bearer \[masked:auth\]/);
    assert.match(prompt, /\[masked:private-key\]/);
    const record = JSON.parse((await c.get(`/api/records/${t.file}/2`)).text);
    assert.equal(record.message.content[0].input.max_tokens, 4096);
    assert.equal(record.message.content[0].input.password, '[masked:value]');
    assert.equal(record.message.content[0].input.credentials.user.value, '[masked:value]');
    assert.equal(record.message.content[0].input.usage_tokens.input, 7);
    assert.equal(record.message.usage.input_tokens, 0); // usage numbers stay readable
    assert.equal((await c.get('/api/audit/findings')).items.find((f: any) => f.toolCall === 'cut').rule, 'git.force-push');
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-13 long text is cut with a flag, a result with no call is ignored, and counts are per call', async () => {
  const { Home, rec, lines: toLines } = await import('./fixture.ts');
  const home = new Home();
  const b = { sid: 'L', cwd: "/work/it's $(here)", at: T0 };
  const big = 'word '.repeat(60_000); // 300,000 characters
  home.transcript('-work-alpha', 'L', [
    rec.prompt(b, 'p'.repeat(5000)),
    rec.toolResult(b, 'orphan'),
    rec.assistant(b, { id: 'l1', content: [rec.toolUse('f1', 'Read', { file_path: '/a.ts' }), rec.toolUse('f2', 'Read', { file_path: '/a.ts' }), rec.toolUse('f3', 'Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' })] }),
    rec.toolResult(b, 'f1', { content: big }),
  ]);
  // a forked session copies history: the same response id in a second file is not counted again
  home.transcript('-work-alpha', 'Lfork', [rec.assistant({ sid: 'Lfork', at: T0 + 5 }, { id: 'l1', usage: { input: 999 } }), rec.assistant({ sid: 'Lfork', at: T0 + 6 }, { id: 'l2', usage: { input: 3 } })]);
  // a line over the limit is skipped and counted, and the lines after it are still read
  home.transcript('-work-alpha', 'O', [rec.prompt({ sid: 'O', at: T0 }, 'x'.repeat(800_000)), rec.assistant({ sid: 'O', at: T0 }, { id: 'l9', usage: { input: 11 } })]);
  void toLines;
  const c = await start(home, { maxLineBytes: 700_000 });
  try {
    const t = await c.get('/api/sessions/L/timeline');
    const prompt = t.items.find((i: any) => i.kind === 'prompt');
    assert.equal(prompt.text.length, 4000);
    assert.equal(prompt.truncated, true);
    assert.deepEqual(t.items.filter((i: any) => i.kind === 'tool').map((i: any) => i.id), ['f1', 'f2', 'f3']);
    const f1 = t.items.find((i: any) => i.id === 'f1');
    assert.equal(f1.result.text.length, 4000);
    assert.equal(f1.result.truncated, true);
    assert.deepEqual(t.items.map((i: any) => i.seq), t.items.map((_: any, i: number) => i));
    const raw = await c.get(`/api/records/${t.file}/${f1.result.line}`);
    // each field of a raw record is masked on its first 64 KB and the rest is not shown
    assert.match(raw.text, /more characters not shown/);
    assert.ok(raw.text.length <= 256 * 1024);
    assert.deepEqual((await c.get('/api/sessions/L/files')).items, [{ path: '/a.ts', read: 2, edit: 1, write: 0 }]);
    assert.equal((await c.get('/api/ops/records')).skippedLines, 1);
    const s = await c.get('/api/sessions/L');
    assert.equal(s.apiCalls, 1);
    const o = await c.get('/api/sessions/O');
    assert.deepEqual([o.usage.input, o.prompts], [11, 0]);
    assert.deepEqual((await c.get('/api/sessions/O/timeline')).items.map((i: any) => i.kind), ['reply']); // the skipped prompt is not on the tape either
    assert.equal((await c.get('/api/sessions/Lfork')).usage.input, 3);
    // both values are single-quoted for the shell; an id that is not a plain identifier gets no command
    assert.equal(s.resumeCommand, "cd '/work/it'\\''s $(here)' && claude --resume 'L'");
    assert.equal((await c.get('/api/ops/doctor')).checks.find((x: any) => x.id === 'index.skipped').status, 'warn');
  } finally {
    await c.close();
    home.destroy();
  }
});

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

test('AEGIS-41 a session list can carry the shape of each session: its events in order, binned, worst kind per bin', async () => {
  const { binRanks } = await import('../src/sessions.ts');
  assert.deepEqual(binRanks([0, 0, 3, 1, 2, 0], 3), [0, 3, 2]);
  assert.deepEqual(binRanks([1, 2], 32), [1, 2]);
  // one failure among twenty calls does not make the stretch a failure; two do
  assert.deepEqual(binRanks([3, ...new Array(19).fill(1)], 1), [1]);
  assert.deepEqual(binRanks([3, 3, ...new Array(18).fill(1)], 1), [3]);
  assert.deepEqual(binRanks([0, 0, 2, 0], 1), [2]);
  assert.deepEqual(binRanks([], 32), []);
  const home = new Home();
  const b = (s: number) => ({ sid: 'S', at: T0 + s * 1000 });
  home.transcript('-work-alpha', 'S', [
    rec.prompt(b(0), 'do the thing'),
    rec.assistant(b(1), { id: 'm1', content: [rec.toolUse('x1', 'Bash', { command: 'ls' })] }),
    rec.toolResult(b(2), 'x1'),
    rec.assistant(b(3), { id: 'm2', content: [rec.toolUse('x2', 'Bash', { command: 'false' })] }),
    rec.toolResult(b(4), 'x2', { error: true }),
    rec.apiError(b(5)),
    rec.assistant(b(6), { id: 'm3' }),
  ]);
  // what a subagent did is part of the session's shape; the task it was handed is not one of your prompts
  home.transcript('-work-alpha', 'S', [rec.prompt({ sid: 'S', at: T0 + 6500, agentId: 'a1' }, 'look around'), rec.assistant({ sid: 'S', at: T0 + 7000, agentId: 'a1' }, { id: 'm4' })], { agent: 'a1' });
  home.transcript('-work-alpha', 'E', [rec.title('E', 'empty')]);
  const c = await start(home);
  try {
    const plain = await c.get('/api/sessions');
    assert.equal('shape' in plain.items[0], false);
    const shaped = await c.get('/api/sessions?shape=1');
    const of = (id: string) => shaped.items.find((s: any) => s.id === id).shape;
    // 0 a response, 1 a tool call, 2 a prompt of yours, 3 a failure
    assert.deepEqual(of('S'), [2, 0, 1, 0, 3, 3, 0, 0]);
    assert.deepEqual(of('E'), []);
    // a span of responses lists the sessions that got one in it, not every session whose life overlaps it
    const ids = async (q: string) => (await c.get(`/api/sessions?${q}`)).items.map((x: any) => x.id);
    assert.deepEqual(await ids(`callsFrom=${T0}&callsTo=${T0 + 10_000}`), ['S']);
    assert.deepEqual(await ids(`callsFrom=${T0 + 3500}&callsTo=${T0 + 5500}`), []);
    assert.deepEqual(await ids(`from=${T0 + 3500}&to=${T0 + 5500}`), ['S']);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-47 the path of a session: the instructions, hooks, skills, permission decisions, subagents and MCP servers it went through, in order', async () => {
  const home = new Home();
  const b = (s: number) => ({ sid: 'P', at: T0 + s * 1000 });
  const att = (s: number, attachment: Record<string, unknown>) => ({ type: 'attachment', uuid: `att-${s}-${attachment.type}`, sessionId: 'P', timestamp: new Date(T0 + s * 1000).toISOString(), cwd: '/work/alpha', attachment });
  const classifier = { decision: 'accept', source: 'config', reasonType: 'classifier' };
  home.transcript('-work-alpha', 'P', [
    att(0, { type: 'instructions', files: [{ path: '/work/alpha/CLAUDE.md', type: 'Project', content: 'TOP-SECRET-RULES' }, { path: '/home/u/.claude/rules/style.md', type: 'User', content: 'x' }] }),
    att(0, { type: 'skill_listing', skillCount: 12, isInitial: true, names: ['a'], content: 'listing-body' }),
    rec.hook(b(1), 'hook_success', { event: 'SessionStart', command: 'boot.sh' }),
    att(1, { type: 'hook_additional_context', hookName: 'SessionStart', hookEvent: 'SessionStart', content: ['ctx-body-123'] }),
    rec.prompt(b(2), 'please build it'),
    rec.assistant(b(3), { id: 'm1', content: [rec.toolUse('s1', 'Skill', { skill: 'aegisops-harness:build' })] }),
    rec.toolResult(b(4), 's1', { perm: { decision: 'accept', source: 'config', reasonType: 'rule', ruleSource: 'userSettings' } }),
    rec.assistant(b(5), {
      id: 'm2',
      content: [rec.toolUse('b1', 'Bash', { command: 'a' }), rec.toolUse('b2', 'Bash', { command: 'b' }), rec.toolUse('b3', 'Read', { file_path: '/x' })],
      extra: { attributionSkill: 'aegisops-harness:build', attributionPlugin: 'aegisops-harness' },
    }),
    rec.toolResult(b(6), 'b1', { perm: classifier }),
    rec.toolResult(b(7), 'b2', { perm: classifier }),
    rec.toolResult(b(8), 'b3', { perm: classifier }),
    rec.hook(b(9), 'hook_non_blocking_error', { event: 'PostToolUse', command: 'python3 gate.py --token=abcdef123456' }),
    rec.assistant(b(10), { id: 'm3', content: [rec.toolUse('d1', 'Bash', { command: 'rm -rf /' }), rec.toolUse('a1', 'Agent', { subagent_type: 'Explore', description: 'look around' }), rec.toolUse('g1', 'mcp__github__list_issues', {})] }),
    rec.toolResult(b(11), 'd1', { error: true, denial: 'hook', perm: { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' } }),
    rec.toolResult(b(12), 'a1', { perm: null }),
    rec.toolResult(b(13), 'g1', { perm: null }),
    rec.stopSummary(b(14), [{ command: 'stop.py', durationMs: 10 }]),
    rec.prompt(b(20), 'thanks'),
    // inside one skill the session enters another, then the first again; a stop hook fails; a call is denied with no decision recorded
    rec.assistant(b(21), { id: 'm4', content: [rec.toolUse('s2', 'Skill', { skill: 'dataviz' })], extra: { attributionSkill: 'aegisops-harness:build' } }),
    rec.assistant(b(22), { id: 'm5', content: [rec.toolUse('s3', 'Skill', { skill: 'build' }), rec.toolUse('x9', 'Bash', { command: 'x' })], extra: { attributionSkill: 'dataviz' } }),
    rec.toolResult(b(23), 'x9', { error: true, denial: 'user-rejected', perm: null }),
    rec.stopSummary(b(24), [{ command: 'stop.py', durationMs: 10 }, { command: 'other.py', durationMs: 5 }], ['boom']),
    rec.hook(b(24), 'hook_non_blocking_error', { event: 'Stop', command: 'stop.py' }),
  ]);
  home.transcript('-work-alpha', 'P', [rec.prompt({ sid: 'P', at: T0 + 12_000, agentId: 'a1' }, 'look around the repo')], { agent: 'a1' });
  const c = await start(home);
  try {
    const path = await c.get('/api/sessions/P/path');
    assert.deepEqual(
      path.steps.map((s: any) => [s.lane, s.title, s.count, s.tone, s.turn]),
      [
        ['context', 'CLAUDE.md', 1, 'plain', 0],
        ['context', 'style.md', 1, 'plain', 0],
        ['context', '12 skills offered', 1, 'plain', 0],
        ['hooks', 'SessionStart', 1, 'ok', 0],
        ['hooks', 'SessionStart', 1, 'plain', 0],
        ['prompt', 'please build it', 1, 'plain', 1],
        ['skills', 'aegisops-harness:build', 1, 'plain', 1],
        ['permissions', 'accept', 1, 'ok', 1],
        ['permissions', 'accept', 3, 'ok', 1],
        ['hooks', 'PostToolUse', 1, 'bad', 1],
        ['agents', 'Explore', 1, 'plain', 1],
        ['mcp', 'github', 1, 'plain', 1],
        ['permissions', 'reject', 1, 'stopped', 1],
        ['hooks', 'Stop', 1, 'ok', 1],
        ['prompt', 'thanks', 1, 'plain', 2],
        ['skills', 'aegisops-harness:build', 1, 'plain', 2],
        ['skills', 'dataviz', 1, 'plain', 2],
        ['skills', 'aegisops-harness:build', 1, 'plain', 2],
        ['permissions', 'reject', 1, 'stopped', 2],
        ['hooks', 'Stop', 1, 'bad', 2],
        ['hooks', 'Stop', 1, 'ok', 2],
      ],
    );
    const step = (i: number) => path.steps[i];
    assert.deepEqual([step(0).detail, step(1).detail], ['Project instructions, /work/alpha/CLAUDE.md', 'User instructions, /home/u/.claude/rules/style.md']);
    assert.equal(step(4).detail, 'added 12 characters of context');
    assert.deepEqual([step(7).by, step(7).tools], [{ decision: 'accept', source: 'config', reason: 'rule', ruleSource: 'userSettings' }, ['Skill']]);
    assert.deepEqual([step(8).by.reason, step(8).tools], ['classifier', ['Bash', 'Read']]);
    assert.deepEqual([step(12).by.source, step(12).tools], ['hook', ['Bash']]);
    // a run of the same decision is one step that spans its transcript lines
    assert.ok(step(8).lastLine > step(8).line);
    // what was loaded or injected is named, never quoted; a secret in a hook command is masked
    const text = JSON.stringify(path);
    for (const leak of ['TOP-SECRET-RULES', 'ctx-body-123', 'listing-body', 'abcdef123456']) assert.ok(!text.includes(leak), `${leak} leaked`);
    assert.deepEqual(path.summary.hooks.map((h: any) => [h.event, h.command.includes('gate.py') || h.command, h.runs, h.failed]), [['SessionStart', 'boot.sh', 1, 0], ['PostToolUse', true, 1, 1], ['Stop', 'stop.py', 2, 1], ['Stop', 'other.py', 1, 0]]);
    assert.deepEqual(path.summary.skills, [{ name: 'aegisops-harness:build', count: 3 }, { name: 'dataviz', count: 1 }]);
    assert.deepEqual([step(18).by.reason, step(18).tools], ['user-rejected', ['Bash']]);
    // in a subagent's own transcript the prompt is the task it was handed
    assert.equal((await c.get('/api/sessions/P/path?agent=a1')).steps[0].detail, 'the task this subagent was given');
    assert.deepEqual(path.summary.permissions.map((p: any) => [p.decision, p.source, p.reason, p.count]), [['accept', 'config', 'classifier', 3], ['accept', 'config', 'rule', 1], ['reject', 'hook', 'hook', 1], ['reject', 'config', 'user-rejected', 1]]);
    assert.deepEqual([path.summary.instructions, path.summary.agents, path.summary.mcp], [2, [{ type: 'Explore', count: 1 }], [{ server: 'github', count: 1 }]]);
    // paging, and an unknown session
    const page = await c.get('/api/sessions/P/path?offset=5&limit=2');
    assert.deepEqual([page.total, page.steps.map((s: any) => s.lane)], [21, ['prompt', 'skills']]);
    assert.equal((await c.getRes('/api/sessions/nope/path')).status, 404);
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-48 the files the agent worked on most, across sessions: reads, edits, writes and how many sessions touched each', async () => {
  const home = new Home();
  const use = (sid: string, s: number, id: string, name: string, file: string, cwd = '/work/alpha') =>
    rec.assistant({ sid, cwd, at: T0 + s * 1000 }, { id: `m-${id}`, content: [rec.toolUse(id, name, { file_path: file, content: 'x', old_string: 'a', new_string: 'b' })] });
  home.transcript('-work-alpha', 'A', [
    use('A', 0, 'r1', 'Read', '/work/alpha/a.ts'), use('A', 1, 'r2', 'Read', '/work/alpha/a.ts'), use('A', 2, 'e1', 'Edit', '/work/alpha/a.ts'),
    use('A', 3, 'w1', 'Write', '/work/alpha/b.ts'), use('A', 4, 'r3', 'Read', '/work/alpha/.env.token=abcdef123456'),
  ]);
  home.transcript('-work-beta', 'B', [use('B', 86_400 * 3, 'r9', 'Read', '/work/alpha/a.ts', '/work/beta')]);
  const c = await start(home);
  try {
    const heat = await c.get('/api/files/heat');
    assert.deepEqual(
      [heat.items[0], heat.items.find((f: any) => f.path.endsWith('b.ts'))].map((f: any) => [f.path, f.read, f.edit, f.write, f.sessions]),
      [['/work/alpha/a.ts', 3, 1, 0, 2], ['/work/alpha/b.ts', 0, 0, 1, 1]],
    );
    assert.deepEqual([heat.files, heat.touches], [3, 6]);
    assert.ok(!JSON.stringify(heat).includes('abcdef123456'));
    // one project, a time span, and a cap
    assert.deepEqual((await c.get('/api/files/heat?project=-work-beta')).items.map((f: any) => [f.path, f.read, f.sessions]), [['/work/alpha/a.ts', 1, 1]]);
    assert.deepEqual((await c.get(`/api/files/heat?to=${T0 + 60_000}`)).items[0].sessions, 1);
    assert.equal((await c.get('/api/files/heat?limit=1')).items.length, 1);
    // by folder, and the files under one folder
    home.transcript('-work-alpha', 'C', [use('C', 5, 'r20', 'Read', '/work/alpha/src/deep/c.ts'), use('C', 6, 'e20', 'Edit', '/work/alpha/src/deep/d.ts')]);
    await c.app.index();
    const folders = await c.get('/api/files/heat?group=folder');
    assert.deepEqual(folders.items.map((f: any) => [f.path, f.read, f.edit, f.write, f.sessions, f.files]), [['/work/alpha', 4, 1, 1, 2, 3], ['/work/alpha/src/deep', 1, 1, 0, 1, 2]]);
    // a folder opens exactly the files its tile counted: the ones directly in it
    const inside = async (dir: string) => (await c.get(`/api/files/heat?under=${encodeURIComponent(dir)}`)).items.map((f: any) => f.path);
    assert.deepEqual(await inside('/work/alpha/src/deep'), ['/work/alpha/src/deep/c.ts', '/work/alpha/src/deep/d.ts']);
    assert.deepEqual(await inside('/work/alpha/src'), []);
    assert.equal((await inside('/work/alpha')).length, 3);
  } finally {
    await c.close();
    home.destroy();
  }
});
