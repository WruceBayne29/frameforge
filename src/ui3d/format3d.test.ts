import { describe, expect, it } from 'vitest';
import {
  equilibriumError,
  fieldInfo,
  fieldTitle,
  idList,
  legendTicks,
  loadSummary3D,
  loadValueText,
  parseIdList,
  restraintLabel,
  slug,
} from './format3d';

describe('format3d', () => {
  it('describes supports', () => {
    expect(restraintLabel([true, true, true, true, true, true])).toBe('Fixed');
    expect(restraintLabel([true, true, true, false, false, false])).toBe('Pinned');
    expect(restraintLabel([false, true, false, false, false, false])).toBe('Roller');
    expect(restraintLabel([true, false, false, false, false, true])).toBe('ux rz');
    expect(restraintLabel([false, false, false, false, false, false])).toBe('Free');
  });

  it('formats loads', () => {
    expect(
      loadValueText({
        id: 'L1',
        kind: 'distributed',
        members: ['M1'],
        direction: 'globalY',
        w1: -5,
      }),
    ).toBe('-5.00 kN/m Y');
    expect(
      loadValueText({
        id: 'L1',
        kind: 'distributed',
        members: ['M1'],
        direction: 'localZ',
        w1: 1,
        w2: 2,
      }),
    ).toBe('1.00 → 2.00 kN/m z');
    expect(
      loadValueText({
        id: 'L1',
        kind: 'nodal',
        nodes: ['N1'],
        fx: 3,
        fy: 4,
        fz: 0,
        mx: 0,
        my: 0,
        mz: 2,
      }),
    ).toBe('5.00 kN + 2.00 kN·m');
    expect(
      loadSummary3D({ id: 'L', kind: 'face', solids: [], face: 1, direction: 'normal', p: 1 }),
    ).toBe('Solid face load');
  });

  it('formats contour legends', () => {
    expect(fieldInfo('displacement').unit).toBe('mm');
    expect(fieldTitle('plateVonMisesTop')).toBe('Plates · von Mises, top (MPa)');
    expect(fieldTitle('displacement')).toBe('Displacement (mm)');
    expect(legendTicks(0, 0.004, 1000, 3)).toEqual(['4.00', '2.00', '0']);
  });

  it('parses and prints id lists', () => {
    const known = new Set(['N1', 'N2', 'N3']);
    expect(parseIdList('N1, N3;N9 N1', known)).toEqual(['N1', 'N3']);
    expect(idList(['a', 'b', 'c', 'd', 'e'], 2)).toBe('a, b … (5)');
    expect(slug('My Frame #2')).toBe('my-frame-2');
    expect(slug('***')).toBe('frameforge-3d');
  });

  it('measures the equilibrium error', () => {
    expect(
      equilibriumError({ appliedLoad: [0, -100, 0], equilibrium: [0, 1e-6, 0, 0, 0, 0] }),
    ).toBeCloseTo(1e-8);
  });
});
