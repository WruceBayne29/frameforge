import { describe, expect, it } from 'vitest';
import { SolverError } from '../solver/errors';
import { cholesky, choleskySolve, gauss3, matVec, zeros } from '../solver/linalg';
import { jacobiEigen } from '../solver/modal';
import {
  add,
  cross,
  dot,
  GAUSS2,
  norm,
  normalize,
  principal3,
  scale,
  sub,
  vonMises3,
} from './math';
import type { SolidElement } from './solid';
import { SOLID_FACES, solidElement, solidResult } from './solid';
import type {
  Solid3D,
  SolidFace,
  SolidFaceLoad3D,
  SolidResult3D,
  StressState,
  Vec3,
} from './types';

// ---------------------------------------------------------------------------------------
// Test helpers: meshes and a small assemble-and-solve driver
// ---------------------------------------------------------------------------------------

const UX = 0;
const UY = 1;
const UZ = 2;
const NO_GRAVITY: Vec3 = [0, 0, 0];
const NODE_IDS: Solid3D['nodes'] = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'];

interface Props {
  E: number;
  nu: number;
  density?: number;
}

interface Mesh {
  nodes: Vec3[];
  hexes: number[][];
  /** Number of elements along X, Y and Z. */
  dims: [number, number, number];
  /** Grid position (i, j, k) of every element. */
  cells: [number, number, number][];
  /** Node index at grid position (i, j, k). */
  node: (i: number, j: number, k: number) => number;
}

interface Problem {
  mesh: Mesh;
  props: Props;
  /** Face loads of element `e`, whose solid id is `id`. */
  loads?: (e: number, id: string) => SolidFaceLoad3D[];
  gravity?: Vec3;
  /** Prescribed displacements: global DOF index (3·node + component) → value. */
  fixed: Map<number, number>;
  /** Nodal loads: global DOF index → value. */
  nodal?: Map<number, number>;
  /** Replaces the element stiffness (used to compare with the plain 8-node brick). */
  stiffness?: (coords: Vec3[], props: Props) => number[][];
}

interface Solution {
  /** Displacements, 3 per node. */
  u: number[];
  elements: SolidElement[];
  results: SolidResult3D[];
  /** K·u − f at every DOF: the reaction at prescribed DOFs, ~0 at free ones. */
  residual: number[];
}

const dof = (node: number, component: number): number => 3 * node + component;

/** Prescribes (by default: fixes) the listed components of a node. */
function fix(fixed: Map<number, number>, node: number, components: number[], value = 0): void {
  for (const c of components) fixed.set(dof(node, c), value);
}

/** Deterministic pseudo-random numbers in [−1, 1) (linear congruential generator). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
}

/**
 * Regular box mesh of nx × ny × nz hexahedra over [0, Lx] × [0, Ly] × [0, Lz]. Element
 * natural axes ξ, η, ζ run along global X, Y, Z, so of every element face 6 / 4 looks towards
 * −X / +X, face 3 / 5 towards −Y / +Y and face 1 / 2 towards −Z / +Z.
 */
function boxMesh(dims: [number, number, number], size: Vec3): Mesh {
  const [nx, ny, nz] = dims;
  const node = (i: number, j: number, k: number): number => i + (nx + 1) * (j + (ny + 1) * k);
  const nodes: Vec3[] = [];
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        nodes.push([(size[0] * i) / nx, (size[1] * j) / ny, (size[2] * k) / nz]);
      }
    }
  }
  const hexes: number[][] = [];
  const cells: [number, number, number][] = [];
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        cells.push([i, j, k]);
        hexes.push([
          node(i, j, k),
          node(i + 1, j, k),
          node(i + 1, j + 1, k),
          node(i, j + 1, k),
          node(i, j, k + 1),
          node(i + 1, j, k + 1),
          node(i + 1, j + 1, k + 1),
          node(i, j + 1, k + 1),
        ]);
      }
    }
  }
  return { nodes, hexes, dims, cells, node };
}

/** Faces of element `e` that lie on the boundary of a box mesh. */
function boundaryFaces(mesh: Mesh, e: number): SolidFace[] {
  const [i, j, k] = mesh.cells[e];
  const [nx, ny, nz] = mesh.dims;
  const faces: SolidFace[] = [];
  if (k === 0) faces.push(1);
  if (k === nz - 1) faces.push(2);
  if (j === 0) faces.push(3);
  if (i === nx - 1) faces.push(4);
  if (j === ny - 1) faces.push(5);
  if (i === 0) faces.push(6);
  return faces;
}

/** Grid positions of all nodes of a box mesh, in node order. */
function gridPositions(mesh: Mesh): [number, number, number][] {
  const [nx, ny, nz] = mesh.dims;
  const out: [number, number, number][] = [];
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) out.push([i, j, k]);
    }
  }
  return out;
}

/**
 * Moves the nodes of a box mesh randomly by up to `amplitude` (absolute, per component).
 * `which` selects the nodes that move: all of them, all but the eight box corners, or only
 * the nodes strictly inside the box.
 */
function distort(
  mesh: Mesh,
  amplitude: number,
  seed: number,
  which: 'all' | 'notCorners' | 'interior',
): Mesh {
  const random = rng(seed);
  const dims = mesh.dims;
  const nodes = gridPositions(mesh).map((grid, n): Vec3 => {
    const onBoundary = grid.filter((g, a) => g === 0 || g === dims[a]).length;
    const d: Vec3 = [amplitude * random(), amplitude * random(), amplitude * random()];
    if (which === 'interior' && onBoundary > 0) return mesh.nodes[n];
    if (which === 'notCorners' && onBoundary === 3) return mesh.nodes[n];
    return add(mesh.nodes[n], d);
  });
  return { ...mesh, nodes };
}

/** Indices of the nodes of a mesh that satisfy a predicate on their position. */
function nodesWhere(mesh: Mesh, test: (p: Vec3) => boolean): number[] {
  return mesh.nodes.flatMap((p, n) => (test(p) ? [n] : []));
}

function solidOf(id: string, props: Props, nodes: Solid3D['nodes'] = NODE_IDS): Solid3D {
  return { id, nodes, ...props };
}

/** Assembles the dense system, applies the prescribed displacements and solves it. */
function solve(problem: Problem): Solution {
  const { mesh, props, fixed } = problem;
  const n = 3 * mesh.nodes.length;
  const K = zeros(n, n);
  const F = new Array<number>(n).fill(0);
  const elements: SolidElement[] = [];
  mesh.hexes.forEach((hex, e) => {
    const id = `S${e + 1}`;
    const coords = hex.map((i) => mesh.nodes[i]);
    const ids = hex.map((i) => `N${i}`) as Solid3D['nodes'];
    const el = solidElement(
      solidOf(id, props, ids),
      coords,
      problem.loads?.(e, id) ?? [],
      problem.gravity ?? NO_GRAVITY,
    );
    elements.push(el);
    const k = problem.stiffness ? problem.stiffness(coords, props) : el.k;
    const map = hex.flatMap((i) => [3 * i, 3 * i + 1, 3 * i + 2]);
    for (let r = 0; r < 24; r++) {
      F[map[r]] += el.f[r];
      for (let c = 0; c < 24; c++) K[map[r]][map[c]] += k[r][c];
    }
  });
  for (const [d, value] of problem.nodal ?? []) F[d] += value;

  const u = new Array<number>(n).fill(0);
  for (const [d, value] of fixed) u[d] = value;
  const free: number[] = [];
  for (let d = 0; d < n; d++) if (!fixed.has(d)) free.push(d);
  if (free.length > 0) {
    const Ku = matVec(K, u);
    const factor = cholesky(free.map((r) => free.map((c) => K[r][c])));
    if (!factor.ok) throw new Error(`test model is unstable at free DOF ${factor.pivotIndex}`);
    const x = choleskySolve(
      factor.L,
      free.map((d) => F[d] - Ku[d]),
    );
    free.forEach((d, i) => (u[d] = x[i]));
  }
  const Ku = matVec(K, u);
  const residual = Ku.map((v, d) => v - F[d]);
  const results = elements.map((el, e) =>
    solidResult(
      el,
      mesh.hexes[e].flatMap((i) => [u[3 * i], u[3 * i + 1], u[3 * i + 2]]),
    ),
  );
  return { u, elements, results, residual };
}

const disp = (sol: Solution, node: number): Vec3 => [
  sol.u[3 * node],
  sol.u[3 * node + 1],
  sol.u[3 * node + 2],
];

/** Rotation matrix about `axis` by `angle` (Rodrigues). */
function rotation(axis: Vec3, angle: number): number[][] {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

const rotate = (R: number[][], v: Vec3): Vec3 => matVec(R, v) as Vec3;

const STRESS_KEYS = ['sxx', 'syy', 'szz', 'txy', 'tyz', 'tzx'] as const;

const tensor = (s: StressState): number[] => STRESS_KEYS.map((key) => s[key]);

/** Stress [sxx, syy, szz, txy, tyz, tzx] of a displacement gradient A[i][j] = ∂u_i/∂x_j. */
function hooke(E: number, nu: number, A: number[][]): number[] {
  const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const G = E / (2 * (1 + nu));
  const trace = A[0][0] + A[1][1] + A[2][2];
  return [
    lambda * trace + 2 * G * A[0][0],
    lambda * trace + 2 * G * A[1][1],
    lambda * trace + 2 * G * A[2][2],
    G * (A[0][1] + A[1][0]),
    G * (A[1][2] + A[2][1]),
    G * (A[2][0] + A[0][2]),
  ];
}

/** Every stress point (centre + 8 corners) of every element of a solution. */
function allStressPoints(sol: Solution): StressState[] {
  return sol.results.flatMap((r) => [r.center, ...r.corners]);
}

/** Expects every stress point of the solution to equal the given tensor. */
function expectUniformStress(sol: Solution, expected: number[], tol: number): void {
  for (const point of allStressPoints(sol)) {
    const got = tensor(point);
    for (let i = 0; i < 6; i++) expect(Math.abs(got[i] - expected[i])).toBeLessThan(tol);
  }
}

/** Sum of the nodal forces of an element load vector. */
function totalForce(f: number[]): Vec3 {
  const sum: Vec3 = [0, 0, 0];
  f.forEach((v, i) => (sum[i % 3] += v));
  return sum;
}

/** Vector area ∫ n dA of a bilinear face with corners a, b, c, d: ½·(c − a) × (d − b). */
function vectorArea(coords: Vec3[], face: readonly number[]): Vec3 {
  const [a, b, c, d] = face.map((i) => coords[i]);
  return scale(cross(sub(c, a), sub(d, b)), 0.5);
}

/** A unit cube with nodes in element order. */
const CUBE: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

/** A generally distorted (all faces warped) but valid hexahedron. */
const DISTORTED: Vec3[] = [
  [0.05, -0.1, 0.02],
  [2.1, 0.15, -0.2],
  [1.9, 1.4, 0.1],
  [-0.2, 1.1, -0.05],
  [0.2, 0.1, 1.2],
  [2.3, -0.05, 0.9],
  [2.0, 1.6, 1.3],
  [0.1, 1.2, 1.05],
];

const R_GENERAL = rotation([1, 2, -0.5], 0.83);

/**
 * Stiffness of the plain 8-node brick (trilinear, 2 × 2 × 2 Gauss, no incompatible modes),
 * written independently of solid.ts to show what the incompatible modes buy in bending.
 */
function plainBrick(coords: Vec3[], props: Props): number[][] {
  const signs = CUBE.map((p) => p.map((v) => 2 * v - 1));
  const A = zeros(3, 3);
  const k = zeros(24, 24);
  for (const g of signs) {
    const [xi, eta, zeta] = g.map((v) => v * GAUSS2[1]);
    const dN = signs.map(([a, b, c]) => [
      (a * (1 + b * eta) * (1 + c * zeta)) / 8,
      ((1 + a * xi) * b * (1 + c * zeta)) / 8,
      ((1 + a * xi) * (1 + b * eta) * c) / 8,
    ]);
    // J[i][j] = ∂x_j/∂ξ_i; solve J·∇N = ∂N/∂ξ by Cramer's rule.
    const J = [0, 1, 2].map((i) =>
      [0, 1, 2].map((j) => dN.reduce((sum, d, n) => sum + d[i] * coords[n][j], 0)),
    );
    const det = dot(J[0] as Vec3, cross(J[1] as Vec3, J[2] as Vec3));
    const grads = dN.map((d) => {
      const out: number[] = [];
      for (let col = 0; col < 3; col++) {
        const M = J.map((row, r) => row.map((v, c) => (c === col ? d[r] : v)));
        out.push(dot(M[0] as Vec3, cross(M[1] as Vec3, M[2] as Vec3)) / det);
      }
      return out;
    });
    // k_ab = ∫ σ(unit displacement b) : ε(unit displacement a) dV
    for (let a = 0; a < 24; a++) {
      for (let b = 0; b < 24; b++) {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i][j] = 0;
        A[b % 3] = grads[Math.floor(b / 3)].slice();
        const s = hooke(props.E, props.nu, A);
        const ga = grads[Math.floor(a / 3)];
        const c = a % 3;
        // strain of DOF a: e_cc = ga[c], γ_cj = ga[j] for j ≠ c
        const index = [
          [0, 3, 5],
          [3, 1, 4],
          [5, 4, 2],
        ];
        let work = 0;
        for (let j = 0; j < 3; j++) work += s[index[c][j]] * ga[j];
        k[a][b] += work * det;
      }
    }
  }
  return k;
}

// ---------------------------------------------------------------------------------------
// 1. Element matrix
// ---------------------------------------------------------------------------------------

describe('solid element matrix', () => {
  const props: Props = { E: 1000, nu: 0.3 };
  const shapes: [string, Vec3[]][] = [
    ['cube', CUBE],
    ['distorted hex', DISTORTED],
    ['rotated distorted hex', DISTORTED.map((p) => add(rotate(R_GENERAL, p), [3, -2, 5]))],
    ['flat slab', CUBE.map(([x, y, z]): Vec3 => [4 * x, 0.2 * y, 3 * z])],
  ];

  /** Three translations and three small rotations about the origin, as 24-vectors. */
  function rigidModes(coords: Vec3[]): number[][] {
    const axes: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    return [
      ...axes.map((a) => coords.flatMap(() => a)),
      ...axes.map((a) => coords.flatMap((p) => cross(a, p))),
    ];
  }

  it.each(shapes)('is symmetric with 6 zero and 18 positive eigenvalues: %s', (_, coords) => {
    const el = solidElement(solidOf('S', props), coords, [], NO_GRAVITY);
    expect(el.dofsPerNode).toBe(3);
    expect(el.nodes).toEqual(NODE_IDS);
    expect(el.k.length).toBe(24);
    expect(el.f).toEqual(new Array<number>(24).fill(0));
    let kmax = 0;
    for (let r = 0; r < 24; r++) {
      expect(el.k[r].length).toBe(24);
      for (let c = 0; c < 24; c++) {
        kmax = Math.max(kmax, Math.abs(el.k[r][c]));
        expect(el.k[r][c]).toBe(el.k[c][r]);
      }
    }
    const { values } = jacobiEigen(el.k);
    const largest = values[23];
    for (let i = 0; i < 6; i++) expect(Math.abs(values[i])).toBeLessThan(1e-11 * largest);
    for (let i = 6; i < 24; i++) expect(values[i]).toBeGreaterThan(1e-7 * largest);
    expect(kmax).toBeGreaterThan(0);
  });

  it.each(shapes)('gives no force, mode amplitude or stress for rigid motion: %s', (_, coords) => {
    const el = solidElement(solidOf('S', props), coords, [], NO_GRAVITY);
    let kmax = 0;
    for (const row of el.k) for (const v of row) kmax = Math.max(kmax, Math.abs(v));
    for (const mode of rigidModes(coords)) {
      const size = Math.max(...mode.map(Math.abs));
      for (const v of matVec(el.k, mode)) expect(Math.abs(v)).toBeLessThan(1e-11 * kmax * size);
      for (const v of matVec(el.modes, mode)) expect(Math.abs(v)).toBeLessThan(1e-11 * size);
      const res = solidResult(el, mode);
      expect(res.maxVonMises).toBeLessThan(1e-10 * props.E * size);
    }
  });

  it('rotates with the element: k′ = T·k·Tᵀ', () => {
    const el = solidElement(solidOf('S', props), DISTORTED, [], NO_GRAVITY);
    const rotated = solidElement(
      solidOf('S', props),
      DISTORTED.map((p) => rotate(R_GENERAL, p)),
      [],
      NO_GRAVITY,
    );
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            let expected = 0;
            for (let p = 0; p < 3; p++) {
              for (let q = 0; q < 3; q++) {
                expected += R_GENERAL[i][p] * el.k[3 * a + p][3 * b + q] * R_GENERAL[j][q];
              }
            }
            expect(Math.abs(rotated.k[3 * a + i][3 * b + j] - expected)).toBeLessThan(1e-9);
          }
        }
      }
    }
  });

  it('scales linearly with E', () => {
    const a = solidElement(solidOf('S', { E: 1, nu: 0.25 }), DISTORTED, [], NO_GRAVITY);
    const b = solidElement(solidOf('S', { E: 7e4, nu: 0.25 }), DISTORTED, [], NO_GRAVITY);
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 24; c++) expect(b.k[r][c]).toBeCloseTo(7e4 * a.k[r][c], 6);
    }
  });

  it('matches the plain brick for a cube in uniform strain but is softer in bending', () => {
    const el = solidElement(solidOf('S', props), CUBE, [], NO_GRAVITY);
    const plain = plainBrick(CUBE, props);
    // Uniform strain field u = A·x: identical nodal forces.
    const A = [
      [0.01, 0.004, -0.002],
      [0.001, -0.02, 0.006],
      [0.003, -0.005, 0.015],
    ];
    const uniform = CUBE.flatMap((p) => matVec(A, p));
    const f1 = matVec(el.k, uniform);
    const f2 = matVec(plain, uniform);
    for (let i = 0; i < 24; i++) expect(f1[i]).toBeCloseTo(f2[i], 10);
    // Bending mode u_x = (x − ½)(y − ½): strain energy of the exact (ν-coupled) solution of a
    // unit cube is E·κ²·I/2 = E/24; the plain brick stores parasitic shear on top of it.
    const bending = CUBE.flatMap((p) => [(p[0] - 0.5) * (p[1] - 0.5), 0, 0]);
    const energy = (k: number[][]): number => 0.5 * dot3n(bending, matVec(k, bending));
    expect(energy(el.k)).toBeLessThan(0.75 * energy(plain));
    expect(energy(el.k)).toBeGreaterThan(props.E / 24);
  });
});

/** Dot product of two equally long vectors. */
function dot3n(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}

// ---------------------------------------------------------------------------------------
// 2. Patch test
// ---------------------------------------------------------------------------------------

/** A general displacement gradient: all six strains plus a rigid rotation. */
const GRADIENT = [
  [1.1e-3, -0.4e-3, 0.7e-3],
  [0.9e-3, -0.6e-3, 0.2e-3],
  [-0.3e-3, 0.8e-3, 0.5e-3],
];
const SHIFT: Vec3 = [2e-3, -1e-3, 3e-3];

/** Runs the displacement patch test on a distorted n × n × n mesh; returns the largest errors. */
function patchTest(props: Props, n: number, seed: number): { du: number; ds: number } {
  const mesh = distort(boxMesh([n, n, n], [2, 3, 2.5]), 0.17, seed, 'all');
  const exact = (p: Vec3): Vec3 => add(matVec(GRADIENT, p) as Vec3, SHIFT);
  const fixed = new Map<number, number>();
  gridPositions(mesh).forEach((grid, node) => {
    if (grid.some((g) => g === 0 || g === n)) {
      const value = exact(mesh.nodes[node]);
      for (let c = 0; c < 3; c++) fixed.set(dof(node, c), value[c]);
    }
  });
  expect(fixed.size).toBe(3 * ((n + 1) ** 3 - (n - 1) ** 3));
  const sol = solve({ mesh, props, fixed });
  let du = 0;
  mesh.nodes.forEach((p, node) => {
    du = Math.max(du, norm(sub(disp(sol, node), exact(p))));
  });
  const expected = hooke(props.E, props.nu, GRADIENT);
  let ds = 0;
  for (const point of allStressPoints(sol)) {
    tensor(point).forEach((v, i) => (ds = Math.max(ds, Math.abs(v - expected[i]))));
    const principal = principal3(...(expected as [number, number, number, number, number, number]));
    ds = Math.max(ds, Math.abs(point.s1 - principal[0]));
    ds = Math.max(ds, Math.abs(point.s2 - principal[1]));
    ds = Math.max(ds, Math.abs(point.s3 - principal[2]));
    ds = Math.max(
      ds,
      Math.abs(
        point.vonMises -
          vonMises3(...(expected as [number, number, number, number, number, number])),
      ),
    );
  }
  // The free interior nodes are in equilibrium.
  sol.residual.forEach((r, d) => {
    if (!fixed.has(d)) expect(Math.abs(r)).toBeLessThan(1e-9 * props.E);
  });
  return { du, ds };
}

describe('solid patch test', () => {
  it('reproduces a general linear field exactly on a distorted 3 × 3 × 3 mesh', () => {
    // E = 1000 with strains of 1e-3 gives stresses of order 1.
    const { du, ds } = patchTest({ E: 1000, nu: 0.3 }, 3, 11);
    expect(du).toBeLessThan(1e-12);
    expect(ds).toBeLessThan(1e-9);
  });

  it('also passes on a distorted 2 × 2 × 2 mesh and with nu = 0', () => {
    const { du, ds } = patchTest({ E: 1000, nu: 0 }, 2, 5);
    expect(du).toBeLessThan(1e-12);
    expect(ds).toBeLessThan(1e-9);
  });

  it('the mesh used is really distorted (non-planar faces, valid elements)', () => {
    const mesh = distort(boxMesh([3, 3, 3], [2, 3, 2.5]), 0.17, 11, 'all');
    let warped = 0;
    for (const hex of mesh.hexes) {
      const coords = hex.map((i) => mesh.nodes[i]);
      for (const face of SOLID_FACES) {
        const [a, b, c, d] = face.map((i) => coords[i]);
        const n = normalize(cross(sub(b, a), sub(c, a)));
        if (Math.abs(dot(sub(d, a), n)) > 0.02) warped++;
      }
    }
    expect(warped).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------------------
// 3. Uniaxial tension
// ---------------------------------------------------------------------------------------

describe('solid bar in uniaxial tension', () => {
  const props: Props = { E: 200, nu: 0.3 };
  const L = 4;
  const b = 1.5;
  const h = 1;
  const area = b * h;
  const sigma = 0.6;
  const eps = sigma / props.E;

  /** Bar along X, interior nodes moved; rigid-body motion removed without restraining ν. */
  function bar(): { mesh: Mesh; fixed: Map<number, number> } {
    const mesh = distort(boxMesh([4, 2, 2], [L, b, h]), 0.12, 3, 'interior');
    const fixed = new Map<number, number>();
    for (const node of nodesWhere(mesh, (p) => p[0] === 0)) fix(fixed, node, [UX]);
    fix(fixed, mesh.node(0, 0, 0), [UY, UZ]);
    fix(fixed, mesh.node(0, 2, 0), [UZ]);
    return { mesh, fixed };
  }

  function expectUniaxial(sol: Solution, mesh: Mesh, stress: number): void {
    const strain = stress / props.E;
    expectUniformStress(sol, [stress, 0, 0, 0, 0, 0], 1e-10);
    mesh.nodes.forEach((p, node) => {
      const u = disp(sol, node);
      // elongation P·L/(E·A) at x = L and lateral contraction −ν·ε
      expect(u[0]).toBeCloseTo(strain * p[0], 12);
      expect(u[1]).toBeCloseTo(-props.nu * strain * p[1], 12);
      expect(u[2]).toBeCloseTo(-props.nu * strain * p[2], 12);
    });
    for (const r of sol.results) {
      expect(r.center.s1).toBeCloseTo(Math.max(stress, 0), 10);
      expect(r.center.s3).toBeCloseTo(Math.min(stress, 0), 10);
      expect(r.center.s2).toBeCloseTo(0, 10);
      expect(r.maxVonMises).toBeCloseTo(Math.abs(stress), 10);
    }
  }

  it('by a face traction: stress P/A, elongation PL/EA, contraction −ν·ε', () => {
    const { mesh, fixed } = bar();
    const sol = solve({
      mesh,
      props,
      fixed,
      loads: (e, id) =>
        boundaryFaces(mesh, e).includes(4)
          ? [{ kind: 'face', solid: id, face: 4, direction: 'globalX', p: sigma }]
          : [],
    });
    expectUniaxial(sol, mesh, sigma);
    const tip = disp(sol, mesh.node(4, 1, 1));
    expect(tip[0]).toBeCloseTo((sigma * area * L) / (props.E * area), 12);
    expect(eps).toBeCloseTo(tip[0] / L, 12);
    // Reaction at the fixed end balances P = σ·A.
    let reaction = 0;
    for (const node of nodesWhere(mesh, (p) => p[0] === 0)) reaction += sol.residual[dof(node, UX)];
    expect(reaction).toBeCloseTo(-sigma * area, 10);
  });

  it("by a 'normal' pressure: a negative pressure pulls, a positive one compresses", () => {
    const { mesh, fixed } = bar();
    const run = (p: number): Solution =>
      solve({
        mesh,
        props,
        fixed,
        loads: (e, id) =>
          boundaryFaces(mesh, e).includes(4)
            ? [{ kind: 'face', solid: id, face: 4, direction: 'normal', p }]
            : [],
      });
    expectUniaxial(run(-sigma), mesh, sigma);
    expectUniaxial(run(sigma), mesh, -sigma);
  });

  it('by a prescribed end displacement', () => {
    const { mesh, fixed } = bar();
    const delta = eps * L;
    const end = nodesWhere(mesh, (p) => p[0] === L);
    for (const node of end) fix(fixed, node, [UX], delta);
    const sol = solve({ mesh, props, fixed });
    expectUniaxial(sol, mesh, sigma);
    let force = 0;
    for (const node of end) force += sol.residual[dof(node, UX)];
    expect(force).toBeCloseTo(sigma * area, 10);
  });

  it('along the other two axes as well', () => {
    for (const axis of [UY, UZ]) {
      const size: Vec3 = [1, 1, 1];
      size[axis] = 3;
      const dims: [number, number, number] = [1, 1, 1];
      dims[axis] = 3;
      const mesh = boxMesh(dims, size);
      const fixed = new Map<number, number>();
      for (const node of nodesWhere(mesh, (p) => p[axis] === 0)) fix(fixed, node, [axis]);
      const others = [UX, UY, UZ].filter((c) => c !== axis);
      fix(fixed, 0, others);
      // second node on the support face, offset along others[0]: stop the spin about `axis`
      const second = nodesWhere(mesh, (p) => p[axis] === 0 && p[others[0]] === 1)[0];
      fix(fixed, second, [others[1]]);
      const face: SolidFace = axis === UY ? 5 : 2;
      const sol = solve({
        mesh,
        props,
        fixed,
        loads: (e, id) =>
          boundaryFaces(mesh, e).includes(face)
            ? [{ kind: 'face', solid: id, face, direction: 'normal', p: -sigma }]
            : [],
      });
      const expected = [0, 0, 0, 0, 0, 0];
      expected[axis] = sigma;
      expectUniformStress(sol, expected, 1e-10);
      const top = nodesWhere(mesh, (p) => p[axis] === 3);
      for (const node of top) expect(sol.u[dof(node, axis)]).toBeCloseTo(eps * 3, 12);
    }
  });
});

// ---------------------------------------------------------------------------------------
// 4. Hydrostatic pressure
// ---------------------------------------------------------------------------------------

describe('solid block under hydrostatic pressure', () => {
  it('has sxx = syy = szz = −p and the volume change of the bulk modulus', () => {
    const props: Props = { E: 500, nu: 0.25 };
    const p = 2;
    const size: Vec3 = [2, 1.5, 1];
    // Every node except the eight corners is moved, so the loaded surface is warped too.
    const mesh = distort(boxMesh([2, 2, 2], size), 0.08, 8, 'notCorners');
    const fixed = new Map<number, number>();
    fix(fixed, mesh.node(0, 0, 0), [UX, UY, UZ]);
    fix(fixed, mesh.node(2, 0, 0), [UY, UZ]);
    fix(fixed, mesh.node(0, 2, 0), [UZ]);
    const sol = solve({
      mesh,
      props,
      fixed,
      loads: (e, id) =>
        boundaryFaces(mesh, e).map((face) => ({
          kind: 'face',
          solid: id,
          face,
          direction: 'normal',
          p,
        })),
    });
    expectUniformStress(sol, [-p, -p, -p, 0, 0, 0], 1e-10);
    for (const r of sol.results) {
      expect(r.maxVonMises).toBeLessThan(1e-10);
      expect(r.center.s1).toBeCloseTo(-p, 10);
      expect(r.center.s3).toBeCloseTo(-p, 10);
    }
    // Uniform strain ε = −p/(3K) in every direction, K = E / (3(1 − 2ν)).
    const bulk = props.E / (3 * (1 - 2 * props.nu));
    const strain = -p / (3 * bulk);
    mesh.nodes.forEach((x, node) => {
      const u = disp(sol, node);
      for (let c = 0; c < 3; c++) expect(u[c]).toBeCloseTo(strain * x[c], 12);
    });
    // Volume of the deformed mesh: ΔV/V = (1 + ε)³ − 1 ≈ −p/K.
    const before = sol.elements.reduce((sum, el) => sum + el.volume, 0);
    const moved: Mesh = { ...mesh, nodes: mesh.nodes.map((x, node) => add(x, disp(sol, node))) };
    const after = solve({ mesh: moved, props, fixed }).elements.reduce(
      (sum, el) => sum + el.volume,
      0,
    );
    expect(after / before - 1).toBeCloseTo((1 + strain) ** 3 - 1, 12);
    expect(Math.abs((after / before - 1) / (-p / bulk) - 1)).toBeLessThan(0.01);
    // No reaction is needed: the pressure is self-equilibrated.
    for (const [d] of fixed) expect(Math.abs(sol.residual[d])).toBeLessThan(1e-10);
  });
});

// ---------------------------------------------------------------------------------------
// 5. Bending
// ---------------------------------------------------------------------------------------

describe('solid cantilever in bending', () => {
  const L = 10;
  const b = 1;
  const h = 1;
  const I = (b * h ** 3) / 12;
  const area = b * h;

  /**
   * Cantilever along X with ONE element through the depth and the width, clamped at x = 0
   * in a way that leaves the Poisson strains of the beam solution free: ux = uy = 0 on the
   * four root nodes (the anticlastic uy is the same at all four) and uz = 0 at one of them.
   */
  function cantilever(n: number): { mesh: Mesh; fixed: Map<number, number> } {
    const mesh = boxMesh([n, 1, 1], [L, h, b]);
    const fixed = new Map<number, number>();
    for (const node of nodesWhere(mesh, (p) => p[0] === 0)) fix(fixed, node, [UX, UY]);
    fix(fixed, mesh.node(0, 0, 0), [UZ]);
    return { mesh, fixed };
  }

  /** End shear P (downwards) as a uniform traction on the tip face. */
  function endShear(n: number, props: Props, P: number, stiffness?: Problem['stiffness']) {
    const { mesh, fixed } = cantilever(n);
    const sol = solve({
      mesh,
      props,
      fixed,
      stiffness,
      loads: (e, id) =>
        boundaryFaces(mesh, e).includes(4)
          ? [{ kind: 'face', solid: id, face: 4, direction: 'globalY', p: -P / area }]
          : [],
    });
    const tipNodes = nodesWhere(mesh, (p) => p[0] === L);
    const tip = tipNodes.reduce((sum, node) => sum + sol.u[dof(node, UY)], 0) / tipNodes.length;
    return { mesh, sol, tip };
  }

  it.each([5, 10])(
    'end shear, %i elements along the length: tip deflection of Timoshenko beam theory',
    (n) => {
      const props: Props = { E: 1000, nu: 0.3 };
      const P = 1;
      const G = props.E / (2 * (1 + props.nu));
      const theory = -((P * L ** 3) / (3 * props.E * I) + (P * L) / ((5 / 6) * G * area));
      const { tip } = endShear(n, props, P);
      expect(Math.abs(tip / theory - 1)).toBeLessThan(n === 5 ? 0.015 : 0.005);

      // This accuracy needs the incompatible modes: the same mesh of plain 8-node bricks
      // locks in shear and gives less than 45 % (elements 2 × 1 × 1) or 75 % (cubes) of the
      // deflection.
      const plain = endShear(n, props, P, plainBrick);
      expect(plain.tip / theory).toBeLessThan(n === 5 ? 0.45 : 0.75);
      expect(plain.tip / theory).toBeGreaterThan(0.1);
    },
  );

  it('end shear: bending stress along the beam and at the root surface', () => {
    const props: Props = { E: 1000, nu: 0.3 };
    const P = 1;
    const n = 10;
    const { mesh, sol } = endShear(n, props, P);
    // The bending strain of an element is constant along its length (the functions that
    // would let exx vary with x are not there), so every element carries the moment of its
    // mid-length section: there the surface stress is M(x_c)·c/I, to rounding ...
    sol.results.forEach((r, e) => {
      const xc = (mesh.cells[e][0] + 0.5) * (L / n);
      const exact = (P * (L - xc) * (h / 2)) / I;
      // top surface (y = h): mean of the four top corners = value at (x_c, h)
      const top = (r.corners[2].sxx + r.corners[3].sxx + r.corners[6].sxx + r.corners[7].sxx) / 4;
      const bottom =
        (r.corners[0].sxx + r.corners[1].sxx + r.corners[4].sxx + r.corners[5].sxx) / 4;
      expect(Math.abs(top / exact - 1)).toBeLessThan(1e-8);
      expect(Math.abs(bottom / -exact - 1)).toBeLessThan(1e-8);
      expect(Math.abs(r.center.sxx)).toBeLessThan(1e-8 * exact);
      // mean shear stress V/A at the centre
      expect(Math.abs(r.center.txy / (-P / area) - 1)).toBeLessThan(1e-8);
    });
    // ... and at the root section itself the nodal stress lags by about half an element
    // length of moment (plus a small Poisson-coupling effect): 5.5 % below M·c/I with 10
    // elements, 2.7 % with 20. It converges linearly with the element length.
    const rootStress = (P * L * (h / 2)) / I;
    const root = sol.results[0];
    for (const corner of [3, 7]) {
      expect(Math.abs(root.corners[corner].sxx / rootStress - 1)).toBeLessThan(0.055);
    }
    for (const corner of [0, 4]) {
      expect(Math.abs(root.corners[corner].sxx / -rootStress - 1)).toBeLessThan(0.055);
    }
    const fine = endShear(20, props, P).sol.results[0];
    expect(Math.abs(fine.corners[3].sxx / rootStress - 1)).toBeLessThan(0.03);
    expect(Math.abs(fine.corners[0].sxx / -rootStress - 1)).toBeLessThan(0.03);

    // Plain bricks: the root stress is far too low on the same mesh.
    const plain = endShear(n, props, P, plainBrick).sol;
    const plainRoot = solidResult(
      plain.elements[0],
      mesh.hexes[0].flatMap((i) => disp(plain, i)),
    );
    expect(plainRoot.corners[3].sxx / rootStress).toBeLessThan(0.75);
    expect(plainRoot.corners[3].sxx / rootStress).toBeGreaterThan(0.1);
  });

  it.each([0, 0.3])('pure bending by end moments is exact (nu = %f)', (nu) => {
    const props: Props = { E: 1000, nu };
    const M = 2;
    const kappa = M / (props.E * I);
    const sigma0 = (M * (h / 2)) / I;
    // Unequal element lengths: nodes at x = 0, 1.5, 4, 7.5, 10.
    const { mesh: regular, fixed } = cantilever(4);
    const stations = [0, 1.5, 4, 7.5, 10];
    const mesh: Mesh = {
      ...regular,
      nodes: regular.nodes.map((p): Vec3 => [stations[Math.round((p[0] / L) * 4)], p[1], p[2]]),
    };
    // Linearly varying traction sxx = σ0·(2y′/h) on the end face, as consistent nodal forces:
    // ± σ0·b·h/12 on each of the two top / bottom nodes (moment σ0·b·h²/6 = M).
    const nodal = new Map<number, number>();
    for (const node of nodesWhere(mesh, (p) => p[0] === L)) {
      const sign = mesh.nodes[node][1] > h / 2 ? 1 : -1;
      nodal.set(dof(node, UX), (sign * sigma0 * b * h) / 12);
    }
    const sol = solve({ mesh, props, fixed, nodal });
    // Exact solution, y′ = y − h/2 measured from the neutral axis (constant shift removed):
    //   ux = κ·x·y′,  uy = −κ·x²/2 − ν·κ·(y′² − z′²)/2 + const,  uz = −ν·κ·y′·z′ + const
    // with z′ = z − b/2; at the nodes y′² = h²/4 and z′² = b²/4, so that part of uy is constant.
    mesh.nodes.forEach((p, node) => {
      const u = disp(sol, node);
      const y = p[1] - h / 2;
      expect(u[0]).toBeCloseTo(kappa * p[0] * y, 10);
      expect(u[1]).toBeCloseTo((-kappa * p[0] ** 2) / 2, 10);
      expect(u[2]).toBeCloseTo(-nu * kappa * (y * (p[2] - b / 2) - (h * b) / 4), 10);
    });
    // Curvature from the rotation of each cross-section: d(ux)/dy′ = κ·x.
    for (const x of stations) {
      const top = nodesWhere(mesh, (p) => p[0] === x && p[1] === h && p[2] === 0)[0];
      const bottom = nodesWhere(mesh, (p) => p[0] === x && p[1] === 0 && p[2] === 0)[0];
      expect((sol.u[dof(top, UX)] - sol.u[dof(bottom, UX)]) / h).toBeCloseTo(kappa * x, 10);
    }
    // Stress: sxx = ±σ0 at the top / bottom nodes, zero at the centre, nothing else.
    for (const r of sol.results) {
      r.corners.forEach((corner, i) => {
        const top = i === 2 || i === 3 || i === 6 || i === 7;
        expect(corner.sxx).toBeCloseTo(top ? sigma0 : -sigma0, 8);
        for (const key of ['syy', 'szz', 'txy', 'tyz', 'tzx'] as const) {
          expect(corner[key]).toBeCloseTo(0, 8);
        }
        expect(corner.vonMises).toBeCloseTo(sigma0, 8);
        expect(top ? corner.s1 : corner.s3).toBeCloseTo(top ? sigma0 : -sigma0, 8);
      });
      for (const v of tensor(r.center)) expect(v).toBeCloseTo(0, 8);
      expect(r.maxVonMises).toBeCloseTo(sigma0, 8);
    }
  });

  it('pure bending needs the incompatible modes: the plain brick is far too stiff', () => {
    const props: Props = { E: 1000, nu: 0.3 };
    const M = 2;
    const { mesh, fixed } = cantilever(4);
    const nodal = new Map<number, number>();
    for (const node of nodesWhere(mesh, (p) => p[0] === L)) {
      nodal.set(dof(node, UX), ((mesh.nodes[node][1] > h / 2 ? 1 : -1) * M) / (2 * h));
    }
    const exact = (-M * L ** 2) / (2 * props.E * I);
    const tipNode = mesh.node(4, 0, 0);
    const good = solve({ mesh, props, fixed, nodal });
    const plain = solve({ mesh, props, fixed, nodal, stiffness: plainBrick });
    expect(good.u[dof(tipNode, UY)]).toBeCloseTo(exact, 10);
    expect(plain.u[dof(tipNode, UY)] / exact).toBeLessThan(0.35);
    expect(plain.u[dof(tipNode, UY)] / exact).toBeGreaterThan(0.05);
  });
});

// ---------------------------------------------------------------------------------------
// 6. Self-weight
// ---------------------------------------------------------------------------------------

describe('solid self-weight', () => {
  it('total nodal force = density · volume · g for a distorted hex and any g', () => {
    const g: Vec3 = [1.5, -9.81, 0.7];
    const density = 2.4;
    const el = solidElement(solidOf('S', { E: 1, nu: 0.2, density }), DISTORTED, [], g);
    const total = totalForce(el.f);
    for (let c = 0; c < 3; c++) expect(total[c]).toBeCloseTo(density * el.volume * g[c], 12);
    // For a cube the weight is shared equally by the eight nodes.
    const cube = solidElement(solidOf('S', { E: 1, nu: 0.2, density }), CUBE, [], [0, -10, 0]);
    for (let n = 0; n < 8; n++) {
      expect(cube.f[3 * n]).toBe(0);
      expect(cube.f[3 * n + 1]).toBeCloseTo((-density * 10) / 8, 12);
      expect(cube.f[3 * n + 2]).toBe(0);
    }
  });

  it('is zero without a density or without gravity', () => {
    const none = solidElement(solidOf('S', { E: 1, nu: 0.2 }), DISTORTED, [], [0, -9.81, 0]);
    expect(none.f.every((v) => v === 0)).toBe(true);
    const still = solidElement(
      solidOf('S', { E: 1, nu: 0.2, density: 3 }),
      DISTORTED,
      [],
      [0, 0, 0],
    );
    expect(still.f.every((v) => v === 0)).toBe(true);
  });

  it.each([0, 0.3])('column under its own weight (nu = %f)', (nu) => {
    const props: Props = { E: 3000, nu, density: 25 };
    const g = 9.81;
    const height = 8;
    const n = 8;
    const gamma = props.density! * g;
    // Column centred on the Y axis so the exact solution has a flat base at the four nodes.
    const box = boxMesh([1, n, 1], [1, height, 1]);
    const mesh: Mesh = {
      ...box,
      nodes: box.nodes.map((p): Vec3 => [p[0] - 0.5, p[1], p[2] - 0.5]),
    };
    // Exact solution: syy = −γ·(h − y), everything else zero, with
    //   ux = ν·γ·(h − y)·x/E, uz = ν·γ·(h − y)·z/E, uy = γ/E·[−(h·y − y²/2) + ν·(x² + z²)/2].
    // The base nodes get uy = 0 and the exact (ν-driven) lateral displacements.
    const fixed = new Map<number, number>();
    for (const node of nodesWhere(mesh, (p) => p[1] === 0)) {
      const [x, , z] = mesh.nodes[node];
      fixed.set(dof(node, UX), (nu * gamma * height * x) / props.E);
      fixed.set(dof(node, UY), 0);
      fixed.set(dof(node, UZ), (nu * gamma * height * z) / props.E);
    }
    const sol = solve({ mesh, props, fixed, gravity: [0, -g, 0] });

    // Vertical reaction = total weight; average base stress = density·g·h.
    let reaction = 0;
    for (const node of nodesWhere(mesh, (p) => p[1] === 0)) reaction += sol.residual[dof(node, UY)];
    expect(reaction).toBeCloseTo(gamma * height, 9);
    expect(sol.elements.reduce((sum, el) => sum + el.volume, 0)).toBeCloseTo(height, 12);

    // Nodal displacements: uy(top) = −γ·h²/(2E) relative to the base nodes. Exact for ν = 0.
    // For ν ≠ 0 each element has a constant axial stress (no load on the incompatible
    // modes) and therefore wants a constant lateral strain, while the exact lateral strain
    // varies linearly with height: the nodal ux, uz are within half an element of lateral
    // strain, ν·γ·(hₑ/2)·|x|/E, and uy is within 0.1 % of the top displacement.
    const he = height / n;
    const top = (gamma * height ** 2) / (2 * props.E);
    const tolAxial = nu === 0 ? 1e-10 : 1e-3 * top;
    const tolLateral = nu === 0 ? 1e-10 : (nu * gamma * (he / 2) * 0.5) / props.E;
    mesh.nodes.forEach((p, node) => {
      const u = disp(sol, node);
      const lateral = (nu * gamma * (height - p[1])) / props.E;
      expect(Math.abs(u[0] - lateral * p[0])).toBeLessThan(tolLateral);
      expect(Math.abs(u[1] + (gamma * (height * p[1] - p[1] ** 2 / 2)) / props.E)).toBeLessThan(
        tolAxial,
      );
      expect(Math.abs(u[2] - lateral * p[2])).toBeLessThan(tolLateral);
    });

    // Stress: linear in height. No load acts on the incompatible modes, so each element
    // carries the mean of the exact stress: exact at the element centres ...
    if (nu > 0) throw new Error(JSON.stringify(sol.results.map((r) => [r.center.sxx, r.center.syy, r.center.szz, r.center.txy, r.center.tyz, r.center.tzx, r.corners[0].sxx, r.corners[3].sxx].map((v) => +v.toFixed(3)))));
    sol.results.forEach((r, e) => {
      const yc = (mesh.cells[e][1] + 0.5) * he;
      expect(r.center.syy).toBeCloseTo(-gamma * (height - yc), 8);
      for (const key of ['sxx', 'szz', 'txy', 'tyz', 'tzx'] as const) {
        expect(Math.abs(r.center[key])).toBeLessThan(nu === 0 ? 1e-8 : 1e-3 * gamma * height);
      }
      // ... and within half an element of weight at its nodes.
      r.corners.forEach((corner, i) => {
        const y = (mesh.cells[e][1] + (i === 2 || i === 3 || i === 6 || i === 7 ? 1 : 0)) * he;
        expect(Math.abs(corner.syy + gamma * (height - y))).toBeLessThanOrEqual(
          (gamma * he) / 2 + 1e-8,
        );
      });
    });
    // Base stress density·g·h: the base element is within γ·hₑ/2 (1/16 here), and the linear
    // extrapolation of the two lowest element-centre values to y = 0 gives it exactly.
    const base = sol.results[0];
    expect(Math.abs(base.corners[0].syy / (-gamma * height) - 1)).toBeLessThan(1 / (2 * n) + 1e-9);
    const extrapolated = 1.5 * sol.results[0].center.syy - 0.5 * sol.results[1].center.syy;
    expect(extrapolated).toBeCloseTo(-gamma * height, 8);
  });
});

// ---------------------------------------------------------------------------------------
// 7. Face loads
// ---------------------------------------------------------------------------------------

describe('solid face loads', () => {
  const props: Props = { E: 1, nu: 0.2 };
  const FACES: SolidFace[] = [1, 2, 3, 4, 5, 6];
  const DIRECTIONS = ['globalX', 'globalY', 'globalZ'] as const;

  const faceLoad = (
    coords: Vec3[],
    face: SolidFace,
    direction: SolidFaceLoad3D['direction'],
    p: number,
  ): number[] =>
    solidElement(
      solidOf('S', props),
      coords,
      [{ kind: 'face', solid: 'S', face, direction, p }],
      NO_GRAVITY,
    ).f;

  it('SOLID_FACES lists the documented node sets', () => {
    const documented = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 4, 8, 7],
      [4, 1, 5, 8],
    ];
    expect(SOLID_FACES.length).toBe(6);
    SOLID_FACES.forEach((face, i) => {
      expect([...face].sort()).toEqual(documented[i].map((n) => n - 1).sort());
      // Consecutive face nodes share an element edge (differ in one natural coordinate).
      for (let a = 0; a < 4; a++) {
        const p = CUBE[face[a]];
        const q = CUBE[face[(a + 1) % 4]];
        expect(norm(sub(p, q))).toBe(1);
      }
    });
  });

  it('SOLID_FACES normals point outwards for random valid hexes', () => {
    const random = rng(42);
    for (let trial = 0; trial < 20; trial++) {
      const R = rotation([random(), random(), random() + 1.5], 3 * random());
      const coords = CUBE.map((p) =>
        rotate(R, [2 * p[0] + 0.3 * random(), 1.5 * p[1] + 0.3 * random(), p[2] + 0.25 * random()]),
      );
      // valid element: solidElement accepts it
      const el = solidElement(solidOf('S', props), coords, [], NO_GRAVITY);
      expect(el.volume).toBeGreaterThan(0);
      const centroid = scale(
        coords.reduce((sum, p) => add(sum, p), [0, 0, 0] as Vec3),
        1 / 8,
      );
      let closed: Vec3 = [0, 0, 0];
      for (const face of SOLID_FACES) {
        const faceCentre = scale(
          face.reduce((sum, i) => add(sum, coords[i]), [0, 0, 0] as Vec3),
          1 / 4,
        );
        const area = vectorArea(coords, face);
        expect(dot(area, sub(faceCentre, centroid))).toBeGreaterThan(0);
        closed = add(closed, area);
      }
      // The outward vector areas of a closed surface sum to zero.
      expect(norm(closed)).toBeLessThan(1e-12);
    }
  });

  it('total force = p · area for every face and global direction of a box', () => {
    const size: Vec3 = [2, 3, 5];
    const coords = CUBE.map((p): Vec3 => [p[0] * size[0], p[1] * size[1], p[2] * size[2]]);
    // faces 1, 2 are normal to Z; 3, 5 to Y; 4, 6 to X
    const areas = [6, 6, 10, 15, 10, 15];
    const p = 0.7;
    for (const face of FACES) {
      DIRECTIONS.forEach((direction, axis) => {
        const f = faceLoad(coords, face, direction, p);
        const total = totalForce(f);
        for (let c = 0; c < 3; c++) {
          expect(total[c]).toBeCloseTo(c === axis ? p * areas[face - 1] : 0, 12);
        }
        // Uniform load on a rectangle: a quarter on each face node, nothing elsewhere.
        for (let n = 0; n < 8; n++) {
          const onFace = SOLID_FACES[face - 1].includes(n);
          expect(f[3 * n + axis]).toBeCloseTo(onFace ? (p * areas[face - 1]) / 4 : 0, 12);
        }
      });
    }
  });

  it("'normal' pushes into the box on every face", () => {
    const size: Vec3 = [2, 3, 5];
    const coords = CUBE.map((p): Vec3 => [p[0] * size[0], p[1] * size[1], p[2] * size[2]]);
    const p = 0.7;
    // inward normals of faces 1..6
    const inward: Vec3[] = [
      [0, 0, 1],
      [0, 0, -1],
      [0, 1, 0],
      [-1, 0, 0],
      [0, -1, 0],
      [1, 0, 0],
    ];
    const areas = [6, 6, 10, 15, 10, 15];
    for (const face of FACES) {
      const total = totalForce(faceLoad(coords, face, 'normal', p));
      for (let c = 0; c < 3; c++) {
        expect(total[c]).toBeCloseTo(p * areas[face - 1] * inward[face - 1][c], 12);
      }
    }
  });

  it("'normal' on a tilted, non-rectangular planar face acts along its inward normal", () => {
    // Top face (face 5, +Y side) cut by the plane y = 1 + 0.3x − 0.2z over a trapezoid.
    const base: [number, number][] = [
      [0, 0],
      [2, 0],
      [1.6, 1.2],
      [0.3, 1],
    ];
    const plane = (x: number, z: number): number => 1 + 0.3 * x - 0.2 * z;
    // Nodes 1-2-3-4 must have their normal towards 5-8: bottom face at z = const is awkward
    // here, so build the hex with ζ along +Y: nodes 1–4 on y = 0 ordered z-then-x.
    const order = [0, 3, 2, 1];
    const coords: Vec3[] = [
      ...order.map((i): Vec3 => [base[i][0], 0, base[i][1]]),
      ...order.map((i): Vec3 => [base[i][0], plane(base[i][0], base[i][1]), base[i][1]]),
    ];
    const p = 3;
    const outward = normalize([-0.3, 1, 0.2]);
    // Area of the tilted face = plan area / n_y (plan area by the shoelace formula).
    let plan = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, z1] = base[i];
      const [x2, z2] = base[(i + 1) % 4];
      plan += (x1 * z2 - x2 * z1) / 2;
    }
    const area = Math.abs(plan) / outward[1];
    const f = faceLoad(coords, 2, 'normal', p);
    const total = totalForce(f);
    for (let c = 0; c < 3; c++) expect(total[c]).toBeCloseTo(-p * area * outward[c], 12);
    // Every nodal force is along the inward normal, and only the face nodes are loaded.
    for (let n = 0; n < 8; n++) {
      const fn: Vec3 = [f[3 * n], f[3 * n + 1], f[3 * n + 2]];
      if (n < 4) expect(norm(fn)).toBe(0);
      else {
        expect(norm(cross(fn, outward))).toBeLessThan(1e-12);
        expect(dot(fn, outward)).toBeLessThan(0);
      }
    }
    // Global tractions act on the true (tilted) area.
    DIRECTIONS.forEach((direction, axis) => {
      const sum = totalForce(faceLoad(coords, 2, direction, p));
      for (let c = 0; c < 3; c++) expect(sum[c]).toBeCloseTo(c === axis ? p * area : 0, 12);
    });
    // The resultant of a uniform pressure passes through the centroid of the face:
    // moment of the nodal forces about the centroid vanishes.
    const centroid = quadCentroid(coords.slice(4));
    let moment: Vec3 = [0, 0, 0];
    for (let n = 4; n < 8; n++) {
      moment = add(moment, cross(sub(coords[n], centroid), [f[3 * n], f[3 * n + 1], f[3 * n + 2]]));
    }
    expect(norm(moment)).toBeLessThan(1e-12);
  });

  it("'normal' on warped faces: resultant = −p · vector area; loads superpose", () => {
    const p = 1.3;
    let sum: Vec3 = [0, 0, 0];
    for (const face of FACES) {
      const total = totalForce(faceLoad(DISTORTED, face, 'normal', p));
      const expected = scale(vectorArea(DISTORTED, SOLID_FACES[face - 1]), -p);
      for (let c = 0; c < 3; c++) expect(total[c]).toBeCloseTo(expected[c], 12);
      sum = add(sum, total);
    }
    // Pressure on all six faces is self-equilibrated, also in moment.
    const el = solidElement(
      solidOf('S', props),
      DISTORTED,
      FACES.map((face) => ({ kind: 'face', solid: 'S', face, direction: 'normal', p })),
      NO_GRAVITY,
    );
    expect(norm(sum)).toBeLessThan(1e-12);
    expect(norm(totalForce(el.f))).toBeLessThan(1e-12);
    let moment: Vec3 = [0, 0, 0];
    DISTORTED.forEach((x, n) => {
      moment = add(moment, cross(x, [el.f[3 * n], el.f[3 * n + 1], el.f[3 * n + 2]]));
    });
    expect(norm(moment)).toBeLessThan(1e-12);
    // Face loads add to the self-weight.
    const both = solidElement(
      solidOf('S', { ...props, density: 2 }),
      DISTORTED,
      [{ kind: 'face', solid: 'S', face: 2, direction: 'globalY', p }],
      [0, -10, 0],
    );
    const weight = solidElement(solidOf('S', { ...props, density: 2 }), DISTORTED, [], [0, -10, 0]);
    const traction = faceLoad(DISTORTED, 2, 'globalY', p);
    for (let i = 0; i < 24; i++) expect(both.f[i]).toBeCloseTo(weight.f[i] + traction[i], 12);
  });

  it('rejects invalid face loads', () => {
    const bad: SolidFaceLoad3D[] = [
      { kind: 'face', solid: 'S', face: 7 as SolidFace, direction: 'normal', p: 1 },
      { kind: 'face', solid: 'S', face: 0 as SolidFace, direction: 'normal', p: 1 },
      { kind: 'face', solid: 'S', face: 1.5 as SolidFace, direction: 'normal', p: 1 },
      { kind: 'face', solid: 'S', face: 1, direction: 'normal', p: Number.NaN },
      { kind: 'face', solid: 'S', face: 1, direction: 'localZ' as 'normal', p: 1 },
    ];
    for (const load of bad) {
      expect(() => solidElement(solidOf('S', props), CUBE, [load], NO_GRAVITY)).toThrow(
        SolverError,
      );
    }
  });
});

/** Centroid of a planar quadrilateral (area-weighted over its two triangles). */
function quadCentroid(q: Vec3[]): Vec3 {
  const a1 = norm(cross(sub(q[1], q[0]), sub(q[2], q[0]))) / 2;
  const a2 = norm(cross(sub(q[2], q[0]), sub(q[3], q[0]))) / 2;
  const c1 = scale(add(add(q[0], q[1]), q[2]), 1 / 3);
  const c2 = scale(add(add(q[0], q[2]), q[3]), 1 / 3);
  return scale(add(scale(c1, a1), scale(c2, a2)), 1 / (a1 + a2));
}

// ---------------------------------------------------------------------------------------
// 8. Orientation invariance
// ---------------------------------------------------------------------------------------

describe('solid orientation invariance', () => {
  it('a rotated model gives rotated displacements and the same stress invariants', () => {
    const props: Props = { E: 800, nu: 0.28, density: 3 };
    const mesh = distort(boxMesh([3, 2, 2], [3, 1, 1.2]), 0.07, 21, 'all');
    const g: Vec3 = [0.4, -2, 0.9];
    const tipForce: Vec3 = [0.3, -0.5, 0.8];
    const offset: Vec3 = [4, -7, 2];

    function run(R: number[][] | null): Solution {
      const turn = (v: Vec3): Vec3 => (R ? rotate(R, v) : v);
      const model: Mesh = {
        ...mesh,
        nodes: mesh.nodes.map((p) => (R ? add(turn(p), offset) : p)),
      };
      const fixed = new Map<number, number>();
      // Fully fixed root: the same condition in any orientation.
      gridPositions(mesh).forEach((grid, node) => {
        if (grid[0] === 0) fix(fixed, node, [UX, UY, UZ]);
      });
      const nodal = new Map<number, number>();
      const force = turn(tipForce);
      for (let c = 0; c < 3; c++) nodal.set(dof(mesh.node(3, 2, 2), c), force[c]);
      return solve({
        mesh: model,
        props,
        fixed,
        nodal,
        gravity: turn(g),
        loads: (e, id) =>
          boundaryFaces(mesh, e)
            .filter((face) => face === 5 || face === 2)
            .map((face) => ({ kind: 'face', solid: id, face, direction: 'normal', p: 0.6 })),
      });
    }

    const reference = run(null);
    const R = rotation([0.3, -1, 0.6], 2.1);
    const turned = run(R);
    const umax = Math.max(...reference.u.map(Math.abs));
    expect(umax).toBeGreaterThan(1e-4);
    mesh.nodes.forEach((_, node) => {
      const expected = rotate(R, disp(reference, node));
      expect(norm(sub(disp(turned, node), expected))).toBeLessThan(1e-9 * umax);
    });
    reference.results.forEach((r, e) => {
      const t = turned.results[e];
      expect(t.volume).toBeCloseTo(r.volume, 12);
      expect(t.maxVonMises).toBeCloseTo(r.maxVonMises, 9);
      [r.center, ...r.corners].forEach((point, i) => {
        const other = i === 0 ? t.center : t.corners[i - 1];
        expect(other.s1).toBeCloseTo(point.s1, 9);
        expect(other.s2).toBeCloseTo(point.s2, 9);
        expect(other.s3).toBeCloseTo(point.s3, 9);
        expect(other.vonMises).toBeCloseTo(point.vonMises, 9);
        // full tensor: σ′ = R·σ·Rᵀ
        const s = [
          [point.sxx, point.txy, point.tzx],
          [point.txy, point.syy, point.tyz],
          [point.tzx, point.tyz, point.szz],
        ];
        const expected = (i2: number, j2: number): number => {
          let sum = 0;
          for (let a = 0; a < 3; a++) {
            for (let b2 = 0; b2 < 3; b2++) sum += R[i2][a] * s[a][b2] * R[j2][b2];
          }
          return sum;
        };
        expect(other.sxx).toBeCloseTo(expected(0, 0), 9);
        expect(other.syy).toBeCloseTo(expected(1, 1), 9);
        expect(other.szz).toBeCloseTo(expected(2, 2), 9);
        expect(other.txy).toBeCloseTo(expected(0, 1), 9);
        expect(other.tyz).toBeCloseTo(expected(1, 2), 9);
        expect(other.tzx).toBeCloseTo(expected(2, 0), 9);
      });
    });
    // The stresses are not trivial.
    expect(Math.max(...reference.results.map((r) => r.maxVonMises))).toBeGreaterThan(0.5);
  });

  it('renumbering the element (starting from another face) gives the same solution', () => {
    const props: Props = { E: 800, nu: 0.28 };
    // Same hex described with ξ→η→ζ→ξ cyclically permuted: nodes 1,4,8,5 form the first face.
    const perm = [0, 3, 7, 4, 1, 2, 6, 5];
    const a = solidElement(solidOf('S', props), DISTORTED, [], NO_GRAVITY);
    const b = solidElement(
      solidOf('S', props),
      perm.map((i) => DISTORTED[i]),
      [],
      NO_GRAVITY,
    );
    expect(b.volume).toBeCloseTo(a.volume, 12);
    const random = rng(4);
    const u = Array.from({ length: 24 }, () => 0.01 * random());
    const ub = perm.flatMap((i) => u.slice(3 * i, 3 * i + 3));
    const fa = matVec(a.k, u);
    const fb = matVec(b.k, ub);
    perm.forEach((i, n) => {
      for (let c = 0; c < 3; c++) expect(fb[3 * n + c]).toBeCloseTo(fa[3 * i + c], 9);
    });
    const ra = solidResult(a, u);
    const rb = solidResult(b, ub);
    perm.forEach((i, n) => {
      tensor(rb.corners[n]).forEach((v, c) => expect(v).toBeCloseTo(tensor(ra.corners[i])[c], 9));
    });
    tensor(rb.center).forEach((v, c) => expect(v).toBeCloseTo(tensor(ra.center)[c], 9));
  });
});

// ---------------------------------------------------------------------------------------
// 9. Near-incompressible material
// ---------------------------------------------------------------------------------------

describe('solid with nu = 0.49', () => {
  it('still passes the patch test', () => {
    const { du, ds } = patchTest({ E: 1000, nu: 0.49 }, 3, 11);
    expect(du).toBeLessThan(1e-11);
    // λ ≈ 16 000: the stresses are an order of magnitude larger than for ν = 0.3.
    expect(ds).toBeLessThan(1e-9);
  });

  it('gives finite, sensible results in bending', () => {
    const props: Props = { E: 1000, nu: 0.49 };
    const L = 10;
    const mesh = boxMesh([10, 1, 1], [L, 1, 1]);
    const fixed = new Map<number, number>();
    for (const node of nodesWhere(mesh, (p) => p[0] === 0)) fix(fixed, node, [UX, UY]);
    fix(fixed, mesh.node(0, 0, 0), [UZ]);
    const sol = solve({
      mesh,
      props,
      fixed,
      loads: (e, id) =>
        boundaryFaces(mesh, e).includes(4)
          ? [{ kind: 'face', solid: id, face: 4, direction: 'globalY', p: -1 }]
          : [],
    });
    expect(sol.u.every(Number.isFinite)).toBe(true);
    for (const point of allStressPoints(sol)) {
      expect(Object.values(point).every(Number.isFinite)).toBe(true);
    }
    const G = props.E / (2 * (1 + props.nu));
    const theory = -(L ** 3 / (3 * props.E * (1 / 12)) + L / ((5 / 6) * G));
    const tip = sol.u[dof(mesh.node(10, 0, 0), UY)];
    // No volumetric locking in bending: 1.2 % below beam theory (0.4 % for ν = 0.3).
    expect(Math.abs(tip / theory - 1)).toBeLessThan(0.015);
    // The element matrix keeps exactly six zero-energy modes.
    const el = solidElement(solidOf('S', props), DISTORTED, [], NO_GRAVITY);
    const { values } = jacobiEigen(el.k);
    expect(values.every(Number.isFinite)).toBe(true);
    for (let i = 0; i < 6; i++) expect(Math.abs(values[i])).toBeLessThan(1e-10 * values[23]);
    for (let i = 6; i < 24; i++) expect(values[i]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------
// 10. Volume, results and invalid input
// ---------------------------------------------------------------------------------------

describe('solid volume', () => {
  /** Volume by the divergence theorem, V = ⅓·∮ x·n dA, with 3-point Gauss on every face. */
  function surfaceVolume(coords: Vec3[]): number {
    let volume = 0;
    for (const face of SOLID_FACES) {
      const q = face.map((i) => coords[i]);
      const at = (s: number, t: number): Vec3[] => {
        const N = [(1 - s) * (1 - t), (1 + s) * (1 - t), (1 + s) * (1 + t), (1 - s) * (1 + t)];
        const Ns = [-(1 - t), 1 - t, 1 + t, -(1 + t)];
        const Nt = [-(1 - s), -(1 + s), 1 + s, 1 - s];
        const sum = (w: number[]): Vec3 =>
          q.reduce((acc, p, i) => add(acc, scale(p, w[i] / 4)), [0, 0, 0] as Vec3);
        return [sum(N), sum(Ns), sum(Nt)];
      };
      volume += gauss3(
        (s) =>
          gauss3(
            (t) => {
              const [x, xs, xt] = at(s, t);
              return dot(x, cross(xs, xt)) / 3;
            },
            -1,
            1,
          ),
        -1,
        1,
      );
    }
    return volume;
  }

  /** Volume of a planar-faced hex from tetrahedra fanned around its centroid. */
  function tetVolume(coords: Vec3[]): number {
    const centre = scale(
      coords.reduce((sum, p) => add(sum, p), [0, 0, 0] as Vec3),
      1 / 8,
    );
    let volume = 0;
    for (const face of SOLID_FACES) {
      const [a, b, c, d] = face.map((i) => sub(coords[i], centre));
      volume += (dot(a, cross(b, c)) + dot(a, cross(c, d))) / 6;
    }
    return volume;
  }

  it('box, frustum and warped hex', () => {
    const props: Props = { E: 1, nu: 0.3 };
    const vol = (coords: Vec3[]): number =>
      solidElement(solidOf('S', props), coords, [], NO_GRAVITY).volume;
    expect(vol(CUBE.map(([x, y, z]): Vec3 => [2 * x, 3 * y, 5 * z]))).toBeCloseTo(30, 12);
    // Square frustum: base 2 × 2, top 1 × 1, height 3 → V = h/3·(A1 + A2 + √(A1·A2)) = 7.
    const frustum: Vec3[] = [
      [-1, -1, 0],
      [1, -1, 0],
      [1, 1, 0],
      [-1, 1, 0],
      [-0.5, -0.5, 3],
      [0.5, -0.5, 3],
      [0.5, 0.5, 3],
      [-0.5, 0.5, 3],
    ];
    expect(vol(frustum)).toBeCloseTo(7, 12);
    expect(tetVolume(frustum)).toBeCloseTo(7, 12);
    // Planar-faced skew hex (affine image of the frustum): tetrahedra are exact.
    const shear = [
      [1.2, 0.3, -0.2],
      [0.1, 0.9, 0.4],
      [-0.3, 0.2, 1.1],
    ];
    const skew = frustum.map((p) => matVec(shear, p) as Vec3);
    expect(vol(skew)).toBeCloseTo(tetVolume(skew), 12);
    // Warped faces: compare with the surface integral of the bilinear faces.
    expect(vol(DISTORTED)).toBeCloseTo(surfaceVolume(DISTORTED), 12);
    expect(surfaceVolume(CUBE)).toBeCloseTo(1, 12);
    // solidResult reports the same volume and the solid id.
    const el = solidElement(solidOf('brick-7', props), DISTORTED, [], NO_GRAVITY);
    const res = solidResult(el, new Array<number>(24).fill(0));
    expect(res.id).toBe('brick-7');
    expect(res.volume).toBe(el.volume);
    expect(res.corners.length).toBe(8);
    expect(res.maxVonMises).toBe(0);
  });
});

describe('solid results', () => {
  it('extrapolates a linear stress field exactly and reports consistent invariants', () => {
    const props: Props = { E: 1000, nu: 0.3 };
    // Pure bending state of a box about z with one element: sxx = E·κ·(y − ½).
    const size: Vec3 = [2, 1, 1.5];
    const coords = CUBE.map((p): Vec3 => [p[0] * size[0], p[1] * size[1], p[2] * size[2]]);
    const el = solidElement(solidOf('S', props), coords, [], NO_GRAVITY);
    const kappa = 1e-3;
    // Nodal values of the exact bending field (the quadratic parts live in the modes).
    const u = coords.flatMap(([x, y, z]) => {
      const yn = y - 0.5;
      const zn = z - size[2] / 2;
      return [
        kappa * x * yn,
        (-kappa * x * x) / 2 - (props.nu * kappa * (yn * yn - zn * zn)) / 2,
        -props.nu * kappa * yn * zn,
      ];
    });
    const res = solidResult(el, u);
    res.corners.forEach((corner, i) => {
      expect(corner.sxx).toBeCloseTo(props.E * kappa * (coords[i][1] - 0.5), 10);
      expect(Math.abs(corner.syy)).toBeLessThan(1e-10);
      expect(Math.abs(corner.szz)).toBeLessThan(1e-10);
      expect(Math.abs(corner.txy)).toBeLessThan(1e-10);
      const [s1, s2, s3] = principal3(
        corner.sxx,
        corner.syy,
        corner.szz,
        corner.txy,
        corner.tyz,
        corner.tzx,
      );
      expect([corner.s1, corner.s2, corner.s3]).toEqual([s1, s2, s3]);
      expect(corner.s1).toBeGreaterThanOrEqual(corner.s2);
      expect(corner.s2).toBeGreaterThanOrEqual(corner.s3);
      expect(corner.vonMises).toBeCloseTo(Math.abs(corner.sxx), 10);
    });
    expect(Math.abs(res.center.sxx)).toBeLessThan(1e-10);
    expect(res.maxVonMises).toBeCloseTo((props.E * kappa) / 2, 10);
    // The recovered mode amplitudes carry the quadratic terms: for uy the modes (1 − ξ²),
    // (1 − η²), (1 − ζ²) have amplitudes κ·a²/2, ν·κ·b²/2, −ν·κ·c²/2 (half-sizes a, b, c).
    const alpha = matVec(el.modes, u);
    const [a, b, c] = size.map((s) => s / 2);
    expect(alpha[1]).toBeCloseTo((kappa * a * a) / 2, 12);
    expect(alpha[4]).toBeCloseTo((props.nu * kappa * b * b) / 2, 12);
    expect(alpha[7]).toBeCloseTo((-props.nu * kappa * c * c) / 2, 12);
    for (const i of [0, 2, 3, 5, 6, 8]) expect(Math.abs(alpha[i])).toBeLessThan(1e-12);
    // The centre value is the mean of the eight Gauss-point stresses.
    const gauss = el.gaussStress.map((S) => matVec(S, u));
    expect(el.gaussStress.length).toBe(8);
    const mean = gauss.reduce((sum, s) => sum + s[0], 0) / 8;
    expect(res.center.sxx).toBeCloseTo(mean, 12);
    // Gauss point g sits at node g's natural coordinates / √3.
    gauss.forEach((s, gp) => {
      const y = 0.5 + (coords[gp][1] - 0.5) / Math.sqrt(3);
      expect(s[0]).toBeCloseTo(props.E * kappa * (y - 0.5), 10);
    });
  });

  it('rejects a displacement vector of the wrong size', () => {
    const el = solidElement(solidOf('S', { E: 1, nu: 0.3 }), CUBE, [], NO_GRAVITY);
    expect(() => solidResult(el, new Array<number>(23).fill(0))).toThrow(SolverError);
    const bad = new Array<number>(24).fill(0);
    bad[5] = Number.NaN;
    expect(() => solidResult(el, bad)).toThrow(/24 finite displacements/);
  });
});

describe('solid invalid input', () => {
  const props: Props = { E: 1000, nu: 0.3 };

  function expectInvalid(run: () => unknown, pattern: RegExp): void {
    let error: unknown;
    try {
      run();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SolverError);
    const solverError = error as SolverError;
    expect(solverError.code).toBe('INVALID_MODEL');
    expect(solverError.memberId).toBe('bad');
    expect(solverError.message).toMatch(pattern);
    expect(solverError.message).toContain('"bad"');
  }

  const build = (coords: Vec3[], p: Props = props, gravity: Vec3 = NO_GRAVITY): SolidElement =>
    solidElement(solidOf('bad', p), coords, [], gravity);

  it('inverted node ordering explains the expected ordering', () => {
    const ordering = /right-hand normal points towards the\s+opposite face/;
    // faces swapped: 5-6-7-8 listed first
    expectInvalid(() => build([...CUBE.slice(4), ...CUBE.slice(0, 4)]), ordering);
    // both faces listed clockwise
    const clockwise = [0, 3, 2, 1, 4, 7, 6, 5].map((i) => CUBE[i]);
    expectInvalid(() => build(clockwise), ordering);
    // mirrored element
    expectInvalid(() => build(CUBE.map(([x, y, z]): Vec3 => [-x, y, z])), /inverted/);
    // top face twisted by one node relative to the bottom face
    const twisted = [0, 1, 2, 3, 6, 7, 4, 5].map((i) => CUBE[i]);
    expectInvalid(() => build(twisted), /inverted or too distorted/);
  });

  it('degenerate and badly distorted elements', () => {
    // two nodes coincide (collapsed edge → zero Jacobian at that corner)
    const collapsed = CUBE.map((p) => p.slice() as Vec3);
    collapsed[1] = [0, 0, 0];
    expectInvalid(() => build(collapsed), /too distorted/);
    // all nodes in one plane (zero volume)
    expectInvalid(() => build(CUBE.map(([x, y]): Vec3 => [x, y, 0])), /too distorted/);
    // all nodes at one point
    expectInvalid(() => build(CUBE.map((): Vec3 => [1, 1, 1])), /too distorted/);
    // a corner pushed through the opposite side: positive volume overall, negative Jacobian
    // at that corner only (the Gauss points alone would not catch it)
    const folded = CUBE.map((p) => p.slice() as Vec3);
    folded[6] = [0.3, 0.3, 0.3];
    expectInvalid(() => build(folded), /too distorted/);
    // wrong number of nodes, non-finite coordinates
    expectInvalid(() => build(CUBE.slice(0, 7)), /eight node positions, got 7/);
    const nan = CUBE.map((p) => p.slice() as Vec3);
    nan[3][1] = Number.NaN;
    expectInvalid(() => build(nan), /not a finite number/);
    const inf = CUBE.map((p) => p.slice() as Vec3);
    inf[0][0] = Number.POSITIVE_INFINITY;
    expectInvalid(() => build(inf), /not a finite number/);
  });

  it('a mildly concave but valid element is accepted', () => {
    const coords = CUBE.map((p) => p.slice() as Vec3);
    coords[6] = [0.8, 0.8, 0.8];
    expect(build(coords).volume).toBeGreaterThan(0.8);
  });

  it('invalid material properties', () => {
    for (const E of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectInvalid(() => build(CUBE, { E, nu: 0.3 }), /positive modulus/);
    }
    for (const nu of [0.5, 0.6, -1, -1.2, Number.NaN]) {
      expectInvalid(() => build(CUBE, { E: 1000, nu }), /Poisson/);
    }
    expectInvalid(() => build(CUBE, { E: 1000, nu: 0.3, density: Number.NaN }), /density/);
    expectInvalid(() => build(CUBE, props, [0, Number.NaN, 0]), /self-weight/);
    // limits that are allowed
    expect(build(CUBE, { E: 1e-3, nu: -0.9 }).volume).toBeCloseTo(1, 12);
    expect(build(CUBE, { E: 1e9, nu: 0.4999 }).volume).toBeCloseTo(1, 12);
  });

  it('invalid loads carry the solid id', () => {
    const load = (over: Partial<SolidFaceLoad3D>): SolidFaceLoad3D[] => [
      { kind: 'face', solid: 'bad', face: 1, direction: 'normal', p: 1, ...over },
    ];
    const run = (over: Partial<SolidFaceLoad3D>) => () =>
      solidElement(solidOf('bad', props), CUBE, load(over), NO_GRAVITY);
    expectInvalid(run({ face: 9 as SolidFace }), /faces are 1 to 6/);
    expectInvalid(run({ p: Number.POSITIVE_INFINITY }), /invalid intensity/);
    expectInvalid(run({ direction: 'up' as 'normal' }), /unknown direction "up"/);
  });
});
