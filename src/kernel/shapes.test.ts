import { describe, expect, it } from 'vitest';
import { Mesh } from './mesh';
import { arcPoints, ngon, offsetLoop, tangentSagitta } from './shapes';
import { type V3, dist } from './vec';

const close = (a: V3[], b: V3[]) => a.forEach((p, i) => p.forEach((x, j) => expect(x).toBeCloseTo(b[i][j], 6)));
const Z: V3 = [0, 0, 1];

describe('ngon', () => {
  it('circle points lie on the circle and close a face', () => {
    const pts = ngon([10, 20, 0], Z, [60, 20, 0], 24);
    expect(pts).toHaveLength(24);
    pts.forEach((p) => expect(dist(p, [10, 20, 0])).toBeCloseTo(50, 9));
    const m = new Mesh();
    pts.forEach((p, i) => m.addEdge(p, pts[(i + 1) % 24]));
    expect(m.faces.size).toBe(1);
    expect(m.edges.size).toBe(24);
    const f = [...m.faces.values()][0];
    m.pushPull(f.id, -30);
    expect(m.faces.size).toBe(26);
  });
});

describe('arc', () => {
  it('half circle passes through the apex and ends on the chord ends', () => {
    const pts = arcPoints([0, 0, 0], [100, 0, 0], Z, 50, 12);
    expect(pts[0]).toEqual([0, 0, 0]);
    expect(pts[12]).toEqual([100, 0, 0]);
    close([pts[6]], [[50, 50, 0]]);
    pts.forEach((p) => expect(dist(p, [50, 0, 0])).toBeCloseTo(50, 9));
  });

  it('negative bulge goes the other way; shallow arc keeps its radius', () => {
    const pts = arcPoints([0, 0, 0], [100, 0, 0], Z, -10, 8);
    close([pts[4]], [[50, -10, 0]]);
    const r = (50 * 50 + 10 * 10) / 20;
    pts.forEach((p) => expect(dist(p, [50, -10 + r, 0])).toBeCloseTo(r, 9));
  });

  it('tangent sagitta continues a line', () => {
    // Coming in along +X at the origin, chord to (100,100): tangent arc is a quarter circle.
    expect(tangentSagitta([0, 0, 0], [100, 100, 0], Z, [1, 0, 0])).toBeCloseTo(-dist([0, 0, 0], [100, 100, 0]) / 2 * Math.tan(Math.PI / 8), 9);
  });
});

describe('offsetLoop', () => {
  const rect: V3[] = [[0, 0, 0], [100, 0, 0], [100, 50, 0], [0, 50, 0]];

  it('insets and outsets a rectangle, either winding', () => {
    close(offsetLoop(rect, Z, -10)!, [[10, 10, 0], [90, 10, 0], [90, 40, 0], [10, 40, 0]]);
    close(offsetLoop([...rect].reverse(), Z, 5)!, [[-5, 55, 0], [105, 55, 0], [105, -5, 0], [-5, -5, 0]]);
  });

  it('insets an L-shape', () => {
    const l: V3[] = [[0, 0, 0], [100, 0, 0], [100, 40, 0], [40, 40, 0], [40, 100, 0], [0, 100, 0]];
    close(offsetLoop(l, Z, -10)!, [[10, 10, 0], [90, 10, 0], [90, 30, 0], [30, 30, 0], [30, 90, 0], [10, 90, 0]]);
  });

  it('refuses an inset that collapses the shape', () => {
    expect(offsetLoop(rect, Z, -30)).toBeNull();
  });

  it('an inset loop splits the face into a ring and an inner face', () => {
    const m = new Mesh();
    rect.forEach((p, i) => m.addEdge(p, rect[(i + 1) % 4]));
    const o = offsetLoop(rect, Z, -10)!;
    o.forEach((p, i) => m.addEdge(p, o[(i + 1) % 4]));
    expect(m.faces.size).toBe(2);
  });
});
