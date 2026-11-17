import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Editor } from '../app/editor';
import { type ToolName, flipSelection } from '../app/tools';
import { STAGE_LABEL, props } from '../app/props';
import { Viewport } from '../app/viewport';
import type { Group } from '../kernel/model';
import { bounds, parseStl } from '../kernel/stl';
import { Chat } from './Chat';

const STL_UNITS: [string, number][] = [['mm', 1], ['cm', 10], ['m', 1000], ['inches', 25.4], ['feet', 304.8]];
type PendingStl = { name: string; tris: Float32Array }[];

/** Ask which units the STL was exported in, showing the size each choice would give. */
function StlUnitsDialog({ files, onClose }: { files: PendingStl; onClose: () => void }) {
  const all = new Float32Array(files.reduce((n, f) => n + f.tris.length, 0));
  files.reduce((o, f) => (all.set(f.tris, o), o + f.tris.length), 0);
  const [lo, hi] = bounds(all);
  const size = hi.map((h, i) => h - lo[i]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} data-testid="stl-units">
        <h3>Import {files.map((f) => f.name).join(', ')}</h3>
        <p>STL files don't record units. Which units was it exported in?</p>
        {STL_UNITS.map(([label, mm]) => (
          <button key={label} data-testid={`stl-unit-${label}`} onClick={() => { editor.importStl(files, mm); onClose(); }}>
            <b>{label}</b>
            <span>{size.map((s) => editor.fmt(s * mm)).join(' × ')}</span>
          </button>
        ))}
        <button className="cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

const editor = new Editor();
props.onChange = () => editor.changed();

const ICONS: Record<ToolName, string> = {
  select: 'M6 3l12 9-5.5 1 3 6.5-2.5 1-3-6.5L6 18z',
  line: 'M5 19L19 5M5 19h.01M19 5h.01',
  rect: 'M5 6h14v12H5z',
  pushpull: 'M5 12h10v7H5zM15 12l4-4M5 12l4-4h10v7l-4 4M12 9V3m-2.5 2.5L12 3l2.5 2.5',
  rotate: 'M3 18h18M5 18a7 7 0 0 1 14 0M12 18l5-6',
  move: 'M12 3v18M3 12h18M12 3l-3 3m3-3l3 3m-3 15l-3-3m3 3l3-3M3 12l3-3m-3 3l3 3m15-3l-3-3m3 3l-3 3',
  orbit: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  pan: 'M8 13V6a1.5 1.5 0 0 1 3 0v6m0-7a1.5 1.5 0 0 1 3 0v7m0-6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-3-4a1.5 1.5 0 0 1 2.3-2L8 15',
  tape: 'M3 9h18v6H3zM7 9v3m4-3v3m4-3v3m4-3v3',
  dim: 'M4 6v12M20 6v12M4 12h16M4 12l3-3m-3 3l3 3m13-3l-3-3m3 3l-3 3',
  paint: 'M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z',
  eraser: 'M8 20h12M4 15l9-9 6 6-8 8H8z M8 11l6 6',
  arc: 'M4 18a8 8 0 0 1 16 0M4 18h.01M20 18h.01',
  circle: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 12h.01',
  polygon: 'M12 4l7 4v8l-7 4-7-4V8z',
  freehand: 'M4 17c3-6 5 2 8-3s4-7 8-4',
  offset: 'M3 5h18v14H3zM7 9h10v6H7z',
  scale: 'M4 10V4h6M4 4l7 7M4 14v6h16V4h-6M20 4l-5 5',
};

const TOOLS: [ToolName, string, string][] = [
  ['select', 'Select', 'Space'],
  ['line', 'Line', 'L'],
  ['rect', 'Rectangle', 'R'],
  ['arc', 'Arc', 'A'],
  ['circle', 'Circle', 'C'],
  ['polygon', 'Polygon', ''],
  ['freehand', 'Freehand', ''],
  ['pushpull', 'Push/Pull', 'P'],
  ['offset', 'Offset', 'F'],
  ['move', 'Move', 'M'],
  ['rotate', 'Rotate', 'Q'],
  ['scale', 'Scale', 'S'],
  ['eraser', 'Eraser', 'E'],
  ['paint', 'Paint', 'B'],
  ['tape', 'Tape Measure', 'T'],
  ['dim', 'Dimension', 'D'],
  ['orbit', 'Orbit', 'O'],
  ['pan', 'Pan', 'H'],
];

const SWATCHES = ['#c8a27a', '#8b5a2b', '#5c3a21', '#e8d8b8', '#d9c7a3', '#f4f1ea', '#9aa5b1', '#3d4752', '#6b8f71', '#b5523b'];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** Generation progress of an AI prop, for the outliner. */
function PropBadge({ id }: { id: string }) {
  const s = props.status.get(id);
  if (!s || s.stage === 'done') return <span className="prop-badge" title="AI model">✦</span>;
  const label = s.stage === 'error' ? `failed: ${s.error ?? ''}` : `${STAGE_LABEL[s.stage]}${s.ahead ? ` (${s.ahead} ahead)` : ''}…`;
  return <span className={`prop-badge ${s.stage === 'error' ? 'err' : 'busy'}`} title={label}>{s.stage === 'error' ? ' ⚠' : ' ⏳'}</span>;
}

function OutlinerNode({ g, depth, parents = [] }: { g: Group; depth: number; parents?: Group[] }) {
  const [editing, setEditing] = useState<false | 'name' | 'def'>(false);
  const done = (v: string) => {
    if (editing === 'def') editor.renameDef(g.id, v);
    else editor.rename(g.id, v);
    setEditing(false);
  };
  const isActive = editor.active.id === g.id;
  const selected = editor.selection.some((s) => s.kind === 'group' && s.id === g.id);
  return (
    <>
      <div
        className={`node${selected ? ' selected' : ''}${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-testid={`outliner-${g.id}`}
        onClick={() => editor.focusGroup(g.id, parents)}
        onDoubleClick={() => (depth ? setEditing('name') : undefined)}
      >
        <span className="caret">{g.children.length ? '▾' : '·'}</span>
        {g.def && <span className="caret" title="Component instance" data-testid={`instance-${g.id}`}>◆</span>}
        {editing ? (
          <input
            autoFocus
            defaultValue={editing === 'def' ? g.def?.name : g.name}
            onBlur={(e) => done(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span className="name">
            {g.name}
            {g.prop && <PropBadge id={g.prop.id} />}
            {g.def && (
              <span
                className="def"
                title="Component definition (double-click to rename for all)"
                onDoubleClick={(e) => { e.stopPropagation(); setEditing('def'); }}
              >
                {` <${g.def.name}>`}
              </span>
            )}
          </span>
        )}
        {depth > 0 && (
          <button
            className={`eye${g.hidden ? ' off' : ''}`}
            title={g.hidden ? 'Show' : 'Hide'}
            onClick={(e) => { e.stopPropagation(); editor.toggleHidden(g.id); }}
          >
            {g.hidden ? '◌' : '●'}
          </button>
        )}
        {depth > 0 && (
          <button className="enter" title="Edit inside" onClick={(e) => { e.stopPropagation(); editor.enter(g.id, parents); }}>
            ↘
          </button>
        )}
      </div>
      {g.children.map((c) => <OutlinerNode key={c.id} g={c} depth={depth + 1} parents={[...parents, g]} />)}
    </>
  );
}

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const stlInput = useRef<HTMLInputElement>(null);
  const [pendingStl, setPendingStl] = useState<PendingStl | null>(null);
  const [chatOpen, setChatOpen] = useState(() => {
    try { return localStorage.getItem('room-planner:chat-open') === '1'; } catch { return false; }
  });
  const toggleChat = () => {
    setChatOpen(!chatOpen);
    try { localStorage.setItem('room-planner:chat-open', chatOpen ? '0' : '1'); } catch { /* blocked storage */ }
  };

  const readStl = async (list: FileList | null) => {
    if (!list?.length) return;
    try {
      setPendingStl(await Promise.all([...list].map(async (f) => ({ name: f.name, tris: parseStl(await f.arrayBuffer()) }))));
    } catch (e) {
      editor.flash(`Import failed: ${(e as Error).message}`);
    }
  };
  useSyncExternalStore(editor.subscribe, editor.getVersion);

  useEffect(() => {
    if (editor.vp || !host.current) return;
    editor.vp = new Viewport(host.current, editor);
    editor.vp.zoomExtents();
    window.addEventListener('keydown', editor.onKeyDown);
    window.addEventListener('keyup', editor.onKeyUp);
    window.addEventListener('beforeunload', (e) => { if (editor.dirty) e.preventDefault(); });
  }, []);

  const sel = editor.selection;
  const selGroups = editor.selectedGroups();
  const selSummary = sel.length
    ? [
        ['face', 'face'], ['edge', 'edge'], ['group', 'group'], ['guide', 'guide'],
      ].map(([k, label]) => {
        const n = sel.filter((s) => s.kind === k).length;
        return n ? `${n} ${label}${n > 1 ? 's' : ''}` : '';
      }).filter(Boolean).join(', ')
    : 'Nothing selected';

  return (
    <div className={`app${chatOpen ? ' chat-open' : ''}`}>
      <header className="topbar">
        <div className="brand">Roughcut</div>
        <button onClick={() => editor.newModel()}>New</button>
        <button onClick={() => editor.open()} title="⌘O">Open</button>
        <button onClick={() => editor.save()} title="⌘S">Save</button>
        <button onClick={() => editor.save(true)} title="⇧⌘S">Save As</button>
        <button onClick={() => stlInput.current?.click()} data-testid="import-stl">Import STL…</button>
        <input
          ref={stlInput}
          type="file"
          accept=".stl"
          multiple
          hidden
          onChange={(e) => { readStl(e.target.files); e.target.value = ''; }}
        />
        <span className="sep" />
        <button onClick={() => editor.undo()} title="⌘Z">Undo</button>
        <button onClick={() => editor.redo()} title="⇧⌘Z">Redo</button>
        <span className="sep" />
        <button onClick={() => editor.makeGroup()} disabled={!sel.length} title="G">Make Group</button>
        <button onClick={() => editor.makeGroup(true)} disabled={!sel.length} title="⇧G" data-testid="make-component">Make Component</button>
        <button onClick={() => editor.makeUnique()} disabled={!selGroups.some((g) => g.def)} data-testid="make-unique">Make Unique</button>
        <button onClick={() => editor.explode()} disabled={!selGroups.length} data-testid="explode">Explode</button>
        {['Red', 'Green', 'Blue'].map((axis, i) => (
          <button key={axis} data-testid={`flip-${axis.toLowerCase()}`} onClick={() => flipSelection(editor, i)} disabled={!sel.length}>
            Flip {axis}
          </button>
        ))}
        <button onClick={() => editor.deleteGuides()} disabled={!editor.active.guides.length} data-testid="delete-guides">Delete Guides</button>
        <button onClick={() => editor.vp.zoomExtents()} title="Z">Zoom Extents</button>
        <button className={chatOpen ? 'on' : ''} onClick={toggleChat} data-testid="toggle-chat">Assistant</button>
        <span className="file">{editor.fileName}{editor.dirty ? ' •' : ''}</span>
      </header>

      <nav className="toolbar">
        {TOOLS.map(([name, label, key]) => (
          <button
            key={name}
            data-testid={`tool-${name}`}
            className={editor.toolName === name ? 'on' : ''}
            title={key ? `${label} (${key})` : label}
            onClick={() => editor.setTool(name)}
          >
            <Icon d={ICONS[name]} />
          </button>
        ))}
      </nav>

      <main className="viewport" ref={host} data-testid="viewport" />

      <aside className="panel">
        <section>
          <h3>Outliner</h3>
          <div className="outliner">
            <OutlinerNode g={editor.root} depth={0} />
          </div>
          {editor.path.length > 1 && (
            <button className="wide" onClick={() => editor.exitContext()}>Close group (Esc)</button>
          )}
        </section>
        <section>
          <h3>Paint</h3>
          <div className="swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                className={editor.color === c ? 'on' : ''}
                style={{ background: c }}
                title={c}
                onClick={() => { editor.color = c; editor.setTool('paint'); }}
              />
            ))}
            <label className="custom" title="Custom colour">
              <input
                type="color"
                value={editor.color}
                onChange={(e) => { editor.color = e.target.value; editor.setTool('paint'); }}
              />
            </label>
          </div>
        </section>
        <section>
          <h3>Settings</h3>
          <div className="seg">
            <button className={editor.units === 'metric' ? 'on' : ''} onClick={() => editor.setUnits('metric')}>mm</button>
            <button className={editor.units === 'imperial' ? 'on' : ''} onClick={() => editor.setUnits('imperial')}>ft / in</button>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={editor.swapOrbitPan}
              onChange={(e) => { editor.swapOrbitPan = e.target.checked; editor.emit(); }}
            />
            Two-finger drag pans (Shift orbits)
          </label>
        </section>
        <section className="sel">{selSummary}</section>
      </aside>
      {chatOpen && <Chat editor={editor} />}

      <footer className="status">
        <span className="hint">{editor.message || editor.hint}</span>
        {editor.lock && <span className="lock">Axis locked</span>}
        <span className="vcb" data-testid="vcb">
          <label>{editor.tool?.vcbLabel}</label>
          <span className={editor.vcbText ? 'typing' : ''}>{editor.vcbText || editor.measure || ' '}</span>
        </span>
      </footer>
      {pendingStl && <StlUnitsDialog files={pendingStl} onClose={() => setPendingStl(null)} />}
    </div>
  );
}
