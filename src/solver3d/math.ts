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

/** Principal stresses of a 3D stress state, sorted s1 >= s2 >= s3 (closed form). */
export function principal3(
  sxx: number,
  syy: number,
  szz: number,
  txy: number,
  tyz: number,
  tzx: number,
): [number, number, number] {
  const mean = (sxx + syy + szz) / 3;
  const dx = sxx - mean;
  const dy = syy - mean;
  const dz = szz - mean;
  // Second and third invariants of the deviatoric stress.
  const j2 = 0.5 * (dx * dx + dy * dy + dz * dz) + txy * txy + tyz * tyz + tzx * tzx;
  if (!(j2 > 0)) return [mean, mean, mean];
  const j3 = dx * dy * dz + 2 * txy * tyz * tzx - dx * tyz * tyz - dy * tzx * tzx - dz * txy * txy;
  const r = Math.sqrt(j2 / 3);
  const cos3 = Math.max(-1, Math.min(1, j3 / (2 * r * r * r)));
  const angle = Math.acos(cos3) / 3;
  const s1 = mean + 2 * r * Math.cos(angle);
  const s3 = mean + 2 * r * Math.cos(angle + (2 * Math.PI) / 3);
  const s2 = 3 * mean - s1 - s3;
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
