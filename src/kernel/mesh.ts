import { ShapeUtils, Vector2 } from 'three';
import {
  type V3, EPS, add, sub, scale, dot, cross, len, norm, dist, basis,
  onSegmentInterior, segmentCrossing, projectOnSegment,
} from './vec';

/** A face: outer loop first (counter-clockwise about its normal), then holes (clockwise). */
export interface Face {
  id: number;
  loops: number[][];
  color: string | null;
}

export interface MeshData {
  verts: [number, number, number, number][];
  edges: [number, number][];
  faces: Face[];
  nextId: number;
}

export interface Plane {
  n: V3;
  d: number;
}

export const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

export function planeFrom3(a: V3, b: V3, c: V3): Plane | null {
  const c3 = cross(sub(b, a), sub(c, a));
  if (len(c3) < 1e-6 * Math.max(1, dist(a, b) * dist(a, c))) return null;
  return canonicalPlane(norm(c3), a);
}

/** Plane with its normal flipped so the largest component is positive, so equal planes compare equal. */
function canonicalPlane(n: V3, p: V3): Plane {
  const i = [0, 1, 2].reduce((m, k) => (Math.abs(n[k]) > Math.abs(n[m]) ? k : m), 0);
  const nn = n[i] < 0 ? scale(n, -1) : n;
  return { n: nn, d: dot(nn, p) };
}

const samePlane = (p: Plane, q: Plane) => Math.abs(dot(p.n, q.n)) > 1 - 1e-9 && Math.abs(p.d - q.d) < EPS;

const area2D = (pts: [number, number][]) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};

/** Point in polygon; points on the boundary count as inside. */
function inPoly(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const cr = (p[0] - xi) * (yj - yi) - (p[1] - yi) * (xj - xi);
    const within = Math.min(xi, xj) - EPS <= p[0] && p[0] <= Math.max(xi, xj) + EPS
      && Math.min(yi, yj) - EPS <= p[1] && p[1] <= Math.max(yi, yj) + EPS;
    if (within && Math.abs(cr) / Math.hypot(xj - xi, yj - yi) < EPS) return true;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Sticky edge/face mesh: edges join at shared vertices,
 * closed coplanar loops become faces, and edges split faces they cross.
 *
 * ponytail: vertex lookup and edge adjacency are linear scans, fine for furniture-sized
 * models; add a spatial hash and adjacency index if large models get slow.
 */
export class Mesh {
  verts = new Map<number, V3>();
  edges = new Map<string, [number, number]>();
  faces = new Map<number, Face>();
  nextId = 1;

  static from(data: MeshData): Mesh {
    const m = new Mesh();
    for (const [id, x, y, z] of data.verts) m.verts.set(id, [x, y, z]);
    for (const [a, b] of data.edges) m.edges.set(edgeKey(a, b), [a, b]);
    for (const f of data.faces) m.faces.set(f.id, { id: f.id, loops: f.loops.map((l) => [...l]), color: f.color });
    m.nextId = data.nextId;
    return m;
  }

  toJSON(): MeshData {
    return {
      verts: [...this.verts].map(([id, p]) => [id, p[0], p[1], p[2]]),
      edges: [...this.edges.values()].map(([a, b]) => [a, b]),
      faces: [...this.faces.values()].map((f) => ({ id: f.id, loops: f.loops.map((l) => [...l]), color: f.color })),
      nextId: this.nextId,
    };
  }

  clone() {
    return Mesh.from(this.toJSON());
  }

  pos(id: number): V3 {
    return this.verts.get(id)!;
  }

  vertexEdges(v: number): [number, number][] {
    return [...this.edges.values()].filter(([a, b]) => a === v || b === v);
  }

  facesWithEdge(a: number, b: number): Face[] {
    return [...this.faces.values()].filter((f) =>
      f.loops.some((l) => l.some((x, i) => {
        const y = l[(i + 1) % l.length];
        return (x === a && y === b) || (x === b && y === a);
      })),
    );
  }

  faceNormal(f: Face): V3 {
    // Newell's method on the outer loop.
    const n: V3 = [0, 0, 0];
    const l = f.loops[0];
    for (let i = 0; i < l.length; i++) {
      const p = this.pos(l[i]), q = this.pos(l[(i + 1) % l.length]);
      n[0] += (p[1] - q[1]) * (p[2] + q[2]);
      n[1] += (p[2] - q[2]) * (p[0] + q[0]);
      n[2] += (p[0] - q[0]) * (p[1] + q[1]);
    }
    return norm(n);
  }

  facePlane(f: Face): Plane {
    return canonicalPlane(this.faceNormal(f), this.pos(f.loops[0][0]));
  }

  /** Triangles of a face as vertex-id triples, honouring holes. */
  triangulate(f: Face): [number, number, number][] {
    const [u, v] = basis(this.faceNormal(f));
    const to2 = (id: number) => { const p = this.pos(id); return new Vector2(dot(p, u), dot(p, v)); };
    const [outer, ...holes] = f.loops;
    const tris = ShapeUtils.triangulateShape(outer.map(to2), holes.map((h) => h.map(to2)));
    const ids = f.loops.flat();
    return tris.map(([a, b, c]) => [ids[a], ids[b], ids[c]]);
  }

  findVertex(p: V3): number | undefined {
    for (const [id, q] of this.verts) if (dist(p, q) < EPS) return id;
    return undefined;
  }

  /** Find or create a vertex at p, splitting any edge it lands on. */
  addVertex(p: V3): number {
    const found = this.findVertex(p);
    if (found !== undefined) return found;
    const id = this.nextId++;
    this.verts.set(id, [...p]);
    for (const [a, b] of this.edges.values()) {
      if (onSegmentInterior(p, this.pos(a), this.pos(b))) {
        this.splitEdge(a, b, id);
        break;
      }
    }
    return id;
  }

  private splitEdge(a: number, b: number, w: number) {
    this.edges.delete(edgeKey(a, b));
    this.edges.set(edgeKey(a, w), [a, w]);
    this.edges.set(edgeKey(w, b), [w, b]);
    for (const f of this.faces.values()) {
      for (const loop of f.loops) {
        for (let i = 0; i < loop.length; i++) {
          const x = loop[i], y = loop[(i + 1) % loop.length];
          if ((x === a && y === b) || (x === b && y === a)) {
            loop.splice(i + 1, 0, w);
            break;
          }
        }
      }
    }
  }

  /**
   * Draw an edge from p to q. Splits at existing vertices and crossings, then forms or
   * splits faces wherever the new edge closes a coplanar loop. Returns the new edge keys.
   */
  addEdge(p: V3, q: V3): string[] {
    if (dist(p, q) < EPS) return [];
    const cuts: V3[] = [];
    for (const v of this.verts.values()) if (onSegmentInterior(v, p, q)) cuts.push(v);
    for (const [a, b] of this.edges.values()) {
      const x = segmentCrossing(p, q, this.pos(a), this.pos(b));
      if (x) cuts.push(x);
    }
    cuts.sort((x, y) => projectOnSegment(x, p, q).t - projectOnSegment(y, p, q).t);
    const ids = [p, ...cuts, q].map((pt) => this.addVertex(pt));
    const created: string[] = [];
    for (let i = 0; i + 1 < ids.length; i++) {
      const [a, b] = [ids[i], ids[i + 1]];
      const k = edgeKey(a, b);
      if (a === b || this.edges.has(k)) continue;
      this.edges.set(k, [a, b]);
      created.push(k);
    }
    this.updateFaces(created);
    return created;
  }

  private updateFaces(newKeys: string[]) {
    if (!newKeys.length) return;
    const planes: Plane[] = [];
    for (const k of newKeys) {
      const [a, b] = this.edges.get(k)!;
      for (const v of [a, b]) {
        for (const [x, y] of this.vertexEdges(v)) {
          const o = x === v ? y : x;
          if (o === a || o === b) continue;
          const pl = planeFrom3(this.pos(a), this.pos(b), this.pos(o));
          if (pl && !planes.some((q) => samePlane(q, pl))) planes.push(pl);
        }
      }
    }
    const fresh = new Set(newKeys);
    for (const pl of planes) this.recomputePlane(pl, fresh, []);
  }

  private facesInPlane(pl: Plane): Face[] {
    const on = (id: number) => Math.abs(dot(pl.n, this.pos(id)) - pl.d) < EPS;
    return [...this.faces.values()].filter((f) => f.loops.every((l) => l.every(on)));
  }

  /**
   * Rebuild every face lying in one plane from the edge graph. A closed region becomes a
   * face when it touches a freshly drawn edge or sits inside a face that was there before;
   * that keeps deliberately erased faces erased.
   */
  private recomputePlane(pl: Plane, fresh: Set<string>, extraParents: Face[]) {
    const on = (id: number) => Math.abs(dot(pl.n, this.pos(id)) - pl.d) < EPS;
    const parents = [...this.facesInPlane(pl), ...extraParents];
    const parentNormals = new Map(parents.map((f) => [f, this.faceNormal(f)]));

    const adj = new Map<number, number[]>();
    for (const [a, b] of this.edges.values()) {
      if (!on(a) || !on(b)) continue;
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
    // Strip dangling edges; they cannot bound a region.
    for (let changed = true; changed;) {
      changed = false;
      for (const [v, nb] of adj) {
        if (nb.length >= 2) continue;
        for (const o of nb) adj.get(o)!.splice(adj.get(o)!.indexOf(v), 1);
        adj.delete(v);
        changed = true;
      }
    }

    const [u, w] = basis(pl.n);
    const p2 = (id: number): [number, number] => { const p = this.pos(id); return [dot(p, u), dot(p, w)]; };
    for (const [v, nb] of adj) {
      const [vx, vy] = p2(v);
      nb.sort((x, y) => {
        const [ax, ay] = p2(x), [bx, by] = p2(y);
        return Math.atan2(ay - vy, ax - vx) - Math.atan2(by - vy, bx - vx);
      });
    }

    // Walk half-edges, always taking the next edge clockwise: traces each region counter-clockwise.
    const seen = new Set<string>();
    const cycles: number[][] = [];
    for (const [v, nb] of adj) {
      for (const n0 of nb) {
        if (seen.has(`${v}>${n0}`)) continue;
        const cyc: number[] = [];
        let x = v, y = n0;
        do {
          seen.add(`${x}>${y}`);
          cyc.push(x);
          const list = adj.get(y)!;
          const z = list[(list.indexOf(x) - 1 + list.length) % list.length];
          x = y;
          y = z;
        } while (!(x === v && y === n0));
        cycles.push(cyc);
      }
    }

    // Connected components, so an island's outline can become a hole in the region around it.
    const comp = new Map<number, number>();
    let c = 0;
    for (const v of adj.keys()) {
      if (comp.has(v)) continue;
      const stack = [v];
      comp.set(v, c);
      while (stack.length) for (const o of adj.get(stack.pop()!)!) if (!comp.has(o)) { comp.set(o, c); stack.push(o); }
      c++;
    }

    const withArea = cycles.map((cyc) => ({ cyc, pts: cyc.map(p2), area: area2D(cyc.map(p2)) }));
    const bounded = withArea.filter((x) => x.area > EPS * EPS);
    const outlines = withArea.filter((x) => x.area < -EPS * EPS);
    const holes = new Map<number[], number[][]>();
    for (const o of outlines) {
      let best: (typeof bounded)[number] | undefined;
      for (const b of bounded) {
        if (comp.get(b.cyc[0]) === comp.get(o.cyc[0])) continue;
        if (!inPoly(o.pts[0], b.pts)) continue;
        if (!best || b.area < best.area) best = b;
      }
      if (best) (holes.get(best.cyc) ?? holes.set(best.cyc, []).get(best.cyc)!).push(o.cyc);
    }

    const insideFace = (f: Face, p: [number, number]) => {
      const [outer, ...hs] = f.loops.map((l) => l.map(p2));
      return inPoly(p, outer) && !hs.some((h) => inPoly(p, h) && !h.some(([hx, hy], i) => {
        const [qx, qy] = h[(i + 1) % h.length];
        return projectOnSegment([p[0], p[1], 0], [hx, hy, 0], [qx, qy, 0]).d < EPS;
      }));
    };

    const newFaces: Face[] = [];
    for (const b of bounded) {
      const hs = holes.get(b.cyc) ?? [];
      const loops = [b.cyc, ...hs];
      const touchesFresh = loops.some((l) => l.some((x, i) => fresh.has(edgeKey(x, l[(i + 1) % l.length]))));
      const tris = ShapeUtils.triangulateShape(
        b.pts.map(([x, y]) => new Vector2(x, y)),
        hs.map((h) => h.map((id) => new Vector2(...p2(id)))),
      );
      const all = loops.flat().map(p2);
      let ip: [number, number] = b.pts[0], best = -1;
      for (const [i, j, k] of tris) {
        const a = Math.abs(area2D([all[i], all[j], all[k]]));
        if (a > best) {
          best = a;
          ip = [(all[i][0] + all[j][0] + all[k][0]) / 3, (all[i][1] + all[j][1] + all[k][1]) / 3];
        }
      }
      const parent = parents.find((f) => insideFace(f, ip));
      if (!touchesFresh && !parent) continue;
      // Default: faces on the ground face down, like the underside of something sitting on it.
      const flip = parent
        ? dot(parentNormals.get(parent)!, pl.n) < 0
        : Math.abs(pl.n[2]) > 0.999 && Math.abs(pl.d) < EPS;
      newFaces.push({
        id: 0,
        loops: flip ? loops.map((l) => [...l].reverse()) : loops.map((l) => [...l]),
        color: parent?.color ?? null,
      });
    }

    for (const f of this.facesInPlane(pl)) this.faces.delete(f.id);
    for (const f of newFaces) {
      f.id = this.nextId++;
      this.faces.set(f.id, f);
    }
  }

  deleteFace(id: number) {
    this.faces.delete(id);
  }

  /** Erase an edge and the faces on it. Two coplanar faces either side merge into one. */
  eraseEdge(a: number, b: number) {
    const k = edgeKey(a, b);
    if (!this.edges.has(k)) return;
    const removed = this.facesWithEdge(a, b);
    const coplanar = removed.length === 2 && samePlane(this.facePlane(removed[0]), this.facePlane(removed[1]));
    const plane = coplanar ? this.facePlane(removed[0]) : null;
    this.edges.delete(k);
    for (const f of removed) this.faces.delete(f.id);
    if (plane) this.recomputePlane(plane, new Set(), removed);
    this.heal(a);
    this.heal(b);
  }

  /** Remove a stray vertex, or one sitting mid-way along a straight line of two edges. */
  heal(v: number) {
    if (!this.verts.has(v)) return;
    const es = this.vertexEdges(v);
    const inLoop = [...this.faces.values()].some((f) => f.loops.some((l) => l.includes(v)));
    if (es.length === 0 && !inLoop) {
      this.verts.delete(v);
      return;
    }
    if (es.length !== 2) return;
    const [x, y] = es.map(([a, b]) => (a === v ? b : a));
    if (!onSegmentInterior(this.pos(v), this.pos(x), this.pos(y))) return;
    this.edges.delete(edgeKey(x, v));
    this.edges.delete(edgeKey(v, y));
    this.edges.set(edgeKey(x, y), [x, y]);
    for (const f of this.faces.values()) f.loops = f.loops.map((l) => l.filter((id) => id !== v));
    this.verts.delete(v);
  }

  /**
   * Push/Pull a face along its normal. A lone face becomes a closed solid; a face on a
   * solid extrudes it (positive) or cuts a pocket (negative). Side faces that end up
   * coplanar with their neighbours merge, so extending a box leaves no seam. A new face
   * landing back-to-back on an existing one cancels out with it, so pushing right through
   * a board leaves a hole, and a pocket or hole touching the board's edge leaves a notch.
   */
  pushPull(faceId: number, distance: number): number | null {
    const f = this.faces.get(faceId);
    if (!f || Math.abs(distance) < EPS) return null;
    const n = this.faceNormal(f);
    const lone = f.loops.every((l) => l.every((v, i) => this.facesWithEdge(v, l[(i + 1) % l.length]).length === 1));
    const flip = lone && distance < 0;
    const off = scale(n, distance);
    const moved = new Map<number, number>();
    for (const v of f.loops.flat()) {
      moved.set(v, this.addVertex(add(this.pos(v), off)));
    }
    const orient = (l: number[]) => (flip ? [...l].reverse() : l);
    const addFace = (loops: number[][]) => {
      const id = this.nextId++;
      this.faces.set(id, { id, loops, color: f.color });
      return id;
    };
    const seams: [number, number][] = [];
    const added: number[] = [];
    for (const l of f.loops) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        const [a2, b2] = [moved.get(a)!, moved.get(b)!];
        this.edges.set(edgeKey(a, a2), [a, a2]);
        this.edges.set(edgeKey(a2, b2), [a2, b2]);
        added.push(addFace([orient([a, b, b2, a2])]));
        seams.push([a, b], [a, a2]);
      }
    }
    const top = addFace(f.loops.map((l) => orient(l.map((v) => moved.get(v)!))));
    if (!lone) this.faces.delete(faceId);
    else if (!flip) f.loops = f.loops.map((l) => [...l].reverse());
    for (const id of [top, ...added]) this.cancelOverlap(id);

    for (const [a, b] of seams) {
      if (!this.edges.has(edgeKey(a, b))) continue;
      const fs = this.facesWithEdge(a, b);
      if (fs.length === 2 && samePlane(this.facePlane(fs[0]), this.facePlane(fs[1]))) this.eraseEdge(a, b);
    }
    return this.faces.has(top) ? top : null;
  }

  /**
   * If face fid lies on an existing face of opposite normal, the two cancel where they
   * overlap: the plane is rebuilt with fid's outline cut in, and every region inside fid goes.
   */
  private cancelOverlap(fid: number) {
    const f = this.faces.get(fid);
    if (!f) return;
    const pl = this.facePlane(f), n = this.faceNormal(f);
    const [u, w] = basis(pl.n);
    const p2 = (p: V3): [number, number] => [dot(p, u), dot(p, w)];
    const inside = (g: Face, p: V3) => {
      const [outer, ...hs] = g.loops.map((l) => l.map((id) => p2(this.pos(id))));
      return inPoly(p2(p), outer) && !hs.some((h) => inPoly(p2(p), h));
    };
    const interior = (g: Face): V3 => {
      const [a, b, c] = this.triangulate(g)[0].map((id) => this.pos(id));
      return scale(add(add(a, b), c), 1 / 3);
    };
    const opposite = this.facesInPlane(pl).filter((g) => g !== f && dot(this.faceNormal(g), n) < 0);
    if (!opposite.some((g) => inside(g, interior(f)) || inside(f, interior(g)))) return;
    const keys = f.loops.flatMap((l) => l.map((v, i) => edgeKey(v, l[(i + 1) % l.length])));
    this.faces.delete(fid);
    this.recomputePlane(pl, new Set(keys), []);
    for (const g of this.facesInPlane(pl)) if (inside(f, interior(g))) this.faces.delete(g.id);
    for (const k of keys) {
      const e = this.edges.get(k);
      if (!e || this.facesWithEdge(e[0], e[1]).length) continue;
      this.edges.delete(k);
      for (const v of e) this.heal(v);
    }
  }

  /** Every face and edge joined, through edges, to the given vertices. */
  connected(start: number[]): { faces: number[]; edges: string[] } {
    const adj = new Map<number, number[]>();
    for (const [a, b] of this.edges.values()) {
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
    // A face joins its hole loops to its outer loop, so a board with a hole is one object.
    for (const f of this.faces.values()) {
      for (const h of f.loops.slice(1)) {
        adj.get(f.loops[0][0])?.push(h[0]);
        adj.get(h[0])?.push(f.loops[0][0]);
      }
    }
    const seen = new Set(start);
    const stack = [...start];
    while (stack.length) {
      for (const o of adj.get(stack.pop()!) ?? []) {
        if (!seen.has(o)) {
          seen.add(o);
          stack.push(o);
        }
      }
    }
    return {
      faces: [...this.faces.values()].filter((f) => seen.has(f.loops[0][0])).map((f) => f.id),
      edges: [...this.edges].filter(([, [a]]) => seen.has(a)).map(([k]) => k),
    };
  }

  mapVerts(ids: Iterable<number>, f: (p: V3) => V3) {
    for (const id of new Set(ids)) this.verts.set(id, f(this.pos(id)));
  }

  /** Turn faces over, e.g. after mirroring their vertices, so normals point out again. */
  reverseFaces(ids: number[]) {
    for (const id of ids) {
      const f = this.faces.get(id);
      if (f) f.loops = f.loops.map((l) => [...l].reverse());
    }
  }

  /**
   * Add a copy of the given faces and edges with every vertex moved by fn, welding onto
   * vertices already there. flip reverses the copied faces (for mirrored copies).
   * ponytail: welds vertices only; a copy laid over existing faces doesn't split or merge them.
   */
  copyGeometry(faceIds: number[], edgeKeys: string[], fn: (p: V3) => V3, flip = false) {
    const keys = new Set(edgeKeys);
    const faces = faceIds.map((id) => this.faces.get(id)!).filter(Boolean);
    for (const f of faces) for (const l of f.loops) l.forEach((v, i) => keys.add(edgeKey(v, l[(i + 1) % l.length])));
    const vmap = new Map<number, number>();
    const vid = (v: number) => {
      let id = vmap.get(v);
      if (id === undefined) {
        const p = fn(this.pos(v));
        id = this.findVertex(p);
        if (id === undefined) this.verts.set((id = this.nextId++), p);
        vmap.set(v, id);
      }
      return id;
    };
    for (const k of keys) {
      const e = this.edges.get(k);
      if (!e) continue;
      const [a, b] = [vid(e[0]), vid(e[1])];
      if (a !== b) this.edges.set(edgeKey(a, b), [a, b]);
    }
    for (const f of faces) {
      const id = this.nextId++;
      const loops = f.loops.map((l) => l.map(vid));
      this.faces.set(id, { id, loops: flip ? loops.map((l) => l.reverse()) : loops, color: f.color });
    }
  }

  /** Copy the given faces and edges into a new mesh and remove them from this one. */
  extract(faceIds: number[], edgeKeys: string[]): Mesh {
    const out = new Mesh();
    out.nextId = this.nextId;
    const keys = new Set(edgeKeys);
    const faces = faceIds.map((id) => this.faces.get(id)!).filter(Boolean);
    for (const f of faces) {
      for (const l of f.loops) l.forEach((v, i) => keys.add(edgeKey(v, l[(i + 1) % l.length])));
    }
    for (const k of keys) {
      const e = this.edges.get(k);
      if (!e) continue;
      out.edges.set(k, [...e]);
      for (const v of e) out.verts.set(v, [...this.pos(v)]);
    }
    for (const f of faces) {
      out.faces.set(f.id, { id: f.id, loops: f.loops.map((l) => [...l]), color: f.color });
      this.faces.delete(f.id);
    }
    for (const k of keys) {
      const e = this.edges.get(k);
      if (!e || this.facesWithEdge(e[0], e[1]).length) continue;
      this.edges.delete(k);
      for (const v of e) this.heal(v);
    }
    return out;
  }

  /**
   * Copy another mesh in, mapped through f, welding onto vertices already here (and splitting
   * edges they land on). flip reverses loops, for mirroring maps. Returns the new faces and edges.
   * ponytail: welds at vertices only; overlapping faces and crossing edges aren't intersected.
   */
  merge(src: Mesh, f: (p: V3) => V3, flip = false): { faces: number[]; edges: string[] } {
    const ids = new Map<number, number>();
    for (const [id, p] of src.verts) ids.set(id, this.addVertex(f(p)));
    const edges: string[] = [];
    for (const [a, b] of src.edges.values()) {
      const e: [number, number] = [ids.get(a)!, ids.get(b)!];
      if (e[0] === e[1]) continue;
      const k = edgeKey(...e);
      this.edges.set(k, e);
      edges.push(k);
    }
    const faces = [...src.faces.values()].map((s) => {
      const id = this.nextId++;
      const loops = s.loops.map((l) => (flip ? [...l].reverse() : l).map((v) => ids.get(v)!));
      this.faces.set(id, { id, loops, color: s.color });
      return id;
    });
    return { faces, edges };
  }
}
