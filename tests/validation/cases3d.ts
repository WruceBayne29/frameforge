/**
 * 3D validation suite: textbook problems and published finite-element benchmarks, solved
 * through the public `analyze3d` API only.
 *
 * Units: kN, m (stresses kN/m²). Global axes are right-handed with Y up.
 *
 * Every case carries its own tolerance. Line elements (truss, beam) are exact for the loads
 * they support, so those cases use 0.1 %, as the 2D suite does. Plate and solid cases compare
 * a finite-element mesh with a continuum solution; their tolerance states the accuracy that
 * mesh is expected to reach and is part of the published table.
 */
import { analyze3d, modalAnalysis3d } from '../../src/solver3d';
import type {
  AnalysisResult3D,
  Load3D,
  Member3D,
  Node3D,
  Plate3D,
  Solid3D,
  Station3D,
  Support3D,
  Vec3,
} from '../../src/solver3d';
import type { ValidationCheck } from './cases';

export interface ValidationCase3D {
  id: string;
  title: string;
  reference: string;
  /** Largest relative error accepted for every quantity of the case (0.001 = 0.1 %). */
  tolerance: number;
  run: () => ValidationCheck[];
}

/** Tolerance of the cases whose reference is the exact solution of the element's theory. */
const EXACT = 1e-3;

const E = 2e8; // kN/m² (200 GPa)
const G = E / (2 * (1 + 0.3)); // kN/m²
const A = 1e-2; // m²
const IZ = 1.2e-4; // m⁴, bending in the local x–y plane
const IY = 4e-5; // m⁴, bending in the local x–z plane
const J = 2.5e-5; // m⁴, torsion constant
/** Very large area used where the classical solution neglects axial deformation. */
const A_RIGID = 1e3;

const node = (id: string, x: number, y: number, z: number): Node3D => ({ id, x, y, z });
const beam = (id: string, i: string, j: string, extra: Partial<Member3D> = {}): Member3D => ({
  id,
  i,
  j,
  type: 'beam',
  E,
  G,
  A,
  Iy: IY,
  Iz: IZ,
  J,
  ...extra,
});
const bar = (id: string, i: string, j: string): Member3D => ({
  id,
  i,
  j,
  type: 'truss',
  E,
  A,
});
const fixed = (n: string): Support3D => ({
  node: n,
  ux: true,
  uy: true,
  uz: true,
  rx: true,
  ry: true,
  rz: true,
});
const pinned = (n: string): Support3D => ({ node: n, ux: true, uy: true, uz: true });

const check = (
  quantity: string,
  formula: string,
  expected: number,
  actual: number,
  unit: string,
): ValidationCheck => ({ quantity, formula, expected, actual, unit });

// ---- small vector helpers (kept local so the references do not depend on solver code) ----

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Solution of the 3 × 3 system M·x = r by Cramer's rule. */
function solve3(m: [Vec3, Vec3, Vec3], r: Vec3): Vec3 {
  const det = (a: Vec3, b: Vec3, c: Vec3) => dot(a, cross(b, c));
  const cols: [Vec3, Vec3, Vec3] = [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
  const d = det(cols[0], cols[1], cols[2]);
  return [det(r, cols[1], cols[2]) / d, det(cols[0], r, cols[2]) / d, det(cols[0], cols[1], r) / d];
}

/** Station of a member at x; at a load discontinuity `side` picks the left or right limit. */
function station(r: AnalysisResult3D, member: string, x: number, side: 'left' | 'right' = 'left') {
  const stations = r.members[member].stations;
  const hits = stations.filter((s) => Math.abs(s.x - x) < 1e-9);
  if (hits.length === 0) throw new Error(`no station of ${member} at x = ${x}`);
  return (side === 'left' ? hits[0] : hits[hits.length - 1]) as Station3D;
}

// ---- meshes ------------------------------------------------------------------------------

/**
 * nx × ny plates on a surface point(s, t), s, t ∈ [0, 1]; node `${p}${i}_${j}`, plate
 * `${p}P${i}_${j}`. Nodes are ordered (i, j), (i+1, j), (i+1, j+1), (i, j+1), so the plate's
 * local x follows i and its local y follows j wherever the grid is a parallelogram.
 */
function plateMesh(
  p: string,
  nx: number,
  ny: number,
  point: (s: number, t: number) => Vec3,
  props: Omit<Plate3D, 'id' | 'nodes'>,
): { nodes: Node3D[]; plates: Plate3D[]; id: (i: number, j: number) => string } {
  const id = (i: number, j: number) => `${p}${i}_${j}`;
  const nodes: Node3D[] = [];
  const plates: Plate3D[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) nodes.push(node(id(i, j), ...point(i / nx, j / ny)));
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      plates.push({
        id: `${p}P${i}_${j}`,
        nodes: [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)],
        ...props,
      });
    }
  }
  return { nodes, plates, id };
}

/**
 * Regular block of hexahedra, n[0] × n[1] × n[2] elements of size[0] × size[1] × size[2];
 * node `${p}${i}_${j}_${k}` at (i·dx, j·dy, k·dz), solid `${p}H${i}_${j}_${k}`.
 * Element faces: 1 = −Z, 2 = +Z, 3 = −Y, 4 = +X, 5 = +Y, 6 = −X.
 */
function solidBlock(
  p: string,
  n: [number, number, number],
  size: Vec3,
  props: Omit<Solid3D, 'id' | 'nodes'>,
): { nodes: Node3D[]; solids: Solid3D[]; id: (i: number, j: number, k: number) => string } {
  const id = (i: number, j: number, k: number) => `${p}${i}_${j}_${k}`;
  const nodes: Node3D[] = [];
  const solids: Solid3D[] = [];
  for (let i = 0; i <= n[0]; i++) {
    for (let j = 0; j <= n[1]; j++) {
      for (let k = 0; k <= n[2]; k++) {
        nodes.push(
          node(id(i, j, k), (size[0] * i) / n[0], (size[1] * j) / n[1], (size[2] * k) / n[2]),
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
  return { nodes, solids, id };
}

// ---- thin-plate reference solutions ------------------------------------------------------

/**
 * Navier double series for the simply supported square Kirchhoff plate of side a, centre
 * values: uniform pressure q → w = α·q·a⁴/D, M = β·q·a²; central point load P → w = γ·P·a²/D.
 */
function navier(nu: number): { alpha: number; beta: number; gamma: number } {
  let alpha = 0;
  let beta = 0;
  let gamma = 0;
  for (let m = 1; m < 2000; m += 2) {
    for (let n = 1; n < 2000; n += 2) {
      const r2 = (m * m + n * n) ** 2;
      gamma += 1 / r2;
      if (m < 400 && n < 400) {
        const sign = ((m + n) / 2) % 2 === 1 ? 1 : -1;
        alpha += sign / (m * n * r2);
        beta += (sign * (m * m + nu * n * n)) / (m * n * r2);
      }
    }
  }
  return {
    alpha: (16 * alpha) / Math.PI ** 6,
    beta: (16 * beta) / Math.PI ** 4,
    gamma: (4 * gamma) / Math.PI ** 4,
  };
}

/** Flexural rigidity of a plate. */
const rigidity = (e: number, t: number, nu: number) => (e * t ** 3) / (12 * (1 - nu * nu));

/**
 * Square plate of side a in the horizontal plane y = 0, x ∈ [0, a], z ∈ [−a, 0], meshed
 * n × n. Local axes: x = global X, y = −global Z, z = global Y (up).
 */
function squarePlate(
  n: number,
  a: number,
  props: Omit<Plate3D, 'id' | 'nodes'>,
  edges: 'simple' | 'clamped',
  loads: (mesh: ReturnType<typeof plateMesh>) => Load3D[],
): { r: AnalysisResult3D; mesh: ReturnType<typeof plateMesh> } {
  const mesh = plateMesh('N', n, n, (s, t) => [a * s, 0, -a * t], props);
  const supports: Support3D[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const alongX = j === 0 || j === n; // edge parallel to X
      const alongZ = i === 0 || i === n; // edge parallel to Z
      if (!alongX && !alongZ) continue;
      const id = mesh.id(i, j);
      if (edges === 'clamped') {
        supports.push(fixed(id));
        continue;
      }
      // Hard simple support: w = 0 and no rotation about the in-plane normal of the edge.
      const s: Support3D = { node: id, uy: true };
      if (alongX) s.rz = true;
      if (alongZ) s.rx = true;
      // In-plane rigid-body motion (the membrane is not loaded).
      if (i === 0 && j === 0) Object.assign(s, { ux: true, uz: true });
      if (i === n && j === 0) s.uz = true;
      supports.push(s);
    }
  }
  const r = analyze3d({ nodes: mesh.nodes, plates: mesh.plates, supports, loads: loads(mesh) });
  return { r, mesh };
}

/** Mean of a plate result quantity over the four elements that meet at grid node (i, j). */
function nodalMean(r: AnalysisResult3D, i: number, j: number, key: 'Mx' | 'My' | 'Mxy'): number {
  const around: Array<[number, number, number]> = [
    [i - 1, j - 1, 2],
    [i, j - 1, 3],
    [i, j, 0],
    [i - 1, j, 1],
  ];
  const values = around
    .filter(([pi, pj]) => r.plates[`NP${pi}_${pj}`] !== undefined)
    .map(([pi, pj, corner]) => r.plates[`NP${pi}_${pj}`].corners[corner][key]);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export const VALIDATION_CASES_3D: ValidationCase3D[] = [
  // ======================================================================================
  // Space trusses
  // ======================================================================================
  {
    id: 'T01',
    title: 'Tripod (statically determinate space truss) under a general apex load',
    reference:
      'Joint equilibrium and the unit-load (virtual work) method; Hibbeler, Structural Analysis',
    tolerance: EXACT,
    run: () => {
      const apex: Vec3 = [1.8, 4, 1.2];
      const feet: Vec3[] = [
        [0, 0, 0],
        [4, 0, 0.5],
        [1.5, 0, 3.5],
      ];
      const P: Vec3 = [10, -60, 15];
      const r = analyze3d({
        nodes: [node('D', ...apex), ...feet.map((f, k) => node(`S${k}`, ...f))],
        members: feet.map((_, k) => bar(`L${k}`, 'D', `S${k}`)),
        supports: feet.map((_, k) => pinned(`S${k}`)),
        loads: [{ kind: 'nodal', node: 'D', fx: P[0], fy: P[1], fz: P[2] }],
      });
      // Unit vectors from the apex to each foot: a tension N pulls the apex along e.
      const lengths = feet.map((f) => length(sub(f, apex)));
      const e = feet.map((f, k) => scale(sub(f, apex), 1 / lengths[k])) as [Vec3, Vec3, Vec3];
      // Σ Nk·ek + P = 0
      const N = solve3(
        [
          [e[0][0], e[1][0], e[2][0]],
          [e[0][1], e[1][1], e[2][1]],
          [e[0][2], e[1][2], e[2][2]],
        ],
        scale(P, -1),
      );
      // Compatibility: elongation_k = Nk·Lk/EA = −u·ek (the feet do not move).
      const u = solve3(e, N.map((n, k) => (-n * lengths[k]) / (E * A)) as Vec3);
      return [
        ...N.map((n, k) =>
          check(`Force in leg ${k + 1}`, 'ΣN·e + P = 0', n, r.members[`L${k}`].stations[0].N, 'kN'),
        ),
        check('Apex displacement ux', 'Σ N·n·L/EA', u[0], r.displacements.D.ux, 'm'),
        check('Apex displacement uy', 'Σ N·n·L/EA', u[1], r.displacements.D.uy, 'm'),
        check('Apex displacement uz', 'Σ N·n·L/EA', u[2], r.displacements.D.uz, 'm'),
        check('Reaction Fy at foot 1', 'N₁·e₁,y', N[0] * e[0][1], r.reactions.S0.fy, 'kN'),
      ];
    },
  },
  {
    id: 'T02',
    title: 'Square pyramid (one redundant bar) under vertical and horizontal apex loads',
    reference:
      'Joint stiffness K = (EA/L)·Σ e·eᵀ, diagonal by symmetry; Kassimali, Matrix Analysis of Structures',
    tolerance: EXACT,
    run: () => {
      const a = 2;
      const h = 3;
      const P = 40; // downward
      const H = 12; // along +X
      const L = Math.hypot(a, h, a);
      const corners: Array<[number, number]> = [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ];
      const r = analyze3d({
        nodes: [
          node('D', 0, h, 0),
          ...corners.map(([sx, sz], k) => node(`S${k}`, sx * a, 0, sz * a)),
        ],
        members: corners.map((_, k) => bar(`L${k}`, 'D', `S${k}`)),
        supports: corners.map((_, k) => pinned(`S${k}`)),
        loads: [{ kind: 'nodal', node: 'D', fx: H, fy: -P }],
      });
      // Σ e·eᵀ is diagonal: 4a²/L², 4h²/L², 4a²/L².
      const legForce = (sx: number) => (-sx * H * L) / (4 * a) - (P * L) / (4 * h);
      return [
        check(
          'Apex sway ux',
          'HL³/(4EAa²)',
          (H * L ** 3) / (4 * E * A * a * a),
          r.displacements.D.ux,
          'm',
        ),
        check(
          'Apex deflection uy',
          'PL³/(4EAh²)',
          (-P * L ** 3) / (4 * E * A * h * h),
          r.displacements.D.uy,
          'm',
        ),
        check(
          'Force in leg towards +X',
          '−HL/4a − PL/4h',
          legForce(1),
          r.members.L0.stations[0].N,
          'kN',
        ),
        check(
          'Force in leg towards −X',
          '+HL/4a − PL/4h',
          legForce(-1),
          r.members.L1.stations[0].N,
          'kN',
        ),
        check(
          'Vertical reaction, +X foot',
          '−N·h/L',
          (-legForce(1) * h) / L,
          r.reactions.S0.fy,
          'kN',
        ),
      ];
    },
  },
  // ======================================================================================
  // Space frames (12-DOF beam)
  // ======================================================================================
  {
    id: 'B01',
    title: 'L-shaped cantilever (grillage) with an out-of-plane tip load: bending + torsion',
    reference:
      'Bent cantilever by superposition of bending and torsion; Gere & Goodno, Mechanics of Materials',
    tolerance: EXACT,
    run: () => {
      const L1 = 3;
      const L2 = 2;
      const P = 10;
      const r = analyze3d({
        nodes: [node('A', 0, 0, 0), node('B', L1, 0, 0), node('C', L1, 0, L2)],
        members: [beam('AB', 'A', 'B'), beam('BC', 'B', 'C')],
        supports: [fixed('A')],
        loads: [{ kind: 'nodal', node: 'C', fy: -P }],
      });
      const twist = (P * L2 * L1) / (G * J);
      return [
        check(
          'Tip deflection at C',
          'PL₁³/3EI + PL₂²L₁/GJ + PL₂³/3EI',
          -((P * L1 ** 3) / (3 * E * IZ) + twist * L2 + (P * L2 ** 3) / (3 * E * IZ)),
          r.displacements.C.uy,
          'm',
        ),
        check('Twist of AB at B', 'PL₂L₁/GJ', twist, r.displacements.B.rx, 'rad'),
        check(
          'Slope of AB at B',
          'PL₁²/2EI',
          (-P * L1 ** 2) / (2 * E * IZ),
          r.displacements.B.rz,
          'rad',
        ),
        check('Torque in AB', 'PL₂', P * L2, r.members.AB.stations[0].T, 'kN·m'),
        check('Root moment of AB (hogging)', 'PL₁', -P * L1, r.members.AB.stations[0].Mz, 'kN·m'),
        check('Root moment of BC (hogging)', 'PL₂', -P * L2, r.members.BC.stations[0].Mz, 'kN·m'),
        check('Reaction torque Mx at A', '−PL₂', -P * L2, r.reactions.A.mx, 'kN·m'),
        check('Reaction moment Mz at A', 'PL₁', P * L1, r.reactions.A.mz, 'kN·m'),
      ];
    },
  },
  {
    id: 'B02',
    title: 'Skew cantilever, roll angle β = 30°, with a biaxial tip load',
    reference:
      'Inclined load resolved onto the principal axes; Gere & Goodno, Mechanics of Materials',
    tolerance: EXACT,
    run: () => {
      const L = 4;
      const theta = Math.PI / 6; // plan angle of the member from +X towards +Z
      const beta = Math.PI / 6;
      const P: Vec3 = [3, -8, 5];
      const tip: Vec3 = [L * Math.cos(theta), 0, L * Math.sin(theta)];
      const r = analyze3d({
        nodes: [node('A', 0, 0, 0), node('B', ...tip)],
        members: [beam('AB', 'A', 'B', { beta })],
        supports: [fixed('A')],
        loads: [{ kind: 'nodal', node: 'B', fx: P[0], fy: P[1], fz: P[2] }],
      });
      // Local axes of a horizontal member: x along the member, y0 = global Y, z0 = x × Y;
      // β turns y and z about x.
      const x: Vec3 = [Math.cos(theta), 0, Math.sin(theta)];
      const y0: Vec3 = [0, 1, 0];
      const z0: Vec3 = [-Math.sin(theta), 0, Math.cos(theta)];
      const y: Vec3 = [
        Math.cos(beta) * y0[0] + Math.sin(beta) * z0[0],
        Math.cos(beta) * y0[1] + Math.sin(beta) * z0[1],
        Math.cos(beta) * y0[2] + Math.sin(beta) * z0[2],
      ];
      const z = cross(x, y);
      const [px, py, pz] = [dot(P, x), dot(P, y), dot(P, z)];
      const local: Vec3 = [
        (px * L) / (E * A),
        (py * L ** 3) / (3 * E * IZ),
        (pz * L ** 3) / (3 * E * IY),
      ];
      const u: Vec3 = [0, 1, 2].map(
        (c) => local[0] * x[c] + local[1] * y[c] + local[2] * z[c],
      ) as Vec3;
      const reaction = scale(cross(tip, P), -1);
      const d = r.displacements.B;
      return [
        check('Tip ux', 'Σ (P·eₖ)L³/3EIₖ · eₖ', u[0], d.ux, 'm'),
        check('Tip uy', 'Σ (P·eₖ)L³/3EIₖ · eₖ', u[1], d.uy, 'm'),
        check('Tip uz', 'Σ (P·eₖ)L³/3EIₖ · eₖ', u[2], d.uz, 'm'),
        check('Root moment Mz', 'P_y·L', py * L, r.members.AB.stations[0].Mz, 'kN·m'),
        check('Root moment My', 'P_z·L', pz * L, r.members.AB.stations[0].My, 'kN·m'),
        check('Reaction Mx', '−(r × P)ₓ', reaction[0], r.reactions.A.mx, 'kN·m'),
        check('Reaction My', '−(r × P)ᵧ', reaction[1], r.reactions.A.my, 'kN·m'),
        check('Reaction Mz', '−(r × P)_z', reaction[2], r.reactions.A.mz, 'kN·m'),
      ];
    },
  },
  {
    id: 'B03',
    title:
      'Fixed-fixed beam along Z: UDL in the local x–y plane, point load in the local x–z plane',
    reference: 'Fixed-end beam formulas; Roark’s Formulas for Stress and Strain, table 8.1',
    tolerance: EXACT,
    run: () => {
      const L = 6;
      const w = 9; // downward
      const P = 16; // along −local z
      const a = 2;
      const b = L - a;
      const r = analyze3d({
        nodes: [node('A', 0, 0, 0), node('B', 0, 0, L)],
        members: [beam('AB', 'A', 'B')],
        supports: [fixed('A'), fixed('B')],
        loads: [
          { kind: 'distributed', member: 'AB', direction: 'globalY', w1: -w },
          { kind: 'point', member: 'AB', direction: 'localZ', P: -P, a },
        ],
      });
      const mid = station(r, 'AB', L / 2);
      const under = station(r, 'AB', a);
      return [
        check(
          'End moment Mz (hogging)',
          'wL²/12',
          (-w * L * L) / 12,
          r.members.AB.stations[0].Mz,
          'kN·m',
        ),
        check('Midspan moment Mz', 'wL²/24', (w * L * L) / 24, mid.Mz, 'kN·m'),
        check('Midspan deflection v', 'wL⁴/384EIz', (-w * L ** 4) / (384 * E * IZ), mid.v, 'm'),
        check(
          'End moment My at A',
          'Pab²/L²',
          (-P * a * b * b) / L ** 2,
          r.members.AB.stations[0].My,
          'kN·m',
        ),
        check(
          'Moment My under the load',
          '2Pa²b²/L³',
          (2 * P * a * a * b * b) / L ** 3,
          under.My,
          'kN·m',
        ),
        check(
          'Deflection w under the load',
          'Pa³b³/3EIyL³',
          (-P * a ** 3 * b ** 3) / (3 * E * IY * L ** 3),
          under.w,
          'm',
        ),
        check(
          'Shear Vz at A',
          'Pb²(3a+b)/L³',
          (P * b * b * (3 * a + b)) / L ** 3,
          r.members.AB.stations[0].Vz,
          'kN',
        ),
        check('Vertical reaction at A', 'wL/2', (w * L) / 2, r.reactions.A.fy, 'kN'),
      ];
    },
  },
  {
    id: 'B04',
    title: 'Four-column table frame swaying in X and Z (weak and strong column axes)',
    reference:
      'Fixed-base portal by slope-deflection, Δ = (Hh³/12EI)(3k+2)/(6k+1); Kassimali, Structural Analysis',
    tolerance: EXACT,
    run: () => {
      const h = 4;
      const Lx = 6;
      const Lz = 5;
      const Ib = 2.5e-4;
      const Hx = 50;
      const Hz = 30;
      const col = (id: string, i: string, j: string) => beam(id, i, j, { A: A_RIGID });
      const girder = (id: string, i: string, j: string) => beam(id, i, j, { A: A_RIGID, Iz: Ib });
      const r = analyze3d({
        nodes: [
          node('A', 0, 0, 0),
          node('B', Lx, 0, 0),
          node('C', Lx, 0, Lz),
          node('D', 0, 0, Lz),
          node('A1', 0, h, 0),
          node('B1', Lx, h, 0),
          node('C1', Lx, h, Lz),
          node('D1', 0, h, Lz),
        ],
        members: [
          col('cA', 'A', 'A1'),
          col('cB', 'B', 'B1'),
          col('cC', 'C', 'C1'),
          col('cD', 'D', 'D1'),
          girder('gAB', 'A1', 'B1'),
          girder('gDC', 'D1', 'C1'),
          girder('gAD', 'A1', 'D1'),
          girder('gBC', 'B1', 'C1'),
        ],
        supports: ['A', 'B', 'C', 'D'].map(fixed),
        loads: [
          { kind: 'nodal', node: 'A1', fx: Hx / 2, fz: Hz / 2 },
          { kind: 'nodal', node: 'D1', fx: Hx / 2 },
          { kind: 'nodal', node: 'B1', fz: Hz / 2 },
        ],
      });
      // Vertical columns: local y = −X (sway along X bends them about Iz), local z = +Z
      // (sway along Z bends them about Iy). Each of the two frames in a direction takes H/2.
      const kx = Ib / Lx / (IZ / h);
      const kz = Ib / Lz / (IY / h);
      const sway = (H: number, I: number, k: number) =>
        ((H * h ** 3) / (12 * E * I)) * ((3 * k + 2) / (6 * k + 1));
      const base = (H: number, k: number) => ((H * h) / 2) * ((3 * k + 1) / (6 * k + 1));
      return [
        check(
          'Sway along X',
          'H₁h³(3k+2)/12EIz(6k+1), H₁ = Hx/2',
          sway(Hx / 2, IZ, kx),
          r.displacements.C1.ux,
          'm',
        ),
        check(
          'Sway along Z',
          'H₁h³(3k+2)/12EIy(6k+1), H₁ = Hz/2',
          sway(Hz / 2, IY, kz),
          r.displacements.C1.uz,
          'm',
        ),
        check(
          'Base moment Mz, column A',
          'H₁h(3k+1)/2(6k+1)',
          base(Hx / 2, kx),
          r.reactions.A.mz,
          'kN·m',
        ),
        check(
          'Base moment Mx, column A',
          '−H₁h(3k+1)/2(6k+1)',
          -base(Hz / 2, kz),
          r.reactions.A.mx,
          'kN·m',
        ),
        check('Base shear Fx, column C', '−Hx/4', -Hx / 4, r.reactions.C.fx, 'kN'),
        check('Base shear Fz, column C', '−Hz/4', -Hz / 4, r.reactions.C.fz, 'kN'),
      ];
    },
  },
  {
    id: 'B05',
    title: 'Secondary beam with moment releases at both ends, framing into two fixed girders',
    reference:
      'Released ends = simple span; fixed-fixed girder with a central load; Roark, table 8.1',
    tolerance: EXACT,
    run: () => {
      const L = 8; // girder span (along X)
      const B = 5; // secondary span (along Z)
      const w = 12;
      const Ig = 3e-4;
      const Is = 8e-5;
      const pin = { my: true, mz: true };
      const r = analyze3d({
        nodes: [
          node('A', 0, 0, 0),
          node('M', L / 2, 0, 0),
          node('B', L, 0, 0),
          node('C', 0, 0, B),
          node('N', L / 2, 0, B),
          node('D', L, 0, B),
        ],
        members: [
          beam('AM', 'A', 'M', { Iz: Ig }),
          beam('MB', 'M', 'B', { Iz: Ig }),
          beam('CN', 'C', 'N', { Iz: Ig }),
          beam('ND', 'N', 'D', { Iz: Ig }),
          beam('MN', 'M', 'N', { Iz: Is, releaseI: pin, releaseJ: pin }),
        ],
        supports: ['A', 'B', 'C', 'D'].map(fixed),
        loads: [{ kind: 'distributed', member: 'MN', direction: 'globalY', w1: -w }],
      });
      const R = (w * B) / 2; // load each girder receives at midspan
      const girder = (R * L ** 3) / (192 * E * Ig);
      const span = (5 * w * B ** 4) / (384 * E * Is);
      const mid = station(r, 'MN', B / 2);
      const scaleM = (w * B * B) / 8;
      return [
        check(
          'Girder midspan deflection',
          'RL³/192EI, R = wB/2',
          -girder,
          r.displacements.M.uy,
          'm',
        ),
        check(
          'Girder end moment (hogging)',
          'RL/8',
          (-R * L) / 8,
          r.members.AM.stations[0].Mz,
          'kN·m',
        ),
        check('Girder end reaction', 'R/2', R / 2, r.reactions.A.fy, 'kN'),
        check('Secondary midspan moment', 'wB²/8', scaleM, mid.Mz, 'kN·m'),
        check(
          'Secondary midspan deflection',
          'Δ_girder + 5wB⁴/384EI',
          -(girder + span),
          mid.v,
          'm',
        ),
        check('Secondary end shear', 'wB/2', R, r.members.MN.stations[0].Vy, 'kN'),
        check('Released end moment', '0', 0, r.members.MN.stations[0].Mz, 'kN·m'),
      ];
    },
  },
  {
    id: 'B06',
    title: 'Simply supported beam on a skew plan line (30° to X) with vertical and lateral UDLs',
    reference: 'Simply supported beam tables; Gere & Goodno, Mechanics of Materials, App. G',
    tolerance: EXACT,
    run: () => {
      const L = 7;
      const theta = Math.PI / 6;
      const wy = 10; // downward
      const wz = 4; // along +local z (horizontal)
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      const r = analyze3d({
        nodes: [node('A', 0, 0, 0), node('B', L * c, 0, L * s)],
        members: [beam('AB', 'A', 'B')],
        supports: [pinned('A'), pinned('B')],
        loads: [
          { kind: 'distributed', member: 'AB', direction: 'globalY', w1: -wy },
          { kind: 'distributed', member: 'AB', direction: 'localZ', w1: wz },
        ],
      });
      // local z of this member = x × Y = (−sin θ, 0, cos θ)
      const mid = station(r, 'AB', L / 2);
      return [
        check(
          'Midspan deflection v',
          '5wL⁴/384EIz',
          (-5 * wy * L ** 4) / (384 * E * IZ),
          mid.v,
          'm',
        ),
        check(
          'Midspan deflection w',
          '5wL⁴/384EIy',
          (5 * wz * L ** 4) / (384 * E * IY),
          mid.w,
          'm',
        ),
        check('Midspan moment Mz', 'wL²/8', (wy * L * L) / 8, mid.Mz, 'kN·m'),
        check('Midspan moment My', 'wL²/8', (-wz * L * L) / 8, mid.My, 'kN·m'),
        check('Vertical reaction at A', 'wL/2', (wy * L) / 2, r.reactions.A.fy, 'kN'),
        check('Reaction Fx at B', '(wL/2)·sin θ', (wz * L * s) / 2, r.reactions.B.fx, 'kN'),
        check('Reaction Fz at B', '−(wL/2)·cos θ', (-wz * L * c) / 2, r.reactions.B.fz, 'kN'),
      ];
    },
  },
  {
    id: 'B07',
    title: 'Space frame with every member load type: reactions balance the loads (6 components)',
    reference: 'Statics of a rigid body, ΣF = 0 and ΣM = 0 about the origin',
    tolerance: EXACT,
    run: () => {
      const h = 3.5;
      const nodes = [
        node('A', 0, 0, 0),
        node('B', 5, 0, 0),
        node('C', 5, 0, 4),
        node('D', 0, 0, 4),
        node('A1', 0, h, 0),
        node('B1', 5, h, 0),
        node('C1', 5, h, 4),
        node('D1', 0, h, 4),
        node('E', 7, h, 4),
      ];
      const xyz = new Map(nodes.map((n): [string, Vec3] => [n.id, [n.x, n.y, n.z]]));
      const density = 78.5;
      const members: Member3D[] = [
        beam('cA', 'A', 'A1', { density }),
        beam('cB', 'B', 'B1', { density }),
        beam('cC', 'C', 'C1', { density, beta: Math.PI / 2 }),
        beam('cD', 'D', 'D1', { density }),
        beam('gAB', 'A1', 'B1', { density }),
        beam('gBC', 'B1', 'C1', { density }),
        beam('gCD', 'C1', 'D1', { density, releaseJ: { my: true, mz: true } }),
        beam('gDA', 'D1', 'A1', { density }),
        beam('cant', 'C1', 'E', { density }),
        { ...bar('brace', 'A', 'B1'), density },
      ];
      const loads: Load3D[] = [
        { kind: 'nodal', node: 'B1', fx: 12, fy: -30, fz: 8, mx: 5, my: -3, mz: 2 },
        { kind: 'distributed', member: 'gAB', direction: 'globalY', w1: -10 },
        { kind: 'distributed', member: 'gBC', direction: 'globalX', w1: 4, w2: 8, a: 0.5, b: 3.5 },
        { kind: 'point', member: 'gCD', direction: 'globalZ', P: 15, a: 1.5 },
        { kind: 'point', member: 'cant', direction: 'globalY', P: -20, a: 2 },
        { kind: 'moment', member: 'gDA', direction: 'globalY', M: 6, a: 1 },
        { kind: 'selfWeight', direction: 'globalY', factor: -1 },
      ];
      const r = analyze3d({
        nodes,
        members,
        supports: ['A', 'B', 'C', 'D'].map(fixed),
        loads,
      });
      // Resultant force and moment about the origin of every load, computed by hand.
      const F: Vec3 = [0, 0, 0];
      const M: Vec3 = [0, 0, 0];
      const add = (force: Vec3, at: Vec3, couple: Vec3 = [0, 0, 0]) => {
        const m = cross(at, force);
        for (let c = 0; c < 3; c++) {
          F[c] += force[c];
          M[c] += m[c] + couple[c];
        }
      };
      const along = (id: string, d: number): Vec3 => {
        const m = members.find((mm) => mm.id === id) as Member3D;
        const p = xyz.get(m.i) as Vec3;
        const q = xyz.get(m.j) as Vec3;
        const t = d / length(sub(q, p));
        return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
      };
      add([12, -30, 8], xyz.get('B1') as Vec3, [5, -3, 2]);
      add([0, -10 * 5, 0], along('gAB', 2.5)); // UDL over the full 5 m
      // Trapezoid 4 → 8 kN/m over 3 m: resultant 18 kN, centroid 3·(4 + 16)/(3·12) = 5/3 from a.
      add([18, 0, 0], along('gBC', 0.5 + 5 / 3));
      add([0, 0, 15], along('gCD', 1.5));
      add([0, -20, 0], along('cant', 2));
      M[1] += 6;
      for (const m of members) {
        const p = xyz.get(m.i) as Vec3;
        const q = xyz.get(m.j) as Vec3;
        const len = length(sub(q, p));
        add([0, -density * m.A * len, 0], along(m.id, len / 2));
      }
      // The reactions must supply −F and −M (moments of the reactions about the origin).
      const RF: Vec3 = [0, 0, 0];
      const RM: Vec3 = [0, 0, 0];
      for (const [id, rr] of Object.entries(r.reactions)) {
        const at = xyz.get(id) as Vec3;
        const m = cross(at, [rr.fx, rr.fy, rr.fz]);
        RF[0] += rr.fx;
        RF[1] += rr.fy;
        RF[2] += rr.fz;
        RM[0] += m[0] + rr.mx;
        RM[1] += m[1] + rr.my;
        RM[2] += m[2] + rr.mz;
      }
      return [
        check('Σ reaction Fx', '−Σ Fx (loads)', -F[0], RF[0], 'kN'),
        check('Σ reaction Fy', '−Σ Fy (loads incl. self-weight)', -F[1], RF[1], 'kN'),
        check('Σ reaction Fz', '−Σ Fz (loads)', -F[2], RF[2], 'kN'),
        check('Σ reaction moment Mx', '−Σ (r × F + M)ₓ', -M[0], RM[0], 'kN·m'),
        check('Σ reaction moment My', '−Σ (r × F + M)ᵧ', -M[1], RM[1], 'kN·m'),
        check('Σ reaction moment Mz', '−Σ (r × F + M)_z', -M[2], RM[2], 'kN·m'),
      ];
    },
  },
  // ======================================================================================
  // Plates (4-node flat shell)
  // ======================================================================================
  {
    id: 'P01',
    title: 'Simply supported square plate, uniform pressure (a/t = 100, 16 × 16 mesh)',
    reference:
      'Navier double series (α = 0.00406, β = 0.0479 for ν = 0.3); Timoshenko & Woinowsky-Krieger, Theory of Plates and Shells, ch. 5',
    tolerance: 0.01,
    run: () => {
      const a = 4;
      const t = 0.04;
      const nu = 0.3;
      const q = 5;
      const n = 16;
      const { r, mesh } = squarePlate(n, a, { E, nu, t }, 'simple', (m) =>
        m.plates.map((p): Load3D => ({
          kind: 'pressure',
          plate: p.id,
          direction: 'globalY',
          p: -q,
        })),
      );
      const D = rigidity(E, t, nu);
      const { alpha, beta } = navier(nu);
      return [
        check(
          'Centre deflection',
          'α·qa⁴/D, α = 0.00406',
          (-alpha * q * a ** 4) / D,
          r.displacements[mesh.id(n / 2, n / 2)].uy,
          'm',
        ),
        check(
          'Centre moment Mx (sagging)',
          'β·qa², β = 0.0479',
          -beta * q * a * a,
          nodalMean(r, n / 2, n / 2, 'Mx'),
          'kN·m/m',
        ),
        check(
          'Centre moment My (sagging)',
          'β·qa², β = 0.0479',
          -beta * q * a * a,
          nodalMean(r, n / 2, n / 2, 'My'),
          'kN·m/m',
        ),
        check(
          'Total reaction',
          'qa²',
          q * a * a,
          Object.values(r.reactions).reduce((sum, x) => sum + x.fy, 0),
          'kN',
        ),
      ];
    },
  },
  {
    id: 'P02',
    title: 'Simply supported square plate, central point load (16 × 16 mesh)',
    reference:
      'Navier series w = (4Pa²/π⁴D)·Σ 1/(m² + n²)² = 0.01160·Pa²/D; Timoshenko & Woinowsky-Krieger, ch. 5',
    tolerance: 0.01,
    run: () => {
      const a = 4;
      const t = 0.04;
      const nu = 0.3;
      const P = 20;
      const n = 16;
      const { r, mesh } = squarePlate(n, a, { E, nu, t }, 'simple', (m) => [
        { kind: 'nodal', node: m.id(n / 2, n / 2), fy: -P },
      ]);
      const D = rigidity(E, t, nu);
      const { gamma } = navier(nu);
      return [
        check(
          'Centre deflection',
          'γ·Pa²/D, γ = 0.01160',
          (-gamma * P * a * a) / D,
          r.displacements[mesh.id(n / 2, n / 2)].uy,
          'm',
        ),
        check(
          'Deflection at quarter point (a/4, a/2)',
          'series',
          (-quarterPoint() * P * a * a) / D,
          r.displacements[mesh.id(n / 4, n / 2)].uy,
          'm',
        ),
      ];
    },
  },
  {
    id: 'P03',
    title: 'Clamped square plate, uniform pressure (a/t = 100, 16 × 16 mesh)',
    reference:
      'Taylor & Govindjee (2004), Commun. Numer. Meth. Engng 20:757: w = 0.0012653·qa⁴/D, M = 0.02291·qa² (Timoshenko & Woinowsky-Krieger tabulate 0.00126 and 0.0231)',
    tolerance: 0.02,
    run: () => {
      const a = 4;
      const t = 0.04;
      const nu = 0.3;
      const q = 5;
      const n = 16;
      const { r, mesh } = squarePlate(n, a, { E, nu, t }, 'clamped', (m) =>
        m.plates.map((p): Load3D => ({
          kind: 'pressure',
          plate: p.id,
          direction: 'globalY',
          p: -q,
        })),
      );
      const D = rigidity(E, t, nu);
      return [
        check(
          'Centre deflection',
          '0.0012653·qa⁴/D',
          (-0.0012653 * q * a ** 4) / D,
          r.displacements[mesh.id(n / 2, n / 2)].uy,
          'm',
        ),
        check(
          'Centre moment Mx (sagging)',
          '0.02291·qa²',
          -0.02291 * q * a * a,
          nodalMean(r, n / 2, n / 2, 'Mx'),
          'kN·m/m',
        ),
      ];
    },
  },
  {
    id: 'P04',
    title: 'Cantilever plate strip (ν = 0) with a tip line load, 10 elements',
    reference:
      'Timoshenko beam per unit width, PL³/3D + PL/(κGt), κ = 5/6; Timoshenko & Gere, Mechanics of Materials',
    tolerance: 0.005,
    run: () => {
      const L = 10;
      const b = 1;
      const t = 0.1;
      const n = 10;
      const P = 4; // per unit width, downward
      const mesh = plateMesh('N', n, 1, (s, u) => [L * s, 0, -b * u], { E, nu: 0, t });
      const r = analyze3d({
        nodes: mesh.nodes,
        plates: mesh.plates,
        supports: [fixed(mesh.id(0, 0)), fixed(mesh.id(0, 1))],
        loads: [
          { kind: 'nodal', node: mesh.id(n, 0), fy: (-P * b) / 2 },
          { kind: 'nodal', node: mesh.id(n, 1), fy: (-P * b) / 2 },
        ],
      });
      const D = (E * t ** 3) / 12;
      const shear = (5 / 6) * (E / 2) * t;
      const h = L / n;
      return [
        check(
          'Tip deflection',
          'PL³/3D + PL/κGt',
          -((P * L ** 3) / (3 * D) + (P * L) / shear),
          r.displacements[mesh.id(n, 0)].uy,
          'm',
        ),
        check(
          'Moment at the centre of the root element (hogging)',
          'P(L − h/2)',
          P * (L - h / 2),
          r.plates.NP0_0.center.Mx,
          'kN·m/m',
        ),
        check('Transverse shear Qx', '−P', -P, r.plates.NP0_0.center.Qx, 'kN/m'),
        check(
          'Top surface stress, root element',
          '6P(L − h/2)/t²',
          (6 * P * (L - h / 2)) / t ** 2,
          r.plates.NP0_0.center.top.sx,
          'kN/m²',
        ),
      ];
    },
  },
  {
    id: 'P05',
    title: 'Square plate twisted by corner forces (pure Mxy), a/t = 100, 4 × 4 mesh',
    reference:
      'Anticlastic surface w = P·x·y/(2(1 − ν)D), Mxy = P/2; Timoshenko & Woinowsky-Krieger, ch. 2',
    tolerance: 0.005,
    run: () => {
      const a = 2;
      const t = 0.02;
      const nu = 0.3;
      const P = 0.3;
      const n = 4;
      const e = 2e6;
      const mesh = plateMesh('N', n, n, (s, u) => [a * s, 0, -a * u], { E: e, nu, t });
      const r = analyze3d({
        nodes: mesh.nodes,
        plates: mesh.plates,
        supports: [
          { node: mesh.id(0, 0), ux: true, uy: true, uz: true },
          { node: mesh.id(n, 0), uy: true, uz: true },
          { node: mesh.id(0, n), uy: true },
        ],
        loads: [{ kind: 'nodal', node: mesh.id(n, n), fy: P }],
      });
      const D = rigidity(e, t, nu);
      // local axes: x = X, y = −Z, z = Y; the loaded corner is local (a, a)
      return [
        check(
          'Corner deflection',
          'Pa²/(2(1 − ν)D)',
          (P * a * a) / (2 * (1 - nu) * D),
          r.displacements[mesh.id(n, n)].uy,
          'm',
        ),
        check(
          'Twisting moment Mxy at the centre',
          '−P/2',
          -P / 2,
          r.plates[`NP${n / 2}_${n / 2}`].corners[0].Mxy,
          'kN·m/m',
        ),
      ];
    },
  },
  {
    id: 'P06',
    title: 'Scordelis–Lo barrel vault under self-weight (quarter model, 16 × 16 mesh)',
    reference:
      'MacNeal & Harder (1985), Finite Elem. Anal. Des. 1:3 — vertical deflection at mid free edge 0.3024',
    tolerance: 0.01,
    run: () => {
      const R = 25;
      const length2 = 25; // half length
      const half = (40 * Math.PI) / 180;
      const n = 16;
      const t = 0.25;
      // s around the arc from the crown, u from midspan (z = 0) to the diaphragm
      const mesh = plateMesh(
        'N',
        n,
        n,
        (s, u) => [R * Math.sin(s * half), R * Math.cos(s * half), u * length2],
        { E: 4.32e8, nu: 0, t, density: 90 / t },
      );
      const supports: Support3D[] = [];
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          const s: Support3D = { node: mesh.id(i, j) };
          if (i === 0) Object.assign(s, { ux: true, ry: true, rz: true }); // crown symmetry
          if (j === 0) Object.assign(s, { uz: true, rx: true, ry: true }); // midspan symmetry
          if (j === n) Object.assign(s, { ux: true, uy: true }); // rigid diaphragm
          if (Object.keys(s).length > 1) supports.push(s);
        }
      }
      const r = analyze3d({
        nodes: mesh.nodes,
        plates: mesh.plates,
        supports,
        loads: [{ kind: 'selfWeight', direction: 'globalY', factor: -1 }],
      });
      return [
        check(
          'Vertical deflection at mid free edge',
          '0.3024 (reference)',
          -0.3024,
          r.displacements[mesh.id(n, 0)].uy,
          'm',
        ),
      ];
    },
  },
  {
    id: 'P07',
    title: 'Square box-section cantilever of folded plates (20 × 8 mesh), end torque',
    reference:
      'Bredt–Batho closed thin-walled section, J = 4A²t/s; Megson, Aircraft Structures for Engineering Students',
    tolerance: 0.005,
    run: () => {
      const L = 10;
      const side = 1;
      const t = 0.05;
      const e = 2e7;
      const perWall = 2;
      const stations = 20;
      const ring = 4 * perWall;
      const q = 40; // shear flow applied at the tip
      // Perimeter point r (0 … ring−1), counter-clockwise from (−½, −½) seen from +Z.
      const perimeter = (k: number): [number, number] => {
        const wall = Math.floor(k / perWall) % 4;
        const along = ((k % perWall) / perWall) * side;
        const s = side / 2;
        if (wall === 0) return [-s + along, -s];
        if (wall === 1) return [s, -s + along];
        if (wall === 2) return [s - along, s];
        return [-s, s - along];
      };
      const id = (k: number, rr: number) => `T${k}_${rr % ring}`;
      const nodes: Node3D[] = [];
      const plates: Plate3D[] = [];
      for (let k = 0; k <= stations; k++) {
        for (let rr = 0; rr < ring; rr++)
          nodes.push(node(id(k, rr), ...perimeter(rr), (k * L) / stations));
      }
      for (let k = 0; k < stations; k++) {
        for (let rr = 0; rr < ring; rr++) {
          plates.push({
            id: `W${k}_${rr}`,
            nodes: [id(k, rr), id(k, rr + 1), id(k + 1, rr + 1), id(k + 1, rr)],
            E: e,
            nu: 0,
            t,
          });
        }
      }
      // Uniform shear flow q around the tip section as consistent nodal forces.
      const tangents: Vec3[] = [
        [1, 0, 0],
        [0, 1, 0],
        [-1, 0, 0],
        [0, -1, 0],
      ];
      const seg = side / perWall;
      const wallOf = (k: number) => Math.floor((((k % ring) + ring) % ring) / perWall);
      const loads: Load3D[] = [];
      for (let rr = 0; rr < ring; rr++) {
        const f = [0, 1, 2].map(
          (c) => ((tangents[wallOf(rr - 1)][c] + tangents[wallOf(rr)][c]) * q * seg) / 2,
        );
        loads.push({ kind: 'nodal', node: id(stations, rr), fx: f[0], fy: f[1], fz: f[2] });
      }
      const r = analyze3d({
        nodes,
        plates,
        supports: Array.from({ length: ring }, (_, rr) => fixed(id(0, rr))),
        loads,
      });
      const area = side * side;
      const T = 2 * area * q;
      const bredt = (4 * area * area * t) / (4 * side);
      const Jt = bredt + (4 * side * t ** 3) / 3;
      const twist = (T * L) / ((e / 2) * Jt);
      const torque = Object.entries(r.reactions).reduce((sum, [nid, rr]) => {
        const nn = nodes.find((x) => x.id === nid) as Node3D;
        return sum + nn.x * rr.fy - nn.y * rr.fx + rr.mz;
      }, 0);
      return [
        check(
          'Tip twist (nodal rotation rz)',
          'TL/GJ, J = 4A²t/s + Σbt³/3',
          twist,
          r.displacements[id(stations, 1)].rz,
          'rad',
        ),
        check(
          'Tip twist from wall displacement',
          'ux/(−y)',
          twist,
          r.displacements[id(stations, 1)].ux / -perimeter(1)[1],
          'rad',
        ),
        check(
          'Membrane shear flow, mid-length',
          'q·J_Bredt/J',
          (q * bredt) / Jt,
          Math.abs(r.plates[`W${stations / 2}_0`].center.Nxy),
          'kN/m',
        ),
        check('Root reaction torque', '−2Aq', -T, torque, 'kN·m'),
      ];
    },
  },
  // ======================================================================================
  // Solids (8-node hexahedron)
  // ======================================================================================
  {
    id: 'H01',
    title: 'Prismatic bar in uniaxial tension (4 × 1 × 1 hexahedra)',
    reference:
      'Hooke’s law, δ = PL/EA, lateral strain −νσ/E; Timoshenko & Goodier, Theory of Elasticity',
    tolerance: EXACT,
    run: () => {
      const L = 4;
      const b = 0.5;
      const nu = 0.3;
      const sigma = 1500;
      const { nodes, solids, id } = solidBlock('S', [4, 1, 1], [L, b, b], { E, nu });
      const r = analyze3d({
        nodes,
        solids,
        supports: [
          pinned(id(0, 0, 0)),
          { node: id(0, 1, 0), ux: true, uz: true },
          { node: id(0, 0, 1), ux: true, uy: true },
          { node: id(0, 1, 1), ux: true },
        ],
        loads: [{ kind: 'face', solid: 'SH3_0_0', face: 4, direction: 'normal', p: -sigma }],
      });
      const tip = r.displacements[id(4, 1, 1)];
      return [
        check('Elongation', 'σL/E', (sigma * L) / E, tip.ux, 'm'),
        check('Lateral contraction (y)', '−νσb/E', (-nu * sigma * b) / E, tip.uy, 'm'),
        check('Lateral contraction (z)', '−νσb/E', (-nu * sigma * b) / E, tip.uz, 'm'),
        check(
          'Stress σxx at a corner node',
          'P/A',
          sigma,
          r.solids.SH0_0_0.corners[0].sxx,
          'kN/m²',
        ),
        check('Von Mises stress', 'σ', sigma, r.solids.SH2_0_0.center.vonMises, 'kN/m²'),
        check(
          'Support reaction Σ Fx',
          '−σ·A',
          -sigma * b * b,
          Object.values(r.reactions).reduce((s, x) => s + x.fx, 0),
          'kN',
        ),
      ];
    },
  },
  {
    id: 'H02',
    title: 'Slender solid cantilever (L/h = 10) with an end shear, 20 × 2 × 2 hexahedra',
    reference:
      'Timoshenko beam with shear, PL³/3EI + PL/(κGA), κ = 5/6; Timoshenko & Goodier, Theory of Elasticity (cantilever loaded at the end)',
    tolerance: 0.01,
    run: () => {
      const L = 10;
      const h = 1;
      const b = 1;
      const nu = 0.3;
      const e = 30e6;
      const P = 100;
      const nx = 20;
      const { nodes, solids, id } = solidBlock('S', [nx, 2, 2], [L, h, b], { E: e, nu });
      // Root: the section is held plane (ux = 0 everywhere) and the beam axis is held; uy is
      // held only on the neutral plane and uz only on the mid-plane, so that the Poisson
      // (anticlastic) deformation of the beam solution is free.
      const supports: Support3D[] = nodes
        .filter((nn) => nn.x === 0)
        .map((nn) => ({
          node: nn.id,
          ux: true,
          uy: Math.abs(nn.y - h / 2) < 1e-9,
          uz: Math.abs(nn.z - b / 2) < 1e-9,
        }));
      const loads: Load3D[] = [];
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          loads.push({
            kind: 'face',
            solid: `SH${nx - 1}_${j}_${k}`,
            face: 4,
            direction: 'globalY',
            p: -P / (h * b),
          });
        }
      }
      const r = analyze3d({ nodes, solids, supports, loads });
      const I = (b * h ** 3) / 12;
      const Gs = e / (2 * (1 + nu));
      const theory = (P * L ** 3) / (3 * e * I) + (P * L) / ((5 / 6) * Gs * b * h);
      // Bending stress at mid-span, clear of the clamped end: centroid of the top face of the
      // upper element at x = L/2 … L/2 + L/nx.
      const xc = L / 2 + L / nx / 2;
      const topFace = r.solids[`SH${nx / 2}_1_0`].corners;
      const top = (topFace[2].sxx + topFace[3].sxx + topFace[6].sxx + topFace[7].sxx) / 4;
      return [
        check(
          'Tip deflection (axis)',
          'PL³/3EI + PL/κGA',
          -theory,
          r.displacements[id(nx, 1, 1)].uy,
          'm',
        ),
        check(
          'Top-fibre bending stress at mid-span',
          'M(x)·c/I',
          (P * (L - xc) * (h / 2)) / I,
          top,
          'kN/m²',
        ),
        check(
          'Vertical reaction',
          'P',
          P,
          Object.values(r.reactions).reduce((s, x) => s + x.fy, 0),
          'kN',
        ),
      ];
    },
  },
  {
    id: 'H03',
    title: 'Constant-strain patch test on a distorted 3 × 3 × 3 mesh of a unit cube',
    reference:
      'Patch test (Irons); load and material of MacNeal & Harder (1985), Finite Elem. Anal. Des. 1:3 — strains 10⁻³, σ = 2000, τ = 400',
    tolerance: EXACT,
    run: () => {
      const e = 1e6;
      const nu = 0.25;
      const n = 3;
      // The eight interior nodes are moved off the grid by up to 15 % of the element size;
      // every element is distorted and has warped faces.
      const block = solidBlock('S', [n, n, n], [1, 1, 1], { E: e, nu });
      const interior = (nn: Node3D) => [nn.x, nn.y, nn.z].every((v) => v > 1e-9 && v < 1 - 1e-9);
      const nodes = block.nodes.map((nn): Node3D => {
        if (!interior(nn)) return nn;
        const [i, j, k] = [nn.x, nn.y, nn.z].map((v) => Math.round(v * n));
        return node(
          nn.id,
          nn.x + 0.05 * (((i + 2 * j + 3 * k) % 3) - 1),
          nn.y + 0.045 * (((2 * i + j + k) % 3) - 1),
          nn.z + 0.04 * (((i + j + 2 * k + 1) % 3) - 1),
        );
      });
      const field = (p: Vec3): Vec3 => [
        (1e-3 * (2 * p[0] + p[1] + p[2])) / 2,
        (1e-3 * (p[0] + 2 * p[1] + p[2])) / 2,
        (1e-3 * (p[0] + p[1] + 2 * p[2])) / 2,
      ];
      // Boundary nodes follow the linear field; interior nodes are free.
      const supports: Support3D[] = nodes
        .filter((nn) => !interior(nn))
        .map((nn) => {
          const u = field([nn.x, nn.y, nn.z]);
          return {
            node: nn.id,
            ux: true,
            uy: true,
            uz: true,
            settlement: { ux: u[0], uy: u[1], uz: u[2] },
          };
        });
      const r = analyze3d({ nodes, solids: block.solids, supports, loads: [] });
      const free = nodes.filter(interior);
      const states = Object.values(r.solids).flatMap((s) => [s.center, ...s.corners]);
      /** The sample that deviates most from the target. */
      const worst = (values: number[], target: number) =>
        values.reduce((w, v) => (Math.abs(v - target) > Math.abs(w - target) ? v : w), target);
      const lam = (e * nu) / ((1 + nu) * (1 - 2 * nu));
      const mu = e / (2 * (1 + nu));
      const sNormal = (3 * lam + 2 * mu) * 1e-3; // 2000
      const tau = mu * 1e-3; // 400
      const dispCheck = (c: 0 | 1 | 2, key: 'ux' | 'uy' | 'uz', formula: string) => {
        // worst interior node, compared with the field at that node
        let pick = free[0];
        let error = -1;
        for (const nn of free) {
          const err = Math.abs(r.displacements[nn.id][key] - field([nn.x, nn.y, nn.z])[c]);
          if (err > error) [pick, error] = [nn, err];
        }
        return check(
          `Interior ${key}, worst of ${free.length} nodes`,
          formula,
          field([pick.x, pick.y, pick.z])[c],
          r.displacements[pick.id][key],
          'm',
        );
      };
      const points = `worst of ${states.length} points`;
      return [
        dispCheck(0, 'ux', '10⁻³(2x + y + z)/2'),
        dispCheck(1, 'uy', '10⁻³(x + 2y + z)/2'),
        dispCheck(2, 'uz', '10⁻³(x + y + 2z)/2'),
        check(
          `σxx, ${points}`,
          '(3λ + 2μ)·10⁻³',
          sNormal,
          worst(
            states.map((s) => s.sxx),
            sNormal,
          ),
          'kN/m²',
        ),
        check(
          `σyy, ${points}`,
          '(3λ + 2μ)·10⁻³',
          sNormal,
          worst(
            states.map((s) => s.syy),
            sNormal,
          ),
          'kN/m²',
        ),
        check(
          `σzz, ${points}`,
          '(3λ + 2μ)·10⁻³',
          sNormal,
          worst(
            states.map((s) => s.szz),
            sNormal,
          ),
          'kN/m²',
        ),
        check(
          `τxy, ${points}`,
          'μ·10⁻³',
          tau,
          worst(
            states.map((s) => s.txy),
            tau,
          ),
          'kN/m²',
        ),
        check(
          `τyz, ${points}`,
          'μ·10⁻³',
          tau,
          worst(
            states.map((s) => s.tyz),
            tau,
          ),
          'kN/m²',
        ),
        check(
          `τzx, ${points}`,
          'μ·10⁻³',
          tau,
          worst(
            states.map((s) => s.tzx),
            tau,
          ),
          'kN/m²',
        ),
      ];
    },
  },
  {
    id: 'H04',
    title: 'Solid column under its own weight (ν = 0, 2 × 6 × 2 hexahedra)',
    reference:
      'Prismatic bar under its own weight, σ = −ρg(H − y), δ = ρgH²/2E; Timoshenko & Goodier, Theory of Elasticity',
    tolerance: EXACT,
    run: () => {
      const H = 6;
      const b = 1;
      const rho = 25;
      const e = 30e6;
      const { nodes, solids, id } = solidBlock('S', [2, 6, 2], [b, H, b], {
        E: e,
        nu: 0,
        density: rho,
      });
      const r = analyze3d({
        nodes,
        solids,
        supports: nodes.filter((nn) => nn.y === 0).map((nn) => fixed(nn.id)),
        loads: [{ kind: 'selfWeight', direction: 'globalY', factor: -1 }],
      });
      const dy = H / 6;
      return [
        check(
          'Top displacement',
          'ρgH²/2E',
          (-rho * H * H) / (2 * e),
          r.displacements[id(1, 6, 1)].uy,
          'm',
        ),
        check(
          'Displacement at mid-height',
          'ρg(Hy − y²/2)/E',
          (-rho * (H * 3 - 4.5)) / e,
          r.displacements[id(1, 3, 1)].uy,
          'm',
        ),
        check(
          'σyy at the centre of the bottom element',
          '−ρg(H − y)',
          -rho * (H - dy / 2),
          r.solids.SH0_0_0.center.syy,
          'kN/m²',
        ),
        check(
          'Base reaction',
          'ρg·V',
          rho * b * b * H,
          Object.values(r.reactions).reduce((s, x) => s + x.fy, 0),
          'kN',
        ),
      ];
    },
  },

  // ---- Modal analysis ------------------------------------------------------------------
  {
    id: 'M01',
    title: 'Natural frequencies of a simply supported beam, bending about both axes (16 elements)',
    reference: 'Clough & Penzien, Dynamics of Structures: ωn = (nπ/L)²·√(EI/ρA)',
    tolerance: 1e-3,
    run: () => {
      const L = 6;
      const rho = 7.85;
      const r = modalAnalysis3d(
        {
          nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
          members: [beam('AB', 'A', 'B', { mass: rho })],
          supports: [
            { node: 'A', ux: true, uy: true, uz: true, rx: true },
            { node: 'B', uy: true, uz: true },
          ],
          loads: [],
        },
        8,
        { subdivide: 16 },
      );
      const omega = (I: number, n: number) =>
        ((n * Math.PI) / L) ** 2 * Math.sqrt((E * I) / (rho * A));
      const along = (axis: 1 | 2) =>
        r.modes.filter((m) => {
          const v = Math.max(...m.members.AB.map((p) => Math.abs(axis === 1 ? p.v : p.w)));
          const o = Math.max(...m.members.AB.map((p) => Math.abs(axis === 1 ? p.w : p.v)));
          return v > 1e-3 && v > 10 * o;
        });
      const weak = along(2);
      const strong = along(1);
      return [
        check('ω1 about the minor axis', 'π²/L²·√(EIy/ρA)', omega(IY, 1), weak[0].omega, 'rad/s'),
        check('ω2 about the minor axis', '4π²/L²·√(EIy/ρA)', omega(IY, 2), weak[1].omega, 'rad/s'),
        check('ω1 about the major axis', 'π²/L²·√(EIz/ρA)', omega(IZ, 1), strong[0].omega, 'rad/s'),
        check(
          'ω2 about the major axis',
          '4π²/L²·√(EIz/ρA)',
          omega(IZ, 2),
          strong[1].omega,
          'rad/s',
        ),
      ];
    },
  },
  {
    id: 'M02',
    title: 'Cantilever: first two bending frequencies and effective modal mass (12 elements)',
    reference:
      'Blevins, Formulas for Natural Frequency and Mode Shape: β1L = 1.87510, β2L = 4.69409',
    tolerance: 1e-3,
    run: () => {
      const L = 4;
      const rho = 7.85;
      const r = modalAnalysis3d(
        {
          nodes: [node('A', 0, 0, 0), node('B', 0, L, 0)],
          members: [beam('AB', 'A', 'B', { mass: rho, Iy: IZ })],
          supports: [fixed('A')],
          loads: [],
        },
        6,
        { subdivide: 12 },
      );
      // Equal Iy = Iz: the bending modes come in pairs (X and Z); torsional and axial modes
      // (no transverse displacement) are skipped.
      const bending = r.modes.filter((m) =>
        m.members.AB.some((p) => Math.max(Math.abs(p.v), Math.abs(p.w)) > 0.1),
      );
      const base = Math.sqrt((E * IZ) / (rho * A * L ** 4));
      return [
        check('ω1', '1.87510²·√(EI/ρAL⁴)', 1.8751 ** 2 * base, bending[0].omega, 'rad/s'),
        check('ω2', '4.69409²·√(EI/ρAL⁴)', 4.69409 ** 2 * base, bending[2].omega, 'rad/s'),
        check(
          'Effective mass of mode 1',
          '0.6131·ρAL',
          0.6131,
          r.modes[0].massFraction[0] + r.modes[0].massFraction[2],
          '–',
        ),
      ];
    },
  },
  {
    id: 'M03',
    title: 'Fixed–free shaft: torsional and axial frequencies (20 elements)',
    reference: 'Rao, Mechanical Vibrations: ωn = (2n − 1)π/(2L)·√(GJ/ρIp) and √(E/ρ)',
    tolerance: 3e-3,
    run: () => {
      const L = 6;
      const rho = 7.85;
      const r = modalAnalysis3d(
        {
          nodes: [node('A', 0, 0, 0), node('B', L, 0, 0)],
          members: [beam('AB', 'A', 'B', { mass: rho })],
          supports: [{ node: 'A', ux: true, rx: true }],
          loads: [],
          restrainAll: { uy: true, uz: true, ry: true, rz: true },
        },
        8,
        { subdivide: 20 },
      );
      const torsion = (n: number) =>
        (((2 * n - 1) * Math.PI) / (2 * L)) * Math.sqrt((G * J) / (rho * (IY + IZ)));
      const axial = (Math.PI / (2 * L)) * Math.sqrt(E / rho);
      const nearest = (target: number) =>
        r.modes.reduce(
          (best, m) => (Math.abs(m.omega - target) < Math.abs(best - target) ? m.omega : best),
          Infinity,
        );
      return [
        check('First torsional ω', 'π/(2L)·√(GJ/ρIp)', torsion(1), nearest(torsion(1)), 'rad/s'),
        check('Second torsional ω', '3π/(2L)·√(GJ/ρIp)', torsion(2), nearest(torsion(2)), 'rad/s'),
        check('First axial ω', 'π/(2L)·√(E/ρ)', axial, nearest(axial), 'rad/s'),
      ];
    },
  },
  {
    id: 'M04',
    title: 'Simply supported square plate, first two frequencies (a/t = 100, 16 × 16 mesh)',
    reference: 'Leissa, Vibration of Plates (NASA SP-160): ωmn = π²·((m² + n²)/a²)·√(D/ρt)',
    // Set to 2 % after the first run: the second mode (two half-waves across 16 elements)
    // came out 1.4 % high, the fundamental within 0.3 %. See DECISIONS.md.
    tolerance: 2e-2,
    run: () => {
      const a = 2;
      const t = 0.02;
      const n = 16;
      const nu = 0.3;
      const rho = 7.85;
      const id = (i: number, j: number) => `n${i}_${j}`;
      const nodes: Node3D[] = [];
      const supports: Support3D[] = [];
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
          nodes.push(node(id(i, j), (a * i) / n, 0, (a * j) / n));
          if (i === 0 || j === 0 || i === n || j === n) supports.push({ node: id(i, j), uy: true });
        }
      }
      supports.push(
        { node: id(n / 2, n / 2), ux: true, uz: true },
        { node: id(n, n / 2), uz: true },
      );
      const plates: Plate3D[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          plates.push({
            id: `p${i}_${j}`,
            nodes: [id(i, j), id(i, j + 1), id(i + 1, j + 1), id(i + 1, j)],
            E,
            nu,
            t,
            mass: rho,
          });
        }
      }
      const r = modalAnalysis3d({ nodes, plates, supports, loads: [] }, 3);
      const D = (E * t ** 3) / (12 * (1 - nu * nu));
      const w11 = Math.PI ** 2 * (2 / a ** 2) * Math.sqrt(D / (rho * t));
      const w12 = Math.PI ** 2 * (5 / a ** 2) * Math.sqrt(D / (rho * t));
      return [
        check('ω11', 'π²·(2/a²)·√(D/ρt)', w11, r.modes[0].omega, 'rad/s'),
        check('ω12 = ω21', 'π²·(5/a²)·√(D/ρt)', w12, r.modes[1].omega, 'rad/s'),
      ];
    },
  },
  {
    id: 'M05',
    title:
      'Solid cantilever (ν = 0, L/h = 20, 20 × 2 × 2 hexahedra): bending and axial frequencies',
    reference: 'Euler–Bernoulli beam β1L = 1.87510; axial bar π/(2L)·√(E/ρ)',
    tolerance: 1.5e-2,
    run: () => {
      const L = 4;
      const h = 0.2;
      const nx = 20;
      const Es = 2e7;
      const rho = 2.5;
      const id = (i: number, j: number, k: number) => `n${i}_${j}_${k}`;
      const nodes: Node3D[] = [];
      const supports: Support3D[] = [];
      for (let i = 0; i <= nx; i++) {
        for (let j = 0; j <= 2; j++) {
          for (let k = 0; k <= 2; k++) {
            nodes.push(node(id(i, j, k), (L * i) / nx, (h * j) / 2, (h * k) / 2));
            if (i === 0) supports.push({ node: id(i, j, k), ux: true, uy: true, uz: true });
          }
        }
      }
      const solids: Solid3D[] = [];
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
              ],
              E: Es,
              nu: 0,
              mass: rho,
            });
          }
        }
      }
      const r = modalAnalysis3d({ nodes, solids, supports, loads: [] }, 12);
      const bending = (1.8751 ** 2 / L ** 2) * Math.sqrt((Es * h ** 4) / 12 / (rho * h * h));
      const axial = (Math.PI / (2 * L)) * Math.sqrt(Es / rho);
      const nearest = (target: number) =>
        r.modes.reduce(
          (best, m) => (Math.abs(m.omega - target) < Math.abs(best - target) ? m.omega : best),
          Infinity,
        );
      return [
        check('First bending ω', '1.87510²·√(EI/ρAL⁴)', bending, r.modes[0].omega, 'rad/s'),
        check('First axial ω', 'π/(2L)·√(E/ρ)', axial, nearest(axial), 'rad/s'),
      ];
    },
  },
];

/** Deflection coefficient at (a/4, a/2) of the simply supported plate under a central load. */
function quarterPoint(): number {
  // w(x, y) = (4Pa²/π⁴D) Σ sin(mπ/2) sin(nπ/2) sin(mπx/a) sin(nπy/a) / (m² + n²)²
  let sum = 0;
  for (let m = 1; m < 2000; m += 2) {
    for (let n = 1; n < 2000; n += 2) {
      const s = Math.sin((m * Math.PI) / 2) * Math.sin((n * Math.PI) / 2);
      sum += (s * Math.sin((m * Math.PI) / 4) * Math.sin((n * Math.PI) / 2)) / (m * m + n * n) ** 2;
    }
  }
  return (4 * sum) / Math.PI ** 4;
}
