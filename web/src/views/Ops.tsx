// Ops: is the harness healthy, and is it configured the way you think it is.
import { useMemo } from 'react';
import { qs, useApi } from '../api';
import { ChartFrame, Columns, Meter } from '../charts';
import { dayLabel, duration, int, percent, tzOffset, when } from '../format';
import { Empty, Link, Mark, Pill, Problem, setQuery } from '../ui';

const TABS = [
  ['health', 'Health'],
  ['hooks', 'Hooks'],
  ['tools', 'Tools and MCP'],
  ['config', 'Configuration'],
  ['doctor', 'Doctor'],
];

function useRange(query: URLSearchParams) {
  const days = query.get('days') ?? '14';
  return useMemo(() => {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (Number(days) - 1));
    return { days, from: start.getTime(), to: end.getTime() };
  }, [days]);
}

function RangePicker({ days }: { days: string }) {
  return (
    <div className="seg" role="group" aria-label="Range">
      {[['7', '7 days'], ['14', '14 days'], ['30', '30 days'], ['90', '90 days']].map(([v, label]) => (
        <button key={v} aria-pressed={days === v} onClick={() => setQuery({ days: v === '14' ? null : v })}>{label}</button>
      ))}
    </div>
  );
}

const ONE = (key: string, label: string) => [{ key, label, color: 'var(--s1)' }];

function Health({ query }: { query: URLSearchParams }) {
  const range = useRange(query);
  const series = useApi<any>(`/api/ops/series${qs({ from: range.from, to: range.to, bucket: 'day', tz: tzOffset() })}`, 'all');
  const records = useApi<any>('/api/ops/records', 'all');
  const buckets: any[] = series.data?.buckets ?? [];
  const cols = (key: string) => buckets.map((b) => ({ start: b.start, label: dayLabel(b.start), values: { [key]: b[key] } }));
  const sum = (key: string) => buckets.reduce((n, b) => n + b[key], 0);
  const charts: Array<[string, string, string]> = [
    ['apiErrors', 'API errors', `${int(sum('rateLimits'))} were rate limits`],
    ['compactions', 'Context compactions', 'each one means a context window filled up'],
    ['hookFailures', 'Hook failures and blocks', ''],
    ['toolErrors', 'Failed tool calls', `of ${int(sum('toolCalls'))} calls`],
  ];
  const r = records.data;
  return (
    <>
      <div className="filters"><RangePicker days={range.days} /></div>
      <Problem error={series.error} />
      <div className="multiples">
        {charts.map(([key, title, note]) => (
          <ChartFrame key={key} title={`${title}: ${int(sum(key))}`} note={note}>
            <Columns columns={cols(key)} series={ONE(key, title)} format={int} height={150} integer />
          </ChartFrame>
        ))}
      </div>
      {series.data?.errors.length ? (
        <section className="section">
          <div className="section-head"><h2>API errors by kind</h2></div>
          <div className="panel table-wrap">
            <table>
              <thead><tr><th>Error</th><th>Status</th><th className="r">Count</th></tr></thead>
              <tbody>
                {series.data.errors.map((e: any) => (
                  <tr key={`${e.error}-${e.status}`}><td>{String(e.error).replace(/_/g, ' ')}</td><td>{e.status || '—'}</td><td className="r">{int(e.count)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {r ? (
        <section className="section">
          <div className="section-head">
            <h2>The index</h2>
            <p>{int(r.lines)} transcript lines in {int(r.files)} files. {r.skippedLines ? `${int(r.skippedLines)} lines could not be read.` : 'Every line was read.'}</p>
          </div>
          {r.unknownTypes.length ? (
            <div className="banner warn">
              <div>
                <Mark tone="warn">The transcripts hold record types this version of Aegis does not know.</Mark>
                <p className="soft" style={{ marginTop: 4 }}>
                  They are counted and ignored. The transcript format is not a published contract, so this is how a change in the harness shows up:{' '}
                  {r.unknownTypes.map((t: any) => `${t.type} (${int(t.count)})`).join(', ')}.
                </p>
              </div>
            </div>
          ) : null}
          <div className="panel table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>Record type</th><th className="r">Lines</th><th>Known</th></tr></thead>
              <tbody>
                {r.types.map((t: any) => (
                  <tr key={t.type}><td className="mono">{t.type}</td><td className="r">{int(t.count)}</td><td>{t.known ? <span className="muted">yes</span> : <Pill tone="warn" icon={null}>new</Pill>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}

function Hooks({ query }: { query: URLSearchParams }) {
  const range = useRange(query);
  const hooks = useApi<any>(`/api/ops/hooks${qs({ from: range.from, to: range.to })}`, 'all');
  const items: any[] = hooks.data?.items ?? [];
  return (
    <>
      <div className="filters"><RangePicker days={range.days} /></div>
      <Problem error={hooks.error} />
      <div className="panel table-wrap">
        {items.length === 0 && !hooks.loading ? (
          <Empty title="No hook ran in this range">Hooks defined in settings and by plugins show here once they run.</Empty>
        ) : (
          <table>
            <thead><tr><th>Event</th><th>Command</th><th className="r">Runs</th><th className="r">Failed</th><th className="r">Blocked</th><th>Reliability</th><th className="r">Median</th><th className="r">95th pct.</th><th>Last run</th></tr></thead>
            <tbody>
              {items.map((h) => {
                const bad = h.failures + h.blocks;
                return (
                  <tr key={`${h.event}-${h.command}`}>
                    <td className="cell-main nowrap">{h.event}</td>
                    <td className="mono" style={{ overflowWrap: 'anywhere', maxWidth: 520 }}>{h.command || '—'}</td>
                    <td className="r">{int(h.runs)}</td>
                    <td className="r">{h.failures || ''}</td>
                    <td className="r">{h.blocks || ''}</td>
                    <td className="nowrap">{bad === 0 ? <Mark tone="good">no failures</Mark> : <Mark tone={h.failureShare > 0.2 ? 'critical' : 'warn'}>{percent(h.failureShare)} failed or blocked</Mark>}</td>
                    <td className="r">{duration(h.p50)}</td>
                    <td className="r">{duration(h.p95)}</td>
                    <td className="nowrap">{when(h.lastTs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted" style={{ marginTop: 10, fontSize: 13, maxWidth: '80ch' }}>
        Percentiles use the nearest-rank method over recorded durations. Stop hooks are counted from the harness's stop summaries, which list every run; other hooks are counted from the records the harness writes when a hook produces output or fails.
      </p>
    </>
  );
}

function Tools({ query }: { query: URLSearchParams }) {
  const range = useRange(query);
  const data = useApi<any>(`/api/ops/tools${qs({ from: range.from, to: range.to })}`, 'all');
  const tools: any[] = data.data?.tools ?? [];
  const servers: any[] = data.data?.servers ?? [];
  const max = Math.max(0, ...tools.map((t) => t.calls));
  const rate = (v: number, n: number) => (n === 0 || v === 0 ? <span className="muted">0%</span> : <Mark tone={v > 0.2 ? 'critical' : 'warn'}>{percent(v, v < 0.1 ? 1 : 0)}</Mark>);
  return (
    <>
      <div className="filters"><RangePicker days={range.days} /></div>
      <Problem error={data.error} />
      {servers.length ? (
        <section style={{ marginBottom: 24 }}>
          <div className="section-head"><h2>MCP servers</h2><p>Tools grouped by the server in their name.</p></div>
          <div className="panel table-wrap">
            <table>
              <thead><tr><th>Server</th><th className="r">Tools used</th><th className="r">Calls</th><th>Error rate</th><th>Denial rate</th><th className="r">Median</th><th className="r">95th pct.</th></tr></thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.server}>
                    <td className="cell-main">{s.server}</td><td className="r">{s.tools}</td><td className="r">{int(s.calls)}</td>
                    <td>{rate(s.errorRate, s.finished)}</td><td>{rate(s.denialRate, s.calls)}</td><td className="r">{duration(s.p50)}</td><td className="r">{duration(s.p95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <div className="section-head"><h2>Tools</h2><p>Error rate is failed over finished calls; denial rate is denied over all calls.</p></div>
      <div className="panel table-wrap">
        {tools.length === 0 && !data.loading ? <Empty title="No tool was called in this range" /> : (
          <table>
            <thead><tr><th>Tool</th><th style={{ width: '16%' }} /><th className="r">Calls</th><th>Error rate</th><th>Denial rate</th><th className="r">No result</th><th className="r">Median</th><th className="r">95th pct.</th></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.tool}>
                  <td><span className="cell-main">{t.mcpServer ? t.tool.slice(t.tool.lastIndexOf('__') + 2) : t.tool}</span>{t.mcpServer ? <span className="tag" style={{ marginLeft: 8 }}>{t.mcpServer}</span> : null}</td>
                  <td style={{ verticalAlign: 'middle' }}><Meter value={t.calls} max={max} /></td>
                  <td className="r">{int(t.calls)}</td>
                  <td>{rate(t.errorRate, t.finished)}{t.errors ? <span className="muted"> ({t.errors})</span> : null}</td>
                  <td>{rate(t.denialRate, t.calls)}{t.denied ? <span className="muted"> ({t.denied})</span> : null}</td>
                  <td className="r">{t.pending || ''}</td>
                  <td className="r">{duration(t.p50)}</td>
                  <td className="r">{duration(t.p95)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const SCOPE: Record<string, string> = { managed: 'Managed (organisation)', user: 'User', project: 'Project', local: 'Project, local' };

function Rules({ label, rules, tone }: { label: string; rules: string[]; tone?: 'good' | 'critical' | 'warn' }) {
  if (!rules.length) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {rules.map((r, i) => <span key={i} className="tag mono" style={tone === 'critical' ? { color: 'var(--critical)' } : undefined}>{r}</span>)}
      </dd>
    </>
  );
}

function Config() {
  const inv = useApi<any>('/api/ops/inventory');
  const d = inv.data;
  return (
    <>
      <div className="section-head"><p style={{ maxWidth: '80ch' }}>Each settings file as it is on disk, not a merged view. Environment values, headers and server arguments are never read into this page: only their names and counts.</p></div>
      <Problem error={inv.error} />
      {d ? (
        <>
          <section>
            <div className="section-head"><h2>Settings files</h2></div>
            {d.settings.length === 0 ? <div className="panel"><Empty title="No settings file was found" /></div> : null}
            <div style={{ display: 'grid', gap: 12 }}>
              {d.settings.map((s: any) => (
                <div className="panel pad" key={`${s.scope}-${s.path}`}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 8 }}>
                    <h3>{SCOPE[s.scope] ?? s.scope}</h3>
                    <span className="mono muted" style={{ overflowWrap: 'anywhere' }}>{s.path}</span>
                    {!s.readable ? <Mark tone="critical">not valid JSON</Mark> : null}
                  </div>
                  <dl className="kv">
                    {s.defaultMode ? <><dt>Default mode</dt><dd>{s.defaultMode === 'bypassPermissions' ? <Mark tone="critical">{s.defaultMode}</Mark> : s.defaultMode}</dd></> : null}
                    {s.model ? <><dt>Model</dt><dd>{s.model}</dd></> : null}
                    <Rules label="Allow" rules={s.allow} />
                    <Rules label="Ask" rules={s.ask} />
                    <Rules label="Deny" rules={s.deny} />
                    {s.hooks.length ? (
                      <>
                        <dt>Hooks</dt>
                        <dd>{s.hooks.map((h: any, i: number) => <div key={i}><b>{h.event}</b>{h.matcher ? ` (${h.matcher})` : ''} <span className="mono soft">{h.command}</span></div>)}</dd>
                      </>
                    ) : null}
                    {s.enabledPlugins.length ? <><dt>Plugins</dt><dd>{s.enabledPlugins.map((p: any) => `${p.id}${p.enabled ? '' : ' (off)'}`).join(', ')}</dd></> : null}
                    {s.envKeys.length ? <><dt>Environment</dt><dd className="mono">{s.envKeys.join(', ')} <span className="muted" style={{ fontFamily: 'var(--sans)' }}>(names only)</span></dd></> : null}
                  </dl>
                </div>
              ))}
            </div>
          </section>
          <section className="section">
            <div className="section-head"><h2>Plugins</h2><p>From the plugin registry.</p></div>
            <div className="panel table-wrap">
              {d.plugins.length === 0 ? <Empty title="No plugin is installed" /> : (
                <table>
                  <thead><tr><th>Plugin</th><th>Marketplace</th><th>Version</th><th>Installed for</th><th>Enabled in</th><th>Updated</th></tr></thead>
                  <tbody>
                    {d.plugins.map((p: any, i: number) => (
                      <tr key={`${p.id}-${i}`}>
                        <td className="cell-main">{p.name}</td><td>{p.marketplace ?? '—'}</td><td className="mono">{p.version ?? '—'}</td>
                        <td>{p.scope ?? '—'}{p.projectPath ? <div className="cell-sub mono">{p.projectPath}</div> : null}</td>
                        <td>{p.enabledIn.length ? p.enabledIn.join(', ') : <span className="muted">not enabled in a settings file</span>}</td>
                        <td className="nowrap">{p.lastUpdated ? when(Date.parse(p.lastUpdated)) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
          <section className="section">
            <div className="section-head"><h2>MCP servers</h2><p>From the user configuration file and each project's .mcp.json.</p></div>
            <div className="panel table-wrap">
              {d.mcpServers.length === 0 ? <Empty title="No MCP server is configured" /> : (
                <table>
                  <thead><tr><th>Server</th><th>Transport</th><th>Command or host</th><th>Defined in</th><th>Credentials present</th></tr></thead>
                  <tbody>
                    {d.mcpServers.map((m: any, i: number) => (
                      <tr key={`${m.name}-${i}`}>
                        <td className="cell-main">{m.name}</td><td>{m.transport}</td>
                        <td className="mono">{m.command ?? m.host ?? '—'}{m.args ? <span className="muted"> + {m.args} argument{m.args === 1 ? '' : 's'}</span> : null}</td>
                        <td>{m.source}{m.project ? <div className="cell-sub mono">{m.project}</div> : null}</td>
                        <td className="mono soft">{[...m.envKeys, ...m.headerKeys].join(', ') || <span className="muted" style={{ fontFamily: 'var(--sans)' }}>none</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      ) : null}
    </>
  );
}

const CHECK_TONE: Record<string, 'good' | 'warn' | 'critical'> = { pass: 'good', warn: 'warn', fail: 'critical' };
const CHECK_WORD: Record<string, string> = { pass: 'passes', warn: 'warning', fail: 'fails' };

function Doctor() {
  const doc = useApi<any>('/api/ops/doctor', 'all');
  const d = doc.data;
  const order = { fail: 0, warn: 1, pass: 2 } as Record<string, number>;
  return (
    <>
      <Problem error={doc.error} />
      {d ? (
        <>
          <div className={`banner ${d.summary.fail ? 'critical' : d.summary.warn ? 'warn' : ''}`}>
            {d.summary.fail ? <Mark tone="critical">{d.summary.fail} check{d.summary.fail === 1 ? ' fails' : 's fail'}, {d.summary.warn} warn, {d.summary.pass} pass.</Mark> : d.summary.warn ? <Mark tone="warn">{d.summary.warn} warning{d.summary.warn === 1 ? '' : 's'}, {d.summary.pass} checks pass.</Mark> : <Mark tone="good">All {d.summary.pass} checks pass.</Mark>}
          </div>
          <div className="panel checks">
            {[...d.checks].sort((a: any, b: any) => order[a.status] - order[b.status]).map((c: any) => (
              <div className="check" key={c.id}>
                <div><Pill tone={CHECK_TONE[c.status]}>{CHECK_WORD[c.status]}</Pill></div>
                <div>
                  <b>{c.title}</b>
                  <div className="soft">{c.detail}</div>
                  {c.evidence.length ? <ul>{c.evidence.map((e: string, i: number) => <li key={i} className="mono" style={{ overflowWrap: 'anywhere' }}>{e}</li>)}</ul> : null}
                  {c.id === 'integrity.alerts' && c.status !== 'pass' ? <Link to="/audit/integrity">Review in Audit</Link> : null}
                  {c.id === 'hooks.failing' && c.status !== 'pass' ? <Link to="/ops/hooks">See every hook</Link> : null}
                </div>
              </div>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>Aegis only reports. It never changes harness configuration.</p>
        </>
      ) : null}
    </>
  );
}

export function Ops({ tab, query }: { tab: string; query: URLSearchParams }) {
  const doc = useApi<any>('/api/ops/doctor', 'all');
  const bad = doc.data ? doc.data.summary.fail + doc.data.summary.warn : 0;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Ops</h1>
          <p className="lede">Reliability of hooks, tools, MCP servers and the API, and what the harness is configured to do.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Ops sections">
        {TABS.map(([key, label]) => (
          <Link key={key} to={key === 'health' ? '/ops' : `/ops/${key}`} current={tab === key}>
            {label}
            {key === 'doctor' && bad ? <span className="count">{bad}</span> : null}
          </Link>
        ))}
      </nav>
      {tab === 'health' ? <Health query={query} /> : tab === 'hooks' ? <Hooks query={query} /> : tab === 'tools' ? <Tools query={query} /> : tab === 'config' ? <Config /> : tab === 'doctor' ? <Doctor /> : <Empty title="No such section" />}
    </div>
  );
}
