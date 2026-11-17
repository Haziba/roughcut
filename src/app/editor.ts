import { Mesh } from '../kernel/mesh';
import { type Group, deserialize, explode, findGroup, makeComponent, makeUnique, newGroup, serialize, walk, worldXform } from '../kernel/model';
import { meshesFromTriangles } from '../kernel/stl';
import { type Units, formatLength } from '../kernel/units';
import { type V3, AXES } from '../kernel/vec';
import { type M3, type Xform, apply, applyDir, invert } from '../kernel/xform';
import { newInference, refDir } from './inference';
import { type Tool, type ToolName, makeTool } from './tools';
import type { Viewport } from './viewport';

export type Sel = { kind: 'face'; id: number } | { kind: 'edge'; key: string } | { kind: 'group'; id: string } | { kind: 'guide'; i: number };

/** Uncommitted state shown while a tool is mid-gesture, keyed by group id. `adds`: extra child groups (copies). */
export type Preview = Map<string, { mesh?: Mesh; offset?: V3; rot?: M3; adds?: Group[] }>;

const AUTOSAVE_KEY = 'room-planner:autosave';
const TOOL_KEYS: Record<string, ToolName> = {
  ' ': 'select', l: 'line', r: 'rect', p: 'pushpull', m: 'move', q: 'rotate', o: 'orbit', h: 'pan',
  t: 'tape', d: 'dim', b: 'paint', e: 'eraser', s: 'scale',
  a: 'arc', c: 'circle', f: 'offset',
};
/** Keys that start a measurements-box entry, and keys that can continue one. */
const VCB_START = /^[0-9.\-*/x]$/i;
const VCB_CHARS = /^[0-9.,;:'"/\-*° xsmcinft]$/i;

interface FileHandle {
  name: string;
  createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}
type PickerWindow = Window & {
  showSaveFilePicker?: (o: object) => Promise<FileHandle>;
  showOpenFilePicker?: (o: object) => Promise<FileHandle[]>;
};
const PICKER_TYPES = [{ description: 'Roughcut model', accept: { 'application/json': ['.rplan'] } }];

export class Editor {
  root: Group = newGroup('Model');
  /** Context stack from the root to the group being edited. */
  path: Group[] = [this.root];
  units: Units = 'metric';
  color = '#c8a27a';
  selection: Sel[] = [];
  preview: Preview = new Map();
  toolName: ToolName = 'select';
  tool!: Tool;
  vp!: Viewport;

  hint = '';
  measure = '';
  vcbText = '';
  message = '';
  axisLock: V3 | null = null;
  shiftLock: V3 | null = null;
  /** Axis index of the last inference, so Shift can lock onto it. */
  lastAxis: number | null = null;
  /** Remembered edge and tracked points for inference. */
  inf = newInference();
  swapOrbitPan = false;
  /** Option/Alt or Ctrl is down with no other key pressed since: releasing it is a tap. */
  private modTap = false;

  fileName = 'Untitled.rplan';
  private handle: FileHandle | null = null;
  dirty = false;
  private autosaveDirty = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** Bumped by every commit, undo and redo, so a tool can tell if its last edit is still the latest. */
  edits = 0;
  /** The operation just finished, which typing a new value can redo ("retype"). Cleared by any click. */
  lastOp: { at: number; redo: (text: string) => boolean } | null = null;

  version = 0;
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) this.loadData(JSON.parse(saved));
    } catch {
      // Corrupt or blocked storage: start empty.
    }
    this.setTool('select');
    setInterval(() => this.autosave(), 3000);
  }

  // --- change notification -------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  /** Model changed: rebuild the 3D scene and refresh panels. */
  changed() {
    this.vp?.rebuild();
    this.emit();
  }

  /** Only panel text changed. */
  emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // --- context -------------------------------------------------------------

  get active() {
    return this.path[this.path.length - 1];
  }

  /** Active group's local → world transform. */
  get activeXform(): Xform {
    return worldXform(this.path);
  }

  /** World point → active group's local coordinates. */
  toLocal(p: V3): V3 {
    return apply(invert(this.activeXform), p);
  }

  /** World direction → active group's local frame. */
  dirToLocal(v: V3): V3 {
    return applyDir(invert(this.activeXform), v);
  }

  /**
   * Find a group, preferring a child of the active group, then a child of the given parent chain.
   * Groups inside a component definition are reachable through every instance, so the path matters.
   */
  private locate(id: string, parents?: Group[]) {
    for (const ps of [this.path, parents]) {
      const g = ps?.[ps.length - 1].children.find((c) => c.id === id);
      if (g) return { group: g, parents: ps! };
    }
    return findGroup(this.root, id);
  }

  enter(groupId: string, parents?: Group[]) {
    const found = this.locate(groupId, parents);
    if (!found) return;
    this.path = [...found.parents, found.group];
    this.selection = [];
    this.changed();
  }

  exitContext() {
    if (this.path.length <= 1) return;
    const left = this.active;
    this.path = this.path.slice(0, -1);
    this.selection = [{ kind: 'group', id: left.id }];
    this.changed();
  }

  /** Select a group from the outliner, entering its parent's context. */
  focusGroup(id: string, parents?: Group[]) {
    const found = this.locate(id, parents);
    if (!found) return;
    if (!found.parents.length) {
      this.path = [this.root];
      this.selection = [];
    } else {
      this.path = found.parents;
      this.selection = [{ kind: 'group', id }];
    }
    this.changed();
  }

  // --- history -------------------------------------------------------------

  private snapshot() {
    return JSON.stringify({ file: serialize(this.root, this.units), path: this.path.map((g) => g.id) });
  }

  private restore(s: string) {
    const { file, path } = JSON.parse(s);
    this.root = deserialize(file).root;
    this.path = [this.root];
    for (const id of path.slice(1)) {
      const g = this.active.children.find((c) => c.id === id);
      if (!g) break;
      this.path.push(g);
    }
    this.selection = [];
    this.preview.clear();
    this.vp?.invalidate();
    this.markDirty();
    this.changed();
  }

  /**
   * Run a model edit as one undoable step.
   * ponytail: undo stores whole-model snapshots; switch to diffs if models get large.
   */
  commit<T>(fn: () => T): T {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.edits++;
    this.axisLock = null;
    const out = fn();
    this.vp?.invalidate();
    this.preview.clear();
    this.pruneSelection();
    this.markDirty();
    this.changed();
    return out;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.tool.cancel();
    this.edits++;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.tool.cancel();
    this.edits++;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  /** Call right after a commit: `redo(text)` runs the operation again (it has been undone) with a typed value. */
  retypable(redo: (text: string) => boolean) {
    this.lastOp = { at: this.edits, redo };
  }

  /** Typed value right after an operation: undo it and run it again with the new value, as one undo step. */
  private retype(text: string) {
    const op = this.lastOp;
    if (!op || op.at !== this.edits || !this.tool.retypeable()) return false;
    const sel = this.selection;
    this.undo();
    const at = this.edits;
    this.selection = sel;
    if (op.redo(text) && this.edits !== at) return true;
    // Nothing committed: put the original back.
    this.redo();
    this.selection = sel;
    this.lastOp = { ...op, at: this.edits };
    this.emit();
    return false;
  }

  private markDirty() {
    this.dirty = true;
    this.autosaveDirty = true;
  }

  private pruneSelection() {
    const m = this.active.mesh;
    this.selection = this.selection.filter((s) =>
      s.kind === 'face' ? m.faces.has(s.id)
        : s.kind === 'edge' ? m.edges.has(s.key)
        : s.kind === 'guide' ? s.i < this.active.guides.length
        : this.active.children.some((c) => c.id === s.id));
  }

  // --- tools ---------------------------------------------------------------

  setTool(name: ToolName) {
    this.tool?.cancel();
    this.toolName = name;
    this.tool = makeTool(name, this);
    this.lastOp = null;
    this.inf = newInference();
    this.axisLock = null;
    this.vcbText = '';
    this.measure = '';
    this.hint = this.tool.hint;
    this.vp?.clearOverlay();
    this.emit();
  }

  setHint(h: string) {
    this.hint = h;
    this.emit();
  }

  setMeasure(mm: number | string) {
    this.measure = typeof mm === 'number' ? formatLength(mm, this.units) : mm;
    this.emit();
  }

  fmt(mm: number) {
    return formatLength(mm, this.units);
  }

  get lock(): V3 | null {
    return this.axisLock ?? this.shiftLock;
  }

  setUnits(u: Units) {
    this.units = u;
    this.markDirty();
    this.changed();
  }

  // --- selection commands --------------------------------------------------

  isSelected(s: Sel) {
    return this.selection.some((x) => x.kind === s.kind && JSON.stringify(x) === JSON.stringify(s));
  }

  select(s: Sel | null, toggle = false) {
    if (!s) {
      if (!toggle) this.selection = [];
    } else if (toggle) {
      this.selection = this.isSelected(s)
        ? this.selection.filter((x) => JSON.stringify(x) !== JSON.stringify(s))
        : [...this.selection, s];
    } else {
      this.selection = [s];
    }
    this.changed();
  }

  selectAll() {
    const g = this.active;
    this.selection = [
      ...[...g.mesh.faces.keys()].map((id): Sel => ({ kind: 'face', id })),
      ...[...g.mesh.edges.keys()].map((key): Sel => ({ kind: 'edge', key })),
      ...g.children.map((c): Sel => ({ kind: 'group', id: c.id })),
    ];
    this.changed();
  }

  deleteSelection() {
    if (!this.selection.length) return;
    const sel = this.selection;
    this.commit(() => {
      const g = this.active;
      for (const s of sel) {
        if (s.kind === 'face') g.mesh.deleteFace(s.id);
        if (s.kind === 'group') g.children = g.children.filter((c) => c.id !== s.id);
      }
      for (const s of sel) {
        const e = s.kind === 'edge' && g.mesh.edges.get(s.key);
        if (e) g.mesh.eraseEdge(e[0], e[1]);
      }
      const guides = new Set(sel.flatMap((s) => (s.kind === 'guide' ? [s.i] : [])));
      g.guides = g.guides.filter((_, i) => !guides.has(i));
    });
    this.selection = [];
    this.changed();
  }

  deleteGuides() {
    if (!this.active.guides.length) return;
    this.commit(() => { this.active.guides = []; });
  }

  makeGroup(component = false) {
    if (!this.selection.length) return;
    const sel = this.selection;
    const g = this.active;
    this.commit(() => {
      const faces = sel.flatMap((s) => (s.kind === 'face' ? [s.id] : []));
      const edges = sel.flatMap((s) => (s.kind === 'edge' ? [s.key] : []));
      const kids = sel.flatMap((s) => (s.kind === 'group' ? [s.id] : []));
      const n = g.children.length + 1;
      const child = newGroup(`${component ? 'Component' : 'Group'} ${n}`, faces.length || edges.length ? g.mesh.extract(faces, edges) : new Mesh());
      child.children = g.children.filter((c) => kids.includes(c.id));
      if (component) makeComponent(child);
      g.children = [...g.children.filter((c) => !kids.includes(c.id)), child];
      this.selection = [{ kind: 'group', id: child.id }];
    });
  }

  /** Selected child groups of the active group. */
  selectedGroups() {
    return this.active.children.filter((c) => this.selection.some((s) => s.kind === 'group' && s.id === c.id));
  }

  makeUnique() {
    const gs = this.selectedGroups().filter((g) => g.def);
    if (gs.length) this.commit(() => gs.forEach(makeUnique));
  }

  explode() {
    const gs = this.selectedGroups();
    if (!gs.length) return;
    this.commit(() => {
      this.selection = gs.flatMap((g) => {
        const out = explode(this.active, g);
        return [
          ...out.faces.map((id): Sel => ({ kind: 'face', id })),
          ...out.edges.map((key): Sel => ({ kind: 'edge', key })),
          ...out.groups.map((id): Sel => ({ kind: 'group', id })),
        ];
      });
    });
  }

  renameDef(id: string, name: string) {
    const def = findGroup(this.root, id)?.group.def;
    if (!def || !name.trim()) return;
    this.commit(() => { def.name = name.trim(); });
  }

  rename(id: string, name: string) {
    const found = findGroup(this.root, id);
    if (!found || !name.trim()) return;
    this.commit(() => { found.group.name = name.trim(); });
  }

  toggleHidden(id: string) {
    const found = findGroup(this.root, id);
    if (!found) return;
    this.commit(() => { found.group.hidden = !found.group.hidden; });
  }

  /** Add STL files as groups. `toMm` converts file units to mm. */
  importStl(files: { name: string; tris: Float32Array }[], toMm: number) {
    const g = this.active;
    const place = invert(this.activeXform);
    this.tool.cancel();
    this.commit(() => {
      for (const f of files) {
        const base = f.name.replace(/\.stl$/i, '');
        const meshes = meshesFromTriangles(f.tris, toMm);
        const group = newGroup(base, meshes.length === 1 ? meshes[0] : undefined);
        if (meshes.length > 1) group.children = meshes.map((m, i) => newGroup(`${base} ${i + 1}`, m));
        group.rot = place.r;
        group.offset = place.t;
        g.children.push(group);
        this.selection = [{ kind: 'group', id: group.id }];
      }
    });
    this.vp.zoomExtents();
    this.flash(`Imported ${files.map((f) => f.name).join(', ')}`);
  }

  // --- files ---------------------------------------------------------------

  private data() {
    return JSON.stringify(serialize(this.root, this.units));
  }

  private loadData(data: unknown) {
    const { root, units } = deserialize(data);
    this.root = root;
    this.units = units;
    this.path = [root];
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
  }

  private autosave() {
    if (!this.autosaveDirty) return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, this.data());
      this.autosaveDirty = false;
    } catch {
      // Storage full or blocked; the next save to disk still works.
    }
  }

  newModel() {
    if (this.dirty && !confirm('Discard unsaved changes?')) return;
    this.tool.cancel();
    this.loadData(serialize(newGroup('Model'), this.units));
    this.handle = null;
    this.fileName = 'Untitled.rplan';
    this.dirty = false;
    this.autosaveDirty = true;
    this.changed();
  }

  async save(saveAs = false) {
    const w = window as PickerWindow;
    const text = this.data();
    try {
      if (w.showSaveFilePicker) {
        if (saveAs || !this.handle) {
          this.handle = await w.showSaveFilePicker({ suggestedName: this.fileName, types: PICKER_TYPES });
        }
        const s = await this.handle.createWritable();
        await s.write(text);
        await s.close();
        this.fileName = this.handle.name;
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        a.download = this.fileName;
        a.click();
        URL.revokeObjectURL(a.href);
      }
      this.dirty = false;
      this.flash(`Saved ${this.fileName}`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.flash(`Save failed: ${(e as Error).message}`);
    }
  }

  async open() {
    if (this.dirty && !confirm('Discard unsaved changes?')) return;
    const w = window as PickerWindow;
    try {
      let file: File;
      if (w.showOpenFilePicker) {
        const [h] = await w.showOpenFilePicker({ types: PICKER_TYPES });
        file = await h.getFile();
        this.handle = h;
      } else {
        file = await new Promise<File>((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.rplan,application/json';
          input.onchange = () => (input.files?.[0] ? resolve(input.files[0]) : reject(new Error('No file')));
          input.click();
        });
        this.handle = null;
      }
      this.tool.cancel();
      this.loadData(JSON.parse(await file.text()));
      this.fileName = file.name;
      this.dirty = false;
      this.autosaveDirty = true;
      this.vp?.zoomExtents();
      this.changed();
      this.flash(`Opened ${file.name}`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') this.flash(`Open failed: ${(e as Error).message}`);
    }
  }

  flash(msg: string) {
    this.message = msg;
    this.emit();
    setTimeout(() => {
      if (this.message === msg) {
        this.message = '';
        this.emit();
      }
    }, 3000);
  }

  // --- keyboard ------------------------------------------------------------

  onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'Alt' || e.key === 'Control') {
      e.preventDefault();
      if (!e.repeat) {
        this.modTap = true;
        this.tool.onModifier(true);
      }
      return;
    }
    this.modTap = false;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();

    if (mod) {
      const run = (fn: () => void) => { e.preventDefault(); fn(); };
      if (k === 'z' && e.shiftKey) return run(() => this.redo());
      if (k === 'z' || k === 'y') return run(() => (k === 'y' ? this.redo() : this.undo()));
      if (k === 's') return run(() => this.save(e.shiftKey));
      if (k === 'o') return run(() => this.open());
      if (k === 'a') return run(() => this.selectAll());
      return;
    }

    if (e.key === 'Shift') {
      const dir = this.lastAxis !== null ? AXES[this.lastAxis] : this.inf.lastDir;
      if (!this.shiftLock && dir) {
        this.shiftLock = dir;
        this.tool.refresh();
      }
      return;
    }

    // Measurements box: digits start an entry, then only measurement characters go in until
    // Enter. Any other letter abandons the entry and runs its shortcut (so G still groups).
    if (this.vcbText ? VCB_CHARS.test(e.key) : VCB_START.test(e.key)) {
      e.preventDefault();
      this.vcbText += e.key;
      this.emit();
      return;
    }
    if (this.vcbText && e.key.length === 1) {
      this.vcbText = '';
      this.emit();
    }
    if (e.key === 'Backspace' && this.vcbText) {
      this.vcbText = this.vcbText.slice(0, -1);
      this.emit();
      return;
    }
    if (e.key === 'Enter') {
      if (this.vcbText) {
        const text = this.vcbText;
        this.vcbText = '';
        if (this.retype(text) || this.tool.onVcb(text)) this.measure = text;
        else this.flash(`Can't use "${text}" here`);
        this.emit();
      }
      return;
    }

    const arrows: Record<string, number> = { ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2 };
    if (e.key in arrows || e.key === 'ArrowDown') {
      e.preventDefault();
      // Down locks to the current parallel/perpendicular inference or the remembered edge.
      const edgeLocked = this.axisLock && !AXES.includes(this.axisLock);
      const ax = e.key === 'ArrowDown' ? (edgeLocked ? null : this.inf.lastDir ?? refDir(this.inf)) : AXES[arrows[e.key]];
      this.axisLock = ax && this.axisLock !== ax ? ax : null;
      this.tool.refresh();
      return;
    }

    if (e.key === 'Escape') {
      this.inf = newInference();
      this.axisLock = null;
      if (this.vcbText) this.vcbText = '';
      else if (this.tool.busy()) this.tool.cancel();
      else if (this.selection.length) this.select(null);
      else this.exitContext();
      this.emit();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return this.deleteSelection();
    if (k === 'g') return this.makeGroup(e.shiftKey);
    if (k === 'z') return this.vp.zoomExtents();
    if (TOOL_KEYS[k]) {
      e.preventDefault();
      this.setTool(TOOL_KEYS[k]);
    }
  };

  onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Alt' || e.key === 'Control') {
      this.tool.onModifier(false, this.modTap);
      this.modTap = false;
    }
    if (e.key === 'Shift' && this.shiftLock) {
      this.shiftLock = null;
      this.tool.refresh();
    }
  };

  /** All groups with their ancestor chain, for panels. */
  groups() {
    return [...walk(this.root)];
  }
}
