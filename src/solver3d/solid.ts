/**
 * 8-node hexahedral solid element ("brick"): 3 translations per node (24 DOF), isotropic
 * linear elasticity, built directly in global axes.
 *
 * Natural coordinates (ξ, η, ζ) ∈ [−1, 1]³ with the usual node numbering
 *
 *     node   1   2   3   4   5   6   7   8
 *     ξ     −1  +1  +1  −1  −1  +1  +1  −1
 *     η     −1  −1  +1  +1  −1  −1  +1  +1
 *     ζ     −1  −1  −1  −1  +1  +1  +1  +1
 *
 * so nodes 1–4 (ζ = −1) are ordered with their right-hand normal towards the opposite face
 * 5–8 (ζ = +1), which makes the Jacobian determinant positive (see `Solid3D`).
 *
 * Formulation:
 *  - Compatible part: trilinear isoparametric shape functions Nᵢ = ⅛(1 + ξᵢξ)(1 + ηᵢη)(1 + ζᵢζ),
 *    2 × 2 × 2 Gauss integration.
 *  - Wilson–Taylor incompatible modes: every displacement component gets the three extra
 *    functions (1 − ξ²), (1 − η²), (1 − ζ²) with element-internal amplitudes α (9 in total).
 *    They supply the quadratic terms a bending deformation needs and remove the shear
 *    ("parasitic shear") locking of the plain 8-node brick. In the modified form of Taylor,
 *    Beresford & Wilson (1976) used here, the derivatives of the extra functions are formed
 *    with the Jacobian at the element centre and scaled by detJ₀ / detJ:
 *
 *        ∂Mₖ/∂x = (detJ₀ / detJ) · J₀⁻¹ · ∂Mₖ/∂ξ,     ∂Mₖ/∂ξ = −2·ξₖ·eₖ
 *
 *    so that ∫ ∂Mₖ/∂x dV = detJ₀ · J₀⁻¹ · ∫ ∂Mₖ/∂ξ dξ dη dζ = 0 for any element shape. A
 *    constant stress therefore does no work on the extra modes and the element passes the
 *    patch test, also when it is distorted.
 *  - With strains ε = B·u + G·α the element equations are
 *
 *        [ Kuu  Kuα ] [ u ]   [ f ]
 *        [ Kαu  Kαα ] [ α ] = [ 0 ]
 *
 *    (no load is put on the extra modes). Static condensation gives α = −Kαα⁻¹·Kαu·u and
 *    k = Kuu − Kuα·Kαα⁻¹·Kαu. The 9 × 24 recovery matrix −Kαα⁻¹·Kαu is kept for the stresses.
 *
 * Strain / stress order: [xx, yy, zz, xy, yz, zx] with engineering shear strains γ.
 *
 * Loads: uniform face tractions (2 × 2 Gauss on the bilinear face, which may be tilted,
 * non-rectangular or warped) and self-weight (2 × 2 × 2 Gauss over the volume), both turned
 * into consistent nodal forces of the compatible shape functions.
 *
 * Results: stresses σ = D·(B·u + G·α) at the 8 Gauss points, extrapolated trilinearly to the
 * nodes and the centre.
 *
 * Limitations: because the extra modes carry no load, a load that varies the stress inside an
 * element (self-weight, a moment gradient) is represented by its element-wise mean in the
 * direction of the variation; refine the mesh in that direction. Nodal stresses are element
 * values and are not averaged between neighbouring elements.
 */
import { SolverError } from '../solver/errors';
import { zeros } from '../solver/linalg';
import type { ElementMatrices } from './contract';
import { cross, GAUSS2, invert, norm, principal3, sub, vonMises3 } from './math';
import type { Solid3D, SolidFaceLoad3D, SolidResult3D, StressState, Vec3 } from './types';

/** Natural coordinates (ξ, η, ζ) of the eight nodes, in element node order. */
const NODE_NATURAL: readonly (readonly [number, number, number])[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

/**
 * 0-based node indices of the six faces of a solid, in the face numbering documented on
 * `SolidFace` (face 1 = nodes 1-2-3-4, 2 = 5-6-7-8, 3 = 1-2-6-5, 4 = 2-3-7-6, 5 = 3-4-8-7,
 * 6 = 4-1-5-8). Each face is ordered so that its right-hand normal points OUT of the solid;
 * only face 1 has to be reversed for that (1-4-3-2).
 */
export const SOLID_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];

/** Natural (s, t) coordinates of the four nodes of a face, in face node order. */
const FACE_NATURAL: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** Number of element displacements and of condensed incompatible-mode amplitudes. */
const NU = 24;
const NA = 9;

/** One solid prepared for assembly, with the data needed to recover its results. */
export interface SolidElement extends ElementMatrices {
  dofsPerNode: 3;
  /** The solid this element was built from. */
  solid: Solid3D;
  /** Volume of the element (2 × 2 × 2 Gauss integration of detJ, exact for a trilinear hex). */
  volume: number;
  /**
   * Recovery of the condensed incompatible-mode amplitudes: α = modes · u (9 × 24), with
   * α ordered [αx, αy, αz] for the mode (1 − ξ²), then (1 − η²), then (1 − ζ²).
   */
  modes: number[][];
  /**
   * Stress recovery matrices of the eight Gauss points (each 6 × 24): the stress
   * [sxx, syy, szz, txy, tyz, tzx] at a Gauss point is `gaussStress[g] · u`, with the
   * incompatible-mode strains already included. Gauss point g sits at the natural
   * coordinates of node g + 1 divided by √3.
   */
  gaussStress: number[][][];
}

function invalid(solid: Solid3D, problem: string): SolverError {
  return new SolverError('INVALID_MODEL', `Solid "${solid.id}" ${problem}`, {
    memberId: solid.id,
  });
}

/** Trilinear shape functions at (ξ, η, ζ). */
function shape(xi: number, eta: number, zeta: number): number[] {
  return NODE_NATURAL.map(([a, b, c]) => ((1 + a * xi) * (1 + b * eta) * (1 + c * zeta)) / 8);
}

/** Derivatives of the trilinear shape functions with respect to (ξ, η, ζ), one row per node. */
function shapeNatural(xi: number, eta: number, zeta: number): Vec3[] {
  return NODE_NATURAL.map(([a, b, c]) => [
    (a * (1 + b * eta) * (1 + c * zeta)) / 8,
    ((1 + a * xi) * b * (1 + c * zeta)) / 8,
    ((1 + a * xi) * (1 + b * eta) * c) / 8,
  ]);
}

/** Jacobian J[i][j] = ∂x_j/∂ξ_i at a point, its determinant and (when detJ ≠ 0) its inverse. */
interface Jacobian {
  det: number;
  /** inv[j][i] = ∂ξ_i/∂x_j, so that ∂N/∂x_j = Σ_i inv[j][i] · ∂N/∂ξ_i. */
  inv: number[][];
}

function jacobian(dN: Vec3[], coords: Vec3[]): Jacobian {
  const J = zeros(3, 3);
  for (let n = 0; n < 8; n++) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) J[i][j] += dN[n][i] * coords[n][j];
    }
  }
  const c00 = J[1][1] * J[2][2] - J[1][2] * J[2][1];
  const c01 = J[1][2] * J[2][0] - J[1][0] * J[2][2];
  const c02 = J[1][0] * J[2][1] - J[1][1] * J[2][0];
  const det = J[0][0] * c00 + J[0][1] * c01 + J[0][2] * c02;
  // Inverse by the adjugate (transposed cofactors).
  const inv = [
    [
      c00 / det,
      (J[0][2] * J[2][1] - J[0][1] * J[2][2]) / det,
      (J[0][1] * J[1][2] - J[0][2] * J[1][1]) / det,
    ],
    [
      c01 / det,
      (J[0][0] * J[2][2] - J[0][2] * J[2][0]) / det,
      (J[0][2] * J[1][0] - J[0][0] * J[1][2]) / det,
    ],
    [
      c02 / det,
      (J[0][1] * J[2][0] - J[0][0] * J[2][1]) / det,
      (J[0][0] * J[1][1] - J[0][1] * J[1][0]) / det,
    ],
  ];
  return { det, inv };
}

/**
 * Isotropic elasticity matrix (6 × 6) for the stress order [sxx, syy, szz, txy, tyz, tzx] and
 * engineering shear strains.
 */
function elasticity(E: number, nu: number): number[][] {
  const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const G = E / (2 * (1 + nu));
  const D = zeros(6, 6);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) D[i][j] = lambda + (i === j ? 2 * G : 0);
    D[i + 3][i + 3] = G;
  }
  return D;
}

/**
 * Strain–displacement matrix (6 × 3m) of m interpolation functions with the Cartesian
 * gradients `grads`, each acting on the three displacement components [ux, uy, uz].
 */
function strainMatrix(grads: Vec3[]): number[][] {
  const B = zeros(6, 3 * grads.length);
  grads.forEach(([gx, gy, gz], n) => {
    const c = 3 * n;
    B[0][c] = gx;
    B[1][c + 1] = gy;
    B[2][c + 2] = gz;
    B[3][c] = gy;
    B[3][c + 1] = gx;
    B[4][c + 1] = gz;
    B[4][c + 2] = gy;
    B[5][c] = gz;
    B[5][c + 2] = gx;
  });
  return B;
}

/**
 * Checks the node positions: the Jacobian determinant must be positive at the centre, at every
 * Gauss point and at every corner. Returns the centre Jacobian.
 */
function checkedGeometry(solid: Solid3D, coords: Vec3[]): Jacobian {
  if (coords.length !== 8) {
    throw invalid(solid, `needs exactly eight node positions, got ${coords.length}.`);
  }
  if (coords.some((p) => p.length !== 3 || p.some((v) => !Number.isFinite(v)))) {
    throw invalid(solid, 'has a node position that is not a finite number.');
  }
  // Characteristic size: the largest distance between two nodes. A determinant below a
  // rounding-level fraction of size³ is treated as zero (collapsed element).
  let size = 0;
  for (let a = 0; a < 8; a++) {
    for (let b = a + 1; b < 8; b++) size = Math.max(size, norm(sub(coords[a], coords[b])));
  }
  const tol = 1e-12 * size ** 3;
  const g = GAUSS2[1];
  const points: (readonly [number, number, number])[] = [[0, 0, 0]];
  for (const [a, b, c] of NODE_NATURAL) points.push([a * g, b * g, c * g], [a, b, c]);
  let centre: Jacobian | undefined;
  for (const [xi, eta, zeta] of points) {
    const jac = jacobian(shapeNatural(xi, eta, zeta), coords);
    if (!(jac.det > tol)) {
      throw invalid(
        solid,
        'is inverted or too distorted (its Jacobian determinant is not positive everywhere). ' +
          'List nodes 1–4 around one face so that their right-hand normal points towards the ' +
          'opposite face, then nodes 5–8 on that opposite face with 5 connected to 1, 6 to 2, ' +
          '7 to 3 and 8 to 4; no face may be collapsed or folded.',
      );
    }
    centre ??= jac;
  }
  return centre as Jacobian;
}

/**
 * Consistent nodal forces (24, global axes) of a uniform load on one face: f = ∫ Nᵀ·t dA with
 * 2 × 2 Gauss on the bilinear face. The outward normal times the area element is the cross
 * product of the two tangent vectors, n·dA = (∂x/∂s × ∂x/∂t) ds dt, because `SOLID_FACES`
 * orders every face counter-clockwise when seen from outside.
 */
function addFaceLoad(f: number[], solid: Solid3D, coords: Vec3[], load: SolidFaceLoad3D): void {
  const face = SOLID_FACES[load.face - 1];
  if (!Number.isInteger(load.face) || face === undefined) {
    throw invalid(solid, `has a face load on face "${String(load.face)}"; faces are 1 to 6.`);
  }
  if (!Number.isFinite(load.p)) throw invalid(solid, 'has a face load with an invalid intensity.');
  const axis = { globalX: 0, globalY: 1, globalZ: 2, normal: -1 }[load.direction];
  if (axis === undefined) {
    throw invalid(solid, `has a face load with an unknown direction "${String(load.direction)}".`);
  }
  for (const s of GAUSS2) {
    for (const t of GAUSS2) {
      const N = FACE_NATURAL.map(([a, b]) => ((1 + a * s) * (1 + b * t)) / 4);
      const ts: Vec3 = [0, 0, 0];
      const tt: Vec3 = [0, 0, 0];
      FACE_NATURAL.forEach(([a, b], n) => {
        const p = coords[face[n]];
        for (let j = 0; j < 3; j++) {
          ts[j] += ((a * (1 + b * t)) / 4) * p[j];
          tt[j] += (((1 + a * s) * b) / 4) * p[j];
        }
      });
      const normalArea = cross(ts, tt);
      // Traction × area element: a pressure pushes against the outward normal (into the
      // solid); a global traction acts along the + axis on the true area |n·dA|.
      const q: Vec3 = [0, 0, 0];
      if (axis < 0) {
        for (let j = 0; j < 3; j++) q[j] = -load.p * normalArea[j];
      } else {
        q[axis] = load.p * norm(normalArea);
      }
      for (let n = 0; n < 4; n++) {
        for (let j = 0; j < 3; j++) f[3 * face[n] + j] += N[n] * q[j];
      }
    }
  }
}

/**
 * Builds the stiffness matrix and the equivalent nodal load vector of one solid in global
 * axes, in the DOF order [ux, uy, uz] × 8 nodes.
 *
 * `coords` are the eight node positions in element node order (see `Solid3D`), `loads` the
 * face loads that name this solid and `gravity` the summed self-weight vector g (body force
 * per unit volume = density · g).
 *
 * Face loads are uniform per unit area of the face: `normal` is a pressure, positive pushing
 * INTO the solid; `globalX/Y/Z` are tractions, positive along the + axis. No load is put on
 * the incompatible modes.
 *
 * Throws `SolverError('INVALID_MODEL', …, { memberId: solid.id })` for an inverted,
 * collapsed or badly distorted element, for E <= 0 or ν outside (−1, 0.5), and for invalid
 * loads.
 */
export function solidElement(
  solid: Solid3D,
  coords: Vec3[],
  loads: SolidFaceLoad3D[],
  gravity: Vec3,
): SolidElement {
  const { E, nu } = solid;
  if (!(E > 0) || !Number.isFinite(E)) {
    throw invalid(solid, 'needs a positive modulus of elasticity E.');
  }
  if (!(nu > -1 && nu < 0.5)) {
    throw invalid(solid, "needs a Poisson's ratio between −1 and 0.5 (exclusive).");
  }
  const density = solid.density ?? 0;
  if (!Number.isFinite(density)) throw invalid(solid, 'has an invalid density.');
  if (gravity.some((v) => !Number.isFinite(v))) {
    throw invalid(solid, 'received an invalid self-weight vector.');
  }
  const centre = checkedGeometry(solid, coords);
  const D = elasticity(E, nu);

  // Full 33 × 33 stiffness of the 24 displacements followed by the 9 mode amplitudes.
  const NT = NU + NA;
  const kFull = zeros(NT, NT);
  const f = new Array<number>(NU).fill(0);
  const body: Vec3 = [density * gravity[0], density * gravity[1], density * gravity[2]];
  let volume = 0;
  /** D·[B G] at each Gauss point (6 × 33), turned into stress recovery matrices below. */
  const stressFull: number[][][] = [];

  const g = GAUSS2[1];
  for (const [a, b, c] of NODE_NATURAL) {
    const natural = [a * g, b * g, c * g];
    const N = shape(natural[0], natural[1], natural[2]);
    const dN = shapeNatural(natural[0], natural[1], natural[2]);
    const { det, inv } = jacobian(dN, coords);
    // Cartesian gradients: the 8 compatible functions with the local Jacobian, then the 3
    // incompatible modes with the centre Jacobian, scaled by detJ0 / detJ.
    const grads: Vec3[] = dN.map((d) => [
      inv[0][0] * d[0] + inv[0][1] * d[1] + inv[0][2] * d[2],
      inv[1][0] * d[0] + inv[1][1] * d[1] + inv[1][2] * d[2],
      inv[2][0] * d[0] + inv[2][1] * d[1] + inv[2][2] * d[2],
    ]);
    for (let m = 0; m < 3; m++) {
      const factor = (centre.det / det) * (-2 * natural[m]);
      grads.push([centre.inv[0][m] * factor, centre.inv[1][m] * factor, centre.inv[2][m] * factor]);
    }
    const B = strainMatrix(grads);
    const DB = zeros(6, NT);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const d = D[i][j];
        if (d === 0) continue;
        for (let col = 0; col < NT; col++) DB[i][col] += d * B[j][col];
      }
    }
    stressFull.push(DB);
    // Gauss weights are 1, so the integration weight is detJ alone.
    for (let r = 0; r < NT; r++) {
      for (let col = r; col < NT; col++) {
        let sum = 0;
        for (let i = 0; i < 6; i++) sum += B[i][r] * DB[i][col];
        kFull[r][col] += sum * det;
      }
    }
    volume += det;
    for (let n = 0; n < 8; n++) {
      for (let j = 0; j < 3; j++) f[3 * n + j] += N[n] * body[j] * det;
    }
  }
  for (let r = 0; r < NT; r++) {
    for (let col = 0; col < r; col++) kFull[r][col] = kFull[col][r];
  }

  // Static condensation of the mode amplitudes: α = −Kαα⁻¹·Kαu·u.
  const kaa = kFull.slice(NU).map((row) => row.slice(NU));
  const kaaInv = invert(kaa);
  if (!kaaInv) {
    throw invalid(solid, 'is too distorted: its incompatible-mode stiffness is singular.');
  }
  const modes = zeros(NA, NU);
  for (let a = 0; a < NA; a++) {
    for (let col = 0; col < NU; col++) {
      let sum = 0;
      for (let b = 0; b < NA; b++) sum += kaaInv[a][b] * kFull[NU + b][col];
      modes[a][col] = -sum;
    }
  }
  const k = zeros(NU, NU);
  for (let r = 0; r < NU; r++) {
    for (let col = r; col < NU; col++) {
      let sum = kFull[r][col];
      for (let a = 0; a < NA; a++) sum += kFull[r][NU + a] * modes[a][col];
      k[r][col] = sum;
      k[col][r] = sum;
    }
  }
  const gaussStress = stressFull.map((DB) =>
    DB.map((row) => {
      const out = row.slice(0, NU);
      for (let a = 0; a < NA; a++) {
        const d = row[NU + a];
        if (d === 0) continue;
        for (let col = 0; col < NU; col++) out[col] += d * modes[a][col];
      }
      return out;
    }),
  );

  for (const load of loads) addFaceLoad(f, solid, coords, load);

  return {
    nodes: solid.nodes.slice(),
    dofsPerNode: 3,
    k,
    f,
    solid,
    volume,
    modes,
    gaussStress,
  };
}

/** Completes a stress tensor [sxx, syy, szz, txy, tyz, tzx] with its invariants. */
function stressState(s: number[]): StressState {
  const [sxx, syy, szz, txy, tyz, tzx] = s;
  const [s1, s2, s3] = principal3(sxx, syy, szz, txy, tyz, tzx);
  return {
    sxx,
    syy,
    szz,
    txy,
    tyz,
    tzx,
    s1,
    s2,
    s3,
    vonMises: vonMises3(sxx, syy, szz, txy, tyz, tzx),
  };
}

/**
 * Stresses of one solid from its 24 global displacements `u` ([ux, uy, uz] × 8 nodes, element
 * node order). Stresses are in global axes, tension positive, in the unit of E. They are
 * evaluated at the 2 × 2 × 2 Gauss points (compatible + incompatible-mode strains) and
 * extrapolated trilinearly to the eight nodes (`corners`, node order) and to the centre
 * ξ = η = ζ = 0; principal stresses and von Mises are computed from the extrapolated tensors.
 * `maxVonMises` is the largest von Mises stress over the centre and the corners.
 */
export function solidResult(el: SolidElement, u: number[]): SolidResult3D {
  if (u.length !== NU || u.some((v) => !Number.isFinite(v))) {
    throw invalid(el.solid, `needs 24 finite displacements for result recovery.`);
  }
  const gauss = el.gaussStress.map((S) =>
    S.map((row) => {
      let sum = 0;
      for (let col = 0; col < NU; col++) sum += row[col] * u[col];
      return sum;
    }),
  );
  // The Gauss points are the "nodes" of a trilinear field on the cube [−1/√3, 1/√3]³; in
  // its own natural coordinates an element corner is at ±√3 and the centre at 0.
  const extrapolate = (xi: number, eta: number, zeta: number): number[] => {
    const N = shape(xi, eta, zeta);
    const s = new Array<number>(6).fill(0);
    for (let p = 0; p < 8; p++) {
      for (let i = 0; i < 6; i++) s[i] += N[p] * gauss[p][i];
    }
    return s;
  };
  const r = Math.sqrt(3);
  const center = stressState(extrapolate(0, 0, 0));
  const corners = NODE_NATURAL.map(([a, b, c]) => stressState(extrapolate(a * r, b * r, c * r)));
  let maxVonMises = center.vonMises;
  for (const corner of corners) maxVonMises = Math.max(maxVonMises, corner.vonMises);
  return { id: el.solid.id, volume: el.volume, center, corners, maxVonMises };
}
