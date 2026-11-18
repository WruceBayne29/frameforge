import { describe, expect, it } from 'vitest';
import { getSection } from '../design-codes';
import { analyzeProject3D } from '../model3d/analysis';
import { issueText } from './common';
import type { StaadImportOptions } from './staad';
import { importStaad, looksLikeStaad } from './staad';
import { importTables } from './tables';

import portalFrame from '../../public/samples/portal-frame.std?raw';
import spaceFrameZUp from '../../public/samples/space-frame-zup.std?raw';

const SAMPLES: Record<string, string> = {
  'portal-frame.std': portalFrame,
  'space-frame-zup.std': spaceFrameZUp,
};
const sample = (name: string) => SAMPLES[name];

function ok(text: string, options?: StaadImportOptions) {
  const result = importStaad(text, options);
  expect(result.errors.map(issueText)).toEqual([]);
  expect(result.project).not.toBeNull();
  return { result, project: result.project!, warnings: result.warnings.map(issueText) };
}
const errorsOf = (text: string, options?: StaadImportOptions) =>
  importStaad(text, options).errors.map(issueText).join('\n');

const ISMB300 = getSection('ISMB 300')!;

/** A simply supported plane beam of span 6 m, in kN and m, with the given loads. */
const beam = (loads: string, extra = '') => `STAAD PLANE
UNIT METER KN
JOINT COORDINATES
1 0 0 0; 2 6 0 0
MEMBER INCIDENCES
1 1 2
MEMBER PROPERTY INDIAN
1 TABLE ST ISMB300
CONSTANTS
E 2.0E8 ALL
POISSON 0.3 ALL
${extra}
SUPPORTS
1 PINNED
2 FIXED BUT FX MZ
LOAD 1
${loads}
PERFORM ANALYSIS
FINISH
`;

describe('importStaad — results against closed forms', () => {
  it('cantilever with a tip load: PL³/3EI and PL', () => {
    const { project } = ok(`STAAD PLANE CANTILEVER
UNIT METER KN
JOINT COORDINATES
1 0 0 0; 2 4 0 0
MEMBER INCIDENCES
1 1 2
MEMBER PROPERTY INDIAN
1 TABLE ST ISMB300
CONSTANTS
E 2.0E8 ALL
SUPPORTS
1 FIXED
LOAD 1 TITLE TIP LOAD
JOINT LOAD
2 FY -10
`);
    expect(project.name).toBe('CANTILEVER');
    expect(project.plane).toBe('XY');
    expect(project.members[0]).toMatchObject({ section: 'ISMB 300', type: 'beam' });
    expect(project.materials).toEqual([{ name: 'E 200 GPa', E: 200, nu: 0.3, density: 0 }]);
    const r = analyzeProject3D(project);
    const EI = 2e8 * ISMB300.Izz * 1e-8;
    expect(r.displacements['2'].uy).toBeCloseTo((-10 * 4 ** 3) / (3 * EI), 10);
    expect(r.reactions['1'].fy).toBeCloseTo(10, 9);
    expect(r.reactions['1'].mz).toBeCloseTo(40, 9);
  });

  it('simply supported rectangular beam in mm and N: 5wL⁴/384EI', () => {
    const { project } = ok(`STAAD SPACE
UNIT MMS NEWTON
JOINT COORDINATES
1 0 0 0 3 6000 0 0
MEMBER INCIDENCES
1 1 2 2
MEMBER PROPERTY
1 2 PRIS YD 400 ZD 200
CONSTANTS
E 2.1E5 ALL
POISSON 0.2 ALL
SUPPORTS
1 PINNED
3 FIXED BUT FX MZ
LOAD 1
MEMBER LOAD
1 2 UNI GY -10
`);
    expect(project.plane).toBeUndefined();
    expect(project.nodes.map((n) => n.x)).toEqual([0, 3, 6]);
    expect(project.customSections).toHaveLength(1);
    const s = project.customSections[0];
    expect(s.name).toBe('Rect 400x200');
    expect(s.A).toBeCloseTo(800, 9); // cm²
    expect(s.Iz).toBeCloseTo((20 * 40 ** 3) / 12, 6); // cm⁴
    expect(s.Iy).toBeCloseTo((40 * 20 ** 3) / 12, 6);
    // Rectangle torsion constant β a b³ with b/a = 1/2: β = 1/3 − 0.21·0.5·(1 − 0.5⁴/12).
    expect(s.J).toBeCloseTo((1 / 3 - 0.21 * 0.5 * (1 - 0.5 ** 4 / 12)) * 40 * 20 ** 3, 6);
    expect(project.materials[0].E).toBeCloseTo(210, 9);
    const r = analyzeProject3D(project);
    const EI = (210e6 * (0.2 * 0.4 ** 3)) / 12;
    expect(r.displacements['2'].uy).toBeCloseTo((-5 * 10 * 6 ** 4) / (384 * EI), 10);
    expect(r.reactions['1'].fy).toBeCloseTo(30, 8);
    expect(r.reactions['3'].fy).toBeCloseTo(30, 8);
  });

  it('member load types give the reactions of statics', () => {
    const cases: Array<[string, number]> = [
      // [load, reaction at joint 1]
      ['MEMBER LOAD\n1 CON GY -30 2', 20],
      ['MEMBER LOAD\n1 CON GY -30', 15], // no distance: mid-span
      ['MEMBER LOAD\n1 CMOM GZ 12 1.5', 2], // anticlockwise: R1 = M / L
      ['MEMBER LOAD\n1 UNI GY -4 1 4', (4 * 3 * 3.5) / 6],
      ['MEMBER LOAD\n1 LIN Y 0 -6', (6 * 6) / 2 / 3],
      ['MEMBER LOAD\n1 LIN GY 0 0 -6', (6 * 6) / 2 / 2], // triangle peaking at mid-span
      ['MEMBER LOAD\n1 TRAP GY -2 -4 0 6', 6 * (2 / 2) + (6 * 2) / 2 / 3],
      ['MEMBER LOAD\n1 TRAP GY -2 -2 3 6', (2 * 3 * 1.5) / 6],
      ['JOINT LOAD\n1 FY -5', 5],
    ];
    for (const [loads, expected] of cases) {
      const { project } = ok(beam(loads));
      const r = analyzeProject3D(project);
      expect(r.reactions['1'].fy, loads).toBeCloseTo(expected, 8);
    }
  });

  it('projected loads act on the projected length', () => {
    const frame = (load: string) => `STAAD PLANE
UNIT METER KN
JOINT COORDINATES
1 0 0 0; 2 4 3 0
MEMBER INCIDENCES
1 1 2
MEMBER PROPERTY
1 PRIS YD 0.3 ZD 0.2
CONSTANTS
E 2.5E7 ALL
SUPPORTS
1 FIXED
LOAD 1
MEMBER LOAD
1 ${load}
`;
    const projected = ok(frame('UNI PY -10')).project;
    const global = ok(frame('UNI GY -8')).project;
    expect(projected.loads[0]).toMatchObject({ direction: 'globalY' });
    expect((projected.loads[0] as { w1: number }).w1).toBeCloseTo(-8, 12);
    expect(analyzeProject3D(projected).reactions['1'].fy).toBeCloseTo(40, 8);
    expect(analyzeProject3D(global).reactions['1'].fy).toBeCloseTo(40, 8);
    // PX on this member: projected on the vertical, 3 m of 5 m.
    expect((ok(frame('UNI PX 10')).project.loads[0] as { w1: number }).w1).toBeCloseTo(6, 12);
  });

  it('a truss with axial-only members gives the forces of the method of joints', () => {
    const { project, warnings } = ok(`STAAD TRUSS
UNIT METER KN
JOINT COORDINATES
1 0 0; 2 4 0; 3 2 2
MEMBER INCIDENCES
1 1 2; 2 1 3; 3 2 3
MEMBER PROPERTY
1 TO 3 PRIS AX 0.002
CONSTANTS
E 2.05E8 ALL
SUPPORTS
1 PINNED
2 FIXED BUT FX
LOAD 1
JOINT LOAD
3 FY -10
`);
    expect(project.plane).toBe('XY');
    expect(project.members.every((m) => m.type === 'truss')).toBe(true);
    expect(warnings.some((w) => /PRIS AX without IZ/.test(w))).toBe(true);
    const r = analyzeProject3D(project);
    expect(r.members['1'].maxAxial.value).toBeCloseTo(5, 8);
    expect(r.members['2'].minAxial.value).toBeCloseTo(-10 / Math.SQRT2, 8);
    expect(r.members['3'].minAxial.value).toBeCloseTo(-10 / Math.SQRT2, 8);
  });

  it('SET Z UP files give the same model as the Y-up equivalent', () => {
    const zUp = ok(sample('space-frame-zup.std')).project;
    const yUp = ok(`STAAD SPACE ONE-BAY SPACE FRAME (Z UP)
UNIT METER KN
JOINT COORDINATES
1 0 0 0; 2 5 0 0; 3 5 0 -4; 4 0 0 -4
REPEAT ALL 1 0 3.5 0
MEMBER INCIDENCES
1 1 5 4
5 5 6 7
8 8 5
MEMBER PROPERTY INDIAN
1 TO 4 TABLE ST ISMB250
5 TO 8 TABLE ST ISMB300
CONSTANTS
E STEEL ALL
POISSON STEEL ALL
DENSITY STEEL ALL
SUPPORTS
1 TO 4 FIXED
LOAD 1
SELFWEIGHT Y -1
MEMBER LOAD
5 TO 8 UNI GY -12
JOINT LOAD
5 8 FX 6
`).project;
    expect(zUp.nodes).toEqual(yUp.nodes);
    expect(zUp.loads).toEqual(yUp.loads);
    expect(zUp.selfWeight).toBe(true);
    const a = analyzeProject3D(zUp);
    const b = analyzeProject3D(yUp);
    for (const id of ['5', '6', '7', '8']) {
      for (const k of ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const) {
        expect(a.displacements[id][k]).toBeCloseTo(b.displacements[id][k], 12);
      }
    }
    // Total vertical reaction: 12 kN/m on 18 m of beams plus the self-weight.
    const steel = 76.8195;
    const weight =
      steel * 1e-4 * (4 * 3.5 * getSection('ISMB 250')!.A + 18 * getSection('ISMB 300')!.A);
    const fy = Object.values(a.reactions).reduce((s, x) => s + x.fy, 0);
    expect(fy).toBeCloseTo(12 * 18 + weight, 6);
    // Z-up support, load and moment directions map onto Y-up ones.
    const mapped = ok(`STAAD SPACE
SET Z UP
UNIT METER KN
JOINT COORDINATES
1 0 0 0; 2 0 0 3
MEMBER INCIDENCES
1 1 2
MEMBER PROPERTY
1 PRIS YD 0.3 ZD 0.3
CONSTANTS
E 2E7 ALL
SUPPORTS
1 FIXED BUT FY MY
LOAD 1
JOINT LOAD
2 FX 1 FY 2 FZ 3 MX 4 MY 5 MZ 6
MEMBER LOAD
1 UNI GY 7
1 CON PZ 8
`).project;
    expect(mapped.nodes[1]).toEqual({ id: '2', x: 0, y: 3, z: 0 });
    expect(mapped.supports[0].restraints).toEqual([true, true, false, true, true, false]);
    expect(mapped.loads[0]).toMatchObject({ fx: 1, fy: 3, fz: -2, mx: 4, my: 6, mz: -5 });
    expect(mapped.loads[1]).toMatchObject({ direction: 'globalZ', w1: -7 });
    // A vertical member has no length projected on the horizontal plane.
    expect(mapped.loads[2]).toMatchObject({ direction: 'globalY', P: 0 });
  });

  it('agrees with the same portal frame entered as tables', () => {
    const { project, result, warnings } = ok(sample('portal-frame.std'));
    expect(result.loadCases.map((c) => c.number)).toEqual([1, 2]);
    expect(result.loadCases[0].title).toBe('DEAD + LIVE');
    expect(result.loadCase).toBe(1);
    expect(warnings.some((w) => /Load combinations/.test(w))).toBe(true);
    expect(warnings.some((w) => /Design commands/.test(w))).toBe(true);
    expect(project.materials).toEqual([{ name: 'Steel', E: 205, nu: 0.3, density: 76.8195 }]);
    const tables = importTables({
      nodes: '1,0,0\n2,0,4\n3,6,4\n4,6,0',
      members: '1,1,2,ISMB300,,Steel\n2,2,3,ISMB400,,Steel\n3,3,4,ISMB300,,Steel',
      materials: 'name,E_GPa,nu,density\nSteel,205,0.3,76.8195',
      supports: '1,fixed\n4,fixed',
      nodalLoads: 'node,fx\n2,10',
      memberLoads: 'member,type,direction,w1\n2,udl,GY,-20',
    }).project!;
    const a = analyzeProject3D(project);
    const b = analyzeProject3D(tables);
    expect(a.displacements['3'].ux).toBeCloseTo(b.displacements['3'].ux, 12);
    expect(a.reactions['4'].mz).toBeCloseTo(b.reactions['4'].mz, 9);
    expect(a.reactions['1'].fy + a.reactions['4'].fy).toBeCloseTo(120, 8);
    // The second load case on request.
    const wind = ok(sample('portal-frame.std'), { loadCase: 2 }).project;
    expect(wind.loads).toEqual([
      { id: 'L1', kind: 'nodal', nodes: ['2'], fx: 25, fy: 0, fz: 0, mx: 0, my: 0, mz: 0 },
    ]);
  });
});

describe('importStaad — input language', () => {
  it('generates joints and members with REPEAT and REPEAT ALL', () => {
    const { project } = ok(`STAAD SPACE
* Two storeys, two bays by one bay.
UNIT METER KN
JOINT COORDINATES
1 0 0 0 3 10 0 0
REPEAT 1 0 0 4
REPEAT ALL 2 0 3 0
MEMBER INCIDENCES
* columns of the first storey, then the beams
1 1 7 6
7 7 8 8; 9 10 11 10
11 7 10 13
REPEAT ALL 1 13 6
MEMBER PROPERTY INDIAN
1 TO 26 TABLE ST ISMB200
CONSTANTS
E STEEL ALL
SUPPORTS
1 TO 6 FIXED
`);
    expect(project.nodes).toHaveLength(18);
    const node = (id: number) => project.nodes.find((n) => n.id === String(id));
    expect(node(4)).toMatchObject({ x: 0, y: 0, z: 4 });
    expect(node(9)).toMatchObject({ x: 10, y: 3, z: 0 });
    expect(node(18)).toMatchObject({ x: 10, y: 6, z: 4 });
    expect(project.members).toHaveLength(26);
    const member = (id: number) => project.members.find((m) => m.id === String(id));
    expect(member(6)).toMatchObject({ i: '6', j: '12' });
    expect(member(10)).toMatchObject({ i: '11', j: '12' });
    expect(member(13)).toMatchObject({ i: '9', j: '12' });
    expect(member(14)).toMatchObject({ i: '7', j: '13' });
    expect(member(26)).toMatchObject({ i: '15', j: '18' });
    expect(project.supports).toHaveLength(6);
  });

  it('applies repeated increments, shorthand, continuation lines and lists', () => {
    const { project } = ok(`STAAD PLANE
UNIT METER KN
JOINT COORDINATES
1 0 0 0
REPEAT 4 1 0 0 3*0 0 0 0 2 0 0
MEMBER INCIDENCES
1 1 2 4
MEMBER PROPERTY
1 TO 4 BY 2 TABLE ST ISMB250
2 4 TABLE ST ISMB 350
CONSTANTS
E 2E8 MEMB 1 -
 2 3 4
SUPPORTS
1 5 PINNED
`);
    // Increments 1, then 1 again (zero sets repeat the previous one), then 2.
    expect(project.nodes.map((n) => n.x)).toEqual([0, 1, 2, 3, 5]);
    expect(project.members.map((m) => m.section)).toEqual([
      'ISMB 250',
      'ISMB 350',
      'ISMB 250',
      'ISMB 350',
    ]);
  });

  it('reads groups, materials, constants, releases and truss members', () => {
    const { project, warnings } = ok(`STAAD SPACE
UNIT METER KN
JOINT COORDINATES
1 0 0 0; 2 4 0 0; 3 8 0 0; 4 4 3 0
MEMBER INCIDENCES
1 1 2; 2 2 3; 3 1 4; 4 4 3; 5 2 4
START GROUP DEFINITION
MEMBER
_CHORD 1 2
_WEB 3 TO 5
JOINT
_BASE 1 3
END GROUP DEFINITION
DEFINE MATERIAL START
ISOTROPIC MYSTEEL
E 2.1e+08
POISSON 0.29
DENSITY 78.5
ISOTROPIC CONCRETE
E 3e+07
POISSON 0.2
DENSITY 25
END DEFINE MATERIAL
MEMBER PROPERTY INDIAN
_CHORD TABLE ST ISMB300
_WEB TABLE ST ISMC200
CONSTANTS
MATERIAL MYSTEEL MEMB _CHORD
MATERIAL CONCRETE MEMB 3
E 1.9E8 MEMB 4
POISSON 0.25 MEMB 4
E STEEL MEMB 5
BETA 90 MEMB 1
BETA 0 MEMB 2
DENSITY 70 ALL
ALPHA 1.2E-5 ALL
MEMBER RELEASE
2 START MZ
3 BOTH MY MZ
1 END MX KFY 100
MEMBER TRUSS
5
SUPPORTS
_BASE FIXED
`);
    const m = (id: string) => project.members.find((x) => x.id === id)!;
    expect(m('1')).toMatchObject({ section: 'ISMB 300', beta: 90 });
    expect(m('3')).toMatchObject({
      section: 'ISMC 200',
      releaseI: { my: true, mz: true },
      releaseJ: { my: true, mz: true },
    });
    expect(m('2')).toMatchObject({ releaseI: { mz: true } });
    expect(m('2')).not.toHaveProperty('beta');
    expect(m('1')).toMatchObject({ releaseJ: { mx: true } });
    expect(m('5')).toMatchObject({ type: 'truss' });
    expect(m('5')).not.toHaveProperty('releaseI');
    const material = (id: string) => project.materials.find((x) => x.name === m(id).material)!;
    // DENSITY 70 ALL comes after MATERIAL: the numbers make the material the member's own.
    expect(material('1')).toMatchObject({ E: 210, nu: 0.29, density: 70 });
    expect(material('3')).toMatchObject({ E: 30, nu: 0.2, density: 70 });
    expect(material('4')).toMatchObject({ E: 190, nu: 0.25, density: 70 });
    expect(material('5')).toMatchObject({ name: 'Steel', E: 205, density: 70 });
    expect(project.supports.map((s) => s.node)).toEqual(['1', '3']);
    expect(warnings).toContain('line 36: CONSTANTS ALPHA is not used by FrameForge.');
    expect(warnings.some((w) => /Partial or spring releases/.test(w))).toBe(true);
  });

  it('converts values with the unit in force when they are read', () => {
    const { project } = ok(`STAAD PLANE
UNIT CM KN
JOINT COORDINATES
1 0 0 0; 2 300 0 0
UNIT METER
MEMBER INCIDENCES
1 1 2
UNIT MMS NEWTON
MEMBER PROPERTY
1 PRIS YD 300
CONSTANTS
E 200000 ALL
DENSITY 7.85E-5 ALL
SUPPORTS
1 FIXED
UNIT METER KN
LOAD 1
JOINT LOAD
2 FY -1 MZ 2
UNIT KIP FEET
JOINT LOAD
2 FX 1
UNIT MTON METER
MEMBER LOAD
1 CON GY -1 1.5
`);
    expect(project.nodes[1].x).toBeCloseTo(3, 12);
    const s = project.customSections[0];
    expect(s.name).toBe('Circle 300');
    expect(s.Iz).toBeCloseTo((Math.PI * 30 ** 4) / 64, 6);
    expect(s.J).toBeCloseTo((Math.PI * 30 ** 4) / 32, 6);
    expect(project.materials[0].E).toBeCloseTo(200, 9);
    expect(project.materials[0].density).toBeCloseTo(78.5, 9);
    expect(project.loads[0]).toMatchObject({ fy: -1, mz: 2 });
    expect((project.loads[1] as { fx: number }).fx).toBeCloseTo(4.4482216, 9);
    expect((project.loads[2] as { P: number }).P).toBeCloseTo(-9.80665, 9);
  });

  it('handles self-weight: −1 along gravity turns it on, anything else becomes line loads', () => {
    const on = ok(beam('SELFWEIGHT Y -1', 'DENSITY 78.5 ALL')).project;
    expect(on.selfWeight).toBe(true);
    expect(on.loads).toEqual([]);
    const { project, warnings } = ok(beam('SELFWEIGHT Y -1.5', 'DENSITY 78.5 ALL'));
    expect(project.selfWeight).toBe(false);
    expect((project.loads[0] as { w1: number }).w1).toBeCloseTo(-1.5 * 78.5 * ISMB300.A * 1e-4, 12);
    expect(warnings.some((w) => /applied as member line loads/.test(w))).toBe(true);
    const sideways = ok(beam('SELFWEIGHT X 1 LIST 1', 'DENSITY 78.5 ALL')).project;
    expect(sideways.loads[0]).toMatchObject({ direction: 'globalX' });
    const noDensity = ok(beam('SELFWEIGHT')).warnings;
    expect(noDensity).toContain(
      'SELFWEIGHT is on but no material has a density, so it adds no load.',
    );
  });

  it('warns about what it cannot import and keeps going', () => {
    const { project, warnings } = ok(`STAAD SPACE
INPUT WIDTH 79
UNIT METER KN
JOINT COORDINATES
1 0 0 0; 2 5 0 0; 3 5 0 5; 4 0 0 5
JOINT COORDINATES CYLINDRICAL
5 1 0 0
MEMBER INCIDENCES
1 1 2; 2 2 3; 3 3 4
ELEMENT INCIDENCES SHELL
10 1 2 3 4
ELEMENT PROPERTY
10 THICKNESS 0.2
MEMBER OFFSET
1 START 0.1 0 0
MEMBER PROPERTY AMERICAN
1 TABLE ST W12X26
2 TABLE D ISMC200
3 TAPERED 0.3 0.01 0.3 0.2 0.01
CONSTANTS
E STEEL ALL
BETA ANGLE ALL
SUPPORTS
1 4 FIXED BUT KFX 1000 MZ
2 ENFORCED
LOAD 1
FLOOR LOAD
YRANGE -1 1 FLOAD -5
ELEMENT LOAD
10 PR GY -2
MEMBER LOAD
1 UMOM GY 2
1 UNI GY -3 0 5 0.2
2 CON GY -3 2 0.5
LOAD 2
FLOOR LOAD
YRANGE -1 1 FLOAD -5
LOAD COMB 3
1 1.0 2 1.0
PRINT SUPPORT REACTION
PERFORM ANALYSIS
FINISH
`);
    expect(project.members.map((m) => m.section)).toEqual(['ISMB 300', 'ISMB 300', 'ISMB 300']);
    expect(project.supports.map((s) => s.restraints)).toEqual([
      [false, true, true, true, true, false],
      [false, true, true, true, true, false],
    ]);
    for (const expected of [
      'Cylindrical joint coordinates are not supported.',
      '"ELEMENT INCIDENCES" is not supported and is ignored.',
      '"ELEMENT PROPERTY" is not supported and is ignored.',
      '"MEMBER OFFSET" is not supported and is ignored.',
      'Section W12X26 is not in FrameForge',
      'TABLE D sections are not supported',
      'Member property "TAPERED',
      'BETA ANGLE is not supported',
      'Spring supports (KFX) are not supported',
      'Support type "ENFORCED" is not supported.',
      '"FLOOR LOAD" is not supported and is ignored.',
      '"ELEMENT LOAD" is not supported and is ignored.',
      'Member load type UMOM is not supported',
      'Load offsets (d3) are ignored.',
      'Load offsets are ignored.',
      'Load combinations are not imported',
      'The file has 2 load cases; load case 1 was imported.',
    ]) {
      expect(
        warnings.some((w) => w.includes(expected)),
        expected,
      ).toBe(true);
    }
    // Warnings of load case 2 are not reported when case 1 is imported.
    expect(warnings.filter((w) => w.includes('FLOOR LOAD'))).toHaveLength(1);
  });

  it('warns about missing headers, units, properties and repeated definitions', () => {
    const { warnings } = ok(`JOINT COORDINATES
1 0 0 0; 2 3 0 0; 2 4 0 0
MEMBER INCIDENCES
1 1 2; 1 2 1
SUPPORTS
1 FIXED
SET Z UP
`);
    for (const expected of [
      'No UNIT command found; values are read as metres and kN.',
      'No STAAD SPACE / PLANE / TRUSS line found; read as a space frame.',
      'Joint 2 is defined twice; the last one is used.',
      'Member 1 is defined twice; the last one is used.',
      'SET Z UP after the joints have been read is ignored.',
      "1 member(s) had no E in CONSTANTS and use STAAD's STEEL.",
      '1 member(s) had no MEMBER PROPERTY and use ISMB 300.',
    ]) {
      expect(
        warnings.some((w) => w.includes(expected)),
        expected,
      ).toBe(true);
    }
  });

  it('reports malformed input with line numbers', () => {
    const head = 'STAAD SPACE\nUNIT METER KN\n';
    const cases: Array<[string, string]> = [
      ['JOINT COORDINATES\n1 0 0 x', 'line 4: A joint line must contain only numbers.'],
      ['JOINT COORDINATES\n1 0 0 0 0', 'line 4: A joint line needs: number x y z'],
      ['JOINT COORDINATES\n1 0 0 0 4 3 0 0 2', 'line 4: Joint generation needs i2 > i1'],
      [
        'JOINT COORDINATES\n1 0 0 0\nREPEAT X 1 0 0',
        'line 5: REPEAT needs a number of repetitions.',
      ],
      ['JOINT COORDINATES\n1 0 0 0\nREPEAT 2 a 0 0', 'line 5: REPEAT increments must be numbers.'],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 3',
        'Member 1 refers to joint 3',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 1',
        'Member 1 starts and ends at joint 1.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1',
        'line 6: A member line needs',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n5 1 2 3',
        'line 6: Member generation needs',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nREPEAT 1 x',
        'line 7: REPEAT needs: n',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nMEMBER PROPERTY\n1 PRIS ZD 0.2',
        'line 8: PRIS needs YD',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nMEMBER PROPERTY\n1 PRIS YD x',
        'line 8: PRIS value YD must be a number.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nMEMBER PROPERTY\n1 PRIS YD -0.2 ZD 0.1',
        'line 8: PRIS section properties must be positive.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nCONSTANTS\nMATERIAL WOOD ALL',
        'line 8: Material WOOD is not defined.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nCONSTANTS\nE WOOD ALL',
        'line 8: E needs a value',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nSUPPORTS\n3 FIXED',
        'A support refers to joint 3',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nJOINT LOAD\n2 FY',
        'line 9: Joint load "FY" was not understood.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nJOINT LOAD\n3 FY 1',
        'line 9: A joint load refers to a joint that is not defined.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nMEMBER LOAD\n1 UNI',
        'line 9: Member load "1 UNI" was not understood.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nMEMBER LOAD\n1 UNI QQ 1',
        'line 9: Member load direction QQ is not supported.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nMEMBER LOAD\n2 UNI GY 1',
        'line 9: A member load refers to member 2',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nMEMBER LOAD\n1 UNI GY 1 0 2',
        'line 9: UNI load position is outside member 1.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nMEMBER LOAD\n1 UNI GY 1 0.8 0.2',
        'line 9: UNI load on member 1 ends before it starts.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nMEMBER LOAD\n1 CON GY 1 3',
        'line 9: CON load position is outside member 1.',
      ],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nLOAD 1\nMEMBER LOAD\n1 TRAP GY 1 1 0 3',
        'line 9: TRAP load position is outside member 1.',
      ],
      ['JOINT COORDINATES\n1 0 0 0', 'The file has no members.'],
      [
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nSUPPORTS\n1 TO 2000000 FIXED',
        'line 8: A list range is too long.',
      ],
    ];
    for (const [body, expected] of cases) {
      expect(errorsOf(head + body), body).toContain(expected);
    }
    const outside = importStaad(
      head +
        'JOINT COORDINATES\n1 0 0 0; 2 1 0 0\nMEMBER INCIDENCES\n1 1 2\nMEMBER LOAD\n1 UNI GY 1',
    );
    expect(outside.errors).toEqual([]);
    expect(outside.warnings.map(issueText)).toContain(
      'line 7: "MEMBER LOAD" outside a LOAD case is ignored.',
    );
    expect(errorsOf(beam('JOINT LOAD\n2 FY -1'), { loadCase: 7 })).toContain(
      'Load case 7 is not in the file.',
    );
    expect(
      errorsOf(
        beam('JOINT LOAD\n2 FY -1')
          .replace('STAAD PLANE', 'STAAD PLANE')
          .replace('2 6 0 0', '2 6 0 1'),
      ),
    ).toContain('Plane-frame mode needs every node at z = 0.');
  });

  it('lets options override the name and the plane-frame choice', () => {
    const p = ok(beam('JOINT LOAD\n2 FY -1'), { name: 'My beam', plane: 'none' }).project;
    expect(p.name).toBe('My beam');
    expect(p.plane).toBeUndefined();
    expect(p.description).toBe('Imported from STAAD.Pro');
  });

  it('recognises STAAD text', () => {
    expect(looksLikeStaad(sample('portal-frame.std'))).toBe(true);
    expect(looksLikeStaad('JOINT COORDINATES\n1 0 0 0')).toBe(true);
    expect(looksLikeStaad('[nodes]\nid,x,y')).toBe(false);
  });
});
