// One place for how numbers, times and harness terms are shown.

export function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v === 0) return '$0.00';
  if (Math.abs(v) < 1) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a < 10_000) return n.toLocaleString('en-US');
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 100_000 ? 1 : 0)}K`;
  if (a < 1_000_000_000) return `${(n / 1_000_000).toFixed(a < 100_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export const int = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export const percent = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(digits)}%`);

const pad = (n: number) => String(n).padStart(2, '0');
export function clock(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DAY = 86_400_000;
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:02", "Yesterday 14:02", "18 Nov 14:02", "18 Nov 2025". */
export function when(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, n)) return hm;
  if (sameDay(d, new Date(now - DAY))) return `Yesterday ${hm}`;
  if (d.getFullYear() === n.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export const hourLabel = (ts: number) => `${pad(new Date(ts).getHours())}:00`;
export const fullTime = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : '');

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** The last two folders of a working directory: enough to recognise a project. */
export function shortPath(p: string | null | undefined): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join('/')}`;
}

export const projectName = (cwd: string | null | undefined, project: string) => (cwd ? cwd.split('/').filter(Boolean).pop() ?? cwd : project);

export const modelName = (m: string | null | undefined) => (m ? m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d{8})$/, '') : '—');

/** How a tool call was allowed or denied, in the operator's words. The raw values stay available as a tooltip. */
export function allowedBy(decision?: string | null, source?: string | null, reason?: string | null): string {
  if (!decision) return 'not recorded';
  if (decision === 'accept') {
    if (source?.startsWith('user')) return source === 'user_temporary' ? 'you, once' : 'you';
    if (reason === 'classifier') return 'auto-mode classifier';
    if (reason === 'rule') return 'allow rule';
    if (reason === 'mode') return 'permission mode';
    if (reason === 'subcommandResults') return 'allow rules, per subcommand';
    if (source === 'hook') return 'hook';
    return reason && reason !== 'other' ? reason : 'configuration';
  }
  if (source === 'hook') return 'blocked by a hook';
  if (reason?.startsWith('bashMiss:')) return `no rule matched (${reason.slice(9).replace(/-/g, ' ')})`;
  if (source?.startsWith('user')) return 'you declined';
  return reason && reason !== 'unknown' ? `declined: ${reason}` : 'declined';
}

export function allowedByText(text: string): { label: string; raw: string } {
  if (text === 'not recorded') return { label: text, raw: text };
  const [decision, source, reason] = text.split(' · ');
  return { label: allowedBy(decision, source, reason), raw: text };
}

export const REASONS: Record<string, { label: string; tone: 'critical' | 'serious' | 'warn' | 'info' }> = {
  integrity: { label: 'Transcript changed', tone: 'critical' },
  question: { label: 'Waiting for your answer', tone: 'info' },
  blocked: { label: 'Blocked by a hook', tone: 'serious' },
  tool_pending: { label: 'Tool pending over a minute', tone: 'warn' },
  rate_limited: { label: 'Rate limited', tone: 'serious' },
  finding: { label: 'Risky action to review', tone: 'critical' },
};

export const SEVERITY_TONE: Record<string, 'critical' | 'serious' | 'warn' | 'idle'> = { critical: 'critical', high: 'serious', medium: 'warn', low: 'idle' };

export const tzOffset = () => -new Date().getTimezoneOffset();
