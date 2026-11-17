import { describe, expect, it } from 'vitest';
import { applyActions, describeModel, parseReply } from './assistant';
import { Editor } from './editor';

const ids = (ed: Editor) => ed.root.children.map((g) => g.id);

describe('assistant actions', () => {
  it('parses prose and an actions block', () => {
    const r = parseReply('Adding a shelf.\n```actions\n[{"op":"rename","id":"a","name":"b"}]\n```');
    expect(r.prose).toBe('Adding a shelf.');
    expect(r.actions).toHaveLength(1);
    expect(parseReply('```actions\n{oops\n```').error).toBeTruthy();
    expect(parseReply('Just chatting').actions).toEqual([]);
  });

  it('builds, moves, copies and deletes as one undo step', () => {
    const ed = new Editor();
    expect(applyActions(ed, [{ op: 'box', name: 'Shelf', size: [600, 300, 18], at: [0, 0, 900] }])).toEqual([]);
    const shelf = ed.root.children[0];
    expect(describeModel(ed)).toContain(`${shelf.id} | Shelf | ${ed.root.id} | [0, 0, 900] → [600, 300, 918]`);

    const errors = applyActions(ed, [
      { op: 'move', id: shelf.id, by: [100, 0, 0] },
      { op: 'copy', id: shelf.id, by: [0, 0, 300], count: 2 },
      { op: 'resize', id: shelf.id, size: [800, 300, 18] },
      { op: 'rotate', id: 'nope', deg: 90 },
    ]);
    expect(errors).toEqual(['rotate: no group nope']);
    expect(ed.root.children).toHaveLength(3);
    const text = describeModel(ed);
    expect(text).toContain('[100, 0, 900] → [900, 300, 918]');
    expect(text).toContain('[100, 0, 1500] → [700, 300, 1518]');

    ed.undo();
    expect(ed.root.children).toHaveLength(1);
    ed.redo();
    applyActions(ed, [{ op: 'delete', ids: ids(ed).slice(1) }]);
    expect(ed.root.children).toHaveLength(1);
  });

  it('makes cylinders and AI-prop placeholders', () => {
    const ed = new Editor();
    expect(applyActions(ed, [
      { op: 'cylinder', name: 'Leg', radius: 20, height: 700, at: [100, 100, 0] },
      { op: 'generate', name: 'Chair', prompt: 'a grey armchair', size: [800, 750, 900], at: [0, 1000, 0] },
      { op: 'generate', prompt: '', size: [1, 1, 1], at: [0, 0, 0] },
    ])).toEqual(['generate: needs a prompt']);
    const [leg, chair] = ed.root.children;
    expect(leg.mesh.faces.size).toBe(26);
    expect(describeModel(ed)).toContain('[80, 80, 0] → [120, 120, 700]');
    expect(chair.prop).toMatchObject({ prompt: 'a grey armchair' });
    expect(chair.prop!.id).toMatch(/^[a-z0-9]{12}$/);
    expect(describeModel(ed)).toContain('[0, 1000, 0] → [800, 1750, 900]');
    expect(describeModel(ed)).toContain('AI model "a grey armchair"');
    applyActions(ed, [{ op: 'generate', prompt: 'a grey armchair', size: [800, 750, 900], at: [2000, 0, 0] }]);
    expect(ed.root.children[2].prop!.id).toBe(chair.prop!.id);
  });

  it('draws a flat rectangle as loose geometry', () => {
    const ed = new Editor();
    expect(applyActions(ed, [{ op: 'rect', size: [1870, 420], at: [0, 0, 0] }])).toEqual([]);
    expect(ed.root.mesh.faces.size).toBe(1);
    expect(Math.max(...[...ed.root.mesh.verts.values()].map((p) => p[0]))).toBe(1870);
  });

  it('rotates about the bounding-box centre', () => {
    const ed = new Editor();
    applyActions(ed, [{ op: 'box', size: [200, 100, 10], at: [0, 0, 0] }]);
    applyActions(ed, [{ op: 'rotate', id: ids(ed)[0], deg: 90 }]);
    expect(describeModel(ed)).toContain('[50, -50, 0] → [150, 150, 10]');
  });
});
