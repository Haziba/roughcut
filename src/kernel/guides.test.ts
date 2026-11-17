import { describe, expect, it } from 'vitest';
import { alignDirs, guideHits } from './guides';
import { deserialize, newGroup, serialize } from './model';

describe('guides', () => {
  it('finds guide-guide and guide-edge crossings', () => {
    const hits = guideHits(
      [{ p: [0, 50, 0], d: [1, 0, 0] }, { p: [30, 0, 0], d: [0, 1, 0] }, { p: [0, 0, 10], d: [1, 0, 0] }],
      [[[100, 0, 0], [100, 200, 0]], [[200, 0, 0], [200, 10, 0]]],
    );
    expect(hits).toContainEqual([30, 50, 0]);
    expect(hits).toContainEqual([100, 50, 0]);
    expect(hits).toHaveLength(2); // skew lines and the short edge miss
  });

  it('infers parallel and perpendicular directions, skipping axes', () => {
    const s = Math.SQRT1_2;
    const dirs = alignDirs([1, 1, 0], [[0, 0, 1]]);
    expect(dirs.map((d) => d.kind)).toEqual(['parallel', 'perp']);
    dirs[0].dir.forEach((c, i) => expect(c).toBeCloseTo([s, s, 0][i]));
    dirs[1].dir.forEach((c, i) => expect(Math.abs(c)).toBeCloseTo([s, s, 0][i]));
    expect(alignDirs([1, 0, 0], [[0, 0, 1]])).toEqual([]);
  });

  it('loads files saved before guides existed', () => {
    const data = serialize(newGroup('Model'), 'metric');
    delete (data.root as { guides?: unknown }).guides;
    expect(deserialize(data).root.guides).toEqual([]);
  });
});
