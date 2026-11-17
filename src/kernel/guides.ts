import { type V3, AXES, add, closestLineParams, cross, dist, dot, len, norm, scale, sub } from './vec';

/**
 * A guide, in the group's local coords: an infinite line through p along unit d, or (no d)
 * a guide point at p, drawn with a dashed leader from `from` when set.
 */
export interface Guide {
  p: V3;
  d?: V3;
  from?: V3;
}

/** Guide lines are drawn and snapped as segments this long each way. */
export const GUIDE_LEN = 1e5;

/** Points where guide lines (unit d) cross each other or cross segments. */
export function guideHits(lines: { p: V3; d: V3 }[], segs: [V3, V3][]): V3[] {
  const out: V3[] = [];
  const hit = (p: V3, d: V3, q: V3, e: V3, seg: boolean) => {
    const st = closestLineParams(p, d, q, e);
    if (!st) return;
    const [s, t] = st;
    const a = add(p, scale(d, s));
    if (dist(a, add(q, scale(e, t))) > 0.01 || Math.abs(s) > GUIDE_LEN) return;
    if (seg && (t < -1e-9 || t > 1 + 1e-9)) return;
    out.push(a);
  };
  lines.forEach((l, i) => {
    for (let j = i + 1; j < lines.length; j++) hit(l.p, l.d, lines[j].p, lines[j].d, false);
    for (const [a, b] of segs) hit(l.p, l.d, a, sub(b, a), true);
  });
  return out;
}

const axial = (v: V3) => AXES.some((a) => Math.abs(dot(a, v)) > 0.9999);

/**
 * Directions to infer from a remembered edge with direction d: parallel to it, and
 * perpendicular to it within each plane normal given. Axis-aligned ones are skipped since
 * the axis inference already covers them.
 */
export function alignDirs(d: V3, normals: V3[]): { dir: V3; kind: 'parallel' | 'perp' }[] {
  const out: { dir: V3; kind: 'parallel' | 'perp' }[] = [];
  const push = (dir: V3, kind: 'parallel' | 'perp') => {
    if (axial(dir) || out.some((o) => Math.abs(dot(o.dir, dir)) > 0.9999)) return;
    out.push({ dir, kind });
  };
  const u = norm(d);
  if (len(u) < 0.5) return out;
  push(u, 'parallel');
  for (const n of normals) {
    const c = cross(u, n);
    if (len(c) > 0.05) push(norm(c), 'perp');
  }
  return out;
}
