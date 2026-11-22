// Prices come from the table the harness caches in the user configuration file. Nothing is hard-coded:
// a model with no entry is unpriced and its cost is never guessed.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };

export type PriceTable = {
  models: Map<string, Rates>;
  /** Hash of the table's content; a change means stored costs must be recomputed. */
  hash: string;
  readable: boolean;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function loadPrices(configFile: string): PriceTable {
  const models = new Map<string, Rates>();
  let readable = true;
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8'))?.additionalModelCostsCache;
    if (!raw || typeof raw !== 'object') readable = false; // no price table in the file
    if (raw && typeof raw === 'object') {
      for (const [model, value] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
        const input = num(value?.inputTokens);
        const output = num(value?.outputTokens);
        const cacheRead = num(value?.promptCacheReadTokens);
        const cacheWrite5m = num(value?.promptCacheWriteTokens);
        // An entry without every rate is not a price: the model stays unpriced rather than guessed.
        // The one allowed fallback is the 1-hour cache-write rate, which defaults to the 5-minute rate.
        if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite5m === undefined) continue;
        models.set(model, { input, output, cacheRead, cacheWrite5m, cacheWrite1h: num(value.promptCacheWrite1hTokens) ?? cacheWrite5m });
      }
    }
  } catch {
    readable = false;
  }
  const canonical = JSON.stringify([...models.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  return { models, hash: createHash('sha256').update(canonical).digest('hex'), readable };
}

/** Exact id first, then the longest priced id the model starts with. */
export function resolveModel(table: PriceTable, model: string | null | undefined): string | null {
  if (!model) return null;
  if (table.models.has(model)) return model;
  let best: string | null = null;
  for (const id of table.models.keys()) {
    if (model.startsWith(id) && (best === null || id.length > best.length)) best = id;
  }
  return best;
}

/** USD for one response; null when the model has no price. Rates are USD per million tokens. */
export function costOf(table: PriceTable, model: string | null | undefined, t: Tokens): number | null {
  const id = resolveModel(table, model);
  if (id === null) return null;
  const r = table.models.get(id)!;
  return (
    (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + t.cacheWrite5m * r.cacheWrite5m + t.cacheWrite1h * r.cacheWrite1h) /
    1e6
  );
}
