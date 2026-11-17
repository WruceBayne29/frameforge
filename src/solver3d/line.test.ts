import { describe, expect, it } from 'vitest';
import { analyze } from '../solver';
import type { SolverLoad, SolverMember, StructureModel } from '../solver';
import { SolverError } from '../solver/errors';
import { cholesky, choleskySolve, matVec, zeros } from '../solver/linalg';
import { jacobiEigen } from '../solver/modal';
import type { LineElement } from './line';
import {
  condenseReleases,
  lineElement,
  lineResult,
  localStiffness3D,
  memberAxes,
  releasedDofs3D,
} from './line';
import {
  emptyLineLoads,
  equivalentLineLoads,
  internalForces,
  lineBreakpoints,
  loadResultant,
  resolveDirection,
  resolveLineLoads,
} from './lineLoads';
import { add, cross, dot, norm, normalize, scale, sub } from './math';
import type {
  EndRelease,
  Member3D,
  MemberLoad3D,
  MemberLoadDirection,
  MemberResult3D,
  Station3D,
  Vec3,
} from './types';

// ---------------------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------------------

const E = 210e6;
const G = 81e6;
const A = 0.012;
const Iy = 2e-5;
const Iz = 8e-5;
const J = 3e-5;

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

/** Asserts |actual − expected| <= tol · max(|expected|, scale). */
function near(actual: number, expected: number, tol = 1e-9, magnitude = 0): void {
  const bound = tol * Math.max(Math.abs(expected), magnitude);
  if (!(Math.abs(actual - expected) <= bound)) {
    throw new Error(`expected ${actual} to be within ${bound} of ${expected}`);
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

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL = [0, 1, 2, 3, 4, 5];
const PINNED = [0, 1, 2];

interface Model {
  nodes: Record<string, Vec3>;
  members: Member3D[];
  loads?: MemberLoad3D[];
  /** Nodal loads [fx, fy, fz, mx, my, mz] in global axes. */
  nodal?: Record<string, number[]>;
  /** Restrained DOF offsets (0–5) per node. */
  fixed: Record<string, number[]>;
  /** DOF offsets restrained at every node (e.g. [2, 3, 4] for a planar XY problem). */
  fixEverywhere?: number[];
  gravity?: Vec3;
}

interface Solution {
  u: Record<string, number[]>;
  /** Support reactions [fx, fy, fz, mx, my, mz] at every node (zero at free DOFs). */
  reactions: Record<string, number[]>;
  members: Record<string, MemberResult3D>;
  elements: Record<string, LineElement>;
}

/** Tiny dense direct-stiffness solver around `lineElement` / `lineResult`. */
function solveModel(model: Model, segments = 20): Solution {
  const ids = Object.keys(model.nodes);
  const index = new Map(ids.map((id, k) => [id, k]));
  const n = 6 * ids.length;
  const K = zeros(n, n);
  const F = new Array<number>(n).fill(0);
  const elements: Record<string, LineElement> = {};
  const dofMap: Record<string, number[]> = {};

  for (const member of model.members) {
    const el = lineElement(
      member,
      model.nodes[member.i],
      model.nodes[member.j],
      (model.loads ?? []).filter((l) => l.member === member.id),
      model.gravity ?? [0, 0, 0],
    );
    const dofs: number[] = [];
    for (const node of el.nodes) {
      for (let d = 0; d < el.dofsPerNode; d++) dofs.push(6 * (index.get(node) as number) + d);
    }
    dofs.forEach((r, a) => {
      F[r] += el.f[a];
      dofs.forEach((c, b) => (K[r][c] += el.k[a][b]));
    });
    elements[member.id] = el;
    dofMap[member.id] = dofs;
  }
  for (const [node, load] of Object.entries(model.nodal ?? {})) {
    load.forEach((value, d) => (F[6 * (index.get(node) as number) + d] += value));
  }

  const restrained = new Array<boolean>(n).fill(false);
  for (const [node, list] of Object.entries(model.fixed)) {
    for (const d of list) restrained[6 * (index.get(node) as number) + d] = true;
  }
  for (const id of ids) {
    for (const d of model.fixEverywhere ?? []) restrained[6 * (index.get(id) as number) + d] = true;
  }
  // DOFs without stiffness (rotations at truss joints) are removed, as the assembler does.
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, K[i][i]);
  const free: number[] = [];
  for (let i = 0; i < n; i++) if (!restrained[i] && K[i][i] > 1e-12 * maxDiag) free.push(i);

  const u = new Array<number>(n).fill(0);
  if (free.length > 0) {
    const factor = cholesky(free.map((r) => free.map((c) => K[r][c])));
    if (!factor.ok) throw new Error(`test model is unstable at DOF ${free[factor.pivotIndex]}`);
    const uf = choleskySolve(
      factor.L,
      free.map((r) => F[r]),
    );
    free.forEach((r, a) => (u[r] = uf[a]));
  }
  const Ku = matVec(K, u);

  const solution: Solution = { u: {}, reactions: {}, members: {}, elements };
  ids.forEach((id, k) => {
    solution.u[id] = u.slice(6 * k, 6 * k + 6);
    solution.reactions[id] = ALL.map((d) =>
      restrained[6 * k + d] ? Ku[6 * k + d] - F[6 * k + d] : 0,
    );
  });
  for (const member of model.members) {
    solution.members[member.id] = lineResult(
      elements[member.id],
      dofMap[member.id].map((d) => u[d]),
      segments,
    );
  }
  return solution;
}

/** A single member A → B with the given restraints. */
function single(
  member: Member3D,
  xj: Vec3,
  loads: MemberLoad3D[],
  fixedA: number[],
  fixedB: number[],
  extra: Partial<Model> = {},
  segments = 20,
): { sol: Solution; res: MemberResult3D; el: LineElement } {
  const sol = solveModel(
    {
      nodes: { A: [0, 0, 0], B: xj },
      members: [member],
      loads,
      fixed: { A: fixedA, B: fixedB },
      ...extra,
    },
    segments,
  );
  return { sol, res: sol.members[member.id], el: sol.elements[member.id] };
}

/** Local components of a global 3-vector. */
function toLocal(axes: { x: Vec3; y: Vec3; z: Vec3 }, v: number[]): Vec3 {
  const g: Vec3 = [v[0], v[1], v[2]];
  return [dot(axes.x, g), dot(axes.y, g), dot(axes.z, g)];
}

/** Global components of a local 3-vector. */
function toGlobal(axes: { x: Vec3; y: Vec3; z: Vec3 }, v: Vec3): Vec3 {
  return add(add(scale(axes.x, v[0]), scale(axes.y, v[1])), scale(axes.z, v[2]));
}

function stationAt(res: MemberResult3D, x: number): Station3D {
  const s = res.stations.find((st) => Math.abs(st.x - x) < 1e-9 * res.length);
  if (!s) throw new Error(`no station at x = ${x}`);
  return s;
}

/** Rigid-body displacement of a node at `p`: translation `d` plus rotation `w` about the origin. */
function rigid(p: Vec3, d: Vec3, w: Vec3): number[] {
  return [...add(d, cross(w, p)), ...w];
}

const UNIT: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const ZERO: Vec3 = [0, 0, 0];

// ---------------------------------------------------------------------------------------
// 1. Local axes
// ---------------------------------------------------------------------------------------

describe('memberAxes', () => {
  it('gives the global axes for a member along +X', () => {
    const { L, x, y, z } = memberAxes([1, 2, 3], [6, 2, 3]);
    expect(L).toBe(5);
    expect(x).toEqual([1, 0, 0]);
    expect(y).toEqual([0, 1, 0]);
    expect(z).toEqual([0, 0, 1]);
  });

  it('keeps local z horizontal and local y "web up" for inclined members', () => {
    const random = rng(7);
    for (let k = 0; k < 50; k++) {
      const d: Vec3 = [random() - 0.5, random() - 0.5, random() - 0.5];
      const { x, y, z } = memberAxes([0, 0, 0], d);
      expect(Math.abs(z[1])).toBeLessThan(1e-14);
      expect(y[1]).toBeGreaterThan(0);
      near(dot(x, normalize(d)), 1, 1e-14);
    }
    // A member along −X has its local y still up, so z flips to −Z.
    const back = memberAxes([0, 0, 0], [-2, 0, 0]);
    expect(back.y).toEqual([0, 1, 0]);
    expect(back.z).toEqual([0, 0, -1]);
    // A member along +Z: z = Z × Y = −X.
    const alongZ = memberAxes([0, 0, 0], [0, 0, 3]);
    expect(alongZ.y).toEqual([0, 1, 0]);
    expect(alongZ.z).toEqual([-1, 0, 0]);
  });

  it('uses global Z as local z for vertical members, up and down', () => {
    const up = memberAxes([1, 0, 1], [1, 4, 1]);
    expect(up.x).toEqual([0, 1, 0]);
    expect(up.z).toEqual([0, 0, 1]);
    expect(up.y).toEqual([-1, 0, 0]);
    const down = memberAxes([1, 4, 1], [1, 0, 1]);
    expect(down.x).toEqual([0, -1, 0]);
    expect(down.z).toEqual([0, 0, 1]);
    expect(down.y).toEqual([1, 0, 0]);
  });

  it('stays orthonormal for members that are vertical only to within the tolerance', () => {
    const almost: Vec3[] = [
      [6e-10, 2, -8e-10],
      [-9e-10, -5, 3e-10],
    ];
    for (const d of almost) {
      for (const beta of [0, 1.1]) {
        const { x, y, z } = memberAxes([0, 0, 0], d, beta);
        for (const v of [x, y, z]) near(norm(v), 1, 1e-14);
        expect(Math.abs(dot(x, y))).toBeLessThan(1e-14);
        expect(Math.abs(dot(y, z))).toBeLessThan(1e-14);
        expect(Math.abs(dot(z, x))).toBeLessThan(1e-14);
        const handed = cross(x, y);
        for (let c = 0; c < 3; c++) expect(Math.abs(handed[c] - z[c])).toBeLessThan(1e-14);
      }
      // Still the vertical convention: local z is global Z (made perpendicular to x).
      const { y, z } = memberAxes([0, 0, 0], d);
      near(z[2], 1, 1e-14);
      near(y[0], -Math.sign(d[1]), 1e-14);
    }
    // The element built on such a member is free of rigid-body forces to rounding.
    const a: Vec3 = [1, 0.5, -2];
    const b = add(a, almost[0]);
    const k = lineElement(beam('m', 'A', 'B', { beta: 0.6 }), a, b, [], ZERO).k;
    let kmax = 0;
    for (const row of k) for (const v of row) kmax = Math.max(kmax, Math.abs(v));
    for (let mode = 0; mode < 6; mode++) {
      const d = mode < 3 ? UNIT[mode] : ZERO;
      const w = mode < 3 ? ZERO : UNIT[mode - 3];
      for (const value of matVec(k, [...rigid(a, d, w), ...rigid(b, d, w)])) {
        expect(Math.abs(value)).toBeLessThan(1e-13 * kmax);
      }
    }
    // Just outside the tolerance the member counts as inclined: local z = x × Y is horizontal,
    // which for a member leaning towards +Z is −X rather than the vertical convention's +Z.
    const leaning = memberAxes([0, 0, 0], [0, 2, 1e-6]);
    expect(leaning.z).toEqual([-1, 0, 0]);
    expect(leaning.y[1]).toBeGreaterThan(0);
    near(leaning.y[2], -1, 1e-12);
  });

  it('rotates y towards z with beta (right-hand rule about x)', () => {
    const quarter = memberAxes([0, 0, 0], [3, 0, 0], Math.PI / 2);
    near(dot(quarter.y, [0, 0, 1]), 1, 1e-14);
    near(dot(quarter.z, [0, -1, 0]), 1, 1e-14);
    const base = memberAxes([0, 0, 0], [1, 2, -3]);
    const rolled = memberAxes([0, 0, 0], [1, 2, -3], 0.4);
    near(dot(rolled.y, base.y), Math.cos(0.4), 1e-14);
    near(dot(rolled.y, base.z), Math.sin(0.4), 1e-14);
    near(dot(rolled.z, base.y), -Math.sin(0.4), 1e-14);
    const vertical = memberAxes([0, 0, 0], [0, 2, 0], Math.PI / 2);
    near(dot(vertical.y, [0, 0, 1]), 1, 1e-14);
    near(dot(vertical.z, [1, 0, 0]), 1, 1e-14);
  });

  it('returns an orthonormal right-handed triad for random directions and roll angles', () => {
    const random = rng(11);
    for (let k = 0; k < 200; k++) {
      const a: Vec3 = [random() * 10 - 5, random() * 10 - 5, random() * 10 - 5];
      const b: Vec3 = [random() * 10 - 5, random() * 10 - 5, random() * 10 - 5];
      const { L, x, y, z } = memberAxes(a, b, random() * 7 - 3.5);
      near(L, norm(sub(b, a)), 1e-14);
      for (const v of [x, y, z]) near(norm(v), 1, 1e-13);
      expect(Math.abs(dot(x, y))).toBeLessThan(1e-13);
      expect(Math.abs(dot(y, z))).toBeLessThan(1e-13);
      expect(Math.abs(dot(z, x))).toBeLessThan(1e-13);
      const handed = cross(x, y);
      for (let c = 0; c < 3; c++) expect(Math.abs(handed[c] - z[c])).toBeLessThan(1e-13);
    }
  });

  it('rejects a zero-length member', () => {
    expectError(() => memberAxes([1, 1, 1], [1, 1, 1]), 'INVALID_MODEL', /zero length/);
  });
});

// ---------------------------------------------------------------------------------------
// 2. Beam stiffness
// ---------------------------------------------------------------------------------------

describe('beam stiffness', () => {
  it('has the textbook coefficients for a member along X', () => {
    const L = 4;
    const el = lineElement(beam('m', 'A', 'B'), [0, 0, 0], [L, 0, 0], [], ZERO);
    expect(el.dofsPerNode).toBe(6);
    expect(el.nodes).toEqual(['A', 'B']);
    expect(el.k.length).toBe(12);
    expect(el.f).toEqual(new Array(12).fill(0));
    const k = el.k;
    const expected: Array<[number, number, number]> = [
      [0, 0, (E * A) / L],
      [0, 6, (-E * A) / L],
      [3, 3, (G * J) / L],
      [3, 9, (-G * J) / L],
      [1, 1, (12 * E * Iz) / L ** 3],
      [1, 5, (6 * E * Iz) / L ** 2],
      [1, 7, (-12 * E * Iz) / L ** 3],
      [1, 11, (6 * E * Iz) / L ** 2],
      [5, 5, (4 * E * Iz) / L],
      [5, 7, (-6 * E * Iz) / L ** 2],
      [5, 11, (2 * E * Iz) / L],
      [7, 11, (-6 * E * Iz) / L ** 2],
      [11, 11, (4 * E * Iz) / L],
      [2, 2, (12 * E * Iy) / L ** 3],
      [2, 4, (-6 * E * Iy) / L ** 2],
      [2, 8, (-12 * E * Iy) / L ** 3],
      [2, 10, (-6 * E * Iy) / L ** 2],
      [4, 4, (4 * E * Iy) / L],
      [4, 8, (6 * E * Iy) / L ** 2],
      [4, 10, (2 * E * Iy) / L],
      [8, 10, (6 * E * Iy) / L ** 2],
      [10, 10, (4 * E * Iy) / L],
    ];
    for (const [r, c, value] of expected) {
      near(k[r][c], value, 1e-13);
      near(k[c][r], value, 1e-13);
    }
    // The two bending planes, axial and torsion are uncoupled for a member along X.
    for (const [r, c] of [
      [0, 1],
      [1, 2],
      [1, 4],
      [2, 5],
      [3, 4],
      [0, 3],
      [5, 10],
    ]) {
      expect(k[r][c]).toBe(0);
    }
  });

  it('is symmetric with exactly six rigid-body modes for arbitrarily oriented members', () => {
    const random = rng(3);
    for (let trial = 0; trial < 20; trial++) {
      const a: Vec3 = [random() * 6 - 3, random() * 6 - 3, random() * 6 - 3];
      const b: Vec3 = [random() * 6 - 3, random() * 6 - 3, random() * 6 - 3];
      const el = lineElement(beam('m', 'A', 'B', { beta: random() * 6 }), a, b, [], ZERO);
      const k = el.k;
      let kmax = 0;
      for (const row of k) for (const v of row) kmax = Math.max(kmax, Math.abs(v));
      for (let r = 0; r < 12; r++) {
        for (let c = 0; c < r; c++) expect(Math.abs(k[r][c] - k[c][r])).toBeLessThan(1e-12 * kmax);
      }
      for (let mode = 0; mode < 6; mode++) {
        const d = mode < 3 ? UNIT[mode] : ZERO;
        const w = mode < 3 ? ZERO : UNIT[mode - 3];
        const force = matVec(k, [...rigid(a, d, w), ...rigid(b, d, w)]);
        for (const value of force) expect(Math.abs(value)).toBeLessThan(1e-10 * kmax);
      }
      const { values } = jacobiEigen(k);
      const top = values[11];
      expect(values.filter((v) => Math.abs(v) < 1e-9 * top).length).toBe(6);
      expect(values[0]).toBeGreaterThan(-1e-9 * top);
    }
  });

  it('exposes the local stiffness with axial terms only when the other rigidities are zero', () => {
    const k = localStiffness3D(2, 10, 0, 0, 0);
    expect(k[0][0]).toBe(5);
    expect(k[0][6]).toBe(-5);
    expect(k[6][6]).toBe(5);
    let others = 0;
    k.forEach((row, r) =>
      row.forEach((v, c) => {
        if (!((r === 0 || r === 6) && (c === 0 || c === 6))) others += Math.abs(v);
      }),
    );
    expect(others).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// 3. Cantilever closed forms in a skew direction with roll
// ---------------------------------------------------------------------------------------

describe('skew cantilever with beta ≠ 0', () => {
  const a: Vec3 = [1, 2, 3];
  const b: Vec3 = [4, 6.5, 1];
  const beta = 0.7;
  const axes = memberAxes(a, b, beta);
  const L = axes.L;
  const P = 7;

  const tip = (force: Vec3, moment: Vec3) => {
    const sol = solveModel(
      {
        nodes: { A: a, B: b },
        members: [beam('m', 'A', 'B', { beta })],
        nodal: { B: [...toGlobal(axes, force), ...toGlobal(axes, moment)] },
        fixed: { A: ALL },
      },
      8,
    );
    const u = sol.u.B;
    return {
      d: toLocal(axes, u.slice(0, 3)),
      r: toLocal(axes, u.slice(3, 6)),
      res: sol.members.m,
      reaction: sol.reactions.A,
    };
  };
  const expectLocal = (actual: Vec3, expected: Vec3, magnitude: number) => {
    for (let c = 0; c < 3; c++) near(actual[c], expected[c], 1e-9, magnitude);
  };

  it('tip force along local y: PL³/3EIz and PL²/2EIz', () => {
    const { d, r, res, reaction } = tip([0, P, 0], ZERO);
    const v = (P * L ** 3) / (3 * E * Iz);
    const theta = (P * L ** 2) / (2 * E * Iz);
    expectLocal(d, [0, v, 0], v);
    expectLocal(r, [0, 0, theta], theta);
    for (const s of res.stations) {
      near(s.Vy, -P, 1e-9);
      near(s.Mz, P * (L - s.x), 1e-9, P * L);
      near(s.v, (P * s.x ** 2 * (3 * L - s.x)) / (6 * E * Iz), 1e-9, v);
      near(s.w, 0, 1e-9, v);
      near(s.My, 0, 1e-9, P * L);
      near(s.N, 0, 1e-9, P);
    }
    near(res.maxAbsMz.value, P * L, 1e-9);
    expect(res.maxAbsMz.x).toBe(0);
    // Largest departure from the chord joining the displaced ends: P·x(L−x)(2L−x)/6EI, whose
    // maximum PL³/(9√3·EI) is at x = L(1 − 1/√3); the result is the largest station value.
    const sag = (x: number) => (P * x * (L - x) * (2 * L - x)) / (6 * E * Iz);
    near(res.maxAbsDeflection.value, Math.max(...res.stations.map((s) => sag(s.x))), 1e-9);
    expect(res.maxAbsDeflection.value).toBeLessThanOrEqual(
      (P * L ** 3) / (9 * Math.sqrt(3) * E * Iz),
    );
    expect(res.maxAbsDeflection.value).toBeGreaterThan(
      (0.95 * P * L ** 3) / (9 * Math.sqrt(3) * E * Iz),
    );
    // Reaction balances the load.
    const load = toGlobal(axes, [0, P, 0]);
    for (let c = 0; c < 3; c++) near(reaction[c], -load[c], 1e-9, P);
  });

  it('tip force along local z: PL³/3EIy and θy = −PL²/2EIy', () => {
    const { d, r, res } = tip([0, 0, P], ZERO);
    const w = (P * L ** 3) / (3 * E * Iy);
    const theta = (P * L ** 2) / (2 * E * Iy);
    expectLocal(d, [0, 0, w], w);
    expectLocal(r, [0, -theta, 0], theta);
    for (const s of res.stations) {
      near(s.Vz, -P, 1e-9);
      near(s.My, P * (L - s.x), 1e-9, P * L);
      near(s.w, (P * s.x ** 2 * (3 * L - s.x)) / (6 * E * Iy), 1e-9, w);
      near(s.v, 0, 1e-9, w);
      near(s.Mz, 0, 1e-9, P * L);
    }
    near(res.maxAbsMy.value, P * L, 1e-9);
    near(res.maxAbsVz.value, -P, 1e-9);
    // The deflection extreme is measured from the chord in this plane as well.
    const sag = (x: number) => (P * x * (L - x) * (2 * L - x)) / (6 * E * Iy);
    near(res.maxAbsDeflection.value, Math.max(...res.stations.map((s) => sag(s.x))), 1e-9);
    expect(res.maxAbsDeflection.value).toBeLessThan(0.2 * w);
  });

  it('biaxial tip force: maxAbsDeflection is the resultant sag from the chord, at its station', () => {
    const { d, res } = tip([0, P, -2 * P], ZERO);
    expectLocal(
      d,
      [0, (P * L ** 3) / (3 * E * Iz), (-2 * P * L ** 3) / (3 * E * Iy)],
      (2 * P * L ** 3) / (3 * E * Iy),
    );
    // Both planes have the same shape x(L−x)(2L−x)/6, scaled by P/EIz and −2P/EIy.
    const shape = (x: number) => (x * (L - x) * (2 * L - x)) / 6;
    const factor = Math.hypot(P / (E * Iz), (2 * P) / (E * Iy));
    let worst = res.stations[0];
    for (const s of res.stations) if (shape(s.x) > shape(worst.x)) worst = s;
    near(res.maxAbsDeflection.value, factor * shape(worst.x), 1e-9);
    expect(res.maxAbsDeflection.x).toBe(worst.x);
    expect(worst.x).toBeGreaterThan(0);
    expect(worst.x).toBeLessThan(L);
    // The absolute deflection is largest at the tip, so the chord really was subtracted.
    const tipStation = res.stations[res.stations.length - 1];
    expect(Math.hypot(tipStation.v, tipStation.w)).toBeGreaterThan(4 * res.maxAbsDeflection.value);
    // Extremes carry the sign of the governing value and its position.
    near(res.maxAbsVy.value, -P, 1e-9);
    near(res.maxAbsVz.value, 2 * P, 1e-9);
    near(res.maxAbsMz.value, P * L, 1e-9);
    near(res.maxAbsMy.value, -2 * P * L, 1e-9);
    expect(res.maxAbsMy.x).toBe(0);
    near(res.maxAbsTorsion.value, 0, 1e-9, P * L);
  });

  it('tip moments: ML/EI rotation and ML²/2EI deflection in each plane', () => {
    const mz = tip(ZERO, [0, 0, P]);
    expectLocal(mz.d, [0, (P * L ** 2) / (2 * E * Iz), 0], (P * L ** 2) / (2 * E * Iz));
    expectLocal(mz.r, [0, 0, (P * L) / (E * Iz)], (P * L) / (E * Iz));
    for (const s of mz.res.stations) {
      near(s.Mz, P, 1e-9);
      near(s.Vy, 0, 1e-9, P / L);
      near(s.v, (P * s.x ** 2) / (2 * E * Iz), 1e-9, (P * L ** 2) / (2 * E * Iz));
    }
    // A positive moment about local y turns the tip towards −z: E·Iy·w″ = My = −M.
    const my = tip(ZERO, [0, P, 0]);
    expectLocal(my.d, [0, 0, (-P * L ** 2) / (2 * E * Iy)], (P * L ** 2) / (2 * E * Iy));
    expectLocal(my.r, [0, (P * L) / (E * Iy), 0], (P * L) / (E * Iy));
    for (const s of my.res.stations) {
      near(s.My, -P, 1e-9);
      near(s.w, (-P * s.x ** 2) / (2 * E * Iy), 1e-9, (P * L ** 2) / (2 * E * Iy));
    }
  });

  it('tip torque TL/GJ and axial load PL/EA', () => {
    const torque = tip(ZERO, [P, 0, 0]);
    expectLocal(torque.r, [(P * L) / (G * J), 0, 0], (P * L) / (G * J));
    expectLocal(torque.d, ZERO, (P * L * L) / (G * J));
    for (const s of torque.res.stations) {
      near(s.T, P, 1e-9);
      near(s.twist, (P * s.x) / (G * J), 1e-9, (P * L) / (G * J));
    }
    near(torque.res.maxAbsTorsion.value, P, 1e-9);

    const pull = tip([P, 0, 0], ZERO);
    expectLocal(pull.d, [(P * L) / (E * A), 0, 0], (P * L) / (E * A));
    for (const s of pull.res.stations) {
      near(s.N, P, 1e-9);
      near(s.u, (P * s.x) / (E * A), 1e-9, (P * L) / (E * A));
    }
    near(pull.res.maxAxial.value, P, 1e-9);
    near(pull.res.minAxial.value, P, 1e-9);
    // End forces: the joint pulls back at i and the load pulls at j.
    near(pull.res.endForces[0], -P, 1e-9);
    near(pull.res.endForces[6], P, 1e-9);
    expect(pull.res.id).toBe('m');
    near(pull.res.length, L, 1e-14);
    expect(pull.res.axes.x).toEqual(axes.x);
    expect(pull.res.axes.y).toEqual(axes.y);
    expect(pull.res.axes.z).toEqual(axes.z);
  });
});

// ---------------------------------------------------------------------------------------
// 4. Fixed-fixed and simply-supported beams, both bending planes
// ---------------------------------------------------------------------------------------

interface Plane {
  name: string;
  direction: MemberLoadDirection;
  /** Direction of the moment that is conjugate to the plane's slope (+Mz or −My). */
  momentDirection: MemberLoadDirection;
  momentSign: 1 | -1;
  EI: number;
  /** endForces indices of the transverse force and of the bending moment at i. */
  force: number;
  moment: number;
  V: (s: Station3D) => number;
  M: (s: Station3D) => number;
  defl: (s: Station3D) => number;
  other: (s: Station3D) => number;
  /** Local rotation index of the node rotation and its sign relative to the slope. */
  rotation: number;
}

const PLANES: Plane[] = [
  {
    name: 'x–y plane (Iz)',
    direction: 'localY',
    momentDirection: 'localZ',
    momentSign: 1,
    EI: E * Iz,
    force: 1,
    moment: 5,
    V: (s) => s.Vy,
    M: (s) => s.Mz,
    defl: (s) => s.v,
    other: (s) => s.w,
    rotation: 2,
  },
  {
    name: 'x–z plane (Iy)',
    direction: 'localZ',
    momentDirection: 'localY',
    momentSign: -1,
    EI: E * Iy,
    force: 2,
    moment: 4,
    V: (s) => s.Vz,
    M: (s) => s.My,
    defl: (s) => s.w,
    other: (s) => s.v,
    rotation: 1,
  },
];

describe.each(PLANES)('single-span beams in the $name', (plane) => {
  // A skew member with roll: all expectations are in local axes, so they must not change.
  const xj: Vec3 = [3, 2, -1.5];
  const beta = -0.35;
  const axes = memberAxes([0, 0, 0], xj, beta);
  const L = axes.L;
  const EI = plane.EI;
  const sign = plane.momentSign;
  const member = beam('m', 'A', 'B', { beta });
  // Simple supports: all translations held, twist held at A.
  const fixedFixed = (loads: MemberLoad3D[], segments = 20) =>
    single(member, xj, loads, ALL, ALL, {}, segments).res;
  const simple = (loads: MemberLoad3D[], segments = 20) =>
    single(member, xj, loads, [0, 1, 2, 3], PINNED, {}, segments);
  const udl = (w1: number, w2 = w1, a?: number, b?: number): MemberLoad3D => ({
    kind: 'distributed',
    member: 'm',
    direction: plane.direction,
    w1,
    w2,
    a,
    b,
  });
  const point = (P: number, a: number): MemberLoad3D => ({
    kind: 'point',
    member: 'm',
    direction: plane.direction,
    P,
    a,
  });
  // A moment that turns the slope positive in this plane (+Mz, or −My).
  const moment = (M: number, a: number): MemberLoad3D => ({
    kind: 'moment',
    member: 'm',
    direction: plane.momentDirection,
    M: sign * M,
    a,
  });
  /** End forces [F_i, M_i, F_j, M_j] in the plane's "2D" convention. */
  const ends = (res: MemberResult3D) => [
    res.endForces[plane.force],
    sign * res.endForces[plane.moment],
    res.endForces[plane.force + 6],
    sign * res.endForces[plane.moment + 6],
  ];
  const expectEnds = (res: MemberResult3D, expected: number[], magnitude: number) => {
    const actual = ends(res);
    for (let k = 0; k < 4; k++) near(actual[k], expected[k], 1e-9, magnitude * (k % 2 ? 1 : 1 / L));
    // Nothing leaks into the other plane, the axis or torsion.
    res.endForces.forEach((value, k) => {
      const own = k % 6 === plane.force || k % 6 === plane.moment;
      if (!own) expect(Math.abs(value)).toBeLessThan(1e-9 * magnitude);
    });
  };
  const w = 9;
  const P = 13;

  it('fixed-fixed UDL: wL²/12 at the ends, wL²/24 and wL⁴/384EI at midspan', () => {
    const res = fixedFixed([udl(w)]);
    expectEnds(res, [(-w * L) / 2, (-w * L * L) / 12, (-w * L) / 2, (w * L * L) / 12], w * L * L);
    const mid = stationAt(res, L / 2);
    near(plane.M(mid), (-w * L * L) / 24, 1e-9);
    near(plane.V(mid), 0, 1e-9, w * L);
    near(plane.defl(mid), (w * L ** 4) / (384 * EI), 1e-9);
    near(plane.M(res.stations[0]), (w * L * L) / 12, 1e-9);
    near(plane.M(res.stations[res.stations.length - 1]), (w * L * L) / 12, 1e-9);
    for (const s of res.stations) {
      near(plane.defl(s), (w * s.x ** 2 * (L - s.x) ** 2) / (24 * EI), 1e-9, (w * L ** 4) / EI);
      near(plane.other(s), 0, 1e-9, (w * L ** 4) / EI);
    }
    near(res.maxAbsDeflection.value, (w * L ** 4) / (384 * EI), 1e-9);
    near(res.maxAbsDeflection.x, L / 2, 1e-9);
  });

  it('simply-supported UDL: wL²/8, 5wL⁴/384EI and the quartic deflected shape', () => {
    const { res, sol } = simple([udl(w)], 7);
    expectEnds(res, [(-w * L) / 2, 0, (-w * L) / 2, 0], w * L * L);
    const mid = stationAt(res, L / 2); // zero-shear station (7 segments has none at midspan)
    near(plane.M(mid), (-w * L * L) / 8, 1e-9);
    near(plane.defl(mid), (5 * w * L ** 4) / (384 * EI), 1e-9);
    for (const s of res.stations) {
      const x = s.x;
      near(plane.defl(s), (w * x * (L ** 3 - 2 * L * x * x + x ** 3)) / (24 * EI), 1e-9, 1e-3);
      near(plane.M(s), (-w * x * (L - x)) / 2, 1e-9, w * L * L);
      near(plane.V(s), -w * (L / 2 - x), 1e-9, w * L);
    }
    // End slopes ±wL³/24EI; in the x–z plane the node rotation is θy = −dw/dx.
    const slope = (w * L ** 3) / (24 * EI);
    near(toLocal(axes, sol.u.A.slice(3))[plane.rotation], sign * slope, 1e-9);
    near(toLocal(axes, sol.u.B.slice(3))[plane.rotation], -sign * slope, 1e-9);
  });

  it('point load: Pab²/L² fixed-end moments and PL³/48EI at midspan', () => {
    const a = 0.3 * L;
    const b = L - a;
    const fixed = fixedFixed([point(P, a)]);
    expectEnds(
      fixed,
      [
        (-P * b * b * (3 * a + b)) / L ** 3,
        (-P * a * b * b) / L ** 2,
        (-P * a * a * (a + 3 * b)) / L ** 3,
        (P * a * a * b) / L ** 2,
      ],
      P * L,
    );
    near(plane.defl(stationAt(fixed, a)), (P * a ** 3 * b ** 3) / (3 * L ** 3 * EI), 1e-9);

    const off = simple([point(P, a)]).res;
    expectEnds(off, [(-P * b) / L, 0, (-P * a) / L, 0], P * L);
    near(plane.defl(stationAt(off, a)), (P * a * a * b * b) / (3 * EI * L), 1e-9);
    near(plane.M(stationAt(off, a)), (-P * a * b) / L, 1e-9);

    const centre = simple([point(P, L / 2)]).res;
    near(plane.defl(stationAt(centre, L / 2)), (P * L ** 3) / (48 * EI), 1e-9);
    near(plane.M(stationAt(centre, L / 2)), (-P * L) / 4, 1e-9);
    const extremeM = plane.direction === 'localY' ? centre.maxAbsMz : centre.maxAbsMy;
    near(extremeM.value, (-P * L) / 4, 1e-9);
    near(extremeM.x, L / 2, 1e-12);
  });

  it('partial UDL: fixed-end moments and simple-span deflection from the closed forms', () => {
    const a = 0.15 * L;
    const b = 0.45 * L;
    const fixed = fixedFixed([udl(w, w, a, b)]);
    // ∫ w·x(L−x)²/L² dx and ∫ w·x²(L−x)/L² dx over the loaded length.
    const pI = (x: number) => ((L * L * x * x) / 2 - (2 * L * x ** 3) / 3 + x ** 4 / 4) / L ** 2;
    const pJ = (x: number) => ((L * x ** 3) / 3 - x ** 4 / 4) / L ** 2;
    const mI = -w * (pI(b) - pI(a));
    const mJ = w * (pJ(b) - pJ(a));
    // Shears from statics with those moments.
    const total = w * (b - a);
    const fJ = -(mI + mJ + (total * (a + b)) / 2) / L;
    expectEnds(fixed, [-total - fJ, mI, fJ, mJ], w * L * L);

    const { res } = simple([udl(w, w, a, b)]);
    expectEnds(
      res,
      [-total * (1 - (a + b) / (2 * L)), 0, (-total * (a + b)) / (2 * L), 0],
      w * L * L,
    );
    // Midspan deflection by superposing the point-load formula s(3L² − 4s²)/48EI (s <= L/2).
    const q = (s: number) => (3 * L * L * s * s) / 2 - s ** 4;
    near(plane.defl(stationAt(res, L / 2)), (w * (q(b) - q(a))) / (48 * EI), 1e-9);
  });

  it('triangular and trapezoidal loads: wL²/30, wL²/20, wL²/9√3, 5wL⁴/768EI', () => {
    const tri = fixedFixed([udl(0, w)]);
    expectEnds(
      tri,
      [(-3 * w * L) / 20, (-w * L * L) / 30, (-7 * w * L) / 20, (w * L * L) / 20],
      w * L * L,
    );
    const w1 = 4;
    const trap = fixedFixed([udl(w1, w)]);
    const dw = w - w1;
    expectEnds(
      trap,
      [
        (-w1 * L) / 2 - (3 * dw * L) / 20,
        (-w1 * L * L) / 12 - (dw * L * L) / 30,
        (-w1 * L) / 2 - (7 * dw * L) / 20,
        (w1 * L * L) / 12 + (dw * L * L) / 20,
      ],
      w * L * L,
    );

    const { res } = simple([udl(0, w)], 6);
    expectEnds(res, [(-w * L) / 6, 0, (-w * L) / 3, 0], w * L * L);
    // Maximum moment wL²/(9√3) at x = L/√3, a point of zero shear between the regular stations.
    const peak = plane.direction === 'localY' ? res.maxAbsMz : res.maxAbsMy;
    near(peak.value, (-w * L * L) / (9 * Math.sqrt(3)), 1e-9);
    near(peak.x, L / Math.sqrt(3), 1e-9);
    near(plane.defl(stationAt(res, L / 2)), (5 * w * L ** 4) / (768 * EI), 1e-9);
  });

  it('point moment: M·b(2a−b)/L² fixed-end moments, M/L reactions and the moment jump', () => {
    const M0 = 17;
    const mid = fixedFixed([moment(M0, L / 2)]);
    expectEnds(mid, [(1.5 * M0) / L, M0 / 4, (-1.5 * M0) / L, M0 / 4], M0);
    const a = 0.3 * L;
    const b = L - a;
    const fixed = fixedFixed([moment(M0, a)]);
    const mI = (M0 * b * (2 * a - b)) / L ** 2;
    const mJ = (M0 * a * (2 * b - a)) / L ** 2;
    const fJ = -(mI + mJ + M0) / L;
    expectEnds(fixed, [-fJ, mI, fJ, mJ], M0);

    const { res } = simple([moment(M0, a)]);
    expectEnds(res, [M0 / L, 0, -M0 / L, 0], M0);
    const pair = res.stations.filter((s) => Math.abs(s.x - a) < 1e-12);
    expect(pair.length).toBe(2);
    near(plane.M(pair[0]), (M0 * a) / L, 1e-9);
    near(plane.M(pair[1]), (M0 * a) / L - M0, 1e-9);
    near(plane.V(pair[0]), M0 / L, 1e-9);
    near(plane.defl(pair[0]), (M0 * a * b * (b - a)) / (3 * EI * L), 1e-9);
    near(plane.defl(pair[1]), (M0 * a * b * (b - a)) / (3 * EI * L), 1e-9);
  });
});

describe('equivalent nodal loads satisfy statics', () => {
  const DIRECTIONS: MemberLoadDirection[] = [
    'localX',
    'localY',
    'localZ',
    'globalX',
    'globalY',
    'globalZ',
  ];
  const RELEASES: Array<[EndRelease | undefined, EndRelease | undefined]> = [
    [undefined, undefined],
    [{ mz: true }, undefined],
    [undefined, { my: true, mz: true }],
    [
      { my: true, mz: true },
      { my: true, mz: true },
    ],
    [{ fy: true }, { mx: true }],
    [{ fx: true, fz: true, my: true }, undefined],
    [{ mx: true, my: true, mz: true }, { fx: true }],
  ];

  /** Resultant force and moment about node i of the loads, computed directly in global axes. */
  function resultant(
    loads: MemberLoad3D[],
    axes: { L: number; x: Vec3; y: Vec3; z: Vec3 },
  ): { force: Vec3; moment: Vec3 } {
    let force: Vec3 = [0, 0, 0];
    let moment: Vec3 = [0, 0, 0];
    const unit = (direction: MemberLoadDirection): Vec3 =>
      ({
        localX: axes.x,
        localY: axes.y,
        localZ: axes.z,
        globalX: UNIT[0],
        globalY: UNIT[1],
        globalZ: UNIT[2],
      })[direction];
    for (const load of loads) {
      const e = unit(load.direction);
      if (load.kind === 'distributed') {
        const a = load.a ?? 0;
        const b = load.b ?? axes.L;
        const w2 = load.w2 ?? load.w1;
        const total = ((load.w1 + w2) / 2) * (b - a);
        // ∫ w(s)·s ds for a linear w between a and b.
        const first = ((b - a) * (load.w1 * (2 * a + b) + w2 * (a + 2 * b))) / 6;
        force = add(force, scale(e, total));
        moment = add(moment, scale(cross(axes.x, e), first));
      } else if (load.kind === 'point') {
        force = add(force, scale(e, load.P));
        moment = add(moment, scale(cross(axes.x, e), load.P * load.a));
      } else {
        moment = add(moment, scale(e, load.M));
      }
    }
    return { force, moment };
  }

  function randomLoads(random: () => number, L: number): MemberLoad3D[] {
    const loads: MemberLoad3D[] = [];
    const pick = () => DIRECTIONS[Math.floor(random() * 6)];
    for (let k = 0; k < 6; k++) {
      const a = random() * L;
      const b = a + random() * (L - a);
      const kind = Math.floor(random() * 4);
      if (kind === 0) {
        loads.push({ kind: 'distributed', member: 'm', direction: pick(), w1: random() * 8 - 4 });
      } else if (kind === 1) {
        loads.push({
          kind: 'distributed',
          member: 'm',
          direction: pick(),
          w1: random() * 8 - 4,
          w2: random() * 8 - 4,
          a,
          b,
        });
      } else if (kind === 2) {
        loads.push({ kind: 'point', member: 'm', direction: pick(), P: random() * 8 - 4, a });
      } else {
        loads.push({ kind: 'moment', member: 'm', direction: pick(), M: random() * 8 - 4, a });
      }
    }
    return loads;
  }

  it('beams (with and without releases): Σf and Σm of f equal the load resultant', () => {
    const random = rng(2024);
    for (let trial = 0; trial < 60; trial++) {
      const a: Vec3 = [random() * 6 - 3, random() * 6 - 3, random() * 6 - 3];
      const b: Vec3 = [random() * 6 - 3, random() * 6 - 3, random() * 6 - 3];
      const beta = random() * 6 - 3;
      const axes = memberAxes(a, b, beta);
      const loads = randomLoads(random, axes.L);
      const [releaseI, releaseJ] = RELEASES[trial % RELEASES.length];
      const el = lineElement(beam('m', 'A', 'B', { beta, releaseI, releaseJ }), a, b, loads, ZERO);
      const { force, moment } = resultant(loads, axes);
      const f = el.f;
      const sumF = add([f[0], f[1], f[2]], [f[6], f[7], f[8]]);
      const sumM = add(
        add([f[3], f[4], f[5]], [f[9], f[10], f[11]]),
        cross(sub(b, a), [f[6], f[7], f[8]]),
      );
      for (let c = 0; c < 3; c++) {
        near(sumF[c], force[c], 1e-10, 10);
        near(sumM[c], moment[c], 1e-10, 10);
      }
      // The local-axis resultant helper agrees with the direct global calculation.
      const local = loadResultant(el.loads);
      const lf = toGlobal(axes, [local[0], local[1], local[2]]);
      const lm = toGlobal(axes, [local[3], local[4], local[5]]);
      for (let c = 0; c < 3; c++) {
        near(lf[c], force[c], 1e-10, 10);
        near(lm[c], moment[c], 1e-10, 10);
      }
      // The condensed element is still free of rigid-body forces and stays symmetric.
      let kmax = 0;
      for (const row of el.k) for (const v of row) kmax = Math.max(kmax, Math.abs(v));
      for (let mode = 0; mode < 6; mode++) {
        const d = mode < 3 ? UNIT[mode] : ZERO;
        const w = mode < 3 ? ZERO : UNIT[mode - 3];
        for (const value of matVec(el.k, [...rigid(a, d, w), ...rigid(b, d, w)])) {
          expect(Math.abs(value)).toBeLessThan(1e-9 * kmax);
        }
      }
      for (let r = 0; r < 12; r++) {
        for (let c = 0; c < r; c++) {
          expect(Math.abs(el.k[r][c] - el.k[c][r])).toBeLessThan(1e-10 * kmax);
        }
      }
    }
  });

  it('trusses: joint loads carry the full resultant except the torque about the bar', () => {
    const random = rng(99);
    for (let trial = 0; trial < 40; trial++) {
      const a: Vec3 = [random() * 6 - 3, random() * 6 - 3, random() * 6 - 3];
      const b: Vec3 = [random() * 6 - 3, random() * 6 - 3, random() * 6 - 3];
      const axes = memberAxes(a, b);
      const loads = randomLoads(random, axes.L);
      const el = lineElement(truss('m', 'A', 'B', { beta: 1.3 }), a, b, loads, ZERO);
      expect(el.f.length).toBe(6);
      const { force, moment } = resultant(loads, axes);
      const f = el.f;
      const sumF = add([f[0], f[1], f[2]], [f[3], f[4], f[5]]);
      const sumM = cross(sub(b, a), [f[3], f[4], f[5]]);
      // Remove the component of the applied moment about the bar's own axis.
      const transverse = sub(moment, scale(axes.x, dot(moment, axes.x)));
      for (let c = 0; c < 3; c++) {
        near(sumF[c], force[c], 1e-10, 10);
        near(sumM[c], transverse[c], 1e-10, 10);
      }
    }
  });

  it('random space frame: global equilibrium, member equilibrium and exact closure at end j', () => {
    const random = rng(515);
    const nodes: Record<string, Vec3> = {
      A: [0, 0, 0],
      B: [3, 1, 0.5],
      C: [3.5, 4, 2],
      D: [6, 3.5, -1],
      F: [1, 3, 3],
      H: [3.5, 7, 2],
    };
    const members = [
      beam('AB', 'A', 'B', { beta: 0.4 }),
      beam('BC', 'B', 'C', { beta: -1.1 }),
      beam('DC', 'D', 'C', { beta: 2.2, releaseJ: { my: true, mz: true } }),
      beam('CF', 'C', 'F', { beta: 0.3 }),
      beam('BD', 'B', 'D'),
      beam('HC', 'H', 'C', { beta: 0.8 }), // vertical, pointing down
    ];
    const loads: MemberLoad3D[] = [];
    for (const m of members) {
      const L = norm(sub(nodes[m.j], nodes[m.i]));
      for (const load of randomLoads(random, L)) loads.push({ ...load, member: m.id });
    }
    const nodal = { F: [3, -4, 5, 1, -2, 0.5] };
    const sol = solveModel({ nodes, members, loads, nodal, fixed: { A: ALL, D: PINNED } }, 9);

    // Global equilibrium: reactions + applied loads, forces and moments about the origin.
    let force: Vec3 = [nodal.F[0], nodal.F[1], nodal.F[2]];
    let moment: Vec3 = add([nodal.F[3], nodal.F[4], nodal.F[5]], cross(nodes.F, force));
    for (const m of members) {
      const axes = memberAxes(nodes[m.i], nodes[m.j], m.beta);
      const r = resultant(
        loads.filter((l) => l.member === m.id),
        axes,
      );
      force = add(force, r.force);
      moment = add(moment, add(r.moment, cross(nodes[m.i], r.force)));
    }
    for (const [id, r] of Object.entries(sol.reactions)) {
      force = add(force, [r[0], r[1], r[2]]);
      moment = add(moment, add([r[3], r[4], r[5]], cross(nodes[id], [r[0], r[1], r[2]])));
    }
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(force[c])).toBeLessThan(1e-9);
      expect(Math.abs(moment[c])).toBeLessThan(1e-9);
    }

    let uMax = 0;
    for (const u of Object.values(sol.u)) uMax = Math.max(uMax, norm([u[0], u[1], u[2]]));
    expect(uMax).toBeGreaterThan(1e-6);
    for (const m of members) {
      const res = sol.members[m.id];
      const el = sol.elements[m.id];
      const e = res.endForces;
      const L = res.length;
      // Member equilibrium in local axes (moments about node i).
      const r = loadResultant(el.loads);
      const balance = [
        e[0] + e[6] + r[0],
        e[1] + e[7] + r[1],
        e[2] + e[8] + r[2],
        e[3] + e[9] + r[3],
        e[4] + e[10] - L * e[8] + r[4],
        e[5] + e[11] + L * e[7] + r[5],
      ];
      for (const value of balance) expect(Math.abs(value)).toBeLessThan(1e-9);
      // The diagrams start and end at the member end forces (Station3D sign conventions).
      const first = res.stations[0];
      const last = res.stations[res.stations.length - 1];
      const start = [first.N + e[0], first.Vy - e[1], first.Vz - e[2], first.T + e[3]];
      start.push(first.My - e[4], first.Mz + e[5]);
      const finish = [last.N - e[6], last.Vy + e[7], last.Vz + e[8], last.T - e[9]];
      finish.push(last.My + e[10], last.Mz - e[11]);
      for (const value of [...start, ...finish]) expect(Math.abs(value)).toBeLessThan(1e-9);
      // Integrating the strains from end i reproduces the displacements of joint j exactly.
      const ui = toLocal(res.axes, sol.u[m.i]);
      const uj = toLocal(res.axes, sol.u[m.j]);
      const ri = toLocal(res.axes, sol.u[m.i].slice(3));
      const rj = toLocal(res.axes, sol.u[m.j].slice(3));
      near(first.u, ui[0], 1e-9, uMax);
      near(first.v, ui[1], 1e-9, uMax);
      near(first.w, ui[2], 1e-9, uMax);
      near(first.twist, ri[0], 1e-9, uMax);
      near(last.u, uj[0], 1e-8, uMax);
      near(last.v, uj[1], 1e-8, uMax);
      near(last.w, uj[2], 1e-8, uMax);
      near(last.twist, rj[0], 1e-8, uMax);
      // Released components are exactly zero.
      el.released.forEach((flag, k) => {
        if (flag) expect(e[k]).toBe(0);
      });
    }
    expect(sol.members.DC.endForces[10]).toBe(0);
    expect(sol.members.DC.endForces[11]).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// 5. Agreement with the validated 2D solver
// ---------------------------------------------------------------------------------------

const E2 = 2e8;
const A2 = 0.01;
const I2 = 1e-4;
const frame2 = (
  id: string,
  i: string,
  j: string,
  extra: Partial<SolverMember> = {},
): SolverMember => ({ id, i, j, type: 'frame', E: E2, A: A2, I: I2, ...extra });
const truss2 = (id: string, i: string, j: string): SolverMember => ({
  id,
  i,
  j,
  type: 'truss',
  E: E2,
  A: A2,
  I: 0,
});

/**
 * Solves a planar model with the 2D solver and as 3D members in the z = 0 plane (out-of-plane
 * DOFs restrained), and compares displacements, reactions, end forces and every station.
 * The 3D "web up" convention flips local y (and z) for members drawn right-to-left, which
 * changes the sign of local-y loads, V, M and v; `flip` accounts for it.
 */
function compareWith2D(model2: StructureModel, segments = 12): Record<string, 1 | -1> {
  const ref = analyze(model2, { segments });
  const nodes: Record<string, Vec3> = {};
  for (const n of model2.nodes) nodes[n.id] = [n.x, n.y, 0];
  const flip: Record<string, 1 | -1> = {};
  const members: Member3D[] = model2.members.map((m) => {
    const axes = memberAxes(nodes[m.i], nodes[m.j]);
    const cos = axes.x[0];
    const sin = axes.x[1];
    const s = Math.round(dot(axes.y, [-sin, cos, 0]));
    expect(Math.abs(s)).toBe(1);
    flip[m.id] = s as 1 | -1;
    if (m.type === 'truss') return { id: m.id, i: m.i, j: m.j, type: 'truss', E: m.E, A: m.A };
    return {
      id: m.id,
      i: m.i,
      j: m.j,
      type: 'beam',
      E: m.E,
      G: m.E / 2.6,
      A: m.A,
      Iz: m.I,
      Iy: 3 * m.I,
      J: 2 * m.I,
      releaseI: m.releaseI ? { mz: true } : undefined,
      releaseJ: m.releaseJ ? { mz: true } : undefined,
    };
  });
  const loads: MemberLoad3D[] = [];
  const nodal: Record<string, number[]> = {};
  for (const load of model2.loads) {
    if (load.kind === 'nodal') {
      const prev = nodal[load.node] ?? [0, 0, 0, 0, 0, 0];
      prev[0] += load.fx ?? 0;
      prev[1] += load.fy ?? 0;
      prev[5] += load.mz ?? 0;
      nodal[load.node] = prev;
    } else if (load.kind === 'moment') {
      loads.push({
        kind: 'moment',
        member: load.member,
        direction: 'globalZ',
        M: load.M,
        a: load.a,
      });
    } else {
      const s = load.direction === 'localY' ? flip[load.member] : 1;
      if (load.kind === 'point') loads.push({ ...load, P: s * load.P });
      else {
        loads.push({
          ...load,
          w1: s * load.w1,
          w2: load.w2 === undefined ? undefined : s * load.w2,
        });
      }
    }
  }
  const fixed: Record<string, number[]> = {};
  for (const s of model2.supports) {
    fixed[s.node] = [...(s.ux ? [0] : []), ...(s.uy ? [1] : []), ...(s.rz ? [5] : [])];
  }
  const sol = solveModel(
    { nodes, members, loads, nodal, fixed, fixEverywhere: [2, 3, 4] },
    segments,
  );

  let uMax = 0;
  let rMax = 0;
  for (const d of Object.values(ref.displacements)) {
    uMax = Math.max(uMax, Math.abs(d.ux), Math.abs(d.uy));
    rMax = Math.max(rMax, Math.abs(d.rz));
  }
  for (const n of model2.nodes) {
    const d = ref.displacements[n.id];
    const u = sol.u[n.id];
    near(u[0], d.ux, 1e-9, uMax);
    near(u[1], d.uy, 1e-9, uMax);
    near(u[5], d.rz, 1e-9, rMax);
    expect(u[2]).toBe(0);
    expect(u[3]).toBe(0);
    expect(u[4]).toBe(0);
  }
  let fMax = 0;
  let mMax = 0;
  for (const r of Object.values(ref.members)) {
    for (const s of r.stations) {
      fMax = Math.max(fMax, Math.abs(s.N), Math.abs(s.V));
      mMax = Math.max(mMax, Math.abs(s.M));
    }
  }
  for (const [id, r] of Object.entries(ref.reactions)) {
    near(sol.reactions[id][0], r.fx, 1e-9, fMax);
    near(sol.reactions[id][1], r.fy, 1e-9, fMax);
    near(sol.reactions[id][5], r.mz, 1e-9, mMax);
  }
  for (const m of model2.members) {
    const r2 = ref.members[m.id];
    const r3 = sol.members[m.id];
    const s = flip[m.id];
    near(r3.length, r2.length, 1e-13);
    const map: Array<[number, number, number]> = [
      [0, 0, 1],
      [1, 1, s],
      [5, 2, s],
      [6, 3, 1],
      [7, 4, s],
      [11, 5, s],
    ];
    for (const [k3, k2, f] of map) {
      near(r3.endForces[k3], f * r2.endForces[k2], 1e-9, k2 % 3 === 2 ? mMax : fMax);
    }
    for (const k of [2, 3, 4, 8, 9, 10])
      expect(Math.abs(r3.endForces[k])).toBeLessThan(1e-9 * fMax);
    expect(r3.stations.length).toBe(r2.stations.length);
    r2.stations.forEach((s2, k) => {
      const s3 = r3.stations[k];
      near(s3.x, s2.x, 1e-9, r2.length);
      near(s3.N, s2.N, 1e-9, fMax);
      near(s3.Vy, s * s2.V, 1e-9, fMax);
      near(s3.Mz, s * s2.M, 1e-9, mMax);
      near(s3.u, s2.u, 1e-9, uMax);
      near(s3.v, s * s2.v, 1e-9, uMax);
      expect(Math.abs(s3.Vz)).toBeLessThan(1e-9 * fMax);
      expect(Math.abs(s3.My)).toBeLessThan(1e-9 * mMax);
      expect(Math.abs(s3.T)).toBeLessThan(1e-9 * mMax);
      expect(Math.abs(s3.w)).toBeLessThan(1e-9 * uMax);
      expect(s3.twist).toBe(0);
    });
    near(r3.maxAbsMz.value, s * r2.maxAbsMoment.value, 1e-9, mMax);
    near(r3.maxAbsVy.value, s * r2.maxAbsShear.value, 1e-9, fMax);
    near(r3.maxAxial.value, r2.maxAxial.value, 1e-9, fMax);
    near(r3.minAxial.value, r2.minAxial.value, 1e-9, fMax);
    near(Math.abs(r3.maxAbsDeflection.value), Math.abs(r2.maxAbsDeflection.value), 1e-9, uMax);
  }
  return flip;
}

describe('agreement with the 2D solver for planar frames in the XY plane', () => {
  it('portal frame with UDL, lateral load and member loads', () => {
    const loads: SolverLoad[] = [
      { kind: 'distributed', member: 'BC', direction: 'globalY', w1: -12 },
      { kind: 'nodal', node: 'B', fx: 25, mz: -4 },
      { kind: 'distributed', member: 'AB', direction: 'localY', w1: 3, w2: 6, a: 0.5, b: 3 },
      { kind: 'point', member: 'DC', direction: 'globalX', P: 8, a: 1.5 },
      { kind: 'moment', member: 'BC', M: 10, a: 2 },
    ];
    const flip = compareWith2D({
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 0, y: 4 },
        { id: 'C', x: 6, y: 4 },
        { id: 'D', x: 6, y: 0 },
      ],
      members: [frame2('AB', 'A', 'B'), frame2('BC', 'B', 'C'), frame2('DC', 'D', 'C')],
      supports: [
        { node: 'A', ux: true, uy: true, rz: true },
        { node: 'D', ux: true, uy: true },
      ],
      loads,
    });
    expect(flip).toEqual({ AB: 1, BC: 1, DC: 1 });
  });

  it('the same portal drawn right-to-left and top-down (local y flips on the beam)', () => {
    const flip = compareWith2D({
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 0, y: 4 },
        { id: 'C', x: 6, y: 5 },
        { id: 'D', x: 6, y: 0 },
      ],
      members: [frame2('BA', 'B', 'A'), frame2('CB', 'C', 'B'), frame2('CD', 'C', 'D')],
      supports: [
        { node: 'A', ux: true, uy: true, rz: true },
        { node: 'D', ux: true, uy: true, rz: true },
      ],
      loads: [
        { kind: 'distributed', member: 'CB', direction: 'localY', w1: 7, w2: 2 },
        { kind: 'distributed', member: 'CB', direction: 'localX', w1: 1.5, a: 1, b: 4 },
        { kind: 'point', member: 'CB', direction: 'localY', P: -9, a: 2.2 },
        { kind: 'moment', member: 'CB', M: -6, a: 4 },
        { kind: 'point', member: 'BA', direction: 'localY', P: 5, a: 1 },
        { kind: 'distributed', member: 'CD', direction: 'globalX', w1: 2 },
        { kind: 'nodal', node: 'C', fx: -10, fy: -30 },
      ],
    });
    expect(flip).toEqual({ BA: 1, CB: -1, CD: 1 });
  });

  it('continuous beam with an internal hinge', () => {
    compareWith2D({
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 5, y: 0 },
        { id: 'C', x: 8, y: 0 },
        { id: 'D', x: 14, y: 0 },
      ],
      members: [
        frame2('AB', 'A', 'B'),
        frame2('BC', 'B', 'C', { releaseJ: true }),
        frame2('CD', 'C', 'D', { I: 2.5e-4 }),
      ],
      supports: [
        { node: 'A', ux: true, uy: true, rz: true },
        { node: 'B', uy: true },
        { node: 'D', uy: true, rz: true },
      ],
      loads: [
        { kind: 'distributed', member: 'AB', direction: 'localY', w1: -15 },
        { kind: 'point', member: 'BC', direction: 'localY', P: -40, a: 1.2 },
        { kind: 'distributed', member: 'CD', direction: 'localY', w1: -5, w2: -20, a: 1, b: 5 },
        { kind: 'moment', member: 'CD', M: 12, a: 3 },
      ],
    });
  });

  it('inclined member with global-direction loads and a hinge at its start', () => {
    compareWith2D({
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 4, y: 3 },
        { id: 'C', x: 9, y: 3 },
      ],
      members: [frame2('AB', 'A', 'B', { releaseI: true }), frame2('BC', 'B', 'C')],
      supports: [
        { node: 'A', ux: true, uy: true, rz: true },
        { node: 'C', uy: true },
      ],
      loads: [
        { kind: 'distributed', member: 'AB', direction: 'globalY', w1: -10 },
        { kind: 'distributed', member: 'AB', direction: 'globalX', w1: 2, w2: 5, a: 1, b: 4.5 },
        { kind: 'point', member: 'AB', direction: 'globalX', P: 6, a: 2 },
        { kind: 'point', member: 'BC', direction: 'globalY', P: -11, a: 2.5 },
        { kind: 'moment', member: 'AB', M: 4, a: 3.5 },
      ],
    });
  });

  it('truss with loaded members (transverse load, point load and point moment)', () => {
    compareWith2D({
      nodes: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 4, y: 0 },
        { id: 'C', x: 2, y: 3 },
      ],
      members: [truss2('AB', 'A', 'B'), truss2('CB', 'C', 'B'), truss2('AC', 'A', 'C')],
      supports: [
        { node: 'A', ux: true, uy: true },
        { node: 'B', uy: true },
      ],
      loads: [
        { kind: 'nodal', node: 'C', fx: 12, fy: -30 },
        { kind: 'distributed', member: 'AB', direction: 'localY', w1: -6 },
        { kind: 'distributed', member: 'AC', direction: 'globalY', w1: -2, w2: -4, a: 0.5, b: 3 },
        { kind: 'point', member: 'CB', direction: 'localY', P: 5, a: 1 },
        { kind: 'moment', member: 'AC', M: 3, a: 2 },
        { kind: 'distributed', member: 'CB', direction: 'localX', w1: 1.5 },
      ],
    });
  });
});

// ---------------------------------------------------------------------------------------
// Space frames: bending + torsion coupling
// ---------------------------------------------------------------------------------------

describe('space frame closed forms', () => {
  it('right-angle cantilever in plan: P(a³+b³)/3EI + P·a·b²/GJ at the tip', () => {
    const a = 3;
    const b = 2;
    const P = 5;
    const sol = solveModel({
      nodes: { A: [0, 0, 0], B: [a, 0, 0], C: [a, 0, b] },
      members: [beam('AB', 'A', 'B'), beam('BC', 'B', 'C')],
      nodal: { C: [0, -P, 0, 0, 0, 0] },
      fixed: { A: ALL },
    });
    // Vertical bending uses Iz in both members (local y is up); AB also twists by P·b·a/GJ.
    const delta = (P * (a ** 3 + b ** 3)) / (3 * E * Iz) + (P * a * b * b) / (G * J);
    near(sol.u.C[1], -delta, 1e-9);
    const ab = sol.members.AB;
    // The tip load is on the +z side of AB: its moment about +x at B is (b·ẑ) × (−P·ŷ) = +P·b·x̂,
    // so the torque the j-side exerts on the i-side is +P·b.
    for (const s of ab.stations) {
      near(s.T, P * b, 1e-9);
      near(s.Vy, P, 1e-9);
      near(s.Mz, -P * (a - s.x), 1e-9, P * a);
    }
    near(sol.reactions.A[1], P, 1e-9);
    near(sol.reactions.A[3], -P * b, 1e-9);
    near(sol.reactions.A[5], P * a, 1e-9);
    // BC runs along +Z, whose local z is −X: it bends about that axis with moment −P(b − x).
    for (const s of sol.members.BC.stations) {
      near(s.Mz, -P * (b - s.x), 1e-9, P * b);
      near(s.T, 0, 1e-9, P * b);
    }
  });

  it('gives the same tip deflection after an arbitrary rigid rotation of the whole model', () => {
    const a = 3;
    const b = 2;
    const P = 5;
    const I = 6e-5;
    // Rotation matrix from a random orthonormal triad.
    const e1 = normalize([0.3, 0.8, -0.5]);
    const e3 = normalize(cross(e1, [0.1, -0.4, 0.9]));
    const e2 = cross(e3, e1);
    const rot = (v: Vec3): Vec3 => add(add(scale(e1, v[0]), scale(e2, v[1])), scale(e3, v[2]));
    const load = rot([0, -P, 0]);
    const sol = solveModel({
      nodes: { A: rot([0, 0, 0]), B: rot([a, 0, 0]), C: rot([a, 0, b]) },
      members: [
        beam('AB', 'A', 'B', { Iy: I, Iz: I, beta: 0.9 }),
        beam('BC', 'B', 'C', { Iy: I, Iz: I, beta: -2.1 }),
      ],
      nodal: { C: [...load, 0, 0, 0] },
      fixed: { A: ALL },
    });
    const delta = (P * (a ** 3 + b ** 3)) / (3 * E * I) + (P * a * b * b) / (G * J);
    const u = sol.u.C.slice(0, 3) as Vec3;
    near(dot(u, rot([0, -1, 0])), delta, 1e-9);
    near(Math.abs(sol.members.AB.stations[0].T), P * b, 1e-9);
    near(Math.hypot(sol.members.AB.stations[0].My, sol.members.AB.stations[0].Mz), P * a, 1e-9);
  });
});

describe('subdivision consistency', () => {
  // One loaded member must give exactly the same answer as the same member cut into pieces at
  // the load points, with the distributed loads applied piece by piece and the concentrated
  // loads applied as nodal loads at the cuts. This checks the equivalent nodal loads, the
  // condensation of releases and the recovery along the member against plain stiffness
  // analysis, for a skew member with roll and loads in every direction.
  const a: Vec3 = [0.5, 1, -1];
  const b: Vec3 = [4.5, 3.5, 1.5];
  const beta = 0.8;
  const axes = memberAxes(a, b, beta);
  const L = axes.L;
  const cuts = [0, 0.2 * L, 0.45 * L, 0.7 * L, L];
  const loads: MemberLoad3D[] = [
    {
      kind: 'distributed',
      member: 'm',
      direction: 'localY',
      w1: 3,
      w2: -5,
      a: cuts[1],
      b: cuts[3],
    },
    { kind: 'distributed', member: 'm', direction: 'globalY', w1: -4 },
    { kind: 'distributed', member: 'm', direction: 'globalZ', w1: 1, w2: 2.5, a: 0, b: cuts[2] },
    { kind: 'distributed', member: 'm', direction: 'localX', w1: 2, w2: 6, a: cuts[2], b: L },
    { kind: 'point', member: 'm', direction: 'globalX', P: 7, a: cuts[1] },
    { kind: 'point', member: 'm', direction: 'localZ', P: -3, a: cuts[3] },
    { kind: 'moment', member: 'm', direction: 'globalY', M: 5, a: cuts[2] },
    { kind: 'moment', member: 'm', direction: 'localX', M: -4, a: cuts[1] },
    { kind: 'moment', member: 'm', direction: 'localZ', M: 2, a: cuts[3] },
  ];
  const unit = (direction: MemberLoadDirection): Vec3 =>
    ({
      localX: axes.x,
      localY: axes.y,
      localZ: axes.z,
      globalX: UNIT[0],
      globalY: UNIT[1],
      globalZ: UNIT[2],
    })[direction];

  const RELEASE_CASES: Array<[string, EndRelease | undefined, EndRelease | undefined]> = [
    ['no releases', undefined, undefined],
    ['fx + mz released at i, my released at j', { fx: true, mz: true }, { my: true }],
    [
      'fy + my released at i, mx + fz released at j',
      { fy: true, my: true },
      { mx: true, fz: true },
    ],
  ];

  it.each(RELEASE_CASES)('%s', (_name, releaseI, releaseJ) => {
    const whole = solveModel(
      {
        nodes: { A: a, B: b },
        members: [beam('m', 'A', 'B', { beta, releaseI, releaseJ })],
        loads,
        fixed: { A: ALL, B: ALL },
      },
      3,
    );

    // The same member in four pieces N0–N1–N2–N3–N4.
    const nodes: Record<string, Vec3> = {};
    cuts.forEach((c, k) => (nodes[`N${k}`] = add(a, scale(axes.x, c))));
    const members: Member3D[] = [];
    const pieceLoads: MemberLoad3D[] = [];
    const nodal: Record<string, number[]> = {};
    for (let k = 0; k < 4; k++) {
      members.push(
        beam(`p${k}`, `N${k}`, `N${k + 1}`, {
          beta,
          releaseI: k === 0 ? releaseI : undefined,
          releaseJ: k === 3 ? releaseJ : undefined,
        }),
      );
    }
    for (const load of loads) {
      if (load.kind === 'distributed') {
        const la = load.a ?? 0;
        const lb = load.b ?? L;
        const w2 = load.w2 ?? load.w1;
        const at = (x: number) => load.w1 + ((w2 - load.w1) * (x - la)) / (lb - la);
        for (let k = 0; k < 4; k++) {
          const s = Math.max(la, cuts[k]);
          const e = Math.min(lb, cuts[k + 1]);
          if (e - s < 1e-12) continue;
          pieceLoads.push({
            kind: 'distributed',
            member: `p${k}`,
            direction: load.direction,
            w1: at(s),
            w2: at(e),
            a: s - cuts[k],
            b: e - cuts[k],
          });
        }
      } else {
        const k = cuts.findIndex((c) => Math.abs(c - load.a) < 1e-12);
        expect(k).toBeGreaterThan(0);
        const entry = nodal[`N${k}`] ?? [0, 0, 0, 0, 0, 0];
        const e = unit(load.direction);
        const offset = load.kind === 'point' ? 0 : 3;
        const value = load.kind === 'point' ? load.P : load.M;
        for (let c = 0; c < 3; c++) entry[offset + c] += value * e[c];
        nodal[`N${k}`] = entry;
      }
    }
    const split = solveModel(
      { nodes, members, loads: pieceLoads, nodal, fixed: { N0: ALL, N4: ALL } },
      3,
    );

    // Reactions.
    let fMax = 0;
    let mMax = 0;
    for (const r of [...split.reactions.N0, ...split.reactions.N4].slice(0, 3)) {
      fMax = Math.max(fMax, Math.abs(r));
    }
    for (const p of members) {
      for (const s of split.members[p.id].stations) {
        fMax = Math.max(fMax, Math.abs(s.N), Math.abs(s.Vy), Math.abs(s.Vz));
        mMax = Math.max(mMax, Math.abs(s.T), Math.abs(s.My), Math.abs(s.Mz));
      }
    }
    expect(fMax).toBeGreaterThan(1);
    expect(mMax).toBeGreaterThan(1);
    for (let d = 0; d < 6; d++) {
      const magnitude = d < 3 ? fMax : mMax;
      near(whole.reactions.A[d], split.reactions.N0[d], 1e-9, magnitude);
      near(whole.reactions.B[d], split.reactions.N4[d], 1e-9, magnitude);
    }

    // End forces of the whole member = outer end forces of the first and last piece.
    const res = whole.members.m;
    for (let d = 0; d < 6; d++) {
      const magnitude = d < 3 ? fMax : mMax;
      near(res.endForces[d], split.members.p0.endForces[d], 1e-9, magnitude);
      near(res.endForces[6 + d], split.members.p3.endForces[6 + d], 1e-9, magnitude);
    }
    for (const r of releasedDofs3D(releaseI, releaseJ)) expect(res.endForces[r]).toBe(0);

    // Internal forces on both sides of every cut, from the end forces of the adjoining pieces.
    for (let k = 1; k <= 3; k++) {
      const pair = res.stations.filter((s) => Math.abs(s.x - cuts[k]) < 1e-12);
      expect(pair.length).toBe(2);
      const left = split.members[`p${k - 1}`].endForces.slice(6);
      const right = split.members[`p${k}`].endForces.slice(0, 6);
      const [before, after] = pair;
      const checks: Array<[number, number, number]> = [
        [before.N, left[0], fMax],
        [before.Vy, -left[1], fMax],
        [before.Vz, -left[2], fMax],
        [before.T, left[3], mMax],
        [before.My, -left[4], mMax],
        [before.Mz, left[5], mMax],
        [after.N, -right[0], fMax],
        [after.Vy, right[1], fMax],
        [after.Vz, right[2], fMax],
        [after.T, -right[3], mMax],
        [after.My, right[4], mMax],
        [after.Mz, -right[5], mMax],
      ];
      for (const [actual, expected, magnitude] of checks) near(actual, expected, 1e-9, magnitude);
    }

    // Displacements along the whole member = joint displacements of the split model, at the
    // cuts and at every other station (via the pieces' own stations).
    let uMax = 0;
    let tMax = 0;
    for (let k = 1; k <= 3; k++) {
      const u = split.u[`N${k}`];
      uMax = Math.max(uMax, norm([u[0], u[1], u[2]]));
      tMax = Math.max(tMax, Math.abs(dot(axes.x, [u[3], u[4], u[5]])));
    }
    expect(uMax).toBeGreaterThan(1e-6);
    for (let k = 1; k <= 3; k++) {
      const u = split.u[`N${k}`];
      const d = toLocal(axes, u);
      const twist = toLocal(axes, u.slice(3))[0];
      for (const s of res.stations.filter((st) => Math.abs(st.x - cuts[k]) < 1e-12)) {
        near(s.u, d[0], 1e-8, uMax);
        near(s.v, d[1], 1e-8, uMax);
        near(s.w, d[2], 1e-8, uMax);
        near(s.twist, twist, 1e-8, tMax);
      }
    }
    // Every regular station of the whole member coincides with a station of one of the pieces
    // (20 divisions of the whole = 4 + 5 + 5 + 6 divisions of the pieces).
    const divisions = [4, 5, 5, 6];
    const full = lineResult(
      whole.elements.m,
      [...whole.u.A, ...whole.u.B],
      divisions.reduce((sum, n) => sum + n, 0),
    );
    let compared = 0;
    for (let k = 0; k < 4; k++) {
      const piece = lineResult(
        split.elements[`p${k}`],
        [...split.u[`N${k}`], ...split.u[`N${k + 1}`]],
        divisions[k],
      );
      for (const ps of piece.stations) {
        const interior = ps.x > 1e-9 && ps.x < piece.length - 1e-9;
        for (const s of full.stations.filter((st) => Math.abs(st.x - cuts[k] - ps.x) < 1e-9)) {
          compared++;
          near(s.u, ps.u, 1e-8, uMax);
          near(s.v, ps.v, 1e-8, uMax);
          near(s.w, ps.w, 1e-8, uMax);
          near(s.twist, ps.twist, 1e-8, tMax);
          if (!interior) continue; // the two limits at a cut were compared above
          near(s.N, ps.N, 1e-9, fMax);
          near(s.Vy, ps.Vy, 1e-9, fMax);
          near(s.Vz, ps.Vz, 1e-9, fMax);
          near(s.T, ps.T, 1e-9, mMax);
          near(s.My, ps.My, 1e-9, mMax);
          near(s.Mz, ps.Mz, 1e-9, mMax);
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(21);
    // The member's own end values at released ends agree as well (they differ from the joint's).
    const first = res.stations[0];
    const start = split.members.p0.stations[0];
    const last = res.stations[res.stations.length - 1];
    const finish = split.members.p3.stations[split.members.p3.stations.length - 1];
    for (const key of ['u', 'v', 'w'] as const) {
      near(first[key], start[key], 1e-8, uMax);
      near(last[key], finish[key], 1e-8, uMax);
    }
    near(first.twist, start.twist, 1e-8, tMax);
    near(last.twist, finish.twist, 1e-8, tMax);
  });
});

// ---------------------------------------------------------------------------------------
// 6. End releases
// ---------------------------------------------------------------------------------------

describe('end releases', () => {
  const L = 5;
  const xj: Vec3 = [L, 0, 0];
  const w = 8;
  const udlY: MemberLoad3D = { kind: 'distributed', member: 'm', direction: 'localY', w1: w };
  const udlZ: MemberLoad3D = { kind: 'distributed', member: 'm', direction: 'localZ', w1: w };

  it('maps release flags to local DOF indices', () => {
    expect(releasedDofs3D()).toEqual([]);
    expect(
      releasedDofs3D({ fx: true, mz: true }, { fy: true, fz: true, mx: true, my: true }),
    ).toEqual([0, 5, 7, 8, 9, 10]);
  });

  it('propped cantilever via an mz release: wL²/8, 5wL/8, 3wL/8 and the exact shape', () => {
    const { res, el } = single(
      beam('m', 'A', 'B', { releaseJ: { mz: true } }),
      xj,
      [udlY],
      ALL,
      ALL,
    );
    expect(el.released[11]).toBe(true);
    near(res.endForces[1], (-5 * w * L) / 8, 1e-9);
    near(res.endForces[5], (-w * L * L) / 8, 1e-9);
    near(res.endForces[7], (-3 * w * L) / 8, 1e-9);
    expect(res.endForces[11]).toBe(0);
    for (const s of res.stations) {
      const x = s.x;
      near(s.v, (w * x * x * (3 * L * L - 5 * L * x + 2 * x * x)) / (48 * E * Iz), 1e-9, 1e-3);
    }
    // Zero shear at 5L/8 gives the span moment 9wL²/128.
    near(stationAt(res, (5 * L) / 8).Mz, (-9 * w * L * L) / 128, 1e-9);
    near(res.stations[res.stations.length - 1].Mz, 0, 1e-9, w * L * L);
  });

  it('propped cantilever in the other plane via a my release at the start', () => {
    const { res } = single(beam('m', 'A', 'B', { releaseI: { my: true } }), xj, [udlZ], ALL, ALL);
    near(res.endForces[2], (-3 * w * L) / 8, 1e-9);
    expect(res.endForces[4]).toBe(0);
    near(res.endForces[8], (-5 * w * L) / 8, 1e-9);
    // Hogging at the fixed end j: the My diagram is +wL²/8 there, i.e. end moment −wL²/8·(−1).
    near(res.stations[res.stations.length - 1].My, (w * L * L) / 8, 1e-9);
    near(res.endForces[10], (-w * L * L) / 8, 1e-9);
    for (const s of res.stations) {
      const x = L - s.x;
      near(s.w, (w * x * x * (3 * L * L - 5 * L * x + 2 * x * x)) / (48 * E * Iy), 1e-9, 1e-3);
    }
  });

  it('shear release (guided end): wL²/6 fixing moment and wL⁴/24EI at the released end', () => {
    for (const end of ['i', 'j'] as const) {
      const release = end === 'i' ? { releaseI: { fy: true } } : { releaseJ: { fy: true } };
      const { res } = single(beam('m', 'A', 'B', release), xj, [udlY], ALL, ALL);
      const free = end === 'i' ? 0 : 6;
      const held = 6 - free;
      expect(res.endForces[1 + free]).toBe(0);
      near(res.endForces[1 + held], -w * L, 1e-9);
      // Moments: −wL²/6 (diagram) at the guided end, +wL²/3 at the fixed end.
      const guided = end === 'i' ? res.stations[0] : res.stations[res.stations.length - 1];
      const fixed = end === 'i' ? res.stations[res.stations.length - 1] : res.stations[0];
      near(guided.Mz, (-w * L * L) / 6, 1e-9);
      near(fixed.Mz, (w * L * L) / 3, 1e-9);
      // The member's own end moves although the joint does not.
      near(guided.v, (w * L ** 4) / (24 * E * Iz), 1e-9);
      near(fixed.v, 0, 1e-9, (w * L ** 4) / (E * Iz));
      for (const s of res.stations) {
        const x = end === 'i' ? s.x : L - s.x; // distance from the guided end
        near(s.v, (w * (L * L - x * x) ** 2) / (24 * E * Iz), 1e-9, 1e-3);
      }
      // Measured from the chord between the member's own ends: w(x⁴ − 2L²x² + L³x)/24EI.
      const sag = (x: number) => (w * (x ** 4 - 2 * L * L * x * x + L ** 3 * x)) / (24 * E * Iz);
      const worst = Math.max(...res.stations.map((s) => sag(end === 'i' ? s.x : L - s.x)));
      near(res.maxAbsDeflection.value, worst, 1e-9);
      expect(worst).toBeGreaterThan((0.125 * w * L ** 4) / (24 * E * Iz));
    }
  });

  it('shear + moment released at one end: a free cantilever, wL⁴/8EI at the tip', () => {
    const y = single(
      beam('m', 'A', 'B', { releaseI: { fy: true, mz: true } }),
      xj,
      [udlY],
      ALL,
      ALL,
    ).res;
    expect(y.endForces[1]).toBe(0);
    expect(y.endForces[5]).toBe(0);
    near(y.endForces[7], -w * L, 1e-9);
    near(y.endForces[11], (w * L * L) / 2, 1e-9);
    near(y.stations[y.stations.length - 1].Mz, (w * L * L) / 2, 1e-9);
    near(y.stations[0].v, (w * L ** 4) / (8 * E * Iz), 1e-9);
    const z = single(
      beam('m', 'A', 'B', { releaseJ: { fz: true, my: true } }),
      xj,
      [udlZ],
      ALL,
      ALL,
    ).res;
    expect(z.endForces[8]).toBe(0);
    expect(z.endForces[10]).toBe(0);
    near(z.endForces[2], -w * L, 1e-9);
    near(z.stations[z.stations.length - 1].w, (w * L ** 4) / (8 * E * Iy), 1e-9);
    // Root of a cantilever loaded towards +z curves towards +z: My = +wL²/2 = end moment My_i.
    near(z.stations[0].My, (w * L * L) / 2, 1e-9);
    near(z.endForces[4], (w * L * L) / 2, 1e-9);
    for (const s of z.stations) {
      const x = s.x;
      near(s.w, (w * x * x * (6 * L * L - 4 * L * x + x * x)) / (24 * E * Iy), 1e-9, 1e-3);
    }
  });

  it('my + mz released at both ends behaves as a truss bar (plus torsion)', () => {
    const a: Vec3 = [1, -2, 0.5];
    const b: Vec3 = [3, 1, 4];
    const pins = { my: true, mz: true };
    const el = lineElement(beam('m', 'A', 'B', { releaseI: pins, releaseJ: pins }), a, b, [], ZERO);
    const bar = lineElement(truss('m', 'A', 'B'), a, b, [], ZERO);
    const tr = [0, 1, 2, 6, 7, 8];
    const scaleK = (E * A) / el.L;
    tr.forEach((r, i) =>
      tr.forEach((c, j) => expect(Math.abs(el.k[r][c] - bar.k[i][j])).toBeLessThan(1e-9 * scaleK)),
    );
    // Only axial and torsional stiffness remain in local axes.
    near(el.kLocal[0][0], scaleK, 1e-12);
    near(el.kLocal[3][3], (G * J) / el.L, 1e-12);
    for (const r of [1, 2, 4, 5, 7, 8, 10, 11]) {
      for (let c = 0; c < 12; c++) expect(Math.abs(el.kLocal[r][c])).toBeLessThan(1e-9 * scaleK);
    }
    // Under a transverse UDL it is a simple beam: wL/2 reactions, wL²/8 moment, zero end moments.
    const span = single(
      beam('m', 'A', 'B', { releaseI: pins, releaseJ: pins }),
      xj,
      [udlY, udlZ],
      ALL,
      ALL,
    ).res;
    for (const k of [4, 5, 10, 11]) expect(span.endForces[k]).toBe(0);
    for (const k of [1, 2, 7, 8]) near(span.endForces[k], (-w * L) / 2, 1e-9);
    near(stationAt(span, L / 2).Mz, (-w * L * L) / 8, 1e-9);
    near(stationAt(span, L / 2).My, (-w * L * L) / 8, 1e-9);
    near(stationAt(span, L / 2).v, (5 * w * L ** 4) / (384 * E * Iz), 1e-9);
    near(stationAt(span, L / 2).w, (5 * w * L ** 4) / (384 * E * Iy), 1e-9);
    near(
      span.maxAbsDeflection.value,
      ((5 * w * L ** 4) / (384 * E)) * Math.hypot(1 / Iz, 1 / Iy),
      1e-9,
    );
  });

  it('an fx release carries no axial force and the member end slides', () => {
    const axial: MemberLoad3D = { kind: 'distributed', member: 'm', direction: 'localX', w1: w };
    const atJ = single(beam('m', 'A', 'B', { releaseJ: { fx: true } }), xj, [axial], ALL, ALL).res;
    near(atJ.endForces[0], -w * L, 1e-9);
    expect(atJ.endForces[6]).toBe(0);
    for (const s of atJ.stations) {
      near(s.N, w * (L - s.x), 1e-9, w * L);
      near(s.u, (w * (L * s.x - (s.x * s.x) / 2)) / (E * A), 1e-9, (w * L * L) / (E * A));
    }
    const atI = single(beam('m', 'A', 'B', { releaseI: { fx: true } }), xj, [axial], ALL, ALL).res;
    expect(atI.endForces[0]).toBe(0);
    near(atI.endForces[6], -w * L, 1e-9);
    for (const s of atI.stations) near(s.N, -w * s.x, 1e-9, w * L);
    near(atI.stations[0].u, (w * L * L) / (2 * E * A), 1e-9);
    near(atI.stations[atI.stations.length - 1].u, 0, 1e-9, (w * L * L) / (E * A));
    near(atI.minAxial.value, -w * L, 1e-9);
    near(atI.maxAxial.value, 0, 1e-9, w * L);

    // In a two-member chain the released member transmits no axial force at all.
    const sol = solveModel({
      nodes: { A: [0, 0, 0], B: [L, 0, 0], C: [2 * L, 0, 0] },
      members: [beam('AB', 'A', 'B'), beam('BC', 'B', 'C', { releaseI: { fx: true } })],
      nodal: { B: [50, 0, 0, 0, 0, 0] },
      fixed: { A: ALL, C: ALL },
    });
    for (const s of sol.members.BC.stations) expect(Math.abs(s.N)).toBeLessThan(1e-9);
    near(sol.members.AB.stations[0].N, 50, 1e-9);
    near(sol.u.B[0], (50 * L) / (E * A), 1e-9);
  });

  it('a torsion release sends the whole torque to the other end', () => {
    const T0 = 6;
    const a = 2;
    const torque: MemberLoad3D = { kind: 'moment', member: 'm', direction: 'localX', M: T0, a };
    const { res } = single(beam('m', 'A', 'B', { releaseJ: { mx: true } }), xj, [torque], ALL, ALL);
    near(res.endForces[3], -T0, 1e-9);
    expect(res.endForces[9]).toBe(0);
    for (const s of res.stations) {
      if (s.x < a) near(s.T, T0, 1e-9);
      if (s.x > a) near(s.T, 0, 1e-9, T0);
      near(s.twist, (T0 * Math.min(s.x, a)) / (G * J), 1e-9, (T0 * a) / (G * J));
    }
    const other = single(
      beam('m', 'A', 'B', { releaseI: { mx: true } }),
      xj,
      [torque],
      ALL,
      ALL,
    ).res;
    expect(other.endForces[3]).toBe(0);
    near(other.endForces[9], -T0, 1e-9);
    // The member's own twist at the released end i: −T0·(L − a)/GJ … measured back from j.
    near(other.stations[0].twist, (T0 * (L - a)) / (G * J), 1e-9);
    near(other.stations[other.stations.length - 1].twist, 0, 1e-9, (T0 * L) / (G * J));
    for (const s of other.stations) {
      if (s.x < a) near(s.T, 0, 1e-9, T0);
      if (s.x > a) near(s.T, -T0, 1e-9);
    }
  });

  it('releases at both ends remove the stiffness of that mode without breaking the rest', () => {
    const el = lineElement(
      beam('m', 'A', 'B', { releaseI: { mx: true, fx: true }, releaseJ: { mx: true, fx: true } }),
      [0, 0, 0],
      xj,
      [udlY],
      ZERO,
    );
    for (const r of [0, 3, 6, 9]) {
      for (let c = 0; c < 12; c++) {
        expect(el.kLocal[r][c]).toBe(0);
        expect(el.kLocal[c][r]).toBe(0);
      }
      expect(el.fLocal[r]).toBe(0);
    }
    near(el.kLocal[1][1], (12 * E * Iz) / L ** 3, 1e-12);
    near(el.fLocal[5], (w * L * L) / 12, 1e-12);
    // Recovery still works: the member keeps the joint values in the floating modes.
    const u = new Array<number>(12).fill(0);
    u[0] = 0.01;
    u[3] = 0.02;
    const res = lineResult(el, u, 4);
    for (const s of res.stations) {
      expect(s.N).toBe(0);
      expect(s.T).toBe(0);
      near(s.u, 0.01, 1e-12);
      near(s.twist, 0.02, 1e-12);
    }
    // Shear released at both ends, unloaded: the transverse mode drops out as well.
    const slider = lineElement(
      beam('m', 'A', 'B', { releaseI: { fy: true }, releaseJ: { fy: true } }),
      [0, 0, 0],
      xj,
      [],
      ZERO,
    );
    expect(slider.kLocal[1][1]).toBe(0);
    expect(slider.kLocal[7][7]).toBe(0);
    // Pure bending EI/L is left between the two end rotations.
    near(slider.kLocal[5][5], (E * Iz) / L, 1e-9);
    near(slider.kLocal[5][11], (-E * Iz) / L, 1e-9);
    const bent = new Array<number>(12).fill(0);
    bent[5] = 0.001;
    bent[11] = -0.001;
    bent[1] = 0.25;
    const curve = lineResult(slider, bent, 4);
    for (const s of curve.stations) {
      near(s.Mz, (-2 * 0.001 * E * Iz) / L, 1e-9);
      near(s.v, 0.25 + 0.001 * s.x - (0.001 * s.x * s.x) / L, 1e-9, 1e-3);
    }
  });

  it('a shear-released member in a frame: rotational restraint EI/L only', () => {
    // Cantilever AB with a tip load P at B; BC is shear-released at B and fixed at C, so it
    // adds only the rotational stiffness EI/L2 (4EI/L − 3EI/L) to joint B.
    const L1 = 4;
    const L2 = 3;
    const P = 20;
    const EI = E * Iz;
    const sol = solveModel({
      nodes: { A: [0, 0, 0], B: [L1, 0, 0], C: [L1 + L2, 0, 0] },
      members: [beam('AB', 'A', 'B'), beam('BC', 'B', 'C', { releaseI: { fy: true } })],
      nodal: { B: [0, P, 0, 0, 0, 0] },
      fixed: { A: ALL, C: ALL },
    });
    const theta = (P * L1 * L1) / (2 * EI * (1 + L1 / L2));
    const M = (EI / L2) * theta;
    near(sol.u.B[5], theta, 1e-9);
    near(sol.u.B[1], (P * L1 ** 3) / (3 * EI) - (M * L1 * L1) / (2 * EI), 1e-9);
    const bc = sol.members.BC;
    expect(bc.endForces[1]).toBe(0);
    for (const s of bc.stations) {
      near(s.Vy, 0, 1e-9, P);
      near(s.Mz, -M, 1e-9);
      // Constant curvature from slope θ at B to zero slope and zero deflection at C: the
      // member's own start is at −θ·L2/2, not at the joint's deflection.
      near(s.v, (-theta * L2) / 2 + theta * s.x - (theta * s.x * s.x) / (2 * L2), 1e-9, theta * L2);
    }
    near(sol.reactions.A[1], -P, 1e-9);
    // BC is in pure bending: joint C holds it with −M, and A takes the rest of P·L1.
    near(sol.reactions.C[5], -M, 1e-9);
    near(sol.reactions.A[5], -P * L1 + M, 1e-9);
    expect(sol.reactions.C[1]).toBe(0);
    // The same member with the release at the far end (member reversed) gives the same joint.
    const mirrored = solveModel({
      nodes: { A: [0, 0, 0], B: [L1, 0, 0], C: [L1 + L2, 0, 0] },
      members: [beam('AB', 'A', 'B'), beam('CB', 'C', 'B', { releaseJ: { fy: true } })],
      nodal: { B: [0, P, 0, 0, 0, 0] },
      fixed: { A: ALL, C: ALL },
    });
    near(mirrored.u.B[5], theta, 1e-9);
    const cb = mirrored.members.CB;
    // CB runs along −X: its local y is still up, its local z is −Z.
    near(cb.stations[cb.stations.length - 1].v, (-theta * L2) / 2, 1e-9);
    near(cb.stations[0].v, 0, 1e-9, theta * L2);
  });

  it('recovers a shape for an unloaded member whose releases form a mechanism', () => {
    const el = lineElement(
      beam('m', 'A', 'B', { releaseI: { mz: true, fy: true }, releaseJ: { mz: true } }),
      [0, 0, 0],
      xj,
      [],
      ZERO,
    );
    for (const r of [1, 5, 7, 11]) {
      for (let c = 0; c < 12; c++) expect(Math.abs(el.kLocal[r][c])).toBeLessThan(1e-6);
    }
    const u = new Array<number>(12).fill(0);
    u[1] = 0.1;
    u[7] = 0.3;
    const res = lineResult(el, u, 2);
    // No bending stiffness is left; the straight line through joint j with the chord slope.
    expect(res.stations.map((s) => s.v)).toEqual([0.1, 0.2, 0.3].map((v) => expect.closeTo(v, 12)));
    for (const s of res.stations) expect(s.Mz).toBe(0);
  });

  it('treats rounding residue in a vanished pivot as zero, for any length and section', () => {
    // After the end moments are condensed the transverse stiffness of the plane is zero in
    // theory but ±1e-16 of its original value in floating point. Dividing by such a pivot
    // would turn the member's load into garbage instead of reporting the mechanism.
    const random = rng(77);
    const cases: Array<[EndRelease, EndRelease, MemberLoadDirection, number[]]> = [
      [{ mz: true, fy: true }, { mz: true }, 'localY', [1, 5, 7, 11]],
      [{ my: true }, { my: true, fz: true }, 'localZ', [2, 4, 8, 10]],
    ];
    for (let trial = 0; trial < 300; trial++) {
      const len = 0.5 + 9 * random();
      const props = {
        E: E * (1 + random()),
        Iy: Iy * (1 + random()),
        Iz: Iz * (1 + random()),
      };
      for (const [releaseI, releaseJ, direction, dead] of cases) {
        const member = beam('m', 'A', 'B', { ...props, releaseI, releaseJ });
        const end: Vec3 = [len, 0, 0];
        const el = lineElement(member, [0, 0, 0], end, [], ZERO);
        const axial = (props.E * A) / len;
        for (const r of dead) {
          for (let c = 0; c < 12; c++) expect(Math.abs(el.kLocal[r][c])).toBeLessThan(1e-9 * axial);
          expect(el.fLocal[r]).toBe(0);
        }
        near(el.kLocal[0][0], axial, 1e-12);
        near(el.kLocal[3][3], (G * J) / len, 1e-12);
        // The other bending plane is untouched.
        const other = direction === 'localY' ? 2 : 1;
        const EI = props.E * (direction === 'localY' ? props.Iy : props.Iz);
        near(el.kLocal[other][other], (12 * EI) / len ** 3, 1e-12);
        expectError(
          () =>
            lineElement(
              member,
              [0, 0, 0],
              end,
              [{ kind: 'distributed', member: 'm', direction, w1: 1 + random() }],
              ZERO,
            ),
          'UNSTABLE',
          /mechanism/,
        );
      }
    }
  });

  it('reports a loaded mechanism as UNSTABLE', () => {
    const torque: MemberLoad3D = { kind: 'moment', member: 'm', direction: 'localX', M: 1, a: 1 };
    const both = (key: keyof EndRelease) =>
      beam('m', 'A', 'B', { releaseI: { [key]: true }, releaseJ: { [key]: true } });
    const err = expectError(
      () => lineElement(both('mx'), [0, 0, 0], xj, [torque], ZERO),
      'UNSTABLE',
      /free to move as a rigid body \(mx/,
    );
    expect(err.memberId).toBe('m');
    expectError(() => lineElement(both('fy'), [0, 0, 0], xj, [udlY], ZERO), 'UNSTABLE', /fy/);
    expectError(
      () =>
        lineElement(
          both('fx'),
          [0, 0, 0],
          xj,
          [{ kind: 'point', member: 'm', direction: 'localX', P: 2, a: 1 }],
          ZERO,
        ),
      'UNSTABLE',
      /fx/,
    );
    // Pinned at both ends and shear-released at one: free to rotate about the other end.
    expectError(
      () =>
        lineElement(
          beam('m', 'A', 'B', { releaseI: { mz: true, fy: true }, releaseJ: { mz: true } }),
          [0, 0, 0],
          xj,
          [udlY],
          ZERO,
        ),
      'UNSTABLE',
      /mechanism/,
    );
    // The same releases without load in that mode are accepted.
    expect(() => lineElement(both('mx'), [0, 0, 0], xj, [udlY], ZERO)).not.toThrow();
    // A small but genuine load in the free mode is still reported next to a much larger one.
    expectError(
      () => lineElement(both('mx'), [0, 0, 0], xj, [udlY, { ...torque, M: 1e-5 }], ZERO),
      'UNSTABLE',
      /mx/,
    );
  });

  it('condenses a generic matrix like the 2D helper', () => {
    const k = [
      [4, 2, 0],
      [2, 3, 1],
      [0, 1, 2],
    ];
    const f = [1, 2, 3];
    condenseReleases(k, f, [1], 1, 'm');
    near(k[0][0], 4 - 4 / 3, 1e-14);
    near(k[0][2], -2 / 3, 1e-14);
    near(k[2][2], 2 - 1 / 3, 1e-14);
    near(f[0], 1 - 4 / 3, 1e-14);
    near(f[2], 3 - 2 / 3, 1e-14);
    expect(k[1]).toEqual([0, 0, 0]);
    expect(f[1]).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// 7. Truss
// ---------------------------------------------------------------------------------------

describe('truss element', () => {
  it('has stiffness EA/L along the axis of a 3D diagonal and none across it', () => {
    const a: Vec3 = [1, 1, 1];
    const b: Vec3 = [4, 5, 13];
    const el = lineElement(truss('t', 'A', 'B'), a, b, [], ZERO);
    expect(el.dofsPerNode).toBe(3);
    expect(el.k.length).toBe(6);
    expect(el.L).toBe(13);
    const n = normalize(sub(b, a));
    const ea = (E * A) / 13;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        near(el.k[r][c], ea * n[r] * n[c], 1e-12, ea);
        near(el.k[r][c + 3], -ea * n[r] * n[c], 1e-12, ea);
        near(el.k[r + 3][c], -ea * n[r] * n[c], 1e-12, ea);
        near(el.k[r + 3][c + 3], ea * n[r] * n[c], 1e-12, ea);
      }
    }
    const stretch = [...scale(n, -0.5), ...scale(n, 0.5)];
    const force = matVec(el.k, stretch);
    near(dot(force.slice(3) as Vec3, n), ea, 1e-12);
    const { values } = jacobiEigen(el.k);
    near(values[5], 2 * ea, 1e-12);
    for (let k = 0; k < 5; k++) expect(Math.abs(values[k])).toBeLessThan(1e-9 * ea);
  });

  it('produces no force under rigid-body motion and ignores beam-only properties', () => {
    const a: Vec3 = [0.5, -1, 2];
    const b: Vec3 = [-2, 3, 1];
    const plain = lineElement(truss('t', 'A', 'B'), a, b, [], ZERO);
    const dressed = lineElement(
      truss('t', 'A', 'B', { beta: 1, G: -1, Iy: 0, J: NaN, releaseI: { fx: true } }),
      a,
      b,
      [],
      ZERO,
    );
    expect(dressed.k).toEqual(plain.k);
    const reference = memberAxes(a, b);
    expect(dressed.axes).toEqual({ x: reference.x, y: reference.y, z: reference.z });
    expect(dressed.released.some(Boolean)).toBe(false);
    for (let mode = 0; mode < 6; mode++) {
      const d = mode < 3 ? UNIT[mode] : ZERO;
      const w = mode < 3 ? ZERO : UNIT[mode - 3];
      const u = [...add(d, cross(w, a)), ...add(d, cross(w, b))];
      for (const value of matVec(plain.k, u)) expect(Math.abs(value)).toBeLessThan(1e-9 * E * A);
    }
  });

  it('solves a three-bar tripod like hand statics', () => {
    const h = 3;
    const r = 2;
    const P = 90;
    const H = 24;
    const base = (deg: number): Vec3 => [
      r * Math.cos((deg * Math.PI) / 180),
      0,
      r * Math.sin((deg * Math.PI) / 180),
    ];
    const Lleg = Math.hypot(r, h);
    const model = (nodal: number[]): Model => ({
      nodes: { T: [0, h, 0], B1: base(0), B2: base(120), B3: base(240) },
      members: [truss('L1', 'T', 'B1'), truss('L2', 'B2', 'T'), truss('L3', 'T', 'B3')],
      nodal: { T: nodal },
      fixed: { B1: PINNED, B2: PINNED, B3: PINNED },
    });
    const vertical = solveModel(model([0, -P, 0, 0, 0, 0]));
    for (const id of ['L1', 'L2', 'L3']) {
      const res = vertical.members[id];
      for (const s of res.stations) near(s.N, (-P * Lleg) / (3 * h), 1e-9);
      expect(res.endForces.filter((_, k) => k !== 0 && k !== 6).every((v) => v === 0)).toBe(true);
      near(res.endForces[0], (P * Lleg) / (3 * h), 1e-9);
      near(res.endForces[6], (-P * Lleg) / (3 * h), 1e-9);
      for (const s of res.stations) {
        expect(s.Vy).toBe(0);
        expect(s.Mz).toBe(0);
        expect(s.twist).toBe(0);
      }
      near(res.maxAbsDeflection.value, 0, 1e-9, 1e-6);
    }
    // δ = P·L³ / (3·EA·h²) from virtual work.
    near(vertical.u.T[1], (-P * Lleg ** 3) / (3 * E * A * h * h), 1e-9);
    near(vertical.u.T[0], 0, 1e-9, 1e-5);
    for (const id of ['B1', 'B2', 'B3']) near(vertical.reactions[id][1], P / 3, 1e-9);

    // With a horizontal load H along +X: N1 = −PL/3h − 2HL/3r, N2 = N3 = −PL/3h + HL/3r.
    const both = solveModel(model([H, -P, 0, 0, 0, 0]));
    near(both.members.L1.stations[0].N, (-P * Lleg) / (3 * h) - (2 * H * Lleg) / (3 * r), 1e-9);
    near(both.members.L2.stations[0].N, (-P * Lleg) / (3 * h) + (H * Lleg) / (3 * r), 1e-9);
    near(both.members.L3.stations[0].N, (-P * Lleg) / (3 * h) + (H * Lleg) / (3 * r), 1e-9);
    let sumX = 0;
    let sumY = 0;
    for (const id of ['B1', 'B2', 'B3']) {
      sumX += both.reactions[id][0];
      sumY += both.reactions[id][1];
    }
    near(sumX, -H, 1e-9);
    near(sumY, P, 1e-9);
    // Stations follow the straight chord between the displaced joints.
    const leg = both.members.L1;
    const axes = leg.axes;
    const top = toLocal(axes, both.u.T);
    for (const s of leg.stations) {
      near(s.v, top[1] * (1 - s.x / Lleg), 1e-9, 1e-5);
      near(s.w, top[2] * (1 - s.x / Lleg), 1e-9, 1e-5);
    }
    near(leg.stations[0].u, top[0], 1e-9);
  });

  it('self-weight: joint loads total density·A·L·g and the bar hangs in tension', () => {
    const density = 78.5;
    const g: Vec3 = [0, -1, 0];
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [2, 6, 3];
    const el = lineElement(truss('t', 'A', 'B', { density }), a, b, [], g);
    const W = density * A * 7;
    near(el.f[1] + el.f[4], -W, 1e-12);
    near(el.f[1], -W / 2, 1e-12);
    for (const k of [0, 2, 3, 5]) expect(Math.abs(el.f[k])).toBeLessThan(1e-12 * W);
    // No density or no gravity: no load.
    expect(lineElement(truss('t', 'A', 'B'), a, b, [], g).f).toEqual([0, 0, 0, 0, 0, 0]);
    expect(lineElement(truss('t', 'A', 'B', { density }), a, b, [], ZERO).f).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(lineElement(truss('t', 'A', 'B', { density: 0 }), a, b, [], g).f).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);

    // Vertical hanger pinned at the top: N = weight below the section, extension W·L/2EA.
    const L = 4;
    const sol = solveModel({
      nodes: { A: [0, L, 0], B: [0, 0, 0] },
      members: [truss('t', 'A', 'B', { density })],
      fixed: { A: PINNED, B: [0, 2] },
      gravity: g,
    });
    const res = sol.members.t;
    const q = density * A;
    for (const s of res.stations) {
      near(s.N, q * (L - s.x), 1e-9, q * L);
      near(s.u, (q * (L * s.x - (s.x * s.x) / 2)) / (E * A), 1e-9, (q * L * L) / (E * A));
    }
    near(sol.reactions.A[1], q * L, 1e-9);
    near(sol.u.B[1], (-q * L * L) / (2 * E * A), 1e-9);
    near(res.maxAxial.value, q * L, 1e-9);
    expect(res.maxAxial.x).toBe(0);
  });

  it('axial diagram of an inclined bar with a localX distributed load', () => {
    const b: Vec3 = [3, 4, 12];
    const L = 13;
    const w1 = 2;
    const w2 = 5;
    const n = normalize(b);
    // Pinned at A; B is held transversally only by restraining it along a sliding direction:
    // solve directly with the element instead (u_j = δ·n is the only free motion).
    const el = lineElement(
      truss('t', 'A', 'B'),
      [0, 0, 0],
      b,
      [{ kind: 'distributed', member: 't', direction: 'localX', w1, w2 }],
      ZERO,
    );
    const fj = dot([el.f[3], el.f[4], el.f[5]], n);
    const fi = dot([el.f[0], el.f[1], el.f[2]], n);
    near(fi, (L * (2 * w1 + w2)) / 6, 1e-12);
    near(fj, (L * (w1 + 2 * w2)) / 6, 1e-12);
    const delta = fj / ((E * A) / L);
    const res = lineResult(el, [0, 0, 0, ...scale(n, delta)], 10);
    const k = (w2 - w1) / L;
    const total = ((w1 + w2) / 2) * L;
    for (const s of res.stations) {
      const x = s.x;
      near(s.N, total - (w1 * x + (k * x * x) / 2), 1e-9, total);
      near(s.u, (total * x - (w1 * x * x) / 2 - (k * x ** 3) / 6) / (E * A), 1e-9, delta);
    }
    near(res.endForces[0], -total, 1e-9);
    near(res.endForces[6], 0, 1e-9, total);
    near(res.stations[res.stations.length - 1].u, delta, 1e-9);
  });

  it('carries transverse loads to the joints and still reports its own V and M', () => {
    const L = 6;
    const w = 4;
    const M0 = 9;
    const { res, el } = single(
      truss('t', 'A', 'B'),
      [L, 0, 0],
      [
        { kind: 'distributed', member: 't', direction: 'localY', w1: -w },
        { kind: 'distributed', member: 't', direction: 'localZ', w1: w },
        { kind: 'moment', member: 't', direction: 'localY', M: M0, a: 2 },
        { kind: 'moment', member: 't', direction: 'globalZ', M: M0, a: 4 },
      ],
      PINNED,
      PINNED,
    );
    expect(el.warnings).toEqual([]);
    // Simple-beam reactions (forces by the joints on the bar).
    near(res.endForces[1], (w * L) / 2 + M0 / L, 1e-9);
    near(res.endForces[7], (w * L) / 2 - M0 / L, 1e-9);
    near(res.endForces[2], (-w * L) / 2 - M0 / L, 1e-9);
    near(res.endForces[8], (-w * L) / 2 + M0 / L, 1e-9);
    for (const k of [3, 4, 5, 9, 10, 11]) expect(res.endForces[k]).toBe(0);
    const end = res.stations[res.stations.length - 1];
    near(end.Mz, 0, 1e-9, w * L * L);
    near(end.My, 0, 1e-9, w * L * L);
    // Mz just left of the moment at x = 4: R·x − w·x²/2; the applied +Mz then drops it by M0.
    const pairZ = res.stations.filter((s) => s.x === 4);
    expect(pairZ.length).toBe(2);
    near(pairZ[0].Mz, ((w * L) / 2 + M0 / L) * 4 - (w * 16) / 2, 1e-9);
    near(pairZ[1].Mz - pairZ[0].Mz, -M0, 1e-9);
    // My jumps by +M0 at x = 2.
    const pairY = res.stations.filter((s) => s.x === 2);
    near(pairY[1].My - pairY[0].My, M0, 1e-9);
    near(pairY[0].My, (-(w * L) / 2 - M0 / L) * 2 + (w * 4) / 2, 1e-9);
    for (const s of res.stations) {
      expect(s.v).toBe(0);
      expect(s.w).toBe(0);
      expect(s.T).toBe(0);
    }
  });

  it('drops a torque about the bar axis with a warning', () => {
    const b: Vec3 = [3, 4, 0];
    const el = lineElement(
      truss('t', 'A', 'B'),
      [0, 0, 0],
      b,
      [{ kind: 'moment', member: 't', direction: 'globalX', M: 10, a: 2 }],
      ZERO,
    );
    expect(el.warnings.length).toBe(1);
    expect(el.warnings[0]).toMatch(/truss member "t".*own axis/);
    // Local components of the moment: 6 about x (dropped), −8 about y (kept, as a couple).
    expect(el.loads.moments[0].m[0]).toBe(0);
    near(el.loads.moments[0].m[1], -8, 1e-12);
    const res = lineResult(el, [0, 0, 0, 0, 0, 0], 4);
    for (const s of res.stations) expect(s.T).toBe(0);
    near(res.endForces[2], 8 / 5, 1e-12);
    near(res.endForces[8], -8 / 5, 1e-12);
    const pure = lineElement(
      truss('t', 'A', 'B'),
      [0, 0, 0],
      b,
      [{ kind: 'moment', member: 't', direction: 'localX', M: 10, a: 2 }],
      ZERO,
    );
    expect(pure.warnings.length).toBe(1);
    expect(pure.f).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------------------
// 8. Self-weight on beams
// ---------------------------------------------------------------------------------------

describe('beam self-weight', () => {
  const density = 25;
  it('total equivalent load on an inclined beam equals density·A·L·g', () => {
    const a: Vec3 = [1, 0, 2];
    const b: Vec3 = [5, 3, 14];
    const g: Vec3 = [0.2, -9.81, 0.4];
    const el = lineElement(beam('m', 'A', 'B', { density, beta: 0.5 }), a, b, [], g);
    const W = scale(g, density * A * 13);
    const f = el.f;
    for (let c = 0; c < 3; c++) near(f[c] + f[6 + c], W[c], 1e-12, norm(W));
    // Moment about A equals that of the weight acting at mid-length.
    const sumM = add(
      add([f[3], f[4], f[5]], [f[9], f[10], f[11]]),
      cross(sub(b, a), [f[6], f[7], f[8]]),
    );
    const expected = cross(scale(sub(b, a), 0.5), W);
    for (let c = 0; c < 3; c++) near(sumM[c], expected[c], 1e-11, norm(expected));
    expect(el.loads.distributed.length).toBe(1);
  });

  it('adds to explicit member loads and gives the rafter reactions and moment', () => {
    // Rafter at 3-4-5 slope, pinned at A, roller (vertical support) at B.
    const q = density * A; // weight per unit length of member
    const { res, sol } = single(
      beam('m', 'A', 'B', { density }),
      [4, 3, 0],
      [{ kind: 'distributed', member: 'm', direction: 'globalY', w1: -2 }],
      [0, 1, 2, 3],
      [1, 2],
      { gravity: [0, -1, 0] },
    );
    const total = (q + 2) * 5;
    near(sol.reactions.A[1], total / 2, 1e-9);
    near(sol.reactions.B[1], total / 2, 1e-9);
    near(sol.reactions.A[0], 0, 1e-9, total);
    // Normal component (q+2)·cos per unit length → M = w_n·L²/8; axial component → N.
    const wn = (q + 2) * 0.8;
    near(stationAt(res, 2.5).Mz, (wn * 25) / 8, 1e-9);
    near(res.stations[0].N, (-total / 2) * 0.6, 1e-9);
    near(res.stations[res.stations.length - 1].N, (total / 2) * 0.6, 1e-9);
  });
});

// ---------------------------------------------------------------------------------------
// 9. Stations
// ---------------------------------------------------------------------------------------

describe('stations', () => {
  const L = 10;
  const xj: Vec3 = [L, 0, 0];
  const member = beam('m', 'A', 'B');
  const simple = (loads: MemberLoad3D[], segments: number) =>
    single(member, xj, loads, [0, 1, 2, 3], PINNED, {}, segments).res;

  it('a point load gives two stations at the same x with a shear jump', () => {
    const P = 3;
    const res = simple([{ kind: 'point', member: 'm', direction: 'localY', P: -P, a: 2 }], 4);
    const pair = res.stations.filter((s) => s.x === 2);
    expect(pair.length).toBe(2);
    near(pair[0].Vy, 2.4, 1e-9);
    near(pair[1].Vy, -0.6, 1e-9);
    near(pair[0].Mz, 4.8, 1e-9);
    near(pair[1].Mz, 4.8, 1e-9);
    expect(pair[0].v).toBe(pair[1].v);
    // Regular stations are all there, in order.
    expect(res.stations.map((s) => s.x)).toEqual([0, 2, 2, 2.5, 5, 7.5, 10]);
    // A load in the other plane jumps Vz, not Vy.
    const z = simple([{ kind: 'point', member: 'm', direction: 'localZ', P: -P, a: 2 }], 4);
    const zp = z.stations.filter((s) => s.x === 2);
    near(zp[1].Vz - zp[0].Vz, -P, 1e-9);
    near(zp[1].Vy - zp[0].Vy, 0, 1e-9, P);
  });

  it('adds the zero-shear station so the maximum moment of UDL + point load is exact', () => {
    const res = simple(
      [
        { kind: 'distributed', member: 'm', direction: 'localY', w1: -2 },
        { kind: 'point', member: 'm', direction: 'localY', P: -3, a: 2 },
      ],
      4,
    );
    // R_i = 12.4; V = 0 at x = 4.7 where M = 12.4·4.7 − 4.7² − 3·2.7 = 28.09.
    near(res.maxAbsMz.x, 4.7, 1e-12);
    near(res.maxAbsMz.value, 28.09, 1e-12);
    const zero = stationAt(res, 4.7);
    near(zero.Vy, 0, 1e-9, 12.4);
    expect(res.stations.map((s) => s.x)).toEqual(
      [0, 2, 2, 2.5, zero.x, 5, 7.5, 10].sort((p, q) => p - q),
    );
    near(res.maxAbsVy.value, 12.4, 1e-12);
    expect(res.maxAbsVy.x).toBe(0);
  });

  it('finds both zeros of a quadratic shear inside one segment, in either plane', () => {
    const w0 = 6;
    const loads: MemberLoad3D[] = [
      { kind: 'distributed', member: 'm', direction: 'localY', w1: -w0, w2: w0 },
      { kind: 'distributed', member: 'm', direction: 'localZ', w1: 0, w2: w0 },
    ];
    const res = simple(loads, 1);
    const x1 = (L * (1 - Math.sqrt(1 / 3))) / 2;
    const x2 = (L * (1 + Math.sqrt(1 / 3))) / 2;
    const xz = L / Math.sqrt(3);
    const xs = res.stations.map((s) => s.x);
    expect(xs.length).toBe(5);
    near(xs[1], x1, 1e-12);
    near(xs[2], xz, 1e-12);
    near(xs[3], x2, 1e-12);
    const moment = (x: number) => w0 * ((L * x) / 6 + x ** 3 / (3 * L) - (x * x) / 2);
    near(res.stations[1].Mz, moment(x1), 1e-10);
    near(res.stations[3].Mz, moment(x2), 1e-10);
    near(res.stations[1].Vy, 0, 1e-10, w0 * L);
    near(res.stations[3].Vy, 0, 1e-10, w0 * L);
    near(res.maxAbsMz.value, moment(x1), 1e-10);
    near(res.maxAbsMy.value, (-w0 * L * L) / (9 * Math.sqrt(3)), 1e-10);
    near(res.maxAbsMy.x, xz, 1e-12);
  });

  it('adds one station where the shear vanishes in both planes at the same section', () => {
    const res = simple(
      [
        { kind: 'distributed', member: 'm', direction: 'localY', w1: -2 },
        { kind: 'distributed', member: 'm', direction: 'localZ', w1: 7 },
      ],
      3,
    );
    const xs = res.stations.map((s) => s.x);
    expect(xs.length).toBe(5);
    near(xs[2], L / 2, 1e-12);
    near(res.maxAbsMz.value, (2 * L * L) / 8, 1e-12);
    near(res.maxAbsMy.value, (-7 * L * L) / 8, 1e-12);
    near(res.maxAbsMz.x, L / 2, 1e-12);
    near(res.maxAbsMy.x, L / 2, 1e-12);
  });

  it('adds no spurious stations for unloaded or uniformly sheared members', () => {
    const sol = solveModel(
      {
        nodes: { A: [0, 0, 0], B: xj },
        members: [member],
        nodal: { B: [5, -3, 2, 1, 0, 0] },
        fixed: { A: ALL },
      },
      5,
    );
    expect(sol.members.m.stations.map((s) => s.x)).toEqual([0, 2, 4, 6, 8, 10]);
    const idle = lineResult(lineElement(member, [0, 0, 0], xj, [], ZERO), new Array(12).fill(0), 3);
    expect(idle.stations.length).toBe(4);
    for (const s of idle.stations) {
      expect([s.N, s.Vy, s.Vz, s.T, s.My, s.Mz, s.u, s.v, s.w, s.twist]).toEqual(
        new Array(10).fill(0),
      );
    }
    expect(idle.maxAbsDeflection).toEqual({ value: 0, x: 0 });
    // Fewer than one segment is treated as one.
    expect(
      lineResult(lineElement(member, [0, 0, 0], xj, [], ZERO), new Array(12).fill(0), 0).stations
        .length,
    ).toBe(2);
    expect(
      lineResult(lineElement(member, [0, 0, 0], xj, [], ZERO), new Array(12).fill(0), NaN).stations
        .length,
    ).toBe(2);
  });

  it('ignores rounding-level shear in the other plane when looking for zero shear', () => {
    // With beta = 90° the global-Y loads act along local −z, but cos 90° = 6e-17 leaves a
    // component of that size along local y. Its "shear" changes sign at x = 4.584, which must
    // not become a station; the real zero of Vz (shifted by the pure local-z load) must.
    const rolled = beam('m', 'A', 'B', { beta: Math.PI / 2 });
    const { res } = single(
      rolled,
      xj,
      [
        { kind: 'distributed', member: 'm', direction: 'globalY', w1: -5 },
        { kind: 'point', member: 'm', direction: 'globalY', P: -20, a: 2 },
        { kind: 'point', member: 'm', direction: 'localZ', P: 30, a: 7 },
      ],
      ALL,
      ALL,
      {},
      3,
    );
    near(res.axes.z[1], -1, 1e-15);
    // Local z loads: +5 per unit length, +20 at 2, +30 at 7 → R_i = 25 + 17.92 + 6.48 = 49.4,
    // and Vz = −49.4 + 5x + 20 vanishes at x = 5.88.
    near(res.endForces[2], -49.4, 1e-9);
    const xs = res.stations.map((s) => s.x);
    expect(xs.length).toBe(9);
    const expected = [0, 2, 2, L / 3, 5.88, (2 * L) / 3, 7, 7, L];
    xs.forEach((x, k) => near(x, expected[k], 1e-9, L));
    for (const s of res.stations) {
      expect(Math.abs(s.Vy)).toBeLessThan(1e-12);
      expect(Math.abs(s.Mz)).toBeLessThan(1e-12);
    }
    near(stationAt(res, 5.88).Vz, 0, 1e-9, 49.4);
  });

  it('torque diagram of a fixed-fixed shaft with a point torque', () => {
    const T0 = 12;
    const a = 3;
    const b = L - a;
    const { res } = single(
      member,
      xj,
      [{ kind: 'moment', member: 'm', direction: 'localX', M: T0, a }],
      ALL,
      ALL,
      {},
      5,
    );
    near(res.endForces[3], (-T0 * b) / L, 1e-9);
    near(res.endForces[9], (-T0 * a) / L, 1e-9);
    const pair = res.stations.filter((s) => s.x === a);
    expect(pair.length).toBe(2);
    near(pair[0].T, (T0 * b) / L, 1e-9);
    near(pair[1].T, (-T0 * a) / L, 1e-9);
    near(pair[0].twist, (T0 * a * b) / (L * G * J), 1e-9);
    for (const s of res.stations) {
      const expected = s.x <= a ? (T0 * b * s.x) / L : (T0 * a * (L - s.x)) / L;
      near(s.twist, expected / (G * J), 1e-9, (T0 * L) / (G * J));
    }
    near(res.maxAbsTorsion.value, (T0 * b) / L, 1e-9);
  });

  it('includes kink stations at the ends of a partial load and handles loads at the ends', () => {
    const res = simple(
      [
        { kind: 'distributed', member: 'm', direction: 'localY', w1: -1, a: 1.3, b: 3.7 },
        { kind: 'point', member: 'm', direction: 'localY', P: -5, a: 0 },
        { kind: 'point', member: 'm', direction: 'localY', P: -7, a: L },
        { kind: 'distributed', member: 'm', direction: 'localY', w1: -4, a: 2, b: 2 },
      ],
      2,
    );
    const xs = res.stations.map((s) => s.x);
    expect(xs[0]).toBe(0);
    expect(xs).toContain(1.3);
    expect(xs).toContain(3.7);
    expect(xs.filter((x) => x === 0).length).toBe(1);
    expect(xs.filter((x) => x === L).length).toBe(1);
    // End loads go straight into the supports: reactions 5 + R and 7 + R′.
    const total = 2.4;
    const rj = (total * 2.5) / L;
    near(res.endForces[1], 5 + total - rj, 1e-9);
    near(res.endForces[7], 7 + rj, 1e-9);
    // The station at x = 0 is the right-hand limit (the end load is already included).
    near(res.stations[0].Vy, total - rj, 1e-9);
    near(res.stations[res.stations.length - 1].Mz, 0, 1e-9, 10);
    // The zero-length load was ignored.
    expect(res.stations.filter((s) => s.x === 2).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// lineLoads helpers
// ---------------------------------------------------------------------------------------

describe('lineLoads helpers', () => {
  const axes = memberAxes([0, 0, 0], [2, 3, 6], 0.3);

  it('resolves local and global directions into local components', () => {
    expect(resolveDirection(2, 'localX', axes)).toEqual([2, 0, 0]);
    expect(resolveDirection(2, 'localY', axes)).toEqual([0, 2, 0]);
    expect(resolveDirection(2, 'localZ', axes)).toEqual([0, 0, 2]);
    (['globalX', 'globalY', 'globalZ'] as const).forEach((direction, k) => {
      const local = resolveDirection(5, direction, axes);
      const back = toGlobal(axes, local);
      for (let c = 0; c < 3; c++) near(back[c], c === k ? 5 : 0, 1e-13, 5);
    });
    expectError(
      () => resolveDirection(1, 'diagonal' as MemberLoadDirection, axes),
      'INVALID_MODEL',
      /Unknown load direction/,
    );
  });

  it('resolves, clamps and collects breakpoints', () => {
    const L = 7;
    const loads = resolveLineLoads(
      [
        { kind: 'distributed', member: 'm', direction: 'localY', w1: 1, a: -1e-12, b: L + 1e-12 },
        { kind: 'point', member: 'm', direction: 'localZ', P: 2, a: 3 },
        { kind: 'moment', member: 'm', direction: 'localX', M: 4, a: 5 },
      ],
      axes,
      L,
      'm',
    );
    expect(loads.distributed[0].a).toBe(0);
    expect(loads.distributed[0].b).toBe(L);
    expect(loads.distributed[0].w2).toEqual([0, 1, 0]);
    expect(lineBreakpoints(loads)).toEqual({ kinks: [0, L], jumps: [3, 5] });
    expect(loadResultant(loads)).toEqual([0, 7, 2, 4, -6, 24.5]);
    expect(lineBreakpoints(emptyLineLoads())).toEqual({ kinks: [], jumps: [] });
    expect(equivalentLineLoads(emptyLineLoads(), L, 'beam')).toEqual(new Array(12).fill(0));
  });

  it('gives a truss no torque about its own axis and a beam the lever-rule split', () => {
    const loads = emptyLineLoads();
    loads.moments.push({ a: 1, m: [8, 0, 0] });
    expect(equivalentLineLoads(loads, 4, 'truss')).toEqual(new Array(12).fill(0));
    const asBeam = equivalentLineLoads(loads, 4, 'beam');
    expect(asBeam[3]).toBe(6);
    expect(asBeam[9]).toBe(2);
    expect(asBeam.filter((_, k) => k !== 3 && k !== 9).every((v) => v === 0)).toBe(true);
    expect(loadResultant(loads)).toEqual([0, 0, 0, 8, 0, 0]);
  });

  it('internal forces follow the Station3D sign conventions', () => {
    // Free body with only end forces at i: [Fx, Fy, Fz, Mx, My, Mz] = [1, 2, 3, 4, 5, 6].
    const e = [1, 2, 3, 4, 5, 6, 0, 0, 0, 0, 0, 0];
    const f = internalForces(2, -1, e, emptyLineLoads());
    expect(f).toEqual({ N: -1, Vy: 2, Vz: 3, T: -4, My: 5 + 3 * 2, Mz: -6 + 2 * 2 });
    // dMz/dx = Vy and dMy/dx = Vz with distributed loads present.
    const loads = resolveLineLoads(
      [
        { kind: 'distributed', member: 'm', direction: 'localY', w1: 1, w2: 3, a: 1, b: 4 },
        { kind: 'distributed', member: 'm', direction: 'localZ', w1: -2, w2: 1, a: 0, b: 5 },
        { kind: 'distributed', member: 'm', direction: 'localX', w1: 2, a: 2, b: 6 },
      ],
      axes,
      7,
      'm',
    );
    const h = 1e-5;
    for (const x of [0.5, 1.7, 3.2, 4.6, 6.5]) {
      const lo = internalForces(x - h, -1, e, loads);
      const hi = internalForces(x + h, -1, e, loads);
      const mid = internalForces(x, -1, e, loads);
      near((hi.Mz - lo.Mz) / (2 * h), mid.Vy, 1e-7, 1);
      near((hi.My - lo.My) / (2 * h), mid.Vz, 1e-7, 1);
    }
    near(internalForces(7, -1, e, loads).N, -(1 + 8), 1e-12);
    near(internalForces(7, -1, e, loads).Vy, 2 + 6, 1e-12);
    near(internalForces(7, -1, e, loads).Vz, 3 - 2.5, 1e-12);
  });
});

// ---------------------------------------------------------------------------------------
// 10. Invalid input
// ---------------------------------------------------------------------------------------

describe('invalid input', () => {
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [4, 0, 0];
  const build = (member: Member3D, loads: MemberLoad3D[] = [], xj: Vec3 = b, g: Vec3 = ZERO) =>
    lineElement(member, a, xj, loads, g);

  it('rejects zero-length members and bad coordinates', () => {
    const err = expectError(
      () => build(beam('m', 'A', 'B'), [], [0, 0, 0]),
      'INVALID_MODEL',
      /zero length/,
    );
    expect(err.memberId).toBe('m');
    expectError(
      () => build(truss('t', 'A', 'B'), [], [1e-12, 0, 0]),
      'INVALID_MODEL',
      /zero length/,
    );
    expectError(() => build(beam('m', 'A', 'B'), [], [NaN, 0, 0]), 'INVALID_MODEL', /coordinates/);
    expectError(
      () => build(beam('m', 'A', 'B'), [], [Infinity, 0, 0]),
      'INVALID_MODEL',
      /coordinates/,
    );
  });

  it('rejects non-positive or non-finite section properties', () => {
    const cases: Array<[Partial<Member3D>, RegExp]> = [
      [{ E: 0 }, /Young's modulus/],
      [{ E: Infinity }, /Young's modulus/],
      [{ A: -1 }, /area A/],
      [{ A: NaN }, /area A/],
      [{ G: undefined }, /shear modulus G/],
      [{ G: 0 }, /shear modulus G/],
      [{ Iy: 0 }, /Iy/],
      [{ Iy: undefined }, /Iy/],
      [{ Iz: -2 }, /Iz/],
      [{ J: Infinity }, /torsion constant J/],
      [{ J: undefined }, /torsion constant J/],
      [{ beta: NaN }, /roll angle/],
      [{ density: -1 }, /density/],
      [{ density: NaN }, /density/],
    ];
    for (const [extra, pattern] of cases) {
      const err = expectError(() => build(beam('m', 'A', 'B', extra)), 'INVALID_MODEL', pattern);
      expect(err.memberId).toBe('m');
    }
    expectError(() => build(truss('t', 'A', 'B', { E: -1 })), 'INVALID_MODEL', /Young's modulus/);
    expectError(() => build(truss('t', 'A', 'B', { A: 0 })), 'INVALID_MODEL', /area A/);
    expectError(
      () => build({ ...beam('m', 'A', 'B'), type: 'cable' as Member3D['type'] }),
      'INVALID_MODEL',
      /unknown type/,
    );
    expectError(
      () => build(beam('m', 'A', 'B', { density: 1 }), [], b, [0, NaN, 0]),
      'INVALID_MODEL',
      /self-weight/,
    );
  });

  it('rejects loads positioned outside the member or with invalid values', () => {
    const outside: MemberLoad3D[] = [
      { kind: 'point', member: 'm', direction: 'localY', P: 1, a: 4.5 },
      { kind: 'point', member: 'm', direction: 'localY', P: 1, a: -0.1 },
      { kind: 'point', member: 'm', direction: 'localY', P: 1, a: NaN },
      { kind: 'moment', member: 'm', direction: 'localZ', M: 1, a: 9 },
      { kind: 'distributed', member: 'm', direction: 'localY', w1: 1, a: -1 },
      { kind: 'distributed', member: 'm', direction: 'localY', w1: 1, b: 5 },
    ];
    for (const load of outside) {
      const err = expectError(
        () => build(beam('m', 'A', 'B'), [load]),
        'INVALID_MODEL',
        /outside the member \(0 to 4\.000\)/,
      );
      expect(err.memberId).toBe('m');
    }
    expectError(
      () =>
        build(beam('m', 'A', 'B'), [
          { kind: 'distributed', member: 'm', direction: 'localY', w1: 1, a: 3, b: 1 },
        ]),
      'INVALID_MODEL',
      /ends before it starts/,
    );
    const bad: MemberLoad3D[] = [
      { kind: 'point', member: 'm', direction: 'localY', P: NaN, a: 1 },
      { kind: 'moment', member: 'm', direction: 'localY', M: Infinity, a: 1 },
      { kind: 'distributed', member: 'm', direction: 'localY', w1: NaN },
      { kind: 'distributed', member: 'm', direction: 'localY', w1: 1, w2: NaN },
    ];
    for (const load of bad) {
      expectError(() => build(truss('m', 'A', 'B'), [load]), 'INVALID_MODEL', /invalid magnitude/);
    }
  });

  it('rejects a displacement vector of the wrong size', () => {
    const el = build(beam('m', 'A', 'B'));
    expectError(() => lineResult(el, [0, 0, 0, 0, 0, 0], 4), 'INVALID_MODEL', /expects 12/);
    const bar = build(truss('t', 'A', 'B'));
    expectError(() => lineResult(bar, new Array(12).fill(0), 4), 'INVALID_MODEL', /expects 6/);
  });
});
