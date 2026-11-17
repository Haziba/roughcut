import { type V3, dist, norm, sub } from '../kernel/vec';

/** Hover this long on an edge or point to remember it for parallel/perpendicular or tracking. */
const DWELL_MS = 300;
const MAX_TRACKED = 3;

/** Inference memory: the remembered edge and tracked points. Cleared on tool change and Esc. */
export interface Inference {
  refEdge: { a: V3; b: V3 } | null;
  tracked: V3[];
  /** Direction of the current parallel/perpendicular inference, for Shift and Down locks. */
  lastDir: V3 | null;
  hover: { key: string; since: number; done: boolean; promote: () => void } | null;
}

export const newInference = (): Inference => ({ refEdge: null, tracked: [], lastDir: null, hover: null });

export const refDir = (inf: Inference) => (inf.refEdge ? norm(sub(inf.refEdge.b, inf.refEdge.a)) : null);

/**
 * Note what the cursor is over. Something hovered for DWELL_MS is promoted: an edge becomes
 * the remembered edge, a point becomes tracked.
 * ponytail: dwell is checked on the next pointer move, so a perfectly still cursor shows the
 * marker only after a wiggle; add a timer if that feels laggy.
 */
export function noteHover(inf: Inference, over: { point: V3 } | { a: V3; b: V3 } | null, now = performance.now()) {
  const key = !over ? '' : 'point' in over ? `p${over.point}` : `e${over.a}${over.b}`;
  const h = inf.hover;
  if (h && !h.done && now - h.since >= DWELL_MS) {
    h.promote();
    h.done = true;
  }
  if (h?.key === key) return;
  inf.hover = !over ? null : {
    key, since: now, done: false,
    promote: 'point' in over
      ? () => {
        if (inf.tracked.some((t) => dist(t, over.point) < 1e-6)) return;
        inf.tracked = [...inf.tracked, over.point].slice(-MAX_TRACKED);
      }
      : () => { inf.refEdge = { a: over.a, b: over.b }; },
  };
}
