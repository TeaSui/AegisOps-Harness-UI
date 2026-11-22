// Charts drawn as plain SVG. Marks are thin, grids recessive, text wears text colours, and every
// chart answers hover with the values under the pointer. Series colours are fixed slots, in order.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
export const OTHER = 'var(--s-other)';

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Round axis maximum and 3 or 4 clean ticks. */
export function niceScale(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const step = [1, 2, 2.5, 5, 10].map((m) => (m * pow) / 2).find((s) => max / s <= 4) ?? pow * 5;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Number(v.toPrecision(12)));
  return { top, ticks };
}

export type Series = { key: string; label: string; color: string };
export type Column = { start: number; label: string; values: Record<string, number>; note?: string };

type Tip = { x: number; y: number; column: Column } | null;

/**
 * Stacked columns over time: one baseline, a 2px surface gap between segments, rounded only at the top.
 * A single series draws plain columns and needs no legend.
 */
export function Columns({ columns, series, format, height = 220, tickFormat }: { columns: Column[]; series: Series[]; format: (v: number) => string; height?: number; tickFormat?: (v: number) => string }) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<Tip>(null);
  const m = { top: 10, right: 8, bottom: 22, left: 46 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;
  const totals = columns.map((c) => series.reduce((s, x) => s + (c.values[x.key] ?? 0), 0));
  const { top, ticks } = niceScale(Math.max(0, ...totals));
  const band = columns.length ? w / columns.length : 0;
  const bar = Math.max(1, Math.min(24, band - 3));
  const y = (v: number) => m.top + h - (v / top) * h;
  const every = Math.max(1, Math.ceil(columns.length / Math.max(1, Math.floor(w / 62))));
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setTip(null)}>
      {width > 0 ? (
        <svg height={height} role="img" aria-label="Chart; the same numbers are in the table below">
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'axis' : 'grid'} x1={m.left} x2={m.left + w} y1={y(t)} y2={y(t)} />
              <text x={m.left - 8} y={y(t) + 4} textAnchor="end">{(tickFormat ?? format)(t)}</text>
            </g>
          ))}
          {columns.map((c, i) => {
            const cx = m.left + band * i + band / 2;
            let acc = 0;
            const segments = series.filter((s) => (c.values[s.key] ?? 0) > 0);
            return (
              <g key={c.start}>
                {segments.map((s, j) => {
                  const v = c.values[s.key];
                  const y1 = y(acc + v);
                  const y0 = y(acc);
                  acc += v;
                  const last = j === segments.length - 1;
                  const gap = j === 0 ? 0 : 2;
                  const hh = Math.max(1, y0 - y1 - gap);
                  const r = last ? Math.min(4, bar / 2, hh) : 0;
                  const x0 = cx - bar / 2;
                  const d = `M${x0},${y1 + hh}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bar - r}Q${x0 + bar},${y1} ${x0 + bar},${y1 + r}V${y1 + hh}Z`;
                  return <path key={s.key} d={d} fill={s.color} opacity={tip && tip.column !== c ? 0.45 : 1} />;
                })}
                {i % every === 0 ? <text x={cx} y={height - 6} textAnchor="middle">{c.label}</text> : null}
                <rect x={m.left + band * i} y={m.top} width={band} height={h} fill="transparent" onMouseEnter={() => setTip({ x: cx, y: y(totals[i]), column: c })} />
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {tip ? (
        <div className="tip" style={{ left: Math.min(Math.max(0, tip.x - 90), Math.max(0, width - 230)), top: Math.max(0, tip.y - 12), transform: 'translateY(-100%)' }}>
          <b>{tip.column.label}</b>
          {series
            .filter((s) => (tip.column.values[s.key] ?? 0) > 0)
            .map((s) => (
              <div className="line" key={s.key}>
                <i className="swatch" style={{ background: s.color }} />
                <span className="clip">{s.label}</span>
                <span>{format(tip.column.values[s.key])}</span>
              </div>
            ))}
          {series.length > 1 ? (
            <div className="line" style={{ marginTop: 4, fontWeight: 600 }}>
              <span>Total</span>
              <span>{format(series.reduce((s, x) => s + (tip.column.values[x.key] ?? 0), 0))}</span>
            </div>
          ) : null}
          {tip.column.note ? <div className="muted" style={{ marginTop: 4 }}>{tip.column.note}</div> : null}
        </div>
      ) : null}
      {series.length > 1 ? (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key} title={s.label}>
              <i className="swatch" style={{ background: s.color }} />
              <span className="clip" style={{ maxWidth: 260 }}>{s.label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type Point = { x: number; y: number; label: string; lines: Array<[string, string]> };
export type Marker = { x: number; label: string; detail: string };

/** One line over an ordered sequence, with vertical markers (compactions) and a crosshair. */
export function LineChart({ points, markers = [], format, height = 180 }: { points: Point[]; markers?: Marker[]; format: (v: number) => string; height?: number }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const m = { top: 18, right: 12, bottom: 8, left: 46 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;
  const { top, ticks } = niceScale(Math.max(0, ...points.map((p) => p.y)));
  const maxX = Math.max(1, ...points.map((p) => p.x));
  const px = (x: number) => m.left + (x / maxX) * w;
  const py = (v: number) => m.top + h - (v / top) * h;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join('');
  const area = points.length ? `${path}L${px(points[points.length - 1].x).toFixed(1)},${py(0)}L${px(points[0].x).toFixed(1)},${py(0)}Z` : '';
  const at = hover === null ? null : points[hover];
  const nearest = (clientX: number, left: number) => {
    const x = ((clientX - left - m.left) / Math.max(1, w)) * maxX;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].x - x) < Math.abs(points[best].x - x)) best = i;
    return best;
  };
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {width > 0 && points.length ? (
        <svg height={height} role="img" aria-label="Context size per response" onMouseMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect().left))}>
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'axis' : 'grid'} x1={m.left} x2={m.left + w} y1={py(t)} y2={py(t)} />
              <text x={m.left - 8} y={py(t) + 4} textAnchor="end">{format(t)}</text>
            </g>
          ))}
          <path d={area} fill="var(--s1)" opacity="0.1" />
          <path d={path} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {markers.map((k, i) => {
            // a label is drawn only where it has room; the line always is
            const room = (i === 0 || px(k.x) - px(markers[i - 1].x) > 52) && px(k.x) < m.left + w - 40;
            return (
              <g key={i}>
                <line x1={px(k.x)} x2={px(k.x)} y1={m.top - 4} y2={m.top + h} stroke="var(--ink-3)" strokeWidth="1" />
                {room ? <text x={px(k.x) + 4} y={m.top - 6} style={{ fill: 'var(--ink-2)' }}>{k.label}</text> : null}
              </g>
            );
          })}
          {at ? (
            <g>
              <line x1={px(at.x)} x2={px(at.x)} y1={m.top} y2={m.top + h} stroke="var(--axis)" />
              <circle cx={px(at.x)} cy={py(at.y)} r="5" fill="var(--s1)" stroke="var(--surface)" strokeWidth="2" />
            </g>
          ) : null}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {at ? (
        <div className="tip" style={{ left: Math.min(Math.max(0, px(at.x) + 12), Math.max(0, width - 220)), top: 0 }}>
          <b>{at.label}</b>
          {at.lines.map(([k, v]) => (
            <div className="line" key={k}><span>{k}</span><span>{v}</span></div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Share bar inside a table cell: magnitude at a glance, the number beside it. */
export function Meter({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="meter" aria-hidden="true">
      <i style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function ChartFrame({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel pad">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3>{title}</h3>
        {note ? <span className="muted" style={{ fontSize: 12.5 }}>{note}</span> : null}
      </div>
      {children}
    </div>
  );
}
