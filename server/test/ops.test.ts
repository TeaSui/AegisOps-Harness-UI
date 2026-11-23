import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Home, PRICES, rec, start, T0, type Client } from './fixture.ts';

const DAY = 86_400_000;

function opsHome(): Home {
  const home = new Home();
  const b = (s: number, day = 0) => ({ sid: 'ops', at: T0 + day * DAY + s * 1000 });
  const gate = { event: 'PostToolUse', name: 'PostToolUse:Bash', command: 'python3 gate.py' };
  home.transcript('-work-alpha', 'ops', [
    // hooks: gate.py ran 6 times (4 ok, 1 failed, 1 blocked)
    ...[100, 200, 300, 400].map((ms, i) => rec.hook(b(i), 'hook_success', { ...gate, durationMs: ms })),
    rec.hook(b(5), 'hook_non_blocking_error', { ...gate, durationMs: 1000 }),
    rec.hook(b(6), 'hook_blocking_error', gate),
    // the stop hook ran 3 times (from the stop summaries) and failed once
    rec.stopSummary(b(10), [{ command: 'stop.py', durationMs: 10 }]),
    rec.stopSummary(b(11), [{ command: 'stop.py', durationMs: 30 }]),
    rec.stopSummary(b(12), [{ command: 'stop.py', durationMs: 20 }], ['boom']),
    rec.hook(b(12), 'hook_non_blocking_error', { event: 'Stop', command: 'stop.py', durationMs: 20 }),
    rec.hook(b(11), 'hook_success', { event: 'Stop', command: 'stop.py', durationMs: 30 }), // already counted by its summary
    rec.hook(b(13), 'hook_success', { event: 'SessionStart', name: 'SessionStart:startup', command: 'boot.sh' }),
    // tools
    rec.assistant(b(20), {
      id: 'm1',
      content: [
        rec.toolUse('b1', 'Bash', { command: 'a' }), rec.toolUse('b2', 'Bash', { command: 'b' }), rec.toolUse('b3', 'Bash', { command: 'c' }),
        rec.toolUse('b4', 'Bash', { command: 'd' }), rec.toolUse('b5', 'Bash', { command: 'e' }),
        rec.toolUse('g1', 'mcp__github__create_issue', {}), rec.toolUse('g2', 'mcp__github__list_issues', {}),
        rec.toolUse('a1', 'mcp__plugin_ops_atlassian__search', {}), rec.toolUse('r1', 'Read', { file_path: '/x' }),
      ],
    }),
    rec.toolResult(b(21), 'b1'),
    rec.toolResult(b(23), 'b2'),
    rec.toolResult(b(22), 'b3', { error: true }),
    rec.toolResult({ sid: 'ops', at: T0 + 20_500 }, 'b4', { error: true, denial: 'permission-rule', perm: { decision: 'reject', source: 'hook', reasonType: 'hook' } }),
    rec.toolResult({ sid: 'ops', at: T0 + 20_100 }, 'g1'),
    rec.toolResult({ sid: 'ops', at: T0 + 20_300 }, 'g2', { error: true }),
    rec.toolResult({ sid: 'ops', at: T0 + 20_050 }, 'a1'),
    rec.toolResult(b(21), 'r1'),
    // API trouble and context pressure over two days
    rec.apiError(b(30)), rec.apiError(b(31)), rec.compaction(b(32), 100, 10),
    rec.apiError(b(0, 1), 529, 'overloaded'),
    { type: 'brand-new-record', sessionId: 'ops' }, { type: 'brand-new-record', sessionId: 'ops' },
  ]);
  return home;
}

async function withOps(fn: (c: Client, home: Home) => Promise<void>, now = T0 + 2 * DAY) {
  const home = opsHome();
  const c = await start(home, { now: () => now });
  try {
    await fn(c, home);
  } finally {
    await c.close();
    home.destroy();
  }
}

test("AEGIS-26 a hook's runs, failures, blocks, median and 95th percentile", () =>
  withOps(async (c) => {
    const hooks = (await c.get('/api/ops/hooks')).items;
    const pick = (event: string) => {
      const h = hooks.find((x: any) => x.event === event);
      return { command: h.command, runs: h.runs, failures: h.failures, blocks: h.blocks, p50: h.p50, p95: h.p95 };
    };
    // durations 100, 200, 300, 400, 1000: nearest rank gives the 3rd and the 5th
    assert.deepEqual(pick('PostToolUse'), { command: 'python3 gate.py', runs: 6, failures: 1, blocks: 1, p50: 300, p95: 1000 });
    // 10, 20, 30 from the summaries
    assert.deepEqual(pick('Stop'), { command: 'stop.py', runs: 3, failures: 1, blocks: 0, p50: 20, p95: 30 });
    // no recorded duration: the percentiles are empty
    assert.deepEqual(pick('SessionStart'), { command: 'boot.sh', runs: 1, failures: 0, blocks: 0, p50: null, p95: null });
    assert.equal(hooks.length, 3);
    // a time range narrows it
    assert.deepEqual((await c.get(`/api/ops/hooks?from=${T0 + 10_000}&to=${T0 + 12_000}`)).items.map((h: any) => [h.event, h.runs]), [['Stop', 3]]);
  }));

test("AEGIS-27 a tool's calls, error rate, denial rate and 95th percentile; MCP tools grouped by server", () =>
  withOps(async (c) => {
    const ops = await c.get('/api/ops/tools');
    const bash = ops.tools.find((t: any) => t.tool === 'Bash');
    // 5 calls: ok 1 s, ok 3 s, error 2 s, denied 0.5 s, one still pending
    assert.deepEqual(
      { calls: bash.calls, finished: bash.finished, errors: bash.errors, denied: bash.denied, pending: bash.pending, errorRate: bash.errorRate, denialRate: bash.denialRate, p50: bash.p50, p95: bash.p95 },
      { calls: 5, finished: 4, errors: 1, denied: 1, pending: 1, errorRate: 0.25, denialRate: 0.2, p50: 1000, p95: 3000 },
    );
    assert.equal(ops.tools.find((t: any) => t.tool === 'Read').calls, 1);
    assert.deepEqual(
      ops.servers.map((s: any) => [s.server, s.calls, s.errors, s.errorRate, s.p95, s.tools]),
      [['github', 2, 1, 0.5, 300, 2], ['plugin_ops_atlassian', 1, 0, 0, 50, 1]],
    );
    assert.equal(ops.tools.find((t: any) => t.tool === 'mcp__github__list_issues').mcpServer, 'github');
  }));

test('AEGIS-28 API errors and compactions over time', () =>
  withOps(async (c) => {
    const s = await c.get(`/api/ops/series?from=${T0 - 10 * 3600_000}&to=${T0 + DAY + 3600_000}&bucket=day&tz=0`);
    const day0 = Date.parse('2026-11-20T00:00:00Z');
    assert.deepEqual(
      s.buckets.map((b: any) => [b.start, b.apiErrors, b.rateLimits, b.compactions, b.hookFailures, b.toolErrors]),
      [[day0, 2, 2, 1, 3, 2], [day0 + DAY, 1, 0, 0, 0, 0]],
    );
    assert.deepEqual(s.errors, [{ error: 'rate_limit', status: '429', count: 2 }, { error: 'overloaded', status: '529', count: 1 }]);
  }));

test('AEGIS-29 the inventory lists settings by scope, rules, hooks, plugins and MCP servers, and no secret value', async () => {
  const home = opsHome();
  const project = join(home.root, 'work', 'alpha');
  mkdirSync(join(project, '.claude'), { recursive: true });
  home.transcript('-proj', 'p', [rec.prompt({ sid: 'p', cwd: project, at: T0 }, 'hi')]);
  home.file('settings.json', JSON.stringify({
    env: { BITBUCKET_API_TOKEN: 'tok-123456789abc', LOG_LEVEL: 'debug-level-value' },
    permissions: { allow: ['Bash(ls:*)', 'Bash'], deny: ['Read(./.env)'], defaultMode: 'bypassPermissions' },
    hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 gate.py --token=abcdef123456' }] }] },
    enabledPlugins: { 'aegisops-harness@aegisops-harness': true, 'ghost@nowhere': true, 'off@x': false },
    model: 'opus',
  }));
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['*'], ask: ['Bash(git push:*)'] } }));
  writeFileSync(join(project, '.claude', 'settings.local.json'), '{ broken json');
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: '/opt/tools/bin/local-mcp', args: ['--api-key', 'KEY-abcdef-123456'] } } }));
  home.file('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'aegisops-harness@aegisops-harness': [{ scope: 'user', version: '5.0.0', installPath: '/x', installedAt: '2026-11-01T00:00:00Z', lastUpdated: '2026-11-22T00:00:00Z' }], 'off@x': [{ scope: 'project', projectPath: project, version: '1.0.0' }] } }));
  home.config({
    additionalModelCostsCache: PRICES,
    mcpServers: {
      github: { command: 'npx', args: ['-y', 'server-github', '--token', 'ghp_supersecretsupersecretsupersecret12'], env: { GITHUB_TOKEN: 'ghp_anothersecretanothersecretanother12' } },
      remote: { type: 'http', url: 'https://user:urlpass123@mcp.example.com/mcp?key=querysecret99', headers: { Authorization: 'Bearer headersecret1234567' } },
    },
    projects: { [project]: { mcpServers: { scoped: { type: 'sse', url: 'https://sse.example.com/x' } } } },
  });
  const c = await start(home);
  try {
    const inv = await c.get('/api/ops/inventory');
    const text = JSON.stringify(inv);
    for (const secret of ['tok-123456789abc', 'debug-level-value', 'abcdef123456', 'KEY-abcdef-123456', 'ghp_supersecret', 'ghp_anothersecret', 'urlpass123', 'querysecret99', 'headersecret1234567']) {
      assert.ok(!text.includes(secret), `${secret} leaked`);
    }
    const user = inv.settings.find((s: any) => s.scope === 'user');
    assert.deepEqual(
      { path: user.path, readable: user.readable, mode: user.defaultMode, allow: user.allow, deny: user.deny, env: user.envKeys, model: user.model },
      { path: 'settings.json', readable: true, mode: 'bypassPermissions', allow: ['Bash(ls:*)', 'Bash'], deny: ['Read(./.env)'], env: ['BITBUCKET_API_TOKEN', 'LOG_LEVEL'], model: 'opus' },
    );
    assert.deepEqual(user.hooks, [{ event: 'PostToolUse', matcher: 'Bash', type: 'command', command: 'python3 gate.py --token=[masked:value]' }]);
    assert.deepEqual(user.enabledPlugins, [{ id: 'aegisops-harness@aegisops-harness', enabled: true }, { id: 'ghost@nowhere', enabled: true }, { id: 'off@x', enabled: false }]);
    const proj = inv.settings.find((s: any) => s.scope === 'project');
    assert.deepEqual({ project: proj.project, allow: proj.allow, ask: proj.ask }, { project, allow: ['*'], ask: ['Bash(git push:*)'] });
    assert.equal(inv.settings.find((s: any) => s.scope === 'local').readable, false);
    assert.deepEqual(
      inv.plugins.map((p: any) => [p.id, p.version, p.scope, p.enabledIn]),
      [['aegisops-harness@aegisops-harness', '5.0.0', 'user', ['user']], ['off@x', '1.0.0', 'project', []]],
    );
    const mcp = Object.fromEntries(inv.mcpServers.map((m: any) => [m.name, m]));
    assert.deepEqual({ transport: mcp.github.transport, command: mcp.github.command, args: mcp.github.args, env: mcp.github.envKeys, source: mcp.github.source }, { transport: 'stdio', command: 'npx', args: 4, env: ['GITHUB_TOKEN'], source: 'user configuration' });
    assert.deepEqual({ transport: mcp.remote.transport, host: mcp.remote.host, headers: mcp.remote.headerKeys }, { transport: 'http', host: 'mcp.example.com', headers: ['Authorization'] });
    assert.deepEqual({ transport: mcp.scoped.transport, host: mcp.scoped.host, project: mcp.scoped.project }, { transport: 'sse', host: 'sse.example.com', project });
    assert.deepEqual({ command: mcp.local.command, source: mcp.local.source, args: mcp.local.args }, { command: 'local-mcp', source: '.mcp.json', args: 2 });

    // AEGIS-30: the doctor names each risk with its evidence
    const doctor = await c.get('/api/ops/doctor');
    const check = (id: string) => doctor.checks.find((x: any) => x.id === id);
    assert.equal(check('mode.bypass').status, 'fail');
    assert.match(check('mode.bypass').evidence.join('\n'), /settings\.json/);
    assert.equal(check('allow.broad').status, 'warn');
    assert.deepEqual(check('allow.broad').evidence.map((e: string) => e.replace(/ in .*/, '')), ['Bash', '*']);
    assert.equal(check('env.credentials').status, 'warn');
    assert.match(check('env.credentials').evidence[0], /BITBUCKET_API_TOKEN/);
    assert.ok(!check('env.credentials').evidence.join().includes('LOG_LEVEL'));
    assert.equal(check('plugin.missing').status, 'warn');
    assert.match(check('plugin.missing').evidence[0], /ghost@nowhere/);
    assert.equal(check('sources.unreadable').status, 'warn');
    assert.match(check('sources.unreadable').evidence.join('\n'), /settings\.local\.json/);
    assert.equal(check('integrity.alerts').status, 'pass');
    assert.equal(check('index.skipped').status, 'pass');
    assert.ok(!JSON.stringify(doctor).includes('tok-123456789abc'));
    assert.deepEqual(doctor.summary, { pass: doctor.checks.filter((x: any) => x.status === 'pass').length, warn: doctor.checks.filter((x: any) => x.status === 'warn').length, fail: 1 });
  } finally {
    await c.close();
    home.destroy();
  }
});

test('AEGIS-30 a hook that fails often is flagged; a clean home passes every check', async () => {
  await withOps(async (c) => {
    // gate.py: 6 runs, 1 failure and 1 block = 33% in the last 7 days; stop.py: 3 runs is under the 5-run floor
    const failing = (await c.get('/api/ops/doctor')).checks.find((x: any) => x.id === 'hooks.failing');
    assert.equal(failing.status, 'warn');
    assert.equal(failing.evidence.length, 1);
    assert.match(failing.evidence[0], /python3 gate\.py/);
    assert.match(failing.evidence[0], /2 of 6/);
    const records = await c.get('/api/ops/records');
    assert.deepEqual(records.unknownTypes, [{ type: 'brand-new-record', count: 2, known: false }]);
  });
  // eight days later the failures are outside the window
  await withOps(async (c) => {
    assert.equal((await c.get('/api/ops/doctor')).checks.find((x: any) => x.id === 'hooks.failing').status, 'pass');
  }, T0 + 8 * DAY);
  const clean = new Home();
  clean.transcript('-work-alpha', 's', [rec.prompt({ sid: 's', at: T0 }, 'hi')]);
  clean.file('settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], defaultMode: 'default' } }));
  clean.file('plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: {} }));
  const c = await start(clean);
  try {
    const doctor = await c.get('/api/ops/doctor');
    assert.deepEqual(doctor.checks.filter((x: any) => x.status !== 'pass').map((x: any) => x.id), []);
    assert.ok(doctor.checks.length >= 8);
    // the sources every installation has are named when they are missing
    rmSync(join(clean.claudeHome, 'settings.json'));
    rmSync(join(clean.claudeHome, 'plugins', 'installed_plugins.json'));
    clean.config({});
    await c.app.index();
    const missing = (await c.get('/api/ops/doctor')).checks.find((x: any) => x.id === 'sources.unreadable');
    assert.equal(missing.status, 'warn');
    assert.match(missing.evidence.join('\n'), /settings\.json \(user, not found\)/);
    assert.match(missing.evidence.join('\n'), /installed_plugins\.json \(not found\)/);
    assert.match(missing.evidence.join('\n'), /price table/);
  } finally {
    await c.close();
    clean.destroy();
  }
  // a missing Claude home is not an error: everything is empty and the doctor says what it could not read
  const empty = new Home();
  const e = await start(empty, { claudeHome: join(empty.root, 'nowhere'), configFile: join(empty.root, 'nothing.json') });
  try {
    assert.equal((await e.get('/api/sessions')).total, 0);
    assert.deepEqual((await e.get('/api/ops/inventory')).mcpServers, []);
    assert.equal((await e.get('/api/ops/doctor')).checks.find((x: any) => x.id === 'sources.unreadable').status, 'warn');
  } finally {
    await e.close();
    empty.destroy();
  }
});

test('AEGIS-38 the harness map counts prompts, responses, gate decisions, tools by category, MCP servers and subagents in a time span', async () => {
  const home = opsHome();
  home.transcript('-work-alpha', 's2', [rec.prompt({ sid: 's2', at: T0 }, 'hello there')]);
  // the task a subagent is given is a prompt in its own transcript, and is not one of yours
  home.transcript('-work-alpha', 'ops', [rec.prompt({ sid: 'ops', at: T0 + 39_000, agentId: 'a1' }, 'explore the repo'), rec.assistant({ sid: 'ops', at: T0 + 40_000, agentId: 'a1' }, { id: 'm2' })], { agent: 'a1', agentType: 'Explore' });
  const c = await start(home, { now: () => T0 + 2 * DAY });
  try {
    const map = await c.get('/api/map');
    assert.equal(map.prompts, 1);
    assert.equal(map.sessions, 2);
    assert.equal(map.api.calls, 2);
    assert.equal(map.models.reduce((n: number, m: any) => n + m.calls, 0), 2);
    assert.deepEqual([map.api.errors, map.api.rateLimits, map.api.compactions], [3, 2, 1]);
    assert.deepEqual(map.gate, { hookCommands: 3, hookRuns: 10, hookFailures: 2, hookBlocks: 1, denied: 1 });
    const cat = (name: string) => {
      const t = map.tools.find((x: any) => x.category === name);
      return [t.calls, t.errors, t.denied, t.pending, t.errorRate, t.p50];
    };
    assert.deepEqual(cat('exec'), [5, 1, 1, 1, 0.25, 1000]);
    assert.deepEqual(cat('read'), [1, 0, 0, 0, 0, 1000]);
    assert.deepEqual(cat('mcp').slice(0, 2), [3, 1]);
    assert.deepEqual(cat('write'), [0, 0, 0, 0, 0, null]);
    assert.deepEqual(map.tools.map((t: any) => t.category), ['exec', 'read', 'write', 'fetch', 'agent', 'mcp', 'other']);
    assert.deepEqual(map.tools.find((t: any) => t.category === 'exec').top, [{ tool: 'Bash', calls: 5 }]);
    assert.deepEqual(map.servers.map((s: any) => [s.server, s.calls, s.errors]), [['github', 2, 1], ['plugin_ops_atlassian', 1, 0]]);
    assert.deepEqual([map.subagents.spawned, map.subagents.types, map.subagents.calls], [1, [{ type: 'Explore', n: 1 }], 1]);
    // a span narrows every count
    const later = await c.get(`/api/map?from=${T0 + DAY}`);
    assert.deepEqual([later.prompts, later.api.calls, later.api.errors, later.gate.hookRuns, later.tools[0].calls, later.subagents.spawned], [0, 0, 1, 0, 0, 0]);
    // a subagent belongs to the span it started in, and `to` closes the span
    assert.equal((await c.get(`/api/map?from=${T0 + 39_500}`)).subagents.spawned, 0);
    assert.deepEqual([(await c.get(`/api/map?to=${T0 + 20_000}`)).tools[0].calls, (await c.get(`/api/map?to=${T0 + 19_000}`)).tools[0].calls], [5, 0]);
    // the map is read like every other route: not without the session cookie
    assert.equal((await fetch(`${c.origin}/api/map`)).status, 401);
  } finally {
    await c.close();
    home.destroy();
  }
});
