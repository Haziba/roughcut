import { describe, expect, it } from 'vitest';
import { formatLength, parseLength } from './units';

describe('parseLength', () => {
  it.each([
    ['600', 'metric', 600],
    ['600mm', 'metric', 600],
    ['60 cm', 'metric', 600],
    ['1.2m', 'metric', 1200],
    ['-18', 'metric', -18],
    ['23 5/8', 'metric', 600.075],
    ['23.625"', 'metric', 600.075],
    ['23 5/8"', 'imperial', 600.075],
    ['1\'11 5/8"', 'imperial', 600.075],
    ['1\'-6"', 'imperial', 457.2],
    ['2\'', 'imperial', 609.6],
    ['3/4', 'imperial', 19.05],
    ['12', 'imperial', 304.8],
    ['600mm', 'imperial', 600],
  ] as const)('%s (%s) → %f mm', (s, u, mm) => {
    expect(parseLength(s, u)).toBeCloseTo(mm, 3);
  });

  it.each(['', 'abc', '1/0', "x'"])('rejects %s', (s) => {
    expect(parseLength(s, 'metric')).toBeNull();
  });
});

describe('formatLength', () => {
  it('formats metric', () => expect(formatLength(612.54, 'metric')).toBe('612.5 mm'));
  it('formats feet and inches', () => expect(formatLength(600.075, 'imperial')).toBe('1\' 11 5/8"'));
  it('marks rounded values', () => expect(formatLength(600, 'imperial')).toBe('~ 1\' 11 5/8"'));
  it('formats under a foot', () => expect(formatLength(19.05, 'imperial')).toBe('3/4"'));
  it('formats whole feet', () => expect(formatLength(609.6, 'imperial')).toBe('2\' 0"'));
});
