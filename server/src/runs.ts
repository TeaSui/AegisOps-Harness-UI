// Control mode: launch and stop headless runs of the harness. This module exists only when Aegis
// was started with --control. A run is the harness's own print mode as a child process; Aegis
// observes it through its transcript like any other session.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, existsSync, realpathSync, statSync, constants as FS } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Db } from './db.ts';
import type { Activity } from './activity.ts';
import { HttpError, badRequest, notFound } from './http.ts';

/** Never a mode that bypasses permission checks. */
export const RUN_MODES = ['plan', 'manual', 'acceptEdits', 'auto', 'dontAsk'] as const;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const MAX_PROMPT = 100_000;
const MAX_ACTIVE = 4;
const KEEP = 50;
const KILL_AFTER_MS = 5000;
const STDERR_TAIL = 4096;
const FIELDS = new Set(['project', 'prompt', 'model', 'permissionMode']);

type Run = {
  id: string;
  sessionId: string;
  project: string;
  cwd: string;
  model: string | null;
  permissionMode: string;
  state: 'starting' | 'running' | 'exited' | 'failed';
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  stopRequestedAt: number | null;
  stderrTail: string;
  pid: number | null;
};

/** Resolves the harness binary once, at start: the given path, else `claude` on the search path. */
export function resolveBinary(given: string | undefined): string {
  const executable = (p: string) => {
    try {
      accessSync(p, FS.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (given) {
    if (isAbsolute(given) && executable(given)) return given;
    throw new Error('Control mode needs the harness binary, and the given path is not an executable file.');
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, 'claude'))) return join(dir, 'claude');
  }
  throw new Error('Control mode needs the harness binary: "claude" was not found on the search path (use --claude-bin).');
}

export class Runs {
  private db: Db;
  private bin: string;
  private activity: Activity;
  private now: () => number;
  private runs: Run[] = [];
  private children = new Map<string, ChildProcess>();
  private killTimers = new Map<string, NodeJS.Timeout>();

  constructor(db: Db, bin: string, activity: Activity, now: () => number) {
    this.db = db;
    this.bin = bin;
    this.activity = activity;
    this.now = now;
  }

  list() {
    return { items: [...this.runs].reverse(), modes: RUN_MODES, maxActive: MAX_ACTIVE, maxPrompt: MAX_PROMPT };
  }

  private active() {
    return this.runs.filter((r) => r.state === 'starting' || r.state === 'running').length;
  }

  /** Validates everything, then starts the binary directly: no shell, a fixed argument list, the prompt on stdin. */
  launch(body: any): Run {
    if (!body || typeof body !== 'object') throw badRequest('The body must be an object');
    for (const key of Object.keys(body)) if (!FIELDS.has(key)) throw badRequest(`Unknown field: ${key.slice(0, 40)}`);
    const { project, prompt, model, permissionMode } = body;
    if (typeof permissionMode !== 'string' || !(RUN_MODES as readonly string[]).includes(permissionMode)) {
      throw badRequest(`permissionMode must be one of: ${RUN_MODES.join(', ')}`);
    }
    if (model !== undefined && model !== null && (typeof model !== 'string' || !MODEL.test(model))) throw badRequest('model is not a valid model alias or id');
    if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > MAX_PROMPT) throw badRequest(`prompt must be text of 1 to ${MAX_PROMPT} characters`);
    if (typeof project !== 'string' || !project) throw badRequest('project must be the id of a known project');
    // The working directory comes from the index, never from the request.
    const known = this.db.prepare('SELECT cwd FROM sessions WHERE project = ? AND cwd IS NOT NULL ORDER BY last_ts DESC LIMIT 1').get(project) as { cwd: string } | undefined;
    if (!known) throw badRequest('project must be the id of a known project');
    let cwd: string;
    try {
      cwd = realpathSync(known.cwd);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw badRequest("The project's directory no longer exists");
    }
    if (this.active() >= MAX_ACTIVE) throw new HttpError(429, 'too_many_runs', `At most ${MAX_ACTIVE} runs can be active`);

    const sessionId = randomUUID();
    const args = ['-p', '--session-id', sessionId, '--permission-mode', permissionMode];
    if (typeof model === 'string') args.push('--model', model);
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('AEGIS_')) env[k] = v;

    const run: Run = {
      id: randomUUID(), sessionId, project, cwd, model: typeof model === 'string' ? model : null, permissionMode, state: 'starting',
      startedAt: this.now(), endedAt: null, exitCode: null, signal: null, stopRequestedAt: null, stderrTail: '', pid: null,
    };
    const child = spawn(this.bin, args, { cwd, env, shell: false, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    run.pid = child.pid ?? null;
    this.runs.push(run);
    this.children.set(run.id, child);
    if (this.runs.length > KEEP) {
      const drop = this.runs.findIndex((r) => r.state === 'exited' || r.state === 'failed');
      if (drop !== -1) this.runs.splice(drop, 1);
    }
    const finish = () => {
      run.endedAt = this.now();
      this.children.delete(run.id);
      const t = this.killTimers.get(run.id);
      if (t) clearTimeout(t);
      this.killTimers.delete(run.id);
    };
    child.once('spawn', () => {
      if (run.state === 'starting') run.state = 'running';
    });
    child.once('error', () => {
      run.state = 'failed';
      finish();
    });
    child.once('exit', (code, signal) => {
      run.state = 'exited';
      run.exitCode = code;
      run.signal = signal;
      finish();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      run.stderrTail = (run.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(prompt);
    this.activity.record('run-launch', {
      run: run.id, session: sessionId, project, model: run.model, mode: permissionMode, promptLength: prompt.length,
      promptHash: createHash('sha256').update(prompt).digest('hex'), pid: run.pid,
    });
    return run;
  }

  /** Interrupts a child this process started, then kills it if it is still there after 5 seconds. */
  stop(id: string): Run {
    const run = this.runs.find((r) => r.id === id);
    if (!run) throw notFound();
    const child = this.children.get(id);
    if (!child || run.state === 'exited' || run.state === 'failed') return run;
    if (run.stopRequestedAt === null) {
      run.stopRequestedAt = this.now();
      child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
      timer.unref();
      this.killTimers.set(id, timer);
      this.activity.record('run-stop', { run: id, session: run.sessionId });
    }
    return run;
  }

  /** On shutdown: interrupt whatever is still running. */
  close() {
    for (const child of this.children.values()) child.kill('SIGINT');
    for (const t of this.killTimers.values()) clearTimeout(t);
  }
}
