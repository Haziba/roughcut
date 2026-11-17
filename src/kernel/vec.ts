export type V3 = [number, number, number];

/** Geometric tolerance in mm. Points closer than this are the same point. */
export const EPS = 1e-3;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3) => len(sub(a, b));
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0, 0] : scale(a, 1 / l);
};
export const lerp = (a: V3, b: V3, t: number): V3 => add(a, scale(sub(b, a), t));

export const AXES: V3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** Two unit vectors spanning the plane with normal n, with u × v = n. */
export function basis(n: V3): [V3, V3] {
  const helper: V3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  // For horizontal planes keep u along +X so 2D coords match world X/Y.
  const u = Math.abs(n[2]) > 0.9 ? norm(sub(helper, scale(n, dot(helper, n)))) : norm(cross(helper, n));
  return [u, cross(n, u)];
}

/** Parameter t of p projected onto segment a→b, and the distance from the segment line. */
export function projectOnSegment(p: V3, a: V3, b: V3): { t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return { t: 0, d: dist(p, a) };
  const t = dot(sub(p, a), ab) / l2;
  return { t, d: dist(p, add(a, scale(ab, t))) };
}

/** True when p lies on segment a→b, strictly between the endpoints. */
export function onSegmentInterior(p: V3, a: V3, b: V3): boolean {
  const { t, d } = projectOnSegment(p, a, b);
  const l = dist(a, b);
  return d < EPS && t * l > EPS && (1 - t) * l > EPS;
}

/** Closest-approach parameters between lines p+s·d1 and q+t·d2. Null if parallel. */
export function closestLineParams(p: V3, d1: V3, q: V3, d2: V3): [number, number] | null {
  const r = sub(p, q);
  const a = dot(d1, d1), b = dot(d1, d2), c = dot(d2, d2), d = dot(d1, r), e = dot(d2, r);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-12 * a * c) return null;
  return [(b * e - c * d) / den, (a * e - b * d) / den];
}

/** Intersection point of two segments, if they cross at interior points of both. */
export function segmentCrossing(p: V3, q: V3, a: V3, b: V3): V3 | null {
  const st = closestLineParams(p, sub(q, p), a, sub(b, a));
  if (!st) return null;
  const [s, t] = st;
  const x = lerp(p, q, s);
  if (dist(x, lerp(a, b, t)) > EPS) return null;
  const l1 = dist(p, q), l2 = dist(a, b);
  if (s * l1 <= EPS || (1 - s) * l1 <= EPS || t * l2 <= EPS || (1 - t) * l2 <= EPS) return null;
  return x;
}
