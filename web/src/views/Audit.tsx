// Audit: what ran and who let it, what looked dangerous, whether history was touched, and what
// was done through this console.
import { useEffect, useState } from 'react';
import { post, qs, useApi } from '../api';
import { allowedByText, duration, fullTime, int, shortPath, when } from '../format';
import { Empty, Icon, Link, Mark, Outcome, Pill, Problem, Severity, Source, navigate, setQuery, useToast } from '../ui';

const TABS = [
  ['findings', 'Risk findings'],
  ['ledger', 'Ledger'],
  ['integrity', 'Integrity'],
  ['activity', 'Console activity'],
];

function ExportButtons({ base, params }: { base: string; params: Record<string, string | null> }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}><Icon name="down" size={15} />Export</button>
      {open ? (
        <div className="tip" style={{ right: 0, top: 36, pointerEvents: 'auto', width: 300 }}>
          <b>Export what the filters show</b>
          <p className="soft" style={{ marginBottom: 8 }}>
            Secrets are masked by pattern, which cannot be complete. Commands, paths and evidence can still hold personal data. The export is logged.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <a className="btn small" href={`${base}${qs({ ...params, format: 'csv' })}`} onClick={() => setOpen(false)}>CSV</a>
            <a className="btn small" href={`${base}${qs({ ...params, format: 'jsonl' })}`} onClick={() => setOpen(false)}>JSON Lines</a>
            <button className="btn small quiet" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </span>
  );
}

function Triage({ finding, onDone }: { finding: any; onDone: () => void }) {
  const [note, setNote] = useState(finding.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const send = async (state: 'acknowledged' | 'open') => {
    try {
      await post(`/api/audit/findings/${encodeURIComponent(finding.id)}/triage`, { state, note });
      toast(state === 'acknowledged' ? 'Acknowledged' : 'Reopened');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 8, padding: '4px 0 6px' }} onClick={(e) => e.stopPropagation()}>
      <textarea className="field" rows={2} maxLength={2000} value={note} placeholder="Why this is fine, or what was done about it (optional)" aria-label="Note" onChange={(e) => setNote(e.target.value)} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {finding.state === 'open' ? (
          <button className="btn small primary" onClick={() => send('acknowledged')}>Acknowledge</button>
        ) : (
          <>
            <button className="btn small" onClick={() => send('acknowledged')}>Save note</button>
            <button className="btn small" onClick={() => send('open')}>Reopen</button>
          </>
        )}
        <Link to={`/sessions/${encodeURIComponent(finding.session)}?show=problems`}>Open the session</Link>
        <Source file={finding.file} line={finding.line} />
        {error ? <Mark tone="critical">{error}</Mark> : null}
      </div>
    </div>
  );
}

function Findings({ query }: { query: URLSearchParams }) {
  const stateParam = query.get('state') === 'all' ? null : (query.get('state') ?? 'open');
  const params = { severity: query.get('severity'), rule: query.get('rule'), session: query.get('session'), project: query.get('project') };
  const offset = Number(query.get('offset') ?? 0) || 0;
  const list = useApi<any>(`/api/audit/findings${qs({ ...params, state: stateParam, limit: 100, offset })}`, 'all');
  const [open, setOpen] = useState<string | null>(null);
  const items: any[] = list.data?.items ?? [];
  const summary: any[] = list.data?.summary ?? [];
  const count = (sev: string, key: 'open' | 'total') => summary.find((s) => s.severity === sev)?.[key] ?? 0;
  const rules: any[] = (list.data?.rules ?? []).filter((r: any) => r.total > 0);
  return (
    <>
      <dl className="stats" style={{ marginBottom: 16 }}>
        {['critical', 'high', 'medium', 'low'].map((sev) => (
          <div className="stat" key={sev}>
            <dt><Severity level={sev} /></dt>
            <dd className="num">{int(count(sev, 'open'))}</dd>
            <small>open of {int(count(sev, 'total'))}</small>
          </div>
        ))}
      </dl>
      <div className="filters">
        <div className="seg">
          {[['open', 'Open'], ['acknowledged', 'Acknowledged'], ['all', 'All']].map(([v, label]) => (
            <button key={v} aria-pressed={(query.get('state') ?? 'open') === v} onClick={() => setQuery({ state: v === 'open' ? null : v, offset: null })}>{label}</button>
          ))}
        </div>
        <select className="field" value={query.get('severity') ?? ''} onChange={(e) => setQuery({ severity: e.target.value || null, offset: null })} aria-label="Severity">
          <option value="">Any severity</option>
          <option value="medium">Medium or higher</option>
          <option value="high">High or higher</option>
          <option value="critical">Critical only</option>
        </select>
        <select data-filter className="field" value={query.get('rule') ?? ''} onChange={(e) => setQuery({ rule: e.target.value || null, offset: null })} aria-label="Rule">
          <option value="">Every rule</option>
          {rules.map((r) => <option key={r.id} value={r.id}>{r.title} ({r.open} open)</option>)}
        </select>
        {query.get('session') ? <button className="btn small" onClick={() => setQuery({ session: null })}>One session only<Icon name="close" size={13} /></button> : null}
        <span style={{ flex: 1 }} />
        <ExportButtons base="/api/audit/findings/export" params={{ ...params, state: stateParam }} />
      </div>
      <Problem error={list.error} />
      <div className="panel table-wrap">
        {items.length === 0 && !list.loading ? (
          <Empty title={(query.get('state') ?? 'open') === 'open' ? 'No open findings' : 'No findings match'}>
            Tool calls are matched against {list.data?.rules?.length ?? 0} built-in risk rules as they are indexed.
          </Empty>
        ) : (
          <table>
            <thead><tr><th>Severity</th><th>What happened</th><th>Session</th><th>When</th><th>Outcome</th><th>State</th></tr></thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id} data-row onClick={() => setOpen(open === f.id ? null : f.id)}>
                  <td><Severity level={f.severity} /></td>
                  <td style={{ maxWidth: 560, minWidth: 300 }}>
                    <div className="cell-main">{f.title}</div>
                    <div className="mono soft" style={{ overflowWrap: 'anywhere', whiteSpace: open === f.id ? 'pre-wrap' : undefined }}>{open === f.id ? f.evidence : f.evidence.replace(/\s+/g, ' ').slice(0, 150)}</div>
                    {f.note && open !== f.id ? <div className="cell-sub">Note: {f.note}</div> : null}
                    {open === f.id ? <Triage finding={f} onDone={list.reload} /> : null}
                  </td>
                  <td style={{ maxWidth: 240 }}><div className="clip">{f.sessionTitle ?? f.session}</div><div className="cell-sub clip" title={f.cwd ?? f.project}>{shortPath(f.cwd) || f.project}</div></td>
                  <td className="nowrap" title={fullTime(f.ts)}>{when(f.ts)}</td>
                  <td>{f.outcome ? <Outcome status={f.outcome} /> : <span className="muted">session-wide</span>}</td>
                  <td>{f.state === 'open' ? <Pill tone="warn" icon={null}>open</Pill> : <Pill tone="good">acknowledged</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <Pager total={list.data?.total ?? 0} offset={offset} shown={items.length} limit={100} />
      <section className="section">
        <div className="section-head"><h2>Rules</h2><p>Built in and versioned with Aegis. A rule fires at most once per tool call.</p></div>
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Rule</th><th>Fires on</th><th>Default severity</th><th className="r">Open</th><th className="r">All</th></tr></thead>
            <tbody>
              {(list.data?.rules ?? []).map((r: any) => (
                <tr key={r.id}>
                  <td><div className="cell-main">{r.title}</div><div className="cell-sub mono">{r.id}</div></td>
                  <td className="soft" style={{ maxWidth: 520 }}>{r.description}</td>
                  <td><Severity level={r.severity} /></td>
                  <td className="r">{r.open || ''}</td>
                  <td className="r">{r.total || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Pager({ total, offset, shown, limit }: { total: number; offset: number; shown: number; limit: number }) {
  return (
    <div className="filters" style={{ marginTop: 12 }}>
      <span className="muted">{total ? `${int(offset + 1)} to ${int(offset + shown)} of ${int(total)}` : ''}</span>
      <span style={{ flex: 1 }} />
      {offset > 0 ? <button className="btn small" onClick={() => setQuery({ offset: String(Math.max(0, offset - limit)) })}>Newer</button> : null}
      {offset + shown < total ? <button className="btn small" onClick={() => setQuery({ offset: String(offset + limit) })}>Older</button> : null}
    </div>
  );
}

const CATEGORY: Record<string, string> = { exec: 'Command', write: 'File write', fetch: 'Web fetch', mcp: 'MCP call', agent: 'Subagent' };

function Ledger({ query }: { query: URLSearchParams }) {
  const [text, setText] = useState(query.get('q') ?? '');
  useEffect(() => {
    if (text === (query.get('q') ?? '')) return;
    const t = window.setTimeout(() => setQuery({ q: text.trim() || null, offset: null }), 250);
    return () => window.clearTimeout(t);
  }, [text, query]);
  const days = query.get('days');
  const [anchor] = useState(() => Date.now());
  const params = {
    q: query.get('q'), tool: query.get('tool'), category: query.get('category'), outcome: query.get('outcome'), project: query.get('project'), session: query.get('session'),
    from: days ? String(anchor - Number(days) * 86_400_000) : null,
  };
  const offset = Number(query.get('offset') ?? 0) || 0;
  const list = useApi<any>(`/api/audit/ledger${qs({ ...params, limit: 200, offset })}`, 'all');
  const projects = useApi<any>('/api/projects');
  const items: any[] = list.data?.items ?? [];
  const sel = (key: string) => (e: React.ChangeEvent<HTMLSelectElement>) => setQuery({ [key]: e.target.value || null, offset: null });
  return (
    <>
      <div className="filters">
        <input data-filter className="field grow" type="search" value={text} placeholder="Find in commands, paths and URLs   /" aria-label="Find in targets" onChange={(e) => setText(e.target.value)} />
        <select className="field" value={query.get('category') ?? ''} onChange={sel('category')} aria-label="Kind">
          <option value="">Every kind</option>
          {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="field" value={query.get('tool') ?? ''} onChange={sel('tool')} aria-label="Tool" style={{ maxWidth: 200 }}>
          <option value="">Every tool</option>
          {(list.data?.tools ?? []).map((t: string) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="field" value={query.get('outcome') ?? ''} onChange={sel('outcome')} aria-label="Outcome">
          <option value="">Any outcome</option>
          <option value="ok">Succeeded</option>
          <option value="error">Failed</option>
          <option value="denied">Denied</option>
          <option value="pending">No result</option>
        </select>
        <select className="field" value={query.get('project') ?? ''} onChange={sel('project')} aria-label="Project" style={{ maxWidth: 200 }}>
          <option value="">All projects</option>
          {(projects.data?.items ?? []).map((p: any) => <option key={p.id} value={p.id}>{shortPath(p.cwd) || p.id}</option>)}
        </select>
        <select className="field" value={days ?? ''} onChange={sel('days')} aria-label="Time range">
          <option value="">Any time</option><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
        </select>
        <ExportButtons base="/api/audit/ledger/export" params={params} />
      </div>
      <Problem error={list.error} />
      <div className="panel table-wrap">
        {items.length === 0 && !list.loading ? (
          <Empty title="Nothing in the ledger matches">The ledger holds every command, file write, fetch, MCP call and subagent dispatch. Reads are left out.</Empty>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Tool</th><th>Target</th><th>Outcome</th><th>Allowed by</th><th className="r">Took</th><th>Source</th></tr></thead>
            <tbody>
              {items.map((r) => {
                const by = allowedByText(r.allowedBy);
                return (
                  <tr key={r.id} data-row onClick={() => navigate(`/sessions/${encodeURIComponent(r.session)}${qs({ agent: r.agentId, show: 'tools' })}`)}>
                    <td className="nowrap" title={fullTime(r.ts)}>{when(r.ts)}</td>
                    <td className="nowrap"><span className="cell-main">{r.mcpServer ? r.tool.slice(r.tool.lastIndexOf('__') + 2) : r.tool}</span>{r.mcpServer ? <div className="cell-sub">{r.mcpServer}</div> : null}</td>
                    <td style={{ maxWidth: 560, minWidth: 300 }}>
                      <div className="mono" style={{ overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{r.target}</div>
                      <div className="cell-sub clip">{r.sessionTitle ?? r.session}, {shortPath(r.cwd) || r.project}{r.findings.length ? <> <Pill tone="warn" icon={null}>{r.findings.join(', ')}</Pill></> : null}</div>
                    </td>
                    <td><Outcome status={r.outcome} />{r.denialKind ? <div className="cell-sub">{r.denialKind}</div> : null}</td>
                    <td title={by.raw}>{by.label}</td>
                    <td className="r">{duration(r.durationMs)}</td>
                    <td><Source file={r.file} line={r.line} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <Pager total={list.data?.total ?? 0} offset={offset} shown={items.length} limit={200} />
    </>
  );
}

function Integrity() {
  const data = useApi<any>('/api/audit/integrity', 'all');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Record<number, string>>({});
  const toast = useToast();
  const verify = async () => {
    setBusy(true);
    try {
      const r = await post<any>('/api/audit/verify');
      toast(`Checked ${r.files} transcripts`);
      data.reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ack = async (id: number) => {
    await post(`/api/audit/integrity/${id}/ack`, { note: note[id] ?? '' });
    data.reload();
  };
  const items: any[] = data.data?.items ?? [];
  return (
    <>
      <div className="section-head">
        <p style={{ maxWidth: '76ch' }}>
          A transcript should only ever grow. Each index pass checks the bytes just before where it stopped; the full check hashes every indexed transcript from its first byte.
        </p>
        <span className="spacer" />
        <button className="btn" onClick={verify} disabled={busy}>{busy ? 'Checking…' : 'Check every transcript now'}</button>
      </div>
      <Problem error={data.error} />
      {data.data ? (
        <div className={`banner ${data.data.open ? 'critical' : ''}`}>
          {data.data.open ? <Mark tone="critical">{data.data.open} transcript{data.data.open === 1 ? ' was' : 's were'} rewritten or truncated after indexing and not yet acknowledged.</Mark> : <Mark tone="good">No unacknowledged alert. {int(data.data.verified.files)} transcripts are tracked.</Mark>}
        </div>
      ) : null}
      <div className="panel table-wrap">
        {items.length === 0 ? (
          <Empty title="No transcript has been altered">An alert appears here when an indexed transcript is rewritten or cut short.</Empty>
        ) : (
          <table>
            <thead><tr><th>Detected</th><th>Transcript</th><th>What changed</th><th>State</th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap" title={fullTime(a.at)}>{when(a.at)}</td>
                  <td><div className="mono" style={{ overflowWrap: 'anywhere' }}>{a.path}</div><Link to={`/sessions/${encodeURIComponent(a.session)}`}>Open the session</Link></td>
                  <td><Mark tone="critical">{a.reason}</Mark><div className="cell-sub num">{int(a.oldSize)} bytes indexed, file now {int(a.newSize)} bytes</div></td>
                  <td style={{ minWidth: 260 }}>
                    {a.ackAt ? (
                      <><Pill tone="good">acknowledged</Pill><div className="cell-sub">{when(a.ackAt)}{a.ackNote ? `: ${a.ackNote}` : ''}</div></>
                    ) : (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input className="field" style={{ flex: 1 }} placeholder="Note (optional)" maxLength={2000} value={note[a.id] ?? ''} onChange={(e) => setNote({ ...note, [a.id]: e.target.value })} aria-label="Note" />
                        <button className="btn small" style={{ height: 30 }} onClick={() => ack(a.id)}>Acknowledge</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data.data?.sourceRemoved.length ? (
        <section className="section">
          <div className="section-head"><h2>Transcripts no longer on disk</h2><p>The harness deletes old transcripts by design. Their indexed figures are kept; this is not an alert.</p></div>
          <div className="panel table-wrap">
            <table><tbody>
              {data.data.sourceRemoved.map((r: any) => (
                <tr key={r.path}><td className="mono" style={{ overflowWrap: 'anywhere' }}>{r.path}</td><td className="r"><Link to={`/sessions/${encodeURIComponent(r.session)}`}>Session</Link></td></tr>
              ))}
            </tbody></table>
          </div>
        </section>
      ) : null}
    </>
  );
}

const ACTION: Record<string, string> = { reveal: 'Revealed a record', export: 'Exported a list', triage: 'Changed a finding', 'integrity-ack': 'Acknowledged an integrity alert', 'run-launch': 'Launched a run', 'run-stop': 'Stopped a run' };

function Activity() {
  const data = useApi<any>('/api/audit/activity?limit=500');
  const items: any[] = data.data?.items ?? [];
  return (
    <>
      <div className="section-head"><p>What was done through this console. Identifiers only: no transcript text and no prompt is written here.</p></div>
      <Problem error={data.error} />
      <div className="panel table-wrap">
        {items.length === 0 ? (
          <Empty title="Nothing yet">Reveals, exports, triage, acknowledgements and run launches are logged here.</Empty>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              {items.map((a, i) => {
                const { at, action, ...rest } = a;
                return (
                  <tr key={i}>
                    <td className="nowrap" title={fullTime(at)}>{when(at)}</td>
                    <td className="cell-main nowrap">{ACTION[action] ?? action}</td>
                    <td className="mono soft" style={{ overflowWrap: 'anywhere' }}>{Object.entries(rest).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k}=${v}`).join('  ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function Audit({ tab, query }: { tab: string; query: URLSearchParams }) {
  const integrity = useApi<any>('/api/audit/integrity', 'all');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Audit</h1>
          <p className="lede">What the agent ran on this machine, who allowed it, and whether any of it was dangerous.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Audit sections">
        {TABS.map(([key, label]) => (
          <Link key={key} to={key === 'findings' ? '/audit' : `/audit/${key}`} current={tab === key}>
            {label}
            {key === 'integrity' && integrity.data?.open ? <span className="count">{integrity.data.open}</span> : null}
          </Link>
        ))}
      </nav>
      {tab === 'findings' ? <Findings query={query} /> : tab === 'ledger' ? <Ledger query={query} /> : tab === 'integrity' ? <Integrity /> : tab === 'activity' ? <Activity /> : <Empty title="No such section" />}
    </div>
  );
}
