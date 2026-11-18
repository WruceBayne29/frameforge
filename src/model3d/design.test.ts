import { describe, expect, it } from 'vitest';
import { checkMember, getSection, STEEL_GRADES } from '../design-codes';
import { analyzeProject3D } from './analysis';
import {
  checkLabel3D,
  designMembers3D,
  effectiveLengthFactors,
  utilisationColor,
  utilisationRgb,
} from './design';
import { addMember, addNode, setSupport } from './edit';
import { emptyProject3D, FIXED_SUPPORT } from './types';
import type { Project3D } from './types';

/** A 3 m vertical ISMB 300 cantilever column with a biaxial tip load and a torque. */
function column(): Project3D {
  let p = emptyProject3D('Column');
  p = addNode(p, 0, 0, 0).project;
  p = addNode(p, 0, 3, 0).project;
  p = addNode(p, 4, 3, 0).project;
  p = addMember(p, 'N1', 'N2', { section: 'ISMB 300' }).project;
  p = addMember(p, 'N2', 'N3', { section: 'Box' }).project;
  p.customSections.push({ name: 'Box', A: 100, Iz: 10000, Iy: 10000, J: 15000 });
  p = setSupport(p, 'N1', [...FIXED_SUPPORT]);
  p.loads.push({
    id: 'L1',
    kind: 'nodal',
    nodes: ['N2'],
    fx: 6,
    fy: -150,
    fz: 2,
    mx: 0,
    my: 1.5,
    mz: 0,
  });
  return p;
}

describe('designMembers3D', () => {
  it('maps Mz / Vy to the major axis and My / Vz to the minor axis', () => {
    const p = column();
    const r = analyzeProject3D(p);
    const design = designMembers3D(p, r);
    // The custom-section member is skipped.
    expect(Object.keys(design)).toEqual(['M1']);
    const f = r.members.M1;
    const expected = checkMember({
      section: getSection('ISMB 300')!,
      grade: STEEL_GRADES[0],
      E: 200000,
      length: 3,
      axial: f.minAxial.value,
      moment: Math.abs(f.maxAbsMz.value),
      shear: Math.abs(f.maxAbsVy.value),
      momentY: Math.abs(f.maxAbsMy.value),
      shearZ: Math.abs(f.maxAbsVz.value),
      torsion: Math.abs(f.maxAbsTorsion.value),
      kz: 1,
      ky: 1,
      kLT: 1,
    });
    expect(design.M1.result).toEqual(expected);
    // A vertical member: local z = global Z, so the X load bends it about z (major) and the Z
    // load about y (minor); the tip moment about Y twists it.
    expect(Math.abs(f.maxAbsMz.value)).toBeCloseTo(18, 9);
    expect(Math.abs(f.maxAbsMy.value)).toBeCloseTo(6, 9);
    expect(Math.abs(f.maxAbsTorsion.value)).toBeCloseTo(1.5, 9);
    expect(design.M1.result.checks.map((c) => c.id)).toContain('bending-y');
    expect(design.M1.result.warnings.join(' ')).toMatch(/Torsion/);
  });

  it('uses the project factors unless a member overrides them', () => {
    const p = column();
    p.design = { ...p.design, kz: 2, ky: 0.7 };
    expect(effectiveLengthFactors(p, p.members[0])).toEqual({ kz: 2, ky: 0.7 });
    p.members[0] = { ...p.members[0], kz: 1.2 };
    expect(effectiveLengthFactors(p, p.members[0])).toEqual({ kz: 1.2, ky: 0.7 });
    const d = designMembers3D(p, analyzeProject3D(p)).M1;
    expect(d).toMatchObject({ kz: 1.2, ky: 0.7 });
    // KL/r about z: 1.2·3000/123.7; about y: 0.7·3000/28.4.
    expect(d.result.slendernessZ).toBeCloseTo((1.2 * 3000) / 123.7, 9);
    expect(d.result.slendernessY).toBeCloseTo((0.7 * 3000) / 28.4, 9);
  });

  it('labels and colours', () => {
    expect(checkLabel3D('bending-y', 'x')).toBe('Bending y-y');
    expect(checkLabel3D('unknown', 'Fallback')).toBe('Fallback');
    expect(utilisationRgb(1.2)).toEqual([192, 38, 211]);
    expect(utilisationRgb(Number.NaN)).toEqual([156, 163, 175]);
    expect(utilisationColor(0)).toMatch(/^rgb\(/);
  });
});
