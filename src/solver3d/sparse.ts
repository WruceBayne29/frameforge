/**
 * Sparse symmetric direct solver for the 3D assembler.
 *
 * Models with plates and solids reach thousands of equations, where the dense `number[][]`
 * Cholesky of the 2D solver (O(n³) time, O(n²) memory) is far too slow. A stiffness matrix
 * is sparse, and with a good equation numbering all of its non-zeros sit close to the
 * diagonal, so this module provides
 *
 *   - `rcmOrder`       reverse Cuthill–McKee numbering, which pulls the non-zeros towards
 *                      the diagonal, and
 *   - `SkylineMatrix`  skyline (variable-band / profile) storage of the upper triangle on a
 *                      single `Float64Array`, with an in-place LDLᵀ factorisation.
 *
 * Storage. Column j of the upper triangle is stored from its first possibly non-zero row
 * `firstRow[j]` down to the diagonal, columns one after another. Elimination only creates
 * fill-in below the first non-zero of a column, so the factor fits in the same profile and
 * the factorisation needs no extra memory.
 *
 * Factorisation. A = Uᵀ·D·U with U unit upper triangular and D diagonal, computed column by
 * column (left-looking "active column" scheme). For column j, with g_ij = d_i·u_ij:
 *
 *   g_ij = a_ij − Σ_{k<i} u_ki·g_kj      i = firstRow[j] … j−1, in increasing order
 *   u_ij = g_ij / d_i
 *   d_j  = a_jj − Σ_{i<j} u_ij·g_ij
 *
 * The inner sum is a dot product of two contiguous stretches of the coefficient array (the
 * finished column i and the partly reduced column j), restricted to the rows both columns
 * store. No square roots are taken, so the sign of every pivot is available: a pivot that is
 * not clearly positive means the matrix is not positive definite, which for a stiffness
 * matrix is a mechanism (or an unsupported structure) at that equation.
 *
 * Misuse of the API (an entry outside the profile, solving before factorising, …) throws a
 * plain `Error` / `RangeError`: those are programming errors in the caller, not problems of
 * the user's model, so they are deliberately not `SolverError`s.
 */

/** Index validation shared by the graph helpers. */
function checkIndex(index: number, n: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new RangeError(`${what} ${index} is outside 0..${n - 1}`);
  }
}

/**
 * Compressed, cleaned copy of an adjacency structure: for vertex v the neighbours are
 * `adj[start[v] .. start[v + 1])`, sorted ascending, without duplicates or self-loops, and
 * symmetric (an edge listed on one side only is added to the other).
 */
function compressGraph(adjacency: ReadonlyArray<ReadonlyArray<number>>): {
  start: Int32Array;
  adj: Int32Array;
} {
  const n = adjacency.length;
  // Count both directions of every listed edge (duplicates are removed afterwards).
  const raw = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) {
    for (const w of adjacency[v]) {
      checkIndex(w, n, 'Neighbour index');
      if (w === v) continue;
      raw[v + 1]++;
      raw[w + 1]++;
    }
  }
  for (let v = 0; v < n; v++) raw[v + 1] += raw[v];
  const fill = raw.slice(0, n);
  const list = new Int32Array(raw[n]);
  for (let v = 0; v < n; v++) {
    for (const w of adjacency[v]) {
      if (w === v) continue;
      list[fill[v]++] = w;
      list[fill[w]++] = v;
    }
  }
  // Sort every row and squeeze out the duplicates in place.
  const start = new Int32Array(n + 1);
  let out = 0;
  for (let v = 0; v < n; v++) {
    const row = list.subarray(raw[v], raw[v + 1]).sort();
    start[v] = out;
    let previous = -1;
    for (let k = 0; k < row.length; k++) {
      const w = row[k];
      if (w !== previous) list[out++] = w;
      previous = w;
    }
  }
  start[n] = out;
  return { start, adj: list.subarray(0, out) };
}

/**
 * Reverse Cuthill–McKee ordering of an undirected graph given as adjacency lists
 * (vertex → neighbours). Returns `order`, where `order[k]` is the original vertex placed
 * k-th; numbering the equations in that sequence gives a small skyline profile.
 *
 * Each connected component is numbered breadth-first from a pseudo-peripheral vertex
 * (George–Liu search started at the component's minimum-degree vertex), visiting the
 * neighbours of a vertex in order of increasing degree; the complete sequence is then
 * reversed. Disconnected graphs and isolated vertices are handled, the input lists may
 * contain duplicates, self-loops or one-sided edges, and every tie is broken by the lower
 * vertex index, so the result depends only on the graph and is deterministic.
 */
export function rcmOrder(adjacency: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const n = adjacency.length;
  const { start, adj } = compressGraph(adjacency);
  const degree = (v: number): number => start[v + 1] - start[v];

  const order = new Int32Array(n); // finished components first, then the BFS work area
  const numbered = new Uint8Array(n);
  const mark = new Int32Array(n); // mark[v] === stamp: v was reached by the current sweep
  let stamp = 0;
  let levelStart = 0; // set by sweep(): where the last BFS level begins in `order`
  let levelCount = 0; // set by sweep(): number of BFS levels (eccentricity + 1)

  /**
   * Breadth-first sweep from `root`, written to order[base ..]; returns the number of
   * vertices reached. With `byDegree` the newly found neighbours of each vertex are queued
   * in order of increasing degree (the Cuthill–McKee rule).
   */
  const sweep = (root: number, base: number, byDegree: boolean): number => {
    stamp++;
    mark[root] = stamp;
    order[base] = root;
    let head = base;
    let tail = base + 1;
    let levelEnd = tail; // one past the last vertex of the level being expanded
    levelStart = base;
    levelCount = 1;
    while (head < tail) {
      if (head === levelEnd) {
        levelStart = head;
        levelEnd = tail;
        levelCount++;
      }
      const v = order[head++];
      const first = tail;
      for (let p = start[v]; p < start[v + 1]; p++) {
        const w = adj[p];
        if (mark[w] === stamp) continue;
        mark[w] = stamp;
        // Rows are sorted by index, so a stable insertion by degree breaks ties by index.
        let q = tail++;
        if (byDegree) {
          const dw = degree(w);
          while (q > first && degree(order[q - 1]) > dw) {
            order[q] = order[q - 1];
            q--;
          }
        }
        order[q] = w;
      }
    }
    return tail - base;
  };

  /** Minimum-degree vertex of order[from .. to), lowest index on ties. */
  const minDegreeVertex = (from: number, to: number): number => {
    let best = order[from];
    for (let k = from + 1; k < to; k++) {
      const v = order[k];
      const dv = degree(v);
      const db = degree(best);
      if (dv < db || (dv === db && v < best)) best = v;
    }
    return best;
  };

  let base = 0;
  for (let seed = 0; seed < n; seed++) {
    if (numbered[seed]) continue;
    // Collect the component, then walk towards a pseudo-peripheral vertex: keep moving to a
    // minimum-degree vertex of the farthest level while that makes the level structure
    // deeper (and therefore narrower).
    const size = sweep(seed, base, false);
    let root = minDegreeVertex(base, base + size);
    sweep(root, base, false);
    let depth = levelCount;
    for (;;) {
      const candidate = minDegreeVertex(levelStart, base + size);
      sweep(candidate, base, false);
      if (levelCount <= depth) break;
      root = candidate;
      depth = levelCount;
    }
    sweep(root, base, true);
    for (let k = base; k < base + size; k++) numbered[order[k]] = 1;
    base += size;
  }
  return Array.from(order).reverse();
}

/**
 * Inverse of a permutation: `position[v]` is the place of vertex v in `order`
 * (`position[order[k]] = k`). With `order = rcmOrder(…)` this maps an original vertex to its
 * new number. Throws if `order` is not a permutation of 0..n−1.
 */
export function invertPermutation(order: ArrayLike<number>): number[] {
  const n = order.length;
  const position = new Array<number>(n).fill(-1);
  for (let k = 0; k < n; k++) {
    const v = order[k];
    checkIndex(v, n, 'Permutation entry');
    if (position[v] !== -1) throw new RangeError(`Permutation entry ${v} occurs twice`);
    position[v] = k;
  }
  return position;
}

/**
 * Adjacency lists of the graph in which all indices of one connectivity list are mutually
 * adjacent (the input `rcmOrder` expects). Works equally for node indices per element and
 * for equation indices per element. Each returned list is sorted, without duplicates and
 * without the vertex itself.
 */
export function adjacencyFromConnectivity(
  n: number,
  lists: ReadonlyArray<ReadonlyArray<number>>,
): number[][] {
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (const list of lists) {
    for (const v of list) checkIndex(v, n, 'Connectivity index');
    for (const v of list) for (const w of list) if (v !== w) adjacency[v].push(w);
  }
  return adjacency.map((row) => {
    row.sort((p, q) => p - q);
    return row.filter((w, k) => k === 0 || w !== row[k - 1]);
  });
}

/** Options of `SkylineMatrix.factor`. */
export interface FactorOptions {
  /** Relative pivot tolerance (pivot compared with tol·|original diagonal|), default 1e-10. */
  tol?: number;
  /** What to do with a non-positive pivot, default 'stop'. */
  onSingular?: 'stop' | 'restrain';
}

/** Outcome of `SkylineMatrix.factor`. */
export interface FactorResult {
  /** False only when the factorisation stopped at a singular pivot ('stop' mode). */
  ok: boolean;
  /**
   * Equation indices whose pivot was <= tol·|original diagonal| (or not finite), in
   * elimination order: the one that stopped the factorisation, or all restrained equations.
   */
  singular: number[];
}

/**
 * Symmetric matrix in skyline (profile) storage with an in-place LDLᵀ direct solver.
 *
 * Typical use: build the profile with `fromConnectivity`, `add` the element coefficients,
 * `factor()` once and `solve()` for every load case.
 */
export class SkylineMatrix {
  /** Number of equations. */
  readonly n: number;
  /** Number of stored coefficients (profile size). */
  readonly size: number;

  /** first[j] = first stored row of column j. */
  private readonly first: Int32Array;
  /** Entry (i, j), first[j] <= i <= j, is stored at ptr[j] + i. */
  private readonly ptr: Int32Array;
  /** Upper-triangle coefficients; after factor(): U above the diagonal, D on it. */
  private readonly a: Float64Array;
  private state: 'assembling' | 'factored' | 'failed' = 'assembling';
  /** Equations restrained by factor(), in elimination order. */
  private restrained: number[] = [];

  /**
   * `firstRow[j]` = smallest row index i (<= j) that can be non-zero in column j of the
   * upper triangle. All coefficients start at zero.
   */
  constructor(firstRow: ArrayLike<number>) {
    const n = firstRow.length;
    const first = new Int32Array(n);
    const ptr = new Int32Array(n);
    let size = 0;
    for (let j = 0; j < n; j++) {
      const f = firstRow[j];
      if (!Number.isInteger(f) || f < 0 || f > j) {
        throw new RangeError(`firstRow[${j}] = ${f} must be an integer in 0..${j}`);
      }
      first[j] = f;
      ptr[j] = size - f;
      size += j - f + 1;
      if (size > 0x7fffffff) throw new RangeError('Skyline profile is too large to store');
    }
    this.n = n;
    this.size = size;
    this.first = first;
    this.ptr = ptr;
    this.a = new Float64Array(size);
  }

  /**
   * Builds the profile from element connectivity: each list holds equation indices that are
   * all coupled to each other (the equations of one element), so column j must reach up to
   * the lowest equation it shares a list with. `n` is the number of equations.
   */
  static fromConnectivity(n: number, lists: ReadonlyArray<ReadonlyArray<number>>): SkylineMatrix {
    const firstRow = new Int32Array(n);
    for (let j = 0; j < n; j++) firstRow[j] = j;
    for (const list of lists) {
      let lowest = n;
      for (const j of list) {
        checkIndex(j, n, 'Equation index');
        if (j < lowest) lowest = j;
      }
      for (const j of list) if (lowest < firstRow[j]) firstRow[j] = lowest;
    }
    return new SkylineMatrix(firstRow);
  }

  /** First stored row of column j (the `firstRow[j]` the matrix was built with). */
  firstRow(j: number): number {
    checkIndex(j, this.n, 'Equation index');
    return this.first[j];
  }

  /** Independent copy (profile, coefficients and factorisation state). */
  clone(): SkylineMatrix {
    const copy = new SkylineMatrix(this.first);
    copy.a.set(this.a);
    copy.state = this.state;
    copy.restrained = this.restrained.slice();
    return copy;
  }

  /**
   * Adds v to the symmetric entry (i, j) = (j, i); adding to the diagonal adds once.
   * Throws if the entry is outside the profile (even for v = 0) or after factor().
   */
  add(i: number, j: number, v: number): void {
    if (this.state !== 'assembling') throw new Error('SkylineMatrix.add: already factorised');
    checkIndex(i, this.n, 'Equation index');
    checkIndex(j, this.n, 'Equation index');
    const row = i < j ? i : j;
    const col = i < j ? j : i;
    if (row < this.first[col]) {
      throw new RangeError(`SkylineMatrix.add: entry (${i}, ${j}) is outside the profile`);
    }
    this.a[this.ptr[col] + row] += v;
  }

  /**
   * Coefficient (i, j) = (j, i); 0 outside the profile. After factor() the stored values are
   * the factors (u_ij above the diagonal, the pivot d_i on it), not the original matrix.
   */
  get(i: number, j: number): number {
    checkIndex(i, this.n, 'Equation index');
    checkIndex(j, this.n, 'Equation index');
    const row = i < j ? i : j;
    const col = i < j ? j : i;
    return row < this.first[col] ? 0 : this.a[this.ptr[col] + row];
  }

  /** Diagonal coefficient a_ii; after factor() the pivot d_i (1 for a restrained equation). */
  diagonal(i: number): number {
    checkIndex(i, this.n, 'Equation index');
    return this.a[this.ptr[i] + i];
  }

  /** y = A·x using the unfactored coefficients (throws after factor()). */
  multiply(x: ArrayLike<number>): Float64Array {
    if (this.state !== 'assembling') {
      throw new Error('SkylineMatrix.multiply: the coefficients were overwritten by factor()');
    }
    const { n, a, first, ptr } = this;
    if (x.length !== n) throw new RangeError(`SkylineMatrix.multiply: x must have length ${n}`);
    const y = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      // Column j of the upper triangle serves both as column j and as row j of A.
      const pj = ptr[j];
      const xj = x[j];
      let s = a[pj + j] * xj;
      for (let i = first[j]; i < j; i++) {
        const aij = a[pj + i];
        y[i] += aij * xj;
        s += aij * x[i];
      }
      y[j] += s;
    }
    return y;
  }

  /**
   * In-place LDLᵀ factorisation (no pivoting, so meant for symmetric positive definite
   * matrices). A pivot d_j is singular when it is not finite or d_j <= tol·|a_jj|, with a_jj
   * the ORIGINAL diagonal of that equation (so a zero diagonal is always singular).
   *
   *   - onSingular 'stop' (default): returns { ok: false, singular: [j] } at the first
   *     singular pivot; the matrix is left half-reduced and must not be used afterwards.
   *   - onSingular 'restrain': equation j is treated exactly as if that degree of freedom
   *     had been restrained (x_j = 0); the result equals that of the system with row and
   *     column j deleted. Returns { ok: true, singular: [all restrained equations] }.
   */
  factor(options: FactorOptions = {}): FactorResult {
    if (this.state !== 'assembling') throw new Error('SkylineMatrix.factor: already factorised');
    const tol = options.tol ?? 1e-10;
    const restrain = options.onSingular === 'restrain';
    const { n, a, first, ptr } = this;
    const fixed = new Uint8Array(n);
    const singular: number[] = [];

    for (let j = 0; j < n; j++) {
      const fj = first[j];
      const pj = ptr[j];
      const scale = Math.abs(a[pj + j]);

      // g_ij = a_ij − Σ_k u_ki·g_kj over the rows k < i stored by both columns.
      for (let i = fj; i < j; i++) {
        if (fixed[i]) {
          a[pj + i] = 0; // row i was deleted together with its column
          continue;
        }
        const fi = first[i];
        const top = fi > fj ? fi : fj;
        // Dot product of a[p ..] (column i) and a[q ..] (column j), rows top … i−1. This
        // loop is where the factorisation spends its time; four independent partial sums
        // let the CPU overlap the additions (about 30 % faster than the plain loop).
        let p = ptr[i] + top;
        let q = pj + top;
        const end = ptr[i] + i;
        const end4 = p + ((i - top) & ~3);
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        for (; p < end4; p += 4, q += 4) {
          s0 += a[p] * a[q];
          s1 += a[p + 1] * a[q + 1];
          s2 += a[p + 2] * a[q + 2];
          s3 += a[p + 3] * a[q + 3];
        }
        for (; p < end; p++, q++) s0 += a[p] * a[q];
        a[pj + i] -= s0 + s1 + s2 + s3;
      }

      // u_ij = g_ij / d_i and d_j = a_jj − Σ_i u_ij·g_ij.
      let d = a[pj + j];
      for (let i = fj; i < j; i++) {
        const g = a[pj + i];
        const u = g / a[ptr[i] + i];
        a[pj + i] = u;
        d -= u * g;
      }

      if (Number.isFinite(d) && d > tol * scale) {
        a[pj + j] = d;
        continue;
      }
      singular.push(j);
      if (!restrain) {
        this.state = 'failed';
        return { ok: false, singular };
      }
      // Delete column j: no coupling to the equations before it, unit pivot. Row j is
      // deleted entry by entry when the later columns are reduced (see `fixed` above).
      for (let i = fj; i < j; i++) a[pj + i] = 0;
      a[pj + j] = 1;
      fixed[j] = 1;
    }
    this.state = 'factored';
    this.restrained = singular.slice();
    return { ok: true, singular };
  }

  /**
   * Solves A·x = b after a successful factor(); may be called for any number of right-hand
   * sides. Equations restrained by factor() get x_j = 0 whatever b_j is.
   */
  solve(b: ArrayLike<number>): Float64Array {
    if (this.state !== 'factored') {
      throw new Error(
        this.state === 'failed'
          ? 'SkylineMatrix.solve: the factorisation stopped at a singular pivot'
          : 'SkylineMatrix.solve: call factor() first',
      );
    }
    const { n, a, first, ptr } = this;
    if (b.length !== n) throw new RangeError(`SkylineMatrix.solve: b must have length ${n}`);
    const x = Float64Array.from(b);
    for (const j of this.restrained) x[j] = 0;

    // Forward substitution Uᵀ·z = b (dot product down each column).
    for (let j = 1; j < n; j++) {
      const pj = ptr[j];
      let s = 0;
      for (let i = first[j]; i < j; i++) s += a[pj + i] * x[i];
      x[j] -= s;
    }
    // Diagonal scaling D·y = z.
    for (let j = 0; j < n; j++) x[j] /= a[ptr[j] + j];
    // Back substitution U·x = y (column j is removed from the rows above once x_j is known).
    for (let j = n - 1; j > 0; j--) {
      const xj = x[j];
      if (xj === 0) continue;
      const pj = ptr[j];
      for (let i = first[j]; i < j; i++) x[i] -= a[pj + i] * xj;
    }
    return x;
  }
}
