// Builds a synthetic Claude home for the tests and starts the server against it.
// Nothing here reads the index database: tests see only what an API consumer sees.
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApp, type App, type AppOptions } from '../src/app.ts';

export const PRICES = {
  'm-priced': {
    inputTokens: 10,
    outputTokens: 50,
    promptCacheWriteTokens: 12.5,
    promptCacheWrite1hTokens: 20,
    promptCacheReadTokens: 1,
  },
  'm-cheap': { inputTokens: 1, outputTokens: 5, promptCacheWriteTokens: 1.25, promptCacheReadTokens: 0.1 },
};

export const T0 = Date.parse('2026-11-20T10:00:00.000Z');
export const iso = (ms: number) => new Date(ms).toISOString();

export type Usage = { input?: number; output?: number; cacheRead?: number; w5?: number; w1?: number; split?: boolean };

export function usage(u: Usage) {
  const out: Record<string, unknown> = {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: (u.w5 ?? 0) + (u.w1 ?? 0),
  };
  if (u.split !== false) {
    out.cache_creation = { ephemeral_5m_input_tokens: u.w5 ?? 0, ephemeral_1h_input_tokens: u.w1 ?? 0 };
  }
  return out;
}

let seq = 0;
const uid = () => `u-${(++seq).toString().padStart(6, '0')}`;

export type Base = { sid: string; cwd?: string; at?: number; branch?: string; entrypoint?: string; agentId?: string };

function base(b: Base) {
  return {
    uuid: uid(),
    timestamp: iso(b.at ?? T0),
    sessionId: b.sid,
    cwd: b.cwd ?? '/work/alpha',
    version: '2.1.319',
    entrypoint: b.entrypoint ?? 'cli',
    gitBranch: b.branch ?? 'main',
    userType: 'external',
    ...(b.agentId ? { agentId: b.agentId, isSidechain: true } : {}),
  };
}

export const rec = {
  prompt: (b: Base, text: string, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    ...base(b),
    promptSource: 'typed',
    origin: { kind: 'human' },
    message: { role: 'user', content: text },
    ...extra,
  }),
  assistant: (
    b: Base,
    o: { id: string; model?: string; usage?: Usage; content?: unknown[]; extra?: Record<string, unknown> },
  ) => ({
    type: 'assistant',
    ...base(b),
    requestId: `req_${o.id}`,
    message: {
      id: o.id,
      type: 'message',
      role: 'assistant',
      model: o.model ?? 'm-priced',
      content: o.content ?? [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: usage(o.usage ?? {}),
    },
    ...(o.extra ?? {}),
  }),
  text: (text: string) => ({ type: 'text', text }),
  toolUse: (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input }),
  toolResult: (
    b: Base,
    id: string,
    o: { content?: string; error?: boolean; denial?: string; perm?: Record<string, unknown> | null } = {},
  ) => ({
    type: 'user',
    ...base(b),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: o.content ?? 'done', is_error: o.error ?? false }],
    },
    toolUseResult: { stdout: o.content ?? 'done', stderr: '', interrupted: false },
    ...(o.denial ? { toolDenialKind: o.denial } : {}),
    ...(o.perm === null
      ? {}
      : { permissionDecision: o.perm ?? { decision: 'accept', source: 'config', reasonType: 'rule' } }),
  }),
  apiError: (b: Base, status = 429, error = 'rate_limit') => ({
    type: 'assistant',
    ...base(b),
    isApiErrorMessage: true,
    apiErrorStatus: status,
    error,
    message: {
      id: `err-${uid()}`,
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: 'API Error: rate limited' }],
      usage: usage({}),
    },
  }),
  hook: (
    b: Base,
    kind: 'hook_success' | 'hook_non_blocking_error' | 'hook_blocking_error',
    o: { event: string; name?: string; command: string; durationMs?: number; stderr?: string },
  ) => ({
    type: 'attachment',
    ...base(b),
    attachment: {
      type: kind,
      hookEvent: o.event,
      hookName: o.name ?? o.event,
      toolUseID: uid(),
      command: o.command,
      durationMs: o.durationMs,
      stdout: '',
      stderr: o.stderr ?? '',
      exitCode: kind === 'hook_success' ? 0 : 2,
      ...(kind === 'hook_blocking_error' ? { blockingError: { blockingError: 'blocked', command: o.command } } : {}),
    },
  }),
  stopSummary: (b: Base, hooks: Array<{ command: string; durationMs: number }>, errors: string[] = []) => ({
    type: 'system',
    subtype: 'stop_hook_summary',
    ...base(b),
    hookCount: hooks.length,
    hookInfos: hooks,
    hookErrors: errors,
    preventedContinuation: false,
  }),
  compaction: (b: Base, pre: number, post: number) => ({
    type: 'system',
    subtype: 'compact_boundary',
    ...base(b),
    compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post, durationMs: 900 },
  }),
  permissionMode: (sid: string, mode: string) => ({ type: 'permission-mode', permissionMode: mode, sessionId: sid }),
  title: (sid: string, title: string) => ({ type: 'ai-title', aiTitle: title, sessionId: sid }),
  costState: (sid: string, startTime: number, total: number) => ({
    type: 'cost-state',
    sessionId: sid,
    startTime,
    totalCostUSD: total,
    modelUsage: {},
  }),
  apiRequest: (sid: string) => ({ type: 'api-request', sessionId: sid, params: { big: 'x'.repeat(200) } }),
};

export const lines = (records: unknown[]) => records.map((r) => JSON.stringify(r) + '\n').join('');

export class Home {
  root: string;
  claudeHome: string;
  configFile: string;
  stateDir: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'aegis-test-'));
    this.claudeHome = join(this.root, '.claude');
    this.configFile = join(this.root, '.claude.json');
    this.stateDir = join(this.root, '.aegis');
    mkdirSync(join(this.claudeHome, 'projects'), { recursive: true });
    mkdirSync(join(this.claudeHome, 'sessions'), { recursive: true });
    this.config({ additionalModelCostsCache: PRICES });
  }

  config(value: unknown) {
    writeFileSync(this.configFile, JSON.stringify(value));
  }

  /** Path of a main transcript, or of a subagent transcript when `agent` is given. */
  path(project: string, sid: string, agent?: string) {
    return agent
      ? join(this.claudeHome, 'projects', project, sid, 'subagents', `agent-${agent}.jsonl`)
      : join(this.claudeHome, 'projects', project, `${sid}.jsonl`);
  }

  transcript(project: string, sid: string, records: unknown[], o: { agent?: string; agentType?: string } = {}) {
    const p = this.path(project, sid, o.agent);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines(records));
    if (o.agent && o.agentType) {
      writeFileSync(p.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: o.agentType, isBuiltIn: true }));
    }
    return p;
  }

  append(p: string, data: unknown[] | string) {
    appendFileSync(p, typeof data === 'string' ? data : lines(data));
  }

  file(rel: string, content: string) {
    const p = join(this.claudeHome, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return p;
  }

  /** A digest of every file under the Claude home: relative path, size, mtime and content hash. */
  snapshot() {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          out.push(`${p} dir ${st.mode}`);
          walk(p);
        } else {
          out.push(`${p} ${st.size} ${st.mtimeMs} ${st.mode} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
        }
      }
    };
    walk(this.claudeHome);
    out.push(createHash('sha256').update(readFileSync(this.configFile)).digest('hex'));
    return out.join('\n');
  }

  destroy() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export type Client = {
  app: App;
  origin: string;
  cookie: string;
  get: (path: string) => Promise<any>;
  getRes: (path: string, init?: RequestInit) => Promise<Response>;
  post: (path: string, body?: unknown) => Promise<Response>;
  close: () => Promise<void>;
};

/** Starts the server on an ephemeral port, exchanges the token and returns an authenticated client. */
export async function start(home: Home, options: Partial<AppOptions> = {}): Promise<Client> {
  const app = await createApp({
    claudeHome: home.claudeHome,
    configFile: home.configFile,
    stateDir: home.stateDir,
    port: 0,
    watch: false,
    quiet: true,
    ...options,
  });
  const origin = `http://127.0.0.1:${app.port}`;
  const exchange = await fetch(`${origin}/?token=${app.token}`, { redirect: 'manual' });
  const cookie = (exchange.headers.get('set-cookie') ?? '').split(';')[0];
  await app.index();
  const getRes = (path: string, init: RequestInit = {}) =>
    fetch(origin + path, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } });
  return {
    app,
    origin,
    cookie,
    getRes,
    get: async (path: string) => {
      const res = await getRes(path);
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
      return res.json();
    },
    post: (path: string, body?: unknown) =>
      fetch(origin + path, {
        method: 'POST',
        headers: { cookie, origin, 'x-aegis': '1', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    close: () => app.close(),
  };
}

// ---- a session with a bit of everything, shared by the session, audit and ops tests -----------------------

export const SECRETS = {
  anthropic: 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
  password: 'hunter2secret',
  bearer: 'abcdefghijklmnop1234',
  apiKey: 'SECRETKEY12345678',
  github: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  privateKey: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  urlPassword: 'dbpass9876',
};

export function richHome(): Home {
  const home = new Home();
  const sid = 'rich';
  const b = (seconds: number): Base => ({ sid, at: T0 + seconds * 1000 });
  home.transcript('-work-alpha', sid, [
    rec.title(sid, 'Deploy the zebra service'),
    rec.permissionMode(sid, 'default'),
    rec.prompt(b(0), 'please deploy the zebra service'),
    rec.assistant(b(1), {
      id: 'r1',
      usage: { input: 100, cacheRead: 900, output: 10 },
      content: [rec.text('Deploying the zebra now'), rec.toolUse('t1', 'Bash', { command: 'git push --force origin main' })],
      extra: { attributionSkill: 'aegisops-harness:ship', attributionPlugin: 'aegisops-harness' },
    }),
    rec.toolResult(b(4), 't1', { content: `pushed with ${SECRETS.github}`, perm: { decision: 'accept', source: 'config', reasonType: 'classifier' } }),
    rec.assistant(b(5), {
      id: 'r2',
      usage: { input: 200, cacheRead: 1800, output: 20 },
      content: [
        rec.toolUse('t2', 'Read', { file_path: '/work/alpha/src/app.ts' }),
        rec.toolUse('t3', 'Edit', { file_path: '/work/alpha/src/app.ts', old_string: 'a', new_string: 'b' }),
      ],
    }),
    rec.toolResult(b(6), 't2', { perm: null }),
    rec.toolResult(b(7), 't3', { error: true, content: 'String to replace not found' }),
    rec.assistant(b(8), {
      id: 'r3',
      usage: { input: 10, output: 5 },
      content: [
        rec.toolUse('t4', 'Bash', {
          command: `curl -H "Authorization: Bearer ${SECRETS.bearer}" "https://api.example.com/x?api_key=${SECRETS.apiKey}"`,
        }),
      ],
    }),
    rec.toolResult(b(9), 't4', {
      error: true,
      denial: 'user-rejected',
      perm: { decision: 'reject', source: 'config', reasonCode: 'bashMiss:too-complex' },
    }),
    rec.compaction(b(20), 150000, 30000),
    rec.hook(b(21), 'hook_non_blocking_error', { event: 'PostToolUse', name: 'PostToolUse:Bash', command: 'python3 gate.py', durationMs: 120 }),
    rec.apiError(b(22)),
    rec.permissionMode(sid, 'acceptEdits'),
    rec.assistant(b(30), {
      id: 'r4',
      usage: { input: 10, output: 5 },
      content: [
        rec.toolUse('t5', 'Write', { file_path: '/etc/hosts', content: 'x' }),
        rec.toolUse('t6', 'mcp__github__create_issue', { title: 'bug', token: SECRETS.github }),
        rec.toolUse('t7', 'WebFetch', { url: `https://user:${SECRETS.urlPassword}@example.com/docs` }),
      ],
    }),
    rec.toolResult(b(31), 't6'),
    rec.toolResult(b(33), 't7'),
    rec.prompt(b(40), `my key is ${SECRETS.anthropic} and password=${SECRETS.password}`),
    rec.assistant(b(41), {
      id: 'r5',
      usage: { input: 10, output: 5 },
      content: [
        rec.text(
          `Found ${SECRETS.aws} and a key:\n-----BEGIN RSA PRIVATE KEY-----\n${SECRETS.privateKey}\n-----END RSA PRIVATE KEY-----\nand a session ${SECRETS.jwt}`,
        ),
      ],
    }),
  ]);
  home.transcript('-work-beta', 'plain', [
    rec.prompt({ sid: 'plain', cwd: '/work/beta', at: T0 + 86_400_000, entrypoint: 'sdk-cli' }, 'summarise the giraffe report', { promptSource: 'sdk', origin: undefined }),
    rec.assistant({ sid: 'plain', cwd: '/work/beta', at: T0 + 86_401_000, entrypoint: 'sdk-cli' }, { id: 'p1', model: 'm-cheap', usage: { input: 1000, output: 100 }, content: [rec.text('The giraffe report is short.')] }),
  ]);
  return home;
}
