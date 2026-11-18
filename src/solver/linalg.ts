/** Small dense linear-algebra helpers. Matrices are `number[][]` (row-major). */

import type { Matrix, Vector } from '../solver3d/linalg';
import { zeros } from '../solver3d/linalg';

// The basic helpers are shared with the 3D solver, which owns them.
export { gauss3, matMul, matVec, transpose, zeros } from '../solver3d/linalg';
export type { Matrix, Vector } from '../solver3d/linalg';

/** Result of a Cholesky factorisation attempt. */
export type CholeskyResult =
  { ok: true; L: Matrix } | { ok: false; pivotIndex: number; pivot: number };

/**
 * Cholesky factorisation A = L·Lᵀ of a symmetric matrix. Returns the index of the first
 * non-positive (relative to `tol`·original diagonal) pivot if A is not positive definite,
 * which for a stiffness matrix signals a mechanism at that degree of freedom.
 */
export function cholesky(a: Matrix, tol = 1e-10): CholeskyResult {
  const n = a.length;
  const L = zeros(n, n);
  for (let j = 0; j < n; j++) {
    let d = a[j][j];
    for (let k = 0; k < j; k++) d -= L[j][k] * L[j][k];
    const scale = Math.abs(a[j][j]);
    if (!(d > tol * scale) || !Number.isFinite(d)) {
      return { ok: false, pivotIndex: j, pivot: d };
    }
    const ljj = Math.sqrt(d);
    L[j][j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let s = a[i][j];
      const li = L[i];
      const lj = L[j];
      for (let k = 0; k < j; k++) s -= li[k] * lj[k];
      li[j] = s / ljj;
    }
  }
  return { ok: true, L };
}

/** Solves L·Lᵀ·x = b given the Cholesky factor L. */
export function choleskySolve(L: Matrix, b: Vector): Vector {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    const li = L[i];
    for (let k = 0; k < i; k++) s -= li[k] * y[k];
    y[i] = s / li[i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}
