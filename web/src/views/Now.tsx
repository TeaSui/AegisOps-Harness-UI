// Now: the harness drawn as a machine with its real traffic, what needs the operator beside it,
// then every running session on a board.
import { useEffect, useMemo, useState } from 'react';
import type { Loaded } from '../api';
import { useApi, qs } from '../api';
import { ago, compact, duration, int, modelName, money, percent, REASONS, shortPath, when } from '../format';
import { CATEGORY, CATEGORY_ORDER, flow, machine } from '../machine';
import { Chips, Stage, type StageEdge, type StageTone, type Tile } from '../stage';
import { Empty, Link, Mark, Pill, Problem, Severity, navigate, setQuery } from '../ui';

const SPANS: Array<[string, string, number]> = [
  ['day', '24 hours', 86_400_000],
  ['week', '7 days', 7 * 86_400_000],
  ['month', '30 days', 30 * 86_400_000],
];

const plural = (n: number, one: string, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;
const toolName = (name: string) => (name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2) : name);

function Machine({ map, live }: { map: any; live: any }) {
  const sessions: any[] = live?.sessions ?? [];
  const attention: any[] = live?.attention ?? [];
  const built = useMemo(() => {
    const toolCalls = map.tools.reduce((n: number, t: any) => n + t.calls, 0);
    const tiles: Tile[] = sessions.map((s) => (s.attention.length ? 'alert' : s.status === 'busy' ? 'busy' : 'idle'));
    const stopped = map.gate.hookFailures + map.gate.hookBlocks;
    const stoppedShare = map.gate.hookRuns ? stopped / map.gate.hookRuns : 0;
    const used = CATEGORY_ORDER.map((c) => map.tools.find((t: any) => t.category === c)).filter(Boolean);
    const models = map.models.slice(0, 2);
    const rest = map.models.length - models.length;
    const { nodes, size, narrowSize } = machine({
      you: { title: 'You', to: '/sessions' },
      harness: {
        title: 'Claude Code',
        sub: sessions.length ? `${int(sessions.length)} running now, ${plural(map.sessions, 'session')} in this span` : `${plural(map.sessions, 'session')} in this span, none running`,
        to: sessions.length ? '/sessions?live=1' : '/sessions',
        tiles,
        badge: attention.length ? { tone: 'critical', text: `${attention.length} need${attention.length === 1 ? 's' : ''} you` } : undefined,
        alert: attention.length ? 'critical' : undefined,
      },
      models: models.length
        ? models.map((m: any, i: number) => ({
            title: m.model ? modelName(m.model) : 'Unnamed model',
            sub: `${compact(m.calls)} responses, ${m.unpriced === m.calls ? 'no price' : money(m.cost)}`,
            to: '/cost',
            badge: i === 0 && map.api.errors ? { tone: (map.api.rateLimits ? 'critical' : 'warn') as StageTone, text: map.api.rateLimits ? `${plural(map.api.rateLimits, 'rate limit')}` : `${plural(map.api.errors, 'API error')}` } : undefined,
            alert: i === 0 && map.api.rateLimits ? ('critical' as StageTone) : undefined,
          }))
        : [{ title: 'Model', sub: 'no response yet', dim: true, to: '/cost' }],
      gate: {
        title: 'Permissions and hooks',
        sub: `${plural(map.gate.hookRuns, 'hook run')}, ${int(map.gate.denied)} denied`,
        to: '/ops/hooks',
        badge: stopped ? { tone: stoppedShare >= 0.2 ? 'critical' : 'warn', text: `${plural(stopped, 'hook failure')}` } : undefined,
        alert: stopped && stoppedShare >= 0.2 ? 'critical' : undefined,
      },
      targets: used.map((t: any) => {
        const bad = t.errors > 0 && t.errorRate >= 0.05;
        const servers = t.category === 'mcp' ? map.servers.length : 0;
        return {
          category: t.category,
          title: CATEGORY[t.category].title,
          sub: t.category === 'mcp' ? `${plural(servers, 'server')}, ${compact(t.calls)} calls` : t.category === 'agent' ? `${plural(map.subagents.spawned, 'run')}, ${money(map.subagents.cost)}` : `${compact(t.calls)} calls`,
          to: t.category === 'agent' ? '/cost?group=agent' : '/ops/tools',
          dim: t.calls === 0,
          badge: bad ? { tone: (t.errorRate >= 0.2 ? 'critical' : 'warn') as StageTone, text: `${percent(t.errorRate)} failed` } : undefined,
          alert: bad && t.errorRate >= 0.2 ? ('critical' as StageTone) : undefined,
        };
      }),
    });
    const edges: StageEdge[] = [
      { id: 'ask', from: 'you', to: 'harness', kind: 'request', label: plural(map.prompts, 'prompt'), packets: flow(map.prompts), dim: map.prompts === 0, lane: 8 },
      { id: 'answer', from: 'harness', to: 'you', kind: 'response', packets: flow(map.prompts), dim: map.prompts === 0, lane: 8 },
      { id: 'call', from: 'harness', to: 'gate', kind: 'request', label: `${compact(toolCalls)} tool calls`, packets: flow(toolCalls), dim: toolCalls === 0, lane: 8 },
      { id: 'result', from: 'gate', to: 'harness', kind: 'response', packets: flow(toolCalls), dim: toolCalls === 0, lane: 8 },
    ];
    models.forEach((m: any, i: number) => {
      edges.push({ id: `req:${i}`, from: 'harness', to: `model:${i}`, kind: 'request', label: i === 0 ? `${compact(map.api.calls)} requests${rest > 0 ? ` to ${map.models.length} models` : ''}` : undefined, packets: flow(m.calls), lane: 8 });
      edges.push({ id: `res:${i}`, from: `model:${i}`, to: 'harness', kind: 'response', packets: flow(m.calls), lane: 8 });
    });
    for (const t of used as any[]) edges.push({ id: `t:${t.category}`, from: 'gate', to: `t:${t.category}`, kind: t.errorRate >= 0.2 ? 'blocked' : 'request', packets: flow(t.calls), dim: t.calls === 0, wideOnly: true });
    return { nodes, edges, size, narrowSize };
  }, [map, sessions, attention.length]);
  return <Stage nodes={built.nodes} edges={built.edges} size={built.size} narrowSize={built.narrowSize} label="The harness and its traffic. Each part opens the view behind it." legend />;
}

function SessionCard({ s, now }: { s: any; now: number }) {
  return (
    <Link className="card" to={`/sessions/${encodeURIComponent(s.id)}`}>
      <span data-row className="title clip">{s.title}</span>
      <span className="line">
        <span className="clip" title={s.cwd}>{shortPath(s.cwd)}{s.gitBranch ? ` on ${s.gitBranch}` : ''}</span>
        <span className="num">{money(s.cost)}</span>
      </span>
      <span className="line">
        {s.lastTool ? (
          <span className="clip"><b>{toolName(s.lastTool.name)}</b> <span className="mono">{s.lastTool.target}</span></span>
        ) : (
          <span className="muted">No tool call yet</span>
        )}
      </span>
      <span className="line">
        <span className="clip">{modelName(s.currentModel)}{s.contextTokens !== null ? `, ${compact(s.contextTokens)} context` : ''}</span>
        <span className="num" title={`${s.status} since ${new Date(s.statusSince).toLocaleString()}`}>{s.status} {ago(s.statusSince, now)}</span>
      </span>
      {s.attention.length ? (
        <span className="line">{s.attention.map((r: string) => <Pill key={r} tone={REASONS[r]?.tone ?? 'warn'}>{REASONS[r]?.label ?? r}</Pill>)}</span>
      ) : s.risk ? (
        <span className="line"><Severity level={s.risk} /></span>
      ) : null}
    </Link>
  );
}

export function Now({ live, overview, query }: { live: Loaded<any>; overview: any; query: URLSearchParams }) {
  const span = SPANS.find((s) => s[0] === query.get('span')) ?? SPANS[0];
  // the span's start moves in five-minute steps: a push re-reads the same question, and a tab left open stays honest
  const [tick, setTick] = useState(() => Math.floor(Date.now() / 300_000));
  useEffect(() => {
    const t = window.setInterval(() => setTick(Math.floor(Date.now() / 300_000)), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const from = tick * 300_000 - span[2];
  const map = useApi<any>(`/api/map${qs({ from })}`, 'all');
  const recent = useApi<any>('/api/sessions?limit=8', 'all');
  const data = live.data;
  const attention: any[] = data?.attention ?? [];
  const sessions: any[] = data?.sessions ?? [];
  const now = data?.at ?? Date.now();
  const lanes = [
    { key: 'needs', title: 'Needs you', hot: true, none: 'No running session is waiting on you.', items: sessions.filter((s) => s.attention.length) },
    { key: 'busy', title: 'Working', hot: false, none: 'Nothing is working right now.', items: sessions.filter((s) => !s.attention.length && s.status === 'busy') },
    { key: 'idle', title: 'Idle', hot: false, none: 'No session is sitting idle.', items: sessions.filter((s) => !s.attention.length && s.status !== 'busy') },
  ];
  const m = map.data;
  const toolCalls = m ? m.tools.reduce((n: number, t: any) => n + t.calls, 0) : 0;
  const toolErrors = m ? m.tools.reduce((n: number, t: any) => n + t.errors, 0) : 0;
  const stopped = m ? m.gate.hookFailures + m.gate.hookBlocks : 0;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Now</h1>
          <p className="lede">
            {data
              ? sessions.length === 0
                ? 'No Claude Code session is running on this machine.'
                : `${plural(sessions.length, 'session')} running, ${sessions.filter((s) => s.status === 'busy').length} working.`
              : 'Reading the live-session registry.'}
          </p>
        </div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Time span of the map">
          {SPANS.map(([key, label]) => (
            <button key={key} aria-pressed={span[0] === key} onClick={() => setQuery({ span: key === 'day' ? null : key })}>{label}</button>
          ))}
        </div>
      </div>
      <Problem error={live.error ?? map.error} />

      <div className="stack">
        <section className={`panel needs${attention.length ? ' hot' : ''}`} aria-label="Needs you">
          {attention.length === 0 ? (
            <div className="clear"><h2>Needs you</h2><Mark tone="good">Nothing needs you right now.</Mark></div>
          ) : (
            <>
              <div className="card-head">
                <h2>Needs you</h2>
                <span className="count hot">{attention.length}</span>
                <p className="muted">Sessions that are waiting, blocked or did something risky.</p>
              </div>
              <div className="items">
                {attention.map((a) => {
                  const r = REASONS[a.reason] ?? { label: a.reason, tone: 'warn' as const };
                  const to = a.reason === 'integrity' ? '/audit/integrity' : a.reason === 'finding' ? `/audit${qs({ session: a.session, state: 'open' })}` : `/sessions/${encodeURIComponent(a.session)}`;
                  return (
                    <Link className="item" to={to} key={`${a.reason}-${a.session}`}>
                      <span data-row><Pill tone={r.tone}>{r.label}</Pill></span>
                      <span className="what">
                        <b className="clip">{a.title}</b>
                        <span className="why clip">{a.detail}</span>
                      </span>
                      <span className="muted nowrap" title={new Date(a.since).toLocaleString()}>{ago(a.since, now)}</span>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </section>
        {m ? (
          <>
            <Chips
              items={[
                { label: 'Prompts', value: int(m.prompts), note: `in the last ${span[1]}` },
                { label: 'Responses', value: compact(m.api.calls), note: m.api.errors ? plural(m.api.errors, 'API error') : 'no API error', tone: m.api.rateLimits ? 'critical' : undefined, to: '/ops' },
                { label: 'Tool calls', value: compact(toolCalls), note: `${int(toolErrors)} failed, ${int(m.gate.denied)} denied`, to: '/ops/tools' },
                { label: 'Hook runs', value: compact(m.gate.hookRuns), note: stopped ? `${int(stopped)} failed or blocked` : 'none failed', tone: stopped && stopped / m.gate.hookRuns >= 0.2 ? 'critical' : stopped ? 'warn' : undefined, to: '/ops/hooks' },
                { label: 'Subagents', value: int(m.subagents.spawned), note: money(m.subagents.cost), to: '/cost?group=agent' },
                { label: 'Spend', value: money(m.api.cost), note: m.api.unpriced ? `${int(m.api.unpriced)} responses have no price` : 'estimated from tokens', to: '/cost' },
              ]}
            />
            <Machine map={m} live={data} />
          </>
        ) : (
          <div className="stage"><Empty title="Drawing the harness">Counting the last {span[1]} of prompts, responses and tool calls.</Empty></div>
        )}
      </div>

      <section className="section" aria-label="Running sessions">
        <div className="section-head">
          <h2>Running</h2>
          <p>From the harness's own registry; a session whose process is gone is not listed.</p>
        </div>
        {sessions.length === 0 ? (
          <div className="panel"><Empty title="Nothing is running">Start Claude Code in a terminal and it appears here within a few seconds.</Empty></div>
        ) : (
          <div className="board">
            {lanes.map((lane) => (
              <div className={`lane${lane.hot && lane.items.length ? ' hot' : ''}`} key={lane.key}>
                <header>{lane.title}<span className="count">{lane.items.length}</span></header>
                {lane.items.length ? <div className="cards">{lane.items.map((s) => <SessionCard key={s.id} s={s} now={now} />)}</div> : <div className="none">{lane.none}</div>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section" aria-label="Recent sessions">
        <div className="section-head">
          <h2>Recent sessions</h2>
          <p>{overview?.totals ? `${int(overview.totals.sessions)} indexed, ${money(overview.totals.cost)} in all.` : ''}</p>
          <span className="spacer" />
          <Link to="/sessions">All sessions</Link>
        </div>
        <div className="panel table-wrap">
          <table>
            <tbody>
              {(recent.data?.items ?? []).map((s: any) => (
                <tr key={s.id} data-row onClick={() => navigate(`/sessions/${encodeURIComponent(s.id)}`)}>
                  <td>
                    <div className="cell-main clip" style={{ maxWidth: 560 }}>{s.title}</div>
                    <div className="cell-sub">{shortPath(s.cwd)}</div>
                  </td>
                  <td className="r">{when(s.lastTs, now)}</td>
                  <td className="r">{duration(s.durationMs)}</td>
                  <td className="r">{money(s.cost)}</td>
                  <td className="r">{s.risk ? <Severity level={s.risk} /> : <span className="muted">no findings</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
