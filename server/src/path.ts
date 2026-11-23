// The path of a session: the machinery of the harness it went through, in order. The instruction files
// that were loaded, the hooks that ran, the skills it entered, how each tool call was let through or
// stopped, the subagents it handed work to and the MCP servers it called. Read from the transcript on
// demand; what was loaded or injected is named and measured, never quoted.
import { basename } from 'node:path';
import { promptOrigin, shapeTool } from './indexer.ts';
import { forEachLine } from './lines.ts';
import { mask, preview } from './redact.ts';

const REQUEST_LOG_PREFIX = Buffer.from('{"type":"api-request');

export type Lane = 'prompt' | 'context' | 'hooks' | 'skills' | 'permissions' | 'agents' | 'mcp';
export type Step = {
  lane: Lane;
  title: string;
  detail: string;
  /** ok: ran or was allowed. bad: failed. stopped: denied or blocked. plain: neither. */
  tone: 'ok' | 'bad' | 'stopped' | 'plain';
  /** How many times in a row this happened. */
  count: number;
  ts: number;
  file: number;
  line: number;
  lastLine: number;
  /** 0 before the first prompt, then the number of the prompt this belongs to. */
  turn: number;
  by?: { decision: string; source: string; reason: string; ruleSource: string | null };
  tools?: string[];
};

const text = (v: unknown, max: number) => preview(mask(String(v ?? '')), max);
const HUMAN = new Set(['human', 'sdk', 'command']);

function promptLine(body: string, origin: string): string {
  if (origin === 'command' || /^<command-(?:name|message)>/.test(body)) {
    const name = /<command-name>([^<]*)<\/command-name>/.exec(body)?.[1]?.trim();
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(body)?.[1]?.trim() ?? '';
    if (name) return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`;
  }
  return body;
}

/** Two spellings of one skill: the name alone, or the name behind its plugin. */
const sameSkill = (a: string | null, b: string) => a !== null && (a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`));

export function buildPath(file: { id: number; path: string; offset: number }, maxLine: number, subagent = false) {
  const steps: Array<Step & { key: string }> = [];
  const pending = new Map<string, string>(); // tool call id -> tool name
  let turn = 0;
  let lastTs = 0;
  let skill: string | null = null;
  let mode: string | null = null;
  // a skill is known by the longest spelling seen so far (`plugin:name` rather than `name`)
  const spellings: string[] = [];
  const canon = (name: string) => {
    const i = spellings.findIndex((k) => sameSkill(k, name));
    if (i === -1) spellings.push(name);
    else if (name.length > spellings[i].length) spellings[i] = name;
    return spellings[i === -1 ? spellings.length - 1 : i];
  };
  // Stop hooks: the summary lists every run, a separate record names the one that failed, in either order
  let stopSteps = new Map<string, number>();
  const stopFailed = new Set<string>();

  const push = (at: { ts: number; line: number }, lane: Lane, key: string, s: Pick<Step, 'title' | 'detail' | 'tone'> & Partial<Pick<Step, 'by' | 'tools'>>) => {
    const last = steps[steps.length - 1];
    if (last && last.lane === lane && last.key === key && last.turn === turn && lane !== 'prompt') {
      last.count++;
      last.lastLine = at.line;
      if (s.tools) last.tools = [...new Set([...(last.tools ?? []), ...s.tools])].slice(0, 6);
      return;
    }
    steps.push({ lane, key, count: 1, ts: at.ts, file: file.id, line: at.line, lastLine: at.line, turn, ...s });
  };

  forEachLine(file.path, file.offset, maxLine, (buf, line) => {
    if (!buf || buf.length === 0) return;
    if (buf.length >= REQUEST_LOG_PREFIX.length && buf.subarray(0, REQUEST_LOG_PREFIX.length).equals(REQUEST_LOG_PREFIX)) return;
    let rec: any;
    try {
      rec = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!rec || typeof rec !== 'object') return;
    try {
      const parsed = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
      const ts = Number.isFinite(parsed) ? parsed : lastTs;
      lastTs = ts;
      const at = { ts, line };
      const newMode = rec.type === 'permission-mode' || rec.type === 'user' ? rec.permissionMode : undefined;
      if (typeof newMode === 'string' && newMode !== mode) {
        if (mode !== null) push(at, 'permissions', `mode:${newMode}`, { title: 'mode', detail: `permission mode changed to ${text(newMode, 40)}`, tone: newMode === 'bypassPermissions' ? 'stopped' : 'plain' });
        mode = newMode;
      }

      if (rec.type === 'attachment' && rec.attachment && typeof rec.attachment === 'object') {
        const a = rec.attachment;
        if (a.type === 'instructions' && Array.isArray(a.files)) {
          for (const f of a.files.slice(0, 50)) {
            const p = text(f?.path, 300);
            push(at, 'context', `file:${p}`, { title: basename(p) || p, detail: `${text(f?.type ?? 'Loaded', 30)} instructions, ${p}`, tone: 'plain' });
          }
        } else if (a.type === 'skill_listing' && a.isInitial && Number.isFinite(a.skillCount)) {
          push(at, 'context', 'skills-offered', { title: `${Math.trunc(a.skillCount)} skills offered`, detail: 'the skills this session could enter', tone: 'plain' });
        } else if (a.type === 'agent_listing_delta' && a.isInitial && Array.isArray(a.addedTypes)) {
          push(at, 'context', 'agents-offered', { title: `${a.addedTypes.length} agent types offered`, detail: a.addedTypes.slice(0, 8).map((t: unknown) => text(t, 40)).join(', '), tone: 'plain' });
        } else if (a.type === 'mcp_instructions_delta' && Array.isArray(a.addedNames) && a.addedNames.length) {
          push(at, 'context', `mcp-described:${a.addedNames.map(String).join(',')}`, { title: `${a.addedNames.length} MCP servers described`, detail: a.addedNames.slice(0, 12).map((t: unknown) => text(t, 40)).join(', '), tone: 'plain' });
        } else if (a.type === 'plan_mode') {
          push(at, 'context', 'plan-mode', { title: 'Plan mode', detail: 'the session was told to plan before acting', tone: 'plain' });
        } else if (a.type === 'hook_success' || a.type === 'hook_non_blocking_error' || a.type === 'hook_blocking_error') {
          const event = text(a.hookEvent ?? a.hookName ?? 'hook', 60);
          const command = text(a.command ?? a.blockingError?.command ?? '', 300);
          const tone = a.type === 'hook_success' ? 'ok' : a.type === 'hook_blocking_error' ? 'stopped' : 'bad';
          if (event === 'Stop' || event === 'SubagentStop') {
            // every run is counted by the stop summary; a failure only says which of those runs it was
            if (tone === 'ok') return;
            const i = stopSteps.get(command);
            const step = i === undefined ? undefined : steps[i];
            if (step && step.tone === 'ok' && step.count === 1) {
              step.tone = tone;
              step.key = `Stop\u0000${command}\u0000${tone}`;
              stopSteps.delete(command);
            } else stopFailed.add(command);
            return;
          }
          push(at, 'hooks', `${event}\u0000${command}\u0000${tone}`, { title: event, detail: command, tone });
        } else if (a.type === 'hook_additional_context') {
          const event = text(a.hookEvent ?? a.hookName ?? 'hook', 60);
          const size = (Array.isArray(a.content) ? a.content : [a.content]).reduce((n: number, c: unknown) => n + (typeof c === 'string' ? c.length : 0), 0);
          push(at, 'hooks', `${event}\u0000context`, { title: event, detail: `added ${size} characters of context`, tone: 'plain' });
        }
        return;
      }

      if (rec.type === 'system') {
        if (rec.subtype === 'stop_hook_summary' && Array.isArray(rec.hookInfos)) {
          stopSteps = new Map();
          for (const h of rec.hookInfos.slice(0, 50)) {
            const command = text(h?.command, 300);
            const tone = rec.preventedContinuation === true ? 'stopped' : stopFailed.delete(command) ? 'bad' : 'ok';
            push(at, 'hooks', `Stop\u0000${command}\u0000${tone}`, { title: 'Stop', detail: command, tone });
            stopSteps.set(command, steps.length - 1);
          }
          stopFailed.clear();
        } else if (rec.subtype === 'compact_boundary') {
          push(at, 'context', 'compaction', { title: 'Context compacted', detail: 'earlier turns were replaced by a summary', tone: 'plain' });
        }
        return;
      }

      if (rec.type === 'assistant' && Array.isArray(rec.message?.content)) {
        // the skill this response is attributed to comes first: a Skill call inside it enters the next one
        const attributed = typeof rec.attributionSkill === 'string' && rec.attributionSkill ? canon(text(rec.attributionSkill, 120)) : null;
        if (attributed && attributed !== skill) {
          skill = attributed;
          push(at, 'skills', `skill:${attributed}`, { title: attributed, detail: typeof rec.attributionPlugin === 'string' ? `from the ${text(rec.attributionPlugin, 80)} plugin` : 'active', tone: 'plain' });
        }
        for (const block of rec.message.content) {
          if (block?.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string' || pending.has(block.id)) continue;
          pending.set(block.id, block.name);
          const shape = shapeTool(block.name, block.input);
          if (block.name === 'Skill') {
            const asked = text(block.input?.skill, 120);
            // every call is an entry, also into the skill that is already active; two in a row are one row
            if (asked) {
              skill = canon(asked);
              push(at, 'skills', `skill:${skill}`, { title: skill, detail: 'entered through the Skill tool', tone: 'plain' });
            }
          } else if (shape.category === 'agent') {
            const type = text(block.input?.subagent_type ?? 'general-purpose', 80);
            push(at, 'agents', `agent:${type}`, { title: type, detail: text(block.input?.description, 140), tone: 'plain' });
          } else if (shape.mcpServer) {
            const server = text(shape.mcpServer, 80);
            push(at, 'mcp', `mcp:${server}`, { title: server, detail: 'called', tone: 'plain', tools: [text(block.name.slice(block.name.lastIndexOf('__') + 2), 60)] });
          }
        }
        return;
      }

      if (rec.type === 'user') {
        const content = rec.message?.content;
        const texts: string[] = [];
        if (typeof content === 'string') texts.push(content);
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
            else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              const tool = pending.get(block.tool_use_id);
              const perm = rec.permissionDecision && typeof rec.permissionDecision === 'object' ? rec.permissionDecision : null;
              const denial = typeof rec.toolDenialKind === 'string' ? text(rec.toolDenialKind, 40) : null;
              if (!tool || (!perm && !denial)) continue;
              // a denial the harness recorded without a decision is still a stop, by whatever kind it names
              const by = perm
                ? { decision: text(perm.decision, 20), source: text(perm.source, 40), reason: text(perm.reasonType ?? '', 40), ruleSource: typeof perm.ruleSource === 'string' ? text(perm.ruleSource, 40) : null }
                : { decision: 'reject', source: 'config', reason: denial!, ruleSource: null };
              const stopped = by.decision === 'reject' || denial !== null;
              push(at, 'permissions', `perm:${by.decision}:${by.source}:${by.reason}:${by.ruleSource ?? ''}:${stopped}`, { title: by.decision, detail: '', tone: stopped ? 'stopped' : 'ok', by, tools: [text(tool.startsWith('mcp__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool, 60)] });
            }
          }
        }
        if (rec.isMeta || rec.isCompactSummary || texts.length === 0) return;
        const body = texts.join('\n').trim();
        if (!body) return;
        const origin = promptOrigin(rec, body);
        if (!HUMAN.has(origin)) return;
        turn++;
        skill = null; // a new prompt starts outside any skill
        push(at, 'prompt', `prompt:${line}`, { title: text(promptLine(body, origin), 160), detail: subagent ? 'the task this subagent was given' : origin === 'command' || /^<command-(?:name|message)>/.test(body) ? 'slash command' : origin === 'sdk' ? 'prompt from the SDK' : 'your prompt', tone: 'plain' });
      }
    } catch {
      /* a record of an unexpected shape is left off the path */
    }
  });

  // what the whole path adds up to, so a page of it can still say what the session went through
  const tally = <T>(keyOf: (s: Step & { key: string }) => string | null, make: (s: Step, n: number) => T, n: (s: Step) => number = (s) => s.count) => {
    const seen = new Map<string, { first: Step; count: number }>();
    for (const s of steps) {
      const k = keyOf(s);
      if (k === null) continue;
      const hit = seen.get(k);
      if (hit) hit.count += n(s);
      else seen.set(k, { first: s, count: n(s) });
    }
    return [...seen.values()].map((v) => make(v.first, v.count));
  };
  const hookRuns = new Map<string, { event: string; command: string; runs: number; failed: number }>();
  for (const s of steps) {
    if (s.lane !== 'hooks' || s.tone === 'plain') continue;
    const k = `${s.title}\u0000${s.detail}`;
    const h = hookRuns.get(k) ?? { event: s.title, command: s.detail, runs: 0, failed: 0 };
    h.runs += s.count;
    if (s.tone !== 'ok') h.failed += s.count;
    hookRuns.set(k, h);
  }
  const summary = {
    prompts: turn,
    instructions: tally((s) => (s.lane === 'context' && s.key.startsWith('file:') ? s.key : null), (s) => s.title).length,
    hooks: [...hookRuns.values()],
    skills: tally((s) => (s.lane === 'skills' ? s.key : null), (s, count) => ({ name: s.title, count }), () => 1),
    permissions: tally((s) => (s.by ? s.key : null), (s, count) => ({ ...s.by!, count })).sort((a, b) => b.count - a.count),
    agents: tally((s) => (s.lane === 'agents' ? s.key : null), (s, count) => ({ type: s.title, count })),
    mcp: tally((s) => (s.lane === 'mcp' ? s.key : null), (s, count) => ({ server: s.title, count })),
  };
  return { steps: steps.map(({ key: _key, ...s }) => s), summary };
}
