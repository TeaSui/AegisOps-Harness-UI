// Pictures that sit above the tables: the shape of a session, a calendar of activity, where the money
// flows, and when risky things happened. Plain SVG and HTML, themed by CSS; every mark has a text twin
// in the table below it.
import { useMemo, useState, type ReactNode } from 'react';
import { OTHER, SLOTS } from './charts';
import { dayLabel, int, money } from './format';

/** Arrow keys walk the marks of a picture, so it costs the keyboard one tab stop instead of one per mark. */
function rove(e: React.KeyboardEvent<SVGSVGElement>) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  const marks = Array.from(e.currentTarget.querySelectorAll<SVGElement>('[role="button"]'));
  const next = marks[marks.indexOf(document.activeElement as SVGElement) + step];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

// ---- the shape of a session ---------------------------------------------------------------------------------

const RANK_CLASS = ['b-talk', 'b-tool', 'b-prompt', 'b-problem'];
const SHAPE_SLOTS = 32;

/** A session's events in order, as a strip: short ticks are responses, taller ones tool calls, full ones your prompts and failures. */
export function ShapeStrip({ shape }: { shape: number[] | undefined }) {
  if (!shape || shape.length === 0) return <span className="muted">—</span>;
  const failures = shape.filter((r) => r === 3).length;
  const prompts = shape.filter((r) => r === 2).length;
  return (
    <svg className="shape" viewBox={`0 0 ${SHAPE_SLOTS} 10`} preserveAspectRatio="none" role="img" aria-label={`Shape of the session: ${prompts} stretch${prompts === 1 ? '' : 'es'} with a prompt, ${failures} with a failure`}>
      {shape.map((r, i) => <rect key={i} className={RANK_CLASS[r] ?? RANK_CLASS[0]} x={i + 0.14} y={r === 0 ? 6 : r === 1 ? 3 : 0} width={0.72} height={r === 0 ? 4 : r === 1 ? 7 : 10} />)}
    </svg>
  );
}

export function ShapeKey() {
  return (
    <span className="shape-key" aria-hidden="true">
      <span><i className="k-prompt" />your prompt</span>
      <span><i className="k-tool" />tool calls</span>
      <span><i className="k-talk" />responses</span>
      <span><i className="k-problem" />a failure</span>
    </span>
  );
}

// ---- calendar of activity ---------------------------------------------------------------------------------------

export type Day = { start: number; cost: number; calls: number };
const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Days as a grid of weeks, shaded by spend in five steps set by the quartiles of the days that had any. */
export function Calendar({ days, selected, onPick }: { days: Day[]; selected: number | null; onPick: (start: number | null) => void }) {
  const { weeks, level, months } = useMemo(() => {
    const active = days.filter((d) => d.calls > 0).map((d) => d.cost).sort((a, b) => a - b);
    const q = (p: number) => active[Math.min(active.length - 1, Math.floor(p * active.length))] ?? 0;
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const level = (d: Day) => (d.calls === 0 ? 0 : d.cost <= cuts[0] ? 1 : d.cost <= cuts[1] ? 2 : d.cost <= cuts[2] ? 3 : 4);
    const weeks: Array<Array<Day | null>> = [];
    for (const d of days) {
      const weekday = (new Date(d.start + DAY / 2).getDay() + 6) % 7; // Monday first
      if (weeks.length === 0 || weekday === 0) weeks.push(new Array(7).fill(null));
      weeks[weeks.length - 1][weekday] = d;
    }
    const months: Array<{ at: number; label: string }> = [];
    weeks.forEach((w, i) => {
      const first = w.find(Boolean) as Day;
      const m = new Date(first.start + DAY / 2).getMonth();
      const before = i > 0 ? new Date((weeks[i - 1].find(Boolean) as Day).start + DAY / 2).getMonth() : -1;
      if (m !== before) months.push({ at: i, label: MONTHS[m] });
    });
    // a first week that only catches the tail of a month would print its name on top of the next one
    if (months.length > 1 && months[1].at - months[0].at < 3) months.shift();
    return { weeks, level, months };
  }, [days]);
  const cell = 13;
  const gap = 3;
  const left = 30;
  const top = 18;
  const w = left + weeks.length * (cell + gap);
  const h = top + 7 * (cell + gap);
  const active = days.filter((d) => d.calls > 0);
  const stop = selected ?? active[active.length - 1]?.start;
  // a day is named by its noon: a bucket that starts an hour early or late around a clock change keeps its date
  const dateOf = (d: Day, options?: Intl.DateTimeFormatOptions) => new Date(d.start + DAY / 2).toLocaleDateString(undefined, options);
  return (
    <svg className="calendar" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="group" aria-label="Spend per day. Arrow keys move between days; Enter lists the sessions of a day." onKeyDown={rove}>
      {months.map((m) => <text key={`${m.at}`} x={left + m.at * (cell + gap)} y={11}>{m.label}</text>)}
      {['Mon', 'Wed', 'Fri'].map((d, i) => <text key={d} x={0} y={top + (i * 2) * (cell + gap) + 10.5}>{d}</text>)}
      {weeks.map((week, x) =>
        week.map((d, y) =>
          d ? (
            <rect
              key={d.start}
              className={`day l${level(d)}${selected === d.start ? ' picked' : ''}`}
              x={left + x * (cell + gap)}
              y={top + y * (cell + gap)}
              width={cell}
              height={cell}
              rx={3}
              tabIndex={d.calls ? (d.start === stop ? 0 : -1) : undefined}
              role={d.calls ? 'button' : undefined}
              aria-pressed={d.calls ? selected === d.start : undefined}
              aria-label={d.calls ? `${dateOf(d)}: ${money(d.cost)}, ${int(d.calls)} responses` : undefined}
              onClick={() => (d.calls ? onPick(selected === d.start ? null : d.start) : undefined)}
              onKeyDown={(e) => {
                if (d.calls && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onPick(selected === d.start ? null : d.start);
                }
              }}
            >
              <title>{`${dateOf(d, { weekday: 'short', day: 'numeric', month: 'short' })}: ${d.calls ? `${money(d.cost)}, ${int(d.calls)} responses` : 'nothing ran'}`}</title>
            </rect>
          ) : null,
        ),
      )}
    </svg>
  );
}

export function CalendarKey() {
  return (
    <span className="calendar-key" aria-hidden="true">
      less {[0, 1, 2, 3, 4].map((l) => <i key={l} className={`day l${l}`} />)} more
    </span>
  );
}

// ---- where the money flows ----------------------------------------------------------------------------------------

export type FlowRow = { project: string; model: string; agent: string; cost: number; calls: number };
type Node = { key: string; label: string; cost: number; y: number; h: number; color: string; out: number; in: number };

const KEEP = 6;

/** Keeps the largest few keys of one column and folds the rest into one. */
function fold(rows: FlowRow[], field: 'project' | 'model' | 'agent') {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r[field], (sums.get(r[field]) ?? 0) + r.cost);
  const ordered = [...sums.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = new Set(ordered.slice(0, KEEP).map(([k]) => k));
  const rest = ordered.length - kept.size;
  return { order: [...kept], rest, of: (key: string) => (kept.has(key) ? key : '\u0000rest') };
}

/** Three columns (project, model, who spent it) joined by bands as wide as the spend they carry. */
export function MoneyFlow({ rows, names }: { rows: FlowRow[]; names: { project: (k: string) => string; model: (k: string) => string; agent: (k: string) => string } }) {
  const [hover, setHover] = useState<string | null>(null);
  const built = useMemo(() => {
    const priced = rows.filter((r) => r.cost > 0);
    const total = priced.reduce((n, r) => n + r.cost, 0);
    if (total <= 0) return null;
    const cols = (['project', 'model', 'agent'] as const).map((f) => fold(priced, f));
    const H = 360;
    const gap = 8;
    const slot = 20; // the least room a part gets, so its one-line label never sits on its neighbour's
    const field = ['project', 'model', 'agent'] as const;
    const keysOf = cols.map((c) => (c.rest ? [...c.order, '\u0000rest'] : c.order));
    const costs = cols.map((c, ci) => keysOf[ci].map((key) => priced.filter((r) => c.of(r[field[ci]]) === key).reduce((n, r) => n + r.cost, 0)));
    const fits = (k: number) => costs.every((column) => column.reduce((n, v) => n + Math.max(slot, v * k), 0) + gap * (column.length - 1) <= H);
    let lo = 0;
    let hi = H / total;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    const scale = lo;
    const restLabel = [(n: number) => `${n} other projects`, (n: number) => `${n} other models`, (n: number) => `${n} other kinds`];
    const label = [names.project, names.model, names.agent];
    const nodes = cols.map((c, ci) => {
      let y = 0;
      const column = keysOf[ci].map((key, i): Node => {
        const cost = costs[ci][i];
        const h = Math.max(1.5, cost * scale);
        const room = Math.max(slot, h);
        const node = { key, label: key === '\u0000rest' ? restLabel[ci](c.rest) : label[ci](key), cost, y: y + (room - h) / 2, h, color: ci === 1 ? (key === '\u0000rest' ? OTHER : SLOTS[i] ?? OTHER) : 'var(--ink-3)', out: 0, in: 0 };
        y += room + gap;
        return node;
      });
      const offset = (H - (y - gap)) / 2;
      for (const n of column) n.y += offset;
      return column;
    });
    const find = (ci: number, key: string) => nodes[ci].find((n) => n.key === key)!;
    const pair = (a: 0 | 1, fa: 'project' | 'model', fb: 'model' | 'agent') => {
      const sums = new Map<string, number>();
      for (const r of priced) {
        const k = `${cols[a].of(r[fa])}\u0001${cols[a + 1].of(r[fb])}`;
        sums.set(k, (sums.get(k) ?? 0) + r.cost);
      }
      const order = (ci: number, key: string) => nodes[ci].findIndex((n) => n.key === key);
      return [...sums.entries()]
        .map(([k, cost]) => ({ from: k.split('\u0001')[0], to: k.split('\u0001')[1], cost }))
        .sort((p, q) => order(a, p.from) - order(a, q.from) || order(a + 1, p.to) - order(a + 1, q.to))
        .map((l) => ({ ...l, a, source: find(a, l.from), target: find(a + 1, l.to) }));
    };
    const links = [...pair(0, 'project', 'model'), ...pair(1, 'model', 'agent')].map((l) => {
      const t = Math.max(1, l.cost * scale);
      const y0 = l.source.y + l.source.out + t / 2;
      l.source.out += l.cost * scale;
      return { ...l, t, y0, y1: 0 };
    });
    // the far end of each band is stacked in the order of where it comes from
    for (const a of [0, 1]) {
      for (const target of nodes[a + 1]) {
        for (const l of links.filter((x) => x.a === a && x.target === target)) {
          l.y1 = target.y + target.in + l.t / 2;
          target.in += l.cost * scale;
        }
      }
    }
    return { nodes, links, total, H };
  }, [rows, names]);
  if (!built) return null;
  const X = [250, 550, 850];
  const W = 1130;
  const nodeW = 12;
  const share = (v: number) => `${((v / built.total) * 100).toFixed(v / built.total < 0.1 ? 1 : 0)}%`;
  return (
    <div className="flow-wrap">
      <svg className="flow" viewBox={`0 -26 ${W} ${built.H + 36}`} role="img" aria-label="Spend flowing from projects, through models, to the main thread and subagents. Each band and post names its amount.">
        {['Project', 'Model', 'Spent by'].map((t, i) => <text key={t} className="head" x={i === 0 ? X[0] + nodeW : i === 1 ? X[1] + nodeW / 2 : X[2]} y={-10} textAnchor={i === 0 ? 'end' : i === 1 ? 'middle' : 'start'}>{t}</text>)}
        {built.links.map((l) => {
          const x0 = X[l.a] + nodeW;
          const x1 = X[l.a + 1];
          const mid = (x0 + x1) / 2;
          const id = `${l.a}:${l.from}:${l.to}`;
          const model = l.a === 0 ? l.target : l.source;
          const lit = hover === null || hover === id || hover === `n:${l.a}:${l.from}` || hover === `n:${l.a + 1}:${l.to}`;
          return (
            <path key={id} className={`band${lit ? '' : ' faint'}`} d={`M${x0},${l.y0.toFixed(1)} C${mid},${l.y0.toFixed(1)} ${mid},${l.y1.toFixed(1)} ${x1},${l.y1.toFixed(1)}`} stroke={model.color} strokeWidth={l.t.toFixed(1)} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}>
              <title>{`${l.source.label} → ${l.target.label}: ${money(l.cost)} (${share(l.cost)})`}</title>
            </path>
          );
        })}
        {built.nodes.map((column, ci) =>
          column.map((n) => (
            <g key={`${ci}:${n.key}`} onMouseEnter={() => setHover(`n:${ci}:${n.key}`)} onMouseLeave={() => setHover(null)}>
              <rect className="post" x={X[ci]} y={n.y} width={nodeW} height={n.h} rx={2} fill={n.color} />
              {n.h >= 30 ? (
                <>
                  <text x={ci === 0 ? X[0] - 8 : X[ci] + nodeW + 8} y={n.y + n.h / 2 - 2} textAnchor={ci === 0 ? 'end' : 'start'} className="name">{n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label}</text>
                  <text x={ci === 0 ? X[0] - 8 : X[ci] + nodeW + 8} y={n.y + n.h / 2 + 12} textAnchor={ci === 0 ? 'end' : 'start'} className="amount">{money(n.cost)}, {share(n.cost)}</text>
                </>
              ) : (
                <text x={ci === 0 ? X[0] - 8 : X[ci] + nodeW + 8} y={n.y + n.h / 2 + 4} textAnchor={ci === 0 ? 'end' : 'start'} className="name">
                  {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label} <tspan className="amount">{money(n.cost)}</tspan>
                </text>
              )}
              <title>{`${n.label}: ${money(n.cost)} (${share(n.cost)})`}</title>
            </g>
          )),
        )}
      </svg>
    </div>
  );
}

// ---- when risky things happened ------------------------------------------------------------------------------------

export type Dot = { id: string; ts: number; severity: string; state: string; title: string; evidence: string; session: string };
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const STACK = 16;

/** One column per day, one square per finding, the worst at the bottom where the eye lands first. Hollow means acknowledged. */
export function RiskTimeline({ dots, days, now, onPick }: { dots: Dot[]; days: number; now: number; onPick: (d: Dot) => void }) {
  const { columns, start } = useMemo(() => {
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    const first = new Date(end);
    first.setDate(first.getDate() - (days - 1));
    const start = first.getTime();
    const columns: Dot[][] = Array.from({ length: days }, () => []);
    for (const d of dots) {
      // by local calendar day, so a day that is 23 or 25 hours long still gets one column
      const day = new Date(d.ts);
      day.setHours(0, 0, 0, 0);
      const i = Math.round((day.getTime() - start) / DAY);
      if (i >= 0 && i < days) columns[i].push(d);
    }
    for (const c of columns) c.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.ts - b.ts);
    return { columns, start };
  }, [dots, days, now]);
  const size = 9;
  const pitch = 11;
  const colW = 13;
  const H = STACK * pitch + 4;
  const W = days * colW;
  return (
    <div className="flow-wrap">
      <svg className="risk" style={{ width: Math.round(W * 1.15) }} viewBox={`0 0 ${W} ${H + 20}`} role="group" aria-label={`Findings per day over the last ${days} days. Arrow keys move between findings; Enter opens the findings of that session.`} onKeyDown={rove}>
        <line className="base" x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} />
        {columns.map((column, i) => {
          const firstMark = columns.findIndex((c) => c.length > 0);
          const x = i * colW + (colW - size) / 2;
          const day = new Date(start).setDate(new Date(start).getDate() + i);
          const shown = column.slice(0, column.length > STACK ? STACK - 1 : STACK);
          const tick = new Date(day).getDay() === 1;
          return (
            <g key={i}>
              {tick ? <text x={i * colW} y={H + 15}>{dayLabel(day)}</text> : null}
              {tick ? <line className="week" x1={i * colW} x2={i * colW} y1={0} y2={H} /> : null}
              {shown.map((d, j) => (
                <rect
                  key={d.id}
                  className={`f ${d.severity}${d.state === 'open' ? '' : ' done'}`}
                  x={x}
                  y={H - (j + 1) * pitch}
                  width={size}
                  height={size}
                  rx={2}
                  tabIndex={i === firstMark && j === 0 ? 0 : -1}
                  role="button"
                  aria-label={`${d.severity}, ${d.state}: ${d.title}, ${new Date(d.ts).toLocaleDateString()}`}
                  onClick={() => onPick(d)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onPick(d);
                    }
                  }}
                >
                  <title>{`${d.severity} (${d.state}): ${d.title}\n${d.evidence.replace(/\s+/g, ' ').slice(0, 140)}\n${new Date(d.ts).toLocaleString()}`}</title>
                </rect>
              ))}
              {column.length > STACK ? <text className="more" x={i * colW + colW / 2} y={H - (STACK - 1) * pitch - 4} textAnchor="middle">+{column.length - (STACK - 1)}</text> : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---- where the agent worked ---------------------------------------------------------------------------------------

export type Heat = { path: string; read: number; edit: number; write: number; sessions: number; files?: number };
type Box = { item: Heat; x: number; y: number; w: number; h: number };

/** The squarified layout: fills the frame row by row, keeping each tile as close to a square as its row allows. */
function squarify(items: Heat[], W: number, H: number): Box[] {
  const size = (f: Heat) => f.read + f.edit + f.write;
  const total = items.reduce((n, f) => n + size(f), 0);
  if (total <= 0) return [];
  const scale = (W * H) / total;
  const out: Box[] = [];
  let x = 0, y = 0, w = W, h = H;
  let row: Heat[] = [];
  const worst = (r: Heat[], side: number) => {
    const sum = r.reduce((n, f) => n + size(f) * scale, 0);
    const big = Math.max(...r.map((f) => size(f) * scale));
    const small = Math.min(...r.map((f) => size(f) * scale));
    return Math.max((side * side * big) / (sum * sum), (sum * sum) / (side * side * small));
  };
  const flush = () => {
    const sum = row.reduce((n, f) => n + size(f) * scale, 0);
    if (w >= h) {
      const rw = sum / h;
      let cy = y;
      for (const f of row) { const rh = (size(f) * scale) / rw; out.push({ item: f, x, y: cy, w: rw, h: rh }); cy += rh; }
      x += rw; w -= rw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (const f of row) { const rw = (size(f) * scale) / rh; out.push({ item: f, x: cx, y, w: rw, h: rh }); cx += rw; }
      y += rh; h -= rh;
    }
    row = [];
  };
  for (const f of [...items].sort((p, q) => size(q) - size(p))) {
    const side = Math.min(w, h);
    if (row.length && worst([...row, f], side) > worst(row, side)) flush();
    row.push(f);
  }
  if (row.length) flush();
  return out;
}

export const heatKind = (f: Heat) => (f.edit + f.write === 0 ? 'read' : (f.edit + f.write) * 2 >= f.read + f.edit + f.write ? 'changed' : 'mixed');
/** A file by its name, a folder by its last two parts. */
const tileName = (p: string, folder: boolean) => (folder ? p.split('/').filter(Boolean).slice(-2).join('/') || p : p.slice(p.lastIndexOf('/') + 1) || p);

/** Files as tiles sized by how often they were touched, tinted by whether they were only read or also changed. */
export function Treemap({ items, folders, onPick }: { items: Heat[]; folders: boolean; onPick: (f: Heat) => void }) {
  const W = 1100;
  const H = 440;
  const boxes = useMemo(() => squarify(items, W, H), [items]);
  return (
    <svg className="tree" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Files or folders sized by how often the agent touched them. Arrow keys move between tiles; Enter opens one." onKeyDown={rove}>
      {boxes.map((b, i) => {
        const f = b.item;
        const n = f.read + f.edit + f.write;
        const name = tileName(f.path, folders);
        const fit = Math.floor((b.w - 12) / 6.6);
        const said = `${f.path}${folders ? ` (${int(f.files ?? 0)} files)` : ''}: read ${int(f.read)}, edited ${int(f.edit)}, written ${int(f.write)}, in ${int(f.sessions)} session${f.sessions === 1 ? '' : 's'}`;
        return (
          <g key={f.path}>
            <rect
              className={heatKind(f)}
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={4}
              role="button"
              tabIndex={i === 0 ? 0 : -1}
              aria-label={said}
              onClick={() => onPick(f)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onPick(f);
                }
              }}
            >
              <title>{said}</title>
            </rect>
            {b.h >= 22 && fit >= 4 ? <text x={b.x + 7} y={b.y + 16}>{name.length > fit ? `${name.slice(0, fit - 1)}…` : name}</text> : null}
            {b.h >= 38 && fit >= 4 ? <text className="n" x={b.x + 7} y={b.y + 31}>{int(n)}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

/** A titled card with the stage's drafting-paper ground, for a picture that leads a view. */
export function Plate({ title, note, aside, children }: { title: string; note?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="plate" aria-label={title}>
      <header>
        <h2>{title}</h2>
        {note ? <p>{note}</p> : null}
        <span className="spacer" />
        {aside}
      </header>
      <div className="plate-body">{children}</div>
    </section>
  );
}
