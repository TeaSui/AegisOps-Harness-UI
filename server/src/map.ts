// The harness as one picture: who asked, which models answered, what passed the gate, which tools ran.
// Every number is a count over indexed rows in a time span; nothing here is estimated.
import type { Db } from './db.ts';
import { hookStats, percentile, toolStats } from './inventory.ts';

const CATEGORIES = ['exec', 'read', 'write', 'fetch', 'agent', 'mcp', 'other'] as const;

export function harnessMap(db: Db, from: number, to: number) {
  const span = [from, to] as const;
  const prompts = (db.prepare("SELECT COUNT(*) n FROM prompts p JOIN files f ON f.id = p.file_id WHERE f.agent_id IS NULL AND p.origin IN ('human', 'sdk', 'command') AND p.ts >= ? AND p.ts <= ?").get(...span) as { n: number }).n;
  const sessions = (db.prepare('SELECT COUNT(*) n FROM sessions WHERE last_ts >= ? AND first_ts <= ?').get(...span) as { n: number }).n;

  const models = (
    db
      .prepare(
        `SELECT COALESCE(model, '') model, COUNT(*) calls, COALESCE(SUM(cost), 0) cost, COALESCE(SUM(cost IS NULL), 0) unpriced, COALESCE(SUM(output), 0) output
         FROM api_calls WHERE ts >= ? AND ts <= ? GROUP BY 1 ORDER BY calls DESC, model`,
      )
      .all(...span) as Array<{ model: string; calls: number; cost: number; unpriced: number; output: number }>
  ).map((m) => ({ ...m, model: m.model || null }));
  const api = db
    .prepare("SELECT COALESCE(SUM(kind = 'api_error'), 0) errors, COALESCE(SUM(kind = 'api_error' AND status = '429'), 0) rateLimits, COALESCE(SUM(kind = 'compaction'), 0) compactions FROM events WHERE ts >= ? AND ts <= ?")
    .get(...span) as { errors: number; rateLimits: number; compactions: number };

  const hooks = hookStats(db, from, to);
  const gate = {
    hookCommands: new Set(hooks.map((h) => h.command)).size,
    hookRuns: hooks.reduce((n, h) => n + h.runs, 0),
    hookFailures: hooks.reduce((n, h) => n + h.failures, 0),
    hookBlocks: hooks.reduce((n, h) => n + h.blocks, 0),
    denied: 0,
  };

  const stats = toolStats(db, from, to);
  const durations = db.prepare("SELECT category, duration_ms d FROM tool_calls WHERE ts >= ? AND ts <= ? AND status != 'pending' AND duration_ms IS NOT NULL ORDER BY duration_ms").all(...span) as Array<{ category: string; d: number }>;
  const byCategory = new Map<string, number[]>();
  for (const r of durations) (byCategory.get(r.category) ?? byCategory.set(r.category, []).get(r.category)!).push(r.d);
  const tools = CATEGORIES.map((category) => {
    const members = stats.tools.filter((t) => t.category === category);
    const sum = (k: 'calls' | 'errors' | 'denied' | 'pending' | 'finished') => members.reduce((n, t) => n + t[k], 0);
    const finished = sum('finished');
    return {
      category,
      calls: sum('calls'),
      errors: sum('errors'),
      denied: sum('denied'),
      pending: sum('pending'),
      errorRate: finished ? sum('errors') / finished : 0,
      p50: percentile(byCategory.get(category) ?? [], 50),
      top: members.slice(0, 3).map((t) => ({ tool: t.tool, calls: t.calls })),
    };
  });
  gate.denied = tools.reduce((n, t) => n + t.denied, 0);

  const agentTypes = db
    .prepare("SELECT COALESCE(agent_type, 'subagent') type, COUNT(*) n FROM files WHERE agent_id IS NOT NULL AND first_ts >= ? AND first_ts <= ? GROUP BY 1 ORDER BY n DESC, type LIMIT 8")
    .all(...span) as Array<{ type: string; n: number }>;
  const agentWork = db.prepare('SELECT COUNT(*) calls, COALESCE(SUM(cost), 0) cost FROM api_calls WHERE agent_id IS NOT NULL AND ts >= ? AND ts <= ?').get(...span) as { calls: number; cost: number };
  const spawned = (db.prepare('SELECT COUNT(*) n FROM files WHERE agent_id IS NOT NULL AND first_ts >= ? AND first_ts <= ?').get(...span) as { n: number }).n;

  return {
    from,
    to,
    prompts,
    sessions,
    models,
    api: { calls: models.reduce((n, m) => n + m.calls, 0), cost: models.reduce((n, m) => n + m.cost, 0), unpriced: models.reduce((n, m) => n + m.unpriced, 0), ...api },
    gate,
    tools,
    servers: stats.servers.map((s) => ({ server: s.server, calls: s.calls, errors: s.errors, errorRate: s.errorRate })),
    subagents: { spawned, types: agentTypes, ...agentWork },
  };
}
