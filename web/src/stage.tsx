// The stage: the harness drawn as a machine. Isometric solids for the parts, lines for the paths
// between them, and dots that travel along a path while traffic flows on it. Plain SVG, themed by CSS.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { navigate } from './ui';

export type StageTone = 'good' | 'warn' | 'serious' | 'critical' | 'idle' | 'info';
export type Shape = 'desk' | 'slab' | 'cube' | 'gate' | 'drum' | 'crate' | 'cluster';
export type Tile = 'busy' | 'idle' | 'alert';

export type StageNode = {
  id: string;
  shape: Shape;
  at: [number, number];
  /** Position in the narrow layout; null leaves the part out of it. */
  narrowAt: [number, number] | null;
  hue: string;
  title: string;
  sub?: string;
  badge?: { tone: StageTone; text: string };
  to?: string;
  dim?: boolean;
  active?: boolean;
  alert?: StageTone;
  tiles?: Tile[];
  /** Puts the name above the part, for one whose paths arrive from below. */
  labelAbove?: boolean;
  /** Puts the name to the right of the part, for parts stacked in a column. */
  labelRight?: boolean;
  /** Slides a name that sits below its part sideways, out of the way of a path. */
  labelDx?: number;
};

export type StageEdge = {
  id: string;
  from: string;
  to: string;
  kind: 'request' | 'response' | 'blocked';
  label?: string;
  /** How many dots travel the path at once: 0 for a path with no traffic. */
  packets?: number;
  seconds?: number;
  dim?: boolean;
  active?: boolean;
  /** Sideways shift, so a request and its response run as two lanes. */
  lane?: number;
  /** Left out of the narrow layout, where the parts it joins sit in a grid under their source. */
  wideOnly?: boolean;
};

type Geometry = { lift: number; top: number; foot: number; rx: number; ry: number };
const GEOMETRY: Record<Shape, Geometry> = {
  desk: { lift: 14, top: 52, foot: 42, rx: 64, ry: 46 },
  slab: { lift: 8, top: 44, foot: 70, rx: 116, ry: 68 },
  cube: { lift: 26, top: 82, foot: 38, rx: 58, ry: 56 },
  gate: { lift: 22, top: 64, foot: 42, rx: 52, ry: 50 },
  drum: { lift: 20, top: 62, foot: 24, rx: 44, ry: 46 },
  crate: { lift: 16, top: 64, foot: 34, rx: 52, ry: 44 },
  cluster: { lift: 12, top: 52, foot: 34, rx: 52, ry: 42 },
};

const COS = 0.866;
const pt = (cx: number, cy: number, x: number, y: number, z: number) => `${(cx + (x - y) * COS).toFixed(1)},${(cy + (x + y) * 0.5 - z).toFixed(1)}`;

/** A box standing on the ground: a and b are half-sizes of its footprint, h its height, z how far it floats. */
function Box({ cx, cy, a, b, h, z = 0, className = '' }: { cx: number; cy: number; a: number; b: number; h: number; z?: number; className?: string }) {
  const p = (x: number, y: number, up: number) => pt(cx, cy, x, y, z + up);
  return (
    <g className={className}>
      <polygon className="iso iso-left" points={[p(-a, b, h), p(a, b, h), p(a, b, 0), p(-a, b, 0)].join(' ')} />
      <polygon className="iso iso-right" points={[p(a, -b, h), p(a, b, h), p(a, b, 0), p(a, -b, 0)].join(' ')} />
      <polygon className="iso iso-top" points={[p(-a, -b, h), p(a, -b, h), p(a, b, h), p(-a, b, h)].join(' ')} />
      {/* drawn only by the hologram look: the edges a solid would hide, and a plate on its top */}
      <path className="iso-ghost" d={`M${p(-a, -b, 0)} L${p(-a, -b, h)} M${p(-a, -b, 0)} L${p(a, -b, 0)} M${p(-a, -b, 0)} L${p(-a, b, 0)}`} />
      {a >= 20 ? <polygon className="iso-inset" points={[p(-a * 0.55, -b * 0.55, h), p(a * 0.55, -b * 0.55, h), p(a * 0.55, b * 0.55, h), p(-a * 0.55, b * 0.55, h)].join(' ')} /> : null}
    </g>
  );
}

function Solid({ shape, cx, cy, tiles }: { shape: Shape; cx: number; cy: number; tiles?: Tile[] }) {
  switch (shape) {
    case 'desk':
      return (
        <>
          <Box cx={cx} cy={cy} a={36} b={36} h={10} />
          <Box cx={cx} cy={cy} a={17} b={12} h={3} z={10} />
          <polygon className="iso iso-screen" points={[pt(cx, cy, -17, -12, 13), pt(cx, cy, 17, -12, 13), pt(cx, cy, 17, -12, 38), pt(cx, cy, -17, -12, 38)].join(' ')} />
        </>
      );
    case 'slab': {
      const spots: Array<[number, number]> = [];
      for (const y of [-39, -13, 13, 39]) for (const x of [-39, -13, 13, 39]) spots.push([x, y]);
      // the first sessions stand in the middle of the floor
      spots.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]) || p[1] - q[1] || p[0] - q[0]);
      const shown = (tiles ?? []).slice(0, spots.length).map((tile, i) => ({ tile, x: spots[i][0], y: spots[i][1] }));
      shown.sort((p, q) => p.x + p.y - (q.x + q.y));
      return (
        <>
          <Box cx={cx} cy={cy} a={64} b={64} h={14} />
          {shown.map((t, i) => (
            <Box key={i} className={`tile tile-${t.tile}`} cx={cx + (t.x - t.y) * COS} cy={cy + (t.x + t.y) * 0.5} a={10} b={10} h={t.tile === 'idle' ? 7 : 14} z={14} />
          ))}
        </>
      );
    }
    case 'cube':
      return <Box cx={cx} cy={cy} a={30} b={30} h={46} />;
    case 'gate':
      return (
        <>
          <Box cx={cx + 26 * COS} cy={cy - 13} a={7} b={7} h={44} />
          <Box cx={cx} cy={cy} a={4} b={26} h={7} z={24} />
          <Box cx={cx - 26 * COS} cy={cy + 13} a={7} b={7} h={44} />
        </>
      );
    case 'drum':
      return (
        <>
          <path className="iso iso-left" d={`M${cx - 32},${cy - 40} V${cy} A32,16 0 0 0 ${cx + 32},${cy} V${cy - 40} Z`} />
          <path className="iso iso-line" d={`M${cx - 32},${cy - 20} A32,16 0 0 0 ${cx + 32},${cy - 20}`} />
          <ellipse className="iso iso-top" cx={cx} cy={cy - 40} rx={32} ry={16} />
        </>
      );
    case 'crate':
      return <Box cx={cx} cy={cy} a={26} b={26} h={30} />;
    case 'cluster':
      return (
        <>
          <Box cx={cx + 26} cy={cy - 13} a={13} b={13} h={22} />
          <Box cx={cx - 24} cy={cy - 6} a={13} b={13} h={30} />
          <Box cx={cx + 6} cy={cy + 10} a={13} b={13} h={18} />
        </>
      );
  }
}

// ---- text boxes: measured, because SVG does not size a box to its text -------------------------------------

const FONT = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
let measure: CanvasRenderingContext2D | null | undefined;
function widthOf(text: string, weight: number, size: number): number {
  if (measure === undefined) measure = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!measure) return text.length * size * 0.58;
  measure.font = `${weight} ${size}px ${FONT}`;
  return measure.measureText(text).width;
}

const tagWidth = (text: string) => Math.ceil(widthOf(text, 700, 12)) + 22;

function Tag({ x, y, text, className = '', start }: { x: number; y: number; text: string; className?: string; start?: boolean }) {
  const w = tagWidth(text);
  return (
    <g className={`tag-box ${className}`} transform={`translate(${Math.round(start ? x : x - w / 2)},${Math.round(y)})`}>
      <rect className="tag-shadow" x={2} y={2} width={w} height={22} rx={11} />
      <rect className="tag-face" width={w} height={22} rx={11} />
      <text x={w / 2} y={15.5} textAnchor="middle">{text}</text>
    </g>
  );
}

/** Where a part's name, its second line and its badge go. */
function labels(n: { x: number; y: number; g: Geometry; title: string; labelAbove?: boolean; labelRight?: boolean; labelDx?: number }) {
  if (n.labelRight) {
    const x = n.x + n.g.rx + 2;
    const y = n.y - n.g.lift - 24;
    return { tag: { x, y, start: true }, sub: { x: x + 4, y: y + 39, anchor: 'start' as const }, badge: { x, y: y + 48, start: true } };
  }
  if (n.labelAbove) {
    const y = n.y - n.g.top - 28;
    return { tag: { x: n.x, y, start: false }, sub: { x: n.x, y: y - 8, anchor: 'middle' as const }, badge: { x: n.x, y: y - 54, start: false } };
  }
  const y = n.y + n.g.foot;
  const x = n.x + (n.labelDx ?? 0);
  return { tag: { x, y, start: false }, sub: { x, y: y + 40, anchor: 'middle' as const }, badge: { x: n.x, y: n.y - n.g.top - 30, start: false } };
}

// ---- layout ---------------------------------------------------------------------------------------------

function useNarrow(ref: React.RefObject<HTMLElement | null>, below: number) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setNarrow(el.clientWidth < below));
    observer.observe(el);
    setNarrow(el.clientWidth < below);
    return () => observer.disconnect();
  }, [ref, below]);
  return narrow;
}

export type Look = 'holo' | 'paper';
const lookListeners = new Set<(l: Look) => void>();
const readLook = (): Look => {
  try {
    return localStorage.getItem('aegis-look') === 'paper' ? 'paper' : 'holo';
  } catch {
    return 'holo';
  }
};

/** Puts the look on the document, where the styles of the whole console read it. */
export function applyLook(look: Look = readLook()) {
  document.documentElement.dataset.look = look;
}

/** How the console is drawn: as a hologram, or on drafting paper. One choice for everything, kept in the browser. */
export function useLook(): [Look, (l: Look) => void] {
  const [look, setLook] = useState<Look>(readLook);
  useEffect(() => {
    lookListeners.add(setLook);
    return () => {
      lookListeners.delete(setLook);
    };
  }, []);
  return [
    look,
    (l) => {
      try {
        localStorage.setItem('aegis-look', l);
      } catch {
        /* the choice just does not persist */
      }
      applyLook(l);
      lookListeners.forEach((f) => f(l));
    },
  ];
}

function useStillness() {
  const [still, setStill] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setStill(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return still;
}

type Placed = StageNode & { x: number; y: number; g: Geometry };

/** The point where a line towards (tx, ty) leaves the part's outline. */
function port(n: Placed, tx: number, ty: number): [number, number] {
  const cx = n.x;
  const cy = n.y - n.g.lift;
  const dx = tx - cx;
  const dy = ty - cy;
  const k = 1 / Math.sqrt((dx / n.g.rx) ** 2 + (dy / n.g.ry) ** 2 || 1);
  return [cx + dx * Math.min(k, 0.48), cy + dy * Math.min(k, 0.48)];
}

export function Stage({ nodes, edges, size, narrowSize, label, legend, children }: { nodes: StageNode[]; edges: StageEdge[]; size: [number, number]; narrowSize: [number, number]; label: string; legend?: boolean; children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(wrap, 640);
  const still = useStillness();
  const [look, setLook] = useLook();
  const [w, h] = narrow ? narrowSize : size;
  const placed: Placed[] = [];
  for (const n of nodes) {
    const at = narrow ? n.narrowAt : n.at;
    if (at) placed.push({ ...n, labelRight: narrow ? false : n.labelRight, labelDx: narrow ? 0 : n.labelDx, x: at[0], y: at[1], g: GEOMETRY[n.shape] });
  }
  const byId = new Map(placed.map((n) => [n.id, n]));
  const lines = edges.flatMap((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b || (narrow && e.wideOnly)) return [];
    let [x0, y0] = port(a, b.x, b.y - b.g.lift);
    let [x1, y1] = port(b, a.x, a.y - a.g.lift);
    const length = Math.hypot(x1 - x0, y1 - y0) || 1;
    const nx = (-(y1 - y0) / length) * (e.lane ?? 0);
    const ny = ((x1 - x0) / length) * (e.lane ?? 0);
    x0 += nx; y0 += ny; x1 += nx; y1 += ny;
    return [{ e, d: `M${x0.toFixed(1)},${y0.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)}`, mx: (x0 + x1) / 2, my: (y0 + y1) / 2, length }];
  });
  // drawn in the order given, which is also the order the keyboard walks them: the parts do not overlap
  const ordered = placed;
  return (
    <div className="stage" ref={wrap}>
      <div className="look seg" role="group" aria-label="How the console is drawn">
        <button aria-pressed={look === 'holo'} onClick={() => setLook('holo')}>Hologram</button>
        <button aria-pressed={look === 'paper'} onClick={() => setLook('paper')}>Paper</button>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} role="group" aria-label={label}>
        <defs>
          {(['request', 'response', 'blocked', 'dim'] as const).map((k) => (
            <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path className={`arrow arrow-${k}`} d="M0,0.5 L10,5 L0,9.5 Z" />
            </marker>
          ))}
        </defs>
        <g>
          {lines.map(({ e, d }) => (
            <path key={e.id} d={d} className={`edge edge-${e.kind}${e.dim ? ' dim' : ''}${e.active ? ' active' : ''}`} markerEnd={`url(#arrow-${e.dim ? 'dim' : e.kind === 'blocked' ? 'blocked' : 'request'})`} />
          ))}
        </g>
        {ordered.map((n) => {
          const at = labels(n);
          const body = (
            <>
              <ellipse className="pad" cx={n.x} cy={n.y + 3} rx={n.g.rx + 8} ry={(n.g.rx + 8) * 0.5} />
              {n.active ? <ellipse className="glow" cx={n.x} cy={n.y + 4} rx={n.g.rx + 6} ry={n.g.ry * 0.62} /> : null}
              <Solid shape={n.shape} cx={n.x} cy={n.y} tiles={n.tiles} />
              <Tag {...at.tag} text={n.title} />
              {n.sub ? <text className="sub" x={at.sub.x} y={at.sub.y} textAnchor={at.sub.anchor}>{n.sub}</text> : null}
            </>
          );
          const cls = `node${n.dim ? ' dim' : ''}${n.active ? ' active' : ''}${n.alert ? ` alert alert-${n.alert}` : ''}`;
          const style = { '--hue': n.hue } as CSSProperties;
          const said = `${n.title}${n.sub ? `, ${n.sub}` : ''}${n.badge ? `, ${n.badge.text}` : ''}`;
          return n.to ? (
            <a
              key={n.id}
              href={n.to}
              className={cls}
              style={style}
              aria-label={said}
              onClick={(ev) => {
                if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                ev.preventDefault();
                navigate(n.to!);
              }}
            >
              {body}
            </a>
          ) : (
            <g key={n.id} className={cls} style={style} role="img" aria-label={said}>
              {body}
            </g>
          );
        })}
        {still ? null : (
          <g aria-hidden="true">
            {lines.flatMap(({ e, d, length }) => {
              const count = e.dim ? 0 : (e.packets ?? 0);
              const seconds = e.seconds ?? Math.max(1.6, length / 90);
              return Array.from({ length: count }, (_, i) => (
                <circle key={`${e.id}-${i}`} r={5} className={`packet packet-${e.kind}`}>
                  <animateMotion dur={`${seconds.toFixed(2)}s`} begin={`-${((seconds * i) / count).toFixed(2)}s`} repeatCount="indefinite" path={d} />
                </circle>
              ));
            })}
          </g>
        )}
        <g>
          {lines.map(({ e, mx, my }) => (e.label && !e.dim && !narrow ? <Tag key={e.id} className="edge-tag" x={mx} y={my - 30} text={e.label} /> : null))}
          {ordered.map((n) => (n.badge ? <Tag key={n.id} className={`badge badge-${n.badge.tone}`} {...labels(n).badge} text={n.badge.text} /> : null))}
        </g>
      </svg>
      {legend ? (
        <div className="stage-legend" aria-hidden="true">
          <span><i className="packet-request" />request</span>
          <span><i className="packet-response" />response</span>
          <span><i className="packet-blocked" />failed or stopped</span>
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** A row of small labelled figures above a stage. */
export function Chips({ items }: { items: Array<{ label: string; value: ReactNode; note?: string; tone?: StageTone; to?: string }> }) {
  return (
    <div className="chips" role="list">
      {items.map((c) => {
        const inner = (
          <>
            <span className="k">{c.label}</span>
            <b className="num">{c.value}</b>
            {c.note ? <small>{c.note}</small> : null}
          </>
        );
        const cls = `chip${c.tone ? ` chip-${c.tone}` : ''}`;
        return c.to ? (
          <div key={c.label} role="listitem" className="chip-slot">
            <a className={cls} href={c.to} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return; ev.preventDefault(); navigate(c.to!); }}>{inner}</a>
          </div>
        ) : (
          <div key={c.label} role="listitem" className={cls}>{inner}</div>
        );
      })}
    </div>
  );
}
