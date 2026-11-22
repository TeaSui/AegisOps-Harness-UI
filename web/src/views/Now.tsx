// Now: what needs the operator first, then what is running, then today at a glance.
import type { Loaded } from '../api';
import { useApi, qs } from '../api';
import { ago, compact, duration, int, modelName, money, REASONS, shortPath, tzOffset, when } from '../format';
import { Empty, Link, Mark, Pill, Problem, Severity, navigate } from '../ui';

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function Now({ live, overview }: { live: Loaded<any>; overview: any }) {
  const today = startOfToday();
  const cost = useApi<any>(`/api/cost/series${qs({ from: today, to: today + 86_399_999, bucket: 'day', tz: tzOffset() })}`, 'all');
  const recent = useApi<any>('/api/sessions?limit=8', 'all');
  const data = live.data;
  const attention: any[] = data?.attention ?? [];
  const sessions: any[] = data?.sessions ?? [];
  const now = data?.at ?? Date.now();
  const busy = sessions.filter((s) => s.status === 'busy').length;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Now</h1>
          <p className="lede">
            {data
              ? sessions.length === 0
                ? 'No Claude Code session is running on this machine.'
                : `${sessions.length} session${sessions.length === 1 ? '' : 's'} running, ${busy} working.`
              : 'Reading the live-session registry.'}
          </p>
        </div>
      </div>
      <Problem error={live.error} />

      <section aria-label="Needs you">
        <div className="section-head">
          <h2>Needs you</h2>
          <p>Sessions that are waiting, blocked or did something risky.</p>
        </div>
        <div className="attention">
          {attention.length === 0 ? (
            <div className="clear">
              <Mark tone="good">Nothing needs you right now.</Mark>
            </div>
          ) : (
            attention.map((a) => {
              const r = REASONS[a.reason] ?? { label: a.reason, tone: 'warn' as const };
              const to = a.reason === 'integrity' ? '/audit/integrity' : a.reason === 'finding' ? `/audit${qs({ session: a.session, state: 'open' })}` : `/sessions/${encodeURIComponent(a.session)}`;
              return (
                <Link className="item" to={to} key={`${a.reason}-${a.session}`}>
                  <span data-row><Pill tone={r.tone}>{r.label}</Pill></span>
                  <span className="what">
                    <b className="clip" style={{ display: 'block' }}>{a.title}</b>
                    <div className="clip">{a.detail}</div>
                  </span>
                  <span className="muted nowrap" title={new Date(a.since).toLocaleString()}>{ago(a.since, now)}</span>
                </Link>
              );
            })
          )}
        </div>
      </section>

      <section className="section" aria-label="Running">
        <div className="section-head">
          <h2>Running</h2>
          <p>From the harness's own registry; a session whose process is gone is not listed.</p>
        </div>
        <div className="panel">
          {sessions.length === 0 ? (
            <Empty title="Nothing is running">Start Claude Code in a terminal and it appears here within a few seconds.</Empty>
          ) : (
            sessions.map((s) => (
              <Link className="live-row" to={`/sessions/${encodeURIComponent(s.id)}`} key={s.id}>
                <span data-row className={`dot ${s.status === 'busy' ? 'busy' : 'idle'}`} title={s.status} />
                <span style={{ minWidth: 0 }}>
                  <div className="cell-main clip">{s.title}</div>
                  <div className="cell-sub clip" title={s.cwd}>
                    {s.status} since {when(s.statusSince, now)}, {shortPath(s.cwd)}{s.gitBranch ? ` on ${s.gitBranch}` : ''}
                  </div>
                </span>
                <span className="hide-narrow" style={{ minWidth: 0 }}>
                  {s.lastTool ? (
                    <>
                      <div className="clip"><b>{s.lastTool.name.startsWith('mcp__') ? s.lastTool.name.slice(s.lastTool.name.lastIndexOf('__') + 2) : s.lastTool.name}</b> <span className="mono soft">{s.lastTool.target}</span></div>
                      <div className="cell-sub">{s.lastTool.status === 'pending' ? `started ${ago(s.lastTool.ts, now)}, no result yet` : `last tool, ${ago(s.lastTool.ts, now)}`}</div>
                    </>
                  ) : (
                    <span className="muted">No tool call yet</span>
                  )}
                </span>
                <span className="hide-narrow">
                  <div>{modelName(s.currentModel)}</div>
                  <div className="cell-sub" title="Input, cache read and cache write tokens of the last response">{s.contextTokens !== null ? `${compact(s.contextTokens)} context` : 'no response yet'}</div>
                </span>
                <span className="num" style={{ textAlign: 'right' }}>
                  <div>{money(s.cost)}</div>
                  <div className="cell-sub">{duration(s.durationMs)}</div>
                </span>
                <span style={{ textAlign: 'right' }}>
                  {s.attention.length ? <Pill tone={REASONS[s.attention[0]]?.tone ?? 'warn'} icon={null}>needs you</Pill> : s.risk ? <Severity level={s.risk} /> : <span className="muted">quiet</span>}
                </span>
              </Link>
            ))
          )}
        </div>
      </section>

      <section className="section" aria-label="Today">
        <div className="section-head">
          <h2>Today</h2>
          <p>Since midnight, local time.</p>
        </div>
        <dl className="stats">
          <div className="stat">
            <dt>Spend</dt>
            <dd className="num">{money(cost.data?.totals.cost)}</dd>
            <small>{cost.data?.totals.unpriced ? `${int(cost.data.totals.unpriced)} responses have no price` : 'estimated from tokens'}</small>
          </div>
          <div className="stat">
            <dt>Responses</dt>
            <dd className="num">{int(cost.data?.totals.calls)}</dd>
            <small>{compact(cost.data?.totals.output)} output tokens</small>
          </div>
          <div className="stat">
            <dt>Input from cache</dt>
            <dd className="num">{cost.data ? (cost.data.totals.cacheShare === null ? 'n/a' : `${Math.round(cost.data.totals.cacheShare * 100)}%`) : '—'}</dd>
            <small>{compact(cost.data?.totals.cacheRead)} tokens read from cache</small>
          </div>
          <div className="stat">
            <dt>All time</dt>
            <dd className="num">{money(overview?.totals?.cost)}</dd>
            <small>{int(overview?.totals?.sessions)} sessions indexed</small>
          </div>
        </dl>
      </section>

      <section className="section" aria-label="Recent sessions">
        <div className="section-head">
          <h2>Recent sessions</h2>
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
