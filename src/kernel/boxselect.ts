export type P2 = [number, number];
export interface Rect { x0: number; y0: number; x1: number; y1: number }

export const rectOf = (ax: number, ay: number, bx: number, by: number): Rect =>
  ({ x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) });

const inside = (r: Rect, p: P2) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;
const side = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const crosses = (a: P2, b: P2, c: P2, d: P2) => side(c, d, a) * side(c, d, b) <= 0 && side(a, b, c) * side(a, b, d) <= 0;

function touches(r: Rect, a: P2, b: P2) {
  if (inside(r, a) || inside(r, b)) return true;
  const c: P2[] = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
  return c.some((p, i) => crosses(a, b, p, c[(i + 1) % 4]));
}

function inPoly(p: P2, poly: P2[]) {
  let inn = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i], poly[j]];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inn = !inn;
  }
  return inn;
}

/**
 * Box-select test in screen space. segs: the item's outline (null = behind the camera);
 * poly: its filled outline, for faces. Window (crossing=false) = wholly inside the box;
 * crossing = touching it at all.
 * ponytail: segments with one end behind the camera are ignored for crossing; clip them if it matters.
 */
export function boxHit(r: Rect, segs: [P2 | null, P2 | null][], crossing: boolean, poly?: (P2 | null)[]): boolean {
  if (!crossing) return segs.length > 0 && segs.every(([a, b]) => !!a && !!b && inside(r, a) && inside(r, b));
  if (segs.some(([a, b]) => a && b && touches(r, a, b))) return true;
  return !!poly && poly.length > 2 && poly.every(Boolean) && inPoly([r.x0, r.y0], poly as P2[]);
}
