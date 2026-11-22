// Secret masking. Everything Aegis stores or shows passes through here first.
//
// Every pattern is linear: no nested unbounded quantifier, no backreference, and every repetition
// that could overlap with what follows it is bounded. Patterns run on at most MASK_LIMIT characters
// of a field; anything beyond that is dropped, never passed through unmasked. Callers mask first and
// shorten afterwards, so a cut can never leave the front half of a secret behind.

export const MASK_LIMIT = 64 * 1024;

type Pattern = { kind: string; re: RegExp; replace?: (match: string, ...groups: string[]) => string };

/** Names under which a value is a credential whatever it looks like. */
const NAME = 'pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential';

/**
 * The one exception to "whatever its shape": a bare number under a name containing "token" is a
 * count (max_tokens=4096, input_tokens: 862), not a secret.
 */
function isTokenCount(name: string, value: string): boolean {
  return /token/i.test(name) && /^\d{1,12}$/.test(value);
}

// An authorization scheme word is not the credential; the value after it is masked by its own pattern.
const valueReplace = (m: string, head: string, value: string) =>
  isTokenCount(head, value) || value.startsWith('[masked:') || /^(?:Bearer|Basic|Digest|Negotiate)$/i.test(value) ? m : `${head}[masked:value]`;

export const PATTERNS: Pattern[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s\\:.,()]{0,16000}(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----)?/g },
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
    // scheme://user:password@host — the password may itself contain a slash
    kind: 'url-credential',
    re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,100}):([^\s@]{1,200})@/gi,
    replace: (_m, head) => `${head}:[masked:url-credential]@`,
  },
  {
    // name = "value with spaces", masked to the closing quote
    kind: 'value',
    re: new RegExp(`((?:${NAME})[A-Za-z0-9_-]{0,30}\\\\?["']?\\s{0,3}[:=]\\s{0,3}\\\\?")([^"\\n]{1,400})`, 'gi'),
    replace: valueReplace,
  },
  {
    kind: 'value',
    re: new RegExp(`((?:${NAME})[A-Za-z0-9_-]{0,30}\\\\?["']?\\s{0,3}[:=]\\s{0,3}\\\\?')([^'\\n]{1,400})`, 'gi'),
    replace: valueReplace,
  },
  {
    // password: several words — a password line is masked to its end
    kind: 'value',
    re: /((?:pass(?:word|wd|phrase)|pwd)[A-Za-z0-9_-]{0,30}\s{0,3}[:=][ \t]{0,3})([^\s"'[][^\n"']{0,200})/gi,
    replace: (_m, head) => `${head}[masked:value]`,
  },
  {
    // name = value, NAME=value: an unquoted value runs to the next white space
    kind: 'value',
    re: new RegExp(`((?:${NAME})[A-Za-z0-9_-]{0,30}\\\\?["']?\\s{0,3}[:=]\\s{0,3})([^\\s"']{1,400})`, 'gi'),
    replace: valueReplace,
  },
  {
    // --token value, --password=value
    kind: 'flag',
    re: new RegExp(`(--?[a-z-]{0,20}(?:${NAME})[a-z-]{0,20}[ =]{1,2}["']?)([^\\s"']{1,400})`, 'gi'),
    replace: valueReplace,
  },
  {
    // curl -u user:password
    kind: 'flag',
    re: /((?:\s-u|--user)[ =]["']?[^\s:"']{1,100}:)([^\s"']{1,200})/g,
    replace: (_m, head) => `${head}[masked:value]`,
  },
  {
    // mysql -pPASSWORD, sshpass -p PASSWORD, docker login -p PASSWORD
    kind: 'flag',
    re: /(\b(?:mysql|mariadb|mysqldump|mysqladmin|sshpass|docker\s{1,3}login)\b[^|;&\n]{0,300}?\s-p\s?)([^\s-][^\s]{0,200})/g,
    replace: (_m, head) => `${head}[masked:value]`,
  },
];

/** Masks recognised secrets in one field. Text beyond the limit is cut, not returned unmasked. */
export function mask(text: string, limit = MASK_LIMIT): string {
  if (!text) return text;
  const cut = text.length > limit;
  let s = cut ? text.slice(0, limit) : text;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    s = p.replace ? s.replace(p.re, p.replace as (m: string, ...g: string[]) => string) : s.replace(p.re, `[masked:${p.kind}]`);
  }
  if (!cut) return s;
  // The cut may have split a secret, leaving a front half no pattern recognises: drop the last run of non-space.
  return `${s.replace(/\S{1,4096}$/, '')}… [${text.length - limit} more characters not shown]`;
}

/** Masks, then shortens, a field for storage in the index. */
export function preview(text: string, max: number): string {
  const masked = mask(text);
  return masked.length > max ? masked.slice(0, max) + '…' : masked;
}

const CREDENTIAL_KEY = new RegExp(`(?:${NAME})`, 'i');
const MAX_DEPTH = 64;

/** Masks every string in a JSON value; values under credential-like keys are masked whatever their shape. */
export function maskDeep(value: unknown, key = '', depth = 0): unknown {
  const credential = key !== '' && CREDENTIAL_KEY.test(key);
  if (typeof value === 'string') {
    if (credential && value !== '' && !value.startsWith('[masked:') && !isTokenCount(key, value)) return '[masked:value]';
    return mask(value);
  }
  if (typeof value === 'number') return credential && !/token/i.test(key) ? '[masked:value]' : value;
  if (value === null || typeof value !== 'object') return value;
  // Fail closed: what is nested too deep to walk is not shown at all.
  if (depth >= MAX_DEPTH) return '[masked:nested too deep to show]';
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, key, depth + 1));
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k, depth + 1);
  return out;
}

/** True when a setting or environment key name suggests it holds a credential. */
export const isCredentialName = (name: string) => CREDENTIAL_KEY.test(name) || /(?:^|_)(?:key|pat)(?:$|_)/i.test(name);
