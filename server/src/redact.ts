// Secret masking. Everything Aegis stores or shows passes through here first.
//
// Every pattern is linear: no nested unbounded quantifier, no backreference, and every repetition
// that could overlap with what follows it is bounded. Patterns run on at most MASK_LIMIT characters
// of a field; anything beyond that is dropped, never passed through unmasked.

export const MASK_LIMIT = 64 * 1024;

type Pattern = { kind: string; re: RegExp; replace?: (match: string, ...groups: string[]) => string };

const NAME = 'pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential';

/** A value under a credential-like name is masked unless it plainly is not a secret (a number, a type name). */
function looksSecret(name: string, value: string): boolean {
  if (/^\[masked:/.test(value)) return false;
  if (/pass/i.test(name)) return value.length >= 4;
  if (value.length >= 20) return true;
  return value.length >= 8 && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

export const PATTERNS: Pattern[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\s\\]{0,16000}(?:-----END [A-Z ]{0,40}PRIVATE KEY-----)?/g },
  { kind: 'aws-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,200}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,200}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,100}/g },
  { kind: 'slack-token', re: /\bxox[abeprs]-[A-Za-z0-9-]{10,200}/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,200}/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}/g },
  { kind: 'atlassian-token', re: /\bATATT[A-Za-z0-9_=-]{20,400}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{4,1000}/g },
  {
    kind: 'auth',
    re: /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,4000})/gi,
    replace: (_m, scheme) => `${scheme} [masked:auth]`,
  },
  {
    kind: 'url-credential',
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,100}):([^\s@/]{1,200})@/gi,
    replace: (_m, head) => `${head}:[masked:url-credential]@`,
  },
  {
    // name = value, "name": "value", NAME=value
    kind: 'value',
    re: new RegExp(`((?:${NAME})[A-Za-z0-9_-]{0,30}\\\\?["']?\\s{0,3}[:=]\\s{0,3}\\\\?["']?)([^\\s"'\\\\,;&]{4,400})`, 'gi'),
    replace: (m, head, value) => (looksSecret(head, value) ? `${head}[masked:value]` : m),
  },
  {
    // --token value, --password=value
    kind: 'flag',
    re: new RegExp(`(--?[a-z-]{0,20}(?:${NAME})[a-z-]{0,20}[ =]{1,2}["']?)([^\\s"']{4,400})`, 'gi'),
    replace: (m, head, value) => (looksSecret(head, value) ? `${head}[masked:value]` : m),
  },
];

/** Masks recognised secrets in one field. Text beyond the limit is cut, not returned unmasked. */
export function mask(text: string, limit = MASK_LIMIT): string {
  if (!text) return text;
  let s = text.length > limit ? text.slice(0, limit) : text;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    s = p.replace ? s.replace(p.re, p.replace as (m: string, ...g: string[]) => string) : s.replace(p.re, `[masked:${p.kind}]`);
  }
  return text.length > limit ? `${s}… [${text.length - limit} more characters not shown]` : s;
}

/** Masks and shortens a field for storage in the index. */
export function preview(text: string, max: number): string {
  const masked = mask(text.length > max * 2 ? text.slice(0, max * 2) : text);
  return masked.length > max ? masked.slice(0, max) + '…' : masked;
}

const CREDENTIAL_KEY = new RegExp(`(?:${NAME})`, 'i');

/** Masks every string in a JSON value; strings under credential-like keys are masked whatever their shape. */
export function maskDeep(value: unknown, key = '', depth = 0): unknown {
  if (typeof value === 'string') {
    if (key && CREDENTIAL_KEY.test(key) && value.length >= 4 && !/^\[masked:/.test(value)) return '[masked:value]';
    return mask(value);
  }
  if (value === null || typeof value !== 'object' || depth > 64) return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, key, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k, depth + 1);
  return out;
}

/** True when a setting or environment key name suggests it holds a credential. */
export const isCredentialName = (name: string) => CREDENTIAL_KEY.test(name) || /(?:^|_)(?:key|pat|pwd)(?:$|_)/i.test(name);
