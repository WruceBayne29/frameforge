import { describe, expect, it } from 'vitest';
import { SECTIONS, getSection, sectionsByFamily } from './sections';
import type { SteelSection } from './sections';

/** |actual − expected| / expected */
function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

/**
 * Idealised geometry: two rectangular flanges bf × tf plus a web (D − 2tf) × tw. The same
 * expressions hold for I-sections and channels about the major axis. Fillets and the flange
 * taper are ignored, so the handbook values sit a few percent above these.
 */
function idealised(s: SteelSection) {
  const hw = s.D - 2 * s.tf;
  const A = (2 * s.bf * s.tf + hw * s.tw) / 100; // cm²
  const Izz = (s.bf * s.D ** 3 - (s.bf - s.tw) * hw ** 3) / 12 / 1e4; // cm⁴
  const Zpz = (s.bf * s.tf * (s.D - s.tf) + (s.tw * hw ** 2) / 4) / 1e3; // cm³
  return { A, Izz, Zpz };
}

describe('section table contents', () => {
  it('contains the 14 ISMB and 11 ISMC sections', () => {
    expect(sectionsByFamily('ISMB').map((s) => s.D)).toEqual([
      100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500, 550, 600,
    ]);
    expect(sectionsByFamily('ISMC').map((s) => s.D)).toEqual([
      75, 100, 125, 150, 175, 200, 225, 250, 300, 350, 400,
    ]);
    expect(SECTIONS).toHaveLength(25);
  });

  it('has unique designations of the form "<family> <depth>"', () => {
    const names = SECTIONS.map((s) => s.designation);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SECTIONS) expect(s.designation).toBe(`${s.family} ${s.D}`);
  });

  it('matches the published handbook values for spot-checked sections', () => {
    expect(getSection('ISMB 300')).toMatchObject({
      mass: 44.2,
      A: 56.26,
      D: 300,
      bf: 140,
      tf: 12.4,
      tw: 7.5,
      Izz: 8603.6,
      Iyy: 453.9,
      rzz: 12.37,
      ryy: 2.84,
      Zez: 573.6,
    });
    expect(getSection('ISMB 300')?.Zpz).toBeCloseTo(651.7, 1);
    expect(getSection('ISMB 200')).toMatchObject({
      mass: 25.4,
      A: 32.33,
      bf: 100,
      tf: 10.8,
      tw: 5.7,
      Izz: 2235.4,
      Iyy: 150,
    });
    expect(getSection('ISMC 200')).toMatchObject({
      mass: 22.1,
      A: 28.21,
      bf: 75,
      tf: 11.4,
      tw: 6.1,
      Izz: 1819.3,
      Iyy: 140.4,
    });
  });

  it('is frozen so callers cannot corrupt the shared table', () => {
    expect(Object.isFrozen(SECTIONS)).toBe(true);
    expect(SECTIONS.every((s) => Object.isFrozen(s))).toBe(true);
  });
});

describe('lookup helpers', () => {
  it('getSection is case- and whitespace-insensitive', () => {
    const ref = getSection('ISMB 300');
    expect(ref).toBeDefined();
    expect(getSection('ismb300')).toBe(ref);
    expect(getSection('  IsMb   300 ')).toBe(ref);
  });

  it('getSection returns undefined for unknown designations', () => {
    expect(getSection('ISMB 301')).toBeUndefined();
    expect(getSection('')).toBeUndefined();
  });

  it('sectionsByFamily returns a fresh array of only that family', () => {
    const a = sectionsByFamily('ISMC');
    expect(a.every((s) => s.family === 'ISMC')).toBe(true);
    a.pop();
    expect(sectionsByFamily('ISMC')).toHaveLength(11);
  });
});

describe.each(SECTIONS.map((s) => [s.designation, s] as const))(
  'internal consistency — %s',
  (_name, s) => {
    const ideal = idealised(s);

    it('(a) area within 6% of 2·bf·tf + (D − 2tf)·tw', () => {
      expect(relErr(s.A, ideal.A)).toBeLessThan(0.06);
    });

    it('(b) Izz within 8% of the idealised-rectangle value', () => {
      expect(relErr(s.Izz, ideal.Izz)).toBeLessThan(0.08);
    });

    it('(c) radii of gyration agree with sqrt(I/A)', () => {
      expect(relErr(s.rzz, Math.sqrt(s.Izz / s.A))).toBeLessThan(0.02);
      expect(relErr(s.ryy, Math.sqrt(s.Iyy / s.A))).toBeLessThan(0.03);
    });

    it('(d) Zez within 2% of Izz / (D/2)', () => {
      expect(relErr(s.Zez, s.Izz / (s.D / 20))).toBeLessThan(0.02);
    });

    it('(e) mass within 2% of A × 0.785 kg/m', () => {
      expect(relErr(s.mass, s.A * 0.785)).toBeLessThan(0.02);
    });

    it('(f) shape factor Zpz/Zez between 1.08 and 1.22, Zpz near the idealised value', () => {
      const shapeFactor = s.Zpz / s.Zez;
      expect(shapeFactor).toBeGreaterThan(1.08);
      expect(shapeFactor).toBeLessThan(1.22);
      expect(relErr(s.Zpz, ideal.Zpz)).toBeLessThan(0.06);
    });

    it('minor-axis modulus is consistent with Iyy and the extreme-fibre distance', () => {
      // Extreme fibre distance c = Iyy / Zey, in mm.
      const c = (s.Iyy / s.Zey) * 10;
      if (s.family === 'ISMB') {
        // Doubly symmetric: c = bf / 2.
        expect(relErr(c, s.bf / 2)).toBeLessThan(0.02);
      } else {
        // Channel: c = bf − Cyy, with the centroid 0.2–0.35 bf from the back of the web.
        expect(c).toBeGreaterThan(0.65 * s.bf);
        expect(c).toBeLessThan(0.8 * s.bf);
      }
    });

    it('has physically sensible proportions', () => {
      expect(s.tf).toBeGreaterThan(s.tw);
      expect(s.Izz).toBeGreaterThan(s.Iyy);
      expect(s.D - 2 * (s.tf + s.r1)).toBeGreaterThan(0);
    });
  },
);

describe.each(['ISMB', 'ISMC'] as const)('(g) monotonic growth with depth — %s', (family) => {
  const list = sectionsByFamily(family);
  const strictlyIncreasing = [
    'D',
    'mass',
    'A',
    'tw',
    'Izz',
    'Iyy',
    'rzz',
    'Zez',
    'Zey',
    'Zpz',
  ] as const;

  it.each(strictlyIncreasing)('%s strictly increases', (key) => {
    for (let i = 1; i < list.length; i++) {
      expect(list[i][key], `${list[i].designation}.${key}`).toBeGreaterThan(list[i - 1][key]);
    }
  });

  it('flange width and root radius never decrease', () => {
    for (let i = 1; i < list.length; i++) {
      expect(list[i].bf).toBeGreaterThanOrEqual(list[i - 1].bf);
      expect(list[i].r1).toBeGreaterThanOrEqual(list[i - 1].r1);
    }
  });
});
