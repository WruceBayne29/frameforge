/** Small dense linear-algebra helpers. Matrices are `number[][]` (row-major). */

export type Matrix = number[][];
export type Vector = number[];

export function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export function transpose(a: Matrix): Matrix {
  const rows = a.length;
  const cols = rows === 0 ? 0 : a[0].length;
  const t = zeros(cols, rows);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) t[j][i] = a[i][j];
  return t;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const m = b.length;
  const p = m === 0 ? 0 : b[0].length;
  const out = zeros(n, p);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < p; j++) out[i][j] += aik * b[k][j];
    }
  }
  return out;
}

export function matVec(a: Matrix, x: Vector): Vector {
  return a.map((row) => row.reduce((sum, v, j) => sum + v * x[j], 0));
}

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

/** Gauss–Legendre points and weights on [-1, 1]. */
const GAUSS_3: ReadonlyArray<readonly [number, number]> = [
  [-Math.sqrt(3 / 5), 5 / 9],
  [0, 8 / 9],
  [Math.sqrt(3 / 5), 5 / 9],
];

/** Integrates f over [a, b] with 3-point Gauss quadrature (exact up to degree 5). */
export function gauss3(f: (x: number) => number, a: number, b: number): number {
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  let sum = 0;
  for (const [xi, w] of GAUSS_3) sum += w * f(mid + half * xi);
  return sum * half;
}
