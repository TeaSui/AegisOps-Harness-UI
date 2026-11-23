// Replay: one session stepped through on the stage. Each row of the transcript is one step; the part of
// the harness it touched lights up, and the figures above show the session as it stood at that moment.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clock, compact, duration, fullTime, int, modelName, money } from '../format';
import { CATEGORY, CATEGORY_ORDER, machine } from '../machine';
import { Chips, Stage, type StageEdge, type StageTone } from '../stage';
import { Empty, Icon, Source } from '../ui';

export type Item = Record<string, any> & { kind: string; ts: number; file: number; line: number };

const HUMAN = new Set(['human', 'sdk', 'command']);
const SPEEDS: Array<[string, number]> = [['1×', 900], ['2×', 450], ['4×', 220]];
const BINS = 320;

export const isProblem = (i: Item) =>
  i.kind === 'api_error' ||
  (i.kind === 'tool' && (i.status === 'error' || i.status === 'denied')) ||
  (i.kind === 'hook' && i.status !== 'success') ||
  (i.kind === 'stop_hooks' && (i.errors > 0 || i.prevented));
const isAsk = (i: Item) => i.kind === 'prompt' && HUMAN.has(i.origin);
const rank = (i: Item) => (isProblem(i) ? 3 : isAsk(i) ? 2 : i.kind === 'tool' ? 1 : 0);
const RANK_CLASS = ['b-talk', 'b-tool', 'b-prompt', 'b-problem'];

const brief = (text: unknown, max = 30) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const shortTool = (name: string) => (name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2) : name);

/** A slash command is recorded as tags; show it the way it was typed. */
export function promptText(item: Item): string {
  if (item.origin !== 'command') return item.text;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(item.text)?.[1]?.trim();
  if (!name) return item.text;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(item.text)?.[1]?.trim() ?? '';
  return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`;
}

type Hop = { from: string; to: string; kind: StageEdge['kind'] };
type View = { title: string; tone: StageTone | null; hops: Hop[]; nodes: string[]; badge?: { on: string; tone: StageTone; text: string }; alert?: { on: string; tone: StageTone } };

/** What a step looks like on the stage: the hops that carry it, the part it lands on and what to call it. */
function viewOf(item: Item, subagent: boolean): View {
  switch (item.kind) {
    case 'prompt':
      if (HUMAN.has(item.origin)) {
        return { title: subagent ? 'The subagent was given a task' : item.origin === 'command' ? 'You ran a slash command' : item.origin === 'sdk' ? 'A prompt arrived from the SDK' : 'You asked', tone: 'info', hops: [{ from: 'you', to: 'harness', kind: 'request' }], nodes: [], badge: { on: 'harness', tone: 'info', text: brief(promptText(item)) || 'prompt' } };
      }
      return { title: item.origin === 'task-notification' ? 'A background task reported back' : item.origin === 'peer' ? 'Another session sent a message' : 'The harness added a message', tone: null, hops: [], nodes: ['harness'], badge: { on: 'harness', tone: 'idle', text: item.origin === 'task-notification' ? 'background task' : item.origin === 'peer' ? 'message from a session' : 'harness message' } };
    case 'thinking':
      return { title: 'Claude is thinking', tone: null, hops: [{ from: 'harness', to: 'model:0', kind: 'request' }], nodes: [], badge: { on: 'model:0', tone: 'idle', text: 'thinking' } };
    case 'reply':
      return { title: 'Claude replied', tone: 'good', hops: [{ from: 'model:0', to: 'harness', kind: 'response' }, { from: 'harness', to: 'you', kind: 'response' }], nodes: [], badge: { on: 'you', tone: 'good', text: brief(item.text) || 'reply' } };
    case 'tool': {
      const target = `t:${CATEGORY[item.category] ? item.category : 'other'}`;
      const name = shortTool(item.name);
      const what = brief(`${name} ${item.category === 'exec' || item.category === 'read' || item.category === 'write' || item.category === 'fetch' || item.category === 'agent' ? item.target : ''}`, 26);
      if (item.status === 'denied') {
        return { title: `${name} was denied`, tone: 'serious', hops: [{ from: 'harness', to: 'gate', kind: 'request' }, { from: 'gate', to: 'harness', kind: 'blocked' }], nodes: [], badge: { on: 'gate', tone: 'serious', text: `denied: ${what}` }, alert: { on: 'gate', tone: 'serious' } };
      }
      const out: Hop[] = [{ from: 'harness', to: 'gate', kind: 'request' }, { from: 'gate', to: target, kind: 'request' }];
      if (item.status === 'pending') return { title: `${name} has no result yet`, tone: 'idle', hops: out, nodes: [], badge: { on: target, tone: 'idle', text: what } };
      const back: StageEdge['kind'] = item.status === 'error' ? 'blocked' : 'response';
      return {
        title: item.status === 'error' ? `${name} failed` : `${name} ran`,
        tone: item.status === 'error' ? 'critical' : 'good',
        hops: [...out, { from: target, to: 'gate', kind: back }, { from: 'gate', to: 'harness', kind: back }],
        nodes: [],
        badge: { on: target, tone: item.status === 'error' ? 'critical' : 'info', text: what },
        alert: item.status === 'error' ? { on: target, tone: 'critical' } : undefined,
      };
    }
    case 'hook': {
      const tone: StageTone = item.status === 'success' ? 'good' : item.status === 'blocked' ? 'serious' : 'critical';
      return { title: `${item.event} hook ${item.status === 'success' ? 'ran' : item.status === 'blocked' ? 'blocked the session' : 'failed'}`, tone, hops: [], nodes: ['gate'], badge: { on: 'gate', tone, text: brief(`${item.event} hook ${item.status === 'success' ? 'ran' : item.status}`) }, alert: item.status === 'success' ? undefined : { on: 'gate', tone } };
    }
    case 'stop_hooks':
      return { title: item.prevented ? 'A stop hook kept the session going' : 'Stop hooks failed', tone: 'critical', hops: [], nodes: ['gate'], badge: { on: 'gate', tone: 'critical', text: item.prevented ? 'stop prevented' : `${item.errors} stop hooks failed` }, alert: { on: 'gate', tone: 'critical' } };
    case 'api_error':
      return { title: `API error ${item.status ?? ''}`.trim(), tone: 'critical', hops: [{ from: 'harness', to: 'model:0', kind: 'blocked' }], nodes: [], badge: { on: 'model:0', tone: 'critical', text: brief(`${item.status ?? ''} ${String(item.error ?? '').replace(/_/g, ' ')}`) || 'API error' }, alert: { on: 'model:0', tone: 'critical' } };
    case 'compaction':
      return { title: 'Context compacted', tone: 'info', hops: [], nodes: ['harness'], badge: { on: 'harness', tone: 'info', text: item.freed !== null ? `compacted, freed ${compact(item.freed)}` : 'context compacted' } };
    case 'permission_mode':
      return { title: 'Permission mode changed', tone: item.mode === 'bypassPermissions' ? 'critical' : null, hops: [], nodes: ['gate'], badge: { on: 'gate', tone: item.mode === 'bypassPermissions' ? 'critical' : 'idle', text: `mode: ${item.mode}` } };
    case 'command':
      return { title: 'Local command', tone: null, hops: [], nodes: ['harness'], badge: { on: 'harness', tone: 'idle', text: brief(`/${item.name}`) } };
    default:
      return { title: 'Turn finished', tone: null, hops: [], nodes: ['harness'], badge: { on: 'harness', tone: 'idle', text: item.durationMs ? `turn took ${duration(item.durationMs)}` : 'turn finished' } };
  }
}

/** Index of the last entry whose time is at or before ts; -1 when none is. */
function lastAtOrBefore(times: number[], ts: number) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export function Replay({ items, calls, loading, total, models, subagent, renderStep }: { items: Item[]; calls: any[]; loading: boolean; total: number; models: string[]; subagent: boolean; renderStep: (item: Item) => ReactNode }) {
  const steps = useMemo(() => items.filter((i) => !(i.kind === 'stop_hooks' && !i.errors && !i.prevented)), [items]);
  // the step in the address is read when the replay opens, so a shared link and a return from the tape land on it
  const [wanted, setWanted] = useState(() => {
    const asked = Math.floor(Number(new URLSearchParams(window.location.search).get('step')));
    return Number.isFinite(asked) && asked > 1 ? asked - 1 : 0;
  });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);
  const last = steps.length - 1;
  const index = Math.max(0, Math.min(last, wanted));
  const indexRef = useRef(index);
  indexRef.current = index;
  const lastRef = useRef(last);
  lastRef.current = last;

  const go = (to: number) => setWanted(Math.max(0, Math.min(lastRef.current, to)));
  const seek = (test: (i: Item) => boolean, direction: 1 | -1) => {
    for (let i = indexRef.current + direction; i >= 0 && i <= lastRef.current; i += direction) {
      if (test(steps[i])) return go(i);
    }
  };
  const seekRef = useRef(seek);
  seekRef.current = seek;

  // the address remembers the step, without a navigation for each one
  useEffect(() => {
    // not while rows are still arriving for a step further on: the address keeps what was asked for
    if (playing || steps.length === 0 || (loading && wanted > last)) return;
    const q = new URLSearchParams(window.location.search);
    if (index === 0) q.delete('step');
    else q.set('step', String(index + 1));
    const s = q.toString();
    window.history.replaceState(null, '', window.location.pathname + (s ? `?${s}` : ''));
  }, [index, playing, steps.length, loading, wanted, last]);

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      if (indexRef.current >= lastRef.current) setPlaying(false);
      else setWanted(indexRef.current + 1);
    }, SPEEDS[speed][1]);
    return () => window.clearInterval(t);
  }, [playing, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('.drawer, .palette')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const direction = e.key === 'ArrowRight' ? 1 : -1;
        e.preventDefault();
        setPlaying(false);
        if (e.shiftKey) seekRef.current(isAsk, direction);
        else go(indexRef.current + direction);
      } else if (e.key === ' ') {
        if (e.target instanceof HTMLElement && e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        setPlaying((p) => !p && indexRef.current < lastRef.current);
      } else if (e.key === 'e') {
        setPlaying(false);
        seekRef.current(isProblem, 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // running totals, so any step can show the session as it stood then
  const sums = useMemo(() => {
    const n = steps.length;
    const asks = new Int32Array(n);
    const tools = new Int32Array(n);
    const problems = new Int32Array(n);
    const stopped = new Int32Array(n);
    const byCategory = new Map<string, Int32Array>();
    const present = new Set<string>();
    for (const s of steps) if (s.kind === 'tool') present.add(CATEGORY[s.category] ? s.category : 'other');
    for (const c of present) byCategory.set(c, new Int32Array(n));
    let a = 0, t = 0, p = 0, d = 0;
    const running = new Map<string, number>();
    steps.forEach((s, i) => {
      if (isAsk(s)) a++;
      if (isProblem(s)) p++;
      if (s.kind === 'tool') {
        t++;
        const c = CATEGORY[s.category] ? s.category : 'other';
        running.set(c, (running.get(c) ?? 0) + 1);
        if (s.status === 'denied') d++;
      }
      if ((s.kind === 'hook' && s.status !== 'success') || s.kind === 'stop_hooks') d++;
      asks[i] = a; tools[i] = t; problems[i] = p; stopped[i] = d;
      for (const [c, arr] of byCategory) arr[i] = running.get(c) ?? 0;
    });
    return { asks, tools, problems, stopped, byCategory, categories: CATEGORY_ORDER.filter((c) => present.has(c)) };
  }, [steps]);
  const spend = useMemo(() => {
    const times = calls.map((c) => c.ts as number);
    const cost: number[] = [];
    let sum = 0;
    for (const c of calls) cost.push((sum += c.cost ?? 0));
    return { times, cost };
  }, [calls]);
  // the same reading as the strips in the session list: a stretch is a problem when a tenth of it failed
  const bins = useMemo(() => {
    const count = Math.min(BINS, steps.length);
    const seen = Array.from({ length: count }, () => [0, 0, 0, 0]);
    steps.forEach((s, i) => {
      seen[Math.min(count - 1, Math.floor((i / steps.length) * count))][rank(s)]++;
    });
    return seen.map(([talk, tool, ask, bad]) => (bad > 0 && bad * 10 >= talk + tool + ask + bad ? 3 : ask > 0 ? 2 : tool > 0 ? 1 : 0));
  }, [steps]);

  if (steps.length === 0) {
    return <div className="panel"><Empty title={loading ? 'Reading the transcript' : 'This transcript has no conversation yet'}>{loading ? `${int(items.length)} of ${int(total)} rows so far.` : null}</Empty></div>;
  }

  const item = steps[index];
  const view = viewOf(item, subagent);
  const call = lastAtOrBefore(spend.times, item.ts);
  const model = call >= 0 ? calls[call].model : models[0];
  const categories = sums.categories.length ? sums.categories : ['exec'];
  const touched = new Set<string>(view.nodes);
  for (const h of view.hops) {
    touched.add(h.from);
    touched.add(h.to);
  }
  const part = (id: string) => ({
    active: touched.has(id),
    dim: !touched.has(id),
    badge: view.badge?.on === id ? { tone: view.badge.tone, text: view.badge.text } : undefined,
    alert: view.alert?.on === id ? view.alert.tone : undefined,
  });
  const { nodes, size, narrowSize } = machine({
    you: { title: 'You', sub: `${int(sums.asks[index])} prompt${sums.asks[index] === 1 ? '' : 's'} so far`, ...part('you') },
    harness: { title: 'Claude Code', sub: call >= 0 ? `${compact(calls[call].context)} tokens of context` : 'no response yet', ...part('harness') },
    models: [{ title: model ? modelName(model) : 'Model', sub: `${int(call + 1)} response${call === 0 ? '' : 's'} so far`, ...part('model:0') }],
    gate: { title: 'Permissions and hooks', sub: sums.stopped[index] ? `${int(sums.stopped[index])} stopped or failed so far` : 'nothing stopped so far', ...part('gate') },
    targets: categories.map((c) => {
      const n = sums.byCategory.get(c)?.[index] ?? 0;
      return { category: c, title: CATEGORY[c].title, sub: `${int(n)} call${n === 1 ? '' : 's'} so far`, ...part(`t:${c}`) };
    }),
  }, true);
  const pairs: Array<[string, string]> = [['you', 'harness'], ['harness', 'model:0'], ['harness', 'gate'], ...categories.map((c) => ['gate', `t:${c}`] as [string, string])];
  const edges: StageEdge[] = pairs.flatMap(([a, b]) =>
    [[a, b], [b, a]].map(([from, to]) => {
      const hop = view.hops.find((h) => h.from === from && h.to === to);
      return { id: `${from}>${to}`, from, to, kind: hop?.kind ?? 'request', dim: !hop, active: !!hop, packets: hop ? 1 : 0, seconds: 1.5, lane: 8, wideOnly: !hop && (from.startsWith('t:') || to.startsWith('t:')) } as StageEdge;
    }),
  );
  // a row with no time of its own (a mode record at the very start) must not become the start of the clock
  const first = steps.find((x) => x.ts > 0)?.ts ?? 0;
  const more = loading ? 'more rows are loading' : total > items.length ? `first ${int(items.length)} rows of ${int(total)}` : null;

  return (
    <div className="console">
      <div className="stack">
        <Chips
          items={[
            { label: 'Step', value: `${int(index + 1)} of ${int(steps.length)}`, note: more ?? `transcript line ${int(item.line)}` },
            { label: 'Elapsed', value: item.ts > 0 ? duration(item.ts - first) : '—', note: `at ${clock(item.ts)}` },
            { label: 'Spent so far', value: call >= 0 ? money(spend.cost[call]) : money(0), note: 'estimated' },
            { label: 'Context', value: call >= 0 ? compact(calls[call].context) : '—', note: 'last response' },
            { label: 'Tool calls', value: int(sums.tools[index]), note: 'so far' },
            { label: 'Problems', value: int(sums.problems[index]), note: 'failed or stopped', tone: sums.problems[index] ? 'warn' : undefined },
          ]}
        />
        <div>
          <Stage nodes={nodes} edges={edges} size={size} narrowSize={narrowSize} label={`Step ${index + 1} of ${steps.length}: ${view.title}`} legend>
            <div className="replay-bar">
              <button className="btn small quiet" onClick={() => { setPlaying(false); seek(isAsk, -1); }} title="Previous prompt (Shift ←)" aria-label="Previous prompt"><Icon name="skipBack" size={16} /></button>
              <button className="btn small" onClick={() => { setPlaying(false); go(index - 1); }} disabled={index === 0} title="Previous step (←)" aria-label="Previous step"><Icon name="back" size={16} /></button>
              <button className="btn small primary" onClick={() => setPlaying(!playing && index < last)} disabled={index >= last && !playing} aria-pressed={playing}>
                <Icon name={playing ? 'pause' : 'run'} size={15} />{playing ? 'Pause' : 'Play'}
              </button>
              <button className="btn small" onClick={() => { setPlaying(false); go(index + 1); }} disabled={index >= last} title="Next step (→)" aria-label="Next step"><Icon name="fwd" size={16} /></button>
              <button className="btn small quiet" onClick={() => { setPlaying(false); seek(isAsk, 1); }} title="Next prompt (Shift →)" aria-label="Next prompt"><Icon name="skipFwd" size={16} /></button>
              <button className="btn small" onClick={() => { setPlaying(false); seek(isProblem, 1); }} disabled={sums.problems[last] === sums.problems[index]} title="Next problem (e)"><Icon name="warn" size={14} />Next problem</button>
              <span className="spacer" />
              <div className="seg" role="group" aria-label="Playback speed">
                {SPEEDS.map(([label], i) => <button key={label} aria-pressed={speed === i} onClick={() => setSpeed(i)}>{label}</button>)}
              </div>
            </div>
            <div className="scrub">
              <svg viewBox={`0 0 ${bins.length} 10`} preserveAspectRatio="none" aria-hidden="true">
                {bins.map((r, i) => <rect key={i} className={RANK_CLASS[r]} x={i + 0.12} y={r === 0 ? 5 : r === 1 ? 3 : 0} width={0.76} height={r === 0 ? 5 : r === 1 ? 7 : 10} />)}
                <rect className="done" x={0} y={0} width={((index + 0.5) / steps.length) * bins.length} height={10} />
              </svg>
              <input type="range" min={1} max={steps.length} value={index + 1} onChange={(e) => { setPlaying(false); go(Number(e.target.value) - 1); }} aria-label="Step" aria-valuetext={`Step ${index + 1} of ${steps.length}: ${view.title}`} />
            </div>
            <div className="scrub-key" aria-hidden="true">
              <span><i style={{ background: 'var(--accent)' }} />your prompts</span>
              <span><i style={{ background: 'var(--ink-3)' }} />tool calls</span>
              <span><i style={{ background: 'var(--line-strong)' }} />thinking and replies</span>
              <span><i style={{ background: 'var(--critical)' }} />problems</span>
            </div>
          </Stage>
        </div>
      </div>

      <section className="panel step-card" aria-label="This step" aria-live="off">
        <div className="card-head">
          <div className="kind">
            <h2>{view.title}</h2>
          </div>
          <span className="spacer" />
          <span className="muted num" title={fullTime(item.ts)}>{clock(item.ts)}</span>
          <Source file={item.file} line={item.line} />
        </div>
        <div className="body tape">{renderStep(item)}</div>
        <div className="keys">
          <span><kbd>←</kbd><kbd>→</kbd> step</span>
          <span><kbd>Shift</kbd> + arrows: prompts</span>
          <span><kbd>Space</kbd> play</span>
          <span><kbd>e</kbd> next problem</span>
        </div>
      </section>
    </div>
  );
}
