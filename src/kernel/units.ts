export type Units = 'metric' | 'imperial';

const MM_PER_IN = 25.4;
const METRIC: Record<string, number> = { mm: 1, cm: 10, m: 1000 };

function parseInches(r: string): number | null {
  r = r.trim();
  if (!r) return 0;
  if (/^(\d+(\.\d+)?|\.\d+)$/.test(r)) return +r;
  const m = r.match(/^(?:(\d+)[\s-]+)?(\d+)\/(\d+)$/);
  if (!m || +m[3] === 0) return null;
  return (m[1] ? +m[1] : 0) + +m[2] / +m[3];
}

/**
 * Parse a typed length into mm. Bare numbers use the current units (mm or inches).
 * Accepts `600`, `600mm`, `60cm`, `1.2m`, `23 5/8`, `23 5/8"`, `1'11 5/8"`, `1'-6"`, `23.625"`.
 * Fractions always mean inches.
 */
export function parseLength(raw: string, units: Units): number | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  let sign = 1;
  if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1).trim();
  }
  const metric = s.match(/^(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|m)$/);
  if (metric) return sign * +metric[1] * METRIC[metric[2]];

  let feet = 0, rest = s, marked = false;
  const fi = s.search(/'|ft/);
  if (fi >= 0) {
    const f = s.slice(0, fi).trim();
    if (!/^\d+(\.\d+)?$/.test(f)) return null;
    feet = +f;
    rest = s.slice(fi).replace(/^('|ft)/, '');
    marked = true;
  }
  rest = rest.trim().replace(/^-/, '');
  if (rest.endsWith('"')) { rest = rest.slice(0, -1); marked = true; }
  else if (rest.endsWith('in')) { rest = rest.slice(0, -2); marked = true; }
  const inches = parseInches(rest);
  if (inches === null || (!marked && !rest.trim())) return null;
  if (!marked && units === 'metric' && !rest.includes('/')) return sign * inches;
  return sign * (feet * 12 + inches) * MM_PER_IN;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Format mm for display: `612.5 mm`, or feet-and-inches to the nearest 1/16" with `~` when rounded. */
export function formatLength(mm: number, units: Units): string {
  if (units === 'metric') return `${+mm.toFixed(1)} mm`;
  const sixteenths = Math.round((Math.abs(mm) / MM_PER_IN) * 16);
  const approx = Math.abs(sixteenths / 16 - Math.abs(mm) / MM_PER_IN) * MM_PER_IN > 0.01 ? '~ ' : '';
  const feet = Math.floor(sixteenths / 192);
  const rem = sixteenths - feet * 192;
  const whole = Math.floor(rem / 16);
  const frac = rem % 16;
  const g = frac ? gcd(frac, 16) : 1;
  const inches = frac ? `${whole ? `${whole} ` : ''}${frac / g}/${16 / g}"` : `${whole}"`;
  const sign = mm < 0 && sixteenths ? '-' : '';
  return `${approx}${sign}${feet ? `${feet}' ` : ''}${inches}`;
}
