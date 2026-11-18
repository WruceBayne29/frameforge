import { describe, expect, it } from 'vitest';
import { jacobiEigen, subspaceIteration } from './eigen';
import { lineElement, lineMass, lineShape } from './line';
import { modalAnalysis3d, refineModel3D } from './modal';
import { plateElement, plateMass } from './plate';
import { solidElement, solidMass } from './solid';
import { SkylineMatrix } from './sparse';
import type { Member3D, StructureModel3D, Support3D, Vec3 } from './types';

const E = 2e8; // kN/m²
const G = E / 2.6;
const RHO = 7.85; // t/m³
const A = 8e-3;
const IZ = 1.2e-4;
const IY = 3e-5;
const J = 4e-6;
const L = 6;

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

function beam(id: string, i: string, j: string, extra: Partial<Member3D> = {}): Member3D {
  return { id, i, j, type: 'beam', E, G, A, Iy: IY, Iz: IZ, J, mass: RHO, ...extra };
}

/** A beam along X from 0 to L as one member, supports at the given ends. */
function straightBeam(supports: Support3D[], extra: Partial<StructureModel3D> = {}) {
  return {
    nodes: [
      { id: 'A', x: 0, y: 0, z: 0 },
      { id: 'B', x: L, y: 0, z: 0 },
    ],
    members: [beam('AB', 'A', 'B')],
    supports,
    loads: [],
    ...extra,
  } satisfies StructureModel3D;
}

/** Frequencies (Hz) of the modes whose mass fraction is mostly along the given axis. */
function frequenciesAlong(r: ReturnType<typeof modalAnalysis3d>, axis: 0 | 1 | 2): number[] {
  return r.modes
    .filter((m) => {
      // A mode belongs to the axis its nodal / member displacement mostly points along.
      let s = [0, 0, 0];
      for (const list of Object.values(m.members)) {
        for (const p of list) s = [s[0] + p.u ** 2, s[1] + p.v ** 2, s[2] + p.w ** 2];
      }
      // Skip modes without translation (torsion).
      return Math.max(...s) > 1e-6 && s[axis] >= Math.max(...s) * 0.999;
    })
    .map((m) => m.frequency);
}

describe('consistent mass matrices', () => {
  it('beam: symmetric, total translational mass ρAL in every direction, torsional inertia', () => {
    const el = lineElement(beam('m', 'a', 'b'), [0, 0, 0], [3, 4, 0], [], [0, 0, 0]);
    const m = lineMass(el);
    const total = RHO * A * 5;
    for (let a = 0; a < 12; a++)
      for (let b = 0; b < 12; b++) expect(m[a][b]).toBeCloseTo(m[b][a], 12);
    // Rigid translation r along each axis: rᵀ·M·r = total mass.
    for (let d = 0; d < 3; d++) {
      let sum = 0;
      for (const a of [d, d + 6]) for (const b of [d, d + 6]) sum += m[a][b];
      expect(rel(sum, total)).toBeLessThan(1e-12);
    }
    // Rigid rotation about the member axis (x = (0.6, 0.8, 0)): ρ·(Iy + Iz)·L.
    const axis: Vec3 = [0.6, 0.8, 0];
    let spin = 0;
    for (const a of [0, 6]) {
      for (const b of [0, 6]) {
        for (let p = 0; p < 3; p++) {
          for (let q = 0; q < 3; q++) spin += axis[p] * axis[q] * m[a + 3 + p][b + 3 + q];
        }
      }
    }
    expect(rel(spin, RHO * (IY + IZ) * 5)).toBeLessThan(1e-12);
  });

  it('truss: 6 × 6, ρAL in each direction', () => {
    const el = lineElement(
      { id: 't', i: 'a', j: 'b', type: 'truss', E, A, mass: RHO },
      [0, 0, 0],
      [0, 2, 0],
      [],
      [0, 0, 0],
    );
    const m = lineMass(el);
    expect(m).toHaveLength(6);
    expect(rel(m[1][1] + m[1][4] + m[4][1] + m[4][4], RHO * A * 2)).toBeLessThan(1e-12);
  });

  it('beam with a released end: Guyan reduction keeps the rigid-body mass', () => {
    const el = lineElement(
      beam('m', 'a', 'b', { releaseJ: { mz: true, my: true } }),
      [0, 0, 0],
      [4, 0, 0],
      [],
      [0, 0, 0],
    );
    const m = lineMass(el);
    let sum = 0;
    for (const a of [1, 7]) for (const b of [1, 7]) sum += m[a][b];
    expect(rel(sum, RHO * A * 4)).toBeLessThan(1e-12);
    expect(m[11][11]).toBe(0);
    expect(m[10][10]).toBe(0);
    // A member with no mass density has none.
    const light = lineElement(
      beam('n', 'a', 'b', { mass: undefined }),
      [0, 0, 0],
      [1, 0, 0],
      [],
      [0, 0, 0],
    );
    expect(
      lineMass(light)
        .flat()
        .every((v) => v === 0),
    ).toBe(true);
  });

  it('plate: ρ·t·area in each translation, rotary inertia ρt³/12', () => {
    const coords: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0.5],
      [2.2, 1.5, 0.5],
      [0, 1.4, 0],
    ];
    const el = plateElement(
      { id: 'p', nodes: ['1', '2', '3', '4'], E: 3e7, nu: 0.2, t: 0.2, mass: 2.5 },
      coords,
      [],
      [0, 0, 0],
    );
    const m = plateMass(el);
    for (let d = 0; d < 3; d++) {
      let sum = 0;
      for (let a = d; a < 24; a += 6) for (let b = d; b < 24; b += 6) sum += m[a][b];
      expect(rel(sum, 2.5 * 0.2 * el.area)).toBeLessThan(1e-12);
    }
    const zero = plateElement(
      { id: 'q', nodes: ['1', '2', '3', '4'], E: 3e7, nu: 0.2, t: 0.2 },
      coords,
      [],
      [0, 0, 0],
    );
    expect(
      plateMass(zero)
        .flat()
        .every((v) => v === 0),
    ).toBe(true);
  });

  it('solid: ρ·V in each translation, also for a distorted hexahedron', () => {
    const coords: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [1.2, 1, 0],
      [0, 0.9, 0.1],
      [0, 0, 1],
      [1.1, 0, 1.2],
      [1, 1, 1],
      [0.1, 1, 1],
    ];
    const el = solidElement(
      { id: 's', nodes: ['1', '2', '3', '4', '5', '6', '7', '8'], E: 1e6, nu: 0.25, mass: 2 },
      coords,
      [],
      [0, 0, 0],
    );
    const m = solidMass(el, coords);
    let sum = 0;
    for (let a = 1; a < 24; a += 3) for (let b = 1; b < 24; b += 3) sum += m[a][b];
    expect(rel(sum, 2 * el.volume)).toBeLessThan(1e-12);
    const light = solidElement(
      { id: 't', nodes: ['1', '2', '3', '4', '5', '6', '7', '8'], E: 1e6, nu: 0.25 },
      coords,
      [],
      [0, 0, 0],
    );
    expect(
      solidMass(light, coords)
        .flat()
        .every((v) => v === 0),
    ).toBe(true);
  });
});

describe('eigen solvers', () => {
  it('Jacobi diagonalises a symmetric matrix', () => {
    const r = jacobiEigen([
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ]);
    expect(r.values[0]).toBeLessThan(r.values[1]);
    expect(r.values.reduce((a, b) => a + b)).toBeCloseTo(9, 12);
  });

  it('subspace iteration matches a dense solve on a spring–mass chain', () => {
    // Ten masses on springs, fixed at one end: K tridiagonal, M diagonal.
    const n = 10;
    const K = new SkylineMatrix(Array.from({ length: n }, (_, j) => Math.max(0, j - 1)));
    const k = (i: number) => 100 + 10 * i;
    for (let i = 0; i < n; i++) {
      K.add(i, i, k(i) + (i + 1 < n ? k(i + 1) : 0));
      if (i + 1 < n) K.add(i, i + 1, -k(i + 1));
    }
    const mass = Array.from({ length: n }, (_, i) => 1 + 0.1 * i);
    const dense = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => K.get(i, j) / Math.sqrt(mass[i] * mass[j])),
    );
    const exact = jacobiEigen(dense).values;
    const kd = Array.from({ length: n }, (_, i) => K.diagonal(i));
    const plain = K.clone();
    K.factor();
    const r = subspaceIteration(
      K,
      (x) => plain.multiply(x),
      (x) => x.map((v, i) => v * mass[i]),
      kd,
      mass,
      3,
    );
    expect(r.converged).toBe(true);
    r.values.forEach((v, i) => expect(rel(v, exact[i])).toBeLessThan(1e-10));
    // More modes than equations: all of them.
    const small = new SkylineMatrix([0]);
    small.add(0, 0, 4);
    small.factor();
    const four = (x: Float64Array) => x.map((v) => 4 * v);
    expect(subspaceIteration(small, four, (x) => x, [4], [1], 3).values[0]).toBeCloseTo(4, 12);
    expect(subspaceIteration(small, four, (x) => x, [4], [1], 0).values).toEqual([]);
    // No mass at all: no finite-frequency mode.
    expect(subspaceIteration(small, four, (x) => x.map(() => 0), [4], [0], 2).values).toEqual([]);
  });
});

describe('subspace iteration: hard cases', () => {
  const diagonal = (values: number[]) => {
    const K = new SkylineMatrix(values.map((_, j) => j));
    values.forEach((v, i) => K.add(i, i, v));
    return K;
  };

  it('widens the subspace past a cluster of nearly equal eigenvalues', () => {
    // 40 uncoupled unit masses: five well separated, then 35 within 0.5 % of each other.
    const k = [1, 2, 3, 4, 5, ...Array.from({ length: 35 }, (_, i) => 10 + 0.0014 * i)];
    const K = diagonal(k);
    const plain = K.clone();
    K.factor();
    const ones = k.map(() => 1);
    const r = subspaceIteration(
      K,
      (x) => plain.multiply(x),
      (x) => x,
      k,
      ones,
      6,
    );
    expect(r.converged).toBe(true);
    // The iteration stops when the values change by < 1e-10 per step; inside a cluster that
    // leaves an error of a few 1e-9.
    [1, 2, 3, 4, 5, 10].forEach((v, i) => expect(Math.abs(r.values[i] - v) / v).toBeLessThan(1e-7));
  });

  it('a mass matrix of lower rank than it looks gives only its finite modes', () => {
    // M = v·vᵀ with v = (1, 1, 1): three DOFs carry mass, but there is one finite mode,
    // λ = 1 / (vᵀ·K⁻¹·v).
    const k = [2, 4, 8];
    const K = diagonal(k);
    const plain = K.clone();
    K.factor();
    const multiplyM = (x: Float64Array) => {
      const s = x[0] + x[1] + x[2];
      return Float64Array.from([s, s, s]);
    };
    const r = subspaceIteration(K, (x) => plain.multiply(x), multiplyM, k, [1, 1, 1], 2);
    expect(r.values).toHaveLength(1);
    expect(r.values[0]).toBeCloseTo(1 / (1 / 2 + 1 / 4 + 1 / 8), 10);
  });

  it('reports when it runs out of iterations', () => {
    const k = [1, 1.0000001, 3, 4];
    const K = diagonal(k);
    const plain = K.clone();
    K.factor();
    const r = subspaceIteration(
      K,
      (x) => plain.multiply(x),
      (x) => x,
      k,
      [1, 1, 1, 1],
      1,
      {
        maxIterations: 1,
      },
    );
    expect(r.converged).toBe(false);
    expect(r.iterations).toBe(1);
  });
});

describe('modal analysis: beams, closed forms', () => {
  // Simply supported (pins at both ends, twist held at one): ωn = (nπ/L)²·√(EI/ρA).
  const pin = (node: string, extra: Partial<Support3D> = {}): Support3D => ({
    node,
    ux: true,
    uy: true,
    uz: true,
    ...extra,
  });

  it('simply supported beam: bending about both axes', () => {
    const r = modalAnalysis3d(straightBeam([pin('A', { rx: true }), pin('B')]), 6, {
      subdivide: 16,
    });
    const f = (I: number, n: number) =>
      (((n * Math.PI) / L) ** 2 * Math.sqrt((E * I) / (RHO * A))) / (2 * Math.PI);
    // Weak axis (Iy, bending in x–z: w) first, then the strong axis.
    const weak = frequenciesAlong(r, 2);
    const strong = frequenciesAlong(r, 1);
    expect(rel(weak[0], f(IY, 1))).toBeLessThan(1e-4);
    expect(rel(weak[1], f(IY, 2))).toBeLessThan(1e-3);
    expect(rel(strong[0], f(IZ, 1))).toBeLessThan(1e-4);
    expect(r.modes[0].frequency).toBeLessThan(r.modes[1].frequency);
    expect(r.warnings).toEqual([]);
  });

  it('cantilever: β1 = 1.8751 in both planes, mass fractions along the bending direction', () => {
    const fixed: Support3D = {
      node: 'A',
      ux: true,
      uy: true,
      uz: true,
      rx: true,
      ry: true,
      rz: true,
    };
    const r = modalAnalysis3d(straightBeam([fixed]), 4, { subdivide: 12 });
    const f = (I: number) =>
      ((1.8751 ** 2 / L ** 2) * Math.sqrt((E * I) / (RHO * A))) / (2 * Math.PI);
    expect(rel(frequenciesAlong(r, 2)[0], f(IY))).toBeLessThan(2e-4);
    expect(rel(frequenciesAlong(r, 1)[0], f(IZ))).toBeLessThan(2e-4);
    // First cantilever mode: effective mass 61.3 % of the total.
    const first = r.modes[0];
    expect(first.massFraction[2]).toBeGreaterThan(0.6);
    expect(first.massFraction[2]).toBeLessThan(0.62);
    expect(rel(r.totalMass, RHO * A * L)).toBeLessThan(1e-12);
  });

  it('torsion and axial vibration of a fixed–free shaft', () => {
    // Only ux and rx free: ω = (2n − 1)·π/(2L)·√(GJ/ρIp) and √(E/ρ).
    const fixed: Support3D = { node: 'A', ux: true, rx: true };
    const r = modalAnalysis3d(
      straightBeam([fixed], { restrainAll: { uy: true, uz: true, ry: true, rz: true } }),
      6,
      { subdivide: 20 },
    );
    const torsion = (n: number) =>
      ((((2 * n - 1) * Math.PI) / (2 * L)) * Math.sqrt((G * J) / (RHO * (IY + IZ)))) /
      (2 * Math.PI);
    const axial = (n: number) =>
      ((((2 * n - 1) * Math.PI) / (2 * L)) * Math.sqrt(E / RHO)) / (2 * Math.PI);
    const freqs = r.modes.map((m) => m.frequency);
    const near = (target: number) => Math.min(...freqs.map((x) => rel(x, target)));
    expect(near(torsion(1))).toBeLessThan(1e-3);
    // Linear elements with consistent mass: the error grows as (n/elements)².
    expect(near(torsion(2))).toBeLessThan(3e-3);
    expect(near(axial(1))).toBeLessThan(1e-3);
    // Pure torsion has no translational mass participation.
    const twist = r.modes.find((m) => rel(m.frequency, torsion(1)) < 1e-3);
    expect(twist?.massFraction.every((v) => v < 1e-12)).toBe(true);
    // Scaled by its rotation: twist × model size = 1 at the free end.
    expect(Math.abs(twist?.displacements.B.rx ?? 0) * L).toBeCloseTo(1, 9);
  });

  it('a lumped mass on a weightless cantilever: ω = √(3EI/(mL³))', () => {
    const fixed: Support3D = {
      node: 'A',
      ux: true,
      uy: true,
      uz: true,
      rx: true,
      ry: true,
      rz: true,
    };
    const model = straightBeam([fixed], { masses: [{ node: 'B', mass: 2 }] });
    model.members = [beam('AB', 'A', 'B', { mass: 0 })];
    const r = modalAnalysis3d(model, 2);
    expect(rel(r.modes[0].omega, Math.sqrt((3 * E * IY) / (2 * L ** 3)))).toBeLessThan(1e-9);
    expect(r.totalMass).toBe(2);
  });

  it('refines beams but not trusses, keeping releases on the end parts', () => {
    const model: StructureModel3D = {
      nodes: [
        { id: 'a', x: 0, y: 0, z: 0 },
        { id: 'b', x: 3, y: 0, z: 0 },
      ],
      members: [
        beam('m', 'a', 'b', { releaseI: { mz: true }, releaseJ: { my: true } }),
        { id: 't', i: 'a', j: 'b', type: 'truss', E, A },
      ],
      supports: [],
      loads: [{ kind: 'nodal', node: 'b', fy: 1 }],
    };
    const refined = refineModel3D(model, 3);
    expect(refined.loads).toEqual([]);
    expect(refined.nodes.map((n) => n.id)).toEqual(['a', 'b', 'm#1', 'm#2']);
    expect(refined.members?.map((m) => m.id)).toEqual(['m#0', 'm#1', 'm#2', 't']);
    expect(refined.members?.[0].releaseI).toEqual({ mz: true });
    expect(refined.members?.[0].releaseJ).toBeUndefined();
    expect(refined.members?.[2].releaseJ).toEqual({ my: true });
    expect(refined.nodes[2].x).toBeCloseTo(1, 12);
    expect(refineModel3D(model, 1).members).toBe(model.members);
  });

  it('mode shape along a member follows the Hermite interpolation', () => {
    const el = lineElement(beam('m', 'a', 'b'), [0, 0, 0], [2, 0, 0], [], [0, 0, 0]);
    // Unit rotation θz at node j only: v(x) = L·(−t² + t³).
    const u = new Array(12).fill(0);
    u[11] = 1;
    const shape = lineShape(el, u, 4);
    expect(shape[2].v).toBeCloseTo(2 * (-0.25 + 0.125), 12);
    expect(shape[4].v).toBeCloseTo(0, 12);
  });

  it('rejects a massless model and reports an unstable one', () => {
    const fixed: Support3D = {
      node: 'A',
      ux: true,
      uy: true,
      uz: true,
      rx: true,
      ry: true,
      rz: true,
    };
    const massless = straightBeam([fixed]);
    massless.members = [beam('AB', 'A', 'B', { mass: undefined })];
    expect(() => modalAnalysis3d(massless)).toThrow(/no mass/);
    expect(() => modalAnalysis3d(straightBeam([{ node: 'A', ux: true }]))).toThrow(/unstable/);
    expect(() =>
      modalAnalysis3d(straightBeam([fixed], { masses: [{ node: 'X', mass: 1 }] })),
    ).toThrow(/missing node/);
    expect(() =>
      modalAnalysis3d(straightBeam([fixed], { masses: [{ node: 'B', mass: -1 }] })),
    ).toThrow(/invalid/);
  });
});

describe('modal analysis: plates and solids', () => {
  it('simply supported square plate: ω11 = π²·(2/a²)·√(D/ρt)', () => {
    // a = 2 m, t = 20 mm (a/t = 100), 16 × 16 mesh in the XZ plane, w = 0 on the edges.
    const a = 2;
    const t = 0.02;
    const n = 16;
    const Ep = 2e8;
    const nu = 0.3;
    const rho = 7.85;
    const id = (i: number, j: number) => `n${i}_${j}`;
    const nodes = [];
    const supports: Support3D[] = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        nodes.push({ id: id(i, j), x: (a * i) / n, y: 0, z: (a * j) / n });
        if (i === 0 || j === 0 || i === n || j === n) supports.push({ node: id(i, j), uy: true });
      }
    }
    // Hold the in-plane rigid-body motion.
    supports.push({ node: id(n / 2, n / 2), ux: true, uz: true });
    supports.push({ node: id(n, n / 2), uz: true });
    const plates = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        plates.push({
          id: `p${i}_${j}`,
          nodes: [id(i, j), id(i, j + 1), id(i + 1, j + 1), id(i + 1, j)] as [
            string,
            string,
            string,
            string,
          ],
          E: Ep,
          nu,
          t,
          mass: rho,
        });
      }
    }
    const r = modalAnalysis3d({ nodes, plates, supports, loads: [] }, 2);
    const D = (Ep * t ** 3) / (12 * (1 - nu * nu));
    const omega = Math.PI ** 2 * (2 / a ** 2) * Math.sqrt(D / (rho * t));
    expect(rel(r.modes[0].omega, omega)).toBeLessThan(0.01);
    expect(rel(r.totalMass, rho * t * a * a)).toBeLessThan(1e-12);
  });

  it('a plate mesh free to spin in its own plane is reported, not given a 0 Hz mode', () => {
    // 6 × 6 mesh in the XZ plane, w held on the edges, X held at two corners on the X axis:
    // nothing stops the slab spinning about Y in its own plane.
    const n = 6;
    const id = (i: number, j: number) => `n${i}_${j}`;
    const nodes: StructureModel3D['nodes'] = [];
    const supports: Support3D[] = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        nodes.push({ id: id(i, j), x: i, y: 0, z: j });
        if (i === 0 || j === 0 || i === n || j === n) supports.push({ node: id(i, j), uy: true });
      }
    }
    supports.push({ node: id(0, 0), ux: true, uz: true }, { node: id(n, 0), ux: true });
    const plates: NonNullable<StructureModel3D['plates']> = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        plates.push({
          id: `p${i}_${j}`,
          nodes: [id(i, j), id(i, j + 1), id(i + 1, j + 1), id(i + 1, j)] as [
            string,
            string,
            string,
            string,
          ],
          E: 3e7,
          nu: 0.2,
          t: 0.2,
          mass: 2.5,
        });
      }
    }
    expect(() => modalAnalysis3d({ nodes, plates, supports, loads: [] })).toThrow(
      /zero-frequency|unstable/,
    );
  });

  it('solid cantilever (ν = 0, L/h = 20): first bending and axial frequencies', () => {
    const Lc = 4;
    const h = 0.2;
    const nx = 20;
    const Es = 2e7;
    const rho = 2.5;
    const id = (i: number, j: number, k: number) => `n${i}_${j}_${k}`;
    const nodes = [];
    const supports: Support3D[] = [];
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= 2; j++) {
        for (let k = 0; k <= 2; k++) {
          nodes.push({ id: id(i, j, k), x: (Lc * i) / nx, y: (h * j) / 2, z: (h * k) / 2 });
          if (i === 0) supports.push({ node: id(i, j, k), ux: true, uy: true, uz: true });
        }
      }
    }
    const solids = [];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          solids.push({
            id: `s${i}_${j}_${k}`,
            nodes: [
              id(i, j, k),
              id(i + 1, j, k),
              id(i + 1, j + 1, k),
              id(i, j + 1, k),
              id(i, j, k + 1),
              id(i + 1, j, k + 1),
              id(i + 1, j + 1, k + 1),
              id(i, j + 1, k + 1),
            ] as [string, string, string, string, string, string, string, string],
            E: Es,
            nu: 0,
            mass: rho,
          });
        }
      }
    }
    const r = modalAnalysis3d({ nodes, solids, supports, loads: [] }, 12);
    const I = h ** 4 / 12;
    const bending = (1.8751 ** 2 / Lc ** 2) * Math.sqrt((Es * I) / (rho * h * h));
    // Square section: the first two modes are the bending pair (y and z).
    expect(rel(r.modes[0].omega, bending)).toBeLessThan(0.015);
    expect(rel(r.modes[1].omega, bending)).toBeLessThan(0.015);
    const axial = (Math.PI / (2 * Lc)) * Math.sqrt(Es / rho);
    expect(Math.min(...r.modes.map((m) => rel(m.omega, axial)))).toBeLessThan(0.005);
  });
});
