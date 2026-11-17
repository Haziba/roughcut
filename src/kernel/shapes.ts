import { type V3, add, cross, dist, dot, norm, scale, sub } from './vec';

/** Regular k-gon round centre c in the plane with normal n; the first vertex is at `first`. */
export function ngon(c: V3, n: V3, first: V3, k: number): V3[] {
  const u = norm(sub(first, c));
  const v = cross(n, u);
  const r = dist(first, c);
  return Array.from({ length: k }, (_, i) => {
    const t = (2 * Math.PI * i) / k;
    return add(c, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t))));
  });
}

/**
 * Arc from a to b in the plane with normal n, bulging `s` (the sagitta) from the chord
 * midpoint towards n × (b − a). Returns k + 1 points, a and b included.
 */
export function arcPoints(a: V3, b: V3, n: V3, s: number, k: number): V3[] {
  const h = dist(a, b) / 2;
  const d = norm(sub(b, a));
  const w = cross(n, d);
  const m = scale(add(a, b), 0.5);
  if (Math.abs(s) < 1e-9) return [a, b];
  const r = (h * h + s * s) / (2 * Math.abs(s));
  const yc = s - Math.sign(s) * r; // centre, in chord coords (x along d, y along w)
  const sweep = -4 * Math.atan(s / h);
  const a0 = Math.atan2(-yc, -h);
  return Array.from({ length: k + 1 }, (_, i) => {
    if (i === 0) return a;
    if (i === k) return b;
    const t = a0 + (sweep * i) / k;
    return add(m, add(scale(d, r * Math.cos(t)), scale(w, yc + r * Math.sin(t))));
  });
}

/** Sagitta that makes an arc on chord a→b leave a tangent to direction `dir`. */
export function tangentSagitta(a: V3, b: V3, n: V3, dir: V3): number {
  const d = norm(sub(b, a));
  const th = Math.atan2(dot(dir, cross(n, d)), dot(dir, d));
  return (dist(a, b) / 2) * Math.tan(th / 2);
}

/**
 * Offset a closed planar loop by d (positive = outward) with mitred corners.
 * Returns null when an edge would flip over, i.e. the offset collapses part of the shape.
 *
 * ponytail: only catches collapsing edges; offsets where non-adjacent edges cross (deep
 * notches in concave shapes) still come back self-intersecting. Needs a proper
 * straight-skeleton / polygon-clipping pass if that matters.
 */
export function offsetLoop(pts: V3[], n: V3, d: number): V3[] | null {
  const k = pts.length;
  // Newell's normal, so the loop's winding about n does not matter.
  const nw: V3 = [0, 0, 0];
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % k];
    nw[0] += (p[1] - q[1]) * (p[2] + q[2]);
    nw[1] += (p[2] - q[2]) * (p[0] + q[0]);
    nw[2] += (p[0] - q[0]) * (p[1] + q[1]);
  });
  const sd = dot(nw, n) < 0 ? -d : d;
  const out = (i: number) => norm(cross(sub(pts[(i + 1) % k], pts[i]), n));
  const res = pts.map((p, i) => {
    const n1 = out((i - 1 + k) % k), n2 = out(i);
    const c = 1 + dot(n1, n2);
    if (c < 1e-6) return null;
    return add(p, scale(add(n1, n2), sd / c));
  });
  if (res.some((p) => !p)) return null;
  const r = res as V3[];
  for (let i = 0; i < k; i++) {
    if (dot(sub(r[(i + 1) % k], r[i]), sub(pts[(i + 1) % k], pts[i])) <= 0) return null;
  }
  return r;
}
