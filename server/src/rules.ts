// Risk rules. A rule is data: an id, a default severity, the tools it applies to and a matcher.
// Matchers work on a simple split of a shell command into pipelines and stages; they do not parse
// quoting, so a rule can fire on a quoted string. That is the conservative side for an audit tool,
// and the stored evidence shows exactly what matched.
//
// Every matcher is linear in the input and runs on at most RULE_LIMIT characters.
import { tmpdir } from 'node:os';
import { posix } from 'node:path';

export const RULE_LIMIT = 64 * 1024;

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
export const severityOfRank = (rank: number): Severity | null =>
  rank >= 4 ? 'critical' : rank === 3 ? 'high' : rank === 2 ? 'medium' : rank === 1 ? 'low' : null;

export type Match = { severity: Severity; evidence: string };
export type RuleContext = { cwd: string; claudeHome: string };
export type Rule = {
  id: string;
  title: string;
  severity: Severity;
  appliesTo: 'shell' | 'read' | 'write' | 'session';
  description: string;
};

/** `bare` is the stage with every quoted multi-word argument emptied: what was typed as command, not as text. */
type Stage = { words: string[]; text: string; bare?: string };
type Pipeline = { stages: Stage[]; text: string; bare?: string };

const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'command', 'exec', 'nice', 'builtin', 'then', 'do', 'else', '(', '{', '!']);

/**
 * Splits a command into pipelines and stages. Quote-aware: separators inside quotes do not split,
 * and a quoted argument is one word (so the text of a commit message is never read as a command).
 */
function parse(command: string): Pipeline[] {
  const out: Pipeline[] = [];
  let stages: Stage[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote = '';
  let stageStart = 0;
  let pipeStart = 0;
  const endWord = () => {
    if (inWord && words.length < 400) words.push(word);
    word = '';
    inWord = false;
  };
  const endStage = (end: number) => {
    endWord();
    const text = command.slice(stageStart, end).trim();
    if (words.length && text) stages.push({ words, text, bare: words.map((w) => (/\s/.test(w) ? '""' : w)).join(' ') });
    words = [];
  };
  const endPipeline = (end: number) => {
    endStage(end);
    if (stages.length) out.push({ stages, text: command.slice(pipeStart, end).trim(), bare: stages.map((x) => x.bare).join(' | ') });
    stages = [];
  };
  const n = command.length;
  for (let i = 0; i < n; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && i + 1 < n) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < n) {
      if (command[i + 1] === '\n') i++;
      else {
        word += command[++i];
        inWord = true;
      }
    } else if (ch === ' ' || ch === '\t') endWord();
    else if (ch === '\n' || ch === ';') {
      endPipeline(i);
      stageStart = pipeStart = i + 1;
    } else if (ch === '&' && command[i + 1] === '&') {
      endPipeline(i);
      i++;
      stageStart = pipeStart = i + 1;
    } else if (ch === '&' && command[i + 1] !== '>' && command[i - 1] !== '>' && command[i - 1] !== '<') {
      // a single & puts the command in the background; what follows is another command
      endPipeline(i);
      stageStart = pipeStart = i + 1;
    } else if (ch === '|' && command[i + 1] === '|') {
      endPipeline(i);
      i++;
      stageStart = pipeStart = i + 1;
    } else if (ch === '|') {
      endStage(i);
      stageStart = i + 1;
    } else {
      word += ch;
      inWord = true;
    }
  }
  endPipeline(n);
  return out;
}

const HEREDOC = /(?<!<)<<(?!<)-?[ \t]{0,4}(?:'([A-Za-z_][A-Za-z0-9_]{0,40})'|"([A-Za-z_][A-Za-z0-9_]{0,40})"|([A-Za-z_][A-Za-z0-9_]{0,40}))/;
const PIPED_TO_SHELL = /\|\s{0,4}(?:sudo\s{1,4})?(?:ba|z|da|k)?sh\b/;

type QuoteState = { single: boolean; double: boolean; arith: number };

/** Advances the quote and $(( )) state over a piece of command text. Linear. */
function scanQuotes(text: string, st: QuoteState): QuoteState {
  let { single, double, arith } = st;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (single) {
      if (ch === "'") single = false;
    } else if (ch === '\\') i++;
    else if (double) {
      if (ch === '"') double = false;
    } else if (ch === "'") single = true;
    else if (ch === '"') double = true;
    else if (ch === '(' && text[i + 1] === '(') {
      arith++;
      i++;
    } else if (ch === ')' && text[i + 1] === ')' && arith > 0) {
      arith--;
      i++;
    }
  }
  return { single, double, arith };
}

/**
 * Takes here-document bodies out of a command. A body is text handed to a program, not commands:
 * writing a file whose content mentions `rm -rf /` runs nothing. The exceptions are kept: a body fed
 * to a shell (directly or through a pipe) is commands, and a body fed to a database client is
 * statements. A `<<` with no closing line is not treated as a here-document, so nothing is dropped.
 */
function splitHeredocs(command: string): { shell: string; sql: string } {
  if (!command.includes('<<')) return { shell: command, sql: command };
  const lines = command.split('\n');
  const shell: string[] = [];
  const sql: string[] = [];
  // Quotes can open on one line and close on a later one (a commit message), so the state is carried along.
  let state: QuoteState = { single: false, double: false, arith: 0 };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    shell.push(line);
    sql.push(line);
    const m = HEREDOC.exec(line);
    const at = m ? scanQuotes(line.slice(0, m.index), state) : null;
    state = scanQuotes(line + '\n', state);
    // `<<` is an operator only outside quotes and outside $(( )), where it is a shift
    if (!m || !at || at.single || at.double || at.arith > 0) continue;
    const delimiter = m[1] ?? m[2] ?? m[3];
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === delimiter) {
        end = j;
        break;
      }
    }
    if (end === -1) continue;
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + m[0].length);
    const stage = before.slice(Math.max(before.lastIndexOf('|'), before.lastIndexOf(';'), before.lastIndexOf('&')) + 1);
    const verb = verbOf({ text: stage, words: stage.trim().split(/\s+/).slice(0, 40) }).verb;
    const toShell = SHELLS.has(verb) || PIPED_TO_SHELL.test(after);
    const toSql = DB_CLIENT.test(stage) || DB_CLIENT.test(after);
    for (let j = i + 1; j < end; j++) {
      if (toShell) shell.push(lines[j]);
      if (toSql) sql.push(lines[j]);
    }
    i = end;
  }
  return { shell: shell.join('\n'), sql: sql.join('\n') };
}

/** The stage's command words with wrappers and leading assignments removed. */
function verbOf(stage: Stage): { verb: string; args: string[]; sudo: boolean } {
  let i = 0;
  let sudo = false;
  const w = stage.words;
  while (i < w.length) {
    const word = w[i].replace(/^[({]+/, '');
    if (word === 'sudo' || word === 'doas') sudo = true;
    if (WRAPPERS.has(word) || word === '' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i++;
    else if (sudo && /^-[ughpUCDRT]$/.test(word)) i += 2; // sudo -u root: the option takes a value
    else if (sudo && /^-/.test(word)) i++;
    else break;
  }
  const first = (w[i] ?? '').replace(/^[({]+/, '');
  return { verb: first.slice(first.lastIndexOf('/') + 1), args: w.slice(i + 1), sudo };
}

const unquote = (s: string) => s.replace(/[);]+$/g, '');
const isFlag = (s: string) => s.startsWith('-');
const shortHas = (arg: string, letter: string) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter);

const ROOT_TARGETS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}', '${HOME}/', '${HOME}/*']);
const WIDE_TARGETS = new Set(['..', '../', '../*', '*', '.', './', './*', '.*']);

function rmMatch(args: string[]): Severity | null {
  const flags = args.filter(isFlag);
  const recursive = flags.some((f) => f === '--recursive' || shortHas(f, 'r') || shortHas(f, 'R'));
  const force = flags.some((f) => f === '--force' || shortHas(f, 'f'));
  if (!recursive || !force) return null;
  let found: Severity | null = null;
  for (const raw of args) {
    if (isFlag(raw)) continue;
    const t = unquote(raw);
    if (ROOT_TARGETS.has(t)) return 'critical';
    // a top-level system directory such as /usr or /Users, or a parent or wildcard root
    if (WIDE_TARGETS.has(t) || /^\/[A-Za-z0-9_.-]+\/?\*?$/.test(t) || /^(?:\.\.\/)+\*?$/.test(t)) found = 'high';
  }
  return found;
}

function gitSub(args: string[]): { sub: string; rest: string[] } {
  let i = 0;
  while (i < args.length) {
    if (args[i] === '-C' || args[i] === '-c') i += 2;
    else if (isFlag(args[i])) i++;
    else break;
  }
  return { sub: args[i] ?? '', rest: args.slice(i + 1) };
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'perl', 'ruby', 'php']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'http', 'https']);
const READERS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'rg', 'awk', 'sed', 'cp', 'scp', 'rsync', 'base64', 'xxd', 'od', 'strings',
  'source', '.', 'open', 'bat', 'nl', 'cut', 'sort', 'jq', 'yq', 'tee', 'tar', 'zip', 'curl', 'python', 'python3', 'node', 'code', 'vim', 'nano', 'view', 'diff', 'wc',
]);

// Credential stores. `.env.example` and public keys are not secrets.
const CREDENTIAL_PATHS: RegExp[] = [
  /(?:^|[\s/"'=<(])\.env(?:\.(?!example|sample|template|dist|defaults)[A-Za-z0-9_-]{1,40})?(?=$|[\s"';|&)<>])/,
  /\.ssh\/(?:id_[a-z0-9_]{2,20}|[A-Za-z0-9_.-]{1,60}\.pem)(?!\.pub)(?=$|[\s"';|&)<>])/,
  /\.aws\/credentials\b/,
  /\.netrc\b/,
  /\.git-credentials\b/,
  /\.config\/gcloud\/(?:credentials\.db|access_tokens\.db|application_default_credentials\.json)/,
  /\.kube\/config\b/,
  /\.docker\/config\.json\b/,
  /\.npmrc\b/,
  /\.pypirc\b/,
  /\.claude\/\.credentials\.json\b/,
  /\bid_(?:rsa|ed25519|ecdsa|dsa)(?=$|[\s"';|&)<>])/,
];

export const isCredentialPath = (path: string) => CREDENTIAL_PATHS.some((re) => re.test(path));

const TLS_OFF: RegExp[] = [
  /\bwget\b[^|;&\n]{0,2000}--no-check-certificate\b/,
  /\bGIT_SSL_NO_VERIFY=(?:1|true)\b/i,
  /\bNODE_TLS_REJECT_UNAUTHORIZED=["']?0\b/,
  /\bPYTHONHTTPSVERIFY=["']?0\b/,
  /\bStrictHostKeyChecking[= ]no\b/i,
  /\bUserKnownHostsFile[= ]\/dev\/null\b/,
  /\bstrict-ssl\s+false\b/,
  /\bsslVerify\s+false\b/i,
  /--insecure-skip-tls-verify\b/,
];

const DB_CLIENT = /\b(?:psql|mysql|mariadb|sqlite3|redis-cli|mongosh|mongo|sqlcmd|clickhouse-client|clickhouse|bq|duckdb|cockroach|snowsql|pg_restore|cqlsh|dynamodb)\b/;
const DB_DESTRUCTIVE: RegExp[] = [
  /\bDROP\s+(?:DATABASE|SCHEMA|TABLE)\b/i,
  /\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z_"`[]/i,
  /\bDELETE\s+FROM\s+[A-Za-z0-9_."`[\]]{1,200}\s{0,10}(?:;|["']|$)/i,
  /\bFLUSH(?:ALL|DB)\b/i,
  /\bdelete-table\b/,
];

const INFRA: Array<{ re: RegExp; severity: Severity }> = [
  { re: /\b(?:terraform|tofu|terragrunt)\s+(?:[^|;&\n]{0,200}\s)?(?:destroy|apply\s+[^|;&\n]{0,200}-destroy)\b/, severity: 'critical' },
  { re: /\b(?:cdk|pulumi)\s+(?:[^|;&\n]{0,200}\s)?destroy\b/, severity: 'critical' },
  { re: /\bkubectl\s+(?:[^|;&\n]{0,200}\s)?delete\s+(?:ns|namespace|namespaces)\b/, severity: 'critical' },
  { re: /\bkubectl\s+(?:[^|;&\n]{0,200}\s)?delete\s[^|;&\n]{0,400}(?:--all\b|\s-A\b|--all-namespaces\b)/, severity: 'critical' },
  { re: /\baws\s+(?:[^|;&\n]{0,200}\s)?[a-z0-9-]{2,40}\s+(?:delete|terminate|purge)-[a-z-]{2,60}\b/, severity: 'critical' },
  { re: /\baws\s+(?:[^|;&\n]{0,200}\s)?s3\s+(?:rb\b|rm\s[^|;&\n]{0,400}--recursive\b)/, severity: 'critical' },
  { re: /\b(?:gcloud|az)\s[^|;&\n]{0,400}\s(?:delete|destroy|purge)\b/, severity: 'critical' },
  { re: /\bhelm\s+(?:[^|;&\n]{0,200}\s)?(?:uninstall|delete)\b/, severity: 'critical' },
  { re: /\bdocker\s+(?:system|volume)\s+prune\b/, severity: 'medium' },
];

const PUBLISH: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:[^|;&\n]{0,100}\s)?publish\b/,
  /\bcargo\s+publish\b/,
  /\btwine\s+upload\b/,
  /\bgem\s+push\b/,
  /\bdocker\s+(?:image\s+)?push\b/,
  /\bmvn\s[^|;&\n]{0,200}\bdeploy\b/,
  /\bgradle(?:w)?\s[^|;&\n]{0,200}\bpublish\b/,
  /\bgh\s+release\s+create\b/,
];

const LOCAL_HOST = /\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|\s|"|'|$)/;

export const RULES: Rule[] = [
  { id: 'fs.destructive-delete', title: 'Recursive forced delete of a root-like path', severity: 'high', appliesTo: 'shell', description: 'rm with recursive and force flags on /, ~, $HOME, a parent path, a top-level directory or a bare wildcard.' },
  { id: 'git.force-push', title: 'Forced push', severity: 'high', appliesTo: 'shell', description: 'git push with --force or a + refspec (medium with --force-with-lease).' },
  { id: 'git.history-rewrite', title: 'History or working tree discarded', severity: 'medium', appliesTo: 'shell', description: 'git reset --hard, clean -f, filter-branch, filter-repo, reflog expire, checkout -- .' },
  { id: 'git.no-verify', title: 'Commit or push with verification skipped', severity: 'medium', appliesTo: 'shell', description: 'git commit or push with --no-verify.' },
  { id: 'exec.pipe-to-shell', title: 'Download piped into a shell or interpreter', severity: 'high', appliesTo: 'shell', description: 'curl or wget output executed by a shell or interpreter.' },
  { id: 'priv.sudo', title: 'Privilege escalation', severity: 'high', appliesTo: 'shell', description: 'sudo, doas or su -.' },
  { id: 'priv.chmod-open', title: 'World-writable permissions', severity: 'medium', appliesTo: 'shell', description: 'chmod 777 or a recursive world-writable chmod.' },
  { id: 'secret.credential-read', title: 'Credential store read', severity: 'high', appliesTo: 'shell', description: '.env files, SSH private keys, cloud credential files, keychains, .netrc and token caches read by a command or the Read tool.' },
  { id: 'secret.env-dump', title: 'Whole environment printed', severity: 'medium', appliesTo: 'shell', description: 'env, printenv or export -p with no arguments.' },
  { id: 'net.tls-off', title: 'Certificate or host-key verification off', severity: 'medium', appliesTo: 'shell', description: 'curl -k, --no-check-certificate, StrictHostKeyChecking=no and similar.' },
  { id: 'net.exfil', title: 'File or command output uploaded to a remote host', severity: 'high', appliesTo: 'shell', description: 'curl sending a file or stdin, or nc after a pipe, to a host that is not local.' },
  { id: 'infra.destroy', title: 'Destructive infrastructure command', severity: 'critical', appliesTo: 'shell', description: 'terraform or cdk destroy, kubectl delete of namespaces or --all, cloud CLI delete and terminate calls, docker prune (medium).' },
  { id: 'db.destructive', title: 'Destructive database statement', severity: 'critical', appliesTo: 'shell', description: 'DROP, TRUNCATE, DELETE without WHERE or FLUSHALL sent through a database client.' },
  { id: 'pkg.publish', title: 'Package or image published', severity: 'medium', appliesTo: 'shell', description: 'npm publish, cargo publish, twine upload, docker push, gh release create and similar.' },
  { id: 'fs.write-outside-project', title: 'Write outside the session project', severity: 'medium', appliesTo: 'write', description: 'A file tool wrote to an absolute path outside the working directory, temp directories and the Claude home plan and scratch areas.' },
  { id: 'perm.bypass-mode', title: 'Session ran with permission checks bypassed', severity: 'high', appliesTo: 'session', description: 'The transcript records the bypassPermissions mode.' },
];

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));
export const ruleById = (id: string) => RULE_BY_ID.get(id);

export type Finding = { ruleId: string; severity: Severity; evidence: string };

/** Findings for one shell command, at most one per rule (the most severe match wins). */
export function matchShell(commandRaw: string, depth = 0): Finding[] {
  const limited = commandRaw.length > RULE_LIMIT ? commandRaw.slice(0, RULE_LIMIT) : commandRaw;
  const { shell: command, sql } = splitHeredocs(limited);
  const found = new Map<string, Finding>();
  const add = (ruleId: string, evidence: string, severity?: Severity) => {
    const sev = severity ?? RULE_BY_ID.get(ruleId)!.severity;
    const prev = found.get(ruleId);
    if (!prev || SEVERITY_RANK[sev] > SEVERITY_RANK[prev.severity]) found.set(ruleId, { ruleId, severity: sev, evidence: evidence.slice(0, 8000) });
  };

  // $(...) and backticks run a command wherever they appear
  if (depth < 2) {
    let seen = 0;
    for (const m of command.matchAll(/\$\(([^()]{1,2000})\)|`([^`]{1,2000})`/g)) {
      if (++seen > 20) break;
      for (const f of matchShell(m[1] ?? m[2], depth + 1)) add(f.ruleId, f.evidence, f.severity);
    }
  }

  for (const pipeline of parse(command)) {
    let downloaderSeen = false;
    pipeline.stages.forEach((stage, index) => {
      const { verb, args, sudo } = verbOf(stage);
      const text = stage.text;
      if (sudo) add('priv.sudo', text);
      // xargs runs its arguments as a command
      if (verb === 'xargs' && depth < 2) {
        const first = args.findIndex((a, i) => !isFlag(a) && !/^-[IiLnPsEd]$/.test(args[i - 1] ?? ''));
        if (first !== -1) for (const f of matchShell(args.slice(first).join(' '), depth + 1)) add(f.ruleId, text, f.severity);
      }
      // sh -c "<command>": the quoted argument is itself a command
      if (SHELLS.has(verb) && depth < 2) {
        const c = args.indexOf('-c');
        if (c !== -1 && args[c + 1]) {
          for (const f of matchShell(args[c + 1], depth + 1)) add(f.ruleId, f.evidence, f.severity);
          if (/^\s*\$\(\s*(?:curl|wget)\b/.test(args[c + 1])) add('exec.pipe-to-shell', text);
        }
      }
      if (verb === 'su' && args.some((a) => a === '-' || a === '-l' || a === '--login')) add('priv.sudo', text);

      if (verb === 'rm') {
        const sev = rmMatch(args);
        if (sev) add('fs.destructive-delete', text, sev);
      }

      if (verb === 'git') {
        const { sub, rest } = gitSub(args);
        if (sub === 'push') {
          const lease = rest.some((a) => a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes'));
          const force = rest.some((a) => a === '--force' || shortHas(a, 'f') || /^\+[A-Za-z0-9_./-]/.test(a));
          if (force) add('git.force-push', text, 'high');
          else if (lease) add('git.force-push', text, 'medium');
          if (rest.includes('--no-verify')) add('git.no-verify', text);
        }
        if (sub === 'commit' && (rest.includes('--no-verify') || rest.includes('-n'))) add('git.no-verify', text);
        if (
          (sub === 'reset' && rest.includes('--hard')) ||
          (sub === 'clean' && rest.some((a) => a === '--force' || shortHas(a, 'f'))) ||
          sub === 'filter-branch' ||
          sub === 'filter-repo' ||
          (sub === 'reflog' && rest[0] === 'expire') ||
          (sub === 'checkout' && (rest.join(' ') === '.' || rest.join(' ').endsWith('-- .')))
        ) {
          add('git.history-rewrite', text);
        }
      }

      if (DOWNLOADERS.has(verb)) downloaderSeen = true;
      else if (downloaderSeen && index > 0) {
        const scriptArg = args.find((a) => !isFlag(a));
        if (SHELLS.has(verb) || (INTERPRETERS.has(verb) && (scriptArg === undefined || scriptArg === '-'))) add('exec.pipe-to-shell', pipeline.text);
      }

      if (verb === 'chmod') {
        const recursive = args.some((a) => a === '--recursive' || shortHas(a, 'R'));
        if (args.some((a) => /^0?777$/.test(a)) || (recursive && args.some((a) => /^(?:a|o|ugo)?\+[rx]*w/.test(a)))) add('priv.chmod-open', text);
      }

      // `printenv > file` still dumps everything: redirections are not arguments
      const plain = args.filter((a, i) => !/^\d?>>?/.test(a) && !/^\d?>>?$/.test(args[i - 1] ?? ''));
      if (verb === 'printenv' && plain.length === 0) add('secret.env-dump', text);
      if (stage.words[0] === 'env' && stage.words.slice(1).every((a, i, rest) => /^\d?>>?/.test(a) || /^\d?>>?$/.test(rest[i - 1] ?? ''))) add('secret.env-dump', text);
      if (verb === 'export' && args.length === 1 && args[0] === '-p') add('secret.env-dump', text);

      if (verb === 'security' && args.some((a) => a === 'find-generic-password' || a === 'find-internet-password' || a === 'dump-keychain')) {
        add('secret.credential-read', text);
      }
      if ((READERS.has(verb) || /<\s*\S/.test(stage.bare ?? text)) && isCredentialPath(stage.bare ?? text)) add('secret.credential-read', text);

      if (verb === 'curl') {
        if (args.some((a) => a === '--insecure' || shortHas(a, 'k'))) add('net.tls-off', text);
        if (!LOCAL_HOST.test(text)) {
          const uploads = args.some((a, i) => {
            const value = /^(?:-d|--data|--data-binary|--data-raw|--data-urlencode|-F|--form)$/.test(a) ? unquote(args[i + 1] ?? '') : /^--(?:data|data-binary|form)=/.test(a) ? unquote(a.slice(a.indexOf('=') + 1)) : '';
            return value.startsWith('@') || value.startsWith('$(') || value.startsWith('`') || /^[A-Za-z0-9_]+=@/.test(value) || /^[A-Za-z0-9_]+=<[^<]/.test(value);
          });
          if (uploads || args.some((a) => a === '-T' || a === '--upload-file')) add('net.exfil', pipeline.text);
        }
      }
      if (verb === 'wget' && !LOCAL_HOST.test(text) && args.some((a) => /^--(?:post|body)-file\b/.test(a))) add('net.exfil', pipeline.text);
      if ((verb === 'http' || verb === 'https') && !LOCAL_HOST.test(text) && args.some((a) => /^[A-Za-z0-9_-]+@./.test(a) || a === '<')) add('net.exfil', pipeline.text);
      if ((verb === 'nc' || verb === 'ncat' || verb === 'netcat') && index > 0 && !/\b(?:localhost|127\.0\.0\.1)\b/.test(text)) add('net.exfil', pipeline.text);
    });

    const text = pipeline.text;
    const bare = pipeline.bare ?? text;
    if (/\b(?:ba|z|da|k)?sh\s+(?:<\(|\$\()\s*(?:curl|wget)\b/.test(bare)) add('exec.pipe-to-shell', text);
    for (const re of TLS_OFF) if (re.test(bare)) add('net.tls-off', text);
    for (const { re, severity } of INFRA) if (re.test(bare)) add('infra.destroy', text, severity);
    for (const re of PUBLISH) if (re.test(bare)) add('pkg.publish', text);
  }

  if (DB_CLIENT.test(sql)) {
    for (const re of DB_DESTRUCTIVE) {
      const m = re.exec(sql);
      if (m) add('db.destructive', sql.slice(Math.max(0, m.index - 120), m.index + 200));
    }
  }
  return [...found.values()];
}

const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/', '/var/tmp/', tmpdir().replace(/\/?$/, '/')];

/** A file tool wrote to an absolute path outside the project, temp directories and the Claude home's own work areas. */
export function matchWrite(rawPath: string, ctx: RuleContext): Finding[] {
  if (!rawPath.startsWith('/') || !ctx.cwd) return [];
  // /project/../etc/passwd is not inside the project
  const path = posix.normalize(rawPath.length > 4096 ? rawPath.slice(0, 4096) : rawPath);
  const under = (root: string) => path === root || path.startsWith(root.replace(/\/?$/, '/'));
  if (under(ctx.cwd)) return [];
  // Inside the Claude home only the plan and per-project work areas are expected; settings are not.
  const inHome = under(ctx.claudeHome);
  if (inHome && (under(`${ctx.claudeHome}/plans`) || under(`${ctx.claudeHome}/projects`))) return [];
  if (!inHome && TEMP_ROOTS.some((r) => path.startsWith(r))) return [];
  return [{ ruleId: 'fs.write-outside-project', severity: 'medium', evidence: rawPath.slice(0, 8000) }];
}

export function matchRead(path: string): Finding[] {
  return isCredentialPath(path) ? [{ ruleId: 'secret.credential-read', severity: 'high', evidence: path.slice(0, 8000) }] : [];
}
