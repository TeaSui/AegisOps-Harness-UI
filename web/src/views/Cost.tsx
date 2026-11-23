// Cost: where the money goes. Figures are estimates from tokens at the harness's own price table;
// responses from a model with no price are counted, never priced.
import { useMemo, useState } from 'react';
import { qs, useApi } from '../api';
import { Columns, Meter, OTHER, SLOTS, type Series } from '../charts';
import { compact, dayLabel, hourLabel, int, modelName, money, percent, shortPath, tzOffset, when } from '../format';
import { Empty, Mark, Problem, navigate, setQuery } from '../ui';
import { MoneyFlow, Plate } from '../visuals';

const GROUPS: Array<[string, string]> = [['model', 'Model'], ['project', 'Project'], ['skill', 'Skill'], ['plugin', 'Plugin'], ['agent', 'Agent type']];
const RANGES: Array<[string, string]> = [['1', 'Today, by hour'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
const MAX_SERIES = 6;

export function Cost({ query }: { query: URLSearchParams }) {
  const group = query.get('group') ?? 'model';
  const days = query.get('days') ?? '30';
  const [table, setTable] = useState(false);
  const range = useMemo(() => {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (Number(days) - 1));
    return { from: start.getTime(), to: end.getTime(), bucket: days === '1' ? 'hour' : 'day' };
  }, [days]);
  const series = useApi<any>(`/api/cost/series${qs({ ...range, group, tz: tzOffset() })}`, 'all');
  const top = useApi<any>(`/api/cost/top${qs({ from: range.from, to: range.to, limit: 12, tz: tzOffset() })}`, 'all');
  const projects = useApi<any>('/api/projects');
  const flow = useApi<any>(`/api/cost/flow${qs({ from: range.from, to: range.to, tz: tzOffset() })}`, 'all');
  const flowNames = useMemo(
    () => ({
      project: (k: string) => shortPath((projects.data?.items ?? []).find((p: any) => p.id === k)?.cwd) || k,
      model: (k: string) => (k === '(none)' ? 'No model recorded' : modelName(k)),
      agent: (k: string) => (k === 'main' ? 'Main thread' : k),
    }),
    [projects.data],
  );
  const d = series.data;
  const groupLabel = GROUPS.find((g) => g[0] === group)?.[1] ?? 'Model';
  const name = (key: string) => {
    if (group === 'model') return key === '(none)' ? 'No model recorded' : modelName(key);
    if (group === 'project') return shortPath((projects.data?.items ?? []).find((p: any) => p.id === key)?.cwd) || key;
    if (key === '(none)') return group === 'skill' ? 'No skill active' : group === 'plugin' ? 'No plugin' : key;
    return key;
  };
  // Colour follows the group, in the order of spend over the whole range; the rest fold into "Other".
  const shown: Series[] = useMemo(() => {
    const groups: any[] = d?.groups ?? [];
    const head = groups.slice(0, MAX_SERIES).map((g, i) => ({ key: g.key, label: name(g.key), color: SLOTS[i] }));
    return groups.length > MAX_SERIES ? [...head, { key: '__other', label: `${groups.length - MAX_SERIES} others`, color: OTHER }] : head;
  }, [d, group, projects.data]);
  const columns = useMemo(() => {
    const keys = new Set(shown.map((s) => s.key));
    return (d?.buckets ?? []).map((b: any) => {
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries<any>(b.groups)) {
        const slot = keys.has(k) ? k : '__other';
        values[slot] = (values[slot] ?? 0) + v.cost;
      }
      return {
        start: b.start,
        label: range.bucket === 'hour' ? hourLabel(b.start) : dayLabel(b.start),
        values,
        note: `${int(b.calls)} responses${b.unpriced ? `, ${b.unpriced} unpriced` : ''}, ${percent(b.cacheShare)} of input from cache`,
      };
    });
  }, [d, shown, range.bucket]);
  const maxCost = Math.max(0, ...(d?.groups ?? []).map((g: any) => g.cost));
  const t = d?.totals;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Cost</h1>
          <p className="lede">Spend estimated from tokens at the harness's own price table. Nothing is priced by guess.</p>
        </div>
      </div>
      <div className="filters">
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map(([v, label]) => (
            <button key={v} aria-pressed={days === v} onClick={() => setQuery({ days: v === '30' ? null : v })}>{label}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Group by">
          {GROUPS.map(([v, label]) => (
            <button key={v} aria-pressed={group === v} onClick={() => setQuery({ group: v === 'model' ? null : v })}>{label}</button>
          ))}
        </div>
      </div>
      <Problem error={series.error} />
      {t ? (
        <dl className="stats">
          <div className="stat"><dt>Spend</dt><dd className="num">{money(t.cost)}</dd><small>estimated from tokens</small></div>
          <div className="stat">
            <dt>Responses</dt>
            <dd className="num">{int(t.calls)}</dd>
            <small>{t.unpriced ? <Mark tone="warn">{int(t.unpriced)} have no price and are not in the spend</Mark> : 'every response is priced'}</small>
          </div>
          <div className="stat"><dt>Tokens out</dt><dd className="num">{compact(t.output)}</dd><small>{compact(t.input)} new tokens in</small></div>
          <div className="stat"><dt>Input from cache</dt><dd className="num">{percent(t.cacheShare)}</dd><small>{compact(t.cacheRead)} read, {compact(t.cacheWrite)} written</small></div>
        </dl>
      ) : null}

      {flow.data && flow.data.total > 0 ? (
        <div className="section">
          <Plate title="Where the money goes" note="Each band is as wide as the spend it carries: from a project, through a model, to the main thread or a kind of subagent.">
            <MoneyFlow rows={flow.data.rows} names={flowNames} />
          </Plate>
        </div>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>Spend per {range.bucket === 'hour' ? 'hour' : 'day'}, by {groupLabel.toLowerCase()}</h2>
          <span className="spacer" />
          <button className="btn small quiet" onClick={() => setTable(!table)}>{table ? 'Show the chart' : 'Show as a table'}</button>
        </div>
        <div className="panel pad">
          {!d ? (
            <div style={{ height: 240 }} />
          ) : t.calls === 0 ? (
            <Empty title="No responses in this range">Pick a longer range, or run a session.</Empty>
          ) : table ? (
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>{range.bucket === 'hour' ? 'Hour' : 'Day'}</th>
                    {shown.map((s) => <th className="r" key={s.key}>{s.label}</th>)}
                    <th className="r">Total</th>
                    <th className="r">From cache</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c: any, i: number) => (
                    <tr key={c.start}>
                      <td>{c.label}</td>
                      {shown.map((s) => <td className="r" key={s.key}>{c.values[s.key] ? money(c.values[s.key]) : ''}</td>)}
                      <td className="r">{money(d.buckets[i].cost)}</td>
                      <td className="r">{percent(d.buckets[i].cacheShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Columns columns={columns} series={shown} format={money} tickFormat={(v) => `$${v >= 1000 ? compact(v) : v}`} height={260} />
          )}
        </div>
      </section>

      <div className="split section">
        <section>
          <div className="section-head"><h2>By {groupLabel.toLowerCase()}</h2></div>
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr><th>{groupLabel}</th><th style={{ width: '22%' }} /><th className="r">Spend</th><th className="r">Responses</th><th className="r">Tokens out</th><th className="r">From cache</th></tr>
              </thead>
              <tbody>
                {(d?.groups ?? []).map((g: any, i: number) => (
                  <tr key={g.key}>
                    <td>
                      <span className="swatch" style={{ background: i < MAX_SERIES ? SLOTS[i] : OTHER, marginRight: 8 }} />
                      <span title={g.key}>{name(g.key)}</span>
                    </td>
                    <td style={{ verticalAlign: 'middle' }}><Meter value={g.cost} max={maxCost} color={i < MAX_SERIES ? SLOTS[i] : OTHER} /></td>
                    <td className="r">{g.calls === g.unpriced ? <span className="muted">no price</span> : money(g.cost)}</td>
                    <td className="r">{int(g.calls)}{g.unpriced && g.unpriced !== g.calls ? <div className="cell-sub">{g.unpriced} unpriced</div> : null}</td>
                    <td className="r">{compact(g.output)}</td>
                    <td className="r">{percent(g.cacheShare)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d?.repricing.length ? (
            <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
              The harness's price table changed {d.repricing.length === 1 ? 'once' : `${d.repricing.length} times`}; stored costs were recomputed, last on {when(d.repricing[0].at)}.
            </p>
          ) : null}
        </section>
        <section>
          <div className="section-head"><h2>Most expensive sessions</h2></div>
          <div className="panel table-wrap">
            {(top.data?.items ?? []).length === 0 ? (
              <Empty title="No sessions in this range" />
            ) : (
              <table>
                <tbody>
                  {top.data.items.map((s: any) => (
                    <tr key={s.session} data-row onClick={() => navigate(`/sessions/${encodeURIComponent(s.session)}`)}>
                      <td style={{ maxWidth: 300 }}>
                        <div className="cell-main clip">{s.title}</div>
                        <div className="cell-sub clip">{shortPath(s.cwd) || s.project}, {when(s.lastTs)}</div>
                      </td>
                      <td className="r">{money(s.cost)}<div className="cell-sub">{int(s.calls)} responses</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
