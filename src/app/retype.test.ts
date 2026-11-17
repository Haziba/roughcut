import { describe, expect, it } from 'vitest';
import { Editor } from './editor';

function setup() {
  const ed = new Editor();
  const key = (k: string) => ed.onKeyDown({ key: k, target: { closest: () => null }, preventDefault() {} } as unknown as KeyboardEvent);
  const type = (s: string) => { [...s].forEach(key); key('Enter'); };
  const draw = (l: number) => {
    ed.commit(() => ed.active.mesh.addEdge([0, 0, 0], [l, 0, 0]));
    ed.retypable((t) => (+t > 0 ? (draw(+t), true) : false));
  };
  const lengths = () => [...ed.active.mesh.verts.values()].map((p) => p[0]).sort((a, b) => a - b);
  return { ed, type, draw, lengths };
}

describe('retype after finishing', () => {
  it('redoes the last operation with the typed value, as one undo step', () => {
    const { ed, type, draw, lengths } = setup();
    draw(100);
    type('250');
    expect(lengths()).toEqual([0, 250]);
    type('300');
    expect(lengths()).toEqual([0, 300]);
    ed.undo();
    expect(lengths()).toEqual([]);
  });

  it('keeps the original when the value is rejected', () => {
    const { type, draw, lengths } = setup();
    draw(100);
    type('0');
    expect(lengths()).toEqual([0, 100]);
    type('40');
    expect(lengths()).toEqual([0, 40]);
  });

  it('does nothing once something else was committed, or the tool changed', () => {
    const { ed, type, draw, lengths } = setup();
    draw(100);
    ed.commit(() => ed.active.guides.push({ p: [0, 0, 0], d: [1, 0, 0] }));
    type('250');
    expect(lengths()).toEqual([0, 100]);
    draw(100);
    ed.setTool('line');
    type('250');
    expect(lengths()).toEqual([0, 100]);
  });
});
