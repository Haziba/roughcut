import { describe, expect, it } from 'vitest';
import { meshesFromTriangles, parseStl } from './stl';

// Unit cube as 12 outward-wound triangles, plus a second cube 5 units away.
const cube = (o: number) => {
  const v = (x: number, y: number, z: number) => [x + o, y, z];
  const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  const p = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0), v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)];
  return [
    ...q(p[0], p[3], p[2], p[1]), ...q(p[4], p[5], p[6], p[7]),
    ...q(p[0], p[1], p[5], p[4]), ...q(p[2], p[3], p[7], p[6]),
    ...q(p[1], p[2], p[6], p[5]), ...q(p[3], p[0], p[4], p[7]),
  ];
};

const ascii = (nums: number[]) => {
  let s = 'solid t\n';
  for (let i = 0; i < nums.length; i += 9) {
    s += 'facet normal 0 0 0\nouter loop\n';
    for (let k = 0; k < 9; k += 3) s += `vertex ${nums[i + k]} ${nums[i + k + 1]} ${nums[i + k + 2]}\n`;
    s += 'endloop\nendfacet\n';
  }
  return new TextEncoder().encode(`${s}endsolid t\n`).buffer as ArrayBuffer;
};

const binary = (nums: number[]) => {
  const n = nums.length / 9;
  const dv = new DataView(new ArrayBuffer(84 + n * 50));
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + i * 50 + 12 + k * 4, nums[i * 9 + k], true);
  return dv.buffer;
};

describe('STL import', () => {
  it('reads ASCII and binary alike', () => {
    expect(parseStl(ascii(cube(0)))).toEqual(parseStl(binary(cube(0))));
  });

  it('rebuilds a cube as 6 faces with 12 edges, in mm', () => {
    const [m] = meshesFromTriangles(parseStl(binary(cube(0))), 10);
    expect(m.faces.size).toBe(6);
    expect(m.edges.size).toBe(12);
    expect(m.verts.size).toBe(8);
    const top = [...m.faces.values()].find((f) => f.loops[0].every((v) => m.pos(v)[2] === 10))!;
    expect(m.faceNormal(top)).toEqual([0, 0, 1]);
  });

  it('splits separate solids into separate meshes', () => {
    expect(meshesFromTriangles(parseStl(binary([...cube(0), ...cube(5)])), 1)).toHaveLength(2);
  });

  it('rejects junk', () => {
    expect(() => parseStl(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toThrow();
  });
});
