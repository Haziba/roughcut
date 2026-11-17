import { describe, expect, it } from 'vitest';
import { type P2, boxHit, rectOf } from './boxselect';

const r = rectOf(100, 100, 0, 0);
const seg = (a: P2, b: P2): [P2, P2] => [a, b];

describe('boxHit', () => {
  it('window needs the whole thing inside', () => {
    expect(boxHit(r, [seg([10, 10], [90, 90])], false)).toBe(true);
    expect(boxHit(r, [seg([10, 10], [190, 90])], false)).toBe(false);
    expect(boxHit(r, [[[10, 10], null]], false)).toBe(false);
  });

  it('crossing takes anything touching', () => {
    expect(boxHit(r, [seg([50, -50], [50, 150])], true)).toBe(true);
    expect(boxHit(r, [seg([150, -50], [150, 150])], true)).toBe(false);
  });

  it('crossing a big face from inside selects it', () => {
    const poly: P2[] = [[-500, -500], [500, -500], [500, 500], [-500, 500]];
    const segs = poly.map((p, i) => seg(p, poly[(i + 1) % 4]));
    expect(boxHit(r, segs, true, poly)).toBe(true);
    expect(boxHit(r, segs, false, poly)).toBe(false);
  });
});
