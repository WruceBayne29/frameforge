/**
 * Lowest eigenpairs of the generalised symmetric problem K·φ = λ·M·φ by subspace iteration
 * (Bathe), using one LDLᵀ factorisation of the skyline stiffness and a dense Jacobi solve of
 * the small projected problem at every iteration.
 *
 * K must be symmetric positive definite (mechanisms are restrained by the caller's
 * factorisation) and M symmetric positive semi-definite: massless degrees of freedom simply
 * give infinite eigenvalues, which subspace iteration never converges to.
 */
import type { SkylineMatrix } from './sparse';

/**
 * Eigenvalues and eigenvectors of a small dense symmetric matrix by the cyclic Jacobi method.
 * Eigenvalues ascending; eigenvectors are the columns of `vectors`.
 */
export function jacobiEigen(input: number[][]): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    let diag = 0;
    for (let i = 0; i < n; i++) {
      diag += a[i][i] * a[i][i];
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    }
    if (off <= 1e-28 * (diag + off)) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (apq === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map((i) => a[i][i]), vectors: v.map((row) => order.map((i) => row[i])) };
}

export interface SubspaceOptions {
  /** Relative change of the wanted eigenvalues between iterations that counts as converged. */
  tolerance?: number;
  maxIterations?: number;
}

export interface SubspaceResult {
  /** Wanted eigenvalues, ascending. */
  values: number[];
  /** Matching eigenvectors, M-orthonormal (φᵀ·M·φ = 1). */
  vectors: Float64Array[];
  iterations: number;
  converged: boolean;
}

/** Small deterministic pseudo-random sequence (reproducible starting vectors). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000 - 0.5;
  };
}

/**
 * Lowest `count` eigenpairs of K·φ = λ·M·φ. `factored` is the factorised stiffness, `multiplyK`
 * multiplies by the unfactorised one; `multiplyM` returns M·x; `kDiagonal` and `mDiagonal`
 * (of the unfactorised matrices) choose the starting vectors. Uses
 * q = min(n, max(2·count, count + 8)) iteration vectors.
 *
 * Every iteration solves K·X̄ = M·X, M-orthonormalises X̄ (modified Gram–Schmidt, twice;
 * vectors that collapse are replaced by fresh ones) and solves the projected problem
 * X̄ᵀ·K·X̄·q = λ·q (Rayleigh–Ritz) by Jacobi. Orthonormalising before projecting keeps the
 * small problem well conditioned even when the vectors are nearly parallel. When the largest
 * Ritz value stays within 50 % of the last wanted one (a cluster of close eigenvalues), the
 * subspace is widened by 8 vectors every 8 iterations, up to 120.
 */
export function subspaceIteration(
  factored: SkylineMatrix,
  multiplyK: (x: Float64Array) => Float64Array,
  multiplyM: (x: Float64Array) => Float64Array,
  kDiagonal: ArrayLike<number>,
  mDiagonal: ArrayLike<number>,
  count: number,
  options: SubspaceOptions = {},
): SubspaceResult {
  const n = factored.n;
  const massive: number[] = [];
  for (let i = 0; i < n; i++) if (mDiagonal[i] > 0) massive.push(i);
  // Only DOFs with mass can take part in a finite-frequency mode.
  const wanted = Math.min(count, massive.length);
  if (wanted <= 0) return { values: [], vectors: [], iterations: 0, converged: true };
  const q = Math.min(massive.length, Math.max(2 * wanted, wanted + 8));
  /** Largest subspace the iteration may widen to. */
  const cap = Math.min(massive.length, Math.max(q, 120));
  const tol = options.tolerance ?? 1e-10;
  const maxIterations = options.maxIterations ?? 200;
  const rand = random(12345);
  const noise = () => {
    const x = new Float64Array(n);
    for (const i of massive) x[i] = rand();
    return x;
  };
  const dot = (a: Float64Array, b: Float64Array) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  };

  // Starting vectors: the mass diagonal, unit vectors at the DOFs with the largest m/k ratio
  // and a little noise so no vector is orthogonal to a wanted mode.
  const ratio = (i: number) => (kDiagonal[i] > 0 ? mDiagonal[i] / kDiagonal[i] : 0);
  const ranked = massive.slice().sort((a, b) => ratio(b) - ratio(a));
  let X: Float64Array[] = [];
  for (let k = 0; k < q; k++) {
    const x = noise().map((v) => 1e-3 * v);
    if (k === 0) for (const i of massive) x[i] += mDiagonal[i];
    else x[ranked[(k - 1) % ranked.length]] += 1;
    X.push(x);
  }

  /** M-orthonormal copy of the vectors (replacing any that collapse). */
  const orthonormalise = (vectors: Float64Array[]): { V: Float64Array[]; MV: Float64Array[] } => {
    const V: Float64Array[] = [];
    const MV: Float64Array[] = [];
    for (const start of vectors) {
      let x: Float64Array = Float64Array.from(start);
      for (let attempt = 0; attempt < 4; attempt++) {
        // A copy: multiplyM may return its argument (M = I).
        const mx: Float64Array = Float64Array.from(multiplyM(x));
        const before = Math.sqrt(Math.max(dot(x, mx), 0));
        for (let pass = 0; pass < 2; pass++) {
          for (let j = 0; j < V.length; j++) {
            const c = dot(V[j], mx);
            if (c === 0) continue;
            const v = V[j];
            const mv = MV[j];
            for (let i = 0; i < n; i++) {
              x[i] -= c * v[i];
              mx[i] -= c * mv[i];
            }
          }
        }
        const norm = Math.sqrt(Math.max(dot(x, mx), 0));
        if (norm > 1e-8 * before && norm > 0) {
          for (let i = 0; i < n; i++) {
            x[i] /= norm;
            mx[i] /= norm;
          }
          V.push(x);
          MV.push(mx);
          break;
        }
        // Collapsed: it was (numerically) in the span of the others; try a fresh vector.
        x = factored.solve(multiplyM(noise()));
      }
    }
    return { V, MV };
  };

  let previous: number[] = [];
  let values: number[] = [];
  let iterations: number;
  let converged = false;
  for (iterations = 1; iterations <= maxIterations; iterations++) {
    const Xbar = X.map((x) => factored.solve(multiplyM(x)));
    const { V } = orthonormalise(Xbar);
    const KV = V.map(multiplyK);
    const size = V.length;
    const Kr = V.map((a, i) => V.map((_, j) => (j < i ? 0 : dot(a, KV[j]))));
    for (let i = 0; i < size; i++) for (let j = 0; j < i; j++) Kr[i][j] = Kr[j][i];
    const eig = jacobiEigen(Kr);
    X = eig.vectors[0].map((_, k) => {
      const x = new Float64Array(n);
      for (let j = 0; j < size; j++) {
        const c = eig.vectors[j][k];
        if (c === 0) continue;
        const v = V[j];
        for (let i = 0; i < n; i++) x[i] += c * v[i];
      }
      return x;
    });
    values = eig.values.slice(0, wanted);
    if (
      previous.length === values.length &&
      values.every((v, k) => Math.abs(v - previous[k]) <= tol * Math.abs(v))
    ) {
      converged = true;
      break;
    }
    previous = values;
    // A cluster of nearly equal eigenvalues around the last wanted one (e.g. the local modes
    // of many identical members) stalls the iteration, whose rate is λ_wanted / λ_(q+1).
    // Widen the subspace with fresh vectors until it reaches well past the cluster.
    const top = eig.values[size - 1];
    if (iterations % 8 === 0 && X.length < cap && top < 1.5 * values[wanted - 1]) {
      for (let k = 0; k < 8 && X.length < cap; k++) X.push(noise());
    }
  }
  return {
    values,
    vectors: X.slice(0, values.length),
    iterations: Math.min(iterations, maxIterations),
    converged,
  };
}
