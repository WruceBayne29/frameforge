/** Small vector / dense-matrix helpers shared by the 3D element modules. */
import type { Vec3 } from './types';

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Unit vector along `a`; returns [0, 0, 0] for a zero vector. */
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

/** Gauss–Legendre points on [-1, 1] for the 2-point rule (weights are 1). */
export const GAUSS2: readonly number[] = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];

/**
 * Inverse of a small square matrix by Gauss–Jordan elimination with partial pivoting.
 * Returns null when the matrix is singular to working precision.
 */
export function invert(a: number[][]): number[][] | null {
  const n = a.length;
  const m = a.map((row, i) => {
    const extended = row.slice();
    for (let j = 0; j < n; j++) extended.push(i === j ? 1 : 0);
    return extended;
  });
  let scaleMax = 0;
  for (const row of a) for (const v of row) scaleMax = Math.max(scaleMax, Math.abs(v));
  if (!(scaleMax > 0)) return null;

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (!(Math.abs(m[pivot][col]) > 1e-14 * scaleMax)) return null;
    if (pivot !== col) [m[pivot], m[col]] = [m[col], m[pivot]];
    const p = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= factor * m[col][j];
    }
  }
  return m.map((row) => row.slice(n));
}

/** von Mises stress of a 3D stress state. */
export function vonMises3(
  sxx: number,
  syy: number,
  szz: number,
  txy: number,
  tyz: number,
  tzx: number,
): number {
  return Math.sqrt(
    0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) +
      3 * (txy * txy + tyz * tyz + tzx * tzx),
  );
}

/** Index pairs (p, q) rotated in one Jacobi sweep of a 3 × 3 matrix, with the third index r. */
const JACOBI_PAIRS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 2, 0],
];

/**
 * Principal stresses of a 3D stress state, sorted s1 >= s2 >= s3 (same unit as the input).
 *
 * Computed by cyclic Jacobi rotations of the 3 × 3 stress tensor rather than by the
 * trigonometric (Cardano) closed form: that formula obtains the angle from the stress
 * invariants, which loses half of the significant digits whenever two principal stresses
 * coincide (uniaxial, equibiaxial, nearly hydrostatic states), giving errors of about
 * 1e-8·|σ| and occasionally s2 < s3. Jacobi rotations are accurate to rounding for every
 * state, and a state without shear components is returned exactly.
 */
export function principal3(
  sxx: number,
  syy: number,
  szz: number,
  txy: number,
  tyz: number,
  tzx: number,
): [number, number, number] {
  const a = [
    [sxx, txy, tzx],
    [txy, syy, tyz],
    [tzx, tyz, szz],
  ];
  const size = Math.max(
    Math.abs(sxx),
    Math.abs(syy),
    Math.abs(szz),
    Math.abs(txy),
    Math.abs(tyz),
    Math.abs(tzx),
  );
  // The off-diagonal terms shrink quadratically from sweep to sweep; four to six sweeps
  // bring them far below the rounding error of the diagonal (the cap is only a safeguard).
  for (let sweep = 0; sweep < 30; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (!(off > Number.EPSILON * Number.EPSILON * size)) break;
    for (const [p, q, r] of JACOBI_PAIRS) {
      const apq = a[p][q];
      if (apq === 0) continue;
      // Rotation in the p–q plane that annihilates a_pq; t = tan(angle), |angle| <= 45°.
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.hypot(theta, 1));
      const c = 1 / Math.hypot(t, 1);
      const s = t * c;
      a[p][p] -= t * apq;
      a[q][q] += t * apq;
      a[p][q] = 0;
      a[q][p] = 0;
      const arp = a[r][p];
      const arq = a[r][q];
      a[r][p] = c * arp - s * arq;
      a[p][r] = a[r][p];
      a[r][q] = s * arp + c * arq;
      a[q][r] = a[r][q];
    }
  }
  let s1 = a[0][0];
  let s2 = a[1][1];
  let s3 = a[2][2];
  if (s1 < s2) [s1, s2] = [s2, s1];
  if (s2 < s3) [s2, s3] = [s3, s2];
  if (s1 < s2) [s1, s2] = [s2, s1];
  return [s1, s2, s3];
}

/** Principal stresses (s1 >= s2) and von Mises stress of a plane-stress state. */
export function planeStress(
  sx: number,
  sy: number,
  txy: number,
): { s1: number; s2: number; vonMises: number } {
  const mean = (sx + sy) / 2;
  const radius = Math.hypot((sx - sy) / 2, txy);
  return {
    s1: mean + radius,
    s2: mean - radius,
    vonMises: Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * txy * txy),
  };
}
