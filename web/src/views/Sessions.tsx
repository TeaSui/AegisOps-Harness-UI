// Sessions: find one from what you remember of it.
import { useEffect, useMemo, useState } from 'react';
import { qs, useApi } from '../api';
import { compact, duration, int, modelName, money, shortPath, tzOffset, when } from '../format';
import { Chips } from '../stage';
import { Calendar, CalendarKey, Plate, ShapeKey, ShapeStrip, type Day } from '../visuals';
import { Empty, Icon, Pill, Problem, Severity, Snippet, navigate, setQuery } from '../ui';

const RANGES: Array<[string, string, number | null]> = [['', 'Any time', null], ['1', 'Last 24 hours', 1], ['7', 'Last 7 days', 7], ['30', 'Last 30 days', 30]];

export function Sessions({ query, facets }: { query: URLSearchParams; facets?: { models: string[]; entrypoints: string[] } }) {
  const q = query.get('q') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (text === q) return;
    const t = window.setTimeout(() => setQuery({ q: text.trim().length >= 2 ? text.trim() : null, offset: null }), 250);
    return () => window.clearTimeout(t);
  }, [text, q]);
  const days = query.get('days');
  const on = Number(query.get('on')) || null;
  const [anchor] = useState(() => Date.now());
  // 26 weeks of days, starting on a Monday
  const span = useMemo(() => {
    const end = new Date(anchor);
    end.setHours(23, 59, 59, 999);
    const start = new Date(anchor);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 25 * 7);
    return { from: start.getTime(), to: end.getTime() };
  }, [anchor]);
  const activity = useApi<any>(`/api/cost/series${qs({ ...span, bucket: 'day', tz: tzOffset() })}`, 'all');
  const calendar: Day[] = useMemo(() => (activity.data?.buckets ?? []).filter((b: any) => b.start >= span.from - 3 * 3_600_000).map((b: any) => ({ start: b.start, cost: b.cost, calls: b.calls })), [activity.data, span.from]);
  const facts = useMemo(() => {
    const active = calendar.filter((d) => d.calls > 0);
    const busiest = active.reduce<Day | null>((m, d) => (!m || d.cost > m.cost ? d : m), null);
    let streak = 0;
    for (let i = calendar.length - 1; i >= 0; i--) {
      if (calendar[i].calls > 0) streak++;
      else if (i < calendar.length - 1) break; // today may simply not have started yet
    }
    return { active: active.length, busiest, streak };
  }, [calendar]);
  const offset = Number(query.get('offset') ?? 0) || 0;
  const limit = 100;
  const projects = useApi<any>('/api/projects');
  const path = `/api/sessions${qs({
    q: q.length >= 2 ? q : null,
    project: query.get('project'),
    model: query.get('model'),
    entrypoint: query.get('entrypoint'),
    risk: query.get('risk'),
    errors: query.get('errors') === '1',
    live: query.get('live') === '1',
    sort: query.get('sort'),
    from: days && !on ? anchor - Number(days) * 86_400_000 : null,
    // a picked day lists the sessions that got a response that day, which is what its cell counts
    callsFrom: on,
    callsTo: on ? on + 86_399_999 : null,
    shape: true,
    limit,
    offset,
  })}`;
  const list = useApi<any>(path, 'all');
  const items: any[] = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const set = (key: string) => (e: React.ChangeEvent<HTMLSelectElement>) => setQuery({ [key]: e.target.value || null, offset: null });
  const toggle = (key: string) => setQuery({ [key]: query.get(key) === '1' ? null : '1', offset: null });
  const filtered = ['q', 'project', 'model', 'entrypoint', 'risk', 'errors', 'live', 'days', 'on'].some((k) => query.get(k));
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Sessions</h1>
          <p className="lede">Every session recorded on this machine. Search covers prompts, replies and commands.</p>
        </div>
      </div>
      {calendar.length ? (
        <Plate title="Activity" note="Spend per day over the last 26 weeks. Pick a day to list its sessions." aside={<CalendarKey />}>
          <div className="plate-row">
            <div className="flow-wrap"><Calendar days={calendar} selected={on} onPick={(start) => setQuery({ on: start === null ? null : String(start), days: null, offset: null })} /></div>
            <div className="facts">
              <Chips
                items={[
                  { label: 'Active days', value: `${int(facts.active)} of ${int(calendar.length)}` },
                  { label: 'Days in a row', value: int(facts.streak), note: 'up to today' },
                  { label: 'Busiest day', value: facts.busiest ? money(facts.busiest.cost) : '—', note: facts.busiest ? new Date(facts.busiest.start + 43_200_000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : undefined },
                  { label: 'Spend, 26 weeks', value: money(activity.data?.totals.cost), note: `${compact(activity.data?.totals.calls)} responses` },
                ]}
              />
            </div>
          </div>
        </Plate>
      ) : null}
      <div className="filters">
        <input data-filter className="field grow" type="search" value={text} placeholder="Search what was said or run   /" aria-label="Search sessions" onChange={(e) => setText(e.target.value)} />
        <select className="field" value={query.get('project') ?? ''} onChange={set('project')} aria-label="Project">
          <option value="">All projects</option>
          {(projects.data?.items ?? []).map((p: any) => (
            <option key={p.id} value={p.id}>{shortPath(p.cwd) || p.id}</option>
          ))}
        </select>
        <select className="field" value={query.get('model') ?? ''} onChange={set('model')} aria-label="Model">
          <option value="">All models</option>
          {(facets?.models ?? []).map((m) => <option key={m} value={m}>{modelName(m)}</option>)}
        </select>
        <select className="field" value={query.get('entrypoint') ?? ''} onChange={set('entrypoint')} aria-label="Entry point">
          <option value="">Any entry point</option>
          {(facets?.entrypoints ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {on ? <button className="btn small" onClick={() => setQuery({ on: null, offset: null })}>{new Date(on + 43_200_000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} only<Icon name="close" size={13} /></button> : null}
        <select className="field" value={days ?? ''} onChange={(e) => setQuery({ days: e.target.value || null, on: null, offset: null })} aria-label="Time range">
          {RANGES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        <select className="field" value={query.get('risk') ?? ''} onChange={set('risk')} aria-label="Risk">
          <option value="">Any risk</option>
          <option value="medium">Medium risk or higher</option>
          <option value="high">High risk or higher</option>
          <option value="critical">Critical risk</option>
        </select>
        <div className="seg">
          <button aria-pressed={query.get('errors') === '1'} onClick={() => toggle('errors')}>With errors</button>
          <button aria-pressed={query.get('live') === '1'} onClick={() => toggle('live')}>Running</button>
        </div>
        <select className="field" value={query.get('sort') ?? ''} onChange={set('sort')} aria-label="Sort">
          <option value="">Latest first</option>
          <option value="cost">Most expensive first</option>
          <option value="duration">Longest first</option>
        </select>
      </div>
      <Problem error={text.trim().length === 1 ? null : list.error} />
      <div className="panel table-wrap">
        {items.length === 0 && !list.loading ? (
          <Empty title={filtered ? 'No session matches these filters' : 'No sessions yet'}>
            {filtered ? <button className="linkish" onClick={() => navigate('/sessions')}>Clear the filters</button> : 'Sessions appear here as soon as Claude Code writes a transcript.'}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Shape <span className="sr">of the session, start to end</span></th>
                <th>Last active</th>
                <th className="r">Length</th>
                <th>Model</th>
                <th className="r">Tools</th>
                <th className="r">Cost</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const trouble = s.toolErrors + s.apiErrors + s.hookFailures;
                return (
                  <tr key={s.id} data-row onClick={() => navigate(`/sessions/${encodeURIComponent(s.id)}`)}>
                    <td style={{ maxWidth: 360 }}>
                      <div className="cell-main clip">
                        {s.live ? <span className="dot busy" style={{ display: 'inline-block', marginRight: 7 }} title="Running" /> : null}
                        {s.title}
                      </div>
                      <div className="cell-sub clip" title={s.cwd}>
                        {shortPath(s.cwd) || s.project}{s.gitBranch ? ` on ${s.gitBranch}` : ''}{s.entrypoint && s.entrypoint !== 'cli' ? `, ${s.entrypoint}` : ''}{s.subagents ? `, ${s.subagents} subagent${s.subagents === 1 ? '' : 's'}` : ''}
                      </div>
                      {(s.snippets ?? []).map((sn: any, i: number) => (
                        <div className="snip clip" key={i}><span className="tag">{sn.kind === 'tool' ? 'command' : sn.kind}</span> <Snippet text={sn.text} /></div>
                      ))}
                    </td>
                    <td style={{ verticalAlign: 'middle' }}><ShapeStrip shape={s.shape} /></td>
                    <td className="nowrap" title={new Date(s.lastTs).toLocaleString()}>{when(s.lastTs)}</td>
                    <td className="r">{duration(s.durationMs)}</td>
                    <td className="nowrap">{s.models.length ? modelName(s.models[0]) : '—'}{s.models.length > 1 ? <span className="muted"> +{s.models.length - 1}</span> : null}</td>
                    <td className="r">
                      {int(s.toolCalls)}
                      {trouble ? <div className="cell-sub" style={{ color: 'var(--critical)' }}>{trouble} failed</div> : null}
                    </td>
                    <td className="r">
                      {money(s.cost)}
                      {s.unpricedCalls ? <div className="cell-sub" title="Responses from a model with no price are not in the cost">{s.unpricedCalls} unpriced</div> : null}
                    </td>
                    <td>{s.risk ? <Severity level={s.risk} /> : <span className="muted">none</span>}{s.openFindings ? <div className="cell-sub">{s.openFindings} open</div> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="filters" style={{ marginTop: 12 }}>
        <span className="muted">{total ? `${int(offset + 1)} to ${int(Math.min(total, offset + items.length))} of ${int(total)}` : ''}</span>
        <ShapeKey />
        <span style={{ flex: 1 }} />
        {offset > 0 ? <button className="btn small" onClick={() => setQuery({ offset: String(Math.max(0, offset - limit)) || null })}>Newer</button> : null}
        {offset + items.length < total ? <button className="btn small" onClick={() => setQuery({ offset: String(offset + limit) })}>Older</button> : null}
      </div>
    </div>
  );
}
void Pill;
