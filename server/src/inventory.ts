// What the harness is configured to do: settings by scope, permission rules, hooks, plugins and MCP
// servers. Values that could be credentials never leave this module: environment and header values
// are dropped (key names only), commands and rules are masked.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Db } from './db.ts';
import { isCredentialName, mask } from './redact.ts';

type Read = { found: boolean; readable: boolean; value: any };

function readJson(path: string): Read {
  if (!existsSync(path)) return { found: false, readable: true, value: null };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return { found: true, readable: value !== null && typeof value === 'object', value };
  } catch {
    return { found: true, readable: false, value: null };
  }
}

const strings = (v: unknown, max = 500): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max).map((x) => mask(String(x).slice(0, 500))) : []);

export type SettingsFile = {
  scope: 'managed' | 'user' | 'project' | 'local';
  path: string;
  project: string | null;
  readable: boolean;
  defaultMode: string | null;
  model: string | null;
  allow: string[];
  deny: string[];
  ask: string[];
  hooks: Array<{ event: string; matcher: string; type: string; command: string }>;
  enabledPlugins: Array<{ id: string; enabled: boolean }>;
  envKeys: string[];
};

function summarise(scope: SettingsFile['scope'], path: string, project: string | null, r: Read): SettingsFile {
  const v = r.readable ? r.value : {};
  const hooks: SettingsFile['hooks'] = [];
  if (v.hooks && typeof v.hooks === 'object') {
    for (const [event, groups] of Object.entries(v.hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups.slice(0, 100)) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks.slice(0, 100) : []) {
          hooks.push({
            event: event.slice(0, 80),
            matcher: typeof g.matcher === 'string' ? g.matcher.slice(0, 200) : '',
            type: typeof h?.type === 'string' ? h.type.slice(0, 40) : 'command',
            command: mask(String(h?.command ?? h?.prompt ?? h?.url ?? '').slice(0, 600)),
          });
        }
      }
    }
  }
  const plugins = v.enabledPlugins && typeof v.enabledPlugins === 'object' ? Object.entries(v.enabledPlugins as Record<string, unknown>) : [];
  return {
    scope,
    path,
    project,
    readable: r.readable,
    defaultMode: typeof v.permissions?.defaultMode === 'string' ? v.permissions.defaultMode : null,
    model: typeof v.model === 'string' ? v.model.slice(0, 100) : null,
    allow: strings(v.permissions?.allow),
    deny: strings(v.permissions?.deny),
    ask: strings(v.permissions?.ask),
    hooks,
    enabledPlugins: plugins.map(([id, on]) => ({ id: id.slice(0, 200), enabled: on === true })).sort((a, b) => a.id.localeCompare(b.id)),
    envKeys: v.env && typeof v.env === 'object' ? Object.keys(v.env).map((k) => k.slice(0, 120)).sort() : [],
  };
}

const MANAGED = ['/Library/Application Support/ClaudeCode/managed-settings.json', '/etc/claude-code/managed-settings.json'];

type McpServer = {
  name: string;
  source: string;
  project: string | null;
  transport: string;
  command: string | null;
  host: string | null;
  args: number;
  envKeys: string[];
  headerKeys: string[];
};

function mcpServers(map: unknown, source: string, project: string | null): McpServer[] {
  if (!map || typeof map !== 'object') return [];
  const out: McpServer[] = [];
  for (const [name, def] of Object.entries(map as Record<string, any>)) {
    if (!def || typeof def !== 'object') continue;
    let host: string | null = null;
    if (typeof def.url === 'string') {
      try {
        host = new URL(def.url).host; // host only: no credentials, path or query
      } catch {
        host = '(invalid url)';
      }
    }
    out.push({
      name: name.slice(0, 200),
      source,
      project,
      transport: typeof def.type === 'string' ? def.type.slice(0, 20) : host ? 'http' : 'stdio',
      command: typeof def.command === 'string' ? basename(def.command).slice(0, 200) : null,
      host,
      args: Array.isArray(def.args) ? def.args.length : 0,
      envKeys: def.env && typeof def.env === 'object' ? Object.keys(def.env).sort() : [],
      headerKeys: def.headers && typeof def.headers === 'object' ? Object.keys(def.headers).sort() : [],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function inventory(db: Db, claudeHome: string, configFile: string) {
  const unreadable: string[] = [];
  const settings: SettingsFile[] = [];
  const consider = (scope: SettingsFile['scope'], path: string, shown: string, project: string | null) => {
    const r = readJson(path);
    if (!r.found) return;
    if (!r.readable) unreadable.push(shown);
    settings.push(summarise(scope, shown, project, r));
  };
  for (const p of MANAGED) consider('managed', p, p, null);
  consider('user', join(claudeHome, 'settings.json'), 'settings.json', null);

  if (!existsSync(claudeHome)) unreadable.push('the Claude home (not found)');
  const cwds = (db.prepare('SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL ORDER BY cwd LIMIT 2000').all() as Array<{ cwd: string }>).map((r) => r.cwd);
  const config = readJson(configFile);
  if (!config.found) unreadable.push('the user configuration file (not found)');
  else if (!config.readable) unreadable.push('the user configuration file');
  const mcp: McpServer[] = [...mcpServers(config.value?.mcpServers, 'user configuration', null)];
  for (const cwd of cwds) {
    if (!cwd.startsWith('/') || !existsSync(cwd)) continue;
    consider('project', join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json'), cwd);
    consider('local', join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.local.json'), cwd);
    mcp.push(...mcpServers(config.value?.projects?.[cwd]?.mcpServers, 'user configuration (project)', cwd));
    const dotMcp = readJson(join(cwd, '.mcp.json'));
    if (dotMcp.found && !dotMcp.readable) unreadable.push(join(cwd, '.mcp.json'));
    mcp.push(...mcpServers(dotMcp.value?.mcpServers, '.mcp.json', cwd));
  }

  const registryPath = join(claudeHome, 'plugins', 'installed_plugins.json');
  const registry = readJson(registryPath);
  if (registry.found && !registry.readable) unreadable.push(relative(claudeHome, registryPath));
  const enabledIn = new Map<string, Set<string>>();
  for (const s of settings) for (const p of s.enabledPlugins) if (p.enabled) (enabledIn.get(p.id) ?? enabledIn.set(p.id, new Set()).get(p.id)!).add(s.scope);
  const plugins: Array<Record<string, unknown>> = [];
  const installed = new Set<string>();
  if (registry.readable && registry.value?.plugins && typeof registry.value.plugins === 'object') {
    for (const [id, entries] of Object.entries(registry.value.plugins as Record<string, any>)) {
      installed.add(id);
      for (const e of Array.isArray(entries) ? entries : []) {
        const [name, marketplace] = id.split('@');
        plugins.push({
          id,
          name,
          marketplace: marketplace ?? null,
          version: typeof e?.version === 'string' ? e.version : null,
          scope: typeof e?.scope === 'string' ? e.scope : null,
          projectPath: typeof e?.projectPath === 'string' ? e.projectPath : null,
          installedAt: typeof e?.installedAt === 'string' ? e.installedAt : null,
          lastUpdated: typeof e?.lastUpdated === 'string' ? e.lastUpdated : null,
          enabledIn: [...(enabledIn.get(id) ?? [])].sort(),
        });
      }
    }
  }
  plugins.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const missingPlugins = registry.found && registry.readable ? [...enabledIn.keys()].filter((id) => !installed.has(id)).sort() : [];
  return { settings, plugins, mcpServers: mcp, unreadable, missingPlugins, registryFound: registry.found };
}

export type Check = { id: string; title: string; status: 'pass' | 'warn' | 'fail'; detail: string; evidence: string[] };

const BROAD_ALLOW = new Set(['*', 'Bash', 'Bash(*)', 'Bash(:*)', 'Bash(*:*)', 'Bash(**)']);
const where = (s: SettingsFile) => `${s.path} (${s.scope})`;

/** Configuration risks, each with the evidence that raised it. */
export function doctor(db: Db, claudeHome: string, configFile: string, pricesReadable: boolean, now: number) {
  const inv = inventory(db, claudeHome, configFile);
  const checks: Check[] = [];
  const check = (id: string, title: string, bad: 'warn' | 'fail', evidence: string[], okDetail: string, badDetail: string) =>
    checks.push({ id, title, status: evidence.length ? bad : 'pass', detail: evidence.length ? badDetail : okDetail, evidence: evidence.slice(0, 50) });

  check(
    'mode.bypass', 'Default permission mode', 'fail',
    inv.settings.filter((s) => s.defaultMode === 'bypassPermissions').map((s) => `defaultMode is bypassPermissions in ${where(s)}`),
    'No settings file makes bypassPermissions the default mode.',
    'A settings file makes every session start with permission checks bypassed.',
  );
  check(
    'allow.broad', 'Breadth of allow rules', 'warn',
    inv.settings.flatMap((s) => s.allow.filter((r) => BROAD_ALLOW.has(r.trim())).map((r) => `${r} in ${where(s)}`)),
    'No allow rule permits every shell command or every tool.',
    'An allow rule permits every shell command or every tool without asking.',
  );
  check(
    'env.credentials', 'Credentials in settings files', 'warn',
    inv.settings.flatMap((s) => s.envKeys.filter(isCredentialName).map((k) => `${k} in ${where(s)}`)),
    'No settings environment key looks like a credential.',
    'These environment keys look like credentials and are stored in plain text in a settings file.',
  );
  check(
    'plugin.missing', 'Enabled plugins that are not installed', 'warn',
    inv.missingPlugins.map((id) => `${id} is enabled but not in the plugin registry`),
    inv.registryFound ? 'Every enabled plugin is in the plugin registry.' : 'No plugin registry was found, so there is nothing to compare.',
    'A plugin is enabled in settings but is not installed.',
  );

  const since = now - 7 * 86_400_000;
  const failing = hookStats(db, since, now)
    .filter((h) => h.runs >= 5 && (h.failures + h.blocks) / h.runs > 0.2)
    .map((h) => `${h.event}: ${h.command} failed or blocked ${h.failures + h.blocks} of ${h.runs} recorded runs in the last 7 days`);
  check('hooks.failing', 'Hook reliability', 'warn', failing, 'No hook with 5 or more runs failed more than 20% of the time in the last 7 days.', 'A hook fails often. Outside stop hooks, the harness records a run only when it fails or prints output, so the share is of recorded runs.');

  const sources = [...inv.unreadable];
  if (!pricesReadable && !sources.some((s) => s.includes('user configuration'))) sources.push('the price table in the user configuration file');
  check('sources.unreadable', 'Sources that could not be read', 'warn', sources, 'Settings, registry and price table were read.', 'A source is missing or is not valid JSON; its data is empty.');

  const skipped = db.prepare('SELECT path, skipped FROM files WHERE skipped > 0 ORDER BY skipped DESC LIMIT 20').all() as Array<{ path: string; skipped: number }>;
  check(
    'index.skipped', 'Transcript lines skipped', 'warn',
    skipped.map((f) => `${f.skipped} line${f.skipped === 1 ? '' : 's'} skipped in ${relative(claudeHome, f.path)}`),
    'No transcript line was skipped.',
    'Lines that were not valid JSON, or were larger than 32 MB, were skipped.',
  );
  const alerts = db.prepare('SELECT path, reason FROM integrity_alerts WHERE ack_at IS NULL ORDER BY at DESC LIMIT 20').all() as Array<{ path: string; reason: string }>;
  check(
    'integrity.alerts', 'Transcript integrity', 'fail',
    alerts.map((a) => `${relative(claudeHome, a.path)} was ${a.reason}`),
    'No transcript was rewritten or truncated after it was indexed.',
    'An indexed transcript changed in a way other than being appended to. Review it in Audit.',
  );
  const count = (s: string) => checks.filter((c) => c.status === s).length;
  return { at: now, summary: { pass: count('pass'), warn: count('warn'), fail: count('fail') }, checks };
}

// ---- reliability -----------------------------------------------------------------------------------

/** Nearest-rank percentile of a sorted list; null when it is empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export type HookStat = { event: string; command: string; runs: number; failures: number; blocks: number; p50: number | null; p95: number | null; lastTs: number; failureShare: number };

export function hookStats(db: Db, from: number, to: number): HookStat[] {
  const rows = db.prepare("SELECT name, detail, status, duration_ms, ts FROM events WHERE kind = 'hook' AND ts >= ? AND ts <= ?").all(from, to) as any[];
  const groups = new Map<string, { event: string; command: string; run: number[]; other: number[]; counts: Record<string, number>; lastTs: number }>();
  for (const r of rows) {
    const key = `${r.name}\u0000${r.detail ?? ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { event: r.name ?? 'hook', command: r.detail ?? '', run: [], other: [], counts: { run: 0, success: 0, error: 0, blocked: 0 }, lastTs: 0 }));
    g.counts[r.status] = (g.counts[r.status] ?? 0) + 1;
    if (typeof r.duration_ms === 'number') (r.status === 'run' ? g.run : g.other).push(r.duration_ms);
    if (r.ts > g.lastTs) g.lastTs = r.ts;
  }
  const out: HookStat[] = [];
  for (const g of groups.values()) {
    // A hook counted by stop summaries has one `run` row per run; its error rows describe some of those runs.
    const summarised = g.counts.run > 0;
    const runs = summarised ? g.counts.run : g.counts.success + g.counts.error + g.counts.blocked;
    const durations = (summarised ? g.run : g.other).sort((a, b) => a - b);
    const failures = g.counts.error;
    const blocks = g.counts.blocked;
    out.push({ event: g.event, command: g.command, runs, failures, blocks, p50: percentile(durations, 50), p95: percentile(durations, 95), lastTs: g.lastTs, failureShare: runs ? (failures + blocks) / runs : 0 });
  }
  return out.sort((a, b) => b.failureShare - a.failureShare || b.runs - a.runs || a.event.localeCompare(b.event));
}

export function toolStats(db: Db, from: number, to: number) {
  const rows = db.prepare('SELECT name, category, mcp_server, status, duration_ms FROM tool_calls WHERE ts >= ? AND ts <= ?').all(from, to) as any[];
  type G = { calls: number; errors: number; denied: number; pending: number; durations: number[]; category: string; mcpServer: string | null; tools: Set<string> };
  const mk = (category: string, mcpServer: string | null): G => ({ calls: 0, errors: 0, denied: 0, pending: 0, durations: [], category, mcpServer, tools: new Set() });
  const tools = new Map<string, G>();
  const servers = new Map<string, G>();
  const bump = (g: G, r: any) => {
    g.calls++;
    g.tools.add(r.name);
    if (r.status === 'error') g.errors++;
    else if (r.status === 'denied') g.denied++;
    else if (r.status === 'pending') g.pending++;
    if (r.status !== 'pending' && typeof r.duration_ms === 'number') g.durations.push(r.duration_ms);
  };
  for (const r of rows) {
    if (!tools.has(r.name)) tools.set(r.name, mk(r.category, r.mcp_server));
    bump(tools.get(r.name)!, r);
    if (r.mcp_server) {
      if (!servers.has(r.mcp_server)) servers.set(r.mcp_server, mk('mcp', r.mcp_server));
      bump(servers.get(r.mcp_server)!, r);
    }
  }
  const stat = (g: G) => {
    const finished = g.calls - g.pending;
    const d = g.durations.sort((a, b) => a - b);
    return { calls: g.calls, finished, errors: g.errors, denied: g.denied, pending: g.pending, errorRate: finished ? g.errors / finished : 0, denialRate: g.calls ? g.denied / g.calls : 0, p50: percentile(d, 50), p95: percentile(d, 95) };
  };
  return {
    tools: [...tools.entries()].map(([tool, g]) => ({ tool, category: g.category, mcpServer: g.mcpServer, ...stat(g) })).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
    servers: [...servers.entries()].map(([server, g]) => ({ server, tools: g.tools.size, ...stat(g) })).sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server)),
  };
}

export function opsSeries(db: Db, range: { from: number; to: number; bucket: 'hour' | 'day'; tz: number; starts: number[] }) {
  const size = range.bucket === 'day' ? 86_400_000 : 3_600_000;
  const shift = range.tz * 60_000;
  const bucketOf = `((ts + CAST(? AS INTEGER)) / ${size}) * ${size} - CAST(? AS INTEGER)`;
  const events = db
    .prepare(
      `SELECT ${bucketOf} AS start, COALESCE(SUM(kind = 'api_error'), 0) apiErrors, COALESCE(SUM(kind = 'api_error' AND status = '429'), 0) rateLimits,
         COALESCE(SUM(kind = 'compaction'), 0) compactions, COALESCE(SUM(kind = 'hook' AND status IN ('error', 'blocked')), 0) hookFailures
       FROM events WHERE ts >= ? AND ts <= ? GROUP BY 1`,
    )
    .all(shift, shift, range.from, range.to) as any[];
  const tools = db.prepare(`SELECT ${bucketOf} AS start, COALESCE(SUM(status = 'error'), 0) toolErrors, COUNT(*) toolCalls FROM tool_calls WHERE ts >= ? AND ts <= ? GROUP BY 1`).all(shift, shift, range.from, range.to) as any[];
  const byStart = new Map(range.starts.map((s) => [s, { start: s, apiErrors: 0, rateLimits: 0, compactions: 0, hookFailures: 0, toolErrors: 0, toolCalls: 0 }]));
  for (const e of events) Object.assign(byStart.get(e.start) ?? {}, e);
  for (const t of tools) Object.assign(byStart.get(t.start) ?? {}, t);
  const errors = db
    .prepare("SELECT name AS error, status, COUNT(*) count FROM events WHERE kind = 'api_error' AND ts >= ? AND ts <= ? GROUP BY name, status ORDER BY count DESC, name")
    .all(range.from, range.to);
  return { bucket: range.bucket, tz: range.tz, from: range.from, to: range.to, buckets: [...byStart.values()], errors };
}
