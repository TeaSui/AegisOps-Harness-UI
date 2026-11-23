// Path: the machinery of the harness a session went through, in order, drawn like a commit graph.
// One track per kind of machinery; the line shows where the session went next.
import { useMemo, useState } from 'react';
import { qs, useApi } from '../api';
import { allowedBy, clock, fullTime, int } from '../format';
import { Chips } from '../stage';
import { Empty, Mark, Problem, Source } from '../ui';

type Step = { lane: string; title: string; detail: string; tone: 'ok' | 'bad' | 'stopped' | 'plain'; count: number; ts: number; file: number; line: number; lastLine: number; turn: number; by?: { decision: string; source: string; reason: string; ruleSource: string | null }; tools?: string[] };

const LANES: Array<{ key: string; label: string; color: string; hint: string }> = [
  { key: 'prompt', label: 'You', color: 'var(--accent)', hint: 'a prompt you typed' },
  { key: 'context', label: 'Instructions', color: 'var(--s-other)', hint: 'instruction files and listings loaded into the session' },
  { key: 'hooks', label: 'Hooks', color: 'var(--s4)', hint: 'a hook command the harness ran' },
  { key: 'skills', label: 'Skills', color: 'var(--s6)', hint: 'a skill the session entered' },
  { key: 'permissions', label: 'Permissions', color: 'var(--s1)', hint: 'how tool calls were let through or stopped' },
  { key: 'agents', label: 'Subagents', color: 'var(--s8)', hint: 'work handed to a subagent' },
  { key: 'mcp', label: 'MCP', color: 'var(--s7)', hint: 'a call to an MCP server' },
];
const TRACK = 24;
const ROW = 38;
const X = (lane: string) => LANES.findIndex((l) => l.key === lane) * TRACK + TRACK / 2;
const RULE_SOURCE: Record<string, string> = { userSettings: 'your user settings', projectSettings: 'the project settings', localSettings: 'the local project settings', cliArg: 'a command-line flag', policySettings: 'managed policy', session: 'this session', command: 'the slash command' };

function sentence(s: Step): { head: string; rest: string } {
  if (s.by) {
    const calls = `${int(s.count)} tool call${s.count === 1 ? '' : 's'}`;
    const how = allowedBy(s.by.decision, s.by.source, s.by.reason);
    const where = s.by.ruleSource ? ` in ${RULE_SOURCE[s.by.ruleSource] ?? s.by.ruleSource}` : '';
    return { head: s.by.decision === 'accept' ? `${calls} allowed by ${how}${where}` : `${calls} stopped (${how.replace(/^declined: /, '')}${where})`, rest: (s.tools ?? []).join(', ') };
  }
  if (s.lane === 'hooks') return { head: `${s.title} hook`, rest: s.detail };
  if (s.lane === 'mcp') return { head: s.title, rest: (s.tools ?? []).join(', ') };
  if (s.lane === 'permissions') return { head: 'Permission mode', rest: s.detail };
  return { head: s.title, rest: s.detail };
}

export function Path({ id, agent }: { id: string; agent: string | null }) {
  const path = useApi<any>(`/api/sessions/${encodeURIComponent(id)}/path${qs({ agent, limit: 2000 })}`, (ids) => ids.includes(id));
  const [hidden, setHidden] = useState<string[]>([]);
  const all: Step[] = path.data?.steps ?? [];
  // hiding a track can leave two runs of the same thing next to each other: they become one row again
  const steps = useMemo(() => {
    const out: Step[] = [];
    const same = (a: Step, b: Step) => a.lane === b.lane && a.lane !== 'prompt' && a.turn === b.turn && a.title === b.title && a.tone === b.tone && (a.lane === 'mcp' || a.by || a.detail === b.detail) && JSON.stringify(a.by ?? null) === JSON.stringify(b.by ?? null);
    for (const s of all) {
      if (hidden.includes(s.lane)) continue;
      const last = out[out.length - 1];
      if (last && same(last, s)) out[out.length - 1] = { ...last, count: last.count + s.count, lastLine: s.lastLine, tools: last.tools || s.tools ? [...new Set([...(last.tools ?? []), ...(s.tools ?? [])])].slice(0, 6) : undefined };
      else out.push(s);
    }
    return out;
  }, [all, hidden]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of all) m[s.lane] = (m[s.lane] ?? 0) + (s.lane === 'permissions' && s.by ? s.count : 1);
    return m;
  }, [all]);
  if (path.error && !path.data) return <Problem error={path.error === 'Not found' ? 'The transcript of this session is no longer on disk, so its path cannot be read.' : path.error} />;
  if (!path.data) return <div className="panel"><Empty title="Reading the transcript" /></div>;
  const sum = path.data.summary;
  const failedHooks = sum.hooks.reduce((n: number, h: any) => n + h.failed, 0);
  const stopped = sum.permissions.filter((p: any) => p.decision !== 'accept').reduce((n: number, p: any) => n + p.count, 0);
  const allowed = sum.permissions.filter((p: any) => p.decision === 'accept');
  const top = allowed[0];
  const width = LANES.length * TRACK;
  return (
    <div className="stack">
      <Chips
        items={[
          { label: agent ? 'Tasks given' : 'Prompts', value: int(sum.prompts) },
          { label: 'Instruction files', value: int(sum.instructions), note: 'loaded into context' },
          { label: 'Hook commands', value: int(sum.hooks.length), note: failedHooks ? `${int(failedHooks)} run${failedHooks === 1 ? '' : 's'} failed or blocked` : `${int(sum.hooks.reduce((n: number, h: any) => n + h.runs, 0))} runs, none failed`, tone: failedHooks ? 'warn' : undefined },
          { label: 'Skills entered', value: int(sum.skills.length), note: sum.skills.slice(0, 2).map((s: any) => s.name).join(', ') || 'none' },
          { label: 'Tool calls let through', value: int(allowed.reduce((n: number, p: any) => n + p.count, 0)), note: top ? `mostly by ${allowedBy(top.decision, top.source, top.reason)}` : 'none recorded' },
          { label: 'Tool calls stopped', value: int(stopped), note: stopped ? 'denied or blocked' : 'none', tone: stopped ? 'warn' : undefined },
          { label: 'Subagents and MCP', value: `${int(sum.agents.length)} and ${int(sum.mcp.length)}`, note: 'agent types, servers' },
        ]}
      />
      <section className="plate" aria-label="The path of the session">
        <header>
          <h2>The path</h2>
          <p>Top to bottom, in the order the transcript records it. A run of the same thing is one row. A track's name hides or shows it.</p>
        </header>
        <div className="lanes" role="group" aria-label="Tracks">
          {LANES.map((l) => (
            <button key={l.key} className="lane-key" aria-pressed={!hidden.includes(l.key)} title={`${l.hint}. Click to ${hidden.includes(l.key) ? 'show' : 'hide'}.`} onClick={() => setHidden(hidden.includes(l.key) ? hidden.filter((h) => h !== l.key) : [...hidden, l.key])}>
              <i style={{ background: l.color }} />{l.key === 'prompt' && agent ? 'Task' : l.label}<span className="num">{int(counts[l.key] ?? 0)}</span>
            </button>
          ))}
        </div>
        {steps.length === 0 ? (
          <Empty title={all.length ? 'Every track is hidden' : 'Nothing is recorded on the path of this session yet'} />
        ) : (
          <ol className="path">
            {steps.map((s, i) => {
              const x = X(s.lane);
              const before = i > 0 ? (X(steps[i - 1].lane) + x) / 2 : x;
              const after = i < steps.length - 1 ? (x + X(steps[i + 1].lane)) / 2 : x;
              const lane = LANES.find((l) => l.key === s.lane)!;
              const said = sentence(s);
              return (
                <li key={`${s.line}-${i}`} className={`path-row lane-${s.lane} tone-${s.tone}`}>
                  <span className="when num" title={fullTime(s.ts)}>{i === 0 || clock(steps[i - 1].ts) !== clock(s.ts) ? clock(s.ts) : ''}</span>
                  <svg width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`} aria-hidden="true">
                    {LANES.map((l, k) => <line key={l.key} className="track-line" x1={k * TRACK + TRACK / 2} x2={k * TRACK + TRACK / 2} y1={0} y2={ROW} />)}
                    {i > 0 ? <path className="wire" d={`M${before},0 Q${x},0 ${x},${ROW / 2}`} /> : null}
                    {i < steps.length - 1 ? <path className="wire" d={`M${x},${ROW / 2} Q${x},${ROW} ${after},${ROW}`} /> : null}
                    <circle className="stop" cx={x} cy={ROW / 2} r={s.lane === 'prompt' ? 7 : 5.5} fill={s.tone === 'bad' ? 'var(--critical)' : s.tone === 'stopped' ? 'var(--serious-mark)' : lane.color} />
                  </svg>
                  <span className="what">
                    <span className="sr">{s.lane === 'prompt' && agent ? 'Task' : lane.label}: </span>
                    <b>{said.head}</b>
                    {s.count > 1 && !s.by ? <span className="times num">×{int(s.count)}</span> : null}
                    {s.tone === 'bad' ? <Mark tone="critical">failed</Mark> : s.tone === 'stopped' ? <Mark tone="serious" icon="denied">{s.lane === 'hooks' ? 'blocked' : s.by ? 'stopped' : 'changed'}</Mark> : null}
                    {said.rest ? <span className={`rest clip${s.lane === 'hooks' ? ' mono' : ''}`} title={said.rest}>{said.rest}</span> : null}
                  </span>
                  <span className="src"><Source file={s.file} line={s.line} /></span>
                </li>
              );
            })}
          </ol>
        )}
        {path.data.total > all.length ? <p className="muted" style={{ padding: '0 16px 12px' }}>The first {int(all.length)} of {int(path.data.total)} rows are shown.</p> : null}
      </section>
    </div>
  );
}
