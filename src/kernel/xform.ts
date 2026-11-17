import { type V3, add, cross, dot, norm, scale, sub } from './vec';

/** 3×3 linear map, row-major: a rotation, possibly with scale or mirror. */
export type M3 = number[];

/** Affine transform: apply r, then translate by t. */
export interface Xform {
  r: M3;
  t: V3;
}

export const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const IDENTITY: Xform = { r: I3, t: [0, 0, 0] };

export const mulMV = (r: M3, v: V3): V3 => [
  r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
  r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
  r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
];

const mulMM = (a: M3, b: M3): M3 => {
  const out: M3 = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return tidy(out);
};

const transpose = (r: M3): M3 => [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];

/** Snap entries within float noise of 0 or ±1, so 90° turns stay exact. */
const tidy = (r: M3): M3 => r.map((x) => (Math.abs(x) < 1e-12 ? 0 : Math.abs(Math.abs(x) - 1) < 1e-12 ? Math.sign(x) : x));

export const apply = (x: Xform, p: V3): V3 => add(mulMV(x.r, p), x.t);
export const applyDir = (x: Xform, v: V3): V3 => mulMV(x.r, v);

/** a ∘ b: apply b first, then a. */
export const compose = (a: Xform, b: Xform): Xform => ({ r: mulMM(a.r, b.r), t: add(mulMV(a.r, b.t), a.t) });

export const det = (m: M3) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

const inverse = (m: M3): M3 => {
  const d = det(m);
  return tidy([
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ].map((x) => x / d));
};

export const invert = (x: Xform): Xform => {
  const ri = inverse(x.r);
  return { r: ri, t: scale(mulMV(ri, x.t), -1) };
};

/** Transform a surface normal: inverse-transpose, renormalised, so it stays perpendicular under scale. */
export const applyNormal = (x: Xform, n: V3): V3 => norm(mulMV(transpose(inverse(x.r)), n));

/** Scale by per-axis factors f about pivot. Negative factors mirror. */
export function scaling(pivot: V3, f: V3): Xform {
  const r = [f[0], 0, 0, 0, f[1], 0, 0, 0, f[2]];
  return { r, t: sub(pivot, mulMV(r, pivot)) };
}

export const translation = (t: V3): Xform => ({ r: I3, t });

/** Rotation by angle (radians) about an axis through pivot. */
export function rotation(pivot: V3, axis: V3, angle: number): Xform {
  const [x, y, z] = norm(axis);
  const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
  const r = tidy([
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ]);
  return { r, t: sub(pivot, mulMV(r, pivot)) };
}

/** Signed angle from a to b about normal n, in radians. */
export const signedAngle = (a: V3, b: V3, n: V3) => Math.atan2(dot(cross(a, b), n), dot(a, b));
