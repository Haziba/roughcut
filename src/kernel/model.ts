import type { Guide } from './guides';
import { Mesh, type MeshData } from './mesh';
import type { Units } from './units';
import type { V3 } from './vec';
import { I3, IDENTITY, type M3, type Xform, apply, applyDir, compose, det } from './xform';

/** A dimension annotation: measured from a to b, drawn shifted by off. Local coords. */
export interface Dim {
  a: V3;
  b: V3;
  off: V3;
}

/** A group isolates its own geometry from everything around it. Placed by rot then offset. */
export interface Group {
  id: string;
  name: string;
  mesh: Mesh;
  children: Group[];
  offset: V3;
  rot: M3;
  hidden: boolean;
  dims: Dim[];
  /** Set on a component instance: mesh, children and dims then read and write the definition's. */
  def?: Def;
  guides: Guide[];
  /** An AI-generated stand-in model shown in place of this group's (box) geometry. */
  prop?: { id: string; prompt: string };
}

/** A component definition: contents shared by every instance. */
export interface Def {
  id: string;
  name: string;
  mesh: Mesh;
  children: Group[];
  dims: Dim[];
}

interface GroupData extends Omit<Group, 'mesh' | 'children' | 'dims' | 'def'> {
  mesh?: MeshData;
  children?: GroupData[];
  dims?: Dim[];
  /** Definition id, for instances; their contents live in FileData.definitions. */
  def?: string;
}

interface DefData {
  id: string;
  name: string;
  mesh: MeshData;
  children: GroupData[];
  dims: Dim[];
}

export interface FileData {
  app: 'room-planner';
  version: 1;
  units: Units;
  root: GroupData;
  definitions?: DefData[];
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export const newGroup = (name: string, mesh = new Mesh()): Group => ({
  id: newId(), name, mesh, children: [], offset: [0, 0, 0], rot: I3, hidden: false, dims: [], guides: [],
});

const contentsToData = (g: Pick<Group, 'mesh' | 'children' | 'dims'>, defs: Map<string, DefData>) => ({
  mesh: g.mesh.toJSON(), children: g.children.map((c) => groupToData(c, defs)), dims: structuredClone(g.dims),
});

/** Instances write only their placement; each definition goes into defs once. */
const groupToData = (g: Group, defs: Map<string, DefData>): GroupData => {
  const { mesh: _m, children: _c, dims: _d, def, ...rest } = g;
  if (!def) return { ...rest, guides: structuredClone(g.guides), ...contentsToData(g, defs) };
  if (!defs.has(def.id)) defs.set(def.id, { id: def.id, name: def.name, ...contentsToData(def, defs) });
  return { ...rest, guides: structuredClone(g.guides), def: def.id };
};

export function serialize(root: Group, units: Units): FileData {
  const defs = new Map<string, DefData>();
  const data: FileData = { app: 'room-planner', version: 1, units, root: groupToData(root, defs) };
  if (defs.size) data.definitions = [...defs.values()];
  return data;
}

export function deserialize(data: unknown): { root: Group; units: Units } {
  const d = data as FileData;
  if (d?.app !== 'room-planner' || d.version !== 1 || !d.root) throw new Error('Not a Roughcut file');
  const defData = new Map((d.definitions ?? []).map((x) => [x.id, x]));
  const defs = new Map<string, Def>();
  const getDef = (id: string): Def => {
    let def = defs.get(id);
    if (def) return def;
    const x = defData.get(id);
    if (!x) throw new Error(`Missing component definition ${id}`);
    def = { id, name: x.name, mesh: Mesh.from(x.mesh), children: [], dims: x.dims ?? [] };
    defs.set(id, def);
    def.children = x.children.map(fromData);
    return def;
  };
  const fromData = (g: GroupData): Group => {
    const { def, mesh: _m, children: _c, dims: _d, ...rest } = g;
    const out = { ...rest, rot: g.rot ?? I3, guides: g.guides ?? [] } as Group;
    if (def) return linkDef(out, getDef(def));
    return { ...out, mesh: Mesh.from(g.mesh!), children: (g.children ?? []).map(fromData), dims: g.dims ?? [] };
  };
  return { root: fromData(d.root), units: d.units === 'imperial' ? 'imperial' : 'metric' };
}

const CONTENTS = ['mesh', 'children', 'dims'] as const;

/** Make g an instance of def: its contents become the definition's (reads and writes). */
export function linkDef(g: Group, def: Def): Group {
  g.def = def;
  for (const k of CONTENTS) {
    Object.defineProperty(g, k, {
      get: () => def[k], set: (v) => { (def as unknown as Record<string, unknown>)[k] = v; }, enumerable: true, configurable: true,
    });
  }
  return g;
}

/** Turn a group into the first instance of a new definition holding its current contents. */
export const makeComponent = (g: Group, name = g.name) =>
  linkDef(g, { id: newId(), name, mesh: g.mesh, children: g.children, dims: g.dims });

const copyContents = (g: Group) => ({ mesh: g.mesh.clone(), children: g.children.map(copyGroup), dims: structuredClone(g.dims) });

/** A copy for Copy/duplicate: groups deep-copy with fresh ids, instances become new instances of the same definition. */
export function copyGroup(g: Group): Group {
  const { mesh: _m, children: _c, dims: _d, ...rest } = g;
  const c = { ...rest, id: newId(), offset: [...g.offset] as V3, rot: [...g.rot], guides: structuredClone(g.guides) } as Group;
  return g.def ? linkDef(c, g.def) : Object.assign(c, copyContents(g));
}

/** Give an instance its own private copy of its definition. */
export function makeUnique(g: Group) {
  if (g.def) linkDef(g, { id: newId(), name: `${g.def.name} copy`, ...copyContents(g) });
}

/**
 * Dissolve child g into parent: its geometry merges into the parent's mesh and its children
 * become siblings, all with g's placement applied. Returns what came out, for selecting.
 */
export function explode(parent: Group, g: Group) {
  const x = localXform(g);
  const { faces, edges } = parent.mesh.merge(g.mesh, (p) => apply(x, p), det(x.r) < 0);
  const kids = g.def ? g.children.map(copyGroup) : g.children;
  for (const k of kids) {
    const c = compose(x, localXform(k));
    k.rot = c.r;
    k.offset = c.t;
  }
  parent.dims = [...parent.dims, ...g.dims.map((d) => ({ a: apply(x, d.a), b: apply(x, d.b), off: applyDir(x, d.off) }))];
  parent.children = [...parent.children.filter((c) => c !== g), ...kids];
  return { faces, edges, groups: kids.map((k) => k.id) };
}

export function* walk(g: Group, parents: Group[] = []): Generator<[Group, Group[]]> {
  yield [g, parents];
  for (const c of g.children) yield* walk(c, [...parents, g]);
}

export const findGroup = (root: Group, id: string) => {
  for (const [g, parents] of walk(root)) if (g.id === id) return { group: g, parents };
  return null;
};

export const localXform = (g: Pick<Group, 'rot' | 'offset'>): Xform => ({ r: g.rot, t: g.offset });

/** Group-local → world transform for a chain of groups from the root. */
export const worldXform = (path: Pick<Group, 'rot' | 'offset'>[]) =>
  path.reduce<Xform>((x, g) => compose(x, localXform(g)), IDENTITY);
