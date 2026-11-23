// Where the parts of the harness stand on the stage, shared by the live map and the session replay.
import type { Shape, StageNode } from './stage';

export const CATEGORY: Record<string, { title: string; shape: Shape; hue: string }> = {
  exec: { title: 'Shell', shape: 'crate', hue: 'var(--s2)' },
  read: { title: 'Read and search', shape: 'crate', hue: 'var(--s3)' },
  write: { title: 'Edit and write', shape: 'crate', hue: 'var(--s5)' },
  fetch: { title: 'Web', shape: 'crate', hue: 'var(--s1)' },
  agent: { title: 'Subagents', shape: 'cluster', hue: 'var(--s8)' },
  mcp: { title: 'MCP servers', shape: 'drum', hue: 'var(--s7)' },
  other: { title: 'Other tools', shape: 'crate', hue: 'var(--s-other)' },
};
export const CATEGORY_ORDER = ['exec', 'read', 'write', 'fetch', 'agent', 'mcp', 'other'];

export type Part = Omit<StageNode, 'at' | 'narrowAt' | 'shape' | 'hue' | 'id'>;

/**
 * You, the harness, up to two models above it, the gate, and the tools in a column on the right.
 * Returns the nodes and the two canvas sizes that fit them. `compact` draws the same machine on a
 * smaller canvas, for a stage that shares its row with a panel.
 */
export function machine(parts: { you: Part; harness: Part; gate: Part; models: Part[]; targets: Array<{ category: string } & Part> }, compact = false) {
  const nodes: StageNode[] = [];
  const models = parts.models.slice(0, 2);
  const n = parts.targets.length;
  const x = compact ? { you: 84, harness: 306, gate: 530, tools: 740, width: 1010 } : { you: 120, harness: 400, gate: 680, tools: 950, width: 1180 };
  const gap = n > 5 ? 88 : 104;
  const half = ((n - 1) / 2) * gap;
  const mid = Math.max(370, Math.round(half) + 96);
  nodes.push({ id: 'you', shape: 'desk', hue: 'var(--s-other)', at: [x.you, mid], narrowAt: [92, 96], ...parts.you });
  nodes.push({ id: 'harness', shape: 'slab', hue: 'var(--s1)', at: [x.harness, mid], narrowAt: [200, 310], ...parts.harness });
  models.forEach((m, i) => {
    nodes.push({ id: `model:${i}`, shape: 'cube', hue: 'var(--s6)', at: [x.harness + (i - (models.length - 1) / 2) * 230, mid - 186], narrowAt: i === 0 ? [312, 150] : null, labelAbove: true, ...m });
  });
  nodes.push({ id: 'gate', shape: 'gate', hue: 'var(--s4)', at: [x.gate, mid], narrowAt: [200, 600], labelDx: -36, ...parts.gate });
  parts.targets.forEach((t, i) => {
    const c = CATEGORY[t.category] ?? CATEGORY.other;
    const { category, ...rest } = t;
    const k = i - (n - 1) / 2;
    nodes.push({
      id: `t:${category}`,
      shape: c.shape,
      hue: c.hue,
      // a shallow bow, so the paths from the gate spread instead of stacking
      at: [Math.round(x.tools - k * k * 7), Math.round(mid + 8 + k * gap)],
      narrowAt: [i % 2 ? 300 : 100, 790 + Math.floor(i / 2) * 140],
      labelRight: true,
      ...rest,
      title: rest.title || c.title,
    });
  });
  return { nodes, size: [x.width, mid + Math.max(Math.round(half) + 84, 150)] as [number, number], narrowSize: [400, 790 + Math.ceil(n / 2) * 140] as [number, number] };
}

/** How many dots a path carries for a count of events: none, then one more per order of magnitude or so. */
export const flow = (count: number) => (count <= 0 ? 0 : count < 25 ? 1 : count < 400 ? 2 : 3);
