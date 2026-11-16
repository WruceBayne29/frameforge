import { describe, expect, it } from 'vitest';
import { analyze, assemble, SolverError, validateModel } from './index';
import type { SolverLoad, SolverMember, StructureModel } from './index';
import { condense, elementGeometry, localStiffness, toGlobal, transformation } from './element';
import { cholesky, choleskySolve, gauss3, matMul, matVec, transpose, zeros } from './linalg';
import {
  emptyLoads,
  equivalentNodalLoads,
  internalForcesAt,
  resolveMemberLoads,
} from './memberLoads';

const E = 2e8;
const A = 0.01;
const I = 1e-4;
const frame = (
  id: string,
  i: string,
  j: string,
  extra: Partial<SolverMember> = {},
): SolverMember => ({
  id,
  i,
  j,
  type: 'frame',
  E,
  A,
  I,
  ...extra,
});
const truss = (id: string, i: string, j: string): SolverMember => ({
  id,
  i,
  j,
  type: 'truss',
  E,
  A,
  I: 0,
});

const beam = (loads: SolverLoad[] = [], L = 4): StructureModel => ({
  nodes: [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: L, y: 0 },
  ],
  members: [frame('AB', 'A', 'B')],
  supports: [
    { node: 'A', ux: true, uy: true },
    { node: 'B', uy: true },
  ],
  loads,
});

function expectError(fn: () => unknown, code: string, pattern: RegExp): SolverError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SolverError);
    const err = e as SolverError;
    expect(err.code).toBe(code);
    expect(err.message).toMatch(pattern);
    return err;
  }
  throw new Error('expected a SolverError');
}

describe('linalg', () => {
  it('multiplies and transposes matrices', () => {
    const a = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    expect(transpose(a)).toEqual([
      [1, 3, 5],
      [2, 4, 6],
    ]);
    expect(matMul(a, [[1], [1]])).toEqual([[3], [7], [11]]);
    expect(matVec(a, [1, -1])).toEqual([-1, -1, -1]);
    expect(zeros(2, 3)).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(transpose([])).toEqual([]);
    expect(matMul([], [])).toEqual([]);
  });

  it('solves an SPD system by Cholesky factorisation', () => {
    const a = [
      [4, 12, -16],
      [12, 37, -43],
      [-16, -43, 98],
    ];
    const f = cholesky(a);
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.L[2]).toEqual([-8, 5, 3]);
    const x = choleskySolve(f.L, matVec(a, [1, -2, 3]));
    [1, -2, 3].forEach((v, i) => expect(x[i]).toBeCloseTo(v, 10));
  });

  it('reports the failing pivot of a singular matrix', () => {
    const f = cholesky([
      [1, 1],
      [1, 1],
    ]);
    expect(f.ok).toBe(false);
    if (!f.ok) expect(f.pivotIndex).toBe(1);
  });

  it('integrates quintics exactly with 3-point Gauss', () => {
    expect(gauss3((x) => x ** 5 + 2 * x ** 2, 0, 2)).toBeCloseTo(64 / 6 + 16 / 3, 12);
  });
});

describe('element', () => {
  it('builds the standard 6x6 frame stiffness matrix', () => {
    const k = localStiffness(frame('m', 'a', 'b'), 2);
    expect(k[0][0]).toBeCloseTo((E * A) / 2);
    expect(k[1][1]).toBeCloseTo((12 * E * I) / 8);
    expect(k[1][2]).toBeCloseTo((6 * E * I) / 4);
    expect(k[2][2]).toBeCloseTo((4 * E * I) / 2);
    expect(k[2][5]).toBeCloseTo((2 * E * I) / 2);
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) expect(k[i][j]).toBeCloseTo(k[j][i]);
  });

  it('gives 3EI/L terms after condensing one end rotation', () => {
    const L = 2;
    const k = localStiffness(frame('m', 'a', 'b'), L);
    const f = [0, 0, 0, 0, 0, 0];
    condense(k, f, [5]);
    expect(k[1][1]).toBeCloseTo((3 * E * I) / L ** 3);
    expect(k[1][2]).toBeCloseTo((3 * E * I) / L ** 2);
    expect(k[2][2]).toBeCloseTo((3 * E * I) / L);
    expect(k[5].every((v) => v === 0)).toBe(true);
  });

  it('rotates stiffness into global axes', () => {
    const m = truss('m', 'a', 'b');
    const g = elementGeometry(m, { id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 3 });
    expect(g).toEqual({ L: 3, cos: 0, sin: 1 });
    const kg = toGlobal(localStiffness(m, g.L), transformation(g.cos, g.sin));
    expect(kg[1][1]).toBeCloseTo((E * A) / 3);
    expect(kg[0][0]).toBeCloseTo(0);
    expect(kg[1][4]).toBeCloseTo((-E * A) / 3);
  });

  it('rejects zero-length members', () => {
    expectError(
      () => elementGeometry(truss('m', 'a', 'b'), { id: 'a', x: 1, y: 1 }, { id: 'b', x: 1, y: 1 }),
      'INVALID_MODEL',
      /zero length/,
    );
  });
});

describe('member loads', () => {
  it('gives the classical fixed-end forces for a UDL', () => {
    const L = 6;
    const w = -10;
    const loads = resolveMemberLoads(
      [{ kind: 'distributed', member: 'm', direction: 'localY', w1: w }],
      1,
      0,
      L,
    );
    const f = equivalentNodalLoads(loads, L, 'frame');
    expect(f[1]).toBeCloseTo((w * L) / 2);
    expect(f[2]).toBeCloseTo((w * L * L) / 12);
    expect(f[4]).toBeCloseTo((w * L) / 2);
    expect(f[5]).toBeCloseTo((-w * L * L) / 12);
  });

  it('gives Pab²/L² fixed-end moments for a point load', () => {
    const L = 5;
    const a = 2;
    const b = 3;
    const P = -20;
    const loads = resolveMemberLoads(
      [{ kind: 'point', member: 'm', direction: 'localY', P, a }],
      1,
      0,
      L,
    );
    const f = equivalentNodalLoads(loads, L, 'frame');
    expect(f[2]).toBeCloseTo((P * a * b * b) / L ** 2);
    expect(f[5]).toBeCloseTo((-P * a * a * b) / L ** 2);
    expect(f[1]).toBeCloseTo((P * b * b * (3 * a + b)) / L ** 3);
  });

  it('handles a partial trapezoidal load with the correct resultant', () => {
    const L = 8;
    const loads = resolveMemberLoads(
      [{ kind: 'distributed', member: 'm', direction: 'localY', w1: -4, w2: -10, a: 2, b: 5 }],
      1,
      0,
      L,
    );
    const f = equivalentNodalLoads(loads, L, 'frame');
    const resultant = ((-4 + -10) / 2) * 3;
    expect(f[1] + f[4]).toBeCloseTo(resultant, 10);
    // Moment of the equivalent loads about node i equals the moment of the real load.
    const centroid = 2 + (3 * (4 + 2 * 10)) / (3 * (4 + 10));
    expect(f[2] + f[5] + f[4] * L).toBeCloseTo(resultant * centroid, 10);
  });

  it('resolves global loads on inclined members and axial loads', () => {
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const loads = resolveMemberLoads(
      [
        { kind: 'point', member: 'm', direction: 'globalY', P: -10, a: 1 },
        { kind: 'point', member: 'm', direction: 'globalX', P: 4, a: 1 },
        { kind: 'point', member: 'm', direction: 'localX', P: 3, a: 1 },
      ],
      c,
      s,
      2,
    );
    expect(loads.points[0].px).toBeCloseTo(-10 * s);
    expect(loads.points[0].py).toBeCloseTo(-10 * c);
    expect(loads.points[1].px).toBeCloseTo(4 * c);
    expect(loads.points[1].py).toBeCloseTo(-4 * s);
    const f = equivalentNodalLoads({ ...emptyLoads(), points: [loads.points[2]] }, 2, 'frame');
    expect(f[0]).toBeCloseTo(1.5);
    expect(f[3]).toBeCloseTo(1.5);
  });

  it('uses lever-rule loads for truss members', () => {
    const loads = resolveMemberLoads(
      [
        { kind: 'distributed', member: 'm', direction: 'localY', w1: -6 },
        { kind: 'point', member: 'm', direction: 'localY', P: -8, a: 1 },
        { kind: 'moment', member: 'm', M: 12, a: 2 },
      ],
      1,
      0,
      4,
    );
    const f = equivalentNodalLoads(loads, 4, 'truss');
    expect(f[2]).toBe(0);
    expect(f[5]).toBe(0);
    expect(f[1]).toBeCloseTo(-12 - 6 - 3);
    expect(f[4]).toBeCloseTo(-12 - 2 + 3);
  });

  it('rejects loads outside the member and reversed ranges', () => {
    expectError(
      () =>
        resolveMemberLoads(
          [{ kind: 'point', member: 'm', direction: 'localY', P: 1, a: 9 }],
          1,
          0,
          4,
        ),
      'INVALID_MODEL',
      /outside the member/,
    );
    expectError(
      () =>
        resolveMemberLoads(
          [{ kind: 'distributed', member: 'm', direction: 'localY', w1: 1, a: 3, b: 1 }],
          1,
          0,
          4,
        ),
      'INVALID_MODEL',
      /ends before it starts/,
    );
    const empty = resolveMemberLoads(
      [{ kind: 'distributed', member: 'm', direction: 'localY', w1: 1, a: 2, b: 2 }],
      1,
      0,
      4,
    );
    expect(empty.distributed).toHaveLength(0);
  });

  it('evaluates left and right limits at a point load', () => {
    const loads = { ...emptyLoads(), points: [{ a: 2, px: 0, py: -10 }] };
    const ends = [0, 5, 0, 0, 5, 0];
    expect(internalForcesAt(2, -1, ends, loads).V).toBe(5);
    expect(internalForcesAt(2, 1, ends, loads).V).toBe(-5);
    expect(internalForcesAt(2, 1, ends, loads).M).toBe(10);
  });
});

describe('analyze', () => {
  it('satisfies global equilibrium', () => {
    const r = analyze(
      beam([
        { kind: 'distributed', member: 'AB', direction: 'globalY', w1: -5, w2: -9, a: 0.5, b: 3 },
        { kind: 'point', member: 'AB', direction: 'globalX', P: 7, a: 1 },
        { kind: 'moment', member: 'AB', M: 4, a: 2.5 },
        { kind: 'nodal', node: 'B', fx: 3, mz: -2 },
      ]),
    );
    for (const residual of r.equilibrium) expect(Math.abs(residual)).toBeLessThan(1e-9);
    expect(r.dofCount).toBe(6);
    expect(r.maxDisplacement).toBeGreaterThan(0);
  });

  it('keeps member-end displacements compatible with the nodes', () => {
    const r = analyze(beam([{ kind: 'distributed', member: 'AB', direction: 'globalY', w1: -5 }]), {
      segments: 8,
    });
    const st = r.members.AB.stations;
    expect(st[0].v).toBeCloseTo(0, 12);
    expect(st[st.length - 1].v).toBeCloseTo(0, 12);
    expect(st[st.length - 1].u).toBeCloseTo(r.displacements.B.ux, 12);
    expect(r.members.AB.maxAbsDeflection.x).toBeCloseTo(2, 6);
    expect(r.members.AB.maxAbsShear.value).toBeCloseTo(10);
    expect(r.members.AB.maxAxial.value).toBeCloseTo(0);
    expect(r.members.AB.minAxial.value).toBeCloseTo(0);
  });

  it('reports axial deformation of an axially loaded bar', () => {
    const model = beam([{ kind: 'nodal', node: 'B', fx: 100 }]);
    const r = analyze(model);
    expect(r.displacements.B.ux).toBeCloseTo((100 * 4) / (E * A), 12);
    expect(r.members.AB.start.N).toBeCloseTo(100);
    expect(r.reactions.A.fx).toBeCloseTo(-100);
  });

  it('handles a truss member carrying a transverse member load', () => {
    const model: StructureModel = {
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 4, y: 0 },
        { id: 'C', x: 2, y: 2 },
      ],
      members: [{ ...truss('AB', 'A', 'B'), I }, truss('AC', 'A', 'C'), truss('BC', 'B', 'C')],
      supports: [
        { node: 'A', ux: true, uy: true },
        { node: 'B', uy: true },
      ],
      loads: [{ kind: 'distributed', member: 'AB', direction: 'globalY', w1: -10 }],
    };
    const r = analyze(model);
    expect(r.reactions.A.fy).toBeCloseTo(20);
    expect(r.members.AB.maxMoment.value).toBeCloseTo((10 * 16) / 8);
    expect(r.members.AB.maxAbsDeflection.value).toBeCloseTo((-5 * 10 * 4 ** 4) / (384 * E * I), 9);
    expect(r.displacements.C.rz).toBe(0);
  });

  it('auto-restrains the rotation of fully released joints', () => {
    const model = beam([{ kind: 'nodal', node: 'B', mz: 5 }]);
    model.members[0].releaseJ = true;
    const r = analyze(model);
    expect(r.warnings.join(' ')).toMatch(/moment is applied at node "B"/);
    expect(r.displacements.B.rz).toBe(0);
  });

  it('ignores unconnected nodes with a warning', () => {
    const model = beam([{ kind: 'nodal', node: 'B', fx: 1 }]);
    model.nodes.push({ id: 'Z', x: 9, y: 9 });
    const r = analyze(model);
    expect(r.warnings[0]).toMatch(/"Z" is not connected/);
    expect(r.displacements.Z).toEqual({ ux: 0, uy: 0, rz: 0 });
  });

  it('accumulates multiple supports on one node and rotational springs', () => {
    const model = beam([{ kind: 'nodal', node: 'B', mz: 10 }]);
    model.supports = [
      { node: 'A', ux: true },
      { node: 'A', uy: true },
      { node: 'B', uy: true, spring: { kr: 1e4, kx: 0 } },
    ];
    const r = analyze(model);
    const kb = (3 * E * I) / 4;
    expect(r.displacements.B.rz).toBeCloseTo(10 / (1e4 + kb), 12);
    expect(r.reactions.B.mz).toBeCloseTo((-10 * 1e4) / (1e4 + kb), 9);
    expect(r.reactions.A.fx).toBeCloseTo(0);
  });

  it('solves a fully restrained structure (no free DOFs)', () => {
    const model = beam([{ kind: 'distributed', member: 'AB', direction: 'globalY', w1: -6 }]);
    model.supports = [
      { node: 'A', ux: true, uy: true, rz: true },
      { node: 'B', ux: true, uy: true, rz: true },
    ];
    const r = analyze(model);
    expect(r.reactions.A.fy).toBeCloseTo(12);
    expect(r.reactions.A.mz).toBeCloseTo((6 * 16) / 12);
  });
});

describe('error handling', () => {
  it('detects a missing horizontal restraint', () => {
    const model = beam([{ kind: 'nodal', node: 'B', fy: -1 }]);
    model.supports = [
      { node: 'A', uy: true },
      { node: 'B', uy: true },
    ];
    const err = expectError(() => analyze(model), 'UNSTABLE', /unstable.*horizontal translation/s);
    expect(err.nodeId).toBeDefined();
  });

  it('detects a mechanism created by hinges', () => {
    const model: StructureModel = {
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 2, y: 0 },
        { id: 'C', x: 4, y: 0 },
      ],
      members: [truss('AB', 'A', 'B'), truss('BC', 'B', 'C')],
      supports: [
        { node: 'A', ux: true, uy: true },
        { node: 'C', ux: true, uy: true },
      ],
      loads: [{ kind: 'nodal', node: 'B', fy: -1 }],
    };
    const err = expectError(() => analyze(model), 'UNSTABLE', /mechanism.*node "B".*vertical/s);
    expect(err.nodeId).toBe('B');
  });

  it('detects an unbraced truss panel', () => {
    const model: StructureModel = {
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 3, y: 0 },
        { id: 'C', x: 3, y: 3 },
        { id: 'D', x: 0, y: 3 },
      ],
      members: [truss('AD', 'A', 'D'), truss('DC', 'D', 'C'), truss('BC', 'B', 'C')],
      supports: [
        { node: 'A', ux: true, uy: true },
        { node: 'B', ux: true, uy: true },
      ],
      loads: [{ kind: 'nodal', node: 'D', fx: 5 }],
    };
    expectError(() => analyze(model), 'UNSTABLE', /mechanism/);
  });

  it('requires supports', () => {
    const model = beam();
    model.supports = [];
    expectError(() => analyze(model), 'UNSTABLE', /no supports/);
    model.supports = [{ node: 'A', spring: { kx: 0 } }];
    expectError(() => analyze(model), 'UNSTABLE', /no supports/);
  });

  it('validates the model', () => {
    const base = beam();
    const bad = (patch: (m: StructureModel) => void, pattern: RegExp) => {
      const m: StructureModel = JSON.parse(JSON.stringify(base)) as StructureModel;
      patch(m);
      expectError(() => validateModel(m), 'INVALID_MODEL', pattern);
    };
    bad((m) => (m.nodes = []), /no nodes/);
    bad((m) => (m.members = []), /no members/);
    bad((m) => m.nodes.push({ id: 'A', x: 1, y: 1 }), /Duplicate node/);
    bad((m) => (m.nodes[0].x = Number.NaN), /invalid coordinates/);
    bad((m) => m.members.push(frame('AB', 'A', 'B')), /Duplicate member/);
    bad((m) => (m.members[0].j = 'Q'), /does not exist/);
    bad((m) => (m.members[0].j = 'A'), /same node/);
    bad((m) => (m.members[0].E = 0), /Young's modulus/);
    bad((m) => (m.members[0].A = -1), /positive area/);
    bad((m) => (m.members[0].I = 0), /second moment/);
    bad((m) => m.supports.push({ node: 'Q', ux: true }), /missing node "Q"/);
    bad((m) => m.loads.push({ kind: 'nodal', node: 'Q', fx: 1 }), /missing node "Q"/);
    bad((m) => m.loads.push({ kind: 'moment', member: 'Q', M: 1, a: 0 }), /missing member "Q"/);
  });

  it('exposes the assembled system', () => {
    const sys = assemble(beam());
    expect(sys.K).toHaveLength(6);
    expect(sys.restrained).toEqual([true, true, false, false, true, false]);
    expect(sys.elements[0].dofs).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
