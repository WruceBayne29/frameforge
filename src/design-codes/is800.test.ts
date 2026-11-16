import { describe, expect, it } from 'vitest';
import { STEEL_GRADES, checkMember, classifySection } from './is800';
import type { DesignInput, DesignResult, SteelGrade } from './is800';
import { SECTIONS, getSection } from './sections';
import type { SteelSection } from './sections';

/**
 * Expected values in this file were worked out by hand (calculator arithmetic shown in the
 * comments), independently of the implementation. γm0 = 1.10, γm1 = 1.25, E = 200 000 MPa.
 */

function section(designation: string): SteelSection {
  const s = getSection(designation);
  if (!s) throw new Error(`unknown section ${designation}`);
  return s;
}

function grade(name: string): SteelGrade {
  const g = STEEL_GRADES.find((x) => x.name === name);
  if (!g) throw new Error(`unknown grade ${name}`);
  return g;
}

const ISMB300 = section('ISMB 300');
const ISMB200 = section('ISMB 200');
const ISMB100 = section('ISMB 100');
const ISMC200 = section('ISMC 200');
const ISMC125 = section('ISMC 125');
const E250 = grade('E250');
const E450 = grade('E450');

/** ISMB 300 / E250 member with no load; override what each test needs. */
function run(overrides: Partial<DesignInput> = {}): DesignResult {
  return checkMember({
    section: ISMB300,
    grade: E250,
    length: 3,
    axial: 0,
    moment: 0,
    shear: 0,
    ...overrides,
  });
}

function line(result: DesignResult, id: string) {
  const found = result.checks.find((c) => c.id === id);
  if (!found) throw new Error(`check '${id}' not emitted`);
  return found;
}

function ids(result: DesignResult): string[] {
  return result.checks.map((c) => c.id);
}

/** Relative comparison: hand values are rounded to 4–5 significant figures. */
function expectRel(actual: number, expected: number, tol = 5e-4): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(tol);
}

describe('STEEL_GRADES', () => {
  it('lists the IS 2062 grades with fy / fu', () => {
    expect(STEEL_GRADES.map((g) => [g.name, g.fy, g.fu])).toEqual([
      ['E250', 250, 410],
      ['E300', 300, 440],
      ['E350', 350, 490],
      ['E410', 410, 540],
      ['E450', 450, 570],
    ]);
  });
});

describe('classifySection (Table 2)', () => {
  it('classifies every tabulated section as plastic for fy = 250', () => {
    for (const s of SECTIONS) expect(classifySection(s, 250), s.designation).toBe('plastic');
  });

  it('keeps ISMB 300 plastic even for fy = 450', () => {
    // ε = sqrt(250/450) = 0.7454; flange 70/12.4 = 5.65 ≤ 9.4ε = 7.01;
    // web d = 300 − 2(12.4 + 14) = 247.2, d/tw = 32.96 ≤ 84ε = 62.6.
    expect(classifySection(ISMB300, 450)).toBe('plastic');
  });

  it('downgrades channel flanges as fy rises', () => {
    // ISMC 125: b/tf = 65/8.1 = 8.02; web d/tw = (125 − 2(8.1 + 9.5))/5 = 17.96.
    // fy = 250: 8.02 ≤ 9.4                                  → plastic
    // fy = 350: ε = 0.8452, 9.4ε = 7.94 < 8.02 ≤ 10.5ε = 8.87 → compact
    // fy = 450: ε = 0.7454, 10.5ε = 7.83 < 8.02 ≤ 15.7ε = 11.70 → semi-compact
    expect(classifySection(ISMC125, 250)).toBe('plastic');
    expect(classifySection(ISMC125, 350)).toBe('compact');
    expect(classifySection(ISMC125, 450)).toBe('semi-compact');
  });

  it('flags a channel web beyond 42ε as slender', () => {
    // ISMC 400: d/tw = (400 − 2(15.3 + 15))/8.6 = 39.47.
    // fy = 250: 39.47 ≤ 42 → plastic.  fy = 450: 42ε = 31.30 < 39.47 → slender.
    const ismc400 = section('ISMC 400');
    expect(classifySection(ismc400, 250)).toBe('plastic');
    expect(classifySection(ismc400, 450)).toBe('slender');
  });

  it('classifies I-section flange outstands with b = bf/2', () => {
    // Hypothetical ISMB 300 variants, fy = 250 (ε = 1), b = 70 mm.
    expect(classifySection({ ...ISMB300, tf: 7 }, 250)).toBe('compact'); // 70/7 = 10.0
    expect(classifySection({ ...ISMB300, tf: 6 }, 250)).toBe('semi-compact'); // 11.67
    expect(classifySection({ ...ISMB300, tf: 4 }, 250)).toBe('slender'); // 17.5 > 15.7
  });

  it('classifies I-section webs with the 84ε / 105ε / 126ε limits', () => {
    // Hypothetical ISMB 600 variants, fy = 250: d = 600 − 2(20.8 + 20) = 518.4 mm.
    const ismb600 = section('ISMB 600');
    expect(classifySection({ ...ismb600, tw: 5 }, 250)).toBe('compact'); // 103.7
    expect(classifySection({ ...ismb600, tw: 4.5 }, 250)).toBe('semi-compact'); // 115.2
    expect(classifySection({ ...ismb600, tw: 4 }, 250)).toBe('slender'); // 129.6
  });

  it('takes the worse of flange and web', () => {
    // Flange semi-compact (11.67), web compact (247.2 + 2·6.4 = 260 → 260/2.6 = 100).
    expect(classifySection({ ...ISMB300, tf: 6, tw: 2.6 }, 250)).toBe('semi-compact');
  });
});

describe('tension, cl. 6.2', () => {
  it('ISMB 300 / E250: gross yielding governs, Td = 1278.6 kN', () => {
    // Tdg = 5626 × 250 / 1.1        = 1 278 636 N = 1278.6 kN
    // Tdn = 0.9 × 5626 × 410 / 1.25 = 1 660 795 N = 1660.8 kN  (An = Ag)
    const r = run({ axial: 500 });
    expectRel(r.capacities.Td, 1278.636, 1e-6);
    expect(ids(r)).toEqual(['tension']);
    const t = line(r, 'tension');
    expect(t.clause).toBe('IS 800 cl. 6.2');
    expect(t.unit).toBe('kN');
    expect(t.demand).toBe(500);
    expectRel(t.ratio, 500 / 1278.636, 1e-6); // 0.3910
    expect(r.utilisation).toBe(t.ratio);
    expect(r.governing).toBe('tension');
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('net-section rupture governs when fu is close to fy', () => {
    // fy = 400, fu = 410: Tdg = 5626 × 400 / 1.1 = 2045.8 kN > Tdn = 1660.8 kN.
    const r = run({ grade: { name: 'custom', fy: 400, fu: 410 }, axial: 100 });
    expectRel(r.capacities.Td, 1660.795, 1e-6);
  });

  it('fails when the demand exceeds Td', () => {
    const r = run({ axial: 1300 });
    expect(line(r, 'tension').ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.utilisation).toBeGreaterThan(1);
  });

  it('warns when KL/r exceeds 400 (Table 3)', () => {
    // ISMB 100, L = 7 m: KL/ryy = 7000 / 16.7 = 419 > 400.
    const r = run({ section: ISMB100, length: 7, axial: 10 });
    expectRel(r.slendernessY, 419.16, 1e-4);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/exceeds 400 for a tension member/);
    // 6 m → 359: no warning.
    expect(run({ section: ISMB100, length: 6, axial: 10 }).warnings).toEqual([]);
  });
});

describe('compression, cl. 7.1.2', () => {
  it('ISMB 300 / E250, L = 3 m pinned column: Pd = 619 kN about y-y', () => {
    // D/bf = 300/140 = 2.14 > 1.2 → z-z curve a (α = 0.21), y-y curve b (α = 0.34).
    //
    // y-y: KL/r = 3000 / 28.4 = 105.63
    //      λ    = 105.63 × sqrt(250 / (π² × 200000)) = 105.63 / 88.86 = 1.1888
    //      φ    = 0.5 [1 + 0.34 (1.1888 − 0.2) + 1.1888²] = 0.5 × 2.7494 = 1.3747
    //      χ    = 1 / (1.3747 + sqrt(1.3747² − 1.1888²)) = 1 / (1.3747 + 0.6904) = 0.4842
    //      fcd  = 0.4842 × 250 / 1.1 = 110.05 MPa   (Table 9(b) interpolates to ≈ 110)
    //      Pdy  = 5626 × 110.05 = 619.2 kN
    //
    // z-z: KL/r = 3000 / 123.7 = 24.25, λ = 0.2729
    //      φ    = 0.5 [1 + 0.21 (0.0729) + 0.0745] = 0.5449
    //      χ    = 1 / (0.5449 + sqrt(0.5449² − 0.2729²)) = 1 / (0.5449 + 0.4716) = 0.9837
    //      fcd  = 223.58 MPa, Pdz = 5626 × 223.58 = 1257.8 kN
    const r = run({ axial: -400 });
    expectRel(r.slendernessY, 105.634, 1e-5);
    expectRel(r.slendernessZ, 24.2522, 1e-5);
    expectRel(r.capacities.Pdy, 619.17);
    expectRel(r.capacities.Pdz, 1257.85);
    expect(r.capacities.Pd).toBe(r.capacities.Pdy);
    expect(ids(r)).toEqual(['compression']);
    const c = line(r, 'compression');
    expect(c.clause).toBe('IS 800 cl. 7.1.2');
    expect(c.demand).toBe(400);
    expectRel(c.ratio, 400 / 619.17); // 0.646
    expect(r.governing).toBe('compression');
    expect(r.warnings).toEqual([]);
  });

  it('effective length factors scale the slenderness', () => {
    // ky = 0.5 halves KL/ry: 52.82; kz = 2 doubles KL/rz: 48.50.
    // z-z at 48.50 (curve a): λ = 0.5459, φ = 0.6853, χ = 0.9094, Pdz = 1162.8 kN.
    const r = run({ axial: -1, ky: 0.5, kz: 2 });
    expectRel(r.slendernessY, 52.817, 1e-4);
    expectRel(r.slendernessZ, 48.504, 1e-4);
    expectRel(r.capacities.Pdz, 1162.79);
  });

  it('a zero-length (fully braced) member reaches the squash load A·fy/γm0', () => {
    const r = run({ length: 0, axial: -100 });
    expect(r.slendernessY).toBe(0);
    expectRel(r.capacities.Pd, 1278.636, 1e-6);
  });

  it('uses curves b / c for a stocky I-section with D/bf ≤ 1.2', () => {
    // Hypothetical ISMB 200 with bf widened to 200 mm (other properties untouched), L = 3 m.
    // z-z curve b (α = 0.34): KL/r = 3000/83.2 = 36.06, λ = 0.4058, φ = 0.6173,
    //      χ = 0.9238, Pdz = 3233 × 0.9238 × 250/1.1 = 678.8 kN
    // y-y curve c (α = 0.49): KL/r = 3000/21.5 = 139.53, λ = 1.5703, φ = 2.0687,
    //      χ = 1/(2.0687 + sqrt(2.0687² − 1.5703²)) = 0.2928, Pdy = 215.1 kN
    const r = run({ section: { ...ISMB200, bf: 200 }, axial: -10 });
    expectRel(r.capacities.Pdz, 678.76);
    expectRel(r.capacities.Pdy, 215.14);
  });

  it('uses curve c about both axes for channels (ISMC 200, L = 2 m)', () => {
    // z-z: KL/r = 2000/80.3 = 24.91, λ = 0.2803, φ = 0.5 [1 + 0.49(0.0803) + 0.0786] = 0.5590
    //      χ = 0.9592, Pdz = 2821 × 0.9592 × 250/1.1 = 615.0 kN
    // y-y: KL/r = 2000/22.3 = 89.69, λ = 1.0093, φ = 0.5 [1 + 0.49(0.8093) + 1.0187] = 1.2077
    //      χ = 1/(1.2077 + sqrt(1.2077² − 1.0093²)) = 0.5346, fcd = 121.5 MPa
    //      (Table 9(c) gives 121 MPa at KL/r = 90), Pdy = 342.7 kN
    const r = run({ section: ISMC200, length: 2, axial: -200 });
    expectRel(r.capacities.Pdz, 614.97);
    expectRel(r.capacities.Pdy, 342.72);
    expectRel(r.utilisation, 200 / 342.72);
    // Td = 2821 × 250/1.1 = 641.1 kN; Vd = 200 × 6.1 × 250/(√3 × 1.1) = 160.1 kN.
    expectRel(r.capacities.Td, 641.136, 1e-6);
    expectRel(r.capacities.Vd, 160.083, 1e-5);
    // No bending → no channel LTB warning.
    expect(r.warnings).toEqual([]);
  });

  it('warns when KL/r exceeds 180 (Table 3)', () => {
    // ISMB 100, L = 4 m: KL/ryy = 4000/16.7 = 239.5 > 180.
    // Curve b: λ = 2.6956, φ = 4.5573, χ = 0.1215, Pdy = 1460 × 0.1215 × 250/1.1 = 40.3 kN.
    const r = run({ section: ISMB100, length: 4, axial: -20 });
    expectRel(r.slendernessY, 239.52, 1e-4);
    expectRel(r.capacities.Pd, 40.309);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/KL\/r = 240 exceeds 180 for a compression member/);
    // The same member in tension is within the 400 limit.
    expect(run({ section: ISMB100, length: 4, axial: 20 }).warnings).toEqual([]);
  });

  it('capacity falls monotonically with length', () => {
    let previous = Infinity;
    for (const length of [0.5, 1, 2, 3, 4, 6, 8]) {
      const { Pd } = run({ length, axial: -1 }).capacities;
      expect(Pd).toBeLessThan(previous);
      previous = Pd;
    }
  });
});

describe('shear, cl. 8.4', () => {
  it('ISMB 300 / E250: Vd = 295.2 kN', () => {
    // Vd = D·tw·fy / (√3·γm0) = 300 × 7.5 × 250 / (1.7321 × 1.1) = 295 236 N
    const r = run({ shear: 100 });
    expectRel(r.capacities.Vd, 295.236, 1e-6);
    expect(ids(r)).toEqual(['shear']);
    const v = line(r, 'shear');
    expect(v.clause).toBe('IS 800 cl. 8.4');
    expectRel(v.ratio, 100 / 295.236, 1e-6);
  });

  it('uses the magnitude of a negative shear', () => {
    expect(line(run({ shear: -100 }), 'shear').demand).toBe(100);
  });
});

describe('bending, laterally supported, cl. 8.2.1.2', () => {
  it('ISMB 300 / E250 (plastic): Md = Zp·fy/γm0 = 148.1 kN·m', () => {
    // Md  = 651.74e3 × 250 / 1.1 = 148.12 kN·m
    // cap = 1.2 × 573.6e3 × 250 / 1.1 = 156.44 kN·m (not governing)
    const r = run({ moment: 100, laterallyRestrained: true });
    expectRel(r.capacities.Mdz, 148.1227, 1e-6);
    expect(r.capacities.Md).toBe(r.capacities.Mdz);
    expect(ids(r)).toEqual(['bending']);
    const b = line(r, 'bending');
    expect(b.clause).toBe('IS 800 cl. 8.2.1.2');
    expect(b.unit).toBe('kN·m');
    expectRel(b.ratio, 100 / 148.1227, 1e-6);
  });

  it('uses the magnitude of a hogging (negative) moment', () => {
    const r = run({ moment: -100, laterallyRestrained: true });
    expect(line(r, 'bending').demand).toBe(100);
  });

  it('semi-compact section: Md = Ze·fy/γm0', () => {
    // ISMC 125 / E450 is semi-compact (see classification): βb = Ze/Zp, so
    // Md = 66.6e3 × 450 / 1.1 = 27.245 kN·m.
    const r = run({ section: ISMC125, grade: E450, moment: 10, laterallyRestrained: true });
    expect(r.sectionClass).toBe('semi-compact');
    expectRel(r.epsilon, 0.74536, 1e-5);
    expectRel(r.capacities.Mdz, 27.2455, 1e-5);
  });

  it('caps Md at 1.2·Ze·fy/γm0', () => {
    // Hypothetical shape factor 800/573.6 = 1.39: Zp·fy/γm0 = 181.8 kN·m, cap = 156.44 kN·m.
    const r = run({ section: { ...ISMB300, Zpz: 800 }, moment: 10, laterallyRestrained: true });
    expectRel(r.capacities.Mdz, 156.436, 1e-5);
  });

  it('slender section: semi-compact formulas plus a warning', () => {
    // ISMC 400 / E450 has a slender web: Md = Ze·fy/γm0 = 754.1e3 × 450/1.1 = 308.5 kN·m.
    const r = run({
      section: section('ISMC 400'),
      grade: E450,
      moment: 50,
      laterallyRestrained: true,
    });
    expect(r.sectionClass).toBe('slender');
    expectRel(r.capacities.Mdz, 308.495, 1e-5);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/ISMC 400 is a slender section/);
  });
});

describe('high shear, cl. 9.2.2', () => {
  it('does not reduce Md up to V = 0.6 Vd', () => {
    // 0.6 Vd = 177.1 kN
    const r = run({ moment: 50, shear: 177, laterallyRestrained: true });
    expectRel(r.capacities.Mdz, 148.1227, 1e-6);
  });

  it('reduces Md towards the flange-only capacity for V > 0.6 Vd', () => {
    // V = 250 kN > 177.1 kN
    // β   = (2 × 250/295.236 − 1)² = 0.69356² = 0.48103
    // Mfd = bf·tf·(D − tf)·fy/γm0 = 140 × 12.4 × 287.6 × 250/1.1 = 113.47 kN·m
    // Mdv = 148.12 − 0.48103 × (148.12 − 113.47) = 131.45 kN·m
    const r = run({ moment: 50, shear: 250, laterallyRestrained: true });
    expectRel(r.capacities.Mdz, 131.454, 1e-5);
    expect(r.capacities.Md).toBe(r.capacities.Mdz);
    expectRel(line(r, 'bending').ratio, 50 / 131.454, 1e-5);
  });

  it('bottoms out at the flange-only capacity once V ≥ Vd', () => {
    const r = run({ moment: 50, shear: 400, laterallyRestrained: true });
    expectRel(r.capacities.Mdz, 113.471, 1e-5);
    expect(line(r, 'shear').ok).toBe(false);
  });

  it('leaves a semi-compact section at Ze·fy/γm0', () => {
    // ISMC 125 / E450: Vd = 125 × 5 × 450/(√3 × 1.1) = 147.6 kN; V = 140 kN > 0.6 Vd.
    const r = run({
      section: ISMC125,
      grade: E450,
      moment: 10,
      shear: 140,
      laterallyRestrained: true,
    });
    expectRel(r.capacities.Vd, 147.618, 1e-5);
    expectRel(r.capacities.Mdz, 27.2455, 1e-5);
  });
});

describe('bending, laterally unsupported, cl. 8.2.2', () => {
  it('ISMB 300 / E250, LLT = 4 m: Md = 88.8 kN·m', () => {
    // hf = 300 − 12.4 = 287.6 mm
    // π²·E·Iy·hf / (2·LLT²) = 9.8696 × 2e5 × 453.9e4 × 287.6 / (2 × 4000²) = 80.52e6 N·mm
    // (LLT/ry)/(hf/tf) = (4000/28.4)/(287.6/12.4) = 140.85/23.19 = 6.073
    // sqrt(1 + 6.073²/20) = sqrt(2.844) = 1.6864
    // Mcr  = 80.52 × 1.6864 = 135.79 kN·m
    // λLT  = sqrt(651.74e3 × 250 / 135.79e6) = sqrt(1.1999) = 1.0954
    // φLT  = 0.5 [1 + 0.21 (0.8954) + 1.1999] = 1.1939
    // χLT  = 1 / (1.1939 + sqrt(1.1939² − 1.0954²)) = 1 / (1.1939 + 0.4751) = 0.5992
    // Md   = 0.5992 × 651.74e3 × 250/1.1 = 88.75 kN·m
    const r = run({ length: 4, moment: 60 });
    expectRel(r.capacities.Md, 88.751);
    expectRel(r.capacities.Mdz, 148.1227, 1e-6);
    const b = line(r, 'bending');
    expect(b.clause).toBe('IS 800 cl. 8.2.2');
    expectRel(b.ratio, 60 / 88.751);
    expect(r.warnings).toEqual([]);
  });

  it('LTB reduces the capacity relative to the restrained beam, more so with length', () => {
    const restrained = run({ length: 4, moment: 60, laterallyRestrained: true });
    expect(restrained.capacities.Md).toBeCloseTo(148.1227, 2);
    let previous = restrained.capacities.Md;
    for (const length of [2, 3, 4, 6, 8]) {
      const { Md } = run({ length, moment: 60 }).capacities;
      expect(Md).toBeLessThan(previous);
      previous = Md;
    }
  });

  it('kLT scales the LTB length', () => {
    // kLT = 0.75 on 4 m is the 3 m case: Mcr = 204.32 kN·m, λLT = 0.8930, χLT = 0.7385,
    // Md = 109.39 kN·m.
    const r = run({ length: 4, moment: 60, kLT: 0.75 });
    expectRel(r.capacities.Md, 109.394);
    expect(r.capacities.Md).toBeCloseTo(run({ length: 3, moment: 60 }).capacities.Md, 9);
  });

  it('applies no reduction when λLT ≤ 0.4', () => {
    // L = 0.5 m: Mcr = 5227 kN·m, λLT = sqrt(162.9/5227) = 0.177 ≤ 0.4 → Md = Mdz.
    const r = run({ length: 0.5, moment: 60 });
    expect(r.capacities.Md).toBe(r.capacities.Mdz);
    expectRel(r.capacities.Md, 148.1227, 1e-6);
  });

  it('treats a zero LTB length as fully restrained', () => {
    expect(run({ moment: 60, kLT: 0 }).capacities.Md).toBeCloseTo(148.1227, 2);
    expect(run({ length: 0, moment: 60 }).capacities.Md).toBeCloseTo(148.1227, 2);
  });

  it('never exceeds the high-shear section capacity', () => {
    // L = 0.5 m (no LTB reduction) with V = 250 kN: Md = Mdv = 131.45 kN·m.
    const r = run({ length: 0.5, moment: 60, shear: 250 });
    expectRel(r.capacities.Md, 131.454, 1e-5);
  });

  it('channel path: ISMC 200, L = 2 m, with an approximation warning', () => {
    // hf = 188.6; π²·E·Iy·hf/(2L²) = 9.8696 × 2e5 × 140.4e4 × 188.6/(2 × 2000²) = 65.34e6
    // (L/ry)/(hf/tf) = 89.69/16.54 = 5.421 → sqrt(1 + 5.421²/20) = 1.5714
    // Mcr = 102.67 kN·m; λLT = sqrt(211.25e3 × 250/102.67e6) = 0.7172
    // φLT = 0.5 [1 + 0.21(0.5172) + 0.5144] = 0.8115; χLT = 0.8395
    // Md  = 0.8395 × 211.25e3 × 250/1.1 = 40.31 kN·m;  Mdz = 48.01 kN·m
    const r = run({ section: ISMC200, length: 2, moment: 20, shear: 30 });
    expect(r.sectionClass).toBe('plastic');
    expectRel(r.capacities.Mdz, 48.0114, 1e-5);
    expectRel(r.capacities.Md, 40.306);
    expect(ids(r)).toEqual(['shear', 'bending']);
    expect(r.governing).toBe('bending');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/channel/);
    // Restrained channel: no LTB, no warning.
    const restrained = run({
      section: ISMC200,
      length: 2,
      moment: 20,
      laterallyRestrained: true,
    });
    expect(restrained.warnings).toEqual([]);
    expect(restrained.capacities.Md).toBe(restrained.capacities.Mdz);
  });
});

describe('combined compression + bending, cl. 9.3.1.1 and 9.3.2.2', () => {
  // ISMB 300 / E250, L = 3 m, P = 200 kN, M = 40 kN·m, Cm = 0.9 (default), unrestrained.
  // From the tests above: Pdy = 619.17, Pdz = 1257.85, Nd = 1278.64, Mdz = 148.12,
  // λz = 0.2729; LTB at 3 m: λLT = 0.8930, Md = 109.39 kN·m.
  const beamColumn = () => run({ axial: -200, moment: 40, shear: 20 });

  it('emits every applicable check in a stable order', () => {
    expect(ids(beamColumn())).toEqual([
      'compression',
      'shear',
      'bending',
      'interaction-section',
      'buckling-y',
      'buckling-z',
    ]);
  });

  it('section strength: N/Nd + M/Mdz', () => {
    // 200/1278.64 + 40/148.12 = 0.1564 + 0.2700 = 0.4265
    const c = line(beamColumn(), 'interaction-section');
    expect(c.clause).toBe('IS 800 cl. 9.3.1.1');
    expect(c.capacity).toBe(1);
    expect(c.unit).toBe('-');
    expectRel(c.demand, 0.42646);
    expect(c.ratio).toBe(c.demand);
  });

  it('member buckling about y-y with LTB', () => {
    // ny  = 200/619.17 = 0.3230
    // KLT = 1 − 0.1 × 0.8930 × 0.3230/(0.9 − 0.25) = 1 − 0.04438 = 0.9556
    //       (lower bound 1 − 0.1 × 0.3230/0.65 = 0.9503 does not govern)
    // ratio = 0.3230 + 0.9556 × 40/109.39 = 0.3230 + 0.3494 = 0.6724
    const c = line(beamColumn(), 'buckling-y');
    expect(c.clause).toBe('IS 800 cl. 9.3.2.2');
    expectRel(c.ratio, 0.67244);
  });

  it('member buckling about z-z', () => {
    // nz = 200/1257.85 = 0.1590
    // Kz = 1 + (0.2729 − 0.2) × 0.1590 = 1.0116   (≤ 1 + 0.8 nz = 1.127)
    // ratio = 0.1590 + 1.0116 × 0.9 × 40/109.39 = 0.1590 + 0.3329 = 0.4919
    const c = line(beamColumn(), 'buckling-z');
    expectRel(c.ratio, 0.4919);
  });

  it('governing check and utilisation are the maximum ratio', () => {
    const r = beamColumn();
    expect(r.governing).toBe('buckling-y');
    expect(r.utilisation).toBe(Math.max(...r.checks.map((c) => c.ratio)));
    expectRel(r.utilisation, 0.67244);
    expect(r.ok).toBe(true);
  });

  it('laterally restrained: KLT = 1 and Md = Mdz', () => {
    // buckling-y = 0.3230 + 1.0 × 40/148.12 = 0.5931
    // buckling-z = 0.1590 + 1.0116 × 0.9 × 40/148.12 = 0.4049
    const r = run({ axial: -200, moment: 40, laterallyRestrained: true });
    expectRel(line(r, 'buckling-y').ratio, 0.59306);
    expectRel(line(r, 'buckling-z').ratio, 0.40486);
  });

  it('applies the KLT lower bound when λLT > 1 and the Kz cap when λz > 1', () => {
    // L = 6 m, kz = 3, P = 50 kN, M = 20 kN·m.
    // y-y: KL/r = 211.27, λ = 2.3776, χ = 0.1532, Pdy = 195.89 kN → ny = 0.2552
    // z-z: KL/r = 18000/123.7 = 145.51, λz = 1.6376, φ = 1.9918, χ = 0.3199,
    //      Pdz = 409.08 kN → nz = 0.1222
    // LTB: Mcr = 81.21 kN·m, λLT = 1.4165, χLT = 0.4099, Md = 60.72 kN·m
    // KLT = max(1 − 0.1 × 1.4165 × 0.2552/0.65, 1 − 0.1 × 0.2552/0.65)
    //     = max(0.9444, 0.9607) = 0.9607
    // Kz  = min(1 + 1.4376 × 0.1222, 1 + 0.8 × 0.1222) = min(1.1757, 1.0978) = 1.0978
    // buckling-y = 0.2552 + 0.9607 × 20/60.72 = 0.5717
    // buckling-z = 0.1222 + 1.0978 × 0.9 × 20/60.72 = 0.4476
    const r = run({ length: 6, kz: 3, axial: -50, moment: 20 });
    expectRel(r.capacities.Pdy, 195.89);
    expectRel(r.capacities.Pdz, 409.08);
    expectRel(r.capacities.Md, 60.722);
    expectRel(line(r, 'buckling-y').ratio, 0.57168);
    expectRel(line(r, 'buckling-z').ratio, 0.44765);
    // KL/ry = 211 > 180 is reported.
    expect(r.warnings.some((w) => /exceeds 180/.test(w))).toBe(true);
  });

  it('clamps Cm to the range 0.4 – 1.0', () => {
    const low = run({ axial: -200, moment: 40, cm: 0.1 });
    const atFloor = run({ axial: -200, moment: 40, cm: 0.4 });
    expect(line(low, 'buckling-z').ratio).toBe(line(atFloor, 'buckling-z').ratio);
    expect(line(low, 'buckling-y').ratio).toBe(line(atFloor, 'buckling-y').ratio);
    // Cm = 0.4: buckling-z = 0.1590 + 1.0116 × 0.4 × 40/109.39 = 0.3070
    expectRel(line(atFloor, 'buckling-z').ratio, 0.30696);
    const high = run({ axial: -200, moment: 40, cm: 5 });
    const atCeiling = run({ axial: -200, moment: 40, cm: 1 });
    expect(line(high, 'buckling-z').ratio).toBe(line(atCeiling, 'buckling-z').ratio);
  });

  it('interaction ratios grow monotonically with moment and with axial load', () => {
    const interactionIds = ['interaction-section', 'buckling-y', 'buckling-z'];
    let previous = run({ axial: -200, moment: 5 });
    for (const moment of [10, 20, 40, 80, 120]) {
      const next = run({ axial: -200, moment });
      for (const id of interactionIds) {
        expect(line(next, id).ratio).toBeGreaterThan(line(previous, id).ratio);
      }
      expect(next.utilisation).toBeGreaterThan(previous.utilisation);
      previous = next;
    }
    previous = run({ axial: -10, moment: 40 });
    for (const axial of [-50, -100, -200, -400, -600]) {
      const next = run({ axial, moment: 40 });
      for (const id of interactionIds) {
        expect(line(next, id).ratio).toBeGreaterThan(line(previous, id).ratio);
      }
      expect(next.utilisation).toBeGreaterThan(previous.utilisation);
      previous = next;
    }
  });

  it('reports failure when an interaction ratio exceeds 1', () => {
    const r = run({ axial: -400, moment: 80 });
    expect(r.utilisation).toBeGreaterThan(1);
    expect(r.ok).toBe(false);
    expect(line(r, r.governing).ok).toBe(false);
    // Each individual action is still within its own capacity.
    expect(line(r, 'compression').ok).toBe(true);
    expect(line(r, 'bending').ok).toBe(true);
  });
});

describe('combined tension + bending, cl. 9.3.1.1 and 9.3.2.1', () => {
  it('ISMB 200 / E250, L = 3 m, T = 100 kN, M = 15 kN·m', () => {
    // Td  = 3233 × 250/1.1 = 734.77 kN;  Mdz = 253.86e3 × 250/1.1 = 57.695 kN·m
    // LTB: hf = 189.2; π²·E·Iy·hf/(2L²) = 9.8696 × 2e5 × 150e4 × 189.2/(2 × 3000²) = 31.12e6
    //      (L/ry)/(hf/tf) = 139.53/17.52 = 7.965 → sqrt(1 + 7.965²/20) = 2.0426
    //      Mcr = 63.57 kN·m; λLT = sqrt(253.86e3 × 250/63.57e6) = 0.9992
    //      φLT = 0.5 [1 + 0.21(0.7992) + 0.9984] = 1.0831; χLT = 0.6662; Md = 38.435 kN·m
    // section strength: 100/734.77 + 15/57.695 = 0.1361 + 0.2600 = 0.3961
    // member strength:  100/734.77 + 15/38.435 = 0.1361 + 0.3903 = 0.5264
    const r = run({ section: ISMB200, axial: 100, moment: 15 });
    expectRel(r.capacities.Td, 734.773, 1e-6);
    expectRel(r.capacities.Mdz, 57.6955, 1e-5);
    expectRel(r.capacities.Md, 38.435);
    expect(ids(r)).toEqual(['tension', 'bending', 'interaction-section', 'tension-bending']);
    expectRel(line(r, 'interaction-section').ratio, 0.39608);
    const tb = line(r, 'tension-bending');
    expect(tb.clause).toBe('IS 800 cl. 9.3.2.1');
    expectRel(tb.ratio, 0.52636);
    expect(r.governing).toBe('tension-bending');
    expect(r.ok).toBe(true);
  });

  it('coincides with the section check when laterally restrained', () => {
    const r = run({ section: ISMB200, axial: 100, moment: 15, laterallyRestrained: true });
    expect(line(r, 'tension-bending').ratio).toBeCloseTo(line(r, 'interaction-section').ratio, 12);
  });

  it('emits no compression or member-buckling checks for a tension member', () => {
    const r = run({ axial: 100, moment: 15, shear: 5 });
    expect(ids(r)).not.toContain('compression');
    expect(ids(r)).not.toContain('buckling-y');
    expect(ids(r)).not.toContain('buckling-z');
  });
});

describe('which checks are emitted', () => {
  it('unloaded member: no checks, utilisation 0, ok', () => {
    const r = run();
    expect(r.checks).toEqual([]);
    expect(r.utilisation).toBe(0);
    expect(r.governing).toBe('none');
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
    // Capacities are still reported.
    expect(r.capacities.Td).toBeGreaterThan(0);
    expect(r.capacities.Pd).toBeGreaterThan(0);
    expect(r.capacities.Md).toBeGreaterThan(0);
    expect(r.capacities.Vd).toBeGreaterThan(0);
  });

  it('treats solver round-off as zero load', () => {
    const r = run({ axial: -1e-9, moment: 1e-12, shear: -1e-10 });
    expect(r.checks).toEqual([]);
    expect(r.utilisation).toBe(0);
  });

  it('pure truss members only get the axial check', () => {
    expect(ids(run({ axial: -50, moment: 1e-9, shear: 1e-9 }))).toEqual(['compression']);
    expect(ids(run({ axial: 50, moment: 1e-9, shear: 1e-9 }))).toEqual(['tension']);
  });

  it('a beam gets shear and bending only', () => {
    expect(ids(run({ moment: 30, shear: 40 }))).toEqual(['shear', 'bending']);
  });

  it('every check line is self-consistent', () => {
    const r = run({ axial: -200, moment: 40, shear: 20 });
    for (const c of r.checks) {
      expect(c.clause).toMatch(/^IS 800 cl\. \d/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.ratio).toBeCloseTo(c.demand / c.capacity, 12);
      expect(c.ok).toBe(c.ratio <= 1);
    }
    expect(new Set(ids(r)).size).toBe(r.checks.length);
  });
});

describe('options and input validation', () => {
  it('capacities scale with the modulus E', () => {
    const steel = run({ axial: -100, moment: 20 });
    const soft = run({ axial: -100, moment: 20, E: 100000 });
    expect(soft.capacities.Pd).toBeLessThan(steel.capacities.Pd);
    expect(soft.capacities.Md).toBeLessThan(steel.capacities.Md);
    expect(soft.capacities.Td).toBe(steel.capacities.Td);
  });

  it('higher grade raises tension capacity in proportion to fy', () => {
    // 5626 × 450/1.1 = 2301.5 kN (rupture: 0.9 × 5626 × 570/1.25 = 2308.9 kN)
    const r = run({ grade: E450, axial: 100 });
    expectRel(r.capacities.Td, 2301.545, 1e-6);
  });

  it.each([
    ['length', { length: -1 }],
    ['length', { length: Number.NaN }],
    ['axial', { axial: Number.POSITIVE_INFINITY }],
    ['moment', { moment: Number.NaN }],
    ['shear', { shear: Number.NaN }],
    ['E', { E: 0 }],
    ['kz', { kz: -1 }],
    ['ky', { ky: Number.NaN }],
    ['kLT', { kLT: -0.5 }],
    ['grade.fy', { grade: { name: 'bad', fy: 0, fu: 410 } }],
    ['grade.fu', { grade: { name: 'bad', fy: 250, fu: -1 } }],
  ] satisfies [string, Partial<DesignInput>][])('rejects an invalid %s', (name, overrides) => {
    expect(() => run(overrides)).toThrow(RangeError);
    expect(() => run(overrides)).toThrow(name);
  });

  it('does not mutate its input', () => {
    const input: DesignInput = {
      section: ISMB300,
      grade: E250,
      length: 3,
      axial: -200,
      moment: 40,
      shear: 20,
    };
    const snapshot = JSON.stringify(input);
    checkMember(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
