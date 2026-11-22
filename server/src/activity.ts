// The console's own activity log: an append-only JSON Lines file of what was done through Aegis
// (reveals, exports, triage, acknowledgements, run launches and stops). Identifiers only, never
// transcript text or a prompt.
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ActivityEntry = { at: number; action: string } & Record<string, string | number | boolean | null>;

export class Activity {
  private file: string;
  private now: () => number;
  constructor(stateDir: string, now: () => number) {
    this.file = join(stateDir, 'activity.jsonl');
    this.now = now;
  }

  record(action: string, detail: Record<string, string | number | boolean | null> = {}) {
    const fresh = !existsSync(this.file);
    appendFileSync(this.file, JSON.stringify({ at: this.now(), action, ...detail }) + '\n', { mode: 0o600 });
    if (fresh) chmodSync(this.file, 0o600);
  }

  /** Most recent first. */
  list(limit: number): ActivityEntry[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
    const out: ActivityEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        /* a torn line is skipped */
      }
    }
    return out;
  }
}
