import * as THREE from 'three';
import { GUIDE_LEN, type Guide, guideHits } from '../kernel/guides';
import { type Mesh, edgeKey } from '../kernel/mesh';
import { type Group, walk, worldXform } from '../kernel/model';
import { type Xform, apply, applyDir, applyNormal, det } from '../kernel/xform';
import { type V3, EPS, add, closestLineParams, cross, dist, dot, lerp, norm, scale, sub } from '../kernel/vec';
import type { Editor } from './editor';
import { props } from './props';

/**
 * Who a picked thing belongs to, relative to the group being edited:
 * 'self' = loose geometry in the active group, a group id = a child group of the active
 * group (picked as a whole), null = outside the active group (not editable).
 */
export type Owner = 'self' | string | null;

export interface EdgeRef { a: V3; b: V3; key: string; owner: Owner }
export interface FaceHit { point: V3; distance: number; faceId: number; owner: Owner; normal: V3; groupId: string }
export interface Pick { owner: Owner; face?: FaceHit; edge?: EdgeRef; guide?: EdgeRef }

export const COLORS = {
  x: '#d8413a', y: '#3a9a4b', z: '#3b6fd6',
  face: '#eceae4', back: '#a3b0c0', edge: '#1d232b',
  select: '#2f80ff', hover: '#ffb020',
  endpoint: '#18a34a', midpoint: '#06b6d4', edgeSnap: '#e5484d', faceSnap: '#3b6fd6',
  guide: '#7b8794',
};

/** Edges between faces closer than 20° to flat are drawn soft (hidden). */
const SOFT_COS = Math.cos((20 * Math.PI) / 180);

const v3 = (p: V3) => new THREE.Vector3(p[0], p[1], p[2]);
const arr = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 5, 2e6);
  private light = new THREE.DirectionalLight('#ffffff', 1.6);
  private modelObj = new THREE.Group();
  private overlay = new THREE.Group();
  private faceObjs: THREE.Mesh[] = [];
  edges: EdgeRef[] = [];
  /** Snap targets from committed geometry: endpoints and midpoints in world space. */
  points: { p: V3; kind: 'endpoint' | 'midpoint' | 'guidePoint' | 'intersection' }[] = [];
  /** Guides as world segments (a = b for guide points); key is the index in its group. */
  guides: EdgeRef[] = [];
  private guideLines: { p: V3; d: V3 }[] = [];
  private boxEl: HTMLDivElement | null = null;
  private labels: { el: HTMLElement; p: V3 }[] = [];
  private labelLayer: HTMLDivElement;
  tooltip: HTMLDivElement;

  target: V3 = [800, 400, 300];
  distance = 5500;
  yaw = -2.2;
  pitch = 0.5;
  width = 1;
  height = 1;

  private drag: { mode: 'orbit' | 'pan'; x: number; y: number } | null = null;

  constructor(private host: HTMLElement, private ed: Editor) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor('#f5f6f7');
    host.appendChild(this.renderer.domElement);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'labels';
    host.appendChild(this.labelLayer);
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'snap-tip';
    host.appendChild(this.tooltip);

    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#b8bcc4', 1.4), this.light, this.light.target);
    this.scene.add(this.grid(), this.modelObj, this.overlay);

    new ResizeObserver(() => this.resize()).observe(host);
    this.bindInput();
    this.resize();
    this.rebuild();
  }

  private grid() {
    const g = new THREE.Group();
    const minor = new THREE.GridHelper(20000, 200, '#e3e5e8', '#e3e5e8');
    const major = new THREE.GridHelper(20000, 20, '#d2d5da', '#d2d5da');
    for (const h of [minor, major]) {
      h.rotation.x = Math.PI / 2;
      (h.material as THREE.Material).depthWrite = false;
      g.add(h);
    }
    const axis = (dir: V3, color: string) => {
      for (const sign of [1, -1]) {
        const geo = new THREE.BufferGeometry().setFromPoints([v3([0, 0, 0]), v3(scale(dir, sign * 1e5))]);
        const mat = sign > 0
          ? new THREE.LineBasicMaterial({ color })
          : new THREE.LineDashedMaterial({ color, dashSize: 60, gapSize: 60, opacity: 0.6, transparent: true });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        g.add(line);
      }
    };
    axis([1, 0, 0], COLORS.x);
    axis([0, 1, 0], COLORS.y);
    axis([0, 0, 1], COLORS.z);
    return g;
  }

  resize() {
    this.width = this.host.clientWidth || 1;
    this.height = this.host.clientHeight || 1;
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  // --- camera --------------------------------------------------------------

  private eye(): V3 {
    const c = Math.cos(this.pitch);
    return add(this.target, scale([c * Math.cos(this.yaw), c * Math.sin(this.yaw), Math.sin(this.pitch)], this.distance));
  }

  render() {
    this.camera.position.copy(v3(this.eye()));
    this.camera.lookAt(v3(this.target));
    this.camera.updateMatrixWorld();
    // Headlight from over the viewer's shoulder, like a lamp on the camera.
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.light.position.copy(this.camera.position).addScaledVector(right, this.distance * 0.4).add(new THREE.Vector3(0, 0, this.distance * 0.6));
    this.light.target.position.copy(v3(this.target));
    this.renderer.render(this.scene, this.camera);
    for (const { el, p } of this.labels) {
      const s = this.toScreen(p);
      el.style.display = s ? '' : 'none';
      if (s) el.style.transform = `translate(${s[0]}px, ${s[1]}px) translate(-50%, -50%)`;
    }
  }

  orbit(dx: number, dy: number) {
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dy * 0.006));
    this.render();
  }

  pan(dx: number, dy: number) {
    const k = (2 * this.distance * Math.tan((this.camera.fov * Math.PI) / 360)) / this.height;
    const m = this.camera.matrixWorld;
    const right = arr(new THREE.Vector3().setFromMatrixColumn(m, 0));
    const up = arr(new THREE.Vector3().setFromMatrixColumn(m, 1));
    this.target = add(this.target, add(scale(right, -dx * k), scale(up, dy * k)));
    this.render();
  }

  /** Zoom by factor f (<1 = in), keeping the point under the cursor fixed. */
  zoom(f: number, x: number, y: number) {
    const ray = this.ray(x, y);
    const anchor = this.pickFace(x, y)?.point ?? this.rayPlane(ray, [0, 0, 0], [0, 0, 1]) ?? this.target;
    const nd = Math.max(20, Math.min(1e6, this.distance * f));
    const real = nd / this.distance;
    this.target = add(anchor, scale(sub(this.target, anchor), real));
    this.distance = nd;
    this.render();
  }

  zoomExtents() {
    const pts = this.points.filter((p) => p.kind !== 'intersection').map((p) => p.p);
    if (!pts.length) {
      this.target = [800, 400, 300];
      this.distance = 5500;
    } else {
      const box = new THREE.Box3().setFromPoints(pts.map(v3));
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this.target = arr(sphere.center);
      this.distance = Math.max(200, (sphere.radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.15);
    }
    this.render();
  }

  // --- projection & picking -----------------------------------------------

  ray(x: number, y: number): { o: V3; d: V3 } {
    const ndc = new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return { o: arr(rc.ray.origin), d: arr(rc.ray.direction) };
  }

  rayPlane(r: { o: V3; d: V3 }, p: V3, n: V3): V3 | null {
    const den = dot(r.d, n);
    if (Math.abs(den) < 1e-6) return null;
    const t = dot(sub(p, r.o), n) / den;
    return t > 0 ? add(r.o, scale(r.d, t)) : null;
  }

  toScreen(p: V3): [number, number] | null {
    const v = v3(p).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return [((v.x + 1) / 2) * this.width, ((1 - v.y) / 2) * this.height];
  }

  depth(p: V3) {
    return dist(p, arr(this.camera.position));
  }

  pickFace(x: number, y: number): FaceHit | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1), this.camera);
    const hit = rc.intersectObjects(this.faceObjs, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    const ud = hit.object.userData as { tri: number[]; owner: Owner; groupId: string; normals: Map<number, V3> };
    const faceId = ud.tri[hit.faceIndex];
    return { point: arr(hit.point), distance: hit.distance, faceId, owner: ud.owner, normal: ud.normals.get(faceId)!, groupId: ud.groupId };
  }

  /** Nearest visible edge within px pixels of the cursor. */
  pickEdge(x: number, y: number, px = 6, face = this.pickFace(x, y)): { edge: EdgeRef; point: V3 } | null {
    let best: { edge: EdgeRef; point: V3 } | null = null, bestD = px;
    for (const e of this.edges) {
      const sa = this.toScreen(e.a), sb = this.toScreen(e.b);
      if (!sa || !sb) continue;
      const [abx, aby] = [sb[0] - sa[0], sb[1] - sa[1]];
      const l2 = abx * abx + aby * aby;
      const t = l2 ? Math.max(0, Math.min(1, ((x - sa[0]) * abx + (y - sa[1]) * aby) / l2)) : 0;
      const d = Math.hypot(x - (sa[0] + abx * t), y - (sa[1] + aby * t));
      if (d >= bestD) continue;
      // Screen t isn't world t under perspective; find the world point via the ray instead.
      const r = this.ray(x, y);
      const ab = sub(e.b, e.a);
      const n = cross(ab, cross(r.d, ab));
      const hit = this.rayPlane(r, e.a, norm(n));
      let wt = hit ? dot(sub(hit, e.a), ab) / dot(ab, ab) : t;
      wt = Math.max(0, Math.min(1, wt));
      const point = lerp(e.a, e.b, wt);
      if (face && this.depth(point) > face.distance * 1.002 + 1) continue;
      best = { edge: e, point };
      bestD = d;
    }
    return best;
  }

  /** Nearest visible guide within px pixels. Uses the ray, since guide ends are far off-screen. */
  pickGuide(x: number, y: number, px = 6, face = this.pickFace(x, y), list = this.guides): { edge: EdgeRef; point: V3 } | null {
    const r = this.ray(x, y);
    let best: { edge: EdgeRef; point: V3 } | null = null, bestD = px;
    for (const g of list) {
      const st = dist(g.a, g.b) < EPS ? null : closestLineParams(r.o, r.d, g.a, sub(g.b, g.a));
      if (st && st[0] < 0) continue;
      const point = lerp(g.a, g.b, st ? Math.max(0, Math.min(1, st[1])) : 0);
      const s = this.toScreen(point);
      const d = s ? Math.hypot(s[0] - x, s[1] - y) : Infinity;
      if (d >= bestD || (face && this.depth(point) > face.distance * 1.002 + 1)) continue;
      best = { edge: g, point };
      bestD = d;
    }
    return best;
  }

  pick(x: number, y: number): Pick | null {
    const face = this.pickFace(x, y);
    const edge = this.pickEdge(x, y, 6, face);
    if (edge) return { owner: edge.edge.owner, edge: edge.edge };
    const guide = this.pickGuide(x, y, 6, face, this.guides.filter((g) => g.owner === 'self'));
    if (guide) return { owner: 'self', guide: guide.edge };
    if (face) return { owner: face.owner, face };
    return null;
  }

  // --- scene building ------------------------------------------------------

  /**
   * Rebuild the scene from the model.
   * ponytail: rebuilds everything on each change; cache per-group geometry if it gets slow.
   */
  rebuild() {
    const ed = this.ed;
    for (const o of [...this.modelObj.children]) {
      this.modelObj.remove(o);
      if (o.userData.prop) continue; // shares its geometry with the cached prop model
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        m.geometry?.dispose();
      });
    }
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    this.faceObjs = [];
    this.edges = [];
    this.points = [];
    this.guides = [];
    this.guideLines = [];

    const active = ed.active;
    const inContext = ed.path.length > 1;
    const selFaces = new Set(ed.selection.flatMap((s) => (s.kind === 'face' ? [s.id] : [])));
    const selEdges = new Set(ed.selection.flatMap((s) => (s.kind === 'edge' ? [s.key] : [])));
    const selGroups = new Set(ed.selection.flatMap((s) => (s.kind === 'group' ? [s.id] : [])));
    const selGuides = new Set(ed.selection.flatMap((s) => (s.kind === 'guide' ? [s.i] : [])));

    // Copies shown while Move/Rotate is in copy mode; drawn but never snapped to.
    const adds = (ed.preview.get(active.id)?.adds ?? []).flatMap((c) => [...walk(c, ed.path)].map(([g, p]) => [g, p, true] as const));
    for (const [g, parents, extra] of [...[...walk(ed.root)].map(([g, p]) => [g, p, false] as const), ...adds]) {
      if ([...parents, g].some((x) => x.hidden)) continue;
      const chain = [...parents, g];
      // Match the whole context path: component contents are reachable through every instance.
      const inPath = ed.path.every((p, i) => chain[i] === p);
      const owner: Owner = !inPath ? null : chain.length === ed.path.length ? 'self' : chain[ed.path.length].id;
      // ponytail: a mesh preview is keyed by the edited instance's id, so sibling instances catch up on commit.
      const pv = ed.preview.get(g.id);
      const xf = worldXform(chain.map(this.shown));
      const mesh = pv?.mesh ?? g.mesh;
      const faded = inContext && owner === null;
      const ownerSelected = owner !== null && owner !== 'self' && selGroups.has(owner);
      if (g.prop) props.watch(g.prop.id);
      const propModel = g.prop && props.models.get(g.prop.id);
      if (propModel) this.addProp(propModel, mesh, xf);
      this.addMesh(mesh, xf, {
        owner, groupId: g.id, faded, ghost: !!propModel,
        selFaces: owner === 'self' ? selFaces : new Set(),
        selEdges: owner === 'self' ? selEdges : new Set(),
        allSelected: ownerSelected,
      });
      // Snap targets come from committed geometry so a moving preview can't snap to itself.
      const committed = worldXform(chain);
      const { soft } = this.info(g.mesh);
      for (const [k, [a, b]] of extra ? [] : g.mesh.edges) {
        if (soft.has(k)) continue;
        const pa = apply(committed, g.mesh.pos(a)), pb = apply(committed, g.mesh.pos(b));
        this.points.push({ p: pa, kind: 'endpoint' }, { p: pb, kind: 'endpoint' }, { p: lerp(pa, pb, 0.5), kind: 'midpoint' });
      }
      for (const d of g.dims) this.addDim(d.a, d.b, d.off, xf, faded);
      g.guides.forEach((gd, i) => this.addGuide(gd, xf, committed, owner, String(i), faded, owner === 'self' && selGuides.has(i)));
    }
    for (const p of guideHits(this.guideLines, this.edges.map((e) => [e.a, e.b]))) this.points.push({ p, kind: 'intersection' });
    // Box round selected child groups.
    for (const id of selGroups) {
      const c = active.children.find((x) => x.id === id);
      if (!c) continue;
      const box = new THREE.Box3();
      for (const [g, parents] of walk(c, ed.path)) {
        const xf = worldXform([...parents, g].map(this.shown));
        for (const p of g.mesh.verts.values()) box.expandByPoint(v3(apply(xf, p)));
      }
      if (!box.isEmpty()) this.modelObj.add(new THREE.Box3Helper(box, COLORS.select));
    }
    this.render();
  }

  private cache = new WeakMap<Mesh, { normals: Map<number, V3>; tris: Map<number, number[]>; soft: Set<string> }>();

  /** Forget cached triangulation; call after editing meshes in place. */
  invalidate() {
    this.cache = new WeakMap();
  }

  /**
   * Per-mesh render data: face normals, triangles, and "soft" edges between faces that
   * meet almost flat (curved surfaces), which are hidden as smoothed edges.
   */
  private info(mesh: Mesh) {
    let i = this.cache.get(mesh);
    if (i) return i;
    const normals = new Map<number, V3>(), tris = new Map<number, number[]>();
    const byEdge = new Map<string, V3[]>();
    for (const f of mesh.faces.values()) {
      const n = mesh.faceNormal(f);
      normals.set(f.id, n);
      tris.set(f.id, mesh.triangulate(f).flat());
      for (const l of f.loops) {
        l.forEach((v, k) => {
          const key = edgeKey(v, l[(k + 1) % l.length]);
          (byEdge.get(key) ?? byEdge.set(key, []).get(key)!).push(n);
        });
      }
    }
    const soft = new Set<string>();
    for (const [k, ns] of byEdge) if (ns.length === 2 && dot(ns[0], ns[1]) > SOFT_COS) soft.add(k);
    i = { normals, tris, soft };
    this.cache.set(mesh, i);
    return i;
  }

  /** A group's placement, with any uncommitted Move/Rotate preview applied. */
  private shown = (g: Group) => {
    const pv = this.ed.preview.get(g.id);
    return { rot: pv?.rot ?? g.rot, offset: pv?.offset ?? g.offset };
  };

  /** Draw an AI prop model scaled to fit inside its group's stand-in box, sitting on the box's floor. */
  private addProp(model: THREE.Object3D, box: Mesh, xf: Xform) {
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of box.verts.values()) {
      lo.min(v3(p));
      hi.max(v3(p));
    }
    // The model fills its box exactly: turned a quarter if that fits its shape better, then stretched to size.
    const bs = new THREE.Vector3().subVectors(hi, lo);
    const mb0 = new THREE.Box3().setFromObject(model), m0 = mb0.getSize(new THREE.Vector3());
    const turn = Math.min(bs.x / m0.y, bs.y / m0.x) > Math.min(bs.x / m0.x, bs.y / m0.y);
    const rot = new THREE.Matrix4().makeRotationZ(turn ? Math.PI / 2 : 0);
    const mb = mb0.clone().applyMatrix4(rot), ms = mb.getSize(new THREE.Vector3());
    const sc = new THREE.Vector3(bs.x / ms.x, bs.y / ms.y, bs.z / ms.z);
    if (![sc.x, sc.y, sc.z].every((v) => isFinite(v) && v > 0)) return;
    const fit = new THREE.Matrix4().makeTranslation(lo.x - sc.x * mb.min.x, lo.y - sc.y * mb.min.y, lo.z - sc.z * mb.min.z)
      .multiply(new THREE.Matrix4().makeScale(sc.x, sc.y, sc.z)).multiply(rot);
    const r = xf.r, t = xf.t;
    const place = new THREE.Matrix4().set(r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2], 0, 0, 0, 1);
    const obj = model.clone();
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(place.multiply(fit));
    obj.userData.prop = true;
    this.modelObj.add(obj);
  }

  private addMesh(mesh: Mesh, xf: Xform, o: {
    owner: Owner; groupId: string; faded: boolean; selFaces: Set<number>; selEdges: Set<string>; allSelected: boolean;
    /** Invisible but still pickable: the stand-in box under an AI prop. */
    ghost?: boolean;
  }) {
    const pos: number[] = [], col: number[] = [], tri: number[] = [];
    const info = this.info(mesh);
    const { tris, soft } = info;
    const normals = new Map([...info.normals].map(([id, n]) => [id, applyNormal(xf, n)]));
    // A mirroring transform turns triangles inside out; swap two corners to keep them facing out.
    const order = det(xf.r) < 0 ? [0, 2, 1] : [0, 1, 2];
    const c = new THREE.Color();
    for (const f of mesh.faces.values()) {
      c.set(f.color ?? COLORS.face);
      if (o.selFaces.has(f.id) || o.allSelected) c.lerp(new THREE.Color(COLORS.select), 0.45);
      const ids = tris.get(f.id)!;
      for (let i = 0; i < ids.length; i++) {
        pos.push(...apply(xf, mesh.pos(ids[i - (i % 3) + order[i % 3]])));
        col.push(c.r, c.g, c.b);
        if (i % 3 === 0) tri.push(f.id);
      }
    }
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.computeVertexNormals();
      const common = { visible: !o.ghost, transparent: o.faded, opacity: o.faded ? 0.25 : 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, depthWrite: !o.faded };
      const front = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide, ...common }));
      const back = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: COLORS.back, side: THREE.BackSide, ...common }));
      front.userData = back.userData = { tri, owner: o.owner, groupId: o.groupId, normals };
      this.modelObj.add(front, back);
      if (!o.faded) this.faceObjs.push(front, back);
    }

    if (o.ghost) return;
    const lp: number[] = [], lc: number[] = [];
    const edgeC = new THREE.Color(COLORS.edge), selC = new THREE.Color(COLORS.select);
    for (const [k, [a, b]] of mesh.edges) {
      if (soft.has(k)) continue;
      const pa = apply(xf, mesh.pos(a)), pb = apply(xf, mesh.pos(b));
      lp.push(...pa, ...pb);
      const cc = o.selEdges.has(k) || o.allSelected ? selC : edgeC;
      lc.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
      if (!o.faded) this.edges.push({ a: pa, b: pb, key: k, owner: o.owner });
    }
    if (lp.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
      this.modelObj.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: o.faded, opacity: o.faded ? 0.3 : 1,
      })));
    }
  }

  private addDim(a: V3, b: V3, offV: V3, xf: Xform, faded: boolean) {
    const [pa, pb, ov] = [apply(xf, a), apply(xf, b), applyDir(xf, offV)];
    const [wa, wb] = [add(pa, ov), add(pb, ov)];
    const pts = [pa, wa, pb, wb, wa, wb].map(v3);
    const line = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: '#4a5568', transparent: faded, opacity: faded ? 0.3 : 1 }),
    );
    this.modelObj.add(line);
    const el = document.createElement('div');
    el.className = 'dim-label';
    el.textContent = this.ed.fmt(dist(a, b));
    this.labelLayer.appendChild(el);
    this.labels.push({ el, p: lerp(wa, wb, 0.5) });
  }

  /** Draw a guide and register it for snapping (snapXf = committed placement). */
  private addGuide(gd: Guide, xf: Xform, snapXf: Xform, owner: Owner, key: string, faded: boolean, selected: boolean) {
    const ends = (x: Xform): [V3, V3] => (gd.d
      ? [apply(x, sub(gd.p, scale(gd.d, GUIDE_LEN))), apply(x, add(gd.p, scale(gd.d, GUIDE_LEN)))]
      : [apply(x, gd.p), apply(x, gd.p)]);
    const color = selected ? COLORS.select : COLORS.guide;
    const k = this.distance / 150;
    const mat = new THREE.LineDashedMaterial({ color, dashSize: k, gapSize: k, transparent: true, opacity: faded ? 0.3 : 0.9 });
    const seg = (a: V3, b: V3) => {
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v3(a), v3(b)]), mat);
      l.computeLineDistances();
      this.modelObj.add(l);
    };
    const [a, b] = ends(xf);
    if (gd.d) seg(a, b);
    else {
      if (gd.from) seg(apply(xf, gd.from), a);
      this.modelObj.add(new THREE.Points(
        new THREE.BufferGeometry().setFromPoints([v3(a)]),
        new THREE.PointsMaterial({ color, size: 7, sizeAttenuation: false }),
      ));
    }
    const [sa, sb] = ends(snapXf);
    this.guides.push({ a: sa, b: sb, key, owner });
    if (gd.d) this.guideLines.push({ p: apply(snapXf, gd.p), d: applyDir(snapXf, gd.d) });
    else this.points.push({ p: sa, kind: 'guidePoint' });
  }

  // --- overlay (tool feedback, cleared on every move) ----------------------

  /** Selection box in screen pixels, dashed for crossing; null hides it. */
  box(r: { x0: number; y0: number; x1: number; y1: number } | null, dashed = false) {
    if (!this.boxEl) {
      this.boxEl = document.createElement('div');
      this.boxEl.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
      this.host.appendChild(this.boxEl);
    }
    this.boxEl.style.display = r ? '' : 'none';
    if (!r) return;
    Object.assign(this.boxEl.style, {
      transform: `translate(${r.x0}px, ${r.y0}px)`, width: `${r.x1 - r.x0}px`, height: `${r.y1 - r.y0}px`,
      border: `1px ${dashed ? 'dashed' : 'solid'} ${COLORS.select}`,
    });
  }


  clearOverlay() {
    for (const o of [...this.overlay.children]) {
      this.overlay.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
    }
    this.tooltip.style.display = 'none';
    this.render();
  }

  line(a: V3, b: V3, color: string, dashed = false) {
    const geo = new THREE.BufferGeometry().setFromPoints([v3(a), v3(b)]);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 4, gapSize: 4, depthTest: false })
      : new THREE.LineBasicMaterial({ color, depthTest: false });
    if (dashed) {
      // Dash size in world units scales with zoom; keep it roughly constant on screen.
      const k = this.distance / 300;
      Object.assign(mat, { dashSize: k, gapSize: k });
    }
    const l = new THREE.Line(geo, mat);
    l.computeLineDistances();
    l.renderOrder = 10;
    this.overlay.add(l);
  }

  marker(p: V3, color: string, size = 9) {
    const pts = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints([v3(p)]),
      new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }),
    );
    pts.renderOrder = 11;
    this.overlay.add(pts);
  }

  highlightFace(groupId: string, faceId: number, color = COLORS.hover) {
    for (const [g, parents] of walk(this.ed.root)) {
      if (g.id !== groupId) continue;
      // The active group may be shared by other instances; highlight only the copy being edited.
      if (g === this.ed.active && !this.ed.path.every((p, i) => [...parents, g][i] === p)) continue;
      const mesh = this.ed.preview.get(g.id)?.mesh ?? g.mesh;
      const f = mesh.faces.get(faceId);
      if (!f) return;
      const xf = worldXform([...parents, g].map(this.shown));
      const pts = mesh.triangulate(f).flat().map((v) => v3(apply(xf, mesh.pos(v))));
      const m = new THREE.Mesh(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false }),
      );
      m.renderOrder = 9;
      this.overlay.add(m);
    }
  }

  tip(text: string, x: number, y: number) {
    this.tooltip.textContent = text;
    this.tooltip.style.display = text ? '' : 'none';
    this.tooltip.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  }

  /** Find a group by id, for tools. */
  group(id: string): Group | undefined {
    for (const [g] of walk(this.ed.root)) if (g.id === id) return g;
    return undefined;
  }

  // --- input ---------------------------------------------------------------

  private bindInput() {
    const el = this.renderer.domElement;
    el.tabIndex = 0;
    const xy = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const evt = (e: MouseEvent) => ({ ...xy(e), shift: e.shiftKey, alt: e.altKey, meta: e.metaKey || e.ctrlKey });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = xy(e);
      // ponytail: mouse-vs-trackpad guess from wheelDelta steps; add a setting if it misfires.
      const wd = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY ?? 0;
      const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && wd !== 0 && wd % 120 === 0);
      if (e.ctrlKey || mouseWheel) {
        this.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.012 : 0.0015)), x, y);
      } else if (e.shiftKey !== this.ed.swapOrbitPan) {
        this.pan(-e.deltaX, -e.deltaY);
      } else {
        this.orbit(e.deltaX, e.deltaY);
      }
      this.ed.tool.refresh();
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      el.focus();
      const navTool = this.ed.toolName === 'orbit' || this.ed.toolName === 'pan';
      if (e.button === 1 || (e.button === 0 && navTool)) {
        e.preventDefault();
        const mode = e.button === 1 ? (e.shiftKey ? 'pan' : 'orbit') : (this.ed.toolName as 'orbit' | 'pan');
        this.drag = { mode, x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button === 0) {
        el.setPointerCapture(e.pointerId); // so drags (box select) always get their pointerup
        this.ed.lastOp = null;
        this.ed.tool.onDown(evt(e));
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const [dx, dy] = [e.clientX - this.drag.x, e.clientY - this.drag.y];
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
        if (this.drag.mode === 'orbit') this.orbit(-dx * 1.2, -dy * 1.2);
        else this.pan(dx, dy);
        return;
      }
      this.ed.tool.onMove(evt(e));
    });
    el.addEventListener('pointerup', (e) => {
      if (this.drag) {
        this.drag = null;
        el.releasePointerCapture(e.pointerId);
        return;
      }
      if (e.button === 0) this.ed.tool.onUp(evt(e));
    });
    el.addEventListener('dblclick', (e) => this.ed.tool.onDouble(evt(e)));
    el.addEventListener('pointerleave', () => { this.tooltip.style.display = 'none'; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
