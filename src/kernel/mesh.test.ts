import { describe, expect, it } from 'vitest';
import { Mesh } from './mesh';
import type { V3 } from './vec';

const rect = (m: Mesh, x0: number, y0: number, x1: number, y1: number, z = 0) => {
  const p: V3[] = [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
  p.forEach((a, i) => m.addEdge(a, p[(i + 1) % 4]));
};
const faces = (m: Mesh) => [...m.faces.values()];
const faceAtZ = (m: Mesh, z: number) =>
  faces(m).find((f) => f.loops[0].every((v) => Math.abs(m.pos(v)[2] - z) < 1e-6))!;

describe('faces from edges', () => {
  it('closing a loop makes a face, facing down on the ground', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 50);
    expect(faces(m)).toHaveLength(1);
    expect(m.faceNormal(faces(m)[0])).toEqual([0, 0, -1]);
  });

  it('a line across a face splits it in two', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 50);
    m.addEdge([40, 0, 0], [40, 50, 0]);
    expect(faces(m)).toHaveLength(2);
    expect(m.edges.size).toBe(7);
  });

  it('crossing lines split each other', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 100);
    m.addEdge([50, 0, 0], [50, 100, 0]);
    m.addEdge([0, 50, 0], [100, 50, 0]);
    expect(faces(m)).toHaveLength(4);
  });

  it('a rectangle drawn inside a face cuts a hole and fills it', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 100);
    faces(m)[0].color = '#a0522d';
    rect(m, 25, 25, 75, 75);
    expect(faces(m)).toHaveLength(2);
    const outer = faces(m).find((f) => f.loops.length === 2)!;
    expect(outer).toBeDefined();
    expect(faces(m).every((f) => f.color === '#a0522d')).toBe(true);
  });

  it('a dangling line does not make faces', () => {
    const m = new Mesh();
    m.addEdge([0, 0, 0], [10, 0, 0]);
    m.addEdge([10, 0, 0], [10, 10, 0]);
    expect(faces(m)).toHaveLength(0);
  });

  it('erasing the edge between coplanar faces merges them', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 50);
    m.addEdge([40, 0, 0], [40, 50, 0]);
    const k = [...m.edges.values()].find(([a, b]) => m.pos(a)[0] === 40 && m.pos(b)[0] === 40)!;
    m.eraseEdge(k[0], k[1]);
    expect(faces(m)).toHaveLength(1);
    expect(m.edges.size).toBe(4);
    expect(m.verts.size).toBe(4);
  });

  it('an erased face stays erased when an unrelated line is drawn', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 50);
    m.deleteFace(faces(m)[0].id);
    m.addEdge([0, 0, 0], [-50, 0, 0]);
    expect(faces(m)).toHaveLength(0);
  });
});

describe('push/pull', () => {
  it('a lone rectangle becomes a closed box', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 50);
    const f = faces(m)[0];
    m.pushPull(f.id, -18); // ground face points down, so pull "up" is negative along its normal
    expect(faces(m)).toHaveLength(6);
    expect(m.edges.size).toBe(12);
    expect(m.verts.size).toBe(8);
    const top = faceAtZ(m, 18);
    expect(m.faceNormal(top)).toEqual([0, 0, 1]);
    expect(m.faceNormal(faceAtZ(m, 0))).toEqual([0, 0, -1]);
  });

  it('pushing the top of a box extends it without a seam', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 50);
    m.pushPull(faces(m)[0].id, -18);
    m.pushPull(faceAtZ(m, 18).id, 10);
    expect(faces(m)).toHaveLength(6);
    expect(m.edges.size).toBe(12);
    expect(m.verts.size).toBe(8);
    expect(faceAtZ(m, 28)).toBeDefined();
  });

  it('pushing a rectangle on a box top down cuts a pocket', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 100);
    m.pushPull(faces(m)[0].id, -50);
    rect(m, 25, 25, 75, 75, 50);
    const inner = faces(m).find((f) => f.loops.length === 1 && f.loops[0].every((v) => m.pos(v)[2] === 50))!;
    m.pushPull(inner.id, -20);
    expect(faces(m)).toHaveLength(11);
    const bottom = faceAtZ(m, 30);
    expect(m.faceNormal(bottom)).toEqual([0, 0, 1]);
  });
});

describe('push/pull through a solid', () => {
  const board = (w = 100, d = 100, t = 18) => {
    const m = new Mesh();
    rect(m, 0, 0, w, d);
    m.pushPull(faces(m)[0].id, -t);
    return m;
  };
  const topRect = (m: Mesh, x0: number, y0: number, x1: number, y1: number, z = 18) => {
    rect(m, x0, y0, x1, y1, z);
    const on = (v: number) => {
      const [x, y, zz] = m.pos(v);
      return zz === z && x >= x0 && x <= x1 && y >= y0 && y <= y1;
    };
    return faces(m).find((f) => f.loops.length === 1 && f.loops[0].every(on))!;
  };
  /** Closed 2-manifold: every edge borders exactly two faces and every face edge is an edge. */
  const expectClosed = (m: Mesh) => {
    for (const [a, b] of m.edges.values()) expect(m.facesWithEdge(a, b)).toHaveLength(2);
    for (const f of faces(m)) for (const l of f.loops) l.forEach((v, i) => {
      expect(m.edges.has([v, l[(i + 1) % l.length]].sort((x, y) => x - y).join('_'))).toBe(true);
    });
  };

  it('pushing a rectangle the full thickness leaves a through-hole', () => {
    const m = board();
    m.pushPull(topRect(m, 25, 25, 75, 75).id, -18);
    expect(faces(m)).toHaveLength(10);
    expect(faceAtZ(m, 0).loops).toHaveLength(2);
    expect(faceAtZ(m, 18).loops).toHaveLength(2);
    const walls = faces(m).filter((f) => f.loops[0].every((v) => {
      const [x, y] = m.pos(v);
      return x >= 25 && x <= 75 && y >= 25 && y <= 75;
    }));
    expect(walls).toHaveLength(4);
    expect(m.faceNormal(faceAtZ(m, 0))).toEqual([0, 0, -1]);
    expectClosed(m);
  });

  it('a hole near a corner', () => {
    const m = board();
    m.pushPull(topRect(m, 2, 2, 10, 10).id, -18);
    expect(faces(m)).toHaveLength(10);
    expect(faceAtZ(m, 0).loops).toHaveLength(2);
    expectClosed(m);
  });

  it('pushing less than the thickness still makes a pocket and leaves the far face alone', () => {
    const m = board();
    m.pushPull(topRect(m, 25, 25, 75, 75).id, -10);
    expect(faces(m)).toHaveLength(11);
    expect(faceAtZ(m, 0).loops).toHaveLength(1);
    expect(faceAtZ(m, 0).loops[0]).toHaveLength(4);
    expectClosed(m);
  });

  it('a rectangle touching the edge pushed through makes a slot', () => {
    const m = board();
    m.pushPull(topRect(m, 25, 0, 75, 40).id, -18);
    // top and bottom become U shapes, the front splits in two, the slot has 3 walls
    expect(faces(m)).toHaveLength(10);
    const bottom = faceAtZ(m, 0);
    expect(bottom.loops).toHaveLength(1);
    expect(bottom.loops[0]).toHaveLength(8);
    expectClosed(m);
  });

  it('a pocket touching the edge makes a notch', () => {
    const m = board();
    m.pushPull(topRect(m, 25, 0, 75, 40).id, -10);
    expect(faces(m)).toHaveLength(10);
    expect(faceAtZ(m, 0).loops[0]).toHaveLength(4);
    expectClosed(m);
  });
});

describe('connected', () => {
  it('selects a whole box but not a separate one', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 50);
    m.pushPull(faces(m)[0].id, -18);
    rect(m, 200, 0, 300, 50);
    const box = faceAtZ(m, 18);
    const { faces: fs, edges } = m.connected(box.loops[0]);
    expect(fs).toHaveLength(6);
    expect(edges).toHaveLength(12);
  });

  it('includes the walls of a through-hole', () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 100);
    m.pushPull(faces(m)[0].id, -18);
    rect(m, 25, 25, 75, 75, 18);
    const inner = faces(m).find((f) => f.loops.length === 1 && f.loops[0].every((v) => m.pos(v)[2] === 18) && f.loops[0].some((v) => m.pos(v)[0] === 25))!;
    m.pushPull(inner.id, 18);
    const top = faces(m).find((f) => f.loops.length === 2 && f.loops[0].every((v) => m.pos(v)[2] === 18))!;
    expect(m.connected(top.loops[0]).faces).toHaveLength(faces(m).length);
  });
});

describe('mirroring', () => {
  const box = () => {
    const m = new Mesh();
    rect(m, 0, 0, 100, 50);
    m.pushPull(faces(m)[0].id, -30);
    return m;
  };
  /** Every face's normal points away from the centre of the given faces' vertices. */
  const outward = (m: Mesh, ids: number[]) => {
    const vs = [...new Set(ids.flatMap((id) => m.faces.get(id)!.loops.flat()))].map((v) => m.pos(v));
    const c = [0, 1, 2].map((i) => vs.reduce((s, p) => s + p[i], 0) / vs.length);
    for (const id of ids) {
      const f = m.faces.get(id)!;
      const p = m.pos(f.loops[0][0]), n = m.faceNormal(f);
      expect(n[0] * (p[0] - c[0]) + n[1] * (p[1] - c[1]) + n[2] * (p[2] - c[2])).toBeGreaterThan(0);
    }
  };

  it('mirrored in place keeps outward normals once faces are reversed', () => {
    const m = box();
    const ids = [...m.faces.keys()];
    outward(m, ids);
    m.mapVerts(m.verts.keys(), ([x, y, z]) => [-x, y, z]);
    m.reverseFaces(ids);
    outward(m, ids);
  });

  it('a mirrored copy is a separate solid with outward normals', () => {
    const m = box();
    const ids = [...m.faces.keys()];
    m.copyGeometry(ids, [], ([x, y, z]) => [-x - 10, y, z], true);
    expect(m.faces.size).toBe(12);
    expect(m.verts.size).toBe(16);
    outward(m, [...m.faces.keys()].filter((id) => !ids.includes(id)));
  });

  it('a copy touching the original welds onto its vertices', () => {
    const m = box();
    m.copyGeometry([...m.faces.keys()], [], ([x, y, z]) => [x + 100, y, z]);
    expect(m.verts.size).toBe(12);
  });
});
