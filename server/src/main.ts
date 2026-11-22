// Command-line entry point.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, VERSION } from './app.ts';

const HELP = `Aegis ${VERSION} — a local console for Claude Code

Usage: aegis [options]

  --port <n>           Port on 127.0.0.1 (default 4317). A taken port fails the start.
  --control            Enable the Run view: launch and stop headless runs. Off by default.
  --claude-home <dir>  Claude home to read (default ~/.claude). Opened read-only.
  --config <file>      User configuration file with the price table (default ~/.claude.json).
  --state-dir <dir>    Where Aegis keeps its index and activity log (default ~/.aegis).
  --claude-bin <path>  Harness binary for --control (default: "claude" on the search path).
  --verify             Re-hash every indexed transcript at start (integrity check).
  -h, --help           Show this help.

Aegis listens on loopback only and never writes inside the Claude home.`;

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  const takesValue = new Set(['port', 'claude-home', 'config', 'state-dir', 'claude-bin']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const inline = eq === -1 ? undefined : a.slice(eq + 1);
      if (takesValue.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new Error(`--${name} needs a value`);
        out[name] = value;
      } else if (name === 'control' || name === 'verify') out[name] = true;
      else throw new Error(`Unknown option --${name}`);
    } else throw new Error(`Unexpected argument ${a}`);
  }
  return out;
}

async function main() {
  let args: Record<string, string | boolean>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }
  const port = args.port === undefined ? 4317 : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port must be a port number');
    process.exit(2);
  }
  const home = homedir();
  let app;
  try {
    app = await createApp({
      claudeHome: resolve(String(args['claude-home'] ?? join(home, '.claude'))),
      configFile: resolve(String(args.config ?? join(home, '.claude.json'))),
      stateDir: resolve(String(args['state-dir'] ?? join(home, '.aegis'))),
      port,
      watch: true,
      quiet: process.env.AEGIS_LOG !== '1',
      control: args.control === true,
      claudeBin: typeof args['claude-bin'] === 'string' ? args['claude-bin'] : undefined,
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another with --port.` : `Aegis could not start: ${err.message}`);
    process.exit(1);
  }
  console.log(`\n  Aegis ${VERSION}  ·  ${args.control ? 'control mode: runs can be launched' : 'read-only (start with --control to launch runs)'}`);
  console.log(`\n  Open  ${app.url}\n`);
  console.log('  The link carries a one-time access token. Indexing the Claude home has started; the console shows progress.\n');
  const started = Date.now();
  app.index({ deep: args.verify === true }).then(
    () => {
      if (process.env.AEGIS_LOG === '1') console.log(`first index pass finished in ${Date.now() - started} ms`);
    },
    (e: NodeJS.ErrnoException) => console.error(`The first index pass failed (${e?.name ?? 'Error'} ${e?.code ?? ''}). The console is up; indexing is retried every 15 seconds.`),
  );
  let closing = false;
  const stop = () => {
    if (closing) process.exit(1);
    closing = true;
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
