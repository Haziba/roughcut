# Roughcut — Spec

A local, browser-based 3D modeller for room planning and woodworking design: sticky edges and
faces, Push/Pull, inference snapping and typed measurements, with its own look. Runs on your machine; no hosted server, no account.

## Platform

- Local browser app: Vite + TypeScript + three.js (viewport) + React (panels).
- Run with `npm run dev`. No hosting. The only backend is the local dev server, which runs the
  optional assistant and AI props (`assistant-bridge.ts`).
- Target Chrome-family browsers. Save uses the File System Access API (Cmd+S writes back to the
  same file). Other browsers fall back to downloading a copy.
- Autosave to browser storage every few seconds so a crash never loses work.

## Geometry model

- "Sticky" edges and faces:
  - Lines are edges between vertices. When edges close a coplanar loop, a face fills in.
  - Drawing over an existing face splits it.
  - Loose geometry sticks together; grouping isolates it.
- Push/Pull extrudes a face along its normal, creating side faces.
- Pushing a face exactly onto the opposite face of a solid cuts a through-hole (or a slot when the
  shape touches an edge); hovering the far edges snaps the depth.
- All lengths stored internally in millimetres.
- Geometry kernel is plain TypeScript, independent of three.js, with unit tests (Vitest).

## Hierarchy

- **Groups**: nested containers that isolate geometry. Double-click to edit inside.
- **Components** (M2): reusable definitions; editing one updates every instance. Make Unique
  gives an instance its own copy. Explode dissolves a group or instance into its parent.
- **Tags** (M2, planned, not built yet): visibility toggles across the hierarchy.
- **Outliner**: tree panel of the whole model; select, rename, hide.

## Drawing and input

- Inference snapping: red/green/blue axes, endpoints, midpoints, on-edge, on-face, parallel/
  perpendicular where practical.
  - Parallel/perpendicular: hover an edge briefly to remember it; drawing then snaps parallel or
    perpendicular to it (magenta). Down arrow locks to that direction.
  - Point tracking: hover an endpoint/midpoint ~0.3s to track it (up to 3, cleared on tool
    change/Esc); drawing snaps where it lines up with a tracked point along an axis ("From point").
- Guides (Tape): click an edge or guide then click/type a distance for a parallel guide line;
  click a point then click/type for a guide point. Alt-click only measures. Guides snap (on guide,
  intersections, guide points), are selectable/erasable, hide with their group; "Delete Guides"
  clears the current context's guides.
- Select: drag left→right for a window box (wholly inside), right→left for a crossing box
  (touching). Shift toggles.
- Measurements box: once typing, only measurement characters (digits, units, `. , ; ' " / - * x s`,
  space) go in; any other letter abandons the entry and runs its shortcut.
- Typed measurements (measurements box): after starting a tool, type a value and press Enter.
  - Line: `600`; Rectangle: `600,400`; Push/Pull: `18`; Move: `250`.
  - Arc: chord `600`, then bulge `150`; Circle/Polygon: radius `300`; Offset: `20`. `24s` sets
    segments/sides on Arc, Circle and Polygon.
  - Scale: `1.5`, `2,1,1`, `-1` (mirror), or a new size `600mm`.
  - Retype: right after finishing (before another click, commit, undo or tool change), typing a
    value redoes the last operation with it, as one undo step (Line: the segment just drawn, until
    the mouse moves away; `24s`/`12s` re-segments a just-drawn circle/polygon/arc).
- Move/Rotate: tap Option/Alt (or Ctrl) to copy. Then `x5`/`5x`/`*5` = array of 5,
  `/5` = 5 dividing the distance, or a new distance/angle adjusts the copy.
- Axis locks: arrow keys (Right = red/X, Left = green/Y, Up = blue/Z, Down = parallel/
  perpendicular). Hold Shift to lock the current inference.
- Unlimited undo/redo in-session (Cmd+Z / Cmd+Shift+Z). History is not saved to the file.

## Shortcuts

Single-key shortcuts (rebinding planned, not built yet):

| Key   | Tool          |
|-------|---------------|
| Space | Select        |
| L     | Line          |
| R     | Rectangle     |
| A     | Arc           |
| C     | Circle        |
| F     | Offset        |
| P     | Push/Pull     |
| M     | Move          |
| Q     | Rotate        |
| S     | Scale         |
| O     | Orbit         |
| H     | Pan           |
| Z     | Zoom extents  |
| T     | Tape measure  |
| D     | Dimension     |
| B     | Paint bucket  |
| G     | Make group    |
| Shift+G | Make component |
| E     | Eraser        |

## Navigation

- Trackpad first:
  - Two-finger drag = orbit
  - Shift + two-finger drag = pan
  - Pinch = zoom toward cursor
  - Hold O + drag = orbit (always available)
  - Setting to swap orbit/pan
- Mouse: middle-drag orbit, Shift+middle-drag pan, scroll = zoom toward cursor.

## Units

- Toggle between metric and imperial.
- Metric display in mm.
- Imperial display as feet-and-inches to 1/16" (e.g. `1' 11 5/8"`).
- Input accepts any of: `600`, `600mm`, `60cm`, `23 5/8`, `23 5/8"`, `1'11 5/8"`, `23.625"`.

## Files

- Native format: JSON (`.rplan`).
- Export (planned, not built yet): COLLADA `.dae` (M2) so models can go into other 3D apps. glTF/STL export later.
- Import: STL (M2), the format most free 3D modellers export.
  - Ask for units on import.
  - Merge coplanar adjacent triangles back into faces with edges, so Push/Pull works again.
  - Each connected chunk becomes its own group.
  - Multi-file import: each file becomes a group named after its filename.
  - Colours are lost in STL; repaint after import.
- No `.skp` parsing (closed format, licence terms). No reverse-engineering.

## Materials

- M1: solid colour fill per face (Paint bucket).
- M2 textures (planned, not built yet):
  - User images with real-world size (e.g. "this image = 300mm wide").
  - Bundled starter pack: CC0 only (oak, walnut, birch ply, MDF, paint).
  - Per-face grain direction, rotatable.

## Assistant

- Chat panel (top bar "Assistant") for asking about the model and having things placed.
- Runs through the user's local Claude Code CLI in headless mode (`claude -p`) via a Vite dev-server
  endpoint, so it uses their own Claude login through the official client. No API key. Claude gets
  no tools; it only sees a text summary of the model.
- Replies may end with an `actions` JSON block (box, move, rotate, resize, copy, rename, paint,
  hide, group, delete, select); the app applies it as one undo step.
- Chat log and session are kept in browser storage; "New chat" starts over.
- It can also draw flat rectangles (loose geometry) and upright cylinders.

## AI props

- The assistant's `generate` action makes a 3D stand-in model from a description, on this machine,
  with AssetFurnace (`~/image-to-3dlab`, or `$ASSETFURNACE`): Qwen-Image 2.1 picture → Pixal3D
  model → retopologised to ~4k faces with 512px textures (`tools/make_prop.py`). Hunyuan3D is
  never used (its licence excludes the UK). About 10 minutes each (up to 30 for big boxy things), one at a time.
- A placeholder box of the requested size appears at once (a group with a `prop` tag); when the
  model is ready it is stretched to fill the box exactly, turned a quarter if that fits better. The box stays
  invisible but pickable, so the prop moves, rotates, scales and copies like any group.
- Files live in `props/<id>/` (git-ignored): source picture, finished GLB, AssetFurnace
  provenance, log. The dev server queues jobs and serves `/api/props/<id>` (status) and
  `/api/props/<id>/model.glb`.
- Props are stand-ins for looks and space, not editable geometry.

## Look

Own visual identity: no other app's icons, styling, or branding.

## Milestones

### M1
Grid, orbit/pan/zoom, Line, Rectangle, Arc, Circle, Polygon, Freehand, Offset, inference snapping, typed measurements, axis locks,
Push/Pull, Select (double-click = whole connected object), Move, Rotate, Scale, Flip, copy/arrays, Eraser, Groups, Outliner, colour fill, tape measure, dimensions,
mm/imperial toggle, save/load, autosave, undo/redo.

### M2
Components (Make Component, Make Unique, Explode), Tags, textures, STL import, `.dae` export.

### v2
Cut list (generated from components), more woodworking tools.
