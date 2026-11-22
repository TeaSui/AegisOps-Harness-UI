// One session, read as a recorder tape: prompts, replies and tool calls in order, each tool call
// paired with its result, and every row pointing at the transcript line it came from.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, onPush, qs, useApi } from '../api';
import { LineChart } from '../charts';
import { allowedBy, clock, compact, duration, fullTime, int, modelName, money, percent, shortPath, when } from '../format';
import { Empty, Icon, Link, Mark, Outcome, Pill, Problem, Severity, Source, copyText, setQuery, useToast } from '../ui';

const PAGE = 1000;
const MAX_ITEMS = 12_000;

type Item = Record<string, any> & { kind: string; ts: number; file: number; line: number };

function useTimeline(id: string, agent: string | null) {
  const [state, setState] = useState<{ key: string; items: Item[]; total: number; file: number | null; error: string | null; loading: boolean }>({ key: '', items: [], total: 0, file: null, error: null, loading: true });
  const key = `${id}|${agent ?? ''}`;
  const run = useRef(0);
  const load = useCallback(
    async (from: number, keep: Item[]) => {
      const mine = ++run.current;
      let items = keep;
      let offset = from;
      try {
        for (;;) {
          const page = await get<any>(`/api/sessions/${encodeURIComponent(id)}/timeline${qs({ agent, offset, limit: PAGE })}`);
          if (mine !== run.current) return;
          items = [...items.slice(0, offset), ...page.items];
          setState({ key, items, total: page.total, file: page.file, error: null, loading: items.length < Math.min(page.total, MAX_ITEMS) });
          offset = items.length;
          if (page.items.length === 0 || offset >= page.total || offset >= MAX_ITEMS) break;
        }
      } catch (e) {
        if (mine === run.current) setState((s) => ({ ...s, key, error: (e as Error).message, loading: false }));
      }
    },
    [id, agent, key],
  );
  useEffect(() => {
    setState({ key, items: [], total: 0, file: null, error: null, loading: true });
    void load(0, []);
  }, [key, load]);
  // When this session grows, re-read its tail: new rows arrive and a pending tool call gets its result.
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = state.key === key ? state.items : [];
  useEffect(() => {
    let timer: number | undefined;
    const off = onPush((event, data) => {
      if (event !== 'open' && !(event === 'index' && (data.sessions ?? []).includes(id))) return;
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        const have = itemsRef.current;
        void load(Math.max(0, have.length - 60), have);
      }, 500);
    });
    return () => {
      off();
      if (timer) window.clearTimeout(timer);
    };
  }, [id, load]);
  return state.key === key ? state : { key, items: [], total: 0, file: null, error: null, loading: true };
}

/** A slash command is recorded as tags; show it the way it was typed. */
function promptText(item: Item): string {
  if (item.origin !== 'command') return item.text;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(item.text)?.[1]?.trim();
  if (!name) return item.text;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(item.text)?.[1]?.trim() ?? '';
  return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`;
}

const ORIGIN: Record<string, string> = {
  human: 'You',
  sdk: 'Prompt from the SDK',
  command: 'Slash command',
  peer: 'Message from another session',
  'task-notification': 'Background task reported back',
  local: 'Local command output',
  system: 'System message',
};

function Expandable({ text, truncated, file, line, mono }: { text: string; truncated?: boolean; file: number; line: number; mono?: boolean }) {
  const long = text.length > 700 || text.split('\n').length > 8;
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className={`prose ${mono ? 'mono' : ''} ${long && !open ? 'clamp' : ''}`}>{text}</div>
      {long || truncated ? (
        <div className="notice">
          {long ? <button className="linkish" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show all'}</button> : null}
          {truncated ? <span className="muted">Cut at 4,000 characters. The whole text is in the <Source file={file} line={line} />.</span> : null}
        </div>
      ) : null}
    </div>
  );
}

const Row = memo(function Row({ item, showTime, findings, sessionId }: { item: Item; showTime: boolean; findings: any[] | undefined; sessionId: string }) {
  const [open, setOpen] = useState(false);
  let cls = item.kind;
  let body: React.ReactNode = null;
  switch (item.kind) {
    case 'prompt': {
      const human = item.origin === 'human' || item.origin === 'sdk' || item.origin === 'command';
      if (human) {
        body = (
          <div className="bubble">
            <div className="who"><b>{ORIGIN[item.origin] ?? item.origin}</b><span>{fullTime(item.ts)}</span><span style={{ flex: 1 }} /><Source file={item.file} line={item.line} /></div>
            <Expandable text={promptText(item)} truncated={item.truncated} file={item.file} line={item.line} mono={item.origin === 'command'} />
          </div>
        );
      } else {
        cls = 'aside';
        body = (
          <div>
            <div className="notice">
              <button className="linkish" onClick={() => setOpen(!open)}>{ORIGIN[item.origin] ?? item.origin}</button>
              {!open ? <span className="muted clip" style={{ maxWidth: '60ch' }}>{item.text.replace(/\s+/g, ' ').slice(0, 140)}</span> : null}
            </div>
            {open ? <div className="detail"><pre className="code">{item.text}</pre></div> : null}
          </div>
        );
      }
      break;
    }
    case 'reply':
      body = (
        <div className="reply">
          <Expandable text={item.text} truncated={item.truncated} file={item.file} line={item.line} />
        </div>
      );
      break;
    case 'thinking':
      cls = 'aside';
      body = (
        <div>
          <div className="notice"><button className="linkish" onClick={() => setOpen(!open)}>Thinking</button>{!open ? <span className="muted clip" style={{ maxWidth: '60ch' }}>{item.text.replace(/\s+/g, ' ').slice(0, 120)}</span> : null}</div>
          {open ? <div className="detail"><pre className="code">{item.text}</pre></div> : null}
        </div>
      );
      break;
    case 'tool': {
      cls = `tool ${item.status}${findings?.length ? ' flagged' : ''}`;
      const by = item.allowedBy;
      const how = by ? allowedBy(by.decision, by.source, by.reason) : 'not recorded';
      body = (
        <div>
          <button className="toolrow" onClick={() => setOpen(!open)} aria-expanded={open}>
            <span className="name">{item.mcpServer ? item.name.slice(item.name.lastIndexOf('__') + 2) : item.name}</span>
            {item.mcpServer ? <span className="tag">{item.mcpServer}</span> : null}
            <span className="target mono clip">{item.target.replace(/\s+/g, ' ')}</span>
            <span className="meta">
              {(findings ?? []).map((f) => <Severity key={f.id} level={f.severity} />)}
              {item.status !== 'ok' ? <Outcome status={item.status} /> : null}
              <span className="num">{item.durationMs !== null ? duration(item.durationMs) : ''}</span>
            </span>
          </button>
          {open ? (
            <div className="detail">
              <div className="bar">
                <Outcome status={item.status} />
                <span title={by ? `${by.decision} · ${by.source} · ${by.reason}` : 'The transcript has no permission record for this call'}>
                  {item.status === 'denied' ? 'Denied' : 'Allowed'} by: <b>{how}</b>
                </span>
                {item.denialKind ? <span className="tag">{item.denialKind}</span> : null}
                {item.skill ? <span className="tag" title="The skill that was active">{item.skill}</span> : null}
                <span className="spacer" />
                {item.subagent ? <Link to={`/sessions/${encodeURIComponent(sessionId)}${qs({ agent: item.subagent })}`}>Open the subagent's tape</Link> : null}
                <span>call <Source file={item.file} line={item.line} /></span>
                {item.result ? <span>result <Source file={item.file} line={item.result.line} /></span> : null}
              </div>
              {(findings ?? []).map((f) => (
                <div className="bar" key={f.id}>
                  <Severity level={f.severity} />
                  <b>{f.title}</b>
                  <span className="mono clip" style={{ maxWidth: '50ch' }}>{f.evidence}</span>
                  <span className="spacer" />
                  <Link to={`/audit${qs({ session: sessionId })}`}>{f.state === 'open' ? 'Review in Audit' : 'Acknowledged'}</Link>
                </div>
              ))}
              <h4>{item.category === 'exec' ? 'Command' : 'Input'}</h4>
              <pre className="code">{item.category === 'exec' ? item.target : item.input}{item.inputTruncated || (item.category === 'exec' && item.target.length >= 4000) ? '\n… cut; open the call line for all of it' : ''}</pre>
              {item.result ? (
                <>
                  <h4>Result{item.result.truncated ? ' (cut at 4,000 characters)' : ''}</h4>
                  <pre className="code">{item.result.text || '(empty)'}</pre>
                </>
              ) : (
                <h4 style={{ paddingBottom: 10 }}>No result was recorded: the tool is still running, is waiting for approval, or the session ended first.</h4>
              )}
            </div>
          ) : null}
        </div>
      );
      break;
    }
    case 'compaction':
      cls = 'event';
      body = (
        <div className="notice rule">
          <Mark tone="info">Context compacted{item.trigger ? ` (${item.trigger})` : ''}</Mark>
          <span className="num">{compact(item.preTokens)} to {compact(item.postTokens)} tokens{item.freed !== null ? `, freed ${compact(item.freed)}` : ''}</span>
          <Source file={item.file} line={item.line} />
        </div>
      );
      break;
    case 'hook': {
      cls = item.status === 'success' ? 'event' : item.status === 'blocked' ? 'denied' : 'error';
      const tone = item.status === 'success' ? 'good' : item.status === 'blocked' ? 'serious' : 'critical';
      body = (
        <div>
          <div className="notice one">
            <Mark tone={tone}>{item.event} hook {item.status === 'success' ? 'ran' : item.status === 'blocked' ? 'blocked the session' : 'failed'}</Mark>
            <span className="mono clip" style={{ maxWidth: '56ch' }}>{item.command}</span>
            {item.durationMs !== null ? <span className="num muted">{duration(item.durationMs)}</span> : null}
            {item.detail ? <button className="linkish" onClick={() => setOpen(!open)}>{open ? 'Hide output' : 'Output'}</button> : null}
            <Source file={item.file} line={item.line} />
          </div>
          {open ? <div className="detail"><pre className="code">{item.detail}</pre></div> : null}
        </div>
      );
      break;
    }
    case 'stop_hooks':
      if (!item.errors && !item.prevented) return null;
      cls = 'error';
      body = (
        <div className="notice">
          <Mark tone={item.prevented ? 'serious' : 'critical'}>{item.prevented ? 'A stop hook kept the session going' : `${item.errors} of ${item.hooks.length} stop hooks failed`}</Mark>
          <Source file={item.file} line={item.line} />
        </div>
      );
      break;
    case 'api_error':
      body = (
        <div className="notice one">
          <Mark tone="critical">API error {item.status}{item.error ? `: ${item.error.replace(/_/g, ' ')}` : ''}</Mark>
          <span className="muted clip" style={{ maxWidth: '60ch' }}>{item.text}</span>
          <Source file={item.file} line={item.line} />
        </div>
      );
      break;
    case 'permission_mode':
      cls = 'event';
      body = (
        <div className="notice">
          <Mark tone={item.mode === 'bypassPermissions' ? 'critical' : 'idle'} icon="info">Permission mode: {item.mode}</Mark>
          {item.from ? <span className="muted">was {item.from}</span> : null}
        </div>
      );
      break;
    case 'turn':
      cls = 'event';
      body = <div className="notice muted">Turn finished{item.durationMs !== null ? ` after ${duration(item.durationMs)}` : ''}</div>;
      break;
    case 'command':
      cls = 'event';
      body = <div className="notice"><span className="tag mono">/{item.name}</span><span className="muted">{item.args}</span></div>;
      break;
    default:
      return null;
  }
  return (
    <div className={`row ${cls}`}>
      <div className="time" title={fullTime(item.ts)}>{showTime ? clock(item.ts) : ''}</div>
      <div className="lane"><i /></div>
      <div className="body">{body}</div>
    </div>
  );
});

const FILTERS: Array<[string, string, (i: Item, flagged: boolean) => boolean]> = [
  ['all', 'Everything', () => true],
  ['talk', 'Conversation', (i) => i.kind === 'reply' || (i.kind === 'prompt' && (i.origin === 'human' || i.origin === 'sdk' || i.origin === 'command'))],
  ['tools', 'Tool calls', (i) => i.kind === 'tool'],
  ['problems', 'Problems', (i, flagged) => flagged || i.kind === 'api_error' || (i.kind === 'tool' && (i.status === 'error' || i.status === 'denied')) || (i.kind === 'hook' && i.status !== 'success') || (i.kind === 'stop_hooks' && (i.errors > 0 || i.prevented))],
];

export function Session({ id, query }: { id: string; query: URLSearchParams }) {
  const agent = query.get('agent');
  const show = query.get('show') ?? 'all';
  const session = useApi<any>(`/api/sessions/${encodeURIComponent(id)}`, (ids) => ids.includes(id));
  const timeline = useTimeline(id, agent);
  const context = useApi<any>(`/api/sessions/${encodeURIComponent(id)}/context${qs({ agent })}`, (ids) => ids.includes(id));
  const files = useApi<any>(`/api/sessions/${encodeURIComponent(id)}/files`, (ids) => ids.includes(id));
  const found = useApi<any>(`/api/audit/findings${qs({ session: id, limit: 1000 })}`, (ids) => ids.includes(id));
  const toast = useToast();
  const [text, setText] = useState('');
  const s = session.data;

  const byTool = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const f of found.data?.items ?? []) if (f.toolCall) m.set(f.toolCall, [...(m.get(f.toolCall) ?? []), f]);
    return m;
  }, [found.data]);
  const visible = useMemo(() => {
    const test = (FILTERS.find((f) => f[0] === show) ?? FILTERS[0])[2];
    const needle = text.trim().toLowerCase();
    return timeline.items.filter((i) => {
      if (!test(i, i.kind === 'tool' && byTool.has(i.id))) return false;
      if (!needle) return true;
      return `${i.text ?? ''} ${i.target ?? ''} ${i.name ?? ''} ${i.command ?? ''}`.toLowerCase().includes(needle);
    });
  }, [timeline.items, show, text, byTool]);

  const points = useMemo(() => (context.data?.calls ?? []).map((c: any, i: number) => ({
    x: i,
    y: c.context,
    label: `Response ${i + 1}, ${clock(c.ts)}`,
    lines: [['Context', `${int(c.context)} tokens`], ['From cache', int(c.cacheRead)], ['Output', int(c.output)], ['Cost', money(c.cost)], ['Model', modelName(c.model)]] as Array<[string, string]>,
  })), [context.data]);
  const markers = useMemo(() => {
    const calls = context.data?.calls ?? [];
    return (context.data?.compactions ?? []).map((k: any) => {
      const idx = calls.findIndex((c: any) => c.ts >= k.ts);
      return { x: idx === -1 ? Math.max(0, calls.length - 1) : idx, label: k.freed !== null ? `−${compact(k.freed)}` : 'compacted', detail: '' };
    });
  }, [context.data]);

  if (session.error && !s) {
    return (
      <div className="page">
        <Problem error={session.error === 'Not found' ? 'There is no session with this id in the index.' : session.error} />
        <Link to="/sessions">Back to all sessions</Link>
      </div>
    );
  }
  const agents: any[] = s?.agents ?? [];
  const current = agents.find((a) => (agent ? a.agentId === agent : a.agentId === null)) ?? agents[0];
  const peak = Math.max(0, ...(context.data?.calls ?? []).map((c: any) => c.context));
  const cacheShare = s ? (s.usage.input + s.usage.cacheRead + s.usage.cacheWrite5m + s.usage.cacheWrite1h > 0 ? s.usage.cacheRead / (s.usage.input + s.usage.cacheRead + s.usage.cacheWrite5m + s.usage.cacheWrite1h) : null) : null;
  let lastClock = '';
  return (
    <div className="page">
      <div className="page-head">
        <div style={{ minWidth: 0, flex: '1 1 480px' }}>
          <div className="muted" style={{ marginBottom: 4 }}><Link to="/sessions">Sessions</Link> / {s ? shortPath(s.cwd) || s.project : ''}</div>
          <h1 style={{ overflowWrap: 'anywhere' }}>{s?.title ?? 'Loading the session'}</h1>
          {s ? (
            <p className="lede">
              {s.live ? <Pill tone="info" icon={null}>running</Pill> : null} {when(s.firstTs)} to {when(s.lastTs)}, {duration(s.durationMs)}
              {s.gitBranch ? `, branch ${s.gitBranch}` : ''}{s.entrypoint ? `, started from ${s.entrypoint}` : ''}
            </p>
          ) : null}
        </div>
        {s?.resumeCommand ? (
          <button className="btn" title="Interactive work stays in the terminal" onClick={() => copyText(s.resumeCommand, toast, 'Resume command copied')}>
            <Icon name="copy" size={15} />Copy resume command
          </button>
        ) : null}
      </div>
      {s?.sourceRemoved ? <div className="banner warn"><Mark tone="warn">A transcript of this session is no longer on disk. The figures remain; its tape and raw records cannot be read.</Mark></div> : null}
      {s && !s.hasMain ? <div className="banner info"><Mark tone="info">This session has subagent transcripts but no main transcript.</Mark></div> : null}

      {s ? (
        <dl className="stats">
          <div className="stat">
            <dt>Cost</dt>
            <dd className="num">{money(s.cost.estimated)}</dd>
            <small title={s.cost.reportedBasis}>
              {s.cost.reported !== null ? `harness reported ${money(s.cost.reported)} over ${s.cost.reportedRuns} run${s.cost.reportedRuns === 1 ? '' : 's'}` : s.cost.basis}
              {s.cost.unpricedCalls ? `, ${s.cost.unpricedCalls} unpriced` : ''}
            </small>
          </div>
          <div className="stat">
            <dt>Responses</dt>
            <dd className="num">{int(s.apiCalls)}</dd>
            <small>{compact(s.usage.output)} tokens out, {percent(cacheShare)} of input from cache</small>
          </div>
          <div className="stat">
            <dt>Tool calls</dt>
            <dd className="num">{int(s.toolCalls)}</dd>
            <small>{s.toolErrors} failed, {s.toolDenied} denied</small>
          </div>
          <div className="stat">
            <dt>Peak context</dt>
            <dd className="num">{compact(peak)}</dd>
            <small>{s.compactions} compaction{s.compactions === 1 ? '' : 's'}</small>
          </div>
          <div className="stat">
            <dt>Risk</dt>
            <dd style={{ fontSize: 15, paddingTop: 5 }}>{s.risk ? <Severity level={s.risk} /> : <Mark tone="good">no findings</Mark>}</dd>
            <small>{s.findings ? <Link to={`/audit${qs({ session: id })}`}>{s.openFindings} open of {s.findings}</Link> : 'nothing matched a risk rule'}</small>
          </div>
        </dl>
      ) : null}

      <div className="session-grid section">
        <div style={{ minWidth: 0 }}>
          <div className="filters">
            <div className="seg">
              {FILTERS.map(([key, label]) => (
                <button key={key} aria-pressed={show === key} onClick={() => setQuery({ show: key === 'all' ? null : key })}>{label}</button>
              ))}
            </div>
            <input data-filter className="field grow" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter this tape   /" aria-label="Filter the tape" />
            {agents.length > 1 ? (
              <select className="field" value={agent ?? ''} onChange={(e) => setQuery({ agent: e.target.value || null })} aria-label="Agent">
                {agents.map((a) => (
                  <option key={a.file} value={a.agentId ?? ''}>{a.agentId === null ? 'Main thread' : `${a.agentType} ${a.agentId.slice(0, 7)}`}</option>
                ))}
              </select>
            ) : null}
          </div>
          <Problem error={timeline.error} />
          {agent && current ? <div className="banner info"><Mark tone="info">Tape of the {current.agentType} subagent.</Mark><span style={{ flex: 1 }} /><button className="linkish" onClick={() => setQuery({ agent: null })}>Back to the main thread</button></div> : null}
          <div className="tape">
            {visible.map((item) => {
              const c = clock(item.ts);
              const showTime = c !== lastClock;
              lastClock = c;
              return <Row key={item.seq} item={item} showTime={showTime} findings={item.kind === 'tool' ? byTool.get(item.id) : undefined} sessionId={id} />;
            })}
          </div>
          {timeline.loading ? (
            <div className="tape-end">Reading the transcript… {int(timeline.items.length)} of {int(timeline.total)} rows</div>
          ) : visible.length === 0 ? (
            <Empty title={timeline.items.length ? 'Nothing on this tape matches the filter' : 'This transcript has no conversation yet'} />
          ) : (
            <div className="tape-end">
              {int(visible.length)} of {int(timeline.total)} rows{timeline.total > timeline.items.length ? `. The first ${int(timeline.items.length)} are loaded.` : '.'}{s?.live ? ' New rows appear as the session writes them.' : ''}
            </div>
          )}
        </div>

        <aside className="side">
          <div className="panel pad">
            <h3 style={{ marginBottom: 8 }}>Context size per response</h3>
            {points.length ? <LineChart points={points} markers={markers} format={compact} height={150} /> : <span className="muted">No response recorded{agent ? ' for this agent' : ''}.</span>}
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Input, cache read and cache write tokens of each response. A vertical line is a compaction and what it freed.</p>
          </div>
          {s ? (
            <div className="panel pad">
              <h3 style={{ marginBottom: 8 }}>Details</h3>
              <dl className="kv">
                <dt>Folder</dt><dd className="mono">{s.cwd ?? '—'}</dd>
                <dt>Models</dt><dd>{s.models.map(modelName).join(', ') || '—'}</dd>
                <dt>Permission mode</dt><dd>{s.permissionMode ?? '—'}</dd>
                <dt>Harness</dt><dd>{s.version ?? '—'}</dd>
                <dt>Tokens in</dt><dd className="num">{int(s.usage.input)} new, {int(s.usage.cacheRead)} cached</dd>
                <dt>Cache writes</dt><dd className="num">{int(s.usage.cacheWrite5m)} 5 min, {int(s.usage.cacheWrite1h)} 1 h</dd>
                <dt>Session id</dt><dd className="mono">{s.id}</dd>
                {s.links.map((l: any) => (<><dt key={`t${l.url}`}>Pull request</dt><dd key={l.url}><a href={/^https?:\/\//.test(l.url) ? l.url : undefined} target="_blank" rel="noopener noreferrer">{l.label || l.url}</a></dd></>))}
              </dl>
            </div>
          ) : null}
          {agents.length > 1 ? (
            <div className="panel">
              <div className="pad" style={{ padding: '12px 16px 4px' }}><h3>Agents</h3></div>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {agents.map((a) => (
                      <tr key={a.file} data-row onClick={() => setQuery({ agent: a.agentId })} className={(a.agentId ?? null) === (agent ?? null) ? 'row-active' : ''}>
                        <td><div className="cell-main">{a.agentId === null ? 'Main thread' : a.agentType}</div><div className="cell-sub">{a.apiCalls} responses, {a.toolCalls} tool calls</div></td>
                        <td className="r">{money(a.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          {files.data?.items.length ? (
            <div className="panel">
              <div style={{ padding: '12px 16px 4px' }}><h3>Files touched</h3></div>
              <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>File</th><th className="r">Read</th><th className="r">Edit</th><th className="r">Write</th></tr></thead>
                  <tbody>
                    {files.data.items.map((f: any) => (
                      <tr key={f.path}>
                        <td className="mono" style={{ overflowWrap: 'anywhere' }} title={f.path}>{s?.cwd && f.path.startsWith(s.cwd + '/') ? f.path.slice(s.cwd.length + 1) : f.path}</td>
                        <td className="r">{f.read || ''}</td><td className="r">{f.edit || ''}</td><td className="r">{f.write || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
