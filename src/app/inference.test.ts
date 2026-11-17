import { describe, expect, it } from 'vitest';
import { newInference, noteHover } from './inference';

describe('inference dwell', () => {
  it('tracks a point hovered long enough, keeping at most 3', () => {
    const inf = newInference();
    noteHover(inf, { point: [1, 0, 0] }, 0);
    noteHover(inf, { point: [2, 0, 0] }, 100); // left [1,0,0] too soon
    expect(inf.tracked).toEqual([]);
    noteHover(inf, null, 500);
    expect(inf.tracked).toEqual([[2, 0, 0]]);
    for (let i = 3; i < 7; i++) {
      noteHover(inf, { point: [i, 0, 0] }, i * 1000);
      noteHover(inf, { point: [i, 0, 0] }, i * 1000 + 400);
    }
    expect(inf.tracked).toEqual([[4, 0, 0], [5, 0, 0], [6, 0, 0]]);
  });

  it('remembers a hovered edge', () => {
    const inf = newInference();
    noteHover(inf, { a: [0, 0, 0], b: [1, 1, 0] }, 0);
    noteHover(inf, null, 400);
    expect(inf.refEdge).toEqual({ a: [0, 0, 0], b: [1, 1, 0] });
  });
});
