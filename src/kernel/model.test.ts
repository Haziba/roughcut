import { describe, expect, it } from 'vitest';
import { Mesh } from './mesh';
import { copyGroup, deserialize, explode, makeComponent, makeUnique, newGroup, serialize, walk } from './model';
import type { V3 } from './vec';

const square = (m = new Mesh()) => {
  const p: V3[] = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]];
  p.forEach((a, i) => m.addEdge(a, p[(i + 1) % 4]));
  return m;
};

/** Root with two instances of one "Leg" definition, which has a nested group. */
const twoLegs = () => {
  const root = newGroup('Model');
  const leg = makeComponent(newGroup('Leg', square()));
  leg.children.push(newGroup('Foot', square()));
  const leg2 = copyGroup(leg);
  leg2.offset = [500, 0, 0];
  root.children.push(leg, leg2);
  return { root, leg, leg2 };
};

describe('components', () => {
  it('copies of an instance share contents but not placement', () => {
    const { leg, leg2 } = twoLegs();
    expect(leg2.id).not.toBe(leg.id);
    expect(leg2.mesh).toBe(leg.mesh);
    expect(leg2.children).toBe(leg.children);
    leg.mesh.addEdge([0, 0, 0], [100, 100, 0]);
    expect(leg2.mesh.faces.size).toBe(2);
    leg.children = [];
    expect(leg2.children).toEqual([]);
    expect(leg.offset).toEqual([0, 0, 0]);
  });

  it('copies of a plain group are deep with fresh ids', () => {
    const g = newGroup('G', square());
    g.children.push(newGroup('Kid'));
    const c = copyGroup(g);
    expect(c.mesh).not.toBe(g.mesh);
    expect(c.children[0].id).not.toBe(g.children[0].id);
    expect(c.def).toBeUndefined();
  });

  it('save and load keep instances sharing, writing the definition once', () => {
    const { root } = twoLegs();
    const file = JSON.parse(JSON.stringify(serialize(root, 'metric')));
    expect(file.definitions).toHaveLength(1);
    expect(file.root.children[1].mesh).toBeUndefined();
    const [a, b] = deserialize(file).root.children;
    expect(a.def).toBe(b.def);
    expect(a.def!.name).toBe('Leg');
    expect(a.mesh).toBe(b.mesh);
    expect(a.children[0]).toBe(b.children[0]);
    expect(b.offset).toEqual([500, 0, 0]);
    a.def!.name = 'Table leg';
    expect(b.def!.name).toBe('Table leg');
  });

  it('old files without definitions still load', () => {
    const root = newGroup('Model');
    root.children.push(newGroup('G', square()));
    const file = JSON.parse(JSON.stringify(serialize(root, 'metric')));
    expect(file.definitions).toBeUndefined();
    expect(deserialize(file).root.children[0].mesh.faces.size).toBe(1);
  });

  it('make unique breaks sharing', () => {
    const { leg, leg2 } = twoLegs();
    makeUnique(leg2);
    expect(leg2.def).not.toBe(leg.def);
    expect(leg2.mesh).not.toBe(leg.mesh);
    expect(leg2.children[0]).not.toBe(leg.children[0]);
    leg2.mesh.addEdge([0, 0, 0], [100, 100, 0]);
    expect(leg.mesh.faces.size).toBe(1);
  });
});

describe('explode', () => {
  it('applies the placement and merges into the parent', () => {
    const root = newGroup('Model', square());
    const g = newGroup('G', square());
    g.offset = [100, 0, 0];
    g.rot = [0, -1, 0, 1, 0, 0, 0, 0, 1]; // 90° about Z
    const kid = newGroup('Kid');
    kid.offset = [10, 0, 0];
    g.children.push(kid);
    g.dims.push({ a: [0, 0, 0], b: [100, 0, 0], off: [0, 0, 10] });
    root.children.push(g);
    const out = explode(root, g);
    expect(root.children).toEqual([kid]);
    expect(kid.offset).toEqual([100, 10, 0]);
    expect(out.faces).toHaveLength(1);
    const pts = root.mesh.faces.get(out.faces[0])!.loops[0].map((v) => root.mesh.pos(v));
    expect(pts.map((p) => p[0]).sort((a, b) => a - b)).toEqual([0, 0, 100, 100]);
    // Welded onto the parent's square: still 4 verts.
    expect(root.mesh.verts.size).toBe(4);
    expect(root.dims[0].b).toEqual([100, 100, 0]);
  });

  it('exploding an instance copies its children instead of stealing them', () => {
    const { root, leg, leg2 } = twoLegs();
    explode(root, leg2);
    expect(root.children).toHaveLength(2);
    expect(root.children[1]).not.toBe(leg.children[0]);
    expect(root.children[1].offset).toEqual([500, 0, 0]);
    expect(leg.children).toHaveLength(1);
  });

  it('flips faces under a mirror', () => {
    const root = newGroup('Model');
    const g = newGroup('G', square());
    g.rot = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
    root.children.push(g);
    const out = explode(root, g);
    const f = root.mesh.faces.get(out.faces[0])!;
    expect(root.mesh.faceNormal(f)).toEqual(g.mesh.faceNormal([...g.mesh.faces.values()][0]));
  });
});

describe('copyGroup', () => {
  it('gives fresh ids throughout and shares no geometry', () => {
    const g = newGroup('Cabinet', new Mesh());
    g.mesh.addEdge([0, 0, 0], [10, 0, 0]);
    g.children = [newGroup('Door'), newGroup('Shelf')];
    g.children[0].children = [newGroup('Handle')];
    const c = copyGroup(g);
    const ids = [...walk(g)].map(([x]) => x.id);
    const copied = [...walk(c)].map(([x]) => x.id);
    expect(copied).toHaveLength(4);
    expect(copied.some((id) => ids.includes(id))).toBe(false);
    expect(c.name).toBe('Cabinet');
    expect(c.mesh).not.toBe(g.mesh);
    c.mesh.addEdge([0, 0, 0], [0, 10, 0]);
    expect(g.mesh.edges.size).toBe(1);
  });
});
