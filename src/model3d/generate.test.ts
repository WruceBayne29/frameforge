import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples';
import { buildProject } from '../examples/builder';
import { toSolverModel } from '../model';
import type { Project } from '../model/types';
import { analyze } from '../solver';
import { analyze3d } from '../solver3d';
import type { AnalysisResult3D } from '../solver3d';
import { analyzeProject3D } from './analysis';
import { toSolverModel3D } from './convert';
import { addLoad, addNode } from './edit';
import { BLOCK_FACE, from2D, gridFrame, plateMesh, solidBlock, STEEL_MASS_2D } from './generate';
import { emptyProject3D, FIXED_SUPPORT, GRAVITY, PINNED_SUPPORT } from './types';
import type { Project3D } from './types';

const nodeOf = (p: Project3D, id: string) => {
  const n = p.nodes.find((node) => node.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};

describe('gridFrame', () => {
  const options = {
    baysX: 2,
    baysZ: 1,
    storeys: 3,
    bayWidthX: 6,
    bayWidthZ: 5,
    storeyHeight: 3,
  };

  it('creates the expected nodes, columns, beams and bases', () => {
    const p0 = emptyProject3D();
    const f = gridFrame(p0, { ...options, columnSection: 'ISMB 400', beamSection: 'ISMB 350' });
    expect(p0.nodes).toHaveLength(0);
    expect(f.nodes).toHaveLength(3 * 2 * 4);
    expect(f.columns).toHaveLength(3 * 2 * 3);
    expect(f.beamsX).toHaveLength(2 * 2 * 3);
    expect(f.beamsZ).toHaveLength(3 * 1 * 3);
    expect(f.members).toHaveLength(18 + 12 + 9);
    expect(f.floorBeams.map((b) => b.length)).toEqual([7, 7, 7]);
    expect(f.plates).toEqual([]);
    expect(f.solids).toEqual([]);
    expect(nodeOf(f.project, f.grid[3][2][1])).toMatchObject({ x: 12, y: 9, z: 5 });
    const byId = new Map(f.project.members.map((m) => [m.id, m]));
    for (const id of f.columns) {
      const m = byId.get(id);
      expect(m?.section).toBe('ISMB 400');
      // columns run upwards
      expect(nodeOf(f.project, m?.j ?? '').y - nodeOf(f.project, m?.i ?? '').y).toBeCloseTo(3, 12);
    }
    for (const id of f.beamsX) {
      const m = byId.get(id);
      expect(m?.section).toBe('ISMB 350');
      expect(nodeOf(f.project, m?.j ?? '').x - nodeOf(f.project, m?.i ?? '').x).toBeCloseTo(6, 12);
    }
    for (const id of f.beamsZ) {
      const m = byId.get(id);
      expect(nodeOf(f.project, m?.j ?? '').z - nodeOf(f.project, m?.i ?? '').z).toBeCloseTo(5, 12);
    }
    expect(f.project.supports).toHaveLength(6);
    expect(f.project.supports.every((s) => s.restraints.every(Boolean))).toBe(true);
    expect(f.project.supports.map((s) => s.node).sort()).toEqual(f.grid[0].flat().sort());
  });

  it('supports pinned bases, an origin, a plane frame (baysZ = 0) and validates input', () => {
    const f = gridFrame(emptyProject3D(), {
      ...options,
      baysZ: 0,
      origin: [1, 2, 3],
      fixedBases: false,
      material: 'Concrete M25',
    });
    expect(f.nodes).toHaveLength(3 * 4);
    expect(f.beamsZ).toEqual([]);
    expect(f.project.nodes.every((n) => n.z === 3)).toBe(true);
    expect(nodeOf(f.project, f.grid[0][0][0])).toMatchObject({ x: 1, y: 2, z: 3 });
    expect(f.project.supports[0].restraints).toEqual(PINNED_SUPPORT);
    expect(f.project.members.every((m) => m.material === 'Concrete M25')).toBe(true);
    expect(() => gridFrame(emptyProject3D(), { ...options, baysX: 0 })).toThrow(RangeError);
    expect(() => gridFrame(emptyProject3D(), { ...options, storeys: 1.5 })).toThrow(RangeError);
    expect(() => gridFrame(emptyProject3D(), { ...options, storeyHeight: 0 })).toThrow(RangeError);
  });

  it('merges with coincident existing nodes and members when frames are joined', () => {
    const first = gridFrame(emptyProject3D(), { ...options, baysX: 1, storeys: 1 });
    // a second frame sharing the x = 6 column line
    const second = gridFrame(first.project, {
      ...options,
      baysX: 1,
      storeys: 1,
      origin: [6, 0, 0],
    });
    expect(first.nodes).toHaveLength(8);
    expect(second.nodes).toHaveLength(4);
    expect(second.project.nodes).toHaveLength(12);
    // shared: two columns and one Z beam
    expect(second.members).toHaveLength(first.members.length - 3);
    expect(second.columns).toHaveLength(4);
    expect(new Set(second.project.members.map((m) => m.id)).size).toBe(
      second.project.members.length,
    );
    expect(second.project.supports).toHaveLength(6);
    const result = analyze3d(toSolverModel3D({ ...second.project, selfWeight: true }));
    expect(result.warnings).toEqual([]);
    expect(result.equilibrium.every((v) => Math.abs(v) < 1e-8)).toBe(true);
  });

  it('a plane portal made by gridFrame sways exactly like the same portal in the 2D solver', () => {
    const f = gridFrame(emptyProject3D(), {
      baysX: 1,
      baysZ: 0,
      storeys: 1,
      bayWidthX: 6,
      bayWidthZ: 1,
      storeyHeight: 4,
    });
    const loaded = addLoad(f.project, {
      kind: 'nodal',
      nodes: [f.grid[1][0][0]],
      fx: 50,
      fy: 0,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    }).project;
    const r3 = analyze3d(toSolverModel3D(loaded));
    const p2 = buildProject('portal', '', (b) => {
      const a = b.node(0, 0);
      const bb = b.node(0, 4);
      const c = b.node(6, 4);
      const d = b.node(6, 0);
      b.member(a, bb, 'ISMB 300');
      b.member(bb, c, 'ISMB 300');
      b.member(d, c, 'ISMB 300');
      b.support(a, 'fixed');
      b.support(d, 'fixed');
      b.nodal(bb, 50, 0);
    });
    const r2 = analyze(toSolverModel(p2));
    expect(r3.displacements[f.grid[1][0][0]].ux).toBeCloseTo(r2.displacements.N2.ux, 10);
    expect(r3.displacements[f.grid[1][1][0]].uy).toBeCloseTo(r2.displacements.N3.uy, 10);
  });
});

describe('plateMesh', () => {
  it('maps the corners bilinearly and orders every plate like the corners', () => {
    const p0 = emptyProject3D();
    const mesh = plateMesh(p0, {
      corners: [
        [0, 0, 0],
        [4, 0, 0],
        [5, 2, 3],
        [0, 0, 3],
      ],
      nx: 4,
      ny: 3,
      thickness: 200,
      material: 'Concrete M25',
    });
    expect(mesh.nodes).toHaveLength(5 * 4);
    expect(mesh.plates).toHaveLength(12);
    expect(mesh.plateGrid.flat()).toEqual(mesh.plates);
    expect(nodeOf(mesh.project, mesh.grid[0][0])).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(nodeOf(mesh.project, mesh.grid[4][0])).toMatchObject({ x: 4, y: 0, z: 0 });
    expect(nodeOf(mesh.project, mesh.grid[4][3])).toMatchObject({ x: 5, y: 2, z: 3 });
    expect(nodeOf(mesh.project, mesh.grid[0][3])).toMatchObject({ x: 0, y: 0, z: 3 });
    // centre of the bilinear patch = mean of the corners
    const mid = plateMesh(p0, {
      corners: [
        [0, 0, 0],
        [4, 0, 0],
        [5, 2, 3],
        [0, 0, 3],
      ],
      nx: 2,
      ny: 2,
    });
    const c = nodeOf(mid.project, mid.grid[1][1]);
    expect([c.x, c.y, c.z]).toEqual([2.25, 0.5, 1.5]);
    expect(mid.project.plates[0]).toMatchObject({ thickness: 150, material: 'Steel' });
    expect(mesh.project.plates[0]).toMatchObject({ thickness: 200, material: 'Concrete M25' });
    const first = mesh.project.plates[0].nodes;
    expect(first).toEqual([mesh.grid[0][0], mesh.grid[1][0], mesh.grid[1][1], mesh.grid[0][1]]);
  });

  it('gives every plate the normal (c2 − c1) × (c4 − c1), checked through the solver', () => {
    // corners counter-clockwise seen from above → local z = +Y for every plate
    const up = plateMesh(emptyProject3D(), {
      corners: [
        [0, 0, 0],
        [0, 0, 2],
        [3, 0, 2],
        [3, 0, 0],
      ],
      nx: 2,
      ny: 3,
    });
    let p = up.project;
    for (const row of up.grid) {
      for (const id of row)
        p = { ...p, supports: [...p.supports, { node: id, restraints: [...FIXED_SUPPORT] }] };
    }
    // every node is fixed, so only the plate axes and the load resultant are checked
    p = addLoad(p, { kind: 'pressure', plates: up.plates, direction: 'localZ', p: 2 }).project;
    const result = analyze3d(toSolverModel3D(p));
    for (const plate of Object.values(result.plates)) {
      expect(plate.axes.z[1]).toBeCloseTo(1, 12);
      expect(plate.area).toBeCloseTo(1, 12);
    }
    expect(result.appliedLoad[1]).toBeCloseTo(2 * 6, 10);
  });

  it('merges coincident nodes with an existing mesh and skips duplicate plates', () => {
    const a = plateMesh(emptyProject3D(), {
      corners: [
        [0, 0, 0],
        [0, 0, 2],
        [2, 0, 2],
        [2, 0, 0],
      ],
      nx: 2,
      ny: 2,
    });
    const b = plateMesh(a.project, {
      corners: [
        [2, 0, 0],
        [2, 0, 2],
        [4, 0, 2],
        [4, 0, 0],
      ],
      nx: 2,
      ny: 2,
    });
    expect(b.nodes).toHaveLength(6);
    expect(b.project.nodes).toHaveLength(15);
    expect(b.plates).toHaveLength(4);
    const again = plateMesh(b.project, {
      corners: [
        [0, 0, 0],
        [0, 0, 2],
        [2, 0, 2],
        [2, 0, 0],
      ],
      nx: 2,
      ny: 2,
    });
    expect(again.nodes).toEqual([]);
    expect(again.plates).toEqual([]);
    expect(again.plateGrid).toEqual(a.plateGrid);
    expect(again.project.plates).toHaveLength(8);
    expect(() =>
      plateMesh(a.project, {
        corners: [
          [0, 0, 0],
          [0, 0, 2],
          [2, 0, 2],
          [2, 0, 0],
        ],
        nx: 0,
        ny: 1,
      }),
    ).toThrow(RangeError);
  });
});

describe('solidBlock', () => {
  it('creates a block whose solids all have a positive Jacobian (the solver accepts them)', () => {
    const p0 = emptyProject3D();
    const block = solidBlock(p0, {
      origin: [1, 2, 3],
      size: [2, 1, 3],
      divisions: [2, 1, 3],
      material: 'Concrete M25',
    });
    expect(block.nodes).toHaveLength(3 * 2 * 4);
    expect(block.solids).toHaveLength(6);
    expect(block.solidGrid.flat(2)).toEqual(block.solids);
    expect(nodeOf(block.project, block.grid[0][0][0])).toMatchObject({ x: 1, y: 2, z: 3 });
    expect(nodeOf(block.project, block.grid[2][1][3])).toMatchObject({ x: 3, y: 3, z: 6 });
    expect(block.boundary.yMin.nodes).toHaveLength(12);
    expect(block.boundary.xMin.nodes).toHaveLength(8);
    expect(block.boundary.zMax.solids).toHaveLength(2);
    expect(block.boundary.yMax.solids).toHaveLength(6);

    let p = block.project;
    p = {
      ...p,
      supports: block.boundary.yMin.nodes.map((node) => ({
        node,
        restraints: [...PINNED_SUPPORT],
      })),
      selfWeight: true,
    };
    const result = analyze3d(toSolverModel3D(p));
    const volume = Object.values(result.solids).reduce((s, r) => s + r.volume, 0);
    expect(volume).toBeCloseTo(6, 10);
    expect(result.appliedLoad[1]).toBeCloseTo(-25 * 6, 9);
    expect(result.equilibrium.every((v) => Math.abs(v) < 1e-8)).toBe(true);
  });

  it('numbers the faces as documented: a unit pressure on each side pushes inwards', () => {
    const block = solidBlock(emptyProject3D(), { size: [2, 3, 4], divisions: [2, 2, 2] });
    const supports = block.project.nodes.map((n) => ({
      node: n.id,
      restraints: [...PINNED_SUPPORT] as typeof PINNED_SUPPORT,
    }));
    const expected = {
      xMin: [3 * 4, 0, 0],
      xMax: [-3 * 4, 0, 0],
      yMin: [0, 2 * 4, 0],
      yMax: [0, -2 * 4, 0],
      zMin: [0, 0, 2 * 3],
      zMax: [0, 0, -2 * 3],
    } as const;
    for (const side of Object.keys(expected) as Array<keyof typeof expected>) {
      const b = block.boundary[side];
      expect(b.face).toBe(BLOCK_FACE[side]);
      expect(b.solids).toHaveLength(4);
      const p = addLoad(
        { ...block.project, supports },
        { kind: 'face', solids: b.solids, face: b.face, direction: 'normal', p: 1 },
      ).project;
      const applied = analyze3d(toSolverModel3D(p)).appliedLoad;
      expected[side].forEach((v, k) => expect(applied[k]).toBeCloseTo(v, 10));
    }
  });

  it('merges with existing nodes, so stacked blocks share a face', () => {
    const lower = solidBlock(emptyProject3D(), { size: [1, 1, 1], divisions: [2, 2, 2] });
    const upper = solidBlock(lower.project, {
      origin: [0, 1, 0],
      size: [1, 1, 1],
      divisions: [2, 2, 2],
    });
    expect(upper.nodes).toHaveLength(27 - 9);
    expect(upper.project.solids).toHaveLength(16);
    // a node placed by hand on the block is reused too
    const withNode = addNode(emptyProject3D(), 0.5, 0, 0.5).project;
    const block = solidBlock(withNode, { size: [1, 1, 1], divisions: [2, 1, 2] });
    expect(block.grid[1][0][1]).toBe('N1');
    expect(() => solidBlock(emptyProject3D(), { size: [1, 0, 1], divisions: [1, 1, 1] })).toThrow(
      RangeError,
    );
    expect(() => solidBlock(emptyProject3D(), { size: [1, 1, 1], divisions: [1, 0, 1] })).toThrow(
      RangeError,
    );
  });
});

// ---------------------------------------------------------------------------------------
// from2D: the converted project must analyse to the same in-plane result as the 2D solver
// ---------------------------------------------------------------------------------------

function compare(project: Project): { warnings: string[] } {
  const converted = from2D(project);
  expect(converted.plane).toBe('XY');
  // Without the plane restraint the supports alone hold the model out of plane.
  const free: Project3D = { ...converted };
  delete free.plane;
  compareWith(project, analyze3d(toSolverModel3D(free)));
  return compareWith(project, analyzeProject3D(converted));
}

function compareWith(project: Project, r3: AnalysisResult3D): { warnings: string[] } {
  const r2 = analyze(toSolverModel(project));

  // Largest translation anywhere (nodes and along members) sets the comparison scale.
  const scaleU = r2.maxDisplacement;
  let scaleR = 0;
  for (const r of Object.values(r2.reactions))
    scaleR = Math.max(scaleR, Math.abs(r.fx), Math.abs(r.fy));
  expect(scaleU).toBeGreaterThan(0);
  const tolU = 1e-8 * scaleU;
  const tolR = 1e-8 * Math.max(scaleR, 1);

  const framed = new Set<string>();
  for (const m of project.members) {
    if (m.type === 'frame') framed.add(m.i).add(m.j);
  }
  for (const node of project.nodes) {
    const a = r2.displacements[node.id];
    const b = r3.displacements[node.id];
    expect(Math.abs(a.ux - b.ux), `${node.id} ux`).toBeLessThan(tolU);
    expect(Math.abs(a.uy - b.uy), `${node.id} uy`).toBeLessThan(tolU);
    expect(Math.abs(b.uz), `${node.id} uz`).toBeLessThan(tolU);
    expect(Math.abs(b.rx) + Math.abs(b.ry), `${node.id} rx, ry`).toBeLessThan(tolU);
    // joint rotations exist in both models only where a frame member meets the node
    if (framed.has(node.id)) expect(Math.abs(a.rz - b.rz), `${node.id} rz`).toBeLessThan(tolU);
  }
  expect(Object.keys(r3.reactions).sort()).toEqual(Object.keys(r2.reactions).sort());
  for (const [node, a] of Object.entries(r2.reactions)) {
    const b = r3.reactions[node];
    expect(Math.abs(a.fx - b.fx), `${node} Rx`).toBeLessThan(tolR);
    expect(Math.abs(a.fy - b.fy), `${node} Ry`).toBeLessThan(tolR);
    expect(Math.abs(a.mz - b.mz), `${node} Mz`).toBeLessThan(tolR);
    expect(Math.abs(b.fz) + Math.abs(b.mx) + Math.abs(b.my), `${node} out of plane`).toBeLessThan(
      tolR,
    );
  }
  for (const m of project.members) {
    const a = r2.members[m.id];
    const b = r3.members[m.id];
    expect(Math.abs(a.maxAxial.value - b.maxAxial.value), `${m.id} N+`).toBeLessThan(tolR);
    expect(Math.abs(a.minAxial.value - b.minAxial.value), `${m.id} N−`).toBeLessThan(tolR);
    expect(
      Math.abs(Math.abs(a.maxAbsShear.value) - Math.abs(b.maxAbsVy.value)),
      `${m.id} V`,
    ).toBeLessThan(tolR);
    expect(
      Math.abs(Math.abs(a.maxAbsMoment.value) - Math.abs(b.maxAbsMz.value)),
      `${m.id} M`,
    ).toBeLessThan(tolR);
    expect(Math.abs(b.maxAbsVz.value) + Math.abs(b.maxAbsMy.value)).toBeLessThan(tolR);
  }
  expect(Math.abs(r2.maxDisplacement - r3.maxDisplacement)).toBeLessThan(tolU);
  return { warnings: r3.warnings };
}

describe('from2D', () => {
  it('maps members, sections, supports and loads into the z = 0 plane', () => {
    const p2 = buildProject('Mixed', 'desc', (b) => {
      b.custom({ name: 'Box', A: 80, I: 7000 });
      const a = b.node(0, 0);
      const c = b.node(4, 3);
      const d = b.node(8, 0);
      const e = b.node(8, 5);
      b.member(a, c, 'Box', 'frame', { j: true });
      b.member(d, c, 'ISMB 300', 'frame', { i: true });
      b.member(c, e, 'ISMC 150', 'truss');
      b.support(a, 'fixed');
      b.support(d, 'pinned');
      b.support(e, 'rollerX');
      b.nodal(c, 3, -4, 5);
      b.udl('M1', 2, 'localY');
      b.udl('M2', 2, 'localY');
      b.point('M2', 7, 1, 'localY');
      b.point('M2', 7, 1, 'localX');
      b.design({ grade: 'E350' });
    });
    p2.E = 210;
    p2.loads.push({ id: 'L9', kind: 'moment', member: 'M2', M: 6, a: 2 });
    p2.loads.push({
      id: 'L10',
      kind: 'distributed',
      member: 'M2',
      direction: 'localY',
      w1: 1,
      w2: 3,
      a: 1,
      b: 4,
    });
    p2.supports.push({ node: 'N9', kind: 'rollerY' });
    const p3 = from2D(p2);
    expect(p3).toMatchObject({
      kind: 'space',
      version: 1,
      name: 'Mixed',
      description: 'desc',
      selfWeight: false,
    });
    expect(p3.design.grade).toBe('E350');
    expect(p3.plane).toBe('XY');
    expect(p3.materials[0]).toEqual({
      name: 'Steel',
      E: 210,
      nu: 0.3,
      density: STEEL_MASS_2D * GRAVITY,
    });
    expect(p3.customSections).toEqual([{ name: 'Box', A: 80, Iz: 7000, Iy: 7000, J: 7000 }]);
    expect(p3.nodes.every((n) => n.z === 0)).toBe(true);
    expect(p3.members).toEqual([
      {
        id: 'M1',
        i: 'N1',
        j: 'N2',
        type: 'beam',
        section: 'Box',
        material: 'Steel',
        releaseJ: { mz: true },
      },
      {
        id: 'M2',
        i: 'N3',
        j: 'N2',
        type: 'beam',
        section: 'ISMB 300',
        material: 'Steel',
        releaseI: { mz: true },
      },
      { id: 'M3', i: 'N2', j: 'N4', type: 'truss', section: 'ISMC 150', material: 'Steel' },
    ]);
    expect(p3.supports).toEqual([
      { node: 'N1', restraints: [true, true, true, true, true, true] },
      { node: 'N3', restraints: [true, true, true, true, true, false] },
      { node: 'N4', restraints: [false, true, true, true, true, false] },
      { node: 'N9', restraints: [true, false, true, true, true, false] },
    ]);
    const byId = new Map(p3.loads.map((l) => [l.id, l]));
    expect(byId.get('L1')).toEqual({
      id: 'L1',
      kind: 'nodal',
      nodes: ['N2'],
      fx: 3,
      fy: -4,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 5,
    });
    // M1 runs left to right: local y unchanged. M2 runs right to left: local y flips.
    expect(byId.get('L2')).toMatchObject({ members: ['M1'], direction: 'localY', w1: 2 });
    expect(byId.get('L3')).toMatchObject({ members: ['M2'], direction: 'localY', w1: -2 });
    expect(byId.get('L4')).toMatchObject({ kind: 'point', direction: 'localY', P: -7, a: 1 });
    expect(byId.get('L5')).toMatchObject({ kind: 'point', direction: 'localX', P: 7, a: 1 });
    expect(byId.get('L9')).toEqual({
      id: 'L9',
      kind: 'moment',
      members: ['M2'],
      direction: 'globalZ',
      M: 6,
      a: 2,
    });
    expect(byId.get('L10')).toEqual({
      id: 'L10',
      kind: 'distributed',
      members: ['M2'],
      direction: 'localY',
      w1: -1,
      w2: -3,
      a: 1,
      b: 4,
    });
  });

  for (const example of EXAMPLES) {
    it(`${example.name}: same displacements, reactions and member forces as the 2D solver`, () => {
      const { warnings } = compare(example.build());
      // only "held automatically" notes for out-of-plane freedoms are acceptable
      for (const w of warnings) expect(w).toMatch(/held automatically/);
    });
  }

  it('members drawn in every direction with local loads, member moments and releases', () => {
    const p2 = buildProject('Directions', '', (b) => {
      const a = b.node(0, 0);
      const c = b.node(0, 4); // up
      const d = b.node(5, 6); // up-right
      const e = b.node(10, 4);
      const f = b.node(10, 0);
      const g = b.node(5, 0);
      b.member(a, c, 'ISMB 300'); // M1 vertical up
      b.member(d, c, 'ISMB 300'); // M2 right-to-left, sloping
      b.member(e, d, 'ISMB 300', 'frame', { i: true }); // M3 right-to-left with a hinge
      b.member(e, f, 'ISMB 300'); // M4 vertical down
      b.member(g, d, 'ISMB 250', 'frame', { j: true }); // M5 vertical prop, hinged at the top
      b.member(g, c, 'ISMC 150', 'truss'); // M6 right-to-left truss
      b.support(a, 'fixed');
      b.support(f, 'pinned');
      b.support(g, 'rollerX');
      for (const m of ['M1', 'M2', 'M3', 'M4', 'M5']) {
        b.udl(m, 3, 'localY');
        b.point(m, 5, 1.5, 'localY');
        b.udl(m, 1.5, 'localX');
      }
      b.udl('M2', 4);
      b.point('M3', 9, 2, 'globalX');
      b.nodal(d, 10, -20, 15);
    });
    p2.loads.push(
      { id: 'X1', kind: 'moment', member: 'M2', M: 12, a: 2 },
      { id: 'X2', kind: 'moment', member: 'M4', M: -8, a: 1 },
      { id: 'X3', kind: 'moment', member: 'M1', M: 7, a: 3 },
      {
        id: 'X4',
        kind: 'distributed',
        member: 'M3',
        direction: 'localY',
        w1: 2,
        w2: 6,
        a: 1,
        b: 4,
      },
      { id: 'X5', kind: 'distributed', member: 'M4', direction: 'localY', w1: -2, w2: 1, a: 0.5 },
    );
    const { warnings } = compare(p2);
    expect(warnings).toEqual([]);
  });

  it('a pure truss is held out of plane by the solver, with warnings only', () => {
    const p2 = buildProject('Truss', '', (b) => {
      const a = b.node(0, 0);
      const c = b.node(4, 0);
      const d = b.node(2, 3);
      b.member(a, c, 'ISMC 150', 'truss');
      b.member(c, d, 'ISMC 150', 'truss');
      b.member(d, a, 'ISMC 150', 'truss');
      b.support(a, 'pinned');
      b.support(c, 'rollerX');
      b.nodal(d, 10, -30);
    });
    const { warnings } = compare(p2);
    for (const w of warnings) expect(w).toMatch(/held automatically/);
  });
});
