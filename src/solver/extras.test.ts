import { describe, expect, it } from 'vitest';
import {
  assemble,
  influenceLine,
  jacobiEigen,
  localMass,
  modalAnalysis,
  SolverError,
} from './index';
import type { SolverMember, StructureModel } from './index';

const E = 2e8;
const A = 0.01;
const I = 1e-4;
const m = 0.0785;
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
  massPerLength: m,
  ...extra,
});

const beam = (extra: Partial<SolverMember> = {}): StructureModel => ({
  nodes: [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 3, y: 0 },
    { id: 'C', x: 6, y: 0 },
  ],
  members: [frame('AB', 'A', 'B', extra), frame('BC', 'B', 'C')],
  supports: [
    { node: 'A', ux: true, uy: true },
    { node: 'C', uy: true },
  ],
  loads: [],
});

describe('jacobiEigen', () => {
  it('diagonalises a symmetric matrix', () => {
    const a = [
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ];
    const { values, vectors } = jacobiEigen(a);
    expect(values[0]).toBeLessThan(values[1]);
    expect(values.reduce((s, v) => s + v, 0)).toBeCloseTo(9, 10);
    // A·v = λ·v for every eigenpair.
    for (let k = 0; k < 3; k++) {
      const v = vectors.map((row) => row[k]);
      a.forEach((row, i) => {
        expect(row.reduce((s, x, j) => s + x * v[j], 0)).toBeCloseTo(values[k] * v[i], 9);
      });
    }
  });
});

describe('mass matrices', () => {
  it('conserve the member mass in translation', () => {
    for (const model of [
      beam(),
      beam({ releaseJ: true }),
      beam({ releaseI: true, releaseJ: true }),
    ]) {
      const el = assemble({ ...model, loads: [] }).elements[0];
      const M = localMass(el);
      // Rigid-body translation in y: v_i = v_j = 1 (rotations zero) must give the total mass.
      const rigid = [0, 1, 0, 0, 1, 0];
      const energy = rigid.reduce(
        (s, a, i) => s + a * M[i].reduce((t, x, j) => t + x * rigid[j], 0),
        0,
      );
      expect(energy).toBeCloseTo(m * 3, 10);
    }
    const truss = assemble({
      ...beam(),
      members: [{ ...frame('AB', 'A', 'B'), type: 'truss' }, frame('BC', 'B', 'C')],
    }).elements[0];
    const M = localMass(truss);
    expect(M[1][1] + M[1][4] + M[4][1] + M[4][4]).toBeCloseTo(m * 3, 10);
    expect(M[2][2]).toBe(0);
  });
});

describe('modalAnalysis', () => {
  it('returns ordered modes with normalised shapes', () => {
    const r = modalAnalysis(beam(), 3);
    expect(r.modes).toHaveLength(3);
    expect(r.totalMass).toBeCloseTo(m * 6);
    expect(r.modes[0].omega).toBeLessThan(r.modes[1].omega);
    const peak = Math.max(
      ...Object.values(r.modes[0].displacements).flatMap((d) => [Math.abs(d.ux), Math.abs(d.uy)]),
    );
    expect(peak).toBeCloseTo(1, 10);
    expect(r.modes[0].members.AB).toHaveLength(13);
    expect(r.modes[0].period).toBeCloseTo(1 / r.modes[0].frequency, 10);
  });

  it('subdividing members recovers the exact beam frequencies', () => {
    const model: StructureModel = {
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 5, y: 0 },
      ],
      members: [frame('AB', 'A', 'B')],
      supports: [
        { node: 'A', ux: true, uy: true },
        { node: 'B', uy: true },
      ],
      loads: [],
    };
    const exact = Math.PI ** 2 * Math.sqrt((E * I) / (m * 5 ** 4));
    const coarse = modalAnalysis(model, 1).modes[0].omega;
    const fine = modalAnalysis(model, 2, { subdivide: 8 });
    expect(Math.abs(fine.modes[0].omega - exact) / exact).toBeLessThan(1e-4);
    expect(Math.abs(coarse - exact) / exact).toBeGreaterThan(1e-3);
    expect(Math.abs(fine.modes[1].omega - 4 * exact) / (4 * exact)).toBeLessThan(1e-3);
    // One curve per original member, running its full length, ending at the node values.
    const shape = fine.modes[0].members.AB;
    expect(Object.keys(fine.modes[0].members)).toEqual(['AB']);
    expect(shape[0].x).toBe(0);
    expect(shape[shape.length - 1].x).toBeCloseTo(5, 10);
    expect(Object.keys(fine.modes[0].displacements)).toEqual(['A', 'B']);
    expect(Math.max(...shape.map((p) => Math.abs(p.v)))).toBeGreaterThan(0.9);
  });

  it('a hinge lowers the fundamental frequency', () => {
    const rigid = modalAnalysis(beam(), 1).modes[0].omega;
    const fixedEnds = (extra: Partial<SolverMember>) => {
      const model = beam(extra);
      model.supports = [
        { node: 'A', ux: true, uy: true, rz: true },
        { node: 'C', ux: true, uy: true, rz: true },
      ];
      return modalAnalysis(model, 2);
    };
    const continuous = fixedEnds({});
    const hinged = fixedEnds({ releaseJ: true });
    const hingedStart = fixedEnds({ releaseI: true });
    expect(hinged.modes[0].omega).toBeLessThan(continuous.modes[0].omega);
    expect(hingedStart.modes[0].omega).toBeLessThan(continuous.modes[0].omega);
    expect(continuous.modes[0].omega).toBeGreaterThan(rigid);
    expect(hinged.modes[0].members.AB[12].v).toBeCloseTo(hinged.modes[0].displacements.B.uy, 10);
  });

  it('handles trusses and double releases', () => {
    const model: StructureModel = {
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 4, y: 0 },
        { id: 'C', x: 2, y: 3 },
      ],
      members: [
        { ...frame('AC', 'A', 'C'), type: 'truss' },
        { ...frame('BC', 'B', 'C'), releaseI: true, releaseJ: true },
      ],
      supports: [
        { node: 'A', ux: true, uy: true },
        { node: 'B', ux: true, uy: true },
      ],
      loads: [],
    };
    const r = modalAnalysis(model, 5);
    expect(r.dofCount).toBe(2);
    expect(r.modes).toHaveLength(2);
    expect(r.modes[0].frequency).toBeGreaterThan(0);
  });

  it('rejects missing mass, mechanisms and fully fixed models', () => {
    const noMass = beam();
    noMass.members[0].massPerLength = 0;
    expect(() => modalAnalysis(noMass)).toThrow(/mass per unit length/);
    const unstable = beam();
    unstable.supports = [
      { node: 'A', uy: true },
      { node: 'C', uy: true },
    ];
    expect(() => modalAnalysis(unstable)).toThrow(SolverError);
    expect(() => modalAnalysis(unstable)).toThrow(/no natural frequencies/);
    const rigid: StructureModel = {
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 3, y: 0 },
      ],
      members: [frame('AB', 'A', 'B')],
      supports: [
        { node: 'A', ux: true, uy: true, rz: true },
        { node: 'B', ux: true, uy: true, rz: true },
      ],
      loads: [],
    };
    expect(modalAnalysis(rigid)).toMatchObject({ modes: [], dofCount: 0 });
  });
});

describe('influenceLine', () => {
  it('computes reaction, displacement and member-force lines', () => {
    const model = beam();
    const reaction = influenceLine(model, { kind: 'reaction', node: 'C', component: 'fy' });
    expect(reaction.ordinates).toHaveLength(22);
    expect(reaction.max.value).toBeCloseTo(1, 10);
    expect(reaction.min.value).toBeCloseTo(0, 10);
    const free = influenceLine(
      model,
      { kind: 'reaction', node: 'B', component: 'fy' },
      { path: ['AB'] },
    );
    expect(free.max.value).toBe(0);
    const defl = influenceLine(
      model,
      { kind: 'displacement', node: 'B', component: 'uy' },
      { pointsPerMember: 3, path: ['AB', 'BC'] },
    );
    // Largest downward deflection of B occurs with the load on B: PL³/48EI.
    expect(defl.min.value).toBeCloseTo(-(6 ** 3) / (48 * E * I), 10);
    const shear = influenceLine(
      model,
      { kind: 'memberForce', member: 'AB', x: 1.5, component: 'V' },
      { pointsPerMember: 5, direction: 'globalY', magnitude: -1 },
    );
    expect(shear.max.value).toBeGreaterThan(0);
    expect(shear.min.value).toBeLessThan(0);
    const end = influenceLine(model, { kind: 'memberForce', member: 'BC', x: 3, component: 'M' });
    expect(Math.abs(end.max.value)).toBeLessThan(1e-9);
  });

  it('validates its inputs', () => {
    const model = beam();
    expect(() => influenceLine(model, { kind: 'reaction', node: 'Z', component: 'fy' })).toThrow(
      /Node "Z"/,
    );
    expect(() =>
      influenceLine(model, { kind: 'memberForce', member: 'Z', x: 0, component: 'M' }),
    ).toThrow(/Member "Z"/);
    expect(() =>
      influenceLine(model, { kind: 'reaction', node: 'A', component: 'fy' }, { path: ['Z'] }),
    ).toThrow(/load path/);
    expect(() =>
      influenceLine(model, { kind: 'reaction', node: 'A', component: 'fy' }, { path: [] }),
    ).toThrow(/empty/);
  });
});
