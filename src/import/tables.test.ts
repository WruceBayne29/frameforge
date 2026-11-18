import { describe, expect, it } from 'vitest';
import { getSection } from '../design-codes';
import { analyzeProject3D } from '../model3d/analysis';
import { issueText } from './common';
import type { ImportResult } from './common';
import { importBundle, importTables, looksLikeBundle, parseBundle } from './tables';

const I300 = (getSection('ISMB 300')?.Izz ?? 0) * 1e-8; // m⁴
const E = 200e6; // kN/m²

/** A simply supported 6 m beam in three pieces of 2 m, in metres and kN. */
const BEAM = {
  nodes: 'id,x,y,z\n1,0,0,0\n2,2,0,0\n3,4,0,0\n4,6,0,0',
  members: 'id,i,j,section\nM1,1,2,ISMB 300\nM2,2,3,ISMB 300\nM3,3,4,ISMB 300',
  supports: 'node,type\n1,pinned\n4,roller',
};

function ok(result: ImportResult) {
  expect(result.errors.map(issueText)).toEqual([]);
  expect(result.project).not.toBeNull();
  return result.project!;
}

const errorsOf = (result: ImportResult) => result.errors.map(issueText).join('\n');

describe('importTables', () => {
  it('builds a plane frame that matches closed-form beam theory', () => {
    const p = ok(
      importTables({
        ...BEAM,
        memberLoads: 'member,type,direction,w1\nM1,udl,GY,-10\nM2,udl,GY,-10\nM3,udl,GY,-10',
      }),
    );
    expect(p.plane).toBe('XY');
    expect(p.nodes).toHaveLength(4);
    const r = analyzeProject3D(p);
    expect(r.reactions['1'].fy).toBeCloseTo(30, 9);
    expect(r.reactions['4'].fy).toBeCloseTo(30, 9);
    // Deflection at x = 2 m of a simply supported beam under a UDL: w x (L³ − 2 L x² + x³) / 24 EI.
    const x = 2;
    const L = 6;
    const expected = (-10 * x * (L ** 3 - 2 * L * x ** 2 + x ** 3)) / (24 * E * I300);
    expect(r.displacements['2'].uy).toBeCloseTo(expected, 9);
  });

  it('gives the same answer in mm and N as in m and kN', () => {
    const si = ok(importTables({ ...BEAM, nodalLoads: 'node,fy,mz\n2,-12,3' }));
    const mm = ok(
      importTables(
        {
          nodes: 'id,x,y,z\n1,0,0,0\n2,2000,0,0\n3,4000,0,0\n4,6000,0,0',
          members: BEAM.members,
          supports: BEAM.supports,
          nodalLoads: 'node,fy,mz\n2,-12000,3000000',
        },
        { units: { length: 'mm', force: 'N' } },
      ),
    );
    expect(mm.nodes[3].x).toBeCloseTo(6, 12);
    const a = analyzeProject3D(si);
    const b = analyzeProject3D(mm);
    expect(b.displacements['3'].uy).toBeCloseTo(a.displacements['3'].uy, 12);
    expect(b.reactions['1'].fy).toBeCloseTo(a.reactions['1'].fy, 9);
  });

  it('converts member loads: point and moment loads are forces, not force per length', () => {
    const p = ok(
      importTables(
        {
          nodes: 'id,x,y\n1,0,0\n2,6000,0',
          members: 'id,i,j\nM1,1,2',
          supports: 'node,type\n1,pinned\n2,roller',
          memberLoads:
            'member,type,direction,w1,w2,a,b\n' +
            'M1,point,GY,-30000,,2000,\n' +
            'M1,moment,Z,6000000,,3000,\n' +
            'M1,linear,GY,0,-2,0,6000\n' +
            'M1,udl,Y,-1,,1000,4000',
        },
        { units: { length: 'mm', force: 'N' } },
      ),
    );
    const [point, moment, linear, udl] = p.loads;
    expect(point).toMatchObject({ kind: 'point', P: -30, a: 2, direction: 'globalY' });
    expect(moment).toMatchObject({ kind: 'moment', M: 6, a: 3, direction: 'localZ' });
    expect(linear).toMatchObject({ kind: 'distributed', w1: 0, w2: -2, direction: 'globalY' });
    expect(linear).not.toHaveProperty('a');
    expect(linear).not.toHaveProperty('b');
    expect(udl).toMatchObject({ kind: 'distributed', w1: -1, a: 1, b: 4, direction: 'localY' });
    // Statics: the point load gives 20 kN at node 1, the anticlockwise moment +1 kN, the triangle 2 kN, the
    // partial UDL 3 kN × 3.5 / 6.
    const r = analyzeProject3D(p);
    const expected = 30 * (4 / 6) + 6 / 6 + (6 * 2) / 2 / 3 + (3 * 3.5) / 6;
    expect(r.reactions['1'].fy).toBeCloseTo(expected, 8);
    expect(r.members.M1.length).toBeCloseTo(6, 12);
  });

  it('accepts header aliases, unit suffixes and other separators', () => {
    const p = ok(
      importTables({
        nodes: 'Node;X [mm];Y (mm);Z\nA;0;0;0\nB;2500,5;0;0\nC;2500,5;3000;0',
        members:
          'Element\tStart\tEnd\tProfile\tKind\tMat\nE1\tA\tB\tbox\tframe\tS355\nE2\tB\tC\tISMC300\tbar\tS355',
        sections: 'name,A_cm2,Iz (mm4),Iy cm4,J_cm4\nbox,40,10000000,500,200',
        materials: 'material,E_MPa,poisson,gamma\nS355,210000,0.3,78.5',
        supports: 'joint ux uy uz rx ry rz\nA 1 1 1 1 1 1\nC yes yes yes no no no',
        nodalLoads: 'Joint,Px,Py\nB,5,-10',
      }),
    );
    expect(p.nodes[1]).toEqual({ id: 'B', x: 2.5005, y: 0, z: 0 });
    expect(p.customSections).toHaveLength(1);
    expect(p.customSections[0]).toMatchObject({ name: 'box', A: 40, Iy: 500, J: 200 });
    expect(p.customSections[0].Iz).toBeCloseTo(1000, 9);
    expect(p.materials[0]).toEqual({ name: 'S355', E: 210, nu: 0.3, density: 78.5 });
    expect(p.members[0]).toMatchObject({
      id: 'E1',
      section: 'box',
      type: 'beam',
      material: 'S355',
    });
    expect(p.members[1]).toMatchObject({ section: 'ISMC 300', type: 'truss' });
    expect(p.supports).toEqual([
      { node: 'A', restraints: [true, true, true, true, true, true] },
      { node: 'C', restraints: [true, true, true, false, false, false] },
    ]);
    expect(p.loads[0]).toMatchObject({ kind: 'nodal', nodes: ['B'], fx: 5, fy: -10, fz: 0 });
  });

  it('reads plain section and material columns in the chosen units', () => {
    const p = ok(
      importTables(
        {
          nodes: '1,0,0,0\n2,1000,0,0',
          members: '1,1,2,R',
          sections: 'name,A,Iz,Iy,J\nR,5000,1e8,2e7,3e7',
          materials: 'name,E,nu,density\nC30,30000,0.2,2.5e-5',
          supports: 'node,type\n1,fixed',
        },
        { units: { length: 'mm', force: 'N' } },
      ),
    );
    const s = p.customSections[0];
    expect(s.name).toBe('R');
    for (const [key, value] of [
      ['A', 50],
      ['Iz', 1e4],
      ['Iy', 2e3],
      ['J', 3e3],
    ] as const) {
      expect(s[key]).toBeCloseTo(value, 9);
    }
    expect(p.materials[0].E).toBeCloseTo(30, 12);
    expect(p.materials[0].density).toBeCloseTo(25, 9);
  });

  it('reads tables without a header in the default column order, with a warning', () => {
    const result = importTables({ nodes: '1,0,0,0\n2,3,0,0', members: '1,1,2,ISMB 200,truss' });
    const p = ok(result);
    expect(p.members[0]).toMatchObject({ section: 'ISMB 200', type: 'truss' });
    expect(result.warnings.map(issueText)).toContain(
      'nodes line 1: No header row found; reading columns as id, x, y, z.',
    );
  });

  it('parses releases, roll angles and effective length factors', () => {
    const p = ok(
      importTables({
        nodes: BEAM.nodes,
        members:
          'id,i,j,section,beta,release_i,release_j,kz,ky\n' +
          'M1,1,2,ISMB 300,90,pinned,,1.2,0.8\n' +
          'M2,2,3,ISMB 300,0,my+mz,mz,,\n' +
          'M3,3,4,ISMB 300,,none,fx mx,,',
        supports: BEAM.supports,
      }),
    );
    expect(p.members[0]).toMatchObject({
      beta: 90,
      releaseI: { my: true, mz: true },
      kz: 1.2,
      ky: 0.8,
    });
    expect(p.members[0]).not.toHaveProperty('releaseJ');
    expect(p.members[1]).not.toHaveProperty('beta');
    expect(p.members[1]).toMatchObject({
      releaseI: { my: true, mz: true },
      releaseJ: { mz: true },
    });
    expect(p.members[2]).toMatchObject({ releaseJ: { fx: true, mx: true } });
  });

  it('chooses plane-frame mode only when it is safe, or as asked', () => {
    // Out-of-plane load: stays 3D, but plane mode is suggested.
    const outOfPlane = importTables({ ...BEAM, nodalLoads: 'node,fz\n2,-1' });
    expect(outOfPlane.project?.plane).toBeUndefined();
    expect(outOfPlane.planeSuggested).toBe(true);
    expect(importTables(BEAM, { plane: 'none' }).project?.plane).toBeUndefined();
    expect(
      importTables({ ...BEAM, nodalLoads: 'node,fz\n2,-1' }, { plane: 'XY' }).project?.plane,
    ).toBe('XY');
    // A node off the plane: no plane mode, and asking for it is an error.
    const lifted = { ...BEAM, nodes: BEAM.nodes.replace('3,4,0,0', '3,4,0,1') };
    const space = importTables(lifted);
    expect(space.project?.plane).toBeUndefined();
    expect(space.planeSuggested).toBe(false);
    expect(errorsOf(importTables(lifted, { plane: 'XY' }))).toMatch(/every node at z = 0/);
  });

  it('applies options: name and self-weight', () => {
    const p = ok(importTables(BEAM, { name: '  Roof beam ', selfWeight: true }));
    expect(p.name).toBe('Roof beam');
    expect(p.selfWeight).toBe(true);
    expect(ok(importTables(BEAM)).name).toBe('Imported model');
  });

  it('warns about unused columns, skipped rows and defaulted sections', () => {
    const result = importTables({
      nodes: 'id,x,y,colour\n1,0,0,red\n2,4,0,blue',
      members: 'id,i,j,id\n1,1,2,x',
      supports: 'node,type,ux\n1,fixed,\n1,pinned,\n2,,0',
      nodalLoads: 'node,fy\n2,0',
    });
    ok(result);
    const warnings = result.warnings.map(issueText);
    expect(warnings).toContain('nodes line 1: Column "colour" is not used.');
    expect(warnings).toContain('members line 1: Column "id" repeats id; the first one is used.');
    expect(warnings).toContain(
      'supports line 3: Node "1" already has a support; this row is skipped.',
    );
    expect(warnings).toContain(
      'supports line 4: Support at node "2" restrains nothing and is skipped.',
    );
    expect(warnings).toContain('nodal loads line 2: Load at node "2" is zero and is skipped.');
    expect(warnings).toContain('members: 1 member(s) had no section and use ISMB 300.');
  });

  it('reports malformed input with table and line numbers', () => {
    const result = importTables({
      nodes: 'id,x,y,z\n1,0,0,0\n1,1,0,0\n2,abc,0,0\n,0,0,0\n3,4,0,0\n4,4,0,0',
      members:
        'id,i,j,section,type,material,beta,release_i,kz\n' +
        'M1,1,9,,,,,,\n' +
        'M2,3,4,,,,,,\n' +
        'M3,1,3,W12X26,,,,,\n' +
        'M4,1,3,,cable,,,,\n' +
        'M5,1,3,,,Timber,,,\n' +
        'M6,1,3,,,,abc,,\n' +
        'M7,1,3,,,,,xyz,\n' +
        'M8,1,3,,,,,,-1\n' +
        ',1,3,,,,,,\n' +
        'M9,1,3,,,,,,\n' +
        'M9,1,4,,,,,,',
      supports: 'node,type,ux\n7,fixed,\n1,clamp,\n3,,maybe',
      nodalLoads: 'node,fx\n8,1\n1,abc',
      memberLoads:
        'member,type,direction,w1,w2,a,b\n' +
        'M0,udl,GY,1,,,\n' +
        'M9,wind,GY,1,,,\n' +
        'M9,udl,up,1,,,\n' +
        'M9,udl,GY,abc,,,\n' +
        'M9,udl,GY,1,,5,\n' +
        'M9,udl,GY,1,,3,1\n' +
        'M9,point,GY,1,,,\n' +
        'M9,linear,GY,1,,,',
      sections: 'name,A,Iz,Iy,J\n,1,1,1,1\nS,1,1,1,1\nS,1,1,1,1\nT,0,1,1,1',
      materials: 'name,E,nu,density\n,1,,\nM,1,,\nM,1,,\nN,-1,,\nP,1,0.6,\nQ,1,0.3,-1',
    });
    expect(result.project).toBeNull();
    const text = errorsOf(result);
    for (const expected of [
      'nodes line 3: Node "1" is listed twice.',
      'nodes line 4: Node "2" needs numeric x, y and z.',
      'nodes line 5: Missing node id.',
      'members line 2: Member "M1" refers to node "9", which is not in the nodes table.',
      'members line 3: Member "M2" has zero length',
      'members line 4: Section "W12X26" of member "M3" is not a built-in section',
      'members line 5: Member "M4" has type "cable"; use beam or truss.',
      'members line 6: Material "Timber" of member "M5" is not in the materials table.',
      'members line 7: Member "M6" needs a numeric roll angle',
      'members line 8: Member "M7" start release "xyz" is not understood',
      'members line 9: Member "M8" needs a positive effective length factor kz.',
      'members line 10: Missing member id.',
      'members line 12: Member "M9" is listed twice.',
      'supports line 2: Support at node "7", which is not in the nodes table.',
      'supports line 3: Support type "clamp" is not understood',
      'supports line 4: Restraint "maybe" is not understood',
      'nodal loads line 2: Load at node "8", which is not in the nodes table.',
      'nodal loads line 3: Load at node "1" has a value that is not a number.',
      'member loads line 2: Load on member "M0", which is not in the members table.',
      'member loads line 3: Load type "wind" is not understood',
      'member loads line 4: Direction "up" is not understood',
      'member loads line 5: Load on member "M9" has a value that is not a number.',
      'member loads line 6: Load position on member "M9" must lie between 0 and its length 4 m',
      'member loads line 7: Load position on member "M9" must lie between 0 and its length 4 m',
      'member loads line 8: A point load on member "M9" needs its position a.',
      'member loads line 9: A linear load on member "M9" needs w2.',
      'sections line 2: Missing section name.',
      'sections line 4: Section "S" is listed twice.',
      'sections line 5: Section "T" needs positive A, Iz, Iy and J.',
      'materials line 2: Missing material name.',
      'materials line 4: Material "M" is listed twice.',
      'materials line 5: Material "N" needs a positive E.',
      'materials line 6: Material "P" needs a Poisson\'s ratio between -1 and 0.5.',
      'materials line 7: Material "Q" needs a density of zero or more.',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('reports missing columns, unknown units and empty tables', () => {
    expect(errorsOf(importTables({ nodes: 'id,x\n1,0', members: 'id,i,j\n1,1,1' }))).toContain(
      'nodes line 1: Missing column "y".',
    );
    expect(errorsOf(importTables({ nodes: 'id,x (furlong),y\n1,0,0' }))).toContain(
      'nodes line 1: Unknown unit "furlong" in column "x (furlong)".',
    );
    expect(errorsOf(importTables({}))).toContain('nodes: The nodes table is empty.');
    expect(errorsOf(importTables({ nodes: 'id,x,y\n1,0,0' }))).toContain(
      'members: There are no members to analyse.',
    );
  });

  it('reports a model the project validation rejects', () => {
    // Ids are limited to 200 characters by the project file validation.
    const id = 'n'.repeat(300);
    const result = importTables({
      nodes: `id,x,y\n${id},0,0\n2,1,0`,
      members: `id,i,j\n1,${id},2`,
    });
    expect(result.project).toBeNull();
    expect(errorsOf(result)).toMatch(/short text value/);
  });
});

describe('CSV bundles', () => {
  const BUNDLE = `# a bundle
[settings]
key,value
length,mm
force,N
name,Bundle beam
plane,auto
selfweight,yes

[nodes]
id,x,y
1,0,0
2,4000,0
[members]
id,i,j,section
1,1,2,ISMB 300
[supports]
node,type
1,fixed
[nodal loads]
node,fy
2,-10000
[member loads]
member,type,direction,w1
1,udl,GY,-5
[sections]
name,A,Iz,Iy,J
[materials]
name,E
Steel,200000
`;

  it('splits a bundle into tables and settings', () => {
    const b = parseBundle(BUNDLE);
    expect(b.errors).toEqual([]);
    expect(b.options).toEqual({
      units: { length: 'mm', force: 'N' },
      name: 'Bundle beam',
      plane: 'auto',
      selfWeight: true,
    });
    expect(Object.keys(b.tables).sort()).toEqual(
      ['materials', 'memberLoads', 'members', 'nodalLoads', 'nodes', 'sections', 'supports'].sort(),
    );
    expect(looksLikeBundle(BUNDLE)).toBe(true);
    expect(looksLikeBundle('id,x,y')).toBe(false);
  });

  it('imports a bundle with line numbers of the whole file', () => {
    const result = importBundle(BUNDLE);
    const p = ok(result);
    expect(p.name).toBe('Bundle beam');
    expect(p.selfWeight).toBe(true);
    expect(p.loads[1]).toMatchObject({ kind: 'distributed', w1: -5 });
    const r = analyzeProject3D({ ...p, selfWeight: false });
    // Cantilever: tip load 10 kN and a UDL of 5 kN/m over 4 m.
    expect(r.reactions['1'].fy).toBeCloseTo(10 + 20, 9);
    const broken = importBundle(BUNDLE.replace('2,-10000', '9,-10000'));
    expect(errorsOf(broken)).toContain('nodal loads line 22: Load at node "9"');
  });

  it('lets options override the bundle settings', () => {
    const p = ok(importBundle(BUNDLE, { name: 'Other', units: { force: 'kN' } }));
    expect(p.name).toBe('Other');
    expect(p.loads[0]).toMatchObject({ fy: -10000 });
  });

  it('reports unknown tables, settings and stray text', () => {
    const result = importBundle(
      'stray\n[nodes]\nid,x,y\n1,0,0\n[wind]\nx\n[settings]\nlength,km\ncolour,red',
    );
    expect(result.project).toBeNull();
    const text = errorsOf(result);
    expect(text).toContain('bundle line 1: Text before the first [table] heading.');
    expect(text).toContain('bundle line 5: Unknown table [wind].');
    expect(text).toContain('settings line 8: Setting "length,km" is not understood.');
    expect(text).toContain('settings line 9: Setting "colour,red" is not understood.');
  });
});
