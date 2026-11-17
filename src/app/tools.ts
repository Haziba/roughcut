import { type P2, type Rect, boxHit, rectOf } from '../kernel/boxselect';
import { GUIDE_LEN, type Guide, alignDirs } from '../kernel/guides';
import { type Group, copyGroup, localXform, walk, worldXform } from '../kernel/model';
import { arcPoints, ngon, offsetLoop, tangentSagitta } from '../kernel/shapes';
import { parseLength } from '../kernel/units';
import { type Xform, apply as applyX, applyDir, compose, det, invert, rotation, scaling, signedAngle, translation } from '../kernel/xform';
import { type V3, AXES, EPS, add, basis, closestLineParams, cross, dist, dot, len, norm, projectOnSegment, scale, sub } from '../kernel/vec';
import type { Editor, Sel } from './editor';
import { noteHover } from './inference';
import { COLORS, type EdgeRef, type FaceHit, type Pick, type Viewport } from './viewport';

export type ToolName = 'select' | 'line' | 'rect' | 'pushpull' | 'move' | 'rotate' | 'orbit' | 'pan' | 'tape' | 'dim' | 'paint' | 'eraser'
  | 'arc' | 'circle' | 'polygon' | 'freehand' | 'offset' | 'scale';

export interface PtrEvt { x: number; y: number; shift: boolean; alt: boolean; meta: boolean }

type SnapKind = 'endpoint' | 'midpoint' | 'edge' | 'face' | 'axis' | 'free'
  | 'parallel' | 'perp' | 'track' | 'guide' | 'guidePoint' | 'intersection';
/** dir: parallel/perpendicular direction; ref: tracked point the result lines up with; edge: edge or guide snapped to. */
export interface Snap { p: V3; kind: SnapKind; face?: FaceHit; axis?: number; dir?: V3; ref?: V3; edge?: EdgeRef }

const AXIS_COLORS = [COLORS.x, COLORS.y, COLORS.z];
const AXIS_NAMES = ['Red', 'Green', 'Blue'];
const SNAP_PX = 10;
const AXIS_PX = 14;
const MAGENTA = '#d0329b';
const TRACK_COLOR = '#8b5cf6';
const POINT_KINDS = new Set<SnapKind>(['endpoint', 'midpoint', 'guidePoint', 'intersection']);

/**
 * Work out where the cursor "means" in 3D: endpoints and midpoints first,
 * then axis lines from the start point, then edges, then faces, then a working plane.
 */
export function infer(ed: Editor, x: number, y: number, from?: V3 | null, plane?: { p: V3; n: V3 }): Snap {
  const vp = ed.vp;
  const r = vp.ray(x, y);
  const face = vp.pickFace(x, y);
  const visible = (p: V3) => !face || vp.depth(p) <= face.distance * 1.002 + 1;

  let point: Snap | null = null, best = SNAP_PX;
  for (const c of vp.points) {
    const s = vp.toScreen(c.p);
    if (!s) continue;
    const d = Math.hypot(s[0] - x, s[1] - y) - (c.kind === 'endpoint' ? 2 : 0);
    if (d < best && visible(c.p)) {
      best = d;
      point = { p: c.p, kind: c.kind };
    }
  }
  const edge = vp.pickEdge(x, y, 6, face);
  noteHover(ed.inf, point ? { point: point.p } : edge ? edge.edge : null);

  const near = (p: V3, px: number) => {
    const s = vp.toScreen(p);
    return !!s && Math.hypot(s[0] - x, s[1] - y) < px;
  };
  /** Point on the line from `from` along d that lines up with a tracked point. */
  const lineUp = (d: V3) => {
    for (const t of ed.inf.tracked) {
      const p = add(from!, scale(d, dot(sub(t, from!), d)));
      if (dist(p, from!) > EPS && dist(p, t) > EPS && near(p, SNAP_PX)) return { p, ref: t };
    }
    return null;
  };
  /** Point on the line o + s·d nearest the cursor ray, and its pixel distance from the cursor. */
  const along = (o: V3, d: V3) => {
    const st = closestLineParams(r.o, r.d, o, d);
    if (!st || st[0] < 0) return null;
    const p = add(o, scale(d, st[1]));
    const s = vp.toScreen(p);
    if (!s || dist(p, o) < EPS) return null;
    return { p, px: Math.hypot(s[0] - x, s[1] - y) };
  };

  const lock = ed.lock;
  if (from && lock) {
    // Locked: slide along the axis; hovering a point takes that point's position along it.
    const lu = point ? null : lineUp(lock);
    const p = lu?.p ?? (point
      ? add(from, scale(lock, dot(sub(point.p, from), lock)))
      : add(from, scale(lock, closestLineParams(r.o, r.d, from, lock)?.[1] ?? 0)));
    const axis = AXES.findIndex((a) => a === lock);
    if (axis < 0) {
      const rd = ed.inf.refEdge && norm(sub(ed.inf.refEdge.b, ed.inf.refEdge.a));
      return { p, kind: rd && Math.abs(dot(rd, lock)) > 0.999 ? 'parallel' : 'perp', dir: lock, ref: lu?.ref };
    }
    return { p, kind: 'axis', axis, ref: lu?.ref };
  }
  if (point) return point;

  if (from) {
    let axisSnap: Snap | null = null, ab = AXIS_PX;
    AXES.forEach((a, i) => {
      const st = closestLineParams(r.o, r.d, from, a);
      if (!st || st[0] < 0) return;
      const p = add(from, scale(a, st[1]));
      const s = vp.toScreen(p);
      if (!s || dist(p, from) < EPS) return;
      const d = Math.hypot(s[0] - x, s[1] - y);
      if (d < ab) {
        ab = d;
        axisSnap = { p, kind: 'axis', axis: i };
      }
    });
    const hit = axisSnap as Snap | null;
    if (hit) {
      // Running along an axis until it lines up with a tracked point.
      const lu = lineUp(AXES[hit.axis!]);
      return lu ? { ...hit, ...lu } : hit;
    }
  }

  // Lined up with a tracked point along an axis, within the working plane.
  // ponytail: only lines through the tracked point that lie in the face/working plane count; no tracked-tracked crossings.
  const work = face ? { p: face.point, n: face.normal } : plane ?? { p: from ?? ([0, 0, 0] as V3), n: [0, 0, 1] as V3 };
  let track: Snap | null = null, tb = AXIS_PX;
  for (const t of ed.inf.tracked) {
    for (let i = 0; i < 3; i++) {
      const h = along(t, AXES[i]);
      if (!h || h.px >= tb || Math.abs(dot(sub(h.p, work.p), work.n)) > 1) continue;
      tb = h.px;
      track = { p: h.p, kind: 'track', axis: i, ref: t };
    }
  }
  if (track) return track;

  if (from && ed.inf.refEdge) {
    const normals: V3[] = face ? [face.normal, [0, 0, 1]] : [[0, 0, 1]];
    let best: Snap | null = null, bp = AXIS_PX;
    for (const { dir, kind } of alignDirs(sub(ed.inf.refEdge.b, ed.inf.refEdge.a), normals)) {
      const h = along(from, dir);
      if (h && h.px < bp) {
        bp = h.px;
        best = { p: h.p, kind, dir };
      }
    }
    if (best) return best;
  }

  if (edge) return { p: edge.point, kind: 'edge', edge: edge.edge };
  const guide = vp.pickGuide(x, y, 6, face);
  if (guide) return { p: guide.point, kind: 'guide', edge: guide.edge };
  if (face) return { p: face.point, kind: 'face', face };

  if (plane) {
    const p = vp.rayPlane(r, plane.p, plane.n);
    if (p) return { p, kind: 'free' };
  }
  // Free point: a horizontal plane through the start (or the ground), or a vertical one
  // facing the camera when looking edge-on.
  const base = from ?? [0, 0, 0];
  const p = vp.rayPlane(r, base, [0, 0, 1])
    ?? vp.rayPlane(r, base, norm([r.d[0], r.d[1], 0]))
    ?? base;
  return { p, kind: 'free' };
}

const SNAP_LABEL: Record<SnapKind, string> = {
  endpoint: 'Endpoint', midpoint: 'Midpoint', edge: 'On Edge', face: 'On Face', axis: '', free: '',
  parallel: 'Parallel to edge', perp: 'Perpendicular to edge', track: 'From point',
  guide: 'On Guide', guidePoint: 'Guide Point', intersection: 'Intersection',
};
const SNAP_COLOR: Record<SnapKind, string> = {
  endpoint: COLORS.endpoint, midpoint: COLORS.midpoint, edge: COLORS.edgeSnap, face: COLORS.faceSnap, axis: '', free: '',
  parallel: '', perp: '', track: '', guide: COLORS.edgeSnap, guidePoint: COLORS.endpoint, intersection: COLORS.endpoint,
};

export abstract class Tool {
  hint = '';
  vcbLabel = 'Measurements';
  protected last: PtrEvt | null = null;

  constructor(protected ed: Editor) {}

  onDown(_e: PtrEvt) {}
  onMove(e: PtrEvt) { this.last = e; }
  onUp(_e: PtrEvt) {}
  onDouble(_e: PtrEvt) {}
  /** Handle a typed measurement. Return false if it made no sense. */
  onVcb(_text: string): boolean { return false; }
  busy() { return false; }
  /** Whether a typed value may redo the operation just finished, instead of going to onVcb. */
  retypeable() { return !this.busy(); }
  /** Option/Alt or Ctrl pressed (down) or released; tap = released with no other key in between. */
  onModifier(_down: boolean, _tap = false) {}
  cancel() {
    this.ed.preview.clear();
    this.ed.vp?.clearOverlay();
    this.ed.vp?.rebuild();
  }
  /** Redraw after a camera move or lock change. */
  refresh() { if (this.last) this.onMove(this.last); }

  protected snap(e: PtrEvt, from?: V3 | null, plane?: { p: V3; n: V3 }) {
    const s = infer(this.ed, e.x, e.y, from, plane);
    this.ed.lastAxis = s.kind === 'axis' ? (s.axis ?? null) : null;
    this.ed.inf.lastDir = s.dir ?? null;
    return s;
  }

  /** Draw the snap marker, the rubber-band line from `from`, and the tooltip. */
  protected drawSnap(e: PtrEvt, s: Snap, from?: V3 | null) {
    const vp = this.ed.vp;
    if (from) {
      const color = s.kind === 'axis' && s.axis! >= 0 ? AXIS_COLORS[s.axis!] : s.dir ? MAGENTA : COLORS.edge;
      vp.line(from, s.p, color);
    }
    this.drawInference(s);
    if (SNAP_COLOR[s.kind]) vp.marker(s.p, SNAP_COLOR[s.kind]);
    const locked = this.ed.lock ? ' (locked)' : '';
    const label = s.ref ? 'From point'
      : s.kind === 'axis' && s.axis! >= 0 ? `On ${AXIS_NAMES[s.axis!]} Axis${locked}`
      : SNAP_LABEL[s.kind] + (s.dir ? locked : '');
    vp.tip(label, e.x, e.y);
  }

  /** Tracked point markers, the dotted line from a tracked point, the remembered edge. */
  protected drawInference(s: Snap) {
    const vp = this.ed.vp, inf = this.ed.inf;
    for (const t of inf.tracked) vp.marker(t, TRACK_COLOR, 6);
    if (s.ref) {
      const i = AXES.findIndex((a) => Math.abs(dot(norm(sub(s.p, s.ref!)), a)) > 0.999);
      vp.line(s.ref, s.p, i >= 0 ? AXIS_COLORS[i] : '#4a5568', true);
    }
    if (s.dir && inf.refEdge) vp.line(inf.refEdge.a, inf.refEdge.b, MAGENTA);
  }

  /** Call right after a commit: retyping undoes it, calls `restore` to bring back the in-progress state, then onVcb. */
  protected retypeWith(restore: () => void) {
    this.ed.retypable((t) => { restore(); return this.onVcb(t); });
  }

  protected parse(text: string) {
    return parseLength(text, this.ed.units);
  }
}

// --- Select -----------------------------------------------------------------

function pickToSel(p: Pick | null): Sel | null {
  if (!p || p.owner === null) return null;
  if (p.owner !== 'self') return { kind: 'group', id: p.owner };
  if (p.guide) return { kind: 'guide', i: +p.guide.key };
  if (p.edge) return { kind: 'edge', key: p.edge.key };
  if (p.face) return { kind: 'face', id: p.face.faceId };
  return null;
}

/** Faces, edges and child groups of the active context caught by a selection box. */
function boxSelect(ed: Editor, r: Rect, crossing: boolean): Sel[] {
  const scr = (x: Xform, p: V3) => ed.vp.toScreen(applyX(x, p));
  const ring = (pts: (P2 | null)[]) => pts.map((p, i): [P2 | null, P2 | null] => [p, pts[(i + 1) % pts.length]]);
  const g = ed.active, ax = ed.activeXform, m = g.mesh;
  const out: Sel[] = [];
  for (const [key, [a, b]] of m.edges) {
    if (boxHit(r, [[scr(ax, m.pos(a)), scr(ax, m.pos(b))]], crossing)) out.push({ kind: 'edge', key });
  }
  for (const f of m.faces.values()) {
    const poly = f.loops[0].map((v) => scr(ax, m.pos(v)));
    if (boxHit(r, ring(poly), crossing, poly)) out.push({ kind: 'face', id: f.id });
  }
  for (const c of g.children) {
    const segs: [P2 | null, P2 | null][] = [];
    for (const [h, parents] of walk(c, ed.path)) {
      if ([...parents.slice(ed.path.length), h].some((x) => x.hidden)) continue;
      const x = worldXform([...parents, h]);
      for (const [a, b] of h.mesh.edges.values()) segs.push([scr(x, h.mesh.pos(a)), scr(x, h.mesh.pos(b))]);
    }
    if (boxHit(r, segs, crossing)) out.push({ kind: 'group', id: c.id });
  }
  return out;
}

function highlightGuide(vp: Viewport, g: EdgeRef, color: string) {
  if (dist(g.a, g.b) < EPS) vp.marker(g.a, color);
  else vp.line(g.a, g.b, color);
}

class SelectTool extends Tool {
  hint = 'Click to select. Shift-click to add or remove. Drag right for a window box, left for a crossing box. Double-click an object to select all of it, or a group to edit inside it.';
  private down: { x: number; y: number; shift: boolean; drag: boolean } | null = null;

  busy() { return !!this.down?.drag; }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    const d = this.down;
    if (d && (d.drag || Math.hypot(e.x - d.x, e.y - d.y) > 4)) {
      d.drag = true;
      vp.box(rectOf(d.x, d.y, e.x, e.y), e.x < d.x);
      return;
    }
    const p = vp.pick(e.x, e.y);
    if (p?.owner === 'self' && p.face && !p.edge) vp.highlightFace(p.face.groupId, p.face.faceId, COLORS.select);
    if (p?.owner === 'self' && p.edge) vp.line(p.edge.a, p.edge.b, COLORS.select);
    if (p?.guide) highlightGuide(vp, p.guide, COLORS.select);
    vp.render();
  }

  onDown(e: PtrEvt) {
    this.down = { x: e.x, y: e.y, shift: e.shift, drag: false };
  }

  onUp(e: PtrEvt) {
    const d = this.down;
    this.down = null;
    if (!d) return;
    if (!d.drag) return this.ed.select(pickToSel(this.ed.vp.pick(d.x, d.y)), d.shift);
    this.ed.vp.box(null);
    const hits = boxSelect(this.ed, rectOf(d.x, d.y, e.x, e.y), e.x < d.x);
    const same = (a: Sel, b: Sel) => JSON.stringify(a) === JSON.stringify(b);
    this.ed.selection = d.shift
      ? [...this.ed.selection.filter((s) => !hits.some((h) => same(h, s))), ...hits.filter((h) => !this.ed.isSelected(h))]
      : hits;
    this.ed.changed();
  }

  cancel() {
    this.down = null;
    this.ed.vp?.box(null);
    super.cancel();
  }

  onDouble(e: PtrEvt) {
    const p = this.ed.vp.pick(e.x, e.y);
    if (!p) return;
    if (p.owner && p.owner !== 'self') return this.ed.enter(p.owner);
    if (p.owner === 'self' && (p.face || p.edge)) {
      // The whole connected object: every face and edge joined to what was clicked.
      const mesh = this.ed.active.mesh;
      const start = p.edge ? mesh.edges.get(p.edge.key) : mesh.faces.get(p.face!.faceId)?.loops[0];
      if (!start) return;
      const { faces, edges } = mesh.connected([...start]);
      this.ed.selection = [
        ...faces.map((id): Sel => ({ kind: 'face', id })),
        ...edges.map((key): Sel => ({ kind: 'edge', key })),
      ];
      this.ed.changed();
    }
    if (p.owner === null && this.ed.path.length > 1) this.ed.exitContext();
  }
}

// --- Line -------------------------------------------------------------------

class LineTool extends Tool {
  hint = 'Click to start a line. Type a length and press Enter. Arrow keys lock axes.';
  vcbLabel = 'Length';
  private start: V3 | null = null;
  private cur: Snap | null = null;
  /** Cursor when the last segment was made: retyping changes that segment until the mouse moves away. */
  private at: PtrEvt | null = null;

  busy() { return !!this.start; }
  retypeable() {
    const [a, l] = [this.at, this.last];
    return !this.start || (!!a && !!l && Math.hypot(a.x - l.x, a.y - l.y) < 4);
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    this.cur = this.snap(e, this.start);
    this.ed.vp.clearOverlay();
    this.drawSnap(e, this.cur, this.start);
    if (this.start) this.ed.setMeasure(dist(this.start, this.cur.p));
    this.ed.vp.render();
  }

  onDown(e: PtrEvt) {
    const s = this.snap(e, this.start);
    if (!this.start) {
      this.start = s.p;
      this.ed.setHint('Click the end point, or type a length. Esc to stop.');
    } else {
      this.to(s.p);
    }
  }

  private to(p: V3) {
    if (!this.start || dist(p, this.start) < EPS) return;
    const start = this.start;
    const mesh = this.ed.active.mesh;
    const before = mesh.faces.size;
    this.ed.commit(() => mesh.addEdge(this.ed.toLocal(start), this.ed.toLocal(p)));
    this.retypeWith(() => [this.start, this.cur] = [start, { p, kind: 'free' }]);
    this.at = this.last;
    // Closing a loop makes a face: stop the chain there.
    this.start = mesh.faces.size > before ? null : p;
    if (!this.start) this.ed.setHint(this.hint);
    this.refresh();
  }

  onVcb(text: string) {
    const l = this.parse(text);
    if (l === null || !this.start || !this.cur) return false;
    const dir = norm(sub(this.cur.p, this.start));
    if (len(dir) < 0.5) return false;
    this.to(add(this.start, scale(dir, l)));
    return true;
  }

  cancel() {
    this.start = null;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Rectangle --------------------------------------------------------------

class RectTool extends Tool {
  hint = 'Click the first corner. Draws on the face under the cursor, or on the ground.';
  vcbLabel = 'Dimensions';
  private c0: V3 | null = null;
  private axes: [V3, V3, V3] | null = null; // u, v, normal
  private size: [number, number] = [0, 0];

  busy() { return !!this.c0; }

  private corners(w: number, h: number): V3[] {
    const [u, v] = this.axes!;
    const c = this.c0!;
    return [c, add(c, scale(u, w)), add(add(c, scale(u, w)), scale(v, h)), add(c, scale(v, h))];
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (!this.c0) {
      const s = this.snap(e);
      this.drawSnap(e, s);
    } else {
      const [u, v, n] = this.axes!;
      const s = this.snap(e, null, { p: this.c0, n });
      // Project whatever was snapped onto the drawing plane.
      const p = sub(s.p, scale(n, dot(sub(s.p, this.c0), n)));
      const d = sub(p, this.c0);
      this.size = [dot(d, u), dot(d, v)];
      const pts = this.corners(...this.size);
      pts.forEach((a, i) => vp.line(a, pts[(i + 1) % 4], COLORS.edge));
      this.drawInference(s);
      if (SNAP_COLOR[s.kind]) vp.marker(s.p, SNAP_COLOR[s.kind]);
      const square = Math.abs(Math.abs(this.size[0]) - Math.abs(this.size[1])) < 0.02 * Math.abs(this.size[0]);
      vp.tip(square && this.size[0] ? 'Square' : SNAP_LABEL[s.kind], e.x, e.y);
      this.ed.setMeasure(`${this.ed.fmt(Math.abs(this.size[0]))}, ${this.ed.fmt(Math.abs(this.size[1]))}`);
    }
    vp.render();
  }

  onDown(e: PtrEvt) {
    if (!this.c0) {
      const s = this.snap(e);
      const n = s.face && s.face.owner === 'self' ? s.face.normal : ([0, 0, 1] as V3);
      const u: V3 = Math.abs(n[2]) > 0.999 ? [1, 0, 0] : norm(cross([0, 0, 1], n));
      this.axes = [u, cross(n, u), n];
      this.c0 = s.p;
      this.ed.setHint('Click the opposite corner, or type width,depth.');
      return;
    }
    this.finish(...this.size);
  }

  private finish(w: number, h: number) {
    if (Math.abs(w) < EPS || Math.abs(h) < EPS) return;
    const pts = this.corners(w, h).map((p) => this.ed.toLocal(p));
    this.ed.commit(() => pts.forEach((a, i) => this.ed.active.mesh.addEdge(a, pts[(i + 1) % 4])));
    const [c0, axes] = [this.c0, this.axes];
    this.retypeWith(() => [this.c0, this.axes, this.size] = [c0, axes, [w, h]]);
    this.cancel();
  }

  onVcb(text: string) {
    const parts = text.split(/[,;]/).map((t) => this.parse(t));
    if (!this.c0 || parts.length !== 2 || parts.some((p) => p === null)) return false;
    const [w, h] = parts as number[];
    this.finish(w * (Math.sign(this.size[0]) || 1), h * (Math.sign(this.size[1]) || 1));
    return true;
  }

  cancel() {
    this.c0 = null;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Push/Pull --------------------------------------------------------------

class PushPullTool extends Tool {
  hint = 'Click a face to push or pull it. Double-click to repeat the last distance.';
  vcbLabel = 'Distance';
  private hover: FaceHit | null = null;
  private active: { face: FaceHit; start: V3 } | null = null;
  private d = 0;
  private lastD = 0;

  busy() { return !!this.active; }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (!this.active) {
      const f = vp.pickFace(e.x, e.y);
      this.hover = f?.owner === 'self' ? f : null;
      if (this.hover) vp.highlightFace(this.hover.groupId, this.hover.faceId);
      vp.render();
      return;
    }
    const { face, start } = this.active;
    const s = infer(this.ed, e.x, e.y);
    const r = vp.ray(e.x, e.y);
    // Hovering an edge (e.g. the far side of a board) takes its depth, so a push can land exactly on it.
    this.d = s.kind === 'endpoint' || s.kind === 'midpoint' || s.kind === 'edge'
      ? dot(sub(s.p, start), face.normal)
      : closestLineParams(r.o, r.d, start, face.normal)?.[1] ?? 0;
    if (SNAP_COLOR[s.kind] && (s.kind === 'endpoint' || s.kind === 'midpoint' || s.kind === 'edge')) {
      vp.marker(s.p, SNAP_COLOR[s.kind]);
      vp.tip(SNAP_LABEL[s.kind], e.x, e.y);
    }
    vp.line(start, add(start, scale(face.normal, this.d)), COLORS.edge, true);
    this.previewAt(this.d);
    this.ed.setMeasure(Math.abs(this.d));
  }

  private previewAt(d: number) {
    const { face } = this.active!;
    const mesh = this.ed.active.mesh.clone();
    mesh.pushPull(face.faceId, d);
    this.ed.preview.set(this.ed.active.id, { mesh });
    this.ed.vp.rebuild();
  }

  onDown(e: PtrEvt) {
    if (!this.active) {
      const f = this.ed.vp.pickFace(e.x, e.y);
      if (f?.owner !== 'self') return;
      this.active = { face: f, start: f.point };
      this.ed.setHint('Move to set the distance, click to finish, or type a distance.');
      return;
    }
    this.finish(this.d);
  }

  private finish(d: number) {
    const face = this.active!.face;
    this.active = null;
    this.ed.preview.clear();
    this.lastD = d;
    this.ed.commit(() => this.ed.active.mesh.pushPull(face.faceId, d));
    this.retypeWith(() => [this.active, this.d] = [{ face, start: face.point }, d]);
    this.ed.setHint(this.hint);
    this.refresh();
  }

  onDouble(e: PtrEvt) {
    if (this.active || !this.lastD) return;
    const f = this.ed.vp.pickFace(e.x, e.y);
    if (f?.owner !== 'self') return;
    this.ed.commit(() => this.ed.active.mesh.pushPull(f.faceId, this.lastD));
  }

  onVcb(text: string) {
    const l = this.parse(text);
    if (l === null || !this.active) return false;
    this.finish((Math.sign(this.d) || 1) * l);
    return true;
  }

  cancel() {
    this.active = null;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

/**
 * Apply a world-space transform to the selection: loose geometry in the active group
 * and whole child groups. An array of transforms leaves the selection where it is and
 * places one copy per transform instead. With preview, nothing is changed; the result
 * goes in ed.preview.
 */
function transformSelection(ed: Editor, world: Xform | Xform[], preview: boolean) {
  const g = ed.active;
  const a = ed.activeXform;
  const copying = Array.isArray(world);
  const locals = (copying ? world : [world]).map((w) => compose(invert(a), compose(w, a)));
  const mesh = preview ? g.mesh.clone() : g.mesh;
  const faces = ed.selection.flatMap((s) => (s.kind === 'face' ? [s.id] : []));
  const edges = ed.selection.flatMap((s) => (s.kind === 'edge' ? [s.key] : []));
  if (copying) {
    for (const l of locals) mesh.copyGeometry(faces, edges, (p) => applyX(l, p), det(l.r) < 0);
  } else {
    const verts = [
      ...faces.flatMap((id) => mesh.faces.get(id)?.loops.flat() ?? []),
      ...edges.flatMap((k) => mesh.edges.get(k) ?? []),
    ];
    mesh.mapVerts(verts, (p) => applyX(locals[0], p));
    if (det(locals[0].r) < 0) mesh.reverseFaces(faces);
  }
  const adds: Group[] = [];
  for (const s of ed.selection) {
    if (s.kind !== 'group') continue;
    const c = g.children.find((x) => x.id === s.id);
    if (!c) continue;
    for (const l of locals) {
      const placed = compose(l, localXform(c));
      if (copying) adds.push({ ...(preview ? c : copyGroup(c)), offset: placed.t, rot: placed.r });
      else if (preview) ed.preview.set(c.id, { offset: placed.t, rot: placed.r });
      else [c.offset, c.rot] = [placed.t, placed.r];
    }
  }
  if (!preview) g.children.push(...adds);
  else if (faces.length || edges.length || adds.length) ed.preview.set(g.id, { mesh: faces.length || edges.length ? mesh : undefined, adds });
}

type MakeCopy = (k: number) => Xform;

/**
 * Place copies, `make(k)` placing copy k (1 = where it was dropped). Retyping right after
 * replaces them as one undo step: `x5`, `5x` or `*5` = 5 copies at the same spacing,
 * `/5` = 5 copies dividing the distance, anything else = a new distance/angle via `remake`.
 */
function placeCopies(ed: Editor, make: MakeCopy, remake: (text: string) => MakeCopy | null, ks = [1]) {
  ed.commit(() => transformSelection(ed, ks.map(make), false));
  ed.retypable((text) => {
    const ext = text.match(/^\s*(?:[x*]\s*(\d+)|(\d+)\s*x)\s*$/i);
    const int = text.match(/^\s*\/\s*(\d+)\s*$/);
    let [m, k]: [MakeCopy | null, number[]] = [make, ks];
    if (ext || int) {
      const n = +(ext?.[1] ?? ext?.[2] ?? int![1]);
      if (n < 1 || n > 1000) return false;
      k = Array.from({ length: n }, (_, i) => (int ? (i + 1) / n : i + 1));
    } else m = remake(text);
    if (m) placeCopies(ed, m, remake, k);
    return !!m;
  });
}

/** Show "+" by the cursor while a tool is in copy mode. */
function copyTip(ed: Editor, e: PtrEvt) {
  ed.vp.tip(`+ ${ed.vp.tooltip.textContent ?? ''}`, e.x, e.y);
}

// --- Move -------------------------------------------------------------------

class MoveTool extends Tool {
  hint = 'Click a point to move from. Moves the selection, or what you click on.';
  vcbLabel = 'Distance';
  private start: V3 | null = null;
  private cur: V3 | null = null;
  private copy = false;

  busy() { return !!this.start; }

  onModifier(_down: boolean, tap = false) {
    if (!tap) return;
    this.copy = !this.copy;
    this.ed.flash(this.copy ? 'Copy: on (Option/Ctrl to turn off)' : 'Copy: off');
    this.refresh();
  }

  private apply(off: V3, preview: boolean) {
    transformSelection(this.ed, this.copy ? [translation(off)] : translation(off), preview);
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    const s = this.snap(e, this.start);
    this.drawSnap(e, s, this.start);
    if (this.copy) copyTip(this.ed, e);
    if (this.start) {
      this.cur = s.p;
      this.ed.preview.clear();
      this.apply(sub(s.p, this.start), true);
      vp.rebuild();
      this.ed.setMeasure(dist(this.start, s.p));
    }
    vp.render();
  }

  onDown(e: PtrEvt) {
    if (!this.start) {
      if (!this.ed.selection.length) {
        const sel = pickToSel(this.ed.vp.pick(e.x, e.y));
        if (!sel) return;
        this.ed.select(sel);
      }
      this.start = this.snap(e).p;
      this.ed.setHint('Click where to move to, or type a distance. Option/Ctrl toggles copy.');
      return;
    }
    this.finish(sub(this.snap(e, this.start).p, this.start));
  }

  private finish(off: V3) {
    this.start = null;
    this.ed.preview.clear();
    if (this.copy) {
      const dir = norm(off);
      placeCopies(this.ed, (k) => translation(scale(off, k)), (t) => {
        const l = this.parse(t);
        return l === null ? null : (k) => translation(scale(dir, l * k));
      });
      this.copy = false;
      this.ed.setHint('Copied. Type x5 or /5 for an array, or a new distance.');
    } else {
      this.ed.commit(() => this.apply(off, false));
      // Only the direction from start to cur matters to onVcb.
      this.retypeWith(() => [this.start, this.cur, this.copy] = [[0, 0, 0], off, false]);
      this.ed.setHint(this.hint);
    }
    this.refresh();
  }

  onVcb(text: string) {
    const l = this.parse(text);
    if (l === null || !this.start || !this.cur) return false;
    const dir = norm(sub(this.cur, this.start));
    if (len(dir) < 0.5) return false;
    this.finish(scale(dir, l));
    return true;
  }

  cancel() {
    this.start = null;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Rotate -----------------------------------------------------------------

class RotateTool extends Tool {
  hint = 'Hover a face or the ground to set the rotation plane (arrow keys lock an axis), then click the centre.';
  vcbLabel = 'Angle';
  private stage: 0 | 1 | 2 = 0;
  private pivot: V3 = [0, 0, 0];
  private n: V3 = [0, 0, 1];
  private from: V3 = [1, 0, 0];
  private angle = 0;
  private copy = false;

  busy() { return this.stage > 0; }

  onModifier(_down: boolean, tap = false) {
    if (!tap) return;
    this.copy = !this.copy;
    this.ed.flash(this.copy ? 'Copy: on (Option/Ctrl to turn off)' : 'Copy: off');
    this.refresh();
  }

  private normalAt(s: Snap): V3 {
    return this.ed.lock ?? (s.face ? s.face.normal : [0, 0, 1]);
  }

  /** Cursor on the rotation plane; snapped points are flattened onto it. */
  private planePoint(e: PtrEvt): { p: V3; s: Snap } {
    const s = infer(this.ed, e.x, e.y);
    if (s.kind === 'endpoint' || s.kind === 'midpoint') return { p: sub(s.p, scale(this.n, dot(sub(s.p, this.pivot), this.n))), s };
    const r = this.ed.vp.ray(e.x, e.y);
    return { p: this.ed.vp.rayPlane(r, this.pivot, this.n) ?? s.p, s: { p: s.p, kind: 'free' } };
  }

  private protractor(c: V3, n: V3) {
    const vp = this.ed.vp;
    const axis = AXES.findIndex((a) => Math.abs(dot(a, n)) > 0.999);
    const color = axis >= 0 ? AXIS_COLORS[axis] : '#6b7280';
    const [u, v] = basis(n);
    const r = vp.distance * 0.05;
    const at = (deg: number, k: number) => {
      const t = (deg * Math.PI) / 180;
      return add(c, add(scale(u, Math.cos(t) * r * k), scale(v, Math.sin(t) * r * k)));
    };
    for (let d = 0; d < 360; d += 7.5) vp.line(at(d, 1), at(d + 7.5, 1), color);
    for (let d = 0; d < 360; d += 15) vp.line(at(d, d % 90 ? 0.9 : 0.8), at(d, 1), color);
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (this.stage === 0) {
      const s = this.snap(e);
      this.protractor(s.p, this.normalAt(s));
      this.drawSnap(e, s);
    } else {
      const { p, s } = this.planePoint(e);
      this.protractor(this.pivot, this.n);
      if (SNAP_COLOR[s.kind]) vp.marker(s.p, SNAP_COLOR[s.kind]);
      if (this.stage === 1) {
        vp.line(this.pivot, p, '#4a5568', true);
        vp.tip(SNAP_LABEL[s.kind], e.x, e.y);
      } else {
        const dir = norm(sub(p, this.pivot));
        let deg = (signedAngle(this.from, dir, this.n) * 180) / Math.PI;
        const step = Math.round(deg / 15) * 15;
        if (Math.abs(deg - step) < 2.5) deg = step;
        this.angle = deg;
        const r = vp.distance * 0.05;
        const turned = rotation([0, 0, 0], this.n, (deg * Math.PI) / 180);
        vp.line(this.pivot, add(this.pivot, scale(this.from, r * 1.3)), '#4a5568', true);
        vp.line(this.pivot, add(this.pivot, scale(applyX(turned, this.from), r * 1.3)), '#4a5568');
        this.ed.preview.clear();
        const x = rotation(this.pivot, this.n, (deg * Math.PI) / 180);
        transformSelection(this.ed, this.copy ? [x] : x, true);
        vp.rebuild();
        vp.tip(`${+deg.toFixed(1)}°`, e.x, e.y);
        this.ed.setMeasure(`${+deg.toFixed(1)}°`);
      }
    }
    if (this.copy) copyTip(this.ed, e);
    vp.render();
  }

  onDown(e: PtrEvt) {
    if (this.stage === 0) {
      if (!this.ed.selection.length) {
        const sel = pickToSel(this.ed.vp.pick(e.x, e.y));
        if (!sel) return;
        this.ed.select(sel);
      }
      const s = this.snap(e);
      this.pivot = s.p;
      this.n = this.normalAt(s);
      this.stage = 1;
      this.ed.setHint('Click to set the starting direction.');
    } else if (this.stage === 1) {
      const { p } = this.planePoint(e);
      if (dist(p, this.pivot) < EPS) return;
      this.from = norm(sub(p, this.pivot));
      this.stage = 2;
      this.angle = 0;
      this.ed.setHint('Click to finish, or type an angle in degrees. Snaps every 15°.');
    } else {
      this.finish(this.angle);
    }
  }

  private finish(deg: number) {
    const x = rotation(this.pivot, this.n, (deg * Math.PI) / 180);
    this.stage = 0;
    this.ed.preview.clear();
    if (this.copy && Math.abs(deg) > 1e-9) {
      const [p, n, sign] = [this.pivot, this.n, Math.sign(deg)];
      const turn = (d: number) => (k: number) => rotation(p, n, (d * k * Math.PI) / 180);
      placeCopies(this.ed, turn(deg), (t) => {
        const d = parseFloat(t.replace('°', ''));
        return Number.isNaN(d) ? null : turn(sign * d);
      });
      this.copy = false;
      this.ed.setHint('Copied. Type x5 or /5 for an array, or a new angle.');
    } else {
      if (Math.abs(deg) > 1e-9) {
        this.ed.commit(() => transformSelection(this.ed, x, false));
        const [p, n] = [this.pivot, this.n];
        this.retypeWith(() => [this.stage, this.pivot, this.n, this.angle, this.copy] = [2, p, n, deg, false]);
      }
      this.ed.setHint(this.hint);
    }
    this.refresh();
  }

  onVcb(text: string) {
    const deg = parseFloat(text.replace('°', ''));
    if (this.stage !== 2 || Number.isNaN(deg)) return false;
    this.finish((Math.sign(this.angle) || 1) * deg);
    return true;
  }

  cancel() {
    this.stage = 0;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Scale ------------------------------------------------------------------

/** Bounding box of the selection in the active group's own axes. */
function selectionBox(ed: Editor): { lo: V3; hi: V3 } | null {
  const g = ed.active;
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  const grow = (p: V3) => p.forEach((c, i) => { lo[i] = Math.min(lo[i], c); hi[i] = Math.max(hi[i], c); });
  for (const s of ed.selection) {
    if (s.kind === 'face') g.mesh.faces.get(s.id)?.loops.flat().forEach((v) => grow(g.mesh.pos(v)));
    if (s.kind === 'edge') g.mesh.edges.get(s.key)?.forEach((v) => grow(g.mesh.pos(v)));
    const c = s.kind === 'group' && g.children.find((x) => x.id === s.id);
    if (c) {
      for (const [x, parents] of walk(c)) {
        const xf = worldXform([...parents, x]);
        for (const p of x.mesh.verts.values()) grow(applyX(xf, p));
      }
    }
  }
  return lo[0] <= hi[0] ? { lo, hi } : null;
}

/** World transform that scales by f (in the active group's axes) about a local pivot. */
function scaleXform(ed: Editor, pivot: V3, f: V3): Xform {
  const a = ed.activeXform;
  return compose(a, compose(scaling(pivot, f), invert(a)));
}

/** Mirror the selection about its bounding-box centre along one of the active group's axes. */
export function flipSelection(ed: Editor, axis: number) {
  const box = selectionBox(ed);
  if (!box) return;
  ed.tool.cancel();
  const f: V3 = [1, 1, 1];
  f[axis] = -1;
  ed.commit(() => transformSelection(ed, scaleXform(ed, scale(add(box.lo, box.hi), 0.5), f), false));
}

/** Grip positions as 0/1/2 (min/middle/max) per axis; the centre is not a grip. */
const GRIPS: V3[] = [];
for (let i = 0; i < 27; i++) if (i !== 13) GRIPS.push([i % 3, Math.floor(i / 3) % 3, Math.floor(i / 9)]);

class ScaleTool extends Tool {
  hint = 'Select something, then click a grip: corners scale evenly, edges two ways, faces one way. Hold Option/Alt to scale about the centre.';
  vcbLabel = 'Scale';
  private box: { lo: V3; hi: V3 } | null = null;
  private grip: V3 | null = null;
  private f: V3 = [1, 1, 1];
  private centre = false;
  private down: [number, number] | null = null;

  busy() { return !!this.grip; }

  onModifier(down: boolean) {
    this.centre = down;
    this.refresh();
  }

  /** Local point at grip coordinates g. */
  private at(g: V3): V3 {
    const { lo, hi } = this.box!;
    return [0, 1, 2].map((i) => lo[i] + ((hi[i] - lo[i]) * g[i]) / 2) as V3;
  }

  private pivot(g: V3): V3 {
    return this.at(this.centre ? [1, 1, 1] : (g.map((i) => 2 - i) as V3));
  }

  private world(p: V3) {
    return applyX(this.ed.activeXform, p);
  }

  private hovered(e: PtrEvt): V3 | null {
    let best: V3 | null = null, bd = SNAP_PX;
    for (const g of GRIPS) {
      if (dist(this.at(g), this.at(g.map((i) => 2 - i) as V3)) < EPS) continue;
      const s = this.ed.vp.toScreen(this.world(this.at(g)));
      const d = s ? Math.hypot(s[0] - e.x, s[1] - e.y) : Infinity;
      if (d < bd) [best, bd] = [g, d];
    }
    return best;
  }

  private draw(hot: V3 | null, x: Xform) {
    const vp = this.ed.vp;
    const w = (g: V3) => applyX(x, this.world(this.at(g)));
    for (const g of GRIPS) {
      // Box edges: from each min-side corner to the max side, one axis at a time.
      if (g.every((i) => i !== 1)) g.forEach((i, k) => { if (!i) vp.line(w(g), w(g.map((j, m) => (m === k ? 2 : j)) as V3), COLORS.select); });
    }
    for (const g of this.grip ? [this.grip] : GRIPS) {
      const on = hot === g;
      vp.marker(w(g), on ? COLORS.hover : COLORS.select, on ? 12 : 7);
    }
  }

  private xform(f: V3) {
    return scaleXform(this.ed, this.pivot(this.grip!), f);
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (!this.grip) this.box = selectionBox(this.ed);
    if (!this.box) return vp.render();
    if (!this.grip) {
      const hot = this.hovered(e);
      this.draw(hot, translation([0, 0, 0]));
      vp.tip(hot ? ['', 'Scale one way', 'Scale two ways', 'Scale evenly'][hot.filter((i) => i !== 1).length] : '', e.x, e.y);
      return vp.render();
    }
    const pivotW = this.world(this.pivot(this.grip));
    const dir = sub(this.world(this.at(this.grip)), pivotW);
    const s = infer(this.ed, e.x, e.y);
    const r = vp.ray(e.x, e.y);
    const t = s.kind === 'endpoint' || s.kind === 'midpoint'
      ? dot(sub(s.p, pivotW), dir) / dot(dir, dir)
      : closestLineParams(r.o, r.d, pivotW, dir)?.[1] ?? 1;
    this.f = this.grip.map((i) => (i === 1 ? 1 : t)) as V3;
    if (SNAP_COLOR[s.kind] && (s.kind === 'endpoint' || s.kind === 'midpoint')) vp.marker(s.p, SNAP_COLOR[s.kind]);
    vp.line(pivotW, add(pivotW, scale(dir, t)), COLORS.edge, true);
    this.ed.preview.clear();
    if (Math.abs(t) > 1e-6) {
      const x = this.xform(this.f);
      this.draw(this.grip, x);
      transformSelection(this.ed, x, true);
    }
    vp.rebuild();
    vp.tip(`${+t.toFixed(2)}`, e.x, e.y);
    this.ed.setMeasure(`${+t.toFixed(2)}`);
  }

  onDown(e: PtrEvt) {
    if (this.grip) return this.finish(this.f);
    const g = this.box && this.ed.selection.length ? this.hovered(e) : null;
    if (!g) {
      this.ed.select(pickToSel(this.ed.vp.pick(e.x, e.y)));
      return this.refresh();
    }
    this.grip = g;
    this.f = [1, 1, 1];
    this.down = [e.x, e.y];
    this.ed.setHint('Move to scale and click, or type a factor (1.5), factors (2,1,1) or a size (600mm). Negative mirrors.');
  }

  /** Dragging a grip and letting go finishes too. */
  onUp(e: PtrEvt) {
    if (this.grip && this.down && Math.hypot(e.x - this.down[0], e.y - this.down[1]) > 5) this.finish(this.f);
    this.down = null;
  }

  private finish(f: V3) {
    const x = this.grip && f.every((k) => Math.abs(k) > 1e-6) ? this.xform(f) : null;
    const [grip, box, centre] = [this.grip, this.box, this.centre];
    this.grip = null;
    this.ed.preview.clear();
    if (x) {
      this.ed.commit(() => transformSelection(this.ed, x, false));
      this.retypeWith(() => [this.grip, this.box, this.centre] = [grip, box, centre]);
    }
    this.ed.setHint(this.hint);
    this.refresh();
  }

  onVcb(text: string) {
    if (!this.grip || !this.box) return false;
    const live = [0, 1, 2].filter((i) => this.grip![i] !== 1);
    let f: V3;
    if (/[a-z'"]/i.test(text)) {
      // A size: the new length across the dragged dimension(s).
      const l = this.parse(text);
      const size = Math.hypot(...live.map((i) => this.box!.hi[i] - this.box!.lo[i]));
      if (l === null || size < EPS) return false;
      f = this.grip.map((i) => (i === 1 ? 1 : l / size)) as V3;
    } else {
      const k = text.split(/[,;]/).map((t) => (t.trim() ? +t : NaN));
      if (k.some(Number.isNaN)) return false;
      if (k.length === 1) f = this.grip.map((i) => (i === 1 ? 1 : k[0])) as V3;
      else if (k.length === 3) f = k as V3;
      else if (k.length === live.length) {
        f = [1, 1, 1];
        live.forEach((i, j) => (f[i] = k[j]));
      } else return false;
    }
    if (f.some((k) => Math.abs(k) < 1e-6)) return false;
    this.finish(f);
    return true;
  }

  cancel() {
    this.grip = null;
    this.down = null;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Eraser -----------------------------------------------------------------

class EraserTool extends Tool {
  hint = 'Click an edge, guide or group to erase it. Erasing an edge between flat faces merges them.';

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    const p = vp.pick(e.x, e.y);
    if (p?.owner === 'self' && p.edge) vp.line(p.edge.a, p.edge.b, COLORS.hover);
    if (p?.guide) highlightGuide(vp, p.guide, COLORS.hover);
    vp.render();
  }

  onDown(e: PtrEvt) {
    const p = this.ed.vp.pick(e.x, e.y);
    const g = this.ed.active;
    if (p?.owner === 'self' && p.edge) {
      const ends = g.mesh.edges.get(p.edge.key);
      if (ends) this.ed.commit(() => g.mesh.eraseEdge(ends[0], ends[1]));
    } else if (p?.guide) {
      const i = +p.guide.key;
      this.ed.commit(() => g.guides.splice(i, 1));
    } else if (p?.owner && p.owner !== 'self') {
      const id = p.owner;
      this.ed.commit(() => { g.children = g.children.filter((c) => c.id !== id); });
    }
    this.refresh();
  }
}

// --- Paint ------------------------------------------------------------------

class PaintTool extends Tool {
  hint = 'Click a face to paint it. Click a group to paint all of it. Alt-click to pick up a colour.';

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    const f = vp.pickFace(e.x, e.y);
    if (f?.owner === 'self') vp.highlightFace(f.groupId, f.faceId, this.ed.color);
    vp.render();
  }

  onDown(e: PtrEvt) {
    const ed = this.ed;
    const f = ed.vp.pickFace(e.x, e.y);
    if (!f) return;
    const g = ed.vp.group(f.groupId);
    if (e.alt) {
      const c = g?.mesh.faces.get(f.faceId)?.color;
      if (c) {
        ed.color = c;
        ed.emit();
      }
      return;
    }
    if (f.owner === 'self') {
      ed.commit(() => { g!.mesh.faces.get(f.faceId)!.color = ed.color; });
    } else if (f.owner) {
      const child = ed.vp.group(f.owner)!;
      ed.commit(() => {
        const paint = (x: typeof child) => {
          for (const face of x.mesh.faces.values()) face.color = ed.color;
          x.children.forEach(paint);
        };
        paint(child);
      });
    }
  }
}

// --- Tape measure -----------------------------------------------------------

class TapeTool extends Tool {
  hint = 'Click an edge or guide, then click to place a parallel guide; or a point, then click to place a guide point. Alt-click to only measure.';
  vcbLabel = 'Length';
  private a: V3 | null = null;
  private kind: 'line' | 'point' | 'measure' = 'measure';
  private dir: V3 = [1, 0, 0];
  /** From the start to the guide: perpendicular offset for a line, the full vector for a point. */
  private off: V3 = [0, 0, 0];

  busy() { return !!this.a; }

  private offset(p: V3): V3 {
    const v = sub(p, this.a!);
    return this.kind === 'line' ? sub(v, scale(this.dir, dot(v, this.dir))) : v;
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    const s = this.snap(e, this.a);
    this.drawSnap(e, s, null);
    if (this.a) {
      this.off = this.offset(s.p);
      const b = add(this.a, this.off);
      vp.line(this.a, b, '#4a5568', true);
      if (!e.alt && this.kind === 'line') vp.line(sub(b, scale(this.dir, GUIDE_LEN)), add(b, scale(this.dir, GUIDE_LEN)), COLORS.guide, true);
      if (!e.alt && this.kind === 'point') vp.marker(b, COLORS.guide, 7);
      this.ed.setMeasure(len(this.off));
    }
    vp.render();
  }

  onDown(e: PtrEvt) {
    const s = this.snap(e, this.a);
    if (!this.a) {
      this.a = s.p;
      const line = s.edge && dist(s.edge.a, s.edge.b) > EPS;
      this.kind = e.alt ? 'measure' : line ? 'line' : POINT_KINDS.has(s.kind) ? 'point' : 'measure';
      if (line) this.dir = norm(sub(s.edge!.b, s.edge!.a));
      this.ed.setHint(this.kind === 'measure' ? 'Click the second point.' : 'Click to place the guide, or type a distance. Alt-click to only measure.');
      return;
    }
    this.place(this.offset(s.p), e.alt);
  }

  private place(off: V3, measureOnly = false) {
    const a = this.a!;
    this.ed.flash(`Measured ${this.ed.fmt(len(off))}`);
    if (!measureOnly && this.kind !== 'measure' && len(off) > EPS) {
      const b = add(a, off);
      const guide: Guide = this.kind === 'line'
        ? { p: this.ed.toLocal(b), d: norm(this.ed.dirToLocal(this.dir)) }
        : { p: this.ed.toLocal(b), from: this.ed.toLocal(a) };
      this.ed.commit(() => this.ed.active.guides.push(guide));
      const [kind, dir] = [this.kind, this.dir];
      this.retypeWith(() => [this.a, this.kind, this.dir, this.off] = [a, kind, dir, off]);
    }
    this.cancel();
    this.refresh();
  }

  onVcb(text: string) {
    const l = this.parse(text);
    if (l === null || !this.a || this.kind === 'measure' || len(this.off) < EPS) return false;
    this.place(scale(norm(this.off), l));
    return true;
  }

  cancel() {
    this.a = null;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Dimension --------------------------------------------------------------

class DimTool extends Tool {
  hint = 'Click two points, then move out and click to place the dimension.';
  private pts: V3[] = [];
  private off: V3 = [0, 0, 0];

  busy() { return this.pts.length > 0; }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (this.pts.length < 2) {
      const s = this.snap(e, this.pts[0]);
      this.drawSnap(e, s, null);
      if (this.pts[0]) vp.line(this.pts[0], s.p, '#4a5568', true);
    } else {
      const [a, b] = this.pts;
      const ab = norm(sub(b, a));
      const r = vp.ray(e.x, e.y);
      // Plane through the measured line, facing the camera as much as it can.
      const n = norm(cross(ab, cross(r.d, ab)));
      const p = vp.rayPlane(r, a, n) ?? a;
      const rel = sub(p, a);
      this.off = sub(rel, scale(ab, dot(rel, ab)));
      const [wa, wb] = [add(a, this.off), add(b, this.off)];
      vp.line(a, wa, '#4a5568');
      vp.line(b, wb, '#4a5568');
      vp.line(wa, wb, '#4a5568');
      vp.tip(this.ed.fmt(dist(a, b)), e.x, e.y);
    }
    vp.render();
  }

  onDown(e: PtrEvt) {
    if (this.pts.length < 2) {
      const p = this.snap(e, this.pts[0]).p;
      if (this.pts.length === 1 && dist(p, this.pts[0]) < EPS) return;
      this.pts.push(p);
      if (this.pts.length === 2) this.ed.setHint('Move out and click to place.');
      return;
    }
    const [a, b] = this.pts.map((p) => this.ed.toLocal(p));
    const off = this.ed.dirToLocal(this.off);
    this.ed.commit(() => this.ed.active.dims.push({ a, b, off }));
    this.cancel();
  }

  cancel() {
    this.pts = [];
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Drawing helpers shared by Arc, Circle, Polygon, Freehand, Offset ---------

/** Drawing plane normal at a snap: the locked axis, the face under the cursor, or the ground. */
function planeNormal(ed: Editor, s: Snap): V3 {
  return ed.lock ?? (s.face ? s.face.normal : [0, 0, 1]);
}

/** Cursor on the plane through c; snapped points are flattened onto it. */
function onPlane(ed: Editor, e: PtrEvt, c: V3, n: V3): { p: V3; s: Snap } {
  const s = infer(ed, e.x, e.y);
  if (s.kind === 'endpoint' || s.kind === 'midpoint') return { p: sub(s.p, scale(n, dot(sub(s.p, c), n))), s };
  return { p: ed.vp.rayPlane(ed.vp.ray(e.x, e.y), c, n) ?? s.p, s: { p: s.p, kind: 'free' } };
}

/** Commit world-space points as a chain of edges (closed if asked) in the active group. */
function commitChain(ed: Editor, pts: V3[], closed: boolean) {
  const loc = pts.map((p) => ed.toLocal(p));
  const mesh = ed.active.mesh;
  ed.commit(() => {
    for (let i = 0; i + 1 < loc.length; i++) mesh.addEdge(loc[i], loc[i + 1]);
    if (closed) mesh.addEdge(loc[loc.length - 1], loc[0]);
  });
}

function drawChain(ed: Editor, pts: V3[], closed: boolean, color: string = COLORS.edge) {
  for (let i = 0; i + 1 < pts.length; i++) ed.vp.line(pts[i], pts[i + 1], color);
  if (closed && pts.length > 2) ed.vp.line(pts[pts.length - 1], pts[0], color);
}

/** `24s` in the measurements box: a segment count. */
const segCount = (text: string) => {
  const m = /^\s*(\d+)\s*s\s*$/i.exec(text);
  return m && +m[1] >= 3 && +m[1] <= 999 ? +m[1] : null;
};

// --- Circle / Polygon -------------------------------------------------------

class CircleTool extends Tool {
  hint = 'Click the centre. Draws on the face under the cursor, or the ground; arrow keys lock the plane. Type 24s for 24 sides.';
  vcbLabel = 'Radius';
  protected sides = 24;
  protected noun = 'Circle';
  private c: V3 | null = null;
  private n: V3 = [0, 0, 1];
  private first: V3 | null = null;

  busy() { return !!this.c; }

  private dir(): V3 {
    if (this.first && dist(this.first, this.c!) > EPS) return norm(sub(this.first, this.c!));
    return basis(this.n)[0];
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (!this.c) {
      const s = this.snap(e);
      this.drawSnap(e, s);
    } else {
      const { p, s } = onPlane(this.ed, e, this.c, this.n);
      this.first = p;
      if (SNAP_COLOR[s.kind]) vp.marker(s.p, SNAP_COLOR[s.kind]);
      vp.line(this.c, p, '#4a5568', true);
      if (dist(p, this.c) > EPS) drawChain(this.ed, ngon(this.c, this.n, p, this.sides), true);
      vp.tip(SNAP_LABEL[s.kind], e.x, e.y);
      this.ed.setMeasure(dist(p, this.c));
    }
    vp.render();
  }

  onDown(e: PtrEvt) {
    if (!this.c) {
      const s = this.snap(e);
      this.c = s.p;
      this.n = planeNormal(this.ed, s);
      this.first = null;
      this.ed.setHint(`Click to set the radius, or type a radius. ${this.noun}: ${this.sides} sides.`);
      return;
    }
    if (this.first) this.finish(dist(this.first, this.c));
  }

  private finish(r: number) {
    if (!this.c || r < EPS) return;
    commitChain(this.ed, ngon(this.c, this.n, add(this.c, scale(this.dir(), r)), this.sides), true);
    const [c, n, first] = [this.c, this.n, this.first];
    this.ed.retypable((t) => {
      [this.c, this.n, this.first] = [c, n, first];
      const k = segCount(t);
      if (!k) return this.onVcb(t);
      this.sides = k;
      this.finish(r);
      return true;
    });
    this.cancel();
  }

  onVcb(text: string) {
    const k = segCount(text);
    if (k) {
      this.sides = k;
      this.ed.flash(`${this.noun}: ${k} sides`);
      this.refresh();
      return true;
    }
    const r = this.parse(text);
    if (r === null || !this.c) return false;
    this.finish(Math.abs(r));
    return true;
  }

  cancel() {
    this.c = null;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

class PolygonTool extends CircleTool {
  hint = 'Click the centre. Radius is to a corner. Type 8s for 8 sides; arrow keys lock the plane.';
  protected sides = 6;
  protected noun = 'Polygon';
}

// --- Arc --------------------------------------------------------------------

class ArcTool extends Tool {
  hint = 'Click the start of the arc. Type 12s to set the number of segments.';
  vcbLabel = 'Length';
  private segs = 12;
  private stage: 0 | 1 | 2 = 0;
  private a: V3 = [0, 0, 0];
  private b: V3 = [0, 0, 0];
  private n0: V3 = [0, 0, 1];
  private n: V3 = [0, 0, 1];
  private cur: V3 | null = null;
  private s = 0;

  busy() { return this.stage > 0; }

  /** Direction a single edge arrives at `a`, for tangent snapping. */
  private incoming(): V3 | null {
    const mesh = this.ed.active.mesh;
    const v = mesh.findVertex(this.ed.toLocal(this.a));
    if (v === undefined) return null;
    const es = mesh.vertexEdges(v);
    if (es.length !== 1) return null;
    const o = es[0][0] === v ? es[0][1] : es[0][0];
    return norm(sub(this.a, applyX(this.ed.activeXform, mesh.pos(o))));
  }

  /** Plane of the arc: holds the chord, as close to the starting plane as it can. */
  private planeFor(e: PtrEvt): V3 {
    const ch = norm(sub(this.b, this.a));
    const n = sub(this.n0, scale(ch, dot(this.n0, ch)));
    if (len(n) > 0.1) return norm(n);
    const r = this.ed.vp.ray(e.x, e.y);
    return norm(cross(ch, cross(r.d, ch)));
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (this.stage < 2) {
      const s = this.snap(e, this.stage ? this.a : null);
      this.drawSnap(e, s, this.stage ? this.a : null);
      this.cur = s.p;
      if (this.stage) this.ed.setMeasure(dist(this.a, s.p));
    } else {
      this.n = this.planeFor(e);
      const m = scale(add(this.a, this.b), 0.5);
      const { p, s } = onPlane(this.ed, e, m, this.n);
      const h = dist(this.a, this.b) / 2;
      const w = cross(this.n, norm(sub(this.b, this.a)));
      let bulge = dot(sub(p, m), w), label = SNAP_LABEL[s.kind];
      const inc = this.incoming();
      const tan = inc ? tangentSagitta(this.a, this.b, this.n, inc) : null;
      if (Math.abs(Math.abs(bulge) - h) < 0.04 * h) [bulge, label] = [Math.sign(bulge) * h, 'Half Circle'];
      else if (tan !== null && Math.abs(bulge - tan) < 0.06 * h + 0.03 * Math.abs(tan)) [bulge, label] = [tan, 'Tangent at Vertex'];
      this.s = bulge;
      drawChain(this.ed, arcPoints(this.a, this.b, this.n, bulge, this.segs), false);
      vp.line(m, add(m, scale(w, bulge)), '#4a5568', true);
      if (SNAP_COLOR[s.kind]) vp.marker(s.p, SNAP_COLOR[s.kind]);
      vp.tip(label, e.x, e.y);
      this.ed.setMeasure(Math.abs(bulge));
    }
    vp.render();
  }

  onDown(e: PtrEvt) {
    if (this.stage === 0) {
      const s = this.snap(e);
      this.a = s.p;
      this.n0 = planeNormal(this.ed, s);
      this.stage = 1;
      this.ed.setHint('Click the end of the arc, or type the chord length.');
    } else if (this.stage === 1) {
      this.setEnd(this.snap(e, this.a).p);
    } else {
      this.finish(this.s);
    }
  }

  private setEnd(p: V3) {
    if (dist(p, this.a) < EPS) return;
    this.b = p;
    this.stage = 2;
    this.s = 0;
    this.vcbLabel = 'Bulge';
    this.ed.setHint('Move out to set the bulge, click to finish, or type the bulge distance.');
    this.refresh();
  }

  private finish(s: number) {
    commitChain(this.ed, arcPoints(this.a, this.b, this.n, s, this.segs), false);
    const [a, b, n] = [this.a, this.b, this.n];
    this.ed.retypable((t) => {
      [this.stage, this.a, this.b, this.n, this.s] = [2, a, b, n, s];
      const k = segCount(t);
      if (!k) return this.onVcb(t);
      this.segs = k;
      this.finish(s);
      return true;
    });
    this.cancel();
  }

  onVcb(text: string) {
    const k = segCount(text);
    if (k) {
      this.segs = k;
      this.ed.flash(`Arc: ${k} segments`);
      this.refresh();
      return true;
    }
    const l = this.parse(text);
    if (l === null || !this.stage) return false;
    if (this.stage === 2) {
      this.finish((Math.sign(this.s) || 1) * Math.abs(l));
      return true;
    }
    if (!this.cur || dist(this.cur, this.a) < EPS) return false;
    this.setEnd(add(this.a, scale(norm(sub(this.cur, this.a)), l)));
    return true;
  }

  cancel() {
    this.stage = 0;
    this.vcbLabel = 'Length';
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Freehand ---------------------------------------------------------------

class FreehandTool extends Tool {
  hint = 'Press and drag to draw. End near the start to make a face.';
  private pts: V3[] = [];
  private n: V3 = [0, 0, 1];

  busy() { return this.pts.length > 0; }

  private nearStart(e: PtrEvt) {
    const s = this.ed.vp.toScreen(this.pts[0]);
    return this.pts.length > 3 && !!s && Math.hypot(s[0] - e.x, s[1] - e.y) < 10;
  }

  onDown(e: PtrEvt) {
    const s = this.snap(e);
    this.pts = [s.p];
    this.n = planeNormal(this.ed, s);
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (!this.pts.length) {
      this.drawSnap(e, this.snap(e));
    } else {
      const p = vp.rayPlane(vp.ray(e.x, e.y), this.pts[0], this.n);
      const last = vp.toScreen(this.pts[this.pts.length - 1]);
      // Drop points closer than a few pixels to the last one kept.
      if (p && last && Math.hypot(last[0] - e.x, last[1] - e.y) > 6) this.pts.push(p);
      drawChain(this.ed, this.pts, false);
      vp.tip(this.nearStart(e) ? 'Close' : '', e.x, e.y);
    }
    vp.render();
  }

  onUp(e: PtrEvt) {
    if (!this.pts.length) return;
    const closed = this.nearStart(e);
    const pts = closed ? this.pts.slice(0, -1) : this.pts;
    if (pts.length >= 2) commitChain(this.ed, pts, closed && pts.length >= 3);
    this.cancel();
  }

  cancel() {
    this.pts = [];
    super.cancel();
  }
}

// --- Offset -----------------------------------------------------------------

class OffsetTool extends Tool {
  hint = 'Click a face (or select one first, then click), move in or out, click to finish. Type a distance.';
  vcbLabel = 'Distance';
  private act: { loop: V3[]; n: V3; p0: V3; wn: V3 } | null = null;
  private d = 0;

  busy() { return !!this.act; }

  /** Face to offset: the one under the cursor, else a single selected face. */
  private face(e: PtrEvt): number | null {
    const f = this.ed.vp.pickFace(e.x, e.y);
    if (f?.owner === 'self') return f.faceId;
    const sel = this.ed.selection.filter((s) => s.kind === 'face');
    return sel.length === 1 && sel[0].kind === 'face' ? sel[0].id : null;
  }

  private world(pts: V3[]) {
    const x = this.ed.activeXform;
    return pts.map((p) => applyX(x, p));
  }

  onMove(e: PtrEvt) {
    super.onMove(e);
    const vp = this.ed.vp;
    vp.clearOverlay();
    if (!this.act) {
      const id = this.face(e);
      if (id !== null) vp.highlightFace(this.ed.active.id, id);
      vp.render();
      return;
    }
    const { loop, n, p0, wn } = this.act;
    const w = vp.rayPlane(vp.ray(e.x, e.y), p0, wn);
    if (!w) return;
    const p = this.ed.toLocal(w);
    // Signed distance from the nearest edge: positive outside the loop.
    let best = Infinity;
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length];
      const { t } = projectOnSegment(p, a, b);
      const q = add(a, scale(sub(b, a), Math.max(0, Math.min(1, t))));
      const dd = dist(p, q);
      if (dd < Math.abs(best)) best = dd * (dot(sub(p, q), cross(sub(b, a), n)) >= 0 ? 1 : -1);
    });
    this.d = best;
    const o = offsetLoop(loop, n, this.d);
    if (o) drawChain(this.ed, this.world(o), true);
    vp.tip(o ? '' : 'Too far', e.x, e.y);
    this.ed.setMeasure(Math.abs(this.d));
    vp.render();
  }

  onDown(e: PtrEvt) {
    if (this.act) return this.finish(this.d);
    const id = this.face(e);
    const mesh = this.ed.active.mesh;
    const f = id === null ? undefined : mesh.faces.get(id);
    if (!f) return;
    // ponytail: offsets the outer loop only; holes are ignored.
    const loop = f.loops[0].map((v) => mesh.pos(v));
    const n = mesh.faceNormal(f);
    this.act = { loop, n, p0: applyX(this.ed.activeXform, loop[0]), wn: norm(applyDir(this.ed.activeXform, n)) };
    this.ed.setHint('Move in or out, click to finish, or type a distance.');
  }

  private finish(d: number) {
    const o = this.act && Math.abs(d) > EPS ? offsetLoop(this.act.loop, this.act.n, d) : null;
    if (this.act && !o) return this.ed.flash("Can't offset that far");
    if (o) {
      commitChain(this.ed, this.world(o), true);
      const act = this.act;
      this.retypeWith(() => [this.act, this.d] = [act, d]);
    }
    this.cancel();
  }

  onVcb(text: string) {
    const l = this.parse(text);
    if (l === null || !this.act) return false;
    this.finish((Math.sign(this.d) || -1) * Math.abs(l));
    return true;
  }

  cancel() {
    this.act = null;
    this.ed.setHint(this.hint);
    super.cancel();
  }
}

// --- Navigation tools (dragging is handled by the viewport) -----------------

class OrbitTool extends Tool {
  hint = 'Drag to orbit. Two-finger drag orbits from any tool; Shift + two-finger drag pans.';
}
class PanTool extends Tool {
  hint = 'Drag to pan.';
}

export function makeTool(name: ToolName, ed: Editor): Tool {
  const T = {
    select: SelectTool, line: LineTool, rect: RectTool, pushpull: PushPullTool, move: MoveTool, rotate: RotateTool,
    orbit: OrbitTool, pan: PanTool, tape: TapeTool, dim: DimTool, paint: PaintTool, eraser: EraserTool, scale: ScaleTool,
    arc: ArcTool, circle: CircleTool, polygon: PolygonTool, freehand: FreehandTool, offset: OffsetTool,
  }[name];
  return new T(ed);
}

