import { describe, expect, it } from 'vitest';
import { analyze } from '../solver';
import type { SolverMember, StructureModel } from '../solver';
import {
  analyze3d,
  memberAxes,
  plateAxes,
  rcmOrder,
  SkylineMatrix,
  SOLID_FACES,
  SolverError,
  validateModel3d,
} from './index';
import type {
  AnalysisResult3D,
  Dof6,
  Load3D,
  Member3D,
  Node3D,
  Plate3D,
  Reaction3D,
  Solid3D,
  StructureModel3D,
  Support3D,
  Vec3,
} from './index';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const E = 2e8;
const G = 7.7e7;
const A = 0.01;
const Iy = 5e-5;
const Iz = 1e-4;
const J = 2e-5;

const node = (id: string, x: number, y: number, z: number): Node3D => ({ id, x, y, z });
const beam = (id: string, i: string, j: string, extra: Partial<Member3D> = {}): Member3D => ({
  id,
  i,
  j,
  type: 'beam',
  E,
  G,
  A,
  Iy,
  Iz,
  J,
  ...extra,
});
const truss = (id: string, i: string, j: string, extra: Partial<Member3D> = {}): Member3D => ({
  id,
  i,
  j,
  type: 'truss',
  E,
  A,
  ...extra,
});
const fixed = (id: string): Support3D => ({
  node: id,
  ux: true,
  uy: true,
  uz: true,
  rx: true,
  ry: true,
  rz: true,
});
const pinned = (id: string): Support3D => ({ node: id, ux: true, uy: true, uz: true });

/** Relative comparison: |actual − expected| <= rel · max(|expected|, floor). */
function near(actual: number, expected: number, rel = 1e-9, floor = 0): void {
  const tolerance = rel * Math.max(Math.abs(expected), floor);
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`expected ${actual} to be within ${tolerance} of ${expected}`);
  }
}

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

/** Largest |equilibrium| component must vanish relative to the given force scale. */
function expectEquilibrium(result: AnalysisResult3D, scale: number, rel = 1e-8): void {
  for (const value of result.equilibrium) expect(Math.abs(value)).toBeLessThan(rel * scale);
}

const sumReactions = (result: AnalysisResult3D, key: keyof Reaction3D): number =>
  Object.values(result.reactions).reduce((sum, r) => sum + r[key], 0);

/** Small deterministic random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Regular grid of plates in a horizontal plane (normal = +Y), nodes `${p}${i}_${j}`. */
function plateGrid(
  p: string,
  nx: number,
  nz: number,
  a: number,
  b: number,
  y: number,
  props: Omit<Plate3D, 'id' | 'nodes'>,
): { nodes: Node3D[]; plates: Plate3D[] } {
  const nodes: Node3D[] = [];
  const plates: Plate3D[] = [];
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) nodes.push(node(`${p}${i}_${j}`, (a * i) / nx, y, (b * j) / nz));
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      plates.push({
        id: `${p}P${i}_${j}`,
        nodes: [`${p}${i}_${j}`, `${p}${i}_${j + 1}`, `${p}${i + 1}_${j + 1}`, `${p}${i + 1}_${j}`],
        ...props,
      });
    }
  }
  return { nodes, plates };
}

/**
 * Regular block of hexahedra, nodes `${p}${i}_${j}_${k}`, solids `${p}H${i}_${j}_${k}`.
 * Element faces: 1 = −Z, 2 = +Z, 3 = −Y, 4 = +X, 5 = +Y, 6 = −X.
 */
function solidBlock(
  p: string,
  n: [number, number, number],
  size: Vec3,
  origin: Vec3,
  props: Omit<Solid3D, 'id' | 'nodes'>,
): { nodes: Node3D[]; solids: Solid3D[] } {
  const nodes: Node3D[] = [];
  const solids: Solid3D[] = [];
  const id = (i: number, j: number, k: number) => `${p}${i}_${j}_${k}`;
  for (let i = 0; i <= n[0]; i++) {
    for (let j = 0; j <= n[1]; j++) {
      for (let k = 0; k <= n[2]; k++) {
        nodes.push(
          node(
            id(i, j, k),
            origin[0] + (size[0] * i) / n[0],
            origin[1] + (size[1] * j) / n[1],
            origin[2] + (size[2] * k) / n[2],
          ),
        );
      }
    }
  }
  for (let i = 0; i < n[0]; i++) {
    for (let j = 0; j < n[1]; j++) {
      for (let k = 0; k < n[2]; k++) {
        solids.push({
          id: `${p}H${i}_${j}_${k}`,
          nodes: [
            id(i, j, k),
            id(i + 1, j, k),
            id(i + 1, j + 1, k),
            id(i, j + 1, k),
            id(i, j, k + 1),
            id(i + 1, j, k + 1),
            id(i + 1, j + 1, k + 1),
            id(i, j + 1, k + 1),
          ],
          ...props,
        });
      }
    }
  }
  return { nodes, solids };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

describe('solver3d public API', () => {
  it('re-exports the helpers the UI needs', () => {
    expect(memberAxes([0, 0, 0], [2, 0, 0]).x).toEqual([1, 0, 0]);
    expect(
      plateAxes([
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ]).z.map((v) => v + 0),
    ).toEqual([0, 0, 1]);
    expect(SOLID_FACES).toHaveLength(6);
    expect(rcmOrder([[1], [0]])).toHaveLength(2);
    expect(new SkylineMatrix([0, 0]).n).toBe(2);
    expect(new SolverError('UNSTABLE', 'x').code).toBe('UNSTABLE');
  });
});

// ---------------------------------------------------------------------------------------------
// Space trusses
// ---------------------------------------------------------------------------------------------

describe('space truss', () => {
  const h = 3;
  const r = 2;
  const base = [0, 1, 2].map((k): Vec3 => {
    const angle = (2 * Math.PI * k) / 3 + 0.3;
    return [r * Math.cos(angle), 0, r * Math.sin(angle)];
  });
  const tripod = (loads: Load3D[]): StructureModel3D => ({
    nodes: [node('T', 0, h, 0), ...base.map((b, k) => node(`B${k}`, b[0], b[1], b[2]))],
    members: base.map((_, k) => truss(`M${k}`, `B${k}`, 'T')),
    supports: base.map((_, k) => pinned(`B${k}`)),
    loads,
  });

  it('tripod under a vertical load: leg forces, reactions and apex deflection', () => {
    const P = 90;
    const res = analyze3d(tripod([{ kind: 'nodal', node: 'T', fy: -P }]));
    const L = Math.hypot(r, h);
    const cos = h / L;
    expect(res.dofCount).toBe(3);
    expect(res.warnings).toEqual([]);
    for (let k = 0; k < 3; k++) {
      const m = res.members[`M${k}`];
      near(m.length, L);
      for (const s of m.stations) near(s.N, -P / (3 * cos));
      near(m.maxAxial.value, -P / (3 * cos));
      near(m.minAxial.value, -P / (3 * cos));
      const reaction = res.reactions[`B${k}`];
      near(reaction.fy, P / 3);
      // The compressed leg pushes its base outwards, so the reaction points inwards.
      near(reaction.fx, (-(P / 3) * base[k][0]) / h, 1e-9, P);
      near(reaction.fz, (-(P / 3) * base[k][2]) / h, 1e-9, P);
      expect(reaction.mx).toBe(0);
      expect(reaction.my).toBe(0);
      expect(reaction.mz).toBe(0);
    }
    const apex = res.displacements.T;
    near(apex.uy, (-P * L) / (3 * E * A * cos * cos));
    expect(Math.abs(apex.ux)).toBeLessThan(1e-12);
    expect(Math.abs(apex.uz)).toBeLessThan(1e-12);
    expect([apex.rx, apex.ry, apex.rz]).toEqual([0, 0, 0]);
    near(res.maxDisplacement, Math.abs(apex.uy));
    expect(res.appliedLoad).toEqual([0, -P, 0]);
    expectEquilibrium(res, P);
  });

  it('tripod under an inclined load: joint equilibrium at the apex', () => {
    const F: Vec3 = [40, -25, 15];
    const res = analyze3d(tripod([{ kind: 'nodal', node: 'T', fx: F[0], fy: F[1], fz: F[2] }]));
    const sum: Vec3 = [...F];
    for (let k = 0; k < 3; k++) {
      const m = res.members[`M${k}`];
      // The apex is node j: a tension N pulls it back along −x.
      for (let c = 0; c < 3; c++) sum[c] -= m.stations[0].N * m.axes.x[c];
    }
    for (const value of sum) expect(Math.abs(value)).toBeLessThan(1e-9);
    // Clapeyron: external work equals the strain energy of the bars.
    const d = res.displacements.T;
    const work = 0.5 * (F[0] * d.ux + F[1] * d.uy + F[2] * d.uz);
    let energy = 0;
    for (const m of Object.values(res.members)) {
      energy += (m.stations[0].N ** 2 * m.length) / (2 * E * A);
    }
    near(work, energy);
    expectEquilibrium(res, 40);
  });

  it('simply supported tetrahedron: reactions and bar forces from statics', () => {
    const D: Vec3 = [0.5, 1.5, 0.6];
    const F: Vec3 = [12, -30, 7];
    const nodes = [node('A', 0, 0, 0), node('B', 2, 0, 0), node('C', 0, 0, 2), node('D', ...D)];
    const pairs = [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'A'],
      ['A', 'D'],
      ['B', 'D'],
      ['C', 'D'],
    ];
    const model: StructureModel3D = {
      nodes,
      members: pairs.map(([i, j]) => truss(i + j, i, j)),
      supports: [pinned('A'), { node: 'B', uy: true, uz: true }, { node: 'C', uy: true }],
      loads: [{ kind: 'nodal', node: 'D', fx: F[0], fy: F[1], fz: F[2] }],
    };
    const res = analyze3d(model);
    expect(res.dofCount).toBe(6);
    expect(res.warnings).toEqual([]);

    // Six equations of statics for the six reaction components (moments about A).
    const Cy = (D[1] * F[2] - D[2] * F[1]) / 2;
    const Bz = (D[2] * F[0] - D[0] * F[2]) / 2;
    const By = -(D[0] * F[1] - D[1] * F[0]) / 2;
    near(res.reactions.A.fx, -F[0]);
    near(res.reactions.A.fy, -F[1] - By - Cy);
    near(res.reactions.A.fz, -F[2] - Bz);
    near(res.reactions.B.fy, By);
    near(res.reactions.B.fz, Bz);
    expect(res.reactions.B.fx).toBe(0);
    near(res.reactions.C.fy, Cy);

    // Method of joints: every joint is in equilibrium under bar forces, loads and reactions.
    for (const n of nodes) {
      const r = res.reactions[n.id];
      const sum: Vec3 = r ? [r.fx, r.fy, r.fz] : [0, 0, 0];
      if (n.id === 'D') for (let c = 0; c < 3; c++) sum[c] += F[c];
      for (const [i, j] of pairs) {
        const m = res.members[i + j];
        const sign = n.id === i ? 1 : n.id === j ? -1 : 0;
        for (let c = 0; c < 3; c++) sum[c] += sign * m.stations[0].N * m.axes.x[c];
      }
      for (const value of sum) expect(Math.abs(value)).toBeLessThan(1e-9);
    }

    const d = res.displacements.D;
    let energy = 0;
    for (const m of Object.values(res.members)) {
      energy += (m.stations[0].N ** 2 * m.length) / (2 * E * A);
    }
    near(0.5 * (F[0] * d.ux + F[1] * d.uy + F[2] * d.uz), energy);
    expectEquilibrium(res, 30);
  });

  it('a truss bar with self-weight and a transverse member load reports its own diagrams', () => {
    // A horizontal bar between two pins: the loads go straight to the supports.
    const L = 4;
    const density = 78.5;
    const w = 3;
    const res = analyze3d({
      nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
      members: [truss('AB', 'A', 'B', { density })],
      supports: [pinned('A'), pinned('B')],
      loads: [
        // Self-weight loads add up.
        { kind: 'selfWeight', direction: 'globalY', factor: -0.4 },
        { kind: 'selfWeight', direction: 'globalY', factor: -0.6 },
        { kind: 'distributed', member: 'AB', direction: 'globalZ', w1: w },
      ],
    });
    expect(res.dofCount).toBe(0);
    near(res.appliedLoad[1], -density * A * L);
    near(res.appliedLoad[2], w * L);
    near(res.reactions.A.fy, (density * A * L) / 2);
    near(res.reactions.B.fz, (-w * L) / 2);
    near(res.members.AB.maxAbsMz.value, (density * A * L * L) / 8);
    near(res.members.AB.maxAbsMz.x, L / 2);
    expectEquilibrium(res, w * L);
  });
});

// ---------------------------------------------------------------------------------------------
// Space frames
// ---------------------------------------------------------------------------------------------

describe('space frame', () => {
  it('L-shaped cantilever: bending plus torsion', () => {
    const L1 = 3;
    const L2 = 2;
    const P = 10;
    const res = analyze3d({
      nodes: [node('A', 0, 0, 0), node('B', L1, 0, 0), node('C', L1, 0, L2)],
      members: [beam('AB', 'A', 'B'), beam('BC', 'B', 'C')],
      supports: [fixed('A')],
      loads: [{ kind: 'nodal', node: 'C', fy: -P }],
    });
    expect(res.dofCount).toBe(12);
    expect(res.warnings).toEqual([]);
    const twist = (P * L2 * L1) / (G * J);
    near(res.displacements.B.uy, (-P * L1 ** 3) / (3 * E * Iz));
    near(res.displacements.B.rx, twist);
    near(res.displacements.B.rz, (-P * L1 ** 2) / (2 * E * Iz));
    near(
      res.displacements.C.uy,
      -((P * L1 ** 3) / (3 * E * Iz) + twist * L2 + (P * L2 ** 3) / (3 * E * Iz)),
    );
    near(res.maxDisplacement, Math.abs(res.displacements.C.uy));

    const r = res.reactions.A;
    near(r.fy, P);
    near(r.mx, -P * L2);
    near(r.mz, P * L1);
    for (const key of ['fx', 'fz', 'my'] as const) expect(Math.abs(r[key])).toBeLessThan(1e-9);

    // Member AB: constant shear and torque, hogging moment at the root.
    const ab = res.members.AB;
    expect(ab.axes).toEqual({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
    for (const s of ab.stations) {
      near(s.Vy, P);
      near(s.T, P * L2);
      near(s.Mz, -P * (L1 - s.x), 1e-9, P);
      expect(Math.abs(s.N) + Math.abs(s.Vz) + Math.abs(s.My)).toBeLessThan(1e-8);
    }
    near(ab.maxAbsMz.value, -P * L1);
    expect(ab.maxAbsMz.x).toBe(0);
    near(ab.maxAbsTorsion.value, P * L2);
    near(ab.stations[ab.stations.length - 1].twist, twist);
    // Member BC runs along +Z with local y up: a plain cantilever in its x–y plane.
    const bc = res.members.BC;
    expect(bc.axes.y).toEqual([0, 1, 0]);
    near(bc.stations[0].Mz, -P * L2);
    near(bc.maxAbsVy.value, P);
    expect(Math.abs(bc.maxAbsTorsion.value)).toBeLessThan(1e-8);
    expectEquilibrium(res, P * L1);
  });

  describe('portal frame in the XY plane, full 3D', () => {
    const h = 4;
    const L = 6;
    const big = 1e3; // large area: axial deformation negligible
    const Ib = 2.5e-4;
    const portal = (loads: Load3D[]): StructureModel3D => ({
      nodes: [node('A', 0, 0, 0), node('B', 0, h, 0), node('C', L, h, 0), node('D', L, 0, 0)],
      members: [
        beam('AB', 'A', 'B', { A: big }),
        beam('BC', 'B', 'C', { A: big, Iz: Ib }),
        beam('DC', 'D', 'C', { A: big }),
      ],
      supports: [fixed('A'), fixed('D')],
      loads,
    });

    it('in-plane sway matches the slope-deflection solution', () => {
      const H = 50;
      const res = analyze3d(portal([{ kind: 'nodal', node: 'B', fx: H }]));
      const k = Ib / L / (Iz / h);
      near(
        res.displacements.B.ux,
        ((H * h ** 3) / (12 * E * Iz)) * ((3 * k + 2) / (6 * k + 1)),
        1e-5,
      );
      const base = ((H * h) / 2) * ((3 * k + 1) / (6 * k + 1));
      // Both base moments resist the overturning: clockwise load, counter-clockwise… about −Z.
      near(res.reactions.A.mz, base, 1e-5);
      near(res.reactions.D.mz, base, 1e-5);
      near(res.reactions.A.fx, -H / 2, 1e-5);
      near(res.reactions.D.fx, -H / 2, 1e-5);
      // Column local y points along −X, so the column bends in its x–y plane (Iz).
      expect(res.members.AB.axes.y).toEqual([-1, 0, 0]);
      near(Math.abs(res.members.AB.stations[0].Mz), base, 1e-5);
      expect(Math.abs(res.members.AB.maxAbsMy.value)).toBeLessThan(1e-8);
      expect(Math.abs(res.displacements.B.uz)).toBeLessThan(1e-12);
      expectEquilibrium(res, H * h);
    });

    it('out-of-plane load: the columns act as two cantilevers about their weak axis', () => {
      const H = 8;
      const res = analyze3d(
        portal([
          { kind: 'nodal', node: 'B', fz: H / 2 },
          { kind: 'nodal', node: 'C', fz: H / 2 },
        ]),
      );
      const tip = ((H / 2) * h ** 3) / (3 * E * Iy);
      near(res.displacements.B.uz, tip);
      near(res.displacements.C.uz, tip);
      near(res.displacements.B.rx, ((H / 2) * h ** 2) / (2 * E * Iy));
      near(res.reactions.A.fz, -H / 2);
      near(res.reactions.A.mx, (-H / 2) * h);
      const ab = res.members.AB;
      near(ab.stations[0].Vz, -H / 2);
      near(ab.stations[0].My, (H / 2) * h);
      near(ab.stations[ab.stations.length - 1].w, tip);
      expect(Math.abs(ab.maxAbsMz.value)).toBeLessThan(1e-8);
      // The beam rides along without bending or twisting.
      const bc = res.members.BC;
      expect(Math.abs(bc.maxAbsMy.value) + Math.abs(bc.maxAbsTorsion.value)).toBeLessThan(1e-8);
      expectEquilibrium(res, H * h);
    });
  });

  it('simply supported beam on two pins: the free spin is held with a warning', () => {
    const L = 5;
    const w = 12;
    const res = analyze3d({
      nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
      members: [beam('AB', 'A', 'B')],
      supports: [pinned('A'), { node: 'B', uy: true, uz: true }],
      loads: [{ kind: 'distributed', member: 'AB', direction: 'globalY', w1: -w }],
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(
      /^Node "[AB]" is free to rotate about X \(rx\) without resistance; it was held automatically\. Check supports or member releases\.$/,
    );
    expect(res.dofCount).toBe(7);
    near(res.reactions.A.fy, (w * L) / 2);
    near(res.reactions.B.fy, (w * L) / 2);
    const m = res.members.AB;
    near(m.maxAbsMz.value, (w * L * L) / 8);
    near(m.maxAbsMz.x, L / 2);
    near(m.maxAbsVy.value, (w * L) / 2);
    near(m.maxAbsDeflection.value, (5 * w * L ** 4) / (384 * E * Iz));
    near(res.displacements.A.rz, (-w * L ** 3) / (24 * E * Iz));
    near(res.displacements.B.rz, (w * L ** 3) / (24 * E * Iz));
    const mid = m.stations.find((s) => Math.abs(s.x - L / 2) < 1e-12);
    near(mid?.v as number, (-5 * w * L ** 4) / (384 * E * Iz));
    near(res.maxDisplacement, (5 * w * L ** 4) / (384 * E * Iz));
    expect(res.appliedLoad).toEqual([0, -w * L, 0]);
    expectEquilibrium(res, w * L);
  });

  describe('fixed-fixed beam', () => {
    const L = 6;
    const model = (loads: Load3D[], extra: Partial<Member3D> = {}): StructureModel3D => ({
      nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
      members: [beam('AB', 'A', 'B', extra)],
      supports: [fixed('A'), fixed('B')],
      loads,
    });

    it('uniform load in the local x–y plane', () => {
      const w = 9;
      const res = analyze3d(
        model([{ kind: 'distributed', member: 'AB', direction: 'localY', w1: -w }]),
        { segments: 8 },
      );
      expect(res.dofCount).toBe(0);
      near(res.reactions.A.fy, (w * L) / 2);
      near(res.reactions.A.mz, (w * L * L) / 12);
      near(res.reactions.B.mz, (-w * L * L) / 12);
      const m = res.members.AB;
      expect(m.stations).toHaveLength(9);
      near(m.stations[0].Mz, (-w * L * L) / 12);
      near(m.stations[0].Vy, (w * L) / 2);
      near(m.stations[4].Mz, (w * L * L) / 24);
      near(m.stations[4].v, (-w * L ** 4) / (384 * E * Iz));
      near(m.stations[8].Vy, (-w * L) / 2);
      near(res.maxDisplacement, (w * L ** 4) / (384 * E * Iz));
      expect(m.endForces).toHaveLength(12);
      near(m.endForces[1], (w * L) / 2);
      near(m.endForces[5], (w * L * L) / 12);
      near(m.endForces[11], (-w * L * L) / 12);
      expectEquilibrium(res, w * L);
    });

    it('point load at a distance from node i', () => {
      const P = 20;
      const a = 2;
      const b = L - a;
      const res = analyze3d(
        model([{ kind: 'point', member: 'AB', direction: 'globalY', P: -P, a }]),
      );
      near(res.reactions.A.fy, (P * b * b * (3 * a + b)) / L ** 3);
      near(res.reactions.B.fy, (P * a * a * (a + 3 * b)) / L ** 3);
      near(res.reactions.A.mz, (P * a * b * b) / L ** 2);
      near(res.reactions.B.mz, (-P * a * a * b) / L ** 2);
      const m = res.members.AB;
      const at = m.stations.filter((s) => s.x === a);
      expect(at).toHaveLength(2);
      near(at[0].Vy - at[1].Vy, P);
      near(at[0].v, (-P * a ** 3 * b ** 3) / (3 * E * Iz * L ** 3));
      near(at[0].Mz, (2 * P * a * a * b * b) / L ** 3);
      near(m.maxAbsMz.value, (-P * a * b * b) / L ** 2);
      expectEquilibrium(res, P * L);
    });

    it('point load in the local x–z plane follows the My / Vz conventions', () => {
      const P = 16;
      const res = analyze3d(
        model([{ kind: 'point', member: 'AB', direction: 'localZ', P: -P, a: L / 2 }]),
      );
      near(res.reactions.A.fz, P / 2);
      near(res.reactions.A.my, (-P * L) / 8);
      near(res.reactions.B.my, (P * L) / 8);
      const m = res.members.AB;
      near(m.stations[0].Vz, P / 2);
      near(m.stations[0].My, (-P * L) / 8);
      const mid = m.stations.filter((s) => s.x === L / 2);
      near(mid[0].My, (P * L) / 8);
      near(mid[0].w, (-P * L ** 3) / (192 * E * Iy));
      near(mid[1].Vz, -P / 2);
      near(m.maxAbsDeflection.value, (P * L ** 3) / (192 * E * Iy));
      expect(Math.abs(m.maxAbsMz.value) + Math.abs(m.maxAbsVy.value)).toBeLessThan(1e-9);
      expectEquilibrium(res, P * L);
    });

    it('a roll angle of 90° turns the strong axis: global-Y load bends about Iy', () => {
      const P = 16;
      const res = analyze3d(
        model([{ kind: 'point', member: 'AB', direction: 'globalY', P: -P, a: L / 2 }], {
          beta: Math.PI / 2,
        }),
      );
      const m = res.members.AB;
      // Local y → global Z, local z → global −Y: the load acts along +local z.
      near(m.axes.z[1], -1);
      const mid = m.stations.filter((s) => s.x === L / 2);
      near(mid[0].w, (P * L ** 3) / (192 * E * Iy));
      near(mid[0].My, (-P * L) / 8);
      near(res.reactions.A.mz, (P * L) / 8);
    });

    it('torque and axial load at a third point', () => {
      const T = 6;
      const N = 30;
      const a = L / 3;
      const res = analyze3d(
        model([
          { kind: 'moment', member: 'AB', direction: 'localX', M: T, a },
          { kind: 'point', member: 'AB', direction: 'localX', P: N, a },
        ]),
      );
      near(res.reactions.A.mx, (-T * 2) / 3);
      near(res.reactions.B.mx, -T / 3);
      near(res.reactions.A.fx, (-N * 2) / 3);
      const m = res.members.AB;
      near(m.stations[0].T, (T * 2) / 3);
      near(m.stations[m.stations.length - 1].T, -T / 3);
      near(m.maxAxial.value, (N * 2) / 3);
      near(m.minAxial.value, -N / 3);
      const at = m.stations.filter((s) => s.x === a);
      near(at[0].twist, (((T * 2) / 3) * a) / (G * J));
      near(at[0].u, (((N * 2) / 3) * a) / (E * A));
      expectEquilibrium(res, N);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Planar models through both solvers
// ---------------------------------------------------------------------------------------------

/** The same planar model for the 3D solver: z = 0 and uz / rx / ry restrained everywhere. */
function to3d(model: StructureModel): StructureModel3D {
  const x = new Map(model.nodes.map((n) => [n.id, n.x]));
  const flip = new Map(
    model.members.map((m) => [m.id, (x.get(m.j) as number) < (x.get(m.i) as number) ? -1 : 1]),
  );
  const supported = new Set(model.supports.map((s) => s.node));
  return {
    nodes: model.nodes.map((n) => node(n.id, n.x, n.y, 0)),
    members: model.members.map((m): Member3D =>
      m.type === 'truss'
        ? { id: m.id, i: m.i, j: m.j, type: 'truss', E: m.E, A: m.A }
        : {
            id: m.id,
            i: m.i,
            j: m.j,
            type: 'beam',
            E: m.E,
            G: m.E / 2.6,
            A: m.A,
            Iz: m.I,
            Iy: 0.37 * m.I,
            J: 0.11 * m.I,
            releaseI: m.releaseI ? { mz: true } : undefined,
            releaseJ: m.releaseJ ? { mz: true } : undefined,
          },
    ),
    supports: [
      ...model.supports.map((s): Support3D => ({
        node: s.node,
        ux: s.ux,
        uy: s.uy,
        rz: s.rz,
        uz: true,
        rx: true,
        ry: true,
        settlement: s.settlement,
        spring: s.spring && { ux: s.spring.kx, uy: s.spring.ky, rz: s.spring.kr },
      })),
      ...model.nodes
        .filter((n) => !supported.has(n.id))
        .map((n): Support3D => ({ node: n.id, uz: true, rx: true, ry: true })),
    ],
    loads: model.loads.map((load): Load3D => {
      if (load.kind === 'nodal') return load;
      if (load.kind === 'moment') return { ...load, direction: 'globalZ' };
      // The 3D "web up" rule turns local y over for members drawn right to left.
      const s = load.direction === 'localY' ? (flip.get(load.member) as number) : 1;
      if (load.kind === 'point') return { ...load, P: s * load.P };
      return { ...load, w1: s * load.w1, w2: load.w2 === undefined ? undefined : s * load.w2 };
    }),
  };
}

function expectSameAs2d(model: StructureModel, segments = 10): AnalysisResult3D {
  const r2 = analyze(model, { segments });
  const r3 = analyze3d(to3d(model), { segments });
  const x = new Map(model.nodes.map((n) => [n.id, n.x]));

  let dScale = 0;
  let rScale = 0;
  let fScale = 0;
  let mScale = 0;
  for (const d of Object.values(r2.displacements)) {
    dScale = Math.max(dScale, Math.abs(d.ux), Math.abs(d.uy));
    rScale = Math.max(rScale, Math.abs(d.rz));
  }
  for (const m of Object.values(r2.members)) {
    for (const s of m.stations) {
      fScale = Math.max(fScale, Math.abs(s.N), Math.abs(s.V));
      mScale = Math.max(mScale, Math.abs(s.M));
      dScale = Math.max(dScale, Math.abs(s.u), Math.abs(s.v));
    }
  }
  mScale = Math.max(mScale, fScale);
  const rel = 1e-8;
  const same = (actual: number, expected: number, scale: number) => {
    if (!(Math.abs(actual - expected) <= rel * scale)) {
      throw new Error(`3D value ${actual} differs from 2D value ${expected} (scale ${scale})`);
    }
  };

  for (const n of model.nodes) {
    const a = r3.displacements[n.id];
    const b = r2.displacements[n.id];
    same(a.ux, b.ux, dScale);
    same(a.uy, b.uy, dScale);
    same(a.rz, b.rz, rScale);
    expect([a.uz, a.rx, a.ry]).toEqual([0, 0, 0]);
  }
  for (const [id, b] of Object.entries(r2.reactions)) {
    const a = r3.reactions[id];
    same(a.fx, b.fx, fScale);
    same(a.fy, b.fy, fScale);
    same(a.mz, b.mz, mScale);
    same(a.fz, 0, fScale);
    same(a.mx, 0, mScale);
    same(a.my, 0, mScale);
  }
  for (const member of model.members) {
    const a = r3.members[member.id];
    const b = r2.members[member.id];
    const s = (x.get(member.j) as number) < (x.get(member.i) as number) ? -1 : 1;
    expect(a.stations).toHaveLength(b.stations.length);
    same(a.length, b.length, b.length);
    b.stations.forEach((sb, k) => {
      const sa = a.stations[k];
      same(sa.x, sb.x, b.length);
      same(sa.N, sb.N, fScale);
      same(s * sa.Vy, sb.V, fScale);
      same(s * sa.Mz, sb.M, mScale);
      same(sa.u, sb.u, dScale);
      same(s * sa.v, sb.v, dScale);
      same(sa.Vz, 0, fScale);
      same(sa.My, 0, mScale);
      same(sa.T, 0, mScale);
      same(sa.w, 0, dScale);
    });
    same(s * a.maxAbsMz.value, b.maxAbsMoment.value, mScale);
    same(s * a.maxAbsVy.value, b.maxAbsShear.value, fScale);
    same(a.maxAxial.value, b.maxAxial.value, fScale);
    same(a.minAxial.value, b.minAxial.value, fScale);
    same(Math.abs(a.maxAbsDeflection.value), Math.abs(b.maxAbsDeflection.value), dScale);
  }
  same(r3.maxDisplacement, r2.maxDisplacement, dScale);
  same(r3.equilibrium[0], r2.equilibrium[0], fScale);
  same(r3.equilibrium[1], r2.equilibrium[1], fScale);
  same(r3.equilibrium[5], r2.equilibrium[2], mScale);
  expectEquilibrium(r3, mScale, 1e-8);
  return r3;
}

describe('planar models agree with the 2D solver', () => {
  const frame2 = (
    id: string,
    i: string,
    j: string,
    extra: Partial<SolverMember> = {},
  ): SolverMember => ({ id, i, j, type: 'frame', E, A, I: Iz, ...extra });
  const truss2 = (id: string, i: string, j: string): SolverMember => ({
    id,
    i,
    j,
    type: 'truss',
    E,
    A: 0.004,
    I: 0,
  });

  it('gable frame with a ridge hinge and every member load type', () => {
    const res = expectSameAs2d({
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 0, y: 4 },
        { id: 'C', x: 3, y: 5.5 },
        { id: 'D', x: 6, y: 4 },
        { id: 'E', x: 6.5, y: 0 },
      ],
      members: [
        frame2('AB', 'A', 'B'),
        frame2('BC', 'B', 'C', { releaseJ: true, I: 2 * Iz }),
        frame2('DC', 'D', 'C', { A: 0.02 }),
        frame2('DE', 'D', 'E'),
      ],
      supports: [
        { node: 'A', ux: true, uy: true, rz: true },
        { node: 'E', ux: true, uy: true },
      ],
      loads: [
        { kind: 'nodal', node: 'B', fx: 25, mz: -4 },
        { kind: 'distributed', member: 'BC', direction: 'globalY', w1: -8 },
        { kind: 'distributed', member: 'BC', direction: 'localY', w1: -2, w2: -6, a: 0.5, b: 2.5 },
        { kind: 'distributed', member: 'DC', direction: 'localY', w1: 5, w2: 1 },
        { kind: 'distributed', member: 'DC', direction: 'localX', w1: 3 },
        { kind: 'point', member: 'AB', direction: 'localY', P: 12, a: 1.5 },
        { kind: 'point', member: 'DE', direction: 'globalX', P: -7, a: 2.2 },
        { kind: 'moment', member: 'DC', M: 9, a: 1 },
      ],
    });
    expect(res.warnings).toEqual([]);
  });

  it('pin-jointed truss', () => {
    const model: StructureModel = {
      nodes: [
        { id: 'L0', x: 0, y: 0 },
        { id: 'L1', x: 3, y: 0 },
        { id: 'L2', x: 6, y: 0 },
        { id: 'L3', x: 9, y: 0 },
        { id: 'U1', x: 3, y: 3.5 },
        { id: 'U2', x: 6, y: 3.5 },
      ],
      members: [
        truss2('b1', 'L0', 'L1'),
        truss2('b2', 'L2', 'L1'),
        truss2('b3', 'L2', 'L3'),
        truss2('t1', 'U2', 'U1'),
        truss2('d1', 'L0', 'U1'),
        truss2('d2', 'U1', 'L2'),
        truss2('d3', 'L3', 'U2'),
        truss2('v1', 'U1', 'L1'),
        truss2('v2', 'L2', 'U2'),
      ],
      supports: [
        { node: 'L0', ux: true, uy: true },
        { node: 'L3', uy: true },
      ],
      loads: [
        { kind: 'nodal', node: 'L1', fy: -40 },
        { kind: 'nodal', node: 'L2', fy: -65 },
        { kind: 'nodal', node: 'U1', fx: 15 },
      ],
    };
    const res = expectSameAs2d(model);
    // Only the in-plane translations of the free joints are unknowns.
    expect(res.dofCount).toBe(2 * 6 - 3);
    expect(res.warnings).toEqual([]);
  });

  it('continuous beam with a settlement, springs and members drawn both ways', () => {
    expectSameAs2d({
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 4, y: 0 },
        { id: 'C', x: 9, y: 0 },
        { id: 'D', x: 12, y: 0 },
      ],
      members: [frame2('AB', 'A', 'B'), frame2('CB', 'C', 'B'), frame2('CD', 'C', 'D')],
      supports: [
        { node: 'A', ux: true, uy: true, rz: true },
        { node: 'B', uy: true, settlement: { uy: -0.012 } },
        { node: 'C', spring: { ky: 8000 } },
        { node: 'D', uy: true, spring: { kr: 1500, kx: 300 } },
      ],
      loads: [
        { kind: 'distributed', member: 'AB', direction: 'localY', w1: -10 },
        { kind: 'distributed', member: 'CB', direction: 'localY', w1: 0, w2: 14, a: 1, b: 4 },
        { kind: 'point', member: 'CB', direction: 'globalY', P: -18, a: 3.2 },
        { kind: 'point', member: 'CD', direction: 'localY', P: -22, a: 1.1 },
        { kind: 'moment', member: 'CB', M: -6, a: 2 },
        { kind: 'nodal', node: 'D', fx: 11 },
      ],
    });
  });

  it('braced frame mixing beams, trusses and hinges', () => {
    expectSameAs2d(
      {
        nodes: [
          { id: 'A', x: 0, y: 0 },
          { id: 'B', x: 0, y: 3 },
          { id: 'C', x: 5, y: 3 },
          { id: 'D', x: 5, y: 0 },
          { id: 'T', x: 8, y: 3 },
        ],
        members: [
          frame2('BA', 'B', 'A'),
          frame2('CB', 'C', 'B', { releaseI: true }),
          frame2('DC', 'D', 'C'),
          truss2('AC', 'A', 'C'),
          truss2('CT', 'C', 'T'),
          truss2('DT', 'D', 'T'),
        ],
        supports: [
          { node: 'A', ux: true, uy: true },
          { node: 'D', ux: true, uy: true, rz: true, settlement: { ux: 0.004, rz: 0.002 } },
        ],
        loads: [
          { kind: 'distributed', member: 'CB', direction: 'localY', w1: 6 },
          { kind: 'distributed', member: 'BA', direction: 'globalX', w1: 2, w2: 5 },
          { kind: 'nodal', node: 'T', fy: -30, fx: 4 },
        ],
      },
      7,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Plates
// ---------------------------------------------------------------------------------------------

describe('plates', () => {
  it('simply supported square plate under uniform pressure', () => {
    const a = 4;
    const t = 0.04;
    const nu = 0.3;
    const q = 5;
    const n = 16;
    const grid = plateGrid('N', n, n, a, a, 0, { E, nu, t });
    const supports: Support3D[] = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        if (i !== 0 && i !== n && j !== 0 && j !== n) continue;
        const s: Support3D = { node: `N${i}_${j}`, uy: true };
        // Hard simple support: no rotation about the normal of the edge.
        if (j === 0 || j === n) s.rz = true;
        if (i === 0 || i === n) s.rx = true;
        if (i === 0 && j === 0) Object.assign(s, { ux: true, uz: true });
        if (i === n && j === 0) s.uz = true;
        supports.push(s);
      }
    }
    const res = analyze3d({
      nodes: grid.nodes,
      plates: grid.plates,
      supports,
      loads: grid.plates.map((p): Load3D => ({
        kind: 'pressure',
        plate: p.id,
        direction: 'globalY',
        p: -q,
      })),
    });
    expect(res.warnings).toEqual([]);
    const D = (E * t ** 3) / (12 * (1 - nu * nu));
    near(res.displacements[`N${n / 2}_${n / 2}`].uy, (-0.00406 * q * a ** 4) / D, 5e-3);
    near(res.maxDisplacement, (0.00406 * q * a ** 4) / D, 5e-3);
    // Centre moments: 0.0479·q·a², sagging under a load along −local z is negative.
    const corner = res.plates[`NP${n / 2}_${n / 2}`].corners[0];
    near(corner.Mx, -0.0479 * q * a * a, 1e-2);
    near(corner.My, -0.0479 * q * a * a, 1e-2);
    expect(corner.bottom.sx).toBeGreaterThan(0);
    expect(corner.top.sx).toBeLessThan(0);
    expect(res.plates[`NP0_0`].axes.z.map((v) => v + 0)).toEqual([0, 1, 0]);
    near(res.plates[`NP0_0`].area, (a / n) ** 2);

    near(sumReactions(res, 'fy'), q * a * a);
    near(res.appliedLoad[1], -q * a * a);
    expect(Object.keys(res.plates)).toHaveLength(n * n);
    expectEquilibrium(res, q * a * a * a);
  });

  it('membrane action: a wall plate strip in tension, tilted in space', () => {
    // One strip of three plates in the plane x = z, pulled along its length.
    const L = 3;
    const b = 1;
    const t = 0.02;
    const c = Math.SQRT1_2;
    const nodes: Node3D[] = [];
    const plates: Plate3D[] = [];
    for (let i = 0; i <= 3; i++) {
      nodes.push(node(`a${i}`, c * i, 0, c * i), node(`b${i}`, c * i, b, c * i));
      if (i > 0) {
        plates.push({
          id: `W${i}`,
          nodes: [`a${i - 1}`, `a${i}`, `b${i}`, `b${i - 1}`],
          E,
          nu: 0,
          t,
        });
      }
    }
    const F = 60;
    const res = analyze3d({
      nodes,
      plates,
      supports: [fixed('a0'), fixed('b0')],
      loads: [
        { kind: 'nodal', node: 'a3', fx: (F / 2) * c, fz: (F / 2) * c },
        { kind: 'nodal', node: 'b3', fx: (F / 2) * c, fz: (F / 2) * c },
      ],
    });
    const elongation = (F * L) / (E * b * t);
    near(res.displacements.a3.ux, elongation * c);
    near(res.displacements.b3.uz, elongation * c);
    near(res.plates.W2.center.Nx, F / b);
    near(res.plates.W2.center.top.sx, F / (b * t));
    near(res.plates.W2.maxVonMises, F / (b * t));
    expect(Math.abs(res.plates.W2.center.Mx)).toBeLessThan(1e-9);
    expectEquilibrium(res, F * L);
  });

  it('reports a warped plate', () => {
    const res = analyze3d({
      nodes: [node('1', 0, 0, 0), node('2', 1, 0, 0), node('3', 1, 0.1, 1), node('4', 0, 0, 1)],
      plates: [{ id: 'W', nodes: ['1', '4', '3', '2'], E, nu: 0.3, t: 0.05 }],
      supports: [fixed('1'), fixed('2'), fixed('4')],
      loads: [{ kind: 'nodal', node: '3', fy: -1 }],
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/Plate "W" is warped/);
    expect(res.displacements['3'].uy).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Solids
// ---------------------------------------------------------------------------------------------

describe('solids', () => {
  it('uniaxial bar: uniform stress, elongation and lateral contraction', () => {
    const L = 3;
    const nu = 0.3;
    const sigma = 1200;
    const { nodes, solids } = solidBlock('S', [3, 1, 1], [L, 1, 1], [0, 0, 0], { E, nu });
    const res = analyze3d({
      nodes,
      solids,
      supports: [
        pinned('S0_0_0'),
        { node: 'S0_1_0', ux: true, uz: true },
        { node: 'S0_0_1', ux: true, uy: true },
        { node: 'S0_1_1', ux: true },
      ],
      // A negative pressure pulls on the +X face (face 4 of the last element).
      loads: [{ kind: 'face', solid: 'SH2_0_0', face: 4, direction: 'normal', p: -sigma }],
    });
    expect(res.dofCount).toBe(16 * 3 - 8);
    expect(res.warnings).toEqual([]);
    near(res.displacements.S3_1_1.ux, (sigma * L) / E);
    near(res.displacements.S3_1_1.uy, (-nu * sigma) / E);
    near(res.displacements.S3_1_1.uz, (-nu * sigma) / E);
    expect(res.displacements.S3_1_1.rx).toBe(0);
    for (const solid of Object.values(res.solids)) {
      near(solid.volume, 1);
      for (const state of [solid.center, ...solid.corners]) {
        near(state.sxx, sigma);
        near(state.s1, sigma);
        near(state.vonMises, sigma);
        expect(Math.abs(state.syy) + Math.abs(state.szz) + Math.abs(state.txy)).toBeLessThan(1e-6);
      }
      near(solid.maxVonMises, sigma);
    }
    near(sumReactions(res, 'fx'), -sigma);
    expect(res.appliedLoad[0]).toBeCloseTo(sigma, 8);
    expectEquilibrium(res, sigma);
  });

  it('cantilever block against beam theory', () => {
    const L = 10;
    const P = 100;
    const nx = 10;
    const { nodes, solids } = solidBlock('S', [nx, 1, 1], [L, 1, 1], [0, 0, 0], { E, nu: 0 });
    const res = analyze3d({
      nodes,
      solids,
      supports: nodes.filter((n) => n.x === 0).map((n) => pinned(n.id)),
      loads: [{ kind: 'face', solid: `SH${nx - 1}_0_0`, face: 4, direction: 'globalY', p: -P }],
    });
    const I = 1 / 12;
    const shear = (P * L) / ((5 / 6) * (E / 2));
    const theory = (P * L ** 3) / (3 * E * I) + shear;
    near(res.displacements[`S${nx}_0_0`].uy, -theory, 0.02);
    near(res.displacements[`S${nx}_1_1`].uy, -theory, 0.02);
    near(sumReactions(res, 'fy'), P);
    near(res.appliedLoad[1], -P);
    // Bending stress at the mid-length section of the root element (exact there): M·c/I.
    const root = res.solids.SH0_0_0;
    const top = (root.corners[2].sxx + root.corners[3].sxx) / 2;
    const bottom = (root.corners[0].sxx + root.corners[1].sxx) / 2;
    near(top, (P * (L - 0.5) * 0.5) / I, 0.02);
    near(bottom, (-P * (L - 0.5) * 0.5) / I, 0.02);
    expectEquilibrium(res, P * L);
  });
});

// ---------------------------------------------------------------------------------------------
// Mixed model
// ---------------------------------------------------------------------------------------------

describe('mixed model: slab on beams and columns, bracing and a solid footing', () => {
  const slab = plateGrid('S', 2, 2, 4, 4, 3, { E: 3e7, nu: 0.2, t: 0.15, density: 25 });
  const footing = solidBlock('F', [2, 1, 2], [1, 0.6, 1], [-0.5, -0.6, -0.5], {
    E: 2.5e7,
    nu: 0.2,
    density: 24,
  });
  const rhoB = 78.5;
  const rhoT = 60;
  const At = 0.002;
  const column = (id: string, i: string, j: string) => beam(id, i, j, { density: rhoB });
  const members: Member3D[] = [
    column('C00', 'F1_1_1', 'S0_0'),
    column('C20', 'B2_0', 'S2_0'),
    column('C02', 'B0_2', 'S0_2'),
    column('C22', 'B2_2', 'S2_2'),
  ];
  for (let k = 0; k < 2; k++) {
    for (const edge of [0, 2]) {
      members.push(
        beam(`BX${k}_${edge}`, `S${k}_${edge}`, `S${k + 1}_${edge}`, { density: rhoB, beta: 0.4 }),
        beam(`BZ${edge}_${k}`, `S${edge}_${k}`, `S${edge}_${k + 1}`, { density: rhoB }),
      );
    }
  }
  const brace = (id: string, i: string, j: string) => truss(id, i, j, { A: At, density: rhoT });
  members.push(
    brace('T1', 'B2_0', 'S0_0'),
    brace('T2', 'B0_2', 'S0_0'),
    brace('T3', 'B2_2', 'S2_0'),
    brace('T4', 'B2_2', 'S0_2'),
  );
  const q = 4;
  const w = 6;
  const Pc = 9;
  const H: Vec3 = [14, 0, -5];
  const pf = 50;
  const model: StructureModel3D = {
    nodes: [
      ...slab.nodes,
      ...footing.nodes,
      node('B2_0', 4, 0, 0),
      node('B0_2', 0, 0, 4),
      node('B2_2', 4, 0, 4),
    ],
    members,
    plates: slab.plates,
    solids: footing.solids,
    supports: [
      fixed('B2_0'),
      fixed('B0_2'),
      fixed('B2_2'),
      ...footing.nodes.filter((n) => n.y < -0.5).map((n) => pinned(n.id)),
    ],
    loads: [
      { kind: 'selfWeight', direction: 'globalY', factor: -1 },
      ...slab.plates.map((p): Load3D => ({
        kind: 'pressure',
        plate: p.id,
        direction: 'localZ',
        p: -q,
      })),
      { kind: 'distributed', member: 'BX0_0', direction: 'globalY', w1: -w },
      { kind: 'point', member: 'C22', direction: 'globalX', P: Pc, a: 1.5 },
      { kind: 'nodal', node: 'S2_2', fx: H[0], fz: H[2] },
      { kind: 'face', solid: 'FH0_0_0', face: 5, direction: 'normal', p: pf },
    ],
  };

  it('is in equilibrium and reports the hand-computed total load', () => {
    const res = analyze3d(model);
    expect(res.warnings).toEqual([]);
    const weight =
      rhoB * A * (8 * 2 + 4 * 3) + rhoT * At * 4 * 5 + 25 * 0.15 * 16 + 24 * 0.6 * 1 * 1;
    const totalY = -(weight + q * 16 + w * 2 + pf * 0.25);
    near(res.appliedLoad[0], H[0] + Pc);
    near(res.appliedLoad[1], totalY);
    near(res.appliedLoad[2], H[2]);
    near(sumReactions(res, 'fx'), -(H[0] + Pc));
    near(sumReactions(res, 'fy'), -totalY);
    near(sumReactions(res, 'fz'), -H[2]);
    expectEquilibrium(res, Math.abs(totalY) * 4, 1e-9);

    expect(Object.keys(res.displacements)).toHaveLength(model.nodes.length);
    expect(Object.keys(res.members)).toHaveLength(members.length);
    expect(Object.keys(res.plates)).toHaveLength(4);
    expect(Object.keys(res.solids)).toHaveLength(4);
    expect(Object.keys(res.reactions)).toHaveLength(3 + 9);
    // 9 slab nodes × 6, the column base on the footing × 6, 8 free footing nodes × 3.
    expect(res.dofCount).toBe(9 * 6 + 6 + 8 * 3);
    expect(res.maxDisplacement).toBeGreaterThan(0);
    expect(res.displacements.S1_1.uy).toBeLessThan(0);
    // The footing column is in compression, and so is the footing below it.
    expect(res.members.C00.maxAxial.value).toBeLessThan(0);
    expect(res.solids.FH0_0_0.center.syy).toBeLessThan(0);
    expect(res.plates.SP0_0.maxVonMises).toBeGreaterThan(0);
    for (const value of Object.values(res.displacements)) {
      for (const key of Object.keys(value) as Dof6[])
        expect(Number.isFinite(value[key])).toBe(true);
    }
  });

  it('gives the same answer whatever the order of the nodes', () => {
    const reference = analyze3d(model);
    const shuffled = analyze3d({ ...model, nodes: [...model.nodes].reverse() });
    for (const n of model.nodes) {
      for (const key of ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const) {
        near(shuffled.displacements[n.id][key], reference.displacements[n.id][key], 1e-7, 1e-6);
      }
    }
    expect(shuffled.dofCount).toBe(reference.dofCount);
  });
});

// ---------------------------------------------------------------------------------------------
// Supports
// ---------------------------------------------------------------------------------------------

describe('supports', () => {
  const L = 4;
  const span = (supports: Support3D[], loads: Load3D[] = []): StructureModel3D => ({
    nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
    members: [beam('AB', 'A', 'B')],
    supports,
    loads,
  });

  it('support settlement of a fixed-fixed beam', () => {
    const delta = -0.01;
    const res = analyze3d(
      span([fixed('A'), { ...fixed('B'), settlement: { uy: delta, rx: 0.003 } }]),
    );
    expect(res.displacements.B.uy).toBe(delta);
    expect(res.displacements.B.rx).toBe(0.003);
    const shear = (12 * E * Iz * Math.abs(delta)) / L ** 3;
    near(res.reactions.A.fy, shear);
    near(res.reactions.B.fy, -shear);
    near(res.reactions.A.mz, (6 * E * Iz * Math.abs(delta)) / L ** 2);
    near(res.reactions.B.mz, (6 * E * Iz * Math.abs(delta)) / L ** 2);
    near(res.reactions.B.mx, (G * J * 0.003) / L);
    near(res.reactions.A.mx, (-G * J * 0.003) / L);
    expect(res.appliedLoad).toEqual([0, 0, 0]);
    expectEquilibrium(res, shear * L);
  });

  it('settlement of a support next to free degrees of freedom', () => {
    // Propped cantilever: the prop settles; R = 3·EI·Δ/L³.
    const delta = -0.02;
    const res = analyze3d(
      span([fixed('A'), { node: 'B', uy: true, settlement: { uy: delta, uz: 5 } }]),
    );
    near(res.reactions.B.fy, (3 * E * Iz * delta) / L ** 3);
    near(res.reactions.A.fy, (-3 * E * Iz * delta) / L ** 3);
    near(res.displacements.B.rz, (1.5 * delta) / L);
    // A settlement on a degree of freedom that is not restrained is ignored.
    expect(Math.abs(res.displacements.B.uz)).toBeLessThan(1e-12);
  });

  it('translational and rotational springs: reaction = −k·u', () => {
    const P = 15;
    const k = 2500;
    const kr = 900;
    const res = analyze3d(
      span(
        [fixed('A'), { node: 'B', spring: { uy: k, rx: kr, uz: 0 } }],
        [{ kind: 'nodal', node: 'B', fy: -P, mx: 3 }],
      ),
    );
    const uy = -P / (k + (3 * E * Iz) / L ** 3);
    near(res.displacements.B.uy, uy);
    near(res.reactions.B.fy, -k * uy);
    const rx = 3 / (kr + (G * J) / L);
    near(res.displacements.B.rx, rx);
    near(res.reactions.B.mx, -kr * rx);
    near(res.reactions.A.fy, P + k * uy);
    expect(res.reactions.B.fz).toBe(0);
    expectEquilibrium(res, P * L);
  });

  it('a spring alone can support the structure; springs on restrained DOFs are ignored', () => {
    const k = 4000;
    const res = analyze3d({
      nodes: [node('A', 0, 0, 0), node('B', 2, 0, 0)],
      members: [truss('AB', 'A', 'B')],
      supports: [
        { node: 'A', spring: { ux: k } },
        { node: 'A', uy: true, spring: { uy: 123 } },
        { node: 'B', uy: true },
      ],
      loads: [{ kind: 'nodal', node: 'B', fx: 10 }],
    });
    near(res.displacements.A.ux, 10 / k);
    near(res.displacements.B.ux, 10 / k + (10 * 2) / (E * A));
    near(res.reactions.A.fx, -10);
    expect(res.reactions.A.fy).toBe(0);
    expect(Object.keys(res.reactions)).toEqual(['A', 'B']);
    expect(res.dofCount).toBe(2);
    expectEquilibrium(res, 10);
  });

  it('inclined member with global and local loads', () => {
    // Simply supported rafter in a skew vertical plane.
    const B: Vec3 = [3, 2, 1.5];
    const length = Math.hypot(...B);
    const wg = 4;
    const wl = 2.5;
    const res = analyze3d({
      nodes: [node('A', 0, 0, 0), node('B', ...B)],
      members: [beam('AB', 'A', 'B')],
      supports: [
        { ...pinned('A'), rx: true },
        { node: 'B', uy: true },
      ],
      loads: [
        { kind: 'distributed', member: 'AB', direction: 'globalY', w1: -wg },
        { kind: 'distributed', member: 'AB', direction: 'localY', w1: -wl },
      ],
    });
    const axes = memberAxes([0, 0, 0], B);
    const total: Vec3 = [
      -wl * length * axes.y[0],
      -wg * length - wl * length * axes.y[1],
      -wl * length * axes.y[2],
    ];
    for (let c = 0; c < 3; c++) near(res.appliedLoad[c], total[c], 1e-9, 1);
    near(sumReactions(res, 'fx'), -total[0], 1e-9, 1);
    near(sumReactions(res, 'fy'), -total[1], 1e-9, 1);
    near(sumReactions(res, 'fz'), -total[2], 1e-9, 1);
    // The transverse component of the load gives w·L²/8 at mid-span.
    const wy = wg * axes.y[1] + wl;
    near(res.members.AB.maxAbsMz.value, (wy * length ** 2) / 8, 1e-9);
    expectEquilibrium(res, wg * length * 3);
  });

  it('random space frame: reactions balance the loads in all six components', () => {
    const random = rng(20240611);
    const between = (lo: number, hi: number) => lo + (hi - lo) * random();
    const nodes: Node3D[] = [];
    for (let k = 0; k < 9; k++) {
      nodes.push(node(`N${k}`, between(0, 8), between(0, 6), between(0, 8)));
    }
    const members: Member3D[] = [];
    const add = (i: number, j: number) => {
      const type = random() < 0.25 ? 'truss' : 'beam';
      members.push({
        id: `M${members.length}`,
        i: `N${i}`,
        j: `N${j}`,
        type,
        E,
        G,
        A: between(0.005, 0.02),
        Iy: between(2e-5, 9e-5),
        Iz: between(5e-5, 2e-4),
        J: between(1e-5, 5e-5),
        beta: between(-Math.PI, Math.PI),
        density: between(20, 80),
        releaseJ: random() < 0.2 ? { mz: true, my: true } : undefined,
      });
    };
    for (let k = 1; k < 9; k++) add(k - 1, k);
    for (let k = 0; k < 9; k++) add(k, (k + 2 + Math.floor(between(0, 5))) % 9);
    const pickDirection = () =>
      (['localX', 'localY', 'localZ', 'globalX', 'globalY', 'globalZ'] as const)[
        Math.floor(between(0, 6))
      ];
    const loads: Load3D[] = [
      { kind: 'selfWeight', direction: 'globalY', factor: -1 },
      { kind: 'selfWeight', direction: 'globalX', factor: 0.2 },
    ];
    for (let k = 0; k < 9; k++) {
      loads.push({
        kind: 'nodal',
        node: `N${k}`,
        fx: between(-10, 10),
        fy: between(-10, 10),
        fz: between(-10, 10),
        mx: between(-5, 5),
        my: between(-5, 5),
        mz: between(-5, 5),
      });
    }
    for (const m of members) {
      if (m.type === 'truss') continue;
      loads.push(
        { kind: 'distributed', member: m.id, direction: pickDirection(), w1: 3, w2: -1, a: 0.1 },
        { kind: 'point', member: m.id, direction: pickDirection(), P: between(-9, 9), a: 0.4 },
        { kind: 'moment', member: m.id, direction: pickDirection(), M: between(-4, 4), a: 0.2 },
      );
    }
    const res = analyze3d({
      nodes,
      members,
      supports: [
        fixed('N0'),
        pinned('N4'),
        { node: 'N8', uy: true, rz: true, spring: { ux: 5000, ry: 800 } },
      ],
      loads,
    });
    expect(res.warnings).toEqual([]);
    expectEquilibrium(res, 1000, 1e-9);
    for (let c = 0; c < 3; c++) {
      const key = (['fx', 'fy', 'fz'] as const)[c];
      near(sumReactions(res, key), -res.appliedLoad[c], 1e-8, 10);
    }
    expect(Math.abs(res.appliedLoad[1])).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------------------------
// Mechanisms and inactive degrees of freedom
// ---------------------------------------------------------------------------------------------

describe('mechanisms', () => {
  const L = 4;
  const onPins = (loads: Load3D[]): StructureModel3D => ({
    nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
    members: [beam('AB', 'A', 'B')],
    supports: [pinned('A'), { node: 'B', uy: true, uz: true }],
    loads,
  });

  it('an excited mechanism is an error that names the node', () => {
    const err = expectError(
      () => analyze3d(onPins([{ kind: 'moment', member: 'AB', direction: 'localX', M: 2, a: 1 }])),
      'UNSTABLE',
      /The structure is unstable: a mechanism was detected at node "[AB]" \(rotation about X\)\. Check that the supports/,
    );
    expect(['A', 'B']).toContain(err.nodeId);
  });

  it('a beam resting on vertical supports only: sliding is held, a push is an error', () => {
    const model = (loads: Load3D[]): StructureModel3D => ({
      nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
      members: [beam('AB', 'A', 'B')],
      supports: [
        { node: 'A', uy: true },
        { node: 'B', uy: true },
      ],
      loads,
    });
    const P = 10;
    const res = analyze3d(
      model([{ kind: 'point', member: 'AB', direction: 'globalY', P: -P, a: 1 }]),
    );
    near(res.reactions.A.fy, (P * 3) / 4);
    near(res.reactions.B.fy, P / 4);
    near(res.members.AB.maxAbsMz.value, (P * 1 * 3) / 4);
    expect(res.warnings).toHaveLength(4);
    expect(res.warnings.join('\n')).toMatch(/free to move along X \(ux\)/);
    expect(res.warnings.join('\n')).toMatch(/free to move along Z \(uz\)/);
    expect(res.warnings.join('\n')).toMatch(/free to rotate about X \(rx\)/);
    expect(res.warnings.join('\n')).toMatch(/free to rotate about Y \(ry\)/);
    expectEquilibrium(res, P * L);

    const err = expectError(
      () => analyze3d(model([{ kind: 'nodal', node: 'B', fx: 1, fy: -5 }])),
      'UNSTABLE',
      /mechanism was detected at node "[AB]" \(translation along X\)/,
    );
    expect(err.nodeId).toBeDefined();
    // The push is detected at whichever end it is applied.
    for (const pushed of ['A', 'B']) {
      expectError(
        () => analyze3d(model([{ kind: 'nodal', node: pushed, fz: 0.5, fy: -5 }])),
        'UNSTABLE',
        /mechanism was detected at node "[AB]" \(translation along Z\)/,
      );
    }
  });

  it('settlement only: an unexcited mechanism is judged against the reactions', () => {
    // Two-span beam on three pins; the middle support settles.
    const delta = -0.01;
    const res = analyze3d({
      nodes: [node('A', 0, 0, 0), node('B', L, 0, 0), node('C', 2 * L, 0, 0)],
      members: [beam('AB', 'A', 'B'), beam('BC', 'B', 'C')],
      supports: [
        pinned('A'),
        { node: 'B', uy: true, uz: true, settlement: { uy: delta } },
        { node: 'C', uy: true, uz: true },
      ],
      loads: [],
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/free to rotate about X/);
    near(res.reactions.B.fy, (48 * E * Iz * delta) / (2 * L) ** 3);
    near(res.reactions.A.fy, (-24 * E * Iz * delta) / (2 * L) ** 3);
    expectEquilibrium(res, 1);
  });

  it('settlement only, on a skew beam: rounding residues do not count as excitation', () => {
    const dir: Vec3 = [0.6, 0.48, 0.64];
    const delta = -0.01;
    const res = analyze3d({
      nodes: [0, 1, 2].map((k) => node(`N${k}`, k * L * dir[0], k * L * dir[1], k * L * dir[2])),
      members: [beam('a', 'N0', 'N1'), beam('b', 'N1', 'N2')],
      supports: [pinned('N0'), { ...pinned('N1'), settlement: { uy: delta } }, pinned('N2')],
      loads: [],
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/free to rotate about [XYZ]/);
    expect(Math.abs(res.reactions.N1.fy)).toBeGreaterThan(1);
    near(res.reactions.N0.fy, -res.reactions.N1.fy / 2, 1e-9);
    expectEquilibrium(res, Math.abs(res.reactions.N1.fy) * L);
  });

  it('a bar loaded across its axis with nothing to resist it is an error', () => {
    const bar = (loads: Load3D[]): StructureModel3D => ({
      nodes: [node('A', 0, 0, 0), node('B', 2, 0, 0)],
      members: [truss('AB', 'A', 'B')],
      supports: [pinned('A')],
      loads,
    });
    // Unloaded in the free directions: they are simply left out.
    const res = analyze3d(bar([{ kind: 'nodal', node: 'B', fx: 50 }]));
    expect(res.dofCount).toBe(1);
    expect(res.warnings).toEqual([]);
    near(res.displacements.B.ux, (50 * 2) / (E * A));
    near(res.members.AB.stations[0].N, 50);

    const err = expectError(
      () => analyze3d(bar([{ kind: 'nodal', node: 'B', fx: 50, fz: 1 }])),
      'UNSTABLE',
      /node "B" \(translation along Z\)/,
    );
    expect(err.nodeId).toBe('B');
    expectError(
      () => analyze3d(bar([{ kind: 'distributed', member: 'AB', direction: 'globalY', w1: -1 }])),
      'UNSTABLE',
      /node "B" \(translation along Y\)/,
    );
  });

  it('a member whose own releases form a loaded mechanism reports the member', () => {
    const err = expectError(
      () =>
        analyze3d({
          nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
          members: [beam('AB', 'A', 'B', { releaseI: { mx: true }, releaseJ: { mx: true } })],
          supports: [fixed('A'), fixed('B')],
          loads: [{ kind: 'moment', member: 'AB', direction: 'localX', M: 1, a: 1 }],
        }),
      'UNSTABLE',
      /end releases of member "AB"/,
    );
    expect(err.memberId).toBe('AB');
  });

  it('no supports', () => {
    const model = onPins([]);
    expectError(
      () => analyze3d({ ...model, supports: [] }),
      'UNSTABLE',
      /^The structure has no supports\. Add at least one support/,
    );
    expectError(
      () => validateModel3d({ ...model, supports: [{ node: 'A', spring: { ux: 0 } }] }),
      'UNSTABLE',
      /no supports/,
    );
    expect(() =>
      validateModel3d({ ...model, supports: [{ node: 'A', spring: { rz: 5 } }] }),
    ).not.toThrow();
  });

  it('a solution that overflows is reported as unstable', () => {
    expectError(
      () =>
        analyze3d({
          nodes: [node('A', 0, 0, 0), node('B', 1, 0, 0)],
          members: [truss('AB', 'A', 'B', { E: 1e-300, A: 1e-3 })],
          supports: [pinned('A')],
          loads: [{ kind: 'nodal', node: 'B', fx: 1e300 }],
        }),
      'UNSTABLE',
      /did not converge/,
    );
  });
});

describe('inactive degrees of freedom and warnings', () => {
  it('ignores an unconnected node and the load on it', () => {
    const model: StructureModel3D = {
      nodes: [node('A', 0, 0, 0), node('B', 2, 0, 0), node('X', 9, 9, 9), node('Y', 5, 5, 5)],
      members: [beam('AB', 'A', 'B')],
      supports: [fixed('A'), { node: 'Y', uy: true }],
      loads: [
        { kind: 'nodal', node: 'B', fy: -3 },
        { kind: 'nodal', node: 'X', fx: 7, mz: 1 },
        { kind: 'nodal', node: 'Y', fy: -2 },
      ],
    };
    const res = analyze3d(model);
    expect(res.warnings).toEqual([
      'Node "X" is not connected to any element and was ignored.',
      'The load applied at unconnected node "X" was ignored.',
      'Node "Y" is not connected to any element and was ignored.',
    ]);
    expect(res.displacements.X).toEqual({ ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 });
    expect(res.dofCount).toBe(6);
    // The load on the restrained DOF of the loose node goes straight into its support.
    expect(res.reactions.Y.fy).toBe(2);
    expect(res.appliedLoad).toEqual([0, -5, 0]);
    expectEquilibrium(res, 10);
  });

  it('warns about a moment at a joint where nothing can resist it', () => {
    const res = analyze3d({
      nodes: [node('A', 0, 0, 0), node('B', 2, 0, 0), node('C', 1, 1.5, 0), node('D', 1, 0, 2)],
      members: [truss('AC', 'A', 'C'), truss('BC', 'B', 'C'), truss('DC', 'D', 'C')],
      supports: [pinned('A'), pinned('B'), pinned('D')],
      loads: [{ kind: 'nodal', node: 'C', fy: -10, mx: 2, mz: -1 }],
    });
    expect(res.warnings).toEqual([
      'A moment about X (rx), Z (rz) is applied at node "C", but no element there can resist ' +
        'it (only truss members, solids or released member ends meet at the node). It was ignored.',
    ]);
    expect(res.dofCount).toBe(3);
    expectEquilibrium(res, 20);
  });

  it('passes on warnings of the element modules', () => {
    const res = analyze3d({
      nodes: [node('A', 0, 0, 0), node('B', 2, 0, 0)],
      members: [truss('AB', 'A', 'B')],
      supports: [pinned('A'), pinned('B')],
      loads: [{ kind: 'moment', member: 'AB', direction: 'localX', M: 2, a: 1 }],
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/truss member "AB"/);
  });

  it('uses at least two segments and defaults to twenty', () => {
    const model: StructureModel3D = {
      nodes: [node('A', 0, 0, 0), node('B', 2, 0, 0)],
      members: [beam('AB', 'A', 'B')],
      supports: [fixed('A')],
      loads: [{ kind: 'nodal', node: 'B', fy: -1 }],
    };
    expect(analyze3d(model).members.AB.stations).toHaveLength(21);
    expect(analyze3d(model, { segments: 0 }).members.AB.stations).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

describe('validation', () => {
  const valid = (): StructureModel3D => ({
    nodes: [
      node('A', 0, 0, 0),
      node('B', 1, 0, 0),
      node('C', 1, 0, 1),
      node('D', 0, 0, 1),
      node('E', 0, 1, 0),
      node('F', 1, 1, 0),
      node('G', 1, 1, 1),
      node('H', 0, 1, 1),
    ],
    members: [beam('M', 'A', 'B')],
    plates: [{ id: 'P', nodes: ['E', 'H', 'G', 'F'], E, nu: 0.3, t: 0.1 }],
    solids: [{ id: 'S', nodes: ['A', 'D', 'C', 'B', 'E', 'H', 'G', 'F'], E, nu: 0.3 }],
    supports: [fixed('A'), pinned('B'), pinned('C'), pinned('D')],
    loads: [{ kind: 'nodal', node: 'G', fy: -1 }],
  });
  const reject = (change: (m: StructureModel3D) => void, pattern: RegExp): SolverError => {
    const model = valid();
    change(model);
    expectError(() => validateModel3d(model), 'INVALID_MODEL', pattern);
    return expectError(() => analyze3d(model), 'INVALID_MODEL', pattern);
  };

  it('accepts the reference model', () => {
    expect(() => validateModel3d(valid())).not.toThrow();
    const res = analyze3d(valid());
    expect(res.displacements.G.uy).toBeLessThan(0);
    expectEquilibrium(res, 1);
  });

  it('nodes and elements must exist', () => {
    reject((m) => {
      m.nodes = [];
    }, /^The model has no nodes\.$/);
    reject((m) => {
      m.members = [];
      m.plates = undefined;
      m.solids = undefined;
    }, /^The model has no elements/);
    const onlyNodes: StructureModel3D = { nodes: [node('A', 0, 0, 0)], supports: [], loads: [] };
    expectError(() => analyze3d(onlyNodes), 'INVALID_MODEL', /no elements/);
  });

  it('node ids and coordinates', () => {
    const err = reject((m) => {
      m.nodes.push(node('A', 5, 5, 5));
    }, /^Duplicate node id "A"\.$/);
    expect(err.nodeId).toBe('A');
    for (const key of ['x', 'y', 'z'] as const) {
      const bad = reject((m) => {
        m.nodes[2][key] = Number.NaN;
      }, /^Node "C" has invalid coordinates\.$/);
      expect(bad.nodeId).toBe('C');
    }
  });

  it('element ids and connectivity', () => {
    expect(
      reject((m) => {
        m.members?.push(beam('M', 'C', 'D'));
      }, /^Duplicate member id "M"\.$/).memberId,
    ).toBe('M');
    reject((m) => {
      m.plates?.push({ ...(m.plates[0] as Plate3D) });
    }, /^Duplicate plate id "P"\.$/);
    reject((m) => {
      m.solids?.push({ ...(m.solids[0] as Solid3D) });
    }, /^Duplicate solid id "S"\.$/);
    reject((m) => {
      (m.members as Member3D[])[0].j = 'nope';
    }, /^Member "M" refers to a node that does not exist\.$/);
    reject((m) => {
      (m.plates as Plate3D[])[0].nodes[2] = 'nope';
    }, /^Plate "P" refers to a node that does not exist\.$/);
    reject((m) => {
      (m.solids as Solid3D[])[0].nodes[7] = 'nope';
    }, /^Solid "S" refers to a node that does not exist\.$/);
    reject((m) => {
      (m.members as Member3D[])[0].j = 'A';
    }, /^Member "M" starts and ends at the same node\.$/);
    reject((m) => {
      (m.plates as Plate3D[])[0].nodes[1] = 'E';
    }, /^Plate "P" uses the same node more than once\.$/);
    expect(
      reject((m) => {
        (m.solids as Solid3D[])[0].nodes[4] = 'A';
      }, /^Solid "S" uses the same node more than once\.$/).memberId,
    ).toBe('S');
  });

  it('supports', () => {
    reject((m) => {
      m.supports.push({ node: 'nope', ux: true });
    }, /^A support refers to missing node "nope"\.$/);
    expect(
      reject((m) => {
        m.supports.push({ node: 'G', spring: { uz: -1 } });
      }, /^The uz spring at node "G" needs a stiffness of zero or more\.$/).nodeId,
    ).toBe('G');
    reject((m) => {
      m.supports.push({ node: 'G', spring: { rx: Number.POSITIVE_INFINITY } });
    }, /The rx spring at node "G"/);
    reject((m) => {
      m.supports[0].settlement = { ry: Number.NaN };
    }, /^The ry settlement at node "A" is not a valid number\.$/);
  });

  it('loads', () => {
    reject((m) => {
      m.loads.push({ kind: 'nodal', node: 'nope', fx: 1 });
    }, /^A load refers to missing node "nope"\.$/);
    reject((m) => {
      m.loads.push({ kind: 'nodal', node: 'G', mz: Number.NaN });
    }, /^A load at node "G" is not a valid number\.$/);
    for (const load of [
      { kind: 'distributed', member: 'P', direction: 'localY', w1: 1 },
      { kind: 'point', member: 'P', direction: 'localY', P: 1, a: 0 },
      { kind: 'moment', member: 'P', direction: 'localY', M: 1, a: 0 },
    ] as Load3D[]) {
      reject((m) => {
        m.loads.push(load);
      }, /^A load refers to missing member "P"\.$/);
    }
    for (const load of [
      { kind: 'pressure', plate: 'M', direction: 'localZ', p: 1 },
      { kind: 'platePoint', plate: 'M', direction: 'localZ', P: 1, xi: 0, eta: 0 },
    ] as Load3D[]) {
      reject((m) => {
        m.loads.push(load);
      }, /^A load refers to missing plate "M"\.$/);
    }
    reject((m) => {
      m.loads.push({ kind: 'face', solid: 'P', face: 1, direction: 'normal', p: 1 });
    }, /^A load refers to missing solid "P"\.$/);
    reject((m) => {
      m.loads.push({ kind: 'selfWeight', direction: 'globalY', factor: Number.NaN });
    }, /^A self-weight load needs a global direction and a finite factor\.$/);
    reject((m) => {
      m.loads.push({ kind: 'selfWeight', direction: 'down', factor: 1 } as unknown as Load3D);
    }, /self-weight load needs a global direction/);
    reject((m) => {
      m.loads.push({ kind: 'wind' } as unknown as Load3D);
    }, /^Unknown load kind "wind"\.$/);
  });

  it('element property and geometry errors come from the element modules with the element id', () => {
    const check = (change: (m: StructureModel3D) => void, pattern: RegExp, id: string) => {
      const model = valid();
      change(model);
      expect(expectError(() => analyze3d(model), 'INVALID_MODEL', pattern).memberId).toBe(id);
    };
    check(
      (m) => {
        (m.members as Member3D[])[0].Iz = 0;
      },
      /Iz/,
      'M',
    );
    check(
      (m) => {
        m.nodes[1] = node('B', 0, 0, 0);
        m.solids = [];
      },
      /zero length/,
      'M',
    );
    check(
      (m) => {
        (m.plates as Plate3D[])[0].t = -1;
      },
      /./,
      'P',
    );
    check(
      (m) => {
        (m.solids as Solid3D[])[0].nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
      },
      /./,
      'S',
    );
    check(
      (m) => {
        m.loads.push({ kind: 'point', member: 'M', direction: 'localY', P: 1, a: 7 });
      },
      /./,
      'M',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Size and performance
// ---------------------------------------------------------------------------------------------

describe('larger models', () => {
  it('30 × 30 clamped plate: several thousand equations, in equilibrium', () => {
    const n = 30;
    const a = 6;
    const t = 0.06;
    const nu = 0.3;
    const q = 3;
    const grid = plateGrid('N', n, n, a, a, 0, { E, nu, t, density: 25 });
    const supports = grid.nodes
      .filter((p) => p.x === 0 || p.z === 0 || Math.abs(p.x - a) < 1e-9 || Math.abs(p.z - a) < 1e-9)
      .map((p) => fixed(p.id));
    const start = performance.now();
    const res = analyze3d({
      nodes: grid.nodes,
      plates: grid.plates,
      supports,
      loads: [
        { kind: 'selfWeight', direction: 'globalY', factor: -1 },
        ...grid.plates.map((p): Load3D => ({
          kind: 'pressure',
          plate: p.id,
          direction: 'localZ',
          p: -q,
        })),
      ],
    });
    const elapsed = performance.now() - start;
    expect(res.dofCount).toBe(29 * 29 * 6);
    expect(res.warnings).toEqual([]);
    const total = (q + 25 * t) * a * a;
    near(res.appliedLoad[1], -total);
    near(sumReactions(res, 'fy'), total, 1e-8);
    expectEquilibrium(res, total * a, 1e-8);
    const D = (E * t ** 3) / (12 * (1 - nu * nu));
    near(res.displacements[`N${n / 2}_${n / 2}`].uy, (-0.00126 * (q + 25 * t) * a ** 4) / D, 0.01);
    expect(elapsed).toBeLessThan(15000);
  }, 60000);

  it('10 × 10 × 6 solid block under its own weight', () => {
    const size: Vec3 = [2, 1.2, 2];
    const density = 24;
    const block = solidBlock('S', [10, 6, 10], size, [0, 0, 0], { E: 3e7, nu: 0.2, density });
    const start = performance.now();
    const res = analyze3d({
      nodes: block.nodes,
      solids: block.solids,
      supports: block.nodes.filter((p) => p.y === 0).map((p) => pinned(p.id)),
      loads: [
        { kind: 'selfWeight', direction: 'globalY', factor: -1 },
        { kind: 'selfWeight', direction: 'globalX', factor: 0.3 },
      ],
    });
    const elapsed = performance.now() - start;
    expect(res.dofCount).toBe(11 * 11 * 6 * 3);
    const weight = density * size[0] * size[1] * size[2];
    near(res.appliedLoad[1], -weight);
    near(res.appliedLoad[0], 0.3 * weight);
    near(sumReactions(res, 'fy'), weight, 1e-8);
    near(sumReactions(res, 'fx'), -0.3 * weight, 1e-8);
    expectEquilibrium(res, weight * 2, 1e-8);
    expect(Object.keys(res.solids)).toHaveLength(600);
    // Vertical stress near the base approaches the weight of the column above it.
    const base = res.solids.SH5_0_5.center.syy;
    expect(base).toBeLessThan(0);
    near(base, -density * (size[1] - 0.1), 0.2);
    expect(elapsed).toBeLessThan(15000);
  }, 60000);
});
