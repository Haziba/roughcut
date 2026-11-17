import { describe, expect, it } from 'vitest';
import { apply, applyNormal, compose, det, invert, rotation, scaling, signedAngle } from './xform';

describe('xform', () => {
  it('rotates 90° about a pivot exactly', () => {
    const x = rotation([10, 0, 0], [0, 0, 1], Math.PI / 2);
    expect(apply(x, [20, 0, 0])).toEqual([10, 10, 0]);
  });

  it('inverts and composes', () => {
    const a = compose(rotation([5, 5, 0], [1, 1, 0], 0.7), { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [3, -2, 9] });
    const p = apply(invert(a), apply(a, [1, 2, 3]));
    p.forEach((c, i) => expect(c).toBeCloseTo([1, 2, 3][i], 9));
  });

  it('measures signed angles', () => {
    expect(signedAngle([1, 0, 0], [0, 1, 0], [0, 0, 1])).toBeCloseTo(Math.PI / 2);
    expect(signedAngle([1, 0, 0], [0, -1, 0], [0, 0, 1])).toBeCloseTo(-Math.PI / 2);
  });
});

describe('scale and mirror', () => {
  const close = (p: number[], q: number[]) => p.forEach((c, i) => expect(c).toBeCloseTo(q[i], 9));

  it('inverts and composes a non-uniform scale with rotation', () => {
    const a = compose(rotation([0, 0, 0], [0, 0, 1], 0.4), scaling([10, 0, 5], [2, 0.5, 3]));
    close(apply(invert(a), apply(a, [1, 2, 3])), [1, 2, 3]);
    close(apply(compose(a, invert(a)), [7, -4, 2]), [7, -4, 2]);
  });

  it('mirrors about a pivot with a negative determinant', () => {
    const m = scaling([100, 0, 0], [-1, 1, 1]);
    expect(apply(m, [150, 3, 4])).toEqual([50, 3, 4]);
    expect(det(m.r)).toBe(-1);
    close(apply(invert(m), [50, 3, 4]), [150, 3, 4]);
  });

  it('keeps normals perpendicular under non-uniform scale', () => {
    const s = scaling([0, 0, 0], [4, 1, 1]);
    // A face on the plane x + y = 1 has normal (1,1,0)/√2; after scaling it lies on x/4 + y = 1.
    const n = applyNormal(s, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    const along = apply(s, [1, -1, 0]); // a direction lying in the original plane
    expect(n[0] * along[0] + n[1] * along[1] + n[2] * along[2]).toBeCloseTo(0, 9);
  });
});
