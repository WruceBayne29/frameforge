/**
 * 4-node flat shell element ("plate"): membrane + bending, 6 DOF per node (24 DOF), usable
 * in any orientation in 3D.
 *
 * The element is built in its own local axes (see `plateAxes`) on the node positions projected
 * onto the mean plane, and then rotated to global axes node by node.
 *
 * Local DOF order: [u, v, w, θx, θy, θz] at each of the four nodes, with u, v, w along local
 * x, y, z and θx, θy, θz the components of the (small) rotation vector about them, right-hand
 * rule. Three uncoupled parts make up the local stiffness:
 *
 *  - Membrane (u, v): plane-stress quadrilateral with the Wilson–Taylor incompatible modes in
 *    the modified form that passes the patch test (QM6), 2 × 2 Gauss, the four internal
 *    parameters statically condensed.
 *
 *  - Bending (w, θx, θy): Mindlin–Reissner plate with MITC4 assumed transverse shear strains
 *    (Bathe & Dvorkin 1985), shear correction factor 5/6, 2 × 2 Gauss.
 *    Rotation convention: a material line that was normal to the mid-surface rotates with the
 *    rotation vector, so a point at height z moves in-plane by θ × (z·e_z) = (z·θy, −z·θx).
 *    Writing that as (z·βx, z·βy) defines the section rotations
 *        βx = +θy,   βy = −θx,
 *    from which
 *        curvatures      κx = ∂βx/∂x = ∂θy/∂x,  κy = ∂βy/∂y = −∂θx/∂y,
 *                        κxy = ∂βx/∂y + ∂βy/∂x = ∂θy/∂y − ∂θx/∂x      (strain = z·κ)
 *        shear strains   γxz = ∂w/∂x + θy,  γyz = ∂w/∂y − θx.
 *    In the thin (Kirchhoff) limit γ = 0, so θx = ∂w/∂y, θy = −∂w/∂x and κx = −∂²w/∂x².
 *    Moments are M = ∫σ·z dz = D·κ: a plate sagging under a pressure along −z has ∂²w/∂x² > 0,
 *    hence κx < 0 and Mx < 0 (tension on the bottom, −z, surface), as documented on
 *    `PlateStress`.
 *
 *  - Drilling (θz): a penalty γ·G·t·∫(θz − ω)² dA that ties the nodal drilling rotation field
 *    to the in-plane continuum rotation ω = ½(∂v/∂x − ∂u/∂y) of the compatible displacements.
 *    It is invariant under rigid-body motion, so the element has exactly six zero-energy
 *    modes, and it removes the singularity of coplanar assemblies without a fictitious
 *    spring to ground.
 *
 * Limitations: the element is flat. A warped quadrilateral is analysed on its projection onto
 * the mean plane without rigid-link (offset) corrections, which is only accurate for slight
 * warping (see `warp`); loads are integrated over the projected area. Element loads produce
 * nodal forces only (no fixed-end moments), and the recovered stress resultants come from the
 * nodal displacements alone, as usual for Mindlin elements.
 */
import { SolverError } from '../solver/errors';
import { zeros } from '../solver/linalg';
import type { ElementMatrices } from './contract';
import { cross, dot, GAUSS2, invert, norm, planeStress, scale, sub } from './math';
import type {
  Plate3D,
  PlateLoad3D,
  PlateResult3D,
  PlateStress,
  SurfaceStress,
  Vec3,
} from './types';

/** Local axes and projected geometry of a quadrilateral plate. */
export interface PlateAxes {
  /** Unit vectors of the local axes in global coordinates. */
  x: Vec3;
  y: Vec3;
  z: Vec3;
  /** Centroid of the four nodes; the mean plane passes through it, normal to `z`. */
  origin: Vec3;
  /** Local (x, y) coordinates of the nodes projected onto the mean plane. */
  local: [number, number][];
  /** Area of the projected quadrilateral. */
  area: number;
  /** Largest out-of-plane distance of a node from the mean plane, divided by √area. */
  warp: number;
}

/** One plate prepared for assembly, with the data needed to recover its results. */
export interface PlateElement extends ElementMatrices {
  dofsPerNode: 6;
  /** The plate this element was built from. */
  plate: Plate3D;
  /** Unit vectors of the local axes in global coordinates. */
  axes: { x: Vec3; y: Vec3; z: Vec3 };
  /** Origin of the local axes (centroid of the nodes). */
  origin: Vec3;
  /** Local (x, y) coordinates of the nodes on the mean plane. */
  local: [number, number][];
  /** Area of the element on its mean plane. */
  area: number;
  /** Warping measure, see `PlateAxes.warp` (0 for a flat element). */
  warp: number;
  /**
   * 4 × 8 matrix that recovers the condensed incompatible-mode parameters from the local
   * membrane displacements [u1, v1, …, u4, v4]: a = alpha · u.
   */
  alpha: number[][];
  /** Notes for the user (e.g. a noticeably warped element). */
  warnings: string[];
}

/** Penalty factor of the drilling stiffness, relative to G·t. */
const DRILLING_FACTOR = 1e-3;

/** Shear correction factor of the Mindlin plate. */
const SHEAR_CORRECTION = 5 / 6;

/** `warp` above which the element reports a warning. */
const WARP_WARNING = 0.01;

/** Natural coordinates (ξ, η) of the four nodes. */
const NODE_XI: readonly number[] = [-1, 1, 1, -1];
const NODE_ETA: readonly number[] = [-1, -1, 1, 1];

/** The 2 × 2 Gauss points, numbered like the nodes they are nearest to (weights are 1). */
const GAUSS_POINTS: ReadonlyArray<readonly [number, number]> = NODE_XI.map(
  (xi, i) => [xi * GAUSS2[1], NODE_ETA[i] * GAUSS2[1]] as const,
);

/** Local DOF indices of the membrane part [u1, v1, …, u4, v4]. */
const MEMBRANE_DOFS: readonly number[] = [0, 1, 6, 7, 12, 13, 18, 19];
/** Local DOF indices of the bending part [w1, θx1, θy1, …]. */
const BENDING_DOFS: readonly number[] = [2, 3, 4, 8, 9, 10, 14, 15, 16, 20, 21, 22];
/** Local DOF indices of the drilling part [u1, v1, θz1, …]. */
const DRILLING_DOFS: readonly number[] = [0, 1, 5, 6, 7, 11, 12, 13, 17, 18, 19, 23];

/** Mean plane of four points, or null when the diagonals do not span a plane. */
function meanPlane(coords: Vec3[]): PlateAxes | null {
  const [n1, n2, n3, n4] = coords;
  const d1 = sub(n3, n1);
  const d2 = sub(n4, n2);
  const normal = cross(d1, d2);
  const size = Math.max(norm(d1), norm(d2));
  const twiceArea = norm(normal);
  if (!(twiceArea > 1e-10 * size * size)) return null;
  const z = scale(normal, 1 / twiceArea);

  // Midpoint of edge 2–3 minus midpoint of edge 4–1 = (d1 − d2) / 2: a combination of the
  // diagonals, so it is already perpendicular to z; the projection only removes rounding.
  const across = sub(d1, d2);
  const inPlane = sub(across, scale(z, dot(across, z)));
  const x = scale(inPlane, 1 / norm(inPlane));
  const y = cross(z, x);

  const origin: Vec3 = [0, 1, 2].map((k) => (n1[k] + n2[k] + n3[k] + n4[k]) / 4) as Vec3;
  let offset = 0;
  const local = coords.map((c): [number, number] => {
    const r = sub(c, origin);
    offset = Math.max(offset, Math.abs(dot(r, z)));
    return [dot(r, x), dot(r, y)];
  });
  // The projected quadrilateral has the same diagonals (they are normal to z), and the area
  // of a quadrilateral is half the cross product of its diagonals.
  const area = twiceArea / 2;
  return { x, y, z, origin, local, area, warp: offset / Math.sqrt(area) };
}

/**
 * Local axes of a quadrilateral plate from its four node positions (in node order), following
 * the convention documented on `Plate3D`: z = (n3 − n1) × (n4 − n2) normalised; x from the
 * midpoint of edge 4–1 to the midpoint of edge 2–3, made perpendicular to z; y = z × x.
 * The mean plane passes through the centroid of the nodes, normal to z; `local` holds the
 * node coordinates projected on it, `area` the projected area and `warp` the largest
 * out-of-plane node distance divided by √area (dimensionless, 0 for a flat quadrilateral).
 * Throws `SolverError('INVALID_MODEL')` when the points do not define a plane.
 */
export function plateAxes(coords: Vec3[]): PlateAxes {
  if (coords.length !== 4) {
    throw new SolverError('INVALID_MODEL', 'A plate needs exactly four node positions.');
  }
  const plane = meanPlane(coords);
  if (!plane) {
    throw new SolverError('INVALID_MODEL', 'The plate nodes do not define a plane (zero area).');
  }
  return plane;
}

/** Bilinear shape functions and their derivatives at one point of the element. */
interface Shape {
  N: number[];
  dNdxi: number[];
  dNdeta: number[];
  /** Jacobian J = [[∂x/∂ξ, ∂y/∂ξ], [∂x/∂η, ∂y/∂η]]. */
  xXi: number;
  yXi: number;
  xEta: number;
  yEta: number;
  detJ: number;
  dNdx: number[];
  dNdy: number[];
}

function shapeAt(local: [number, number][], xi: number, eta: number): Shape {
  const N: number[] = [];
  const dNdxi: number[] = [];
  const dNdeta: number[] = [];
  let xXi = 0;
  let yXi = 0;
  let xEta = 0;
  let yEta = 0;
  for (let i = 0; i < 4; i++) {
    const a = 1 + NODE_XI[i] * xi;
    const b = 1 + NODE_ETA[i] * eta;
    N.push((a * b) / 4);
    dNdxi.push((NODE_XI[i] * b) / 4);
    dNdeta.push((NODE_ETA[i] * a) / 4);
    xXi += dNdxi[i] * local[i][0];
    yXi += dNdxi[i] * local[i][1];
    xEta += dNdeta[i] * local[i][0];
    yEta += dNdeta[i] * local[i][1];
  }
  const detJ = xXi * yEta - yXi * xEta;
  // [∂/∂x, ∂/∂y]ᵀ = J⁻¹ · [∂/∂ξ, ∂/∂η]ᵀ with J⁻¹ = [[y,η, −y,ξ], [−x,η, x,ξ]] / detJ.
  const dNdx = dNdxi.map((d, i) => (yEta * d - yXi * dNdeta[i]) / detJ);
  const dNdy = dNdxi.map((d, i) => (-xEta * d + xXi * dNdeta[i]) / detJ);
  return { N, dNdxi, dNdeta, xXi, yXi, xEta, yEta, detJ, dNdx, dNdy };
}

/** Isotropic plane-stress type matrix c · [[1, ν, 0], [ν, 1, 0], [0, 0, (1 − ν)/2]]. */
function isotropic(c: number, nu: number): number[][] {
  return [
    [c, c * nu, 0],
    [c * nu, c, 0],
    [0, 0, (c * (1 - nu)) / 2],
  ];
}

/** Section stiffnesses of the plate: membrane, bending and transverse shear. */
function sectionStiffness(plate: Plate3D): { Dm: number[][]; Db: number[][]; Ds: number } {
  const { E, nu, t } = plate;
  const G = E / (2 * (1 + nu));
  return {
    Dm: isotropic((E * t) / (1 - nu * nu), nu),
    Db: isotropic((E * t ** 3) / (12 * (1 - nu * nu)), nu),
    Ds: SHEAR_CORRECTION * G * t,
  };
}

/** k += weight · Bᵀ · D · B for a strain matrix B (m × n) and a section matrix D (m × m). */
function addBtDB(k: number[][], B: number[][], D: number[][], weight: number): void {
  const m = B.length;
  const n = k.length;
  const DB = zeros(m, n);
  for (let r = 0; r < m; r++) {
    for (let s = 0; s < m; s++) {
      const d = D[r][s];
      if (d === 0) continue;
      for (let j = 0; j < n; j++) DB[r][j] += d * B[s][j];
    }
  }
  for (let r = 0; r < m; r++) {
    for (let i = 0; i < n; i++) {
      const b = B[r][i] * weight;
      if (b === 0) continue;
      for (let j = 0; j < n; j++) k[i][j] += b * DB[r][j];
    }
  }
}

/**
 * Membrane strain matrix (3 × 12) at (ξ, η): strains [εx, εy, γxy] from the eight nodal
 * displacements [u1, v1, …, u4, v4] (columns 0–7) and the four incompatible-mode parameters
 * (columns 8–11), where u += (1 − ξ²)·a1 + (1 − η²)·a2 and v += (1 − ξ²)·a3 + (1 − η²)·a4.
 * The derivatives of the incompatible modes use the Jacobian at the element centre scaled
 * by detJ0/detJ, which makes ∫B_a dA vanish so that constant-stress states are reproduced
 * exactly on distorted elements (QM6).
 */
function membraneB(centre: Shape, s: Shape, xi: number, eta: number): number[][] {
  const B = zeros(3, 12);
  for (let i = 0; i < 4; i++) {
    B[0][2 * i] = s.dNdx[i];
    B[1][2 * i + 1] = s.dNdy[i];
    B[2][2 * i] = s.dNdy[i];
    B[2][2 * i + 1] = s.dNdx[i];
  }
  // (detJ0/detJ) · J0⁻¹ · [∂P/∂ξ, ∂P/∂η]ᵀ with ∂P1/∂ξ = −2ξ and ∂P2/∂η = −2η; the factor
  // detJ0 cancels against the 1/detJ0 of J0⁻¹.
  const p1x = (centre.yEta * -2 * xi) / s.detJ;
  const p1y = (-centre.xEta * -2 * xi) / s.detJ;
  const p2x = (-centre.yXi * -2 * eta) / s.detJ;
  const p2y = (centre.xXi * -2 * eta) / s.detJ;
  B[0][8] = p1x;
  B[0][9] = p2x;
  B[1][10] = p1y;
  B[1][11] = p2y;
  B[2][8] = p1y;
  B[2][9] = p2y;
  B[2][10] = p1x;
  B[2][11] = p2x;
  return B;
}

/**
 * Curvature matrix (3 × 12) at a point: [κx, κy, κxy] from [w1, θx1, θy1, …, w4, θx4, θy4]
 * with κx = ∂θy/∂x, κy = −∂θx/∂y, κxy = ∂θy/∂y − ∂θx/∂x.
 */
function bendingB(s: Shape): number[][] {
  const B = zeros(3, 12);
  for (let i = 0; i < 4; i++) {
    B[0][3 * i + 2] = s.dNdx[i];
    B[1][3 * i + 1] = -s.dNdy[i];
    B[2][3 * i + 1] = -s.dNdx[i];
    B[2][3 * i + 2] = s.dNdy[i];
  }
  return B;
}

/**
 * Covariant transverse shear strains of the displacement interpolation at one point, as
 * rows over [w1, θx1, θy1, …]:
 *   γ_ξz = ∂w/∂ξ + βx·∂x/∂ξ + βy·∂y/∂ξ   and the same with η,
 * with βx = θy and βy = −θx.
 */
function covariantShear(s: Shape): { xi: number[]; eta: number[] } {
  const xi: number[] = [];
  const eta: number[] = [];
  for (let i = 0; i < 4; i++) {
    xi.push(s.dNdxi[i], -s.N[i] * s.yXi, s.N[i] * s.xXi);
    eta.push(s.dNdeta[i], -s.N[i] * s.yEta, s.N[i] * s.xEta);
  }
  return { xi, eta };
}

/** Covariant shear strain rows sampled at the four MITC4 tying points (edge midpoints). */
interface Tying {
  /** γ_ξz at A (ξ = 0, η = +1) and C (ξ = 0, η = −1). */
  a: number[];
  c: number[];
  /** γ_ηz at B (ξ = +1, η = 0) and D (ξ = −1, η = 0). */
  b: number[];
  d: number[];
}

function tyingPoints(local: [number, number][]): Tying {
  return {
    a: covariantShear(shapeAt(local, 0, 1)).xi,
    c: covariantShear(shapeAt(local, 0, -1)).xi,
    b: covariantShear(shapeAt(local, 1, 0)).eta,
    d: covariantShear(shapeAt(local, -1, 0)).eta,
  };
}

/**
 * MITC4 transverse shear strain matrix (2 × 12) at (ξ, η): [γxz, γyz] from
 * [w1, θx1, θy1, …]. The covariant strains are interpolated from the tying points,
 *   γ_ξz = ½(1 + η)·γ_ξz(A) + ½(1 − η)·γ_ξz(C),   γ_ηz = ½(1 + ξ)·γ_ηz(B) + ½(1 − ξ)·γ_ηz(D),
 * and transformed to the local Cartesian axes with [γxz, γyz]ᵀ = J⁻¹ · [γ_ξz, γ_ηz]ᵀ.
 */
function shearB(tying: Tying, s: Shape, xi: number, eta: number): number[][] {
  const B = zeros(2, 12);
  for (let k = 0; k < 12; k++) {
    const gXi = ((1 + eta) * tying.a[k] + (1 - eta) * tying.c[k]) / 2;
    const gEta = ((1 + xi) * tying.b[k] + (1 - xi) * tying.d[k]) / 2;
    B[0][k] = (s.yEta * gXi - s.yXi * gEta) / s.detJ;
    B[1][k] = (-s.xEta * gXi + s.xXi * gEta) / s.detJ;
  }
  return B;
}

/**
 * Drilling constraint row (1 × 12) over [u1, v1, θz1, …]: the difference between the
 * interpolated nodal drilling rotation and the continuum rotation ½(∂v/∂x − ∂u/∂y).
 */
function drillingB(s: Shape): number[][] {
  const b: number[] = [];
  for (let i = 0; i < 4; i++) b.push(s.dNdy[i] / 2, -s.dNdx[i] / 2, s.N[i]);
  return [b];
}

/** Adds a sub-matrix to the 24 × 24 local stiffness at the given local DOF indices. */
function scatter(k: number[][], part: number[][], dofs: readonly number[]): void {
  for (let i = 0; i < dofs.length; i++) {
    for (let j = 0; j < dofs.length; j++) k[dofs[i]][dofs[j]] += part[i][j];
  }
}

/** Local 24 × 24 stiffness and the 4 × 8 recovery matrix of the incompatible modes. */
function localStiffness(
  plate: Plate3D,
  local: [number, number][],
): { k: number[][]; alpha: number[][] } {
  const { Dm, Db, Ds } = sectionStiffness(plate);
  const drilling = (DRILLING_FACTOR * plate.E * plate.t) / (2 * (1 + plate.nu));
  const centre = shapeAt(local, 0, 0);
  const tying = tyingPoints(local);

  const membrane = zeros(12, 12);
  const bending = zeros(12, 12);
  const drill = zeros(12, 12);
  for (const [xi, eta] of GAUSS_POINTS) {
    const s = shapeAt(local, xi, eta);
    addBtDB(membrane, membraneB(centre, s, xi, eta), Dm, s.detJ);
    addBtDB(bending, bendingB(s), Db, s.detJ);
    addBtDB(
      bending,
      shearB(tying, s, xi, eta),
      [
        [Ds, 0],
        [0, Ds],
      ],
      s.detJ,
    );
    addBtDB(drill, drillingB(s), [[drilling]], s.detJ);
  }

  // Static condensation of the incompatible modes (no load acts on them):
  //   a = −K_aa⁻¹·K_ac·u,   K = K_cc − K_ca·K_aa⁻¹·K_ac.
  const kaaInverse = invert(membrane.slice(8).map((row) => row.slice(8)));
  if (!kaaInverse) {
    throw new SolverError(
      'INVALID_MODEL',
      `Plate "${plate.id}" is too distorted: its membrane stiffness is singular.`,
      { memberId: plate.id },
    );
  }
  const alpha = zeros(4, 8);
  for (let a = 0; a < 4; a++) {
    for (let j = 0; j < 8; j++) {
      let sum = 0;
      for (let b = 0; b < 4; b++) sum += kaaInverse[a][b] * membrane[8 + b][j];
      alpha[a][j] = -sum;
    }
  }
  const condensed = zeros(8, 8);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let sum = membrane[i][j];
      for (let a = 0; a < 4; a++) sum += membrane[i][8 + a] * alpha[a][j];
      condensed[i][j] = sum;
    }
  }

  const k = zeros(24, 24);
  scatter(k, condensed, MEMBRANE_DOFS);
  scatter(k, bending, BENDING_DOFS);
  scatter(k, drill, DRILLING_DOFS);
  // Remove the rounding-level asymmetry left by the condensation.
  for (let i = 0; i < 24; i++) {
    for (let j = i + 1; j < 24; j++) {
      const mean = (k[i][j] + k[j][i]) / 2;
      k[i][j] = mean;
      k[j][i] = mean;
    }
  }
  return { k, alpha };
}

/**
 * Global stiffness Tᵀ·k·T, where T applies the 3 × 3 rotation R (rows = local axes) to the
 * translations and to the rotations of every node: u_local = R · u_global.
 */
function toGlobal(k: number[][], R: Vec3[]): number[][] {
  const out = zeros(24, 24);
  for (let I = 0; I < 24; I += 3) {
    for (let J = 0; J < 24; J += 3) {
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          let sum = 0;
          for (let c = 0; c < 3; c++) {
            const rca = R[c][a];
            if (rca === 0) continue;
            const row = k[I + c];
            sum += rca * (row[J] * R[0][b] + row[J + 1] * R[1][b] + row[J + 2] * R[2][b]);
          }
          out[I + a][J + b] = sum;
        }
      }
    }
  }
  return out;
}

function invalid(plate: Plate3D, problem: string): SolverError {
  return new SolverError('INVALID_MODEL', `Plate "${plate.id}" ${problem}`, {
    memberId: plate.id,
  });
}

/** Checks the node positions and returns the local axes; throws for degenerate geometry. */
function checkedGeometry(plate: Plate3D, coords: Vec3[]): PlateAxes {
  if (plate.nodes.length !== 4 || coords.length !== 4) {
    throw invalid(plate, 'must have exactly four nodes.');
  }
  if (!coords.every((c) => c.length === 3 && c.every((v) => Number.isFinite(v)))) {
    throw invalid(plate, 'has a node without valid coordinates.');
  }
  let size = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) size = Math.max(size, norm(sub(coords[i], coords[j])));
  }
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (!(norm(sub(coords[i], coords[j])) > 1e-9 * size)) {
        throw invalid(plate, `has coincident nodes ("${plate.nodes[i]}" and "${plate.nodes[j]}").`);
      }
    }
  }
  const plane = meanPlane(coords);
  if (!plane) throw invalid(plate, 'has zero area (its nodes lie on a line).');

  // detJ varies linearly over the element, so it is positive everywhere (in particular at
  // the Gauss points) exactly when it is positive at the four corners. A re-entrant corner,
  // three nodes on a line or a self-intersecting ("bow-tie") node order all fail here.
  for (let i = 0; i < 4; i++) {
    const { detJ } = shapeAt(plane.local, NODE_XI[i], NODE_ETA[i]);
    if (!(detJ > 1e-8 * plane.area)) {
      throw invalid(
        plate,
        `is not a convex quadrilateral at node "${plate.nodes[i]}" (check the node order ` +
          'and that no three nodes lie on a line).',
      );
    }
  }
  return plane;
}

/** Unit vector of a plate load direction in global axes. */
function loadDirection(direction: PlateLoad3D['direction'], z: Vec3): Vec3 {
  switch (direction) {
    case 'localZ':
      return z;
    case 'globalX':
      return [1, 0, 0];
    case 'globalY':
      return [0, 1, 0];
    case 'globalZ':
      return [0, 0, 1];
  }
}

/**
 * Builds the global stiffness matrix and equivalent nodal load vector of one plate.
 *
 * `coords` are the four node positions in node order, `loads` the loads that name this plate
 * and `gravity` the summed self-weight vector g (body force per unit volume = density · g).
 * Element DOF order: [ux, uy, uz, rx, ry, rz] at each node, global axes.
 *
 * Loads: a `pressure` p acts per unit area of the plate along its direction (`localZ` = the
 * plate normal +z); a `platePoint` force acts at natural coordinates (ξ, η) ∈ [−1, 1]²;
 * self-weight is density · t · g per unit area. All are turned into consistent nodal forces
 * with the bilinear shape functions (no nodal moments).
 *
 * Throws `SolverError('INVALID_MODEL', …, { memberId: plate.id })` for degenerate or
 * non-convex geometry, for E <= 0, t <= 0 or ν outside (−1, 0.5), and for invalid loads.
 */
export function plateElement(
  plate: Plate3D,
  coords: Vec3[],
  loads: PlateLoad3D[],
  gravity: Vec3,
): PlateElement {
  const { E, nu, t } = plate;
  if (!(E > 0) || !Number.isFinite(E)) throw invalid(plate, "needs a Young's modulus E > 0.");
  if (!(t > 0) || !Number.isFinite(t)) throw invalid(plate, 'needs a thickness t > 0.');
  if (!(nu > -1 && nu < 0.5)) {
    throw invalid(plate, "needs a Poisson's ratio between −1 and 0.5 (exclusive).");
  }
  const density = plate.density ?? 0;
  if (!Number.isFinite(density)) throw invalid(plate, 'has an invalid density.');

  const plane = checkedGeometry(plate, coords);
  const { x, y, z, origin, local, area, warp } = plane;
  const { k: kLocal, alpha } = localStiffness(plate, local);
  const k = toGlobal(kLocal, [x, y, z]);

  // Uniformly distributed force per unit area, in global axes: pressures + self-weight.
  let q: Vec3 = scale(gravity, density * t);
  const f = new Array<number>(24).fill(0);
  for (const load of loads) {
    const direction = loadDirection(load.direction, z);
    if (load.kind === 'pressure') {
      if (!Number.isFinite(load.p)) throw invalid(plate, 'has a pressure load without a value.');
      q = [
        q[0] + load.p * direction[0],
        q[1] + load.p * direction[1],
        q[2] + load.p * direction[2],
      ];
    } else {
      const { P, xi, eta } = load;
      if (!Number.isFinite(P)) throw invalid(plate, 'has a point load without a value.');
      if (!(Math.abs(xi) <= 1 && Math.abs(eta) <= 1)) {
        throw invalid(
          plate,
          'has a point load outside the plate: xi and eta must lie between −1 and 1.',
        );
      }
      for (let i = 0; i < 4; i++) {
        const share = (P * (1 + NODE_XI[i] * xi) * (1 + NODE_ETA[i] * eta)) / 4;
        for (let c = 0; c < 3; c++) f[6 * i + c] += share * direction[c];
      }
    }
  }
  if (q[0] !== 0 || q[1] !== 0 || q[2] !== 0) {
    // ∫N_i dA by 2 × 2 Gauss (exact: N_i · detJ is at most quadratic in ξ and in η).
    for (const [xi, eta] of GAUSS_POINTS) {
      const s = shapeAt(local, xi, eta);
      for (let i = 0; i < 4; i++) {
        for (let c = 0; c < 3; c++) f[6 * i + c] += s.N[i] * s.detJ * q[c];
      }
    }
  }

  const warnings: string[] = [];
  if (warp > WARP_WARNING) {
    warnings.push(
      `Plate "${plate.id}" is warped (its nodes are up to ${(warp * 100).toFixed(1)} % of ` +
        'its size out of plane); it is analysed as a flat element on its mean plane.',
    );
  }

  return {
    nodes: [...plate.nodes],
    dofsPerNode: 6,
    k,
    f,
    plate,
    axes: { x, y, z },
    origin,
    local,
    area,
    warp,
    alpha,
    warnings,
  };
}

/** Product of a strain matrix with the element displacements of its part. */
function strains(B: number[][], u: number[]): number[] {
  return B.map((row) => row.reduce((sum, b, j) => sum + b * u[j], 0));
}

function surfaceStress(sx: number, sy: number, txy: number): SurfaceStress {
  return { sx, sy, txy, ...planeStress(sx, sy, txy) };
}

/** Full stress state from the eight resultants [Nx, Ny, Nxy, Mx, My, Mxy, Qx, Qy]. */
function plateStress(r: number[], t: number): PlateStress {
  const [Nx, Ny, Nxy, Mx, My, Mxy, Qx, Qy] = r;
  // σ(z) = N/t + 12·M·z/t³, so the surfaces z = ±t/2 see N/t ± 6·M/t².
  const b = 6 / (t * t);
  return {
    Nx,
    Ny,
    Nxy,
    Mx,
    My,
    Mxy,
    Qx,
    Qy,
    top: surfaceStress(Nx / t + b * Mx, Ny / t + b * My, Nxy / t + b * Mxy),
    bottom: surfaceStress(Nx / t - b * Mx, Ny / t - b * My, Nxy / t - b * Mxy),
  };
}

/**
 * Recovers the stress resultants of a plate from its 24 global displacements
 * ([ux, uy, uz, rx, ry, rz] at each node, in node order).
 *
 * All values are per unit width, in the plate's LOCAL axes, with the sign conventions of
 * `PlateStress`: N = ∫σ dz, M = ∫σ·z dz (positive Mx = tension on the +z surface in local
 * x), Q = ∫τ dz. They are evaluated at the 2 × 2 Gauss points and extrapolated bilinearly to
 * the four corners; the centre is evaluated directly at ξ = η = 0. Surface stresses are
 * σ = N/t ± 6·M/t² (top = +z).
 */
export function plateResult(el: PlateElement, u: number[]): PlateResult3D {
  const { plate, axes, local } = el;
  if (u.length !== 24) {
    throw new SolverError(
      'INVALID_MODEL',
      `Plate "${plate.id}" needs 24 displacements for result recovery, got ${u.length}.`,
      { memberId: plate.id },
    );
  }
  // Local displacements: rotate the translations and the rotations of every node.
  const R = [axes.x, axes.y, axes.z];
  const uLocal = new Array<number>(24).fill(0);
  for (let I = 0; I < 24; I += 3) {
    for (let c = 0; c < 3; c++) {
      uLocal[I + c] = R[c][0] * u[I] + R[c][1] * u[I + 1] + R[c][2] * u[I + 2];
    }
  }
  const um = MEMBRANE_DOFS.map((d) => uLocal[d]);
  const ub = BENDING_DOFS.map((d) => uLocal[d]);
  // Nodal displacements followed by the recovered incompatible-mode parameters.
  const umFull = [...um, ...strains(el.alpha, um)];

  const { Dm, Db, Ds } = sectionStiffness(plate);
  const centre = shapeAt(local, 0, 0);
  const tying = tyingPoints(local);
  const resultantsAt = (xi: number, eta: number): number[] => {
    const s = shapeAt(local, xi, eta);
    const membrane = strains(Dm, strains(membraneB(centre, s, xi, eta), umFull));
    const moments = strains(Db, strains(bendingB(s), ub));
    const shear = strains(shearB(tying, s, xi, eta), ub);
    return [...membrane, ...moments, Ds * shear[0], Ds * shear[1]];
  };

  const atGauss = GAUSS_POINTS.map(([xi, eta]) => resultantsAt(xi, eta));
  // Bilinear extrapolation: the Gauss points sit at ξ, η = ±1/√3, so in the stretched
  // coordinates ξ' = √3·ξ they are the "nodes" of a bilinear surface and corner c lies at
  // ξ' = √3·ξ_c, η' = √3·η_c.
  const root3 = Math.sqrt(3);
  const corners = NODE_XI.map((xiC, c) => {
    const values = new Array<number>(8).fill(0);
    for (let g = 0; g < 4; g++) {
      const weight = ((1 + NODE_XI[g] * root3 * xiC) * (1 + NODE_ETA[g] * root3 * NODE_ETA[c])) / 4;
      for (let k = 0; k < 8; k++) values[k] += weight * atGauss[g][k];
    }
    return plateStress(values, plate.t);
  }) as [PlateStress, PlateStress, PlateStress, PlateStress];
  const center = plateStress(resultantsAt(0, 0), plate.t);

  let maxVonMises = 0;
  for (const state of [center, ...corners]) {
    maxVonMises = Math.max(maxVonMises, state.top.vonMises, state.bottom.vonMises);
  }
  return {
    id: plate.id,
    area: el.area,
    axes: { x: axes.x, y: axes.y, z: axes.z },
    center,
    corners,
    maxVonMises,
  };
}

/**
 * Consistent mass matrix (24 × 24, global axes) of a plate from its mass per unit volume
 * `plate.mass`: ρ·t·∫NᵢNⱼ dA for the three translations and the rotary inertia
 * ρ·t³/12·∫NᵢNⱼ dA for the two bending rotations (Mindlin), none for the drilling rotation.
 * 2 × 2 Gauss is exact (NᵢNⱼ·detJ is at most cubic in ξ and in η).
 */
export function plateMass(el: PlateElement): number[][] {
  const rho = el.plate.mass ?? 0;
  const t = el.plate.t;
  const m = zeros(24, 24);
  if (rho === 0) return m;
  for (const [xi, eta] of GAUSS_POINTS) {
    const s = shapeAt(el.local, xi, eta);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const nn = s.N[i] * s.N[j] * s.detJ;
        for (let c = 0; c < 3; c++) m[6 * i + c][6 * j + c] += rho * t * nn;
        for (let c = 3; c < 5; c++) m[6 * i + c][6 * j + c] += ((rho * t ** 3) / 12) * nn;
      }
    }
  }
  return toGlobal(m, [el.axes.x, el.axes.y, el.axes.z]);
}
