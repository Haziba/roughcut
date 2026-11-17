import { Mesh, edgeKey } from './mesh';
import { type V3, basis, cross, dot, len, norm, onSegmentInterior, sub } from './vec';

/** Parse binary or ASCII STL into a flat list of triangle corners (9 numbers per triangle). */
export function parseStl(buf: ArrayBuffer): Float32Array {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(buf);
  const nums = [...text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [+m[1], +m[2], +m[3]]);
  if (!nums.length || nums.length % 9 || nums.some(Number.isNaN)) throw new Error('Not an STL file');
  return Float32Array.from(nums);
}

export function bounds(tris: Float32Array): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], tris[i]);
    hi[i % 3] = Math.max(hi[i % 3], tris[i]);
  }
  return [lo, hi];
}

class UnionFind {
  p: number[];
  constructor(n: number) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  union(a: number, b: number) { this.p[this.find(a)] = this.find(b); }
}

/**
 * Turn STL triangles back into edge-and-face geometry: flat neighbouring triangles merge
 * into one face with real edges, and each separate connected chunk becomes its own mesh.
 * `scale` converts file units to mm.
 *
 * ponytail: T-junctions (a vertex sitting mid-edge of the neighbouring face) are left as is.
 */
export function meshesFromTriangles(tris: Float32Array, scale: number): Mesh[] {
  // Weld corners to a 0.01 mm grid.
  const verts: V3[] = [];
  const ids = new Map<string, number>();
  const vid = (x: number, y: number, z: number) => {
    const p: V3 = [x * scale, y * scale, z * scale];
    const k = p.map((c) => Math.round(c * 100)).join(',');
    let id = ids.get(k);
    if (id === undefined) {
      id = verts.length;
      ids.set(k, id);
      verts.push(p);
    }
    return id;
  };
  const T: [number, number, number][] = [];
  const N: V3[] = [];
  for (let i = 0; i < tris.length; i += 9) {
    const t: [number, number, number] = [
      vid(tris[i], tris[i + 1], tris[i + 2]),
      vid(tris[i + 3], tris[i + 4], tris[i + 5]),
      vid(tris[i + 6], tris[i + 7], tris[i + 8]),
    ];
    const c = cross(sub(verts[t[1]], verts[t[0]]), sub(verts[t[2]], verts[t[0]]));
    if (len(c) < 1e-6) continue;
    T.push(t);
    N.push(norm(c));
  }

  // Triangles sharing an edge: same flat region if coplanar; same chunk regardless.
  const byEdge = new Map<string, number[]>();
  T.forEach((t, i) => t.forEach((a, k) => {
    const key = edgeKey(a, t[(k + 1) % 3]);
    (byEdge.get(key) ?? byEdge.set(key, []).get(key)!).push(i);
  }));
  const region = new UnionFind(T.length);
  const chunk = new UnionFind(T.length);
  const planeD = T.map((t, i) => dot(N[i], verts[t[0]]));
  for (const list of byEdge.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const [i, j] = [list[x], list[y]];
        chunk.union(i, j);
        if (dot(N[i], N[j]) > 1 - 1e-6 && Math.abs(planeD[i] - planeD[j]) < 0.01) region.union(i, j);
      }
    }
  }

  // Boundary of each region: half-edges whose reverse isn't in the same region.
  const regions = new Map<number, number[]>();
  T.forEach((_, i) => {
    const r = region.find(i);
    (regions.get(r) ?? regions.set(r, []).get(r)!).push(i);
  });
  const faces: { chunk: number; normal: V3; loops: number[][] }[] = [];
  for (const members of regions.values()) {
    const half = new Set<string>();
    for (const i of members) T[i].forEach((a, k) => half.add(`${a}>${T[i][(k + 1) % 3]}`));
    const next = new Map<number, number[]>();
    for (const h of half) {
      const [a, b] = h.split('>').map(Number);
      if (half.has(`${b}>${a}`)) continue;
      (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    }
    const loops: number[][] = [];
    for (const start of next.keys()) {
      while (next.get(start)!.length) {
        const loop: number[] = [];
        let v = start;
        do {
          loop.push(v);
          v = next.get(v)!.pop()!;
        } while (v !== start && v !== undefined && loop.length <= half.size);
        if (v === start && loop.length >= 3) loops.push(loop);
      }
    }
    if (loops.length) faces.push({ chunk: chunk.find(members[0]), normal: N[members[0]], loops });
  }

  // Drop vertices that sit mid-way along a straight run (left over from triangulation).
  const adj = new Map<number, Set<number>>();
  for (const f of faces) {
    for (const l of f.loops) {
      l.forEach((a, k) => {
        const b = l[(k + 1) % l.length];
        (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
        (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
      });
    }
  }
  const redundant = (v: number) => {
    const nb = adj.get(v)!;
    if (nb.size !== 2) return false;
    const [x, y] = [...nb];
    return onSegmentInterior(verts[v], verts[x], verts[y]);
  };

  const meshes = new Map<number, Mesh>();
  for (const f of faces) {
    const loops = f.loops.map((l) => l.filter((v) => !redundant(v))).filter((l) => l.length >= 3);
    if (!loops.length) continue;
    // Outer loop = the one with the largest positive area about the face normal; the rest are holes.
    const [u, w] = basis(f.normal);
    const area = (l: number[]) => l.reduce((s, a, k) => {
      const b = l[(k + 1) % l.length];
      return s + dot(verts[a], u) * dot(verts[b], w) - dot(verts[b], u) * dot(verts[a], w);
    }, 0);
    loops.sort((a, b) => area(b) - area(a));
    let m = meshes.get(f.chunk);
    if (!m) meshes.set(f.chunk, (m = new Mesh()));
    for (const l of loops) {
      l.forEach((a, k) => {
        const b = l[(k + 1) % l.length];
        m.edges.set(edgeKey(a + 1, b + 1), [a + 1, b + 1]);
        m.verts.set(a + 1, verts[a]);
        m.verts.set(b + 1, verts[b]);
      });
    }
    const id = verts.length + 1 + m.faces.size;
    m.faces.set(id, { id, loops: loops.map((l) => l.map((v) => v + 1)), color: null });
  }
  for (const m of meshes.values()) m.nextId = verts.length + 1 + m.faces.size + 1;
  return [...meshes.values()];
}
