import { describe, expect, it } from 'vitest';
import { SolverError } from '../solver/errors';
import { matVec } from '../solver/linalg';
import { jacobiEigen } from '../solver/modal';
import { add, cross, dot, norm, normalize, scale, sub } from './math';
import type { PlateElement } from './plate';
import { plateAxes, plateElement, plateResult } from './plate';
import type { Plate3D, PlateLoad3D, PlateResult3D, PlateStress, Vec3 } from './types';

// ---------------------------------------------------------------------------------------
// Test helpers: meshes and a small assemble-and-solve driver
// ---------------------------------------------------------------------------------------

/** Component offsets of the six nodal DOFs. */
const UX = 0;
const UY = 1;
const UZ = 2;
const RX = 3;
const RY = 4;
const RZ = 5;

interface Mesh {
  nodes: Vec3[];
  quads: number[][];
}

interface Props {
  E: number;
  nu: number;
  t: number;
  density?: number;
}

interface Problem extends Mesh {
  props: Props;
  /** Element loads of quad `e`, whose plate id is `id`. */
  loads?: (e: number, id: string) => PlateLoad3D[];
  gravity?: Vec3;
  /** Prescribed displacements: global DOF index (6·node + component) → value. */
  fixed: Map<number, number>;
  /** Nodal loads: global DOF index → value. */
  nodal?: Map<number, number>;
}

interface Solution {
  /** Displacements, 6 per node. */
  u: number[];
  elements: PlateElement[];
  results: PlateResult3D[];
  /** K·u − f at every DOF: the reaction at prescribed DOFs, ~0 at free ones. */
  residual: number[];
}

const dof = (node: number, component: number): number => 6 * node + component;

/** Prescribes (by default: fixes) the listed components of a node. */
function fix(fixed: Map<number, number>, node: number, components: number[], value = 0): void {
  for (const c of components) fixed.set(dof(node, c), value);
}

/**
 * Structured mesh of nx × ny quads on the unit square (s, t) mapped to 3D by `map`.
 * Node (i, j) has index j·(nx + 1) + i; element (i, j) has index j·nx + i and its first node
 * is node (i, j).
 */
function gridMesh(nx: number, ny: number, map: (s: number, t: number) => Vec3): Mesh {
  const nodes: Vec3[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) nodes.push(map(i / nx, j / ny));
  const quads: number[][] = [];
  const at = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++)
      quads.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  }
  return { nodes, quads };
}

/**
 * The MacNeal–Harder patch: a 0.24 × 0.12 rectangle in the XY plane divided into five
 * distorted quadrilaterals by four interior nodes (nodes 4–7); nodes 0–3 are the corners.
 */
function patchMesh(): Mesh {
  return {
    nodes: [
      [0, 0, 0],
      [0.24, 0, 0],
      [0.24, 0.12, 0],
      [0, 0.12, 0],
      [0.04, 0.02, 0],
      [0.18, 0.03, 0],
      [0.16, 0.08, 0],
      [0.08, 0.08, 0],
    ],
    quads: [
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 0, 4, 7],
    ],
  };
}

/** Rotation matrix about `axis` by `angle` (Rodrigues' formula). */
function rotation(axis: Vec3, angle: number): Vec3[] {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const v = 1 - c;
  return [
    [c + x * x * v, x * y * v - z * s, x * z * v + y * s],
    [y * x * v + z * s, c + y * y * v, y * z * v - x * s],
    [z * x * v - y * s, z * y * v + x * s, c + z * z * v],
  ];
}

const rotate = (R: Vec3[], a: Vec3): Vec3 => [dot(R[0], a), dot(R[1], a), dot(R[2], a)];

/**
 * Solves a banded symmetric positive-definite system by Cholesky factorisation.
 * `band[i][bw − (i − j)]` holds A[i][j] for i − bw <= j <= i.
 */
function solveBanded(band: Float64Array[], bw: number, rhs: number[]): number[] {
  const n = band.length;
  for (let i = 0; i < n; i++) {
    const row = band[i];
    for (let j = Math.max(0, i - bw); j <= i; j++) {
      let s = row[bw - (i - j)];
      const other = band[j];
      for (let k = Math.max(0, i - bw); k < j; k++) s -= row[bw - (i - k)] * other[bw - (j - k)];
      if (j < i) {
        row[bw - (i - j)] = s / other[bw];
      } else {
        if (!(s > 0)) throw new Error(`Stiffness matrix is not positive definite at equation ${i}`);
        row[bw] = Math.sqrt(s);
      }
    }
  }
  const x = rhs.slice();
  for (let i = 0; i < n; i++) {
    let s = x[i];
    for (let k = Math.max(0, i - bw); k < i; k++) s -= band[i][bw - (i - k)] * x[k];
    x[i] = s / band[i][bw];
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) s -= band[k][bw - (k - i)] * x[k];
    x[i] = s / band[i][bw];
  }
  return x;
}

/** Builds every plate with `plateElement`, assembles, solves and recovers the results. */
function solve(problem: Problem): Solution {
  const { nodes, quads, props, fixed } = problem;
  const gravity = problem.gravity ?? [0, 0, 0];
  const elements = quads.map((quad, e) => {
    const id = `p${e}`;
    const plate: Plate3D = {
      id,
      nodes: quad.map((n) => `n${n}`) as Plate3D['nodes'],
      ...props,
    };
    const coords = quad.map((n) => nodes[n]);
    return plateElement(plate, coords, problem.loads?.(e, id) ?? [], gravity);
  });

  const total = 6 * nodes.length;
  const equation = new Array<number>(total).fill(-1);
  let n = 0;
  for (let d = 0; d < total; d++) if (!fixed.has(d)) equation[d] = n++;
  const u = new Array<number>(total).fill(0);
  for (const [d, value] of fixed) u[d] = value;

  const elementDofs = quads.map((quad) =>
    quad.flatMap((node) => [0, 1, 2, 3, 4, 5].map((c) => dof(node, c))),
  );
  let bw = 0;
  for (const dofs of elementDofs) {
    const eqs = dofs.map((d) => equation[d]).filter((q) => q >= 0);
    if (eqs.length > 0) bw = Math.max(bw, Math.max(...eqs) - Math.min(...eqs));
  }
  const band = Array.from({ length: n }, () => new Float64Array(bw + 1));
  const rhs = new Array<number>(n).fill(0);
  for (const [d, value] of problem.nodal ?? []) {
    if (equation[d] >= 0) rhs[equation[d]] += value;
  }
  elements.forEach((el, e) => {
    const dofs = elementDofs[e];
    for (let i = 0; i < 24; i++) {
      const p = equation[dofs[i]];
      if (p < 0) continue;
      rhs[p] += el.f[i];
      for (let j = 0; j < 24; j++) {
        const q = equation[dofs[j]];
        if (q < 0) rhs[p] -= el.k[i][j] * u[dofs[j]];
        else if (q <= p) band[p][bw - (p - q)] += el.k[i][j];
      }
    }
  });
  const x = solveBanded(band, bw, rhs);
  for (let d = 0; d < total; d++) if (equation[d] >= 0) u[d] = x[equation[d]];

  const residual = new Array<number>(total).fill(0);
  for (const [d, value] of problem.nodal ?? []) residual[d] -= value;
  const results = elements.map((el, e) => {
    const ue = elementDofs[e].map((d) => u[d]);
    const ke = matVec(el.k, ue);
    elementDofs[e].forEach((d, i) => (residual[d] += ke[i] - el.f[i]));
    return plateResult(el, ue);
  });
  return { u, elements, results, residual };
}

/**
 * Components [T11, T22, T12] along the unit vectors e1, e2 of the symmetric in-plane tensor
 * given by [Txx, Tyy, Txy] in a plate's local axes.
 */
function tensorAlong(
  axes: PlateResult3D['axes'],
  [txx, tyy, txy]: [number, number, number],
  e1: Vec3,
  e2: Vec3,
): [number, number, number] {
  const p = [dot(e1, axes.x), dot(e1, axes.y)];
  const q = [dot(e2, axes.x), dot(e2, axes.y)];
  const T = (a: number[], b: number[]) =>
    txx * a[0] * b[0] + tyy * a[1] * b[1] + txy * (a[0] * b[1] + a[1] * b[0]);
  return [T(p, p), T(q, q), T(p, q)];
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

const membraneOf = (s: PlateStress): [number, number, number] => [s.Nx, s.Ny, s.Nxy];
const momentsOf = (s: PlateStress): [number, number, number] => [s.Mx, s.My, s.Mxy];

/** The centre and the four corner states of a plate result. */
const statesOf = (r: PlateResult3D): PlateStress[] => [r.center, ...r.corners];

const steel: Props = { E: 210e6, nu: 0.3, t: 0.1 };

function singlePlate(extra: Partial<Plate3D> = {}): Plate3D {
  return { id: 'P1', nodes: ['a', 'b', 'c', 'd'], ...steel, ...extra };
}

const SQUARE: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
];

const DISTORTED: Vec3[] = [
  [0, 0, 0],
  [1.3, 0.1, 0],
  [0.9, 1.1, 0],
  [-0.2, 0.7, 0],
];

const TILT = rotation([1, 2, 3], 0.7);
const SHIFT: Vec3 = [3, -2, 5];
const TILTED: Vec3[] = DISTORTED.map((c) => add(rotate(TILT, c), SHIFT));

/** Expects two vectors to agree to rounding (and treats −0 as 0). */
function expectVec(actual: number[], expected: Vec3, tolerance = 1e-12): void {
  expect(actual).toHaveLength(3);
  expect(norm(sub(actual as Vec3, expected))).toBeLessThan(tolerance);
}

/** Expects `run` to throw a SolverError INVALID_MODEL that names the plate. */
function expectInvalid(run: () => unknown, id: string | undefined, pattern: RegExp): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SolverError);
  const error = caught as SolverError;
  expect(error.code).toBe('INVALID_MODEL');
  expect(error.memberId).toBe(id);
  expect(error.message).toMatch(pattern);
}

// ---------------------------------------------------------------------------------------
// Local axes
// ---------------------------------------------------------------------------------------

describe('plateAxes', () => {
  it('follows the Plate3D convention for a rectangle in the XY plane', () => {
    const axes = plateAxes([
      [1, 1, 0],
      [5, 1, 0],
      [5, 3, 0],
      [1, 3, 0],
    ]);
    expectVec(axes.x, [1, 0, 0]);
    expectVec(axes.y, [0, 1, 0]);
    expectVec(axes.z, [0, 0, 1]);
    expectVec(axes.origin, [3, 2, 0]);
    const corners = [
      [-2, -1],
      [2, -1],
      [2, 1],
      [-2, 1],
    ];
    axes.local.forEach((p, i) => expectVec([...p, 0], [...corners[i], 0] as Vec3));
    expect(axes.area).toBeCloseTo(8, 12);
    expect(axes.warp).toBe(0);
  });

  it('reverses the normal when the nodes are listed the other way round', () => {
    const axes = plateAxes([SQUARE[0], SQUARE[3], SQUARE[2], SQUARE[1]]);
    expectVec(axes.z, [0, 0, -1]);
    // x runs from the midpoint of edge 4–1 (now on the X axis) to that of edge 2–3.
    expectVec(axes.x, [0, 1, 0]);
    expectVec(axes.y, [1, 0, 0]);
  });

  it('gives a right-handed orthonormal triad for a distorted, tilted quadrilateral', () => {
    const { x, y, z, origin, local, area } = plateAxes(TILTED);
    expect(norm(x)).toBeCloseTo(1, 12);
    expect(norm(y)).toBeCloseTo(1, 12);
    expect(norm(z)).toBeCloseTo(1, 12);
    expect(dot(x, y)).toBeCloseTo(0, 12);
    expect(dot(x, z)).toBeCloseTo(0, 12);
    expect(norm(sub(cross(x, y), z))).toBeLessThan(1e-12);
    // z = (n3 − n1) × (n4 − n2), normalised
    const zExpected = normalize(cross(sub(TILTED[2], TILTED[0]), sub(TILTED[3], TILTED[1])));
    expect(norm(sub(z, zExpected))).toBeLessThan(1e-12);
    // x along midpoint(4–1) → midpoint(2–3)
    const across = sub(
      scale(add(TILTED[1], TILTED[2]), 0.5),
      scale(add(TILTED[3], TILTED[0]), 0.5),
    );
    expect(norm(sub(x, normalize(across)))).toBeLessThan(1e-12);
    // the local coordinates reproduce the nodes
    local.forEach(([lx, ly], i) => {
      const back = add(origin, add(scale(x, lx), scale(y, ly)));
      expect(norm(sub(back, TILTED[i]))).toBeLessThan(1e-12);
    });
    // shoelace area of the original planar quadrilateral
    let shoelace = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = DISTORTED[i];
      const [x2, y2] = DISTORTED[(i + 1) % 4];
      shoelace += (x1 * y2 - x2 * y1) / 2;
    }
    expect(area).toBeCloseTo(shoelace, 12);
  });

  it('reports the warp of a deliberately warped quadrilateral', () => {
    const h = 0.05;
    // Unit square (scaled by 2) with the corners alternately ±h out of plane.
    const warped: Vec3[] = [
      [0, 0, h],
      [2, 0, -h],
      [2, 2, h],
      [0, 2, -h],
    ];
    const axes = plateAxes(warped);
    expectVec(axes.z, [0, 0, 1]);
    expect(axes.area).toBeCloseTo(4, 12);
    // every node is h from the mean plane and √area = 2
    expect(axes.warp).toBeCloseTo(h / 2, 12);
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    axes.local.forEach((p, i) => expectVec([...p, 0], [...corners[i], 0] as Vec3));
    // the element is built on the projection and says so
    const el = plateElement(singlePlate(), warped, [], [0, 0, 0]);
    expect(el.warp).toBeCloseTo(h / 2, 12);
    expect(el.warnings).toHaveLength(1);
    expect(el.warnings[0]).toMatch(/P1.*warped.*2\.5 %/);
    expect(plateElement(singlePlate(), SQUARE, [], [0, 0, 0]).warnings).toEqual([]);
  });

  it('rejects points that do not define a plane', () => {
    expectInvalid(() => plateAxes(SQUARE.slice(0, 3)), undefined, /four node positions/);
    expectInvalid(
      () =>
        plateAxes([
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
          [3, 0, 0],
        ]),
      undefined,
      /zero area/,
    );
  });
});

// ---------------------------------------------------------------------------------------
// 1. Element matrix
// ---------------------------------------------------------------------------------------

describe('plate element stiffness matrix', () => {
  const cases: Array<[string, Vec3[]]> = [
    ['unit square', SQUARE],
    ['distorted quadrilateral', DISTORTED],
    ['rotated and translated quadrilateral', TILTED],
  ];

  for (const [name, coords] of cases) {
    it(`${name}: symmetric with exactly 6 zero and 18 positive eigenvalues`, () => {
      const el = plateElement(singlePlate(), coords, [], [0, 0, 0]);
      expect(el.dofsPerNode).toBe(6);
      expect(el.nodes).toEqual(['a', 'b', 'c', 'd']);
      expect(el.k).toHaveLength(24);
      expect(el.f).toEqual(new Array(24).fill(0));
      let largest = 0;
      for (const row of el.k) for (const v of row) largest = Math.max(largest, Math.abs(v));
      for (let i = 0; i < 24; i++) {
        expect(el.k[i]).toHaveLength(24);
        for (let j = 0; j < i; j++) {
          expect(Math.abs(el.k[i][j] - el.k[j][i])).toBeLessThanOrEqual(1e-13 * largest);
        }
      }
      const { values } = jacobiEigen(el.k);
      const top = values[23];
      const zero = values.filter((v) => Math.abs(v) < 1e-10 * top);
      const positive = values.filter((v) => v > 1e-7 * top);
      expect(zero).toHaveLength(6);
      expect(positive).toHaveLength(18);
    });

    it(`${name}: rigid-body motions produce no forces`, () => {
      const el = plateElement(singlePlate(), coords, [], [0, 0, 0]);
      let largest = 0;
      for (const row of el.k) for (const v of row) largest = Math.max(largest, Math.abs(v));
      const motions: Array<{ a: Vec3; w: Vec3 }> = [
        { a: [1, 0, 0], w: [0, 0, 0] },
        { a: [0, 1, 0], w: [0, 0, 0] },
        { a: [0, 0, 1], w: [0, 0, 0] },
        { a: [0, 0, 0], w: [1, 0, 0] },
        { a: [0, 0, 0], w: [0, 1, 0] },
        { a: [0, 0, 0], w: [0, 0, 1] },
        { a: [0.3, -0.2, 0.5], w: [0.4, 0.1, -0.7] },
      ];
      for (const { a, w } of motions) {
        // small rigid motion: u = a + w × r, nodal rotation = w
        const u = coords.flatMap((r) => [...add(a, cross(w, r)), ...w]);
        const forces = matVec(el.k, u);
        const size = Math.max(...u.map(Math.abs));
        for (const force of forces) expect(Math.abs(force)).toBeLessThan(1e-10 * largest * size);
      }
    });
  }

  it('does not depend on where the element is or how it is oriented (same eigenvalues)', () => {
    const flat = jacobiEigen(plateElement(singlePlate(), DISTORTED, [], [0, 0, 0]).k).values;
    const tilted = jacobiEigen(plateElement(singlePlate(), TILTED, [], [0, 0, 0]).k).values;
    for (let i = 6; i < 24; i++) expect(tilted[i] / flat[i]).toBeCloseTo(1, 9);
  });

  it('membrane, bending and drilling parts are uncoupled in a plate lying in the XY plane', () => {
    const { k } = plateElement(singlePlate(), DISTORTED, [], [0, 0, 0]);
    const inPlane = [UX, UY, RZ];
    const outOfPlane = [UZ, RX, RY];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        for (const a of inPlane)
          for (const b of outOfPlane) expect(k[dof(i, a)][dof(j, b)]).toBe(0);
      }
    }
  });

  it('the drilling stiffness is a small penalty: γ·G·t·∫(θz − ω)² dA', () => {
    // Uniform drilling rotation θ of all four nodes with no displacements: θz − ω = θ
    // everywhere, so the energy is ½·(γ·G·t·A)·θ².
    const { k, area } = plateElement(singlePlate(), DISTORTED, [], [0, 0, 0]);
    const u = new Array<number>(24).fill(0);
    for (let i = 0; i < 4; i++) u[dof(i, RZ)] = 1;
    const energy = 0.5 * dot3n(u, matVec(k, u));
    const G = steel.E / (2 * (1 + steel.nu));
    expect(energy).toBeCloseTo(0.5 * 1e-3 * G * steel.t * area, 6);
  });
});

/** Dot product of two equally long vectors. */
function dot3n(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}

// ---------------------------------------------------------------------------------------
// 2. Orientation invariance
// ---------------------------------------------------------------------------------------

describe('orientation invariance', () => {
  /** A 3 × 2 cantilevered plate of distorted quads, clamped along its first edge. */
  function cantilever(R: Vec3[] | null, shift: Vec3): Solution {
    const place = (c: Vec3): Vec3 => (R ? add(rotate(R, c), shift) : c);
    const turn = (c: Vec3): Vec3 => (R ? rotate(R, c) : c);
    const mesh = gridMesh(3, 2, (s, t) => {
      const interior = s > 0 && s < 1 && t > 0 && t < 1;
      // move the interior nodes off the regular grid
      const dx = interior ? 0.11 * (s < 0.5 ? 1 : -1) : 0;
      const dy = interior ? 0.07 : 0;
      return place([1.5 * s + dx, t + dy + 0.1 * s * (1 - t), 0]);
    });
    const fixed = new Map<number, number>();
    for (const node of [0, 4, 8]) fix(fixed, node, [UX, UY, UZ, RX, RY, RZ]);
    const nodal = new Map<number, number>();
    const tipForce = turn([5, -4, 1.5]);
    const tipMoment = turn([0.2, -0.3, 0.1]);
    for (let c = 0; c < 3; c++) {
      nodal.set(dof(11, c), tipForce[c]);
      nodal.set(dof(7, 3 + c), tipMoment[c]);
    }
    return solve({
      ...mesh,
      props: { E: 30e6, nu: 0.25, t: 0.08, density: 25 },
      gravity: turn([0.3, 0.2, -1]),
      loads: (e, id) => [
        { kind: 'pressure', plate: id, direction: 'localZ', p: -3 },
        ...(e === 4
          ? [
              {
                kind: 'platePoint' as const,
                plate: id,
                direction: 'localZ' as const,
                P: 2,
                xi: 0.3,
                eta: -0.4,
              },
            ]
          : []),
      ],
      fixed,
      nodal,
    });
  }

  const flat = cantilever(null, [0, 0, 0]);
  const R = rotation([2, -1, 3], 1.1);
  const tilted = cantilever(R, [4, 7, -2]);

  it('gives the same displacements, rotated with the model', () => {
    const size = Math.max(...flat.u.map(Math.abs));
    expect(size).toBeGreaterThan(0);
    for (let node = 0; node < 12; node++) {
      for (const offset of [0, 3]) {
        const before = flat.u.slice(dof(node, offset), dof(node, offset) + 3) as Vec3;
        const after = tilted.u.slice(dof(node, offset), dof(node, offset) + 3) as Vec3;
        expect(norm(sub(rotate(R, before), after))).toBeLessThan(1e-8 * size);
      }
    }
    // both in-plane and out-of-plane action are present in the flat model
    expect(Math.abs(flat.u[dof(11, UX)])).toBeGreaterThan(0);
    expect(Math.abs(flat.u[dof(11, UZ)])).toBeGreaterThan(0);
  });

  it('gives identical local stress resultants and local axes that follow the model', () => {
    const keys = ['Nx', 'Ny', 'Nxy', 'Mx', 'My', 'Mxy', 'Qx', 'Qy'] as const;
    const scaleOf = (key: (typeof keys)[number]) =>
      Math.max(...flat.results.flatMap((r) => statesOf(r).map((s) => Math.abs(s[key]))));
    for (const key of keys) {
      const size = scaleOf(key);
      expect(size).toBeGreaterThan(0);
      flat.results.forEach((r, e) => {
        const other = statesOf(tilted.results[e]);
        statesOf(r).forEach((s, k) => {
          expect(Math.abs(s[key] - other[k][key])).toBeLessThan(1e-7 * size);
        });
      });
    }
    flat.results.forEach((r, e) => {
      const other = tilted.results[e];
      expect(norm(sub(rotate(R, r.axes.x), other.axes.x))).toBeLessThan(1e-12);
      expect(norm(sub(rotate(R, r.axes.y), other.axes.y))).toBeLessThan(1e-12);
      expect(norm(sub(rotate(R, r.axes.z), other.axes.z))).toBeLessThan(1e-12);
      expect(other.area).toBeCloseTo(r.area, 12);
      expect(other.maxVonMises / r.maxVonMises).toBeCloseTo(1, 7);
      expect(other.id).toBe(r.id);
    });
  });

  it('is in equilibrium: reactions balance the applied loads', () => {
    for (const sol of [flat, tilted]) {
      const applied: Vec3 = [0, 0, 0];
      for (const el of sol.elements) {
        for (let i = 0; i < 4; i++) for (let c = 0; c < 3; c++) applied[c] += el.f[6 * i + c];
      }
      const tip = sol === flat ? [5, -4, 1.5] : rotate(R, [5, -4, 1.5]);
      for (let c = 0; c < 3; c++) {
        let reaction = 0;
        for (const node of [0, 4, 8]) reaction += sol.residual[dof(node, c)];
        expect(reaction + applied[c] + tip[c]).toBeCloseTo(0, 8);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
// 3. Membrane patch test
// ---------------------------------------------------------------------------------------

describe('membrane patch test (distorted mesh)', () => {
  const props: Props = { E: 1e6, nu: 0.25, t: 0.001 };
  // Linear displacement field u = ax·x + ay·y, v = bx·x + by·y (with a rigid rotation part).
  const [ax, ay, bx, by] = [1e-3, 0.2e-3, 0.9e-3, 0.5e-3];
  const mesh = patchMesh();
  const fixed = new Map<number, number>();
  mesh.nodes.forEach(([x, y], node) => {
    fix(fixed, node, [UZ, RX, RY]);
    if (node < 4) {
      fixed.set(dof(node, UX), ax * x + ay * y);
      fixed.set(dof(node, UY), bx * x + by * y);
    }
  });
  const sol = solve({ ...mesh, props, fixed });

  const ex = ax;
  const ey = by;
  const gxy = ay + bx;
  const c = (props.E * props.t) / (1 - props.nu ** 2);
  const expected = [
    c * (ex + props.nu * ey),
    c * (ey + props.nu * ex),
    (c * (1 - props.nu) * gxy) / 2,
  ];

  it('reproduces the linear displacement field at the interior nodes', () => {
    const size = 1e-3 * 0.24;
    for (let node = 4; node < 8; node++) {
      const [x, y] = mesh.nodes[node];
      expect(Math.abs(sol.u[dof(node, UX)] - (ax * x + ay * y))).toBeLessThan(1e-9 * size);
      expect(Math.abs(sol.u[dof(node, UY)] - (bx * x + by * y))).toBeLessThan(1e-9 * size);
    }
  });

  it('drilling rotations follow the continuum rotation ½(∂v/∂x − ∂u/∂y) at every node', () => {
    const omega = (bx - ay) / 2;
    for (let node = 0; node < 8; node++) {
      expect(Math.abs(sol.u[dof(node, RZ)] - omega)).toBeLessThan(1e-9 * Math.abs(omega));
    }
  });

  it('gives the exact constant membrane forces at every centre and corner', () => {
    for (const r of sol.results) {
      for (const state of statesOf(r)) {
        const N = tensorAlong(r.axes, membraneOf(state), X, Y);
        for (let k = 0; k < 3; k++) {
          expect(Math.abs(N[k] - expected[k])).toBeLessThan(1e-9 * Math.abs(expected[0]));
        }
        // no bending: both surfaces carry N / t
        for (const value of [...momentsOf(state), state.Qx, state.Qy]) expect(value).toBe(0);
        expect(state.top).toEqual(state.bottom);
        const S = tensorAlong(r.axes, [state.top.sx, state.top.sy, state.top.txy], X, Y);
        for (let k = 0; k < 3; k++) {
          expect(Math.abs(S[k] - expected[k] / props.t)).toBeLessThan(
            1e-9 * (expected[0] / props.t),
          );
        }
      }
    }
  });

  it('reports principal and von Mises stresses of that state', () => {
    const [sx, sy, txy] = expected.map((v) => v / props.t);
    const mean = (sx + sy) / 2;
    const radius = Math.hypot((sx - sy) / 2, txy);
    const mises = Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * txy * txy);
    for (const r of sol.results) {
      for (const state of statesOf(r)) {
        expect(state.top.s1 / (mean + radius)).toBeCloseTo(1, 9);
        expect(state.top.s2 / (mean - radius)).toBeCloseTo(1, 9);
        expect(state.bottom.vonMises / mises).toBeCloseTo(1, 9);
      }
      expect(r.maxVonMises / mises).toBeCloseTo(1, 9);
    }
  });
});

// ---------------------------------------------------------------------------------------
// 4. Bending patch test
// ---------------------------------------------------------------------------------------

describe('bending patch test (distorted mesh)', () => {
  const props: Props = { E: 1e6, nu: 0.25, t: 0.001 };
  // w = (a·x² + b·x·y + c·y²)/2 with Kirchhoff rotations θx = ∂w/∂y, θy = −∂w/∂x.
  const [a, b, c] = [1e-3, 0.6e-3, -0.4e-3];
  const w = (x: number, y: number) => (a * x * x + b * x * y + c * y * y) / 2;
  const thetaX = (x: number, y: number) => (b * x) / 2 + c * y;
  const thetaY = (x: number, y: number) => -(a * x + (b * y) / 2);
  const mesh = patchMesh();
  const fixed = new Map<number, number>();
  mesh.nodes.forEach(([x, y], node) => {
    fix(fixed, node, [UX, UY, RZ]);
    if (node < 4) {
      fixed.set(dof(node, UZ), w(x, y));
      fixed.set(dof(node, RX), thetaX(x, y));
      fixed.set(dof(node, RY), thetaY(x, y));
    }
  });
  const sol = solve({ ...mesh, props, fixed });

  // κx = −w,xx, κy = −w,yy, κxy = −2·w,xy and M = D·[κx + ν·κy, κy + ν·κx, (1 − ν)/2·κxy]
  const D = (props.E * props.t ** 3) / (12 * (1 - props.nu ** 2));
  const expected = [
    -D * (a + props.nu * c),
    -D * (c + props.nu * a),
    (-D * (1 - props.nu) * b) / 2,
  ];

  it('reproduces the quadratic deflection and linear rotations at the interior nodes', () => {
    for (let node = 4; node < 8; node++) {
      const [x, y] = mesh.nodes[node];
      expect(Math.abs(sol.u[dof(node, UZ)] - w(x, y))).toBeLessThan(1e-9 * w(0.24, 0.12));
      expect(Math.abs(sol.u[dof(node, RX)] - thetaX(x, y))).toBeLessThan(1e-9 * 1e-4);
      expect(Math.abs(sol.u[dof(node, RY)] - thetaY(x, y))).toBeLessThan(1e-9 * 1e-4);
    }
  });

  it('gives the exact constant moments at every element centre and corner, without shear', () => {
    const size = Math.abs(expected[0]);
    for (const r of sol.results) {
      for (const state of statesOf(r)) {
        const M = tensorAlong(r.axes, momentsOf(state), X, Y);
        for (let k = 0; k < 3; k++) expect(Math.abs(M[k] - expected[k])).toBeLessThan(1e-9 * size);
        // transverse shear forces vanish (compared with M / element size)
        expect(Math.abs(state.Qx)).toBeLessThan(1e-6 * (size / 0.05));
        expect(Math.abs(state.Qy)).toBeLessThan(1e-6 * (size / 0.05));
        for (const value of membraneOf(state)) expect(value).toBe(0);
        // surface stresses ±6·M/t²: opposite on the two faces
        expect(state.top.sx).toBeCloseTo(-state.bottom.sx, 12);
        const S = tensorAlong(r.axes, [state.top.sx, state.top.sy, state.top.txy], X, Y);
        for (let k = 0; k < 3; k++) {
          const stress = (6 * expected[k]) / props.t ** 2;
          expect(Math.abs(S[k] - stress)).toBeLessThan((1e-9 * 6 * size) / props.t ** 2);
        }
      }
    }
  });

  it('matches the MacNeal–Harder reference values for their curvature field', () => {
    // w = 1e-3·(x² + x·y + y²)/2: Mx = My = −1.111e-7, Mxy = −3.333e-8
    const field = (x: number, y: number) => 1e-3 * 0.5 * (x * x + x * y + y * y);
    const bc = new Map<number, number>();
    mesh.nodes.forEach(([x, y], node) => {
      fix(bc, node, [UX, UY, RZ]);
      if (node < 4) {
        bc.set(dof(node, UZ), field(x, y));
        bc.set(dof(node, RX), 1e-3 * (x / 2 + y));
        bc.set(dof(node, RY), -1e-3 * (x + y / 2));
      }
    });
    const result = solve({ ...mesh, props, fixed: bc });
    for (const r of result.results) {
      const M = tensorAlong(r.axes, momentsOf(r.center), X, Y);
      expect(M[0] / -1.1111111e-7).toBeCloseTo(1, 6);
      expect(M[1] / -1.1111111e-7).toBeCloseTo(1, 6);
      expect(M[2] / -3.3333333e-8).toBeCloseTo(1, 6);
    }
  });
});

// ---------------------------------------------------------------------------------------
// 5. In-plane bending of a slender cantilever (incompatible modes)
// ---------------------------------------------------------------------------------------

describe('in-plane bending of a slender cantilever', () => {
  const L = 10;
  const h = 1;
  const props: Props = { E: 30e6, nu: 0.3, t: 0.1 };
  const P = 100;
  const I = (props.t * h ** 3) / 12;
  const G = props.E / (2 * (1 + props.nu));
  // Timoshenko beam: bending + shear (κ = 5/6 for a rectangular section)
  const beamTheory = (P * L ** 3) / (3 * props.E * I) + (P * L) / ((5 / 6) * G * props.t * h);

  function run(nx: number, skew: number): Solution {
    const mesh = gridMesh(nx, 1, (s, t) => {
      const i = Math.round(s * nx);
      // shift the interior top nodes alternately left and right: trapezoidal elements
      const dx = t > 0.5 && i > 0 && i < nx ? (i % 2 === 1 ? skew : -skew) : 0;
      return [L * s + dx, h * t, 0];
    });
    const fixed = new Map<number, number>();
    mesh.nodes.forEach((_, node) => fix(fixed, node, [UZ, RX, RY]));
    for (const node of [0, nx + 1]) fix(fixed, node, [UX, UY]);
    // end shear P shared by the two tip nodes
    const nodal = new Map<number, number>([
      [dof(nx, UY), P / 2],
      [dof(2 * nx + 1, UY), P / 2],
    ]);
    return solve({ ...mesh, props, fixed, nodal });
  }

  it('rectangular elements: tip deflection within 2 % of beam theory', () => {
    for (const nx of [5, 10]) {
      const sol = run(nx, 0);
      const tip = (sol.u[dof(nx, UY)] + sol.u[dof(2 * nx + 1, UY)]) / 2;
      expect(Math.abs(tip / beamTheory - 1)).toBeLessThan(0.02);
    }
  });

  it('rectangular elements: bending stresses at the extreme fibres follow M·y/I', () => {
    const nx = 10;
    const sol = run(nx, 0);
    for (const e of [2, 5, 8]) {
      const r = sol.results[e];
      const xc = (e + 0.5) * (L / nx);
      // The tip load along +y bends the beam towards +y: the fibre at y = 0 is on the convex
      // side (tension), the fibre at y = h in compression. Within an element the bending
      // strain does not vary along x, so the corners carry the stress of the centre section.
      const sigma = (P * (L - xc) * (h / 2)) / I;
      // corners 1, 2 are at y = 0 and corners 3, 4 at y = h
      for (const k of [0, 1])
        expect(Math.abs(r.corners[k].Nx / (sigma * props.t) - 1)).toBeLessThan(0.02);
      for (const k of [2, 3])
        expect(Math.abs(r.corners[k].Nx / (-sigma * props.t) - 1)).toBeLessThan(0.02);
      expect(Math.abs(r.center.Nx)).toBeLessThan(1e-6 * sigma * props.t);
      // shear force resultant over the depth: ∫Nxy dy = P (parabolic distribution: the mean
      // of the four Gauss-point values, which is what the corner average returns)
      const mean = r.corners.reduce((sum, corner) => sum + corner.Nxy, 0) / 4;
      expect(Math.abs((mean * h) / P - 1)).toBeLessThan(0.02);
    }
  });

  it('trapezoidal elements: still close to beam theory (looser bound)', () => {
    // top nodes shifted by ±15 % of the element length
    const sol = run(10, 0.15);
    const tip = (sol.u[dof(10, UY)] + sol.u[dof(21, UY)]) / 2;
    // Incompatible-mode quadrilaterals lose some of their bending accuracy when they are
    // not parallelograms (no 4-node element can both pass the patch test and bend exactly
    // as a trapezoid — MacNeal's theorem), so the bound is looser: 5 %.
    expect(tip).toBeLessThan(beamTheory);
    expect(Math.abs(tip / beamTheory - 1)).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------------------
// 6–7. Square plates in bending
// ---------------------------------------------------------------------------------------

/**
 * Navier double-series solution of the simply supported square Kirchhoff plate under uniform
 * pressure: coefficients of the centre deflection (× q·a⁴/D) and centre moment (× q·a²).
 */
function navier(nu: number): { deflection: number; moment: number } {
  let deflection = 0;
  let moment = 0;
  for (let m = 1; m < 400; m += 2) {
    for (let n = 1; n < 400; n += 2) {
      const sign = ((m + n) / 2) % 2 === 1 ? 1 : -1;
      const denominator = m * n * (m * m + n * n) ** 2;
      deflection += sign / denominator;
      moment += (sign * (m * m + nu * n * n)) / denominator;
    }
  }
  return { deflection: (16 * deflection) / Math.PI ** 6, moment: (16 * moment) / Math.PI ** 4 };
}

interface SquarePlateCase {
  /** Elements per side of the quarter model. */
  n: number;
  /** Side length of the full plate. */
  a: number;
  t: number;
  edges: 'simple' | 'clamped';
  load: 'pressure' | 'point';
  /** Pressure (per unit area) or total point load, acting along −z. */
  value: number;
}

const PLATE_E = 10.92e6;
const PLATE_NU = 0.3;

/**
 * Quarter model of a square plate centred on the origin of the XY plane (x, y in [0, a/2]),
 * with symmetry conditions on x = 0 and y = 0. "Simple" supports are hard: w = 0 and no
 * rotation of the normal along the edge. Returns the centre deflection and centre moments.
 */
function squarePlate(c: SquarePlateCase): { w: number; Mx: number; My: number; sol: Solution } {
  const { n } = c;
  const half = c.a / 2;
  const mesh = gridMesh(n, n, (s, t) => [half * s, half * t, 0]);
  const fixed = new Map<number, number>();
  mesh.nodes.forEach(([x, y], node) => {
    fix(fixed, node, [UX, UY, RZ]);
    const onX0 = x === 0;
    const onY0 = y === 0;
    const onXa = Math.abs(x - half) < 1e-12;
    const onYa = Math.abs(y - half) < 1e-12;
    // symmetry: the normal does not tilt across the symmetry line
    if (onX0) fix(fixed, node, [RY]);
    if (onY0) fix(fixed, node, [RX]);
    if (onXa || onYa) fix(fixed, node, [UZ]);
    if (c.edges === 'clamped') {
      if (onXa || onYa) fix(fixed, node, [RX, RY]);
    } else {
      // hard simple support: rotation about the edge normal (slope along the edge) is zero
      if (onXa) fix(fixed, node, [RX]);
      if (onYa) fix(fixed, node, [RY]);
    }
  });
  const sol = solve({
    ...mesh,
    props: { E: PLATE_E, nu: PLATE_NU, t: c.t },
    fixed,
    loads: (e, id) => {
      if (c.load === 'pressure')
        return [{ kind: 'pressure', plate: id, direction: 'localZ', p: -c.value }];
      // a quarter of the point load, at node 1 of element 0 = the plate centre
      return e === 0
        ? [{ kind: 'platePoint', plate: id, direction: 'localZ', P: -c.value / 4, xi: -1, eta: -1 }]
        : [];
    },
  });
  const centre = sol.results[0].corners[0];
  return { w: sol.u[dof(0, UZ)], Mx: centre.Mx, My: centre.My, sol };
}

describe('square plate bending against thin-plate theory', () => {
  const a = 2;
  const q = 3;
  const rigidity = (t: number) => (PLATE_E * t ** 3) / (12 * (1 - PLATE_NU ** 2));

  it('the Navier series reproduces the tabulated coefficients 0.00406 and 0.0479', () => {
    const series = navier(0.3);
    expect(series.deflection).toBeCloseTo(0.00406, 5);
    expect(series.moment).toBeCloseTo(0.0479, 4);
  });

  it('simply supported, uniform pressure: converges to 0.00406·q·a⁴/D and 0.0479·q·a²', () => {
    const t = a / 100;
    const D = rigidity(t);
    const series = navier(PLATE_NU);
    const errors = [4, 8].map((n) => {
      const r = squarePlate({ n, a, t, edges: 'simple', load: 'pressure', value: q });
      // pressure along −z: the plate sags (w < 0) with tension at the bottom (M < 0)
      expect(r.w).toBeLessThan(0);
      expect(r.Mx).toBeLessThan(0);
      expect(r.My / r.Mx).toBeCloseTo(1, 9);
      return {
        w: Math.abs(-r.w / ((series.deflection * q * a ** 4) / D) - 1),
        m: Math.abs(-r.Mx / (series.moment * q * a * a) - 1),
      };
    });
    // 4 × 4 quarter mesh: within 1 %; 8 × 8: within 0.2 %, and better than the coarse mesh
    expect(errors[0].w).toBeLessThan(0.01);
    expect(errors[0].m).toBeLessThan(0.01);
    expect(errors[1].w).toBeLessThan(0.002);
    expect(errors[1].m).toBeLessThan(0.002);
    expect(errors[1].w).toBeLessThan(errors[0].w);
    expect(errors[1].m).toBeLessThan(errors[0].m);
  });

  it('clamped, uniform pressure: 0.00126·q·a⁴/D', () => {
    const t = a / 100;
    const D = rigidity(t);
    const r4 = squarePlate({ n: 4, a, t, edges: 'clamped', load: 'pressure', value: q });
    const r8 = squarePlate({ n: 8, a, t, edges: 'clamped', load: 'pressure', value: q });
    const reference = (0.00126 * q * a ** 4) / D;
    expect(Math.abs(-r4.w / reference - 1)).toBeLessThan(0.02);
    expect(Math.abs(-r8.w / reference - 1)).toBeLessThan(0.01);
    // centre moment 0.0231·q·a² (Timoshenko, table 35), sagging
    expect(r8.Mx).toBeLessThan(0);
    expect(Math.abs(-r8.Mx / (0.0231 * q * a * a) - 1)).toBeLessThan(0.02);
    // Middle of the clamped edge x = a/2: hogging, so the top (+z) surface is in tension
    // and Mx > 0; thin-plate theory gives 0.0513·q·a². Along x the element moment is
    // constant (it is the value of the element's centre section), so the edge value is
    // obtained by extrapolating the last two elements of the row y ≈ 0 to the edge.
    const edge = (r: ReturnType<typeof squarePlate>, n: number) => {
      const last = r.sol.results[n - 1].corners[1].Mx;
      const previous = r.sol.results[n - 2].corners[1].Mx;
      return 1.5 * last - 0.5 * previous;
    };
    const coefficients = [edge(r4, 4), edge(r8, 8)].map((m) => m / (q * a * a));
    expect(coefficients[1]).toBeGreaterThan(0);
    expect(Math.abs(coefficients[1] / 0.0513 - 1)).toBeLessThan(0.05);
    expect(Math.abs(coefficients[1] - 0.0513)).toBeLessThan(Math.abs(coefficients[0] - 0.0513));
    // no curvature along a clamped edge: My = ν·Mx there
    const atEdge = r8.sol.results[7].corners[1];
    expect(atEdge.Mx).toBeGreaterThan(0);
    expect(atEdge.My / atEdge.Mx).toBeCloseTo(PLATE_NU, 6);
  });

  it('simply supported, central point load: 0.01160·P·a²/D', () => {
    const t = a / 100;
    const D = rigidity(t);
    const P = 7;
    const r4 = squarePlate({ n: 4, a, t, edges: 'simple', load: 'point', value: P });
    const r8 = squarePlate({ n: 8, a, t, edges: 'simple', load: 'point', value: P });
    const reference = (0.0116 * P * a * a) / D;
    expect(Math.abs(-r4.w / reference - 1)).toBeLessThan(0.02);
    expect(Math.abs(-r8.w / reference - 1)).toBeLessThan(0.01);
  });

  it('no shear locking: a/t = 1000 is still within 1.5 % of thin-plate theory', () => {
    const t = a / 1000;
    const D = rigidity(t);
    const series = navier(PLATE_NU);
    const r = squarePlate({ n: 8, a, t, edges: 'simple', load: 'pressure', value: q });
    expect(Math.abs(-r.w / ((series.deflection * q * a ** 4) / D) - 1)).toBeLessThan(0.015);
    expect(Math.abs(-r.Mx / (series.moment * q * a * a) - 1)).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------------------------------
// 8. Cantilever plate strip: deflection, statics and signs
// ---------------------------------------------------------------------------------------

describe('cantilever plate strip (nu = 0)', () => {
  const L = 10;
  const b = 1;
  const n = 10;
  const h = L / n;
  const props: Props = { E: 30e6, nu: 0, t: 0.1 };
  const D = (props.E * props.t ** 3) / 12; // per unit width (nu = 0)
  const shearStiffness = ((5 / 6) * props.E * props.t) / 2; // κ·G·t with G = E/2

  /** Strip along X in the XY plane (local axes = global axes), clamped at x = 0. */
  function strip(loads: Problem['loads'], nodal?: Map<number, number>): Solution {
    const mesh = gridMesh(n, 1, (s, t) => [L * s, b * t, 0]);
    const fixed = new Map<number, number>();
    mesh.nodes.forEach((_, node) => fix(fixed, node, [UX, UY, RZ]));
    for (const node of [0, n + 1]) fix(fixed, node, [UZ, RX, RY]);
    return solve({ ...mesh, props, fixed, loads, nodal });
  }
  const tipNodes = [n, 2 * n + 1];
  const rootNodes = [0, n + 1];

  it('has local axes equal to the global axes', () => {
    const sol = strip(undefined, new Map([[dof(n, UZ), 1]]));
    for (const r of sol.results) {
      expectVec(r.axes.x, X);
      expectVec(r.axes.y, Y);
      expectVec(r.axes.z, Z);
    }
  });

  it('tip line load: deflection, exact statics and signs', () => {
    const P = 4; // force per unit width, acting along −z
    const sol = strip(undefined, new Map(tipNodes.map((node) => [dof(node, UZ), (-P * b) / 2])));
    const tip = sol.u[dof(n, UZ)];
    expect(sol.u[dof(2 * n + 1, UZ)]).toBeCloseTo(tip, 12);
    const beam = (P * L ** 3) / (3 * D) + (P * L) / shearStiffness;
    expect(tip).toBeLessThan(0);
    expect(Math.abs(-tip / beam - 1)).toBeLessThan(0.01);
    // The element is a linear Timoshenko element with constant (tied) shear along the strip:
    // nodal rotations are exact and the deflection integrates them by the trapezoidal rule,
    // which loses P·L·h²/(12·D), i.e. the bending part is PL³/3D · (1 − 1/(4n²)).
    const discrete = ((P * L ** 3) / (3 * D)) * (1 - 1 / (4 * n * n)) + (P * L) / shearStiffness;
    expect(-tip / discrete).toBeCloseTo(1, 8);

    // Reactions: vertical force +P·b; the load has moment +P·L·b about the global Y axis
    // through the root ((L, y, 0) × (0, 0, −F) = (−y·F, L·F, 0)), so the root reacts −P·L·b.
    const force = rootNodes.reduce((sum, node) => sum + sol.residual[dof(node, UZ)], 0);
    const moment = rootNodes.reduce((sum, node) => sum + sol.residual[dof(node, RY)], 0);
    expect(force).toBeCloseTo(P * b, 8);
    expect(moment).toBeCloseTo(-P * L * b, 7);

    sol.results.forEach((r, e) => {
      const xc = (e + 0.5) * h;
      // Hogging: the top (+z) surface is in tension, so Mx > 0; by statics |Mx| = P·(L − x).
      expect(r.center.Mx).toBeCloseTo(P * (L - xc), 7);
      expect(Math.abs(r.center.My)).toBeLessThan(1e-7);
      expect(Math.abs(r.center.Mxy)).toBeLessThan(1e-7);
      // The +x face of the part towards the root carries the load on the far side: Qx = −P.
      expect(r.center.Qx).toBeCloseTo(-P, 7);
      expect(Math.abs(r.center.Qy)).toBeLessThan(1e-7);
      for (const corner of r.corners) expect(corner.Qx).toBeCloseTo(-P, 7);
      // surface stresses: σ = ±6·M/t², tension on top
      const sigma = (6 * P * (L - xc)) / props.t ** 2;
      expect(r.center.top.sx / sigma).toBeCloseTo(1, 9);
      expect(r.center.bottom.sx / sigma).toBeCloseTo(-1, 9);
      expect(r.center.top.s1 / sigma).toBeCloseTo(1, 9);
      expect(r.center.bottom.s2 / sigma).toBeCloseTo(-1, 9);
      expect(r.center.top.vonMises / sigma).toBeCloseTo(1, 9);
    });
    // The corner values at the root section give the root moment P·L (within the element
    // the moment is constant along x, so the corner equals the centre value of element 1).
    expect(sol.results[0].corners[0].Mx).toBeCloseTo(P * (L - h / 2), 7);
    expect(sol.results[0].maxVonMises).toBeCloseTo((6 * P * (L - h / 2)) / props.t ** 2, 4);
  });

  it('upward tip load reverses every sign', () => {
    const P = 4;
    const sol = strip(undefined, new Map(tipNodes.map((node) => [dof(node, UZ), (P * b) / 2])));
    expect(sol.u[dof(n, UZ)]).toBeGreaterThan(0);
    const r = sol.results[0];
    expect(r.center.Mx).toBeLessThan(0);
    expect(r.center.Qx).toBeCloseTo(P, 7);
    expect(r.center.top.sx).toBeLessThan(0);
    expect(r.center.bottom.sx).toBeGreaterThan(0);
  });

  it('uniform pressure: deflection, exact statics and signs', () => {
    const q = 0.6; // pressure along −z
    const sol = strip((_, id) => [{ kind: 'pressure', plate: id, direction: 'localZ', p: -q }]);
    const tip = sol.u[dof(n, UZ)];
    const beam = (q * L ** 4) / (8 * D) + (q * L * L) / (2 * shearStiffness);
    expect(tip).toBeLessThan(0);
    expect(Math.abs(-tip / beam - 1)).toBeLessThan(0.01);

    const force = rootNodes.reduce((sum, node) => sum + sol.residual[dof(node, UZ)], 0);
    const moment = rootNodes.reduce((sum, node) => sum + sol.residual[dof(node, RY)], 0);
    expect(force).toBeCloseTo(q * L * b, 8);
    expect(moment).toBeCloseTo((-q * L * L * b) / 2, 7);

    sol.results.forEach((r, e) => {
      const xc = (e + 0.5) * h;
      // The consistent nodal loads are q·h per unit width at every interior station and
      // q·h/2 at the tip. Statics of those forces about the element centre gives
      //   M = q·(L − x)²/2 + q·h²/8   and   Q = −q·(L − x)   exactly.
      expect(r.center.Mx).toBeCloseTo((q * (L - xc) ** 2) / 2 + (q * h * h) / 8, 7);
      expect(r.center.Qx).toBeCloseTo(-q * (L - xc), 7);
      expect(r.center.top.sx).toBeGreaterThan(0);
      expect(r.center.bottom.sx).toBeLessThan(0);
      expect(Math.abs(r.center.My)).toBeLessThan(1e-7);
    });
  });
});

// ---------------------------------------------------------------------------------------
// 9. Twisting moment
// ---------------------------------------------------------------------------------------

describe('pure twist of a square plate (Mxy)', () => {
  const a = 2;
  const props: Props = { E: 2e6, nu: 0.3, t: 0.05 };
  const D = (props.E * props.t ** 3) / (12 * (1 - props.nu ** 2));

  /** n × n mesh of the square [0, a]² with the interior nodes moved off the regular grid. */
  function twistMesh(n: number, distort: number): Mesh {
    return gridMesh(n, n, (s, t) => {
      const interior = s > 0 && s < 1 && t > 0 && t < 1;
      const i = Math.round(s * n);
      const j = Math.round(t * n);
      const dx = interior ? distort * ((i + 2 * j) % 3 === 0 ? 1 : -0.6) : 0;
      const dy = interior ? distort * ((2 * i + j) % 3 === 1 ? 0.8 : -0.5) : 0;
      return [a * s + dx, a * t + dy, 0];
    });
  }

  /** In-plane DOFs fixed everywhere; w = 0 at three corners removes the rigid-body modes. */
  function supports(mesh: Mesh, n: number): Map<number, number> {
    const fixed = new Map<number, number>();
    mesh.nodes.forEach((_, node) => fix(fixed, node, [UX, UY, RZ]));
    for (const node of [0, n, n * (n + 1)]) fix(fixed, node, [UZ]);
    return fixed;
  }

  it('constant Mxy from consistent edge twisting moments is reproduced exactly', () => {
    // Derivation. Take Mxy = M0 everywhere and Mx = My = 0. The edge with outward normal n
    // carries the traction moment (per unit length, as a moment vector)
    //   m = ∫ z·e_z × (σ·n) dz = (M_xβ·n_β)·e_y − (M_yβ·n_β)·e_x = M0·(n_y·e_y − n_x·e_x),
    // i.e. a twisting moment about the edge normal: −M0·e_x on x = a, +M0·e_x on x = 0,
    // +M0·e_y on y = a and −M0·e_y on y = 0. With κxy = ∂θy/∂y − ∂θx/∂x = Mxy/(D(1 − ν)/2)
    // and no shear strain, the solution that vanishes at the three supported corners is
    //   w = c·x·y,  θx = ∂w/∂y = c·x,  θy = −∂w/∂x = −c·y,  c = −M0 / (D·(1 − ν)).
    // The field has constant curvature, so the element must reproduce it on any mesh.
    const n = 3;
    const M0 = 0.7;
    const mesh = twistMesh(n, 0.12);
    const nodal = new Map<number, number>();
    const addMoment = (node: number, component: number, value: number) =>
      nodal.set(dof(node, component), (nodal.get(dof(node, component)) ?? 0) + value);
    const at = (i: number, j: number) => j * (n + 1) + i;
    const half = a / n / 2; // half the length of one boundary segment
    for (let k = 0; k < n; k++) {
      for (const i of [k, k + 1]) {
        addMoment(at(i, 0), RY, -M0 * half); // y = 0
        addMoment(at(i, n), RY, M0 * half); // y = a
        addMoment(at(0, i), RX, M0 * half); // x = 0
        addMoment(at(n, i), RX, -M0 * half); // x = a
      }
    }
    const sol = solve({ ...mesh, props, fixed: supports(mesh, n), nodal });
    const c = -M0 / (D * (1 - props.nu));
    const size = Math.abs(c) * a * a;
    mesh.nodes.forEach(([x, y], node) => {
      expect(Math.abs(sol.u[dof(node, UZ)] - c * x * y)).toBeLessThan(1e-8 * size);
      expect(Math.abs(sol.u[dof(node, RX)] - c * x)).toBeLessThan(1e-8 * size);
      expect(Math.abs(sol.u[dof(node, RY)] + c * y)).toBeLessThan(1e-8 * size);
    });
    for (const r of sol.results) {
      for (const state of statesOf(r)) {
        const M = tensorAlong(r.axes, momentsOf(state), X, Y);
        expect(Math.abs(M[0])).toBeLessThan(1e-8 * M0);
        expect(Math.abs(M[1])).toBeLessThan(1e-8 * M0);
        expect(M[2] / M0).toBeCloseTo(1, 8);
        expect(Math.abs(state.Qx)).toBeLessThan(1e-6 * M0);
        expect(Math.abs(state.Qy)).toBeLessThan(1e-6 * M0);
        // pure shear on the surfaces: τ = 6·M0/t², principal stresses ±τ, von Mises √3·τ
        const tau = (6 * M0) / props.t ** 2;
        expect(state.top.s1 / tau).toBeCloseTo(1, 8);
        expect(state.top.s2 / tau).toBeCloseTo(-1, 8);
        expect(state.bottom.vonMises / (Math.sqrt(3) * tau)).toBeCloseTo(1, 8);
      }
    }
    // the three supports carry nothing
    for (const node of [0, n, n * (n + 1)]) {
      expect(Math.abs(sol.residual[dof(node, UZ)])).toBeLessThan(1e-8 * M0);
    }
  });

  it('corner load on a thin plate: w = P·a²/(2(1 − ν)·D) and Mxy = −P/2 (Kirchhoff)', () => {
    // In thin-plate theory the edge twisting moments above are statically equivalent to
    // corner forces R = 2·|Mxy|. A force P along +z at the corner (a, a), with the other
    // three corners held, therefore gives |Mxy| = P/2 and the corner deflection
    // c·a² = P·a²/(2(1 − ν)·D); w,xy > 0 there, so Mxy = −D(1 − ν)·w,xy = −P/2.
    const P = 0.3;
    const reference = (P * a * a) / (2 * (1 - props.nu) * D);
    for (const n of [1, 4, 8]) {
      const mesh = twistMesh(n, 0);
      const nodal = new Map([[dof((n + 1) * (n + 1) - 1, UZ), P]]);
      const sol = solve({ ...mesh, props: { ...props, t: 0.02 }, fixed: supports(mesh, n), nodal });
      const thin = reference * (props.t / 0.02) ** 3;
      expect(Math.abs(sol.u[dof((n + 1) * (n + 1) - 1, UZ)] / thin - 1)).toBeLessThan(0.005);
      // the middle of the plate is in pure twist; Mx and My are negligible there
      const mid = sol.results[Math.floor((n * n) / 2)].center;
      expect(Math.abs(mid.Mxy / (-P / 2) - 1)).toBeLessThan(0.005);
      expect(Math.abs(mid.Mx)).toBeLessThan(0.005 * P);
      expect(Math.abs(mid.My)).toBeLessThan(0.005 * P);
    }
  });
});

// ---------------------------------------------------------------------------------------
// 11. Scordelis–Lo barrel vault
// ---------------------------------------------------------------------------------------

describe('Scordelis–Lo roof (membrane–bending coupling in 3D)', () => {
  const R = 25;
  const length = 50;
  const halfAngle = (40 * Math.PI) / 180;
  const weight = 90; // per unit area of shell surface
  const props: Props = { E: 4.32e8, nu: 0, t: 0.25, density: weight / 0.25 };

  /**
   * Quarter of the roof: the axis is global Z, Y is up. s runs from the crown (φ = 0) to
   * the free edge (φ = 40°), t from midspan (z = 0) to the end diaphragm (z = L/2).
   */
  function roof(n: number): { sol: Solution; edge: number; area: number } {
    const mesh = gridMesh(n, n, (s, t) => {
      const phi = s * halfAngle;
      return [R * Math.sin(phi), R * Math.cos(phi), (t * length) / 2];
    });
    const fixed = new Map<number, number>();
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const node = j * (n + 1) + i;
        if (i === 0) fix(fixed, node, [UX, RY, RZ]); // crown: symmetry about the YZ plane
        if (j === 0) fix(fixed, node, [UZ, RX, RY]); // midspan: symmetry about the XY plane
        if (j === n) fix(fixed, node, [UX, UY]); // rigid diaphragm
      }
    }
    const sol = solve({ ...mesh, props, fixed, gravity: [0, -1, 0] });
    const area = sol.elements.reduce((sum, el) => sum + el.area, 0);
    return { sol, edge: n, area };
  }

  it('vertical displacement at the middle of the free edge converges to −0.3024', () => {
    const errors = [4, 8, 16].map((n) => {
      const { sol, edge } = roof(n);
      const v = sol.u[dof(edge, UY)];
      expect(v).toBeLessThan(0);
      return Math.abs(v / -0.3024 - 1);
    });
    expect(errors[0]).toBeLessThan(0.06);
    expect(errors[1]).toBeLessThan(0.02);
    expect(errors[2]).toBeLessThan(0.005);
    expect(errors[1]).toBeLessThan(errors[0]);
    expect(errors[2]).toBeLessThan(errors[1]);
  });

  it('is in global equilibrium and its facets are flat', () => {
    const n = 8;
    const { sol, area } = roof(n);
    // facet area → quarter of the cylinder surface as the mesh is refined
    const exactArea = R * halfAngle * (length / 2);
    expect(area).toBeLessThan(exactArea);
    expect(area / exactArea).toBeCloseTo(1, 3);
    for (const el of sol.elements) {
      expect(el.warp).toBeLessThan(1e-12);
      expect(el.warnings).toEqual([]);
    }
    // all the weight goes to the diaphragm (the symmetry planes carry no vertical force)
    let vertical = 0;
    for (let i = 0; i <= n; i++) vertical += sol.residual[dof(n * (n + 1) + i, UY)];
    expect(vertical / (weight * area)).toBeCloseTo(1, 9);
    // free DOFs are in equilibrium
    const largest = Math.max(...sol.residual.map(Math.abs));
    sol.residual.forEach((r, d) => {
      const node = Math.floor(d / 6);
      const i = node % (n + 1);
      const j = Math.floor(node / (n + 1));
      if (i > 0 && j > 0 && j < n) expect(Math.abs(r)).toBeLessThan(1e-8 * largest);
    });
  });

  it('acts as a beam between the diaphragms: free edge in tension, crown in compression', () => {
    const n = 8;
    const { sol } = roof(n);
    // Element at midspan next to the free edge. Its local x runs around the arc and local y
    // along the roof axis, so Ny is the longitudinal (beam-like) membrane force: the free
    // edge is the bottom flange of the vault acting as a beam between the diaphragms.
    const r = sol.results[n - 1];
    expect(Math.abs(dot(r.axes.y, Z))).toBeCloseTo(1, 12);
    expect(r.corners[1].Ny).toBeGreaterThan(0);
    // crown element: longitudinal compression
    expect(sol.results[0].corners[0].Ny).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------------------
// Incompatible modes: pure in-plane bending of a single element
// ---------------------------------------------------------------------------------------

describe('membrane incompatible modes', () => {
  it('a single rectangular element is exact in pure in-plane bending', () => {
    // Pure bending about z: u = κ·x·y, v = −κ·(x² + ν·y²)/2, giving σx = E·κ·y and
    // σy = τxy = 0. At the corners of a rectangle centred on the origin v is the same for
    // all four nodes, so the nodal displacements are u_i = κ·x_i·y_i (v dropped as a rigid
    // translation); the incompatible modes must supply the two parabolic parts of v.
    const [la, lb] = [3, 0.8];
    const kappa = 1e-3;
    const props: Props = { E: 2e7, nu: 0.3, t: 0.05 };
    const coords: Vec3[] = [
      [-la / 2, -lb / 2, 0],
      [la / 2, -lb / 2, 0],
      [la / 2, lb / 2, 0],
      [-la / 2, lb / 2, 0],
    ];
    const el = plateElement(
      { id: 'B', nodes: ['1', '2', '3', '4'], ...props },
      coords,
      [],
      [0, 0, 0],
    );
    // The drilling penalty refers to the rotation of the compatible (bilinear) field,
    // ½(∂v/∂x − ∂u/∂y) = −κ·x/2 here, so nodal drilling rotations equal to it leave the
    // penalty without any energy.
    const u = coords.flatMap(([x, y]) => [kappa * x * y, 0, 0, 0, 0, (-kappa * x) / 2]);
    const result = plateResult(el, u);
    const extreme = props.E * kappa * (lb / 2) * props.t;
    const signs = [-1, -1, 1, 1];
    result.corners.forEach((corner, i) => {
      expect(corner.Nx / (signs[i] * extreme)).toBeCloseTo(1, 10);
      expect(Math.abs(corner.Ny)).toBeLessThan(1e-10 * extreme);
      expect(Math.abs(corner.Nxy)).toBeLessThan(1e-10 * extreme);
    });
    for (const value of membraneOf(result.center))
      expect(Math.abs(value)).toBeLessThan(1e-10 * extreme);
    // Nodal forces: the couple ±F on each end face with F·b = M = E·κ·t·b³/12, no fy.
    const forces = matVec(el.k, u);
    const F = (props.E * kappa * props.t * lb * lb) / 12;
    const expected = [F, -F, F, -F];
    for (let i = 0; i < 4; i++) {
      expect(forces[dof(i, UX)] / expected[i]).toBeCloseTo(1, 9);
      expect(Math.abs(forces[dof(i, UY)])).toBeLessThan(1e-9 * F);
      expect(Math.abs(forces[dof(i, RZ)])).toBeLessThan(1e-9 * F);
    }
    // With the drilling rotations held at zero instead, the penalty adds its (small) share:
    // γ·G·t·∫(κ·x/2)² dA against the bending energy E·t·κ²·a·b³/24, i.e. a relative
    // stiffening of γ·(G/E)·(a/b)²/4.
    const held = coords.flatMap(([x, y]) => [kappa * x * y, 0, 0, 0, 0, 0]);
    const stiffening = (1e-3 / (2 * (1 + props.nu))) * (la / lb) ** 2 * 0.25;
    expect(matVec(el.k, held)[dof(0, UX)] / F - 1).toBeCloseTo(stiffening, 9);
  });
});

// ---------------------------------------------------------------------------------------
// 10. Loads
// ---------------------------------------------------------------------------------------

describe('plate loads', () => {
  const plate = singlePlate({ density: 78.5 });
  const axes = plateAxes(TILTED);

  /** Sum of the nodal forces and of their moments about the global origin. */
  function resultant(f: number[]): { force: Vec3; moment: Vec3 } {
    let force: Vec3 = [0, 0, 0];
    let moment: Vec3 = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const fi = f.slice(6 * i, 6 * i + 3) as Vec3;
      force = add(force, fi);
      moment = add(moment, cross(TILTED[i], fi));
      // no nodal moments
      expect(f.slice(6 * i + 3, 6 * i + 6)).toEqual([0, 0, 0]);
    }
    return { force, moment };
  }

  /** Centroid of the area of the (planar) quadrilateral, from its two triangles. */
  function areaCentroid(): Vec3 {
    const [p1, p2, p3, p4] = TILTED;
    const a1 = norm(cross(sub(p2, p1), sub(p3, p1))) / 2;
    const a2 = norm(cross(sub(p3, p1), sub(p4, p1))) / 2;
    const c1 = scale(add(add(p1, p2), p3), 1 / 3);
    const c2 = scale(add(add(p1, p3), p4), 1 / 3);
    return scale(add(scale(c1, a1), scale(c2, a2)), 1 / (a1 + a2));
  }

  /** A uniform load of intensity `q` (vector, per unit area) must give q·A at the centroid. */
  function expectUniform(f: number[], q: Vec3): void {
    const { force, moment } = resultant(f);
    const total = scale(q, axes.area);
    expect(norm(sub(force, total))).toBeLessThan(1e-12 * norm(total));
    expect(norm(sub(moment, cross(areaCentroid(), total)))).toBeLessThan(1e-11 * norm(total));
  }

  it('pressure along the plate normal gives p·A along local z', () => {
    const el = plateElement(
      plate,
      TILTED,
      [{ kind: 'pressure', plate: 'P1', direction: 'localZ', p: -4 }],
      [0, 0, 0],
    );
    expectUniform(el.f, scale(axes.z, -4));
    expectVec(el.axes.z, axes.z);
  });

  it('pressure along each global axis gives p·A along that axis (per unit plate area)', () => {
    const directions = [
      ['globalX', X],
      ['globalY', Y],
      ['globalZ', Z],
    ] as const;
    for (const [direction, unit] of directions) {
      const el = plateElement(
        plate,
        TILTED,
        [{ kind: 'pressure', plate: 'P1', direction, p: 2.5 }],
        [0, 0, 0],
      );
      expectUniform(el.f, scale(unit, 2.5));
    }
  });

  it('self-weight gives density·t·A·g', () => {
    const g: Vec3 = [0, -1.35, 0];
    const el = plateElement(plate, TILTED, [], g);
    expectUniform(el.f, scale(g, 78.5 * steel.t));
    // inclined gravity vector
    const g2: Vec3 = [0.2, -1, 0.4];
    expectUniform(plateElement(plate, TILTED, [], g2).f, scale(g2, 78.5 * steel.t));
    // a plate without density carries no self-weight
    expect(plateElement(singlePlate(), TILTED, [], g).f).toEqual(new Array(24).fill(0));
  });

  it('loads superpose', () => {
    const g: Vec3 = [0, -1, 0];
    const loads: PlateLoad3D[] = [
      { kind: 'pressure', plate: 'P1', direction: 'localZ', p: 3 },
      { kind: 'pressure', plate: 'P1', direction: 'globalY', p: -2 },
    ];
    const el = plateElement(plate, TILTED, loads, g);
    expectUniform(el.f, add(add(scale(axes.z, 3), [0, -2, 0]), scale(g, 78.5 * steel.t)));
  });

  it('a square plate shares a uniform pressure equally between its nodes', () => {
    const el = plateElement(
      singlePlate(),
      SQUARE,
      [{ kind: 'pressure', plate: 'P1', direction: 'localZ', p: 8 }],
      [0, 0, 0],
    );
    for (let i = 0; i < 4; i++) {
      expect(el.f[dof(i, UZ)]).toBeCloseTo(2, 12);
      expect(el.f[dof(i, UX)]).toBe(0);
      expect(el.f[dof(i, UY)]).toBe(0);
    }
  });

  it('a point load at a node goes entirely to that node', () => {
    const natural = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    natural.forEach(([xi, eta], node) => {
      const el = plateElement(
        plate,
        TILTED,
        [{ kind: 'platePoint', plate: 'P1', direction: 'globalY', P: -12, xi, eta }],
        [0, 0, 0],
      );
      for (let i = 0; i < 4; i++) {
        expect(el.f[dof(i, UY)]).toBeCloseTo(i === node ? -12 : 0, 12);
        expect(el.f[dof(i, UX)]).toBeCloseTo(0, 12);
        expect(el.f[dof(i, UZ)]).toBeCloseTo(0, 12);
      }
    });
  });

  it('a point load at the centre puts a quarter on each node, along the given direction', () => {
    const el = plateElement(
      plate,
      TILTED,
      [{ kind: 'platePoint', plate: 'P1', direction: 'localZ', P: 10, xi: 0, eta: 0 }],
      [0, 0, 0],
    );
    for (let i = 0; i < 4; i++) {
      expectVec(el.f.slice(6 * i, 6 * i + 3), scale(axes.z, 2.5));
    }
    for (const [direction, unit] of [
      ['globalX', X],
      ['globalZ', Z],
    ] as const) {
      const other = plateElement(
        plate,
        TILTED,
        [{ kind: 'platePoint', plate: 'P1', direction, P: 10, xi: 0, eta: 0 }],
        [0, 0, 0],
      );
      for (let i = 0; i < 4; i++) expectVec(other.f.slice(6 * i, 6 * i + 3), scale(unit, 2.5));
    }
  });

  it('a point load elsewhere is statically equivalent to the force at that point', () => {
    const [xi, eta] = [0.5, -0.2];
    const el = plateElement(
      plate,
      TILTED,
      [{ kind: 'platePoint', plate: 'P1', direction: 'localZ', P: 6, xi, eta }],
      [0, 0, 0],
    );
    const weights = [
      (1 - xi) * (1 - eta),
      (1 + xi) * (1 - eta),
      (1 + xi) * (1 + eta),
      (1 - xi) * (1 + eta),
    ].map((v) => v / 4);
    let point: Vec3 = [0, 0, 0];
    weights.forEach((weight, i) => {
      point = add(point, scale(TILTED[i], weight));
      expectVec(el.f.slice(6 * i, 6 * i + 3), scale(axes.z, 6 * weight));
    });
    const { force, moment } = resultant(el.f);
    expectVec(force, scale(axes.z, 6));
    expectVec(moment, cross(point, scale(axes.z, 6)), 1e-11);
  });

  it('rejects point loads outside the plate and loads without a value', () => {
    const point = (xi: number, eta: number, P = 1): PlateLoad3D => ({
      kind: 'platePoint',
      plate: 'P1',
      direction: 'localZ',
      P,
      xi,
      eta,
    });
    for (const [xi, eta] of [
      [1.01, 0],
      [-1.01, 0],
      [0, 1.5],
      [0, -1.0001],
      [Number.NaN, 0],
      [0, Number.NaN],
    ]) {
      expectInvalid(
        () => plateElement(plate, TILTED, [point(xi, eta)], [0, 0, 0]),
        'P1',
        /outside the plate/,
      );
    }
    // the boundary itself is allowed
    expect(() =>
      plateElement(plate, TILTED, [point(1, -1), point(-1, 0.3)], [0, 0, 0]),
    ).not.toThrow();
    expectInvalid(
      () => plateElement(plate, TILTED, [point(0, 0, Number.NaN)], [0, 0, 0]),
      'P1',
      /point load/,
    );
    expectInvalid(
      () =>
        plateElement(
          plate,
          TILTED,
          [{ kind: 'pressure', plate: 'P1', direction: 'localZ', p: Number.POSITIVE_INFINITY }],
          [0, 0, 0],
        ),
      'P1',
      /pressure/,
    );
  });
});

// ---------------------------------------------------------------------------------------
// 12. Invalid input
// ---------------------------------------------------------------------------------------

describe('invalid plates', () => {
  const build =
    (extra: Partial<Plate3D>, coords: Vec3[] = SQUARE) =>
    () =>
      plateElement(singlePlate(extra), coords, [], [0, 0, 0]);

  it('rejects invalid material and thickness', () => {
    for (const E of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expectInvalid(build({ E }), 'P1', /Young's modulus/);
    for (const t of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY])
      expectInvalid(build({ t }), 'P1', /thickness/);
    for (const nu of [0.5, 0.6, -1, -1.2, Number.NaN])
      expectInvalid(build({ nu }), 'P1', /Poisson/);
    expectInvalid(build({ density: Number.NaN }), 'P1', /density/);
    // limits that are still valid
    expect(build({ nu: 0 })).not.toThrow();
    expect(build({ nu: 0.499 })).not.toThrow();
    expect(build({ nu: -0.5 })).not.toThrow();
  });

  it('rejects a wrong number of nodes or invalid coordinates', () => {
    expectInvalid(build({}, SQUARE.slice(0, 3)), 'P1', /four nodes/);
    expectInvalid(build({}, [...SQUARE, [2, 2, 0]]), 'P1', /four nodes/);
    expectInvalid(
      build({ nodes: ['a', 'b', 'c'] as unknown as Plate3D['nodes'] }),
      'P1',
      /four nodes/,
    );
    expectInvalid(
      build({}, [SQUARE[0], SQUARE[1], [1, Number.NaN, 0], SQUARE[3]]),
      'P1',
      /coordinates/,
    );
    expectInvalid(
      build({}, [SQUARE[0], SQUARE[1], [1, 1] as unknown as Vec3, SQUARE[3]]),
      'P1',
      /coordinates/,
    );
  });

  it('rejects coincident nodes', () => {
    // adjacent nodes (a triangle entered as a quadrilateral)
    expectInvalid(
      build({}, [SQUARE[0], SQUARE[1], SQUARE[1], SQUARE[3]]),
      'P1',
      /coincident nodes \("b" and "c"\)/,
    );
    // opposite nodes
    expectInvalid(
      build({}, [SQUARE[0], SQUARE[1], SQUARE[0], SQUARE[3]]),
      'P1',
      /coincident nodes \("a" and "c"\)/,
    );
    // all four
    expectInvalid(build({}, [SQUARE[2], SQUARE[2], SQUARE[2], SQUARE[2]]), 'P1', /coincident/);
  });

  it('rejects zero-area, re-entrant, bow-tie and triangular shapes', () => {
    const line: Vec3[] = [
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
      [3, 3, 3],
    ];
    expectInvalid(build({}, line), 'P1', /zero area/);
    const reEntrant: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [0.5, 0.5, 0],
      [0, 2, 0],
    ];
    expectInvalid(build({}, reEntrant), 'P1', /not a convex quadrilateral at node "c"/);
    const bowTie: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1.3, 1.5, 0],
    ];
    expectInvalid(build({}, bowTie), 'P1', /not a convex quadrilateral/);
    // node 3 on the line between nodes 2 and 4: detJ = 0 at that corner
    const triangle: Vec3[] = [
      [0, 0, 0],
      [2, 0, 0],
      [1, 1, 0],
      [0, 2, 0],
    ];
    expectInvalid(build({}, triangle), 'P1', /not a convex quadrilateral at node "c"/);
    // the same shapes are rejected in any orientation
    expectInvalid(
      build(
        {},
        reEntrant.map((c) => add(rotate(TILT, c), SHIFT)),
      ),
      'P1',
      /not a convex/,
    );
  });

  it('plateResult rejects a displacement vector of the wrong length', () => {
    const el = plateElement(singlePlate(), SQUARE, [], [0, 0, 0]);
    expectInvalid(() => plateResult(el, new Array(12).fill(0)), 'P1', /24 displacements/);
    // zero displacements give zero results
    const result = plateResult(el, new Array(24).fill(0));
    expect(result.maxVonMises).toBe(0);
    expect(result.id).toBe('P1');
    expect(result.area).toBeCloseTo(1, 12);
    expect(result.corners).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------
// Folded-plate assembly: thin-walled square tube
// ---------------------------------------------------------------------------------------

describe('folded-plate assembly: cantilevered square tube', () => {
  const L = 10;
  const side = 1; // wall centre-line dimension
  const props: Props = { E: 2e7, nu: 0, t: 0.05 };
  const G = props.E / 2;
  const perWall = 2;
  const stations = 20;
  const ring = 4 * perWall;

  /** Point on the square perimeter, counter-clockwise from (−½, −½) seen from +Z. */
  function perimeter(r: number): [number, number] {
    const wall = Math.floor(r / perWall) % 4;
    const along = ((r % perWall) / perWall) * side;
    const half = side / 2;
    if (wall === 0) return [-half + along, -half];
    if (wall === 1) return [half, -half + along];
    if (wall === 2) return [half - along, half];
    return [-half, half - along];
  }

  /** Tube along global Z, clamped at z = 0, with nodal loads on the tip ring. */
  function tube(tipLoad: (x: number, y: number, r: number) => Vec3): {
    sol: Solution;
    tip: number[];
  } {
    const nodes: Vec3[] = [];
    for (let k = 0; k <= stations; k++) {
      for (let r = 0; r < ring; r++) nodes.push([...perimeter(r), (k * L) / stations]);
    }
    const quads: number[][] = [];
    for (let k = 0; k < stations; k++) {
      for (let r = 0; r < ring; r++) {
        const next = (r + 1) % ring;
        quads.push([k * ring + r, k * ring + next, (k + 1) * ring + next, (k + 1) * ring + r]);
      }
    }
    const fixed = new Map<number, number>();
    for (let r = 0; r < ring; r++) fix(fixed, r, [UX, UY, UZ, RX, RY, RZ]);
    const nodal = new Map<number, number>();
    const tip: number[] = [];
    for (let r = 0; r < ring; r++) {
      const node = stations * ring + r;
      tip.push(node);
      const [x, y] = perimeter(r);
      tipLoad(x, y, r).forEach((value, c) => nodal.set(dof(node, c), value));
    }
    return { sol: solve({ nodes, quads, props, fixed, nodal }), tip };
  }

  it('walls meet at right angles with outward normals', () => {
    const { sol } = tube(() => [0, 0, 0]);
    // first wall (y = −½): local x along +X, local y along the tube, normal −Y (outward)
    expectVec(sol.results[0].axes.x, [1, 0, 0]);
    expectVec(sol.results[0].axes.y, [0, 0, 1]);
    expectVec(sol.results[0].axes.z, [0, -1, 0]);
    // second wall (x = +½): normal +X
    expectVec(sol.results[perWall].axes.z, [1, 0, 0]);
  });

  it('bending: tip deflection matches thin-walled beam theory', () => {
    const P = 50;
    const { sol, tip } = tube(() => [0, -P / ring, 0]);
    const deflection = tip.reduce((sum, node) => sum + sol.u[dof(node, UY)], 0) / ring;
    // I of the thin-walled section: two webs t·h³/12 and two flanges b·t·(h/2)²;
    // shear carried by the two webs (area 2·h·t).
    const I = (2 * props.t * side ** 3) / 12 + 2 * side * props.t * (side / 2) ** 2;
    const beam = (P * L ** 3) / (3 * props.E * I) + (P * L) / (G * 2 * side * props.t);
    expect(deflection).toBeLessThan(0);
    expect(Math.abs(-deflection / beam - 1)).toBeLessThan(0.015);

    // Flange membrane stress near the root: σ = M·c/I, tension in the top flange (y = +½),
    // compression in the bottom one. First element row, centred at z = L/(2·stations).
    const M = P * (L - L / stations / 2);
    const sigma = (M * (side / 2)) / I;
    const bottom = sol.results[0]; // wall y = −½, local y along the tube
    const top = sol.results[2 * perWall]; // wall y = +½
    expect(Math.abs(dot(top.axes.y, Z))).toBeCloseTo(1, 12);
    expect(Math.abs(top.center.Ny / props.t / sigma - 1)).toBeLessThan(0.03);
    expect(Math.abs(bottom.center.Ny / props.t / -sigma - 1)).toBeLessThan(0.03);

    // equilibrium of the whole tube: root reactions
    let fy = 0;
    let mx = 0;
    for (let r = 0; r < ring; r++) {
      const [, y] = perimeter(r);
      fy += sol.residual[dof(r, UY)];
      // moment about the global X axis through the root centroid: y·Fz − z·Fy (z = 0) + Mx
      mx += y * sol.residual[dof(r, UZ)] + sol.residual[dof(r, RX)];
    }
    expect(fy).toBeCloseTo(P, 7);
    // the load −P·e_y at z = L has moment (0, 0, L) × (0, −P, 0) = (P·L, 0, 0)
    expect(mx).toBeCloseTo(-P * L, 6);
  });

  it('torsion: twist matches Bredt’s closed-section formula', () => {
    // A uniform shear flow q runs counter-clockwise around the tip section (consistent
    // nodal forces q·h/2 from each adjacent wall segment of length h, along that wall).
    // Torque T = 2·A·q. Thin-walled closed section: J = 4·A²·t/perimeter (Bredt) plus the
    // walls' own twisting stiffness Σ b·t³/3 (0.33 % here); the tube turns as a rigid
    // cross-section by T·L/(G·J).
    const q = 40;
    const h = side / perWall;
    const along: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
    ];
    const wallOf = (segment: number) => Math.floor((((segment % ring) + ring) % ring) / perWall);
    const { sol, tip } = tube((_x, _y, r) =>
      scale(add(along[wallOf(r - 1)], along[wallOf(r)]), (q * h) / 2),
    );
    const area = side * side;
    const T = 2 * area * q;
    const bredt = (4 * area * area * props.t) / (4 * side);
    const J = bredt + (4 * side * props.t ** 3) / 3;
    const twist = (T * L) / (G * J);
    for (const node of tip) {
      const [x, y] = perimeter(node - stations * ring);
      // rigid rotation of the cross-section about Z: u = φ·(−y, x), nodal rotation rz = φ
      expect(Math.abs(sol.u[dof(node, UX)] + y * twist)).toBeLessThan(0.003 * twist * side);
      expect(Math.abs(sol.u[dof(node, UY)] - x * twist)).toBeLessThan(0.003 * twist * side);
      expect(Math.abs(sol.u[dof(node, RZ)] / twist - 1)).toBeLessThan(0.003);
      // a square tube of constant thickness does not warp
      expect(Math.abs(sol.u[dof(node, UZ)])).toBeLessThan(1e-3 * twist * side);
    }
    // Membrane shear flow: the closed-section share of the torque, |Nxy| = q·J_Bredt/J, in
    // the half of the tube away from the clamped end. Near the clamp, where the twisting of
    // the walls is restrained, a thickness-wide edge zone that this mesh cannot resolve
    // shifts a few percent of the torque between membrane and plate action, alternating
    // from one element row to the next and dying out along the tube.
    sol.results.forEach((r, e) => {
      const station = Math.floor(e / ring);
      const ratio = Math.abs(r.center.Nxy) / q;
      expect(Math.abs(ratio - 1)).toBeLessThan(0.04);
      if (station >= stations / 2) expect(Math.abs(ratio / (bredt / J) - 1)).toBeLessThan(0.003);
      expect(Math.abs(r.center.Ny)).toBeLessThan(1e-6 * q);
    });
    // root reactions: no net force, torque −T about Z
    let mz = 0;
    for (let r = 0; r < ring; r++) {
      const [x, y] = perimeter(r);
      mz += x * sol.residual[dof(r, UY)] - y * sol.residual[dof(r, UX)] + sol.residual[dof(r, RZ)];
    }
    expect(mz / -T).toBeCloseTo(1, 9);
  });
});
