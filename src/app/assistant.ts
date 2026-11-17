import { Mesh } from '../kernel/mesh';
import { type Group, copyGroup, findGroup, localXform, newGroup, newId, walk, worldXform } from '../kernel/model';
import { ngon } from '../kernel/shapes';
import { type V3, add, scale, sub } from '../kernel/vec';
import { type Xform, apply, applyDir, compose, invert, rotation, scaling } from '../kernel/xform';
import type { Editor } from './editor';
import { STAGE_LABEL, props } from './props';

export interface ChatMsg {
  role: 'user' | 'assistant' | 'note';
  text: string;
}

export type Action =
  | { op: 'box'; name?: string; size: V3; at: V3; color?: string; parent?: string }
  | { op: 'rect'; size: [number, number]; at: V3; plane?: 'xy' | 'xz' | 'yz' }
  | { op: 'cylinder'; name?: string; radius: number; height: number; at: V3; color?: string; parent?: string }
  | { op: 'generate'; name?: string; prompt: string; size: V3; at: V3; parent?: string }
  | { op: 'move'; id: string; to?: V3; by?: V3 }
  | { op: 'rotate'; id: string; deg: number; axis?: 'x' | 'y' | 'z' }
  | { op: 'resize'; id: string; size: V3 }
  | { op: 'copy'; id: string; by: V3; count?: number }
  | { op: 'rename'; id: string; name: string }
  | { op: 'paint'; id: string; color: string }
  | { op: 'hide'; id: string; hidden?: boolean }
  | { op: 'group'; ids: string[]; name?: string }
  | { op: 'delete'; ids: string[] }
  | { op: 'select'; ids: string[] };

export const SYSTEM_PROMPT = `You are the assistant inside Roughcut, a 3D modeller (edges, faces, Push/Pull, groups) the user runs on their own machine for room planning and woodworking. You chat with the user in a side panel and can change their model.

Every user message starts with a <model> block: the current model as a list of groups with ids, names, parents and world bounding boxes. Coordinates are millimetres, Z is up, the ground is z=0, red = X, green = Y, blue = Z. Use it to answer questions about sizes and positions.

To change the model, end your reply with exactly one fenced block tagged actions holding a JSON array. The app applies the whole array as one undo step (the user can press Cmd+Z). All numbers are millimetres in world coordinates. Operations:
- {"op":"box","name":"Shelf","size":[w,d,h],"at":[x,y,z],"color":"#c8a27a","parent":"<group id, optional>"} — a new solid box group; "at" is its minimum corner.
- {"op":"rect","size":[w,d],"at":[x,y,z],"plane":"xy"} — a flat rectangle drawn as loose geometry in the current editing context, the same as the user drawing it with the Rectangle tool ("xy" lies flat, "xz" and "yz" stand upright); "at" is its minimum corner. Use it when the user asks for a rectangle, outline or face rather than a solid; they can Push/Pull it themselves.
- {"op":"cylinder","name":"Leg","radius":20,"height":720,"at":[x,y,z],"color":"#…","parent":"…"} — an upright round solid; "at" is the centre of its base.
- {"op":"generate","name":"Armchair","prompt":"a mid-century armchair with grey fabric and oak legs","size":[w,d,h],"at":[x,y,z],"parent":"…"} — an AI-made 3D model. A placeholder box of that size appears at once; the model replaces it after about 10 minutes (up to 30 for big boxy things) (it is made on the user's machine, one at a time). The model is stretched to fill the box (turned a quarter if that fits better), front facing -Y. Use this for organic or detailed things (sofas, plants, lamps, people, ornaments, appliances). For simple boxy or turned furniture (tables, shelving, cabinets, beds, legs), build it from boxes and cylinders instead: that is instant and the user can edit it. But whenever the user asks for an AI model, a generated model, a 3D model or a realistic model of something, always use generate for it, whatever it is. Several identical things: give each generate the exact same prompt and they share one model, made once. To replace existing boxes with a model, generate at each box's min corner with its size, then delete the boxes. Make the prompt a clear visual description of one object (shape, materials, colours, style); the size is real-world mm.
- {"op":"move","id":"…","to":[x,y,z]} puts the group's bounding-box minimum corner there; or {"op":"move","id":"…","by":[dx,dy,dz]}.
- {"op":"rotate","id":"…","deg":90,"axis":"z"} about the group's bounding-box centre.
- {"op":"resize","id":"…","size":[w,d,h]} stretches the group so its bounding box has this size, keeping the minimum corner.
- {"op":"copy","id":"…","by":[dx,dy,dz],"count":3} makes count copies, each shifted by "by" from the previous.
- {"op":"rename","id":"…","name":"…"}, {"op":"paint","id":"…","color":"#rrggbb"}, {"op":"hide","id":"…","hidden":true}
- {"op":"group","ids":["…","…"],"name":"…"} wraps sibling groups in a new group.
- {"op":"delete","ids":["…"]}, {"op":"select","ids":["…"]}
Only use ids from the latest <model>. Ids of things you create aren't known until the next turn, so do follow-up edits on new objects in a later turn. Only include an actions block when the user wants a change; if a request is ambiguous, ask first. The chat shows plain text, so don't use Markdown (no **bold**, headings or tables); short lines and simple dashes are fine. Keep prose short and practical, and give sizes in the user's display units. Woodworking sense helps: real board thicknesses (18mm ply, 12mm back panels), clearances, sensible joinery.

If the message contains <last_actions_result>, some of your previous actions failed; take that into account.`;

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmtV = (v: V3) => `[${v.map(r1).join(', ')}]`;

/** Group's world placement and world bounding box (null if it has no geometry). */
function info(ed: Editor, id: string) {
  const found = findGroup(ed.root, id);
  if (!found || found.group === ed.root) return null;
  const parentX = worldXform(found.parents);
  return { ...found, parentX, box: worldBox(found.group, found.parents) };
}

function worldBox(g: Group, parents: Group[]): [V3, V3] | null {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, ps] of walk(g, parents)) {
    const xf = worldXform([...ps, x]);
    for (const p of x.mesh.verts.values()) {
      const w = apply(xf, p);
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], w[i]);
        hi[i] = Math.max(hi[i], w[i]);
      }
    }
  }
  return lo[0] === Infinity ? null : [lo, hi];
}

/** The model as text for the assistant. */
export function describeModel(ed: Editor): string {
  const lines = [
    `Display units: ${ed.units === 'metric' ? 'mm' : 'feet and inches'}`,
    `Editing context: ${ed.path.map((g) => `${g.name} (${g.id})`).join(' > ')}`,
    `Selected groups: ${ed.selection.flatMap((s) => (s.kind === 'group' ? [s.id] : [])).join(', ') || 'none'}`,
    'Groups (id | name | parent | world min → max | size | notes):',
  ];
  let n = 0;
  for (const [g, ps] of walk(ed.root)) {
    if (g === ed.root) continue;
    // ponytail: big models are cut off at 300 groups; send only the relevant subtree if that bites.
    if (++n > 300) {
      lines.push('… (more groups not listed)');
      break;
    }
    const box = worldBox(g, ps);
    const ps2 = g.prop && props.status.get(g.prop.id);
    const prop = g.prop && `AI model "${g.prop.prompt}": ${ps2 ? STAGE_LABEL[ps2.stage] : 'status unknown'}${ps2?.error ? ` (${ps2.error})` : ''}`;
    const notes = [g.def && `instance of component "${g.def.name}"`, g.hidden && 'hidden', prop].filter(Boolean).join(', ');
    lines.push(`${g.id} | ${g.name} | ${ps[ps.length - 1].id} | ${box ? `${fmtV(box[0])} → ${fmtV(box[1])} | ${fmtV(sub(box[1], box[0]))}` : 'empty'}${notes ? ` | ${notes}` : ''}`);
  }
  if (n === 0) lines.push('(none)');
  const loose = ed.root.mesh.faces.size;
  if (loose) lines.push(`Loose (ungrouped) geometry at top level: ${loose} faces. Actions can't move or edit it (only add rectangles to it); suggest grouping it if it needs moving.`);
  return lines.join('\n');
}

/** Split a reply into prose and its actions block. */
export function parseReply(text: string): { prose: string; actions: Action[]; error?: string } {
  const m = text.match(/```actions\s*\n([\s\S]*?)```/);
  if (!m) return { prose: text.trim(), actions: [] };
  const prose = text.replace(m[0], '').trim();
  try {
    const a = JSON.parse(m[1]);
    if (!Array.isArray(a)) throw new Error('not an array');
    return { prose, actions: a };
  } catch (e) {
    return { prose, actions: [], error: `Couldn't read the actions block (${(e as Error).message}).` };
  }
}

const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && isFinite(x));
const AXIS: Record<string, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Re-place group g so its world transform becomes `world ∘ (its current world transform)`. */
function transformGroup(g: Group, parentX: Xform, world: Xform) {
  const local = compose(invert(parentX), compose(world, compose(parentX, localXform(g))));
  g.rot = local.r;
  g.offset = local.t;
}

/** Extrude a closed outline on z=0 straight up into a solid. */
function solid(outline: V3[], h: number, color?: string) {
  const m = new Mesh();
  outline.forEach((a, i) => m.addEdge(a, outline[(i + 1) % outline.length]));
  const f = [...m.faces.values()][0];
  m.pushPull(f.id, m.faceNormal(f)[2] < 0 ? -h : h);
  if (color) for (const x of m.faces.values()) x.color = color;
  return m;
}

const boxMesh = ([w, d, h]: V3, color?: string) => solid([[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0]], h, color);

/** New group in the given parent (or the active group), placed so its local origin lands at world `at`. */
function addGroup(ed: Editor, parentId: string | undefined, name: string, mesh: Mesh, at: V3) {
  const parent = parentId ? findGroup(ed.root, parentId) : { group: ed.active, parents: ed.path.slice(0, -1) };
  if (!parent) return null;
  const g = newGroup(name, mesh);
  g.offset = apply(invert(worldXform([...parent.parents, parent.group])), at);
  parent.group.children = [...parent.group.children, g];
  return g;
}

const PLACEHOLDER = '#cfc8f0';

/** Apply the assistant's actions as one undo step. Returns a message per action that failed. */
export function applyActions(ed: Editor, actions: Action[]): string[] {
  const errors: string[] = [];
  ed.tool.cancel();
  ed.commit(() => {
    for (const a of actions) {
      try {
        const msg = applyOne(ed, a);
        if (msg) errors.push(`${a.op}: ${msg}`);
      } catch (e) {
        errors.push(`${(a as { op?: string }).op ?? '?'}: ${(e as Error).message}`);
      }
    }
  });
  return errors;
}

function applyOne(ed: Editor, a: Action): string | void {
  if (a.op === 'box') {
    if (!isV3(a.size) || a.size.some((s) => s <= 0) || !isV3(a.at)) return 'needs size [w,d,h] > 0 and at [x,y,z]';
    return addGroup(ed, a.parent, a.name || 'Box', boxMesh(a.size, a.color), a.at) ? undefined : `no group ${a.parent}`;
  }
  if (a.op === 'rect') {
    const [w, d] = Array.isArray(a.size) ? a.size : [0, 0];
    if (!(w > 0) || !(d > 0) || !isV3(a.at)) return 'needs size [w,d] > 0 and at [x,y,z]';
    const [u, v]: V3[] = a.plane === 'xz' ? [[1, 0, 0], [0, 0, 1]] : a.plane === 'yz' ? [[0, 1, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
    const pts = [[0, 0], [w, 0], [w, d], [0, d]].map(([i, j]) => ed.toLocal(add(a.at, add(scale(u, i), scale(v, j)))));
    pts.forEach((p, i) => ed.active.mesh.addEdge(p, pts[(i + 1) % 4]));
    return;
  }
  if (a.op === 'cylinder') {
    if (!(a.radius > 0) || !(a.height > 0) || !isV3(a.at)) return 'needs radius > 0, height > 0 and at [x,y,z]';
    const mesh = solid(ngon([0, 0, 0], [0, 0, 1], [a.radius, 0, 0], 24), a.height, a.color);
    return addGroup(ed, a.parent, a.name || 'Cylinder', mesh, a.at) ? undefined : `no group ${a.parent}`;
  }
  if (a.op === 'generate') {
    if (!isV3(a.size) || a.size.some((s) => s <= 0) || !isV3(a.at)) return 'needs size [w,d,h] > 0 and at [x,y,z]';
    if (!a.prompt?.trim()) return 'needs a prompt';
    const g = addGroup(ed, a.parent, a.name || 'AI model', boxMesh(a.size, PLACEHOLDER), a.at);
    if (!g) return `no group ${a.parent}`;
    const prompt = a.prompt.trim();
    // The same prompt again shares the existing model, so a row of identical things is made once.
    for (const [x] of walk(ed.root)) {
      if (x !== g && x.prop?.prompt === prompt && props.status.get(x.prop.id)?.stage !== 'error') {
        g.prop = { ...x.prop };
        return;
      }
    }
    const prop = { id: (newId() + newId()).slice(0, 12), prompt };
    g.prop = prop;
    // After the commit finishes, so the refresh it triggers sees the whole change.
    queueMicrotask(() => props.start(prop.id, prop.prompt));
    return;
  }
  if (a.op === 'delete' || a.op === 'select' || a.op === 'group') {
    if (!Array.isArray(a.ids)) return 'needs ids';
    const found = a.ids.map((id) => findGroup(ed.root, id));
    if (found.some((f) => !f || f.group === ed.root)) return `unknown id in ${a.ids.join(', ')}`;
    const gs = found.map((f) => f!);
    if (a.op === 'delete') {
      for (const f of gs) {
        const parent = f.parents[f.parents.length - 1];
        parent.children = parent.children.filter((c) => c !== f.group);
      }
    } else if (a.op === 'select') {
      ed.selection = gs.filter((f) => f.parents[f.parents.length - 1] === ed.active).map((f) => ({ kind: 'group', id: f.group.id }));
    } else {
      const parent = gs[0].parents[gs[0].parents.length - 1];
      if (gs.some((f) => f.parents[f.parents.length - 1] !== parent)) return 'groups must share a parent';
      const g = newGroup(a.name || 'Group');
      g.children = gs.map((f) => f.group);
      parent.children = [...parent.children.filter((c) => !g.children.includes(c)), g];
    }
    return;
  }
  const t = info(ed, a.id);
  if (!t) return `no group ${a.id}`;
  const { group: g, parentX, box } = t;
  switch (a.op) {
    case 'rename':
      if (!a.name?.trim()) return 'needs name';
      g.name = a.name.trim();
      return;
    case 'hide':
      g.hidden = a.hidden ?? true;
      return;
    case 'paint':
      if (!/^#[0-9a-f]{6}$/i.test(a.color)) return 'color must be #rrggbb';
      for (const [x] of walk(g)) for (const f of x.mesh.faces.values()) f.color = a.color;
      return;
  }
  if (!box) return 'group is empty';
  switch (a.op) {
    case 'move': {
      const by = isV3(a.to) ? sub(a.to, box[0]) : isV3(a.by) ? a.by : null;
      if (!by) return 'needs to or by';
      g.offset = add(g.offset, applyDir(invert(parentX), by));
      return;
    }
    case 'rotate': {
      if (typeof a.deg !== 'number') return 'needs deg';
      const centre = scale(add(box[0], box[1]), 0.5);
      transformGroup(g, parentX, rotation(centre, AXIS[a.axis ?? 'z'] ?? AXIS.z, (a.deg * Math.PI) / 180));
      return;
    }
    case 'resize': {
      if (!isV3(a.size) || a.size.some((s) => s <= 0)) return 'needs size [w,d,h] > 0';
      const cur = sub(box[1], box[0]);
      // ponytail: stretches along world axes, so a group rotated off-axis gets sheared; fine for boxes on the grid.
      const f = a.size.map((s, i) => (cur[i] > 1e-6 ? s / cur[i] : 1)) as V3;
      transformGroup(g, parentX, scaling(box[0], f));
      return;
    }
    case 'copy': {
      if (!isV3(a.by)) return 'needs by';
      const parent = t.parents[t.parents.length - 1];
      const n = Math.max(1, Math.min(100, Math.round(a.count ?? 1)));
      for (let i = 1; i <= n; i++) {
        const c = copyGroup(g);
        c.offset = add(c.offset, applyDir(invert(parentX), scale(a.by, i)));
        parent.children = [...parent.children, c];
      }
      return;
    }
  }
  return `unknown op`;
}

/** Send a message through the local Claude Code bridge. */
export async function ask(prompt: string, sessionId: string | null): Promise<{ text: string; sessionId: string }> {
  const res = await fetch('/api/assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, system: SYSTEM_PROMPT, sessionId }),
  });
  const body = await res.json().catch(() => ({ error: `Assistant unavailable (HTTP ${res.status})` }));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
