import { describe, expect, it } from 'vitest';
import { cholesky, choleskySolve, matVec, zeros } from '../solver/linalg';
import type { Matrix } from '../solver/linalg';
import { adjacencyFromConnectivity, invertPermutation, rcmOrder, SkylineMatrix } from './sparse';

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle of 0..n−1. */
function shuffled(n: number, random: () => number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

/** Skyline copy of a dense symmetric matrix; the profile is the first non-zero of each column. */
function fromDense(a: Matrix): SkylineMatrix {
  const n = a.length;
  const firstRow = a.map((_, j) => {
    let i = 0;
    while (i < j && a[i][j] === 0) i++;
    return i;
  });
  const m = new SkylineMatrix(firstRow);
  for (let j = 0; j < n; j++) for (let i = firstRow[j]; i <= j; i++) m.add(i, j, a[i][j]);
  return m;
}

function toDense(m: SkylineMatrix): Matrix {
  const a = zeros(m.n, m.n);
  for (let i = 0; i < m.n; i++) for (let j = 0; j < m.n; j++) a[i][j] = m.get(i, j);
  return a;
}

/** Reference solution by the dense Cholesky of the validated 2D solver. */
function denseSolve(a: Matrix, b: number[]): number[] {
  const f = cholesky(a);
  if (!f.ok) throw new Error(`reference matrix is not positive definite at ${f.pivotIndex}`);
  return choleskySolve(f.L, b);
}

/** Dense matrix / vector with the listed equations deleted. */
function without(
  a: Matrix,
  b: number[],
  deleted: number[],
): { a: Matrix; b: number[]; keep: number[] } {
  const keep = a.map((_, i) => i).filter((i) => !deleted.includes(i));
  return { a: keep.map((i) => keep.map((j) => a[i][j])), b: keep.map((i) => b[i]), keep };
}

/** Largest |actual − expected| relative to the largest |expected|. */
function relativeError(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  expect(actual.length).toBe(expected.length);
  let diff = 0;
  let scale = 0;
  for (let i = 0; i < expected.length; i++) {
    diff = Math.max(diff, Math.abs(actual[i] - expected[i]));
    scale = Math.max(scale, Math.abs(expected[i]));
  }
  return scale > 0 ? diff / scale : diff;
}

/**
 * Random symmetric, strictly diagonally dominant (hence positive definite) matrix whose
 * column j reaches up to row firstRow(j); `density` thins out the entries inside the profile
 * so that the factorisation has to create fill-in.
 */
function randomSpd(
  n: number,
  firstRow: (j: number) => number,
  random: () => number,
  density = 1,
): Matrix {
  const a = zeros(n, n);
  for (let j = 0; j < n; j++) {
    const top = firstRow(j);
    for (let i = top; i < j; i++) {
      if (i > top && random() > density) continue;
      const v = 2 * random() - 1 || 0.5;
      a[i][j] = v;
      a[j][i] = v;
    }
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) if (j !== i) sum += Math.abs(a[i][j]);
    a[i][i] = sum + 0.5 + random();
  }
  return a;
}

/** Stiffness of a chain of springs: spring e (stiffness k[e]) joins equations e and e + 1. */
function springChain(k: number[], groundStiffness = 0): Matrix {
  const n = k.length + 1;
  const a = zeros(n, n);
  a[0][0] += groundStiffness;
  k.forEach((ke, e) => {
    a[e][e] += ke;
    a[e + 1][e + 1] += ke;
    a[e][e + 1] -= ke;
    a[e + 1][e] -= ke;
  });
  return a;
}

/** Adjacency lists of an nx × ny (× nz) grid graph, vertices numbered x-fastest. */
function gridGraph(nx: number, ny: number, nz = 1): number[][] {
  const id = (i: number, j: number, k: number): number => i + nx * (j + ny * k);
  const adjacency: number[][] = Array.from({ length: nx * ny * nz }, () => []);
  const link = (v: number, w: number): void => {
    adjacency[v].push(w);
    adjacency[w].push(v);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i + 1 < nx) link(id(i, j, k), id(i + 1, j, k));
        if (j + 1 < ny) link(id(i, j, k), id(i, j + 1, k));
        if (k + 1 < nz) link(id(i, j, k), id(i, j, k + 1));
      }
    }
  }
  return adjacency;
}

/** The same graph with vertex v renamed to label[v]. */
function relabel(adjacency: number[][], label: number[]): number[][] {
  const out: number[][] = adjacency.map(() => []);
  adjacency.forEach((row, v) => {
    out[label[v]] = row.map((w) => label[w]);
  });
  return out;
}

/** Skyline whose profile holds every edge of the graph after numbering vertex v as position[v]. */
function profileOf(adjacency: number[][], position: number[]): SkylineMatrix {
  const lists: number[][] = [];
  adjacency.forEach((row, v) => row.forEach((w) => lists.push([position[v], position[w]])));
  return SkylineMatrix.fromConnectivity(adjacency.length, lists);
}

/** Largest |i − j| over the edges of the graph after numbering vertex v as position[v]. */
function bandwidth(adjacency: number[][], position: number[]): number {
  let band = 0;
  adjacency.forEach((row, v) =>
    row.forEach((w) => {
      band = Math.max(band, Math.abs(position[v] - position[w]));
    }),
  );
  return band;
}

/**
 * Discrete Laplacian with zero values outside the grid (the 3-, 5- or 7-point stencil:
 * 2·dim on the diagonal, −1 towards every neighbour), numbered by `position`.
 */
function gridLaplacian(adjacency: number[][], position: number[], dim: number): SkylineMatrix {
  const m = profileOf(adjacency, position);
  adjacency.forEach((row, v) => {
    m.add(position[v], position[v], 2 * dim);
    for (const w of row) if (w > v) m.add(position[v], position[w], -1);
  });
  return m;
}

describe('SkylineMatrix storage', () => {
  it('sizes the profile from firstRow', () => {
    const m = new SkylineMatrix([0, 0, 1, 0, 4]);
    expect(m.n).toBe(5);
    expect(m.size).toBe(1 + 2 + 2 + 4 + 1);
    expect([0, 1, 2, 3, 4].map((j) => m.firstRow(j))).toEqual([0, 0, 1, 0, 4]);
    expect(
      toDense(m)
        .flat()
        .every((v) => v === 0),
    ).toBe(true);
  });

  it('accepts an empty system', () => {
    const m = new SkylineMatrix([]);
    expect(m.n).toBe(0);
    expect(m.size).toBe(0);
    expect(m.factor()).toEqual({ ok: true, singular: [] });
    expect(Array.from(m.solve([]))).toEqual([]);
  });

  it('rejects an invalid firstRow', () => {
    expect(() => new SkylineMatrix([0, 2])).toThrow(RangeError);
    expect(() => new SkylineMatrix([0, -1])).toThrow(RangeError);
    expect(() => new SkylineMatrix([0, 0.5])).toThrow(RangeError);
    expect(() => new SkylineMatrix([Number.NaN])).toThrow(RangeError);
    // A full triangle of 65536 equations has more than 2^31 − 1 coefficients (16 GB).
    expect(() => new SkylineMatrix(new Int32Array(65536))).toThrow(/too large/);
  });

  it('builds the profile from element connectivity', () => {
    // Column j reaches up to the lowest equation it shares a list with.
    const m = SkylineMatrix.fromConnectivity(7, [[1, 0, 2], [5, 2], [3, 4], [4], []]);
    expect([0, 1, 2, 3, 4, 5, 6].map((j) => m.firstRow(j))).toEqual([0, 0, 0, 3, 3, 2, 6]);
    expect(m.size).toBe(1 + 2 + 3 + 1 + 2 + 4 + 1);
    // Overlapping lists: the lowest one wins.
    const overlap = SkylineMatrix.fromConnectivity(4, [
      [2, 3],
      [3, 1],
      [0, 2],
    ]);
    expect([0, 1, 2, 3].map((j) => overlap.firstRow(j))).toEqual([0, 1, 0, 1]);
    expect(() => SkylineMatrix.fromConnectivity(3, [[0, 3]])).toThrow(RangeError);
    expect(() => SkylineMatrix.fromConnectivity(3, [[-1, 0]])).toThrow(RangeError);
    expect(() => m.firstRow(7)).toThrow(RangeError);
  });

  it('adds symmetric entries, the diagonal once, and accumulates', () => {
    const m = new SkylineMatrix([0, 0, 1]);
    m.add(0, 1, 2);
    m.add(1, 0, 3); // same entry as (0, 1)
    m.add(1, 1, 7);
    m.add(1, 1, 1);
    m.add(2, 1, -4);
    expect(m.get(0, 1)).toBe(5);
    expect(m.get(1, 0)).toBe(5);
    expect(m.get(1, 1)).toBe(8);
    expect(m.diagonal(1)).toBe(8);
    expect(m.get(1, 2)).toBe(-4);
    expect(m.get(2, 1)).toBe(-4);
    expect(m.diagonal(0)).toBe(0);
  });

  it('returns 0 outside the profile and refuses to add there', () => {
    const m = new SkylineMatrix([0, 0, 1, 3]);
    expect(m.get(0, 2)).toBe(0);
    expect(m.get(2, 0)).toBe(0);
    expect(m.get(3, 1)).toBe(0);
    expect(() => m.add(0, 2, 1)).toThrow(/outside the profile/);
    expect(() => m.add(2, 0, 1)).toThrow(RangeError);
    expect(() => m.add(3, 2, 0)).toThrow(RangeError);
    // Indices that are not equations at all.
    expect(() => m.add(0, 4, 1)).toThrow(RangeError);
    expect(() => m.add(-1, 0, 1)).toThrow(RangeError);
    expect(() => m.add(0.5, 1, 1)).toThrow(RangeError);
    expect(() => m.get(4, 0)).toThrow(RangeError);
    expect(() => m.diagonal(4)).toThrow(RangeError);
  });

  it('multiplies like the dense matrix', () => {
    const random = rng(11);
    const n = 40;
    const a = randomSpd(n, (j) => Math.max(0, j - 1 - Math.floor(random() * 9)), random, 0.6);
    const m = fromDense(a);
    expect(toDense(m)).toEqual(a);
    const x = Array.from({ length: n }, () => 2 * random() - 1);
    expect(relativeError(m.multiply(x), matVec(a, x))).toBeLessThan(1e-14);
    expect(() => m.multiply([1, 2, 3])).toThrow(RangeError);
  });

  it('clones independently', () => {
    const m = fromDense([
      [4, 1],
      [1, 3],
    ]);
    const copy = m.clone();
    copy.add(0, 0, 10);
    expect(m.get(0, 0)).toBe(4);
    expect(copy.get(0, 0)).toBe(14);
    expect(copy.get(0, 1)).toBe(1);
    // A clone of a factorised matrix solves without factorising again.
    m.factor({ onSingular: 'restrain' });
    const factored = m.clone();
    expect(Array.from(factored.solve([5, 4]))).toEqual(Array.from(m.solve([5, 4])));
    expect(() => factored.factor()).toThrow();
  });
});

describe('SkylineMatrix.factor / solve on positive definite systems', () => {
  it('solves a hand-checked 3 × 3 system and exposes the pivots', () => {
    // A = Uᵀ·D·U with U = [[1, 2, 0], [0, 1, 3], [0, 0, 1]] and D = diag(2, 3, 4).
    const m = fromDense([
      [2, 4, 0],
      [4, 11, 9],
      [0, 9, 31],
    ]);
    expect(m.factor()).toEqual({ ok: true, singular: [] });
    expect([0, 1, 2].map((i) => m.diagonal(i))).toEqual([2, 3, 4]);
    expect(m.get(0, 1)).toBe(2);
    expect(m.get(1, 2)).toBe(3);
    // A·[1, −2, 3] = [−6, 9, 75].
    const x = m.solve([-6, 9, 75]);
    expect(relativeError(x, [1, -2, 3])).toBeLessThan(1e-14);
  });

  it('matches the dense Cholesky reference on random banded systems', () => {
    const random = rng(1);
    for (const [n, halfBand] of [
      [1, 0],
      [2, 1],
      [25, 3],
      [60, 12],
      [80, 79], // full matrix
    ]) {
      const a = randomSpd(n, (j) => Math.max(0, j - halfBand), random);
      const b = Array.from({ length: n }, () => 10 * random() - 5);
      const m = fromDense(a);
      expect(m.factor()).toEqual({ ok: true, singular: [] });
      expect(relativeError(m.solve(b), denseSolve(a, b))).toBeLessThan(1e-12);
    }
  });

  it('matches the dense reference on random variable-profile systems with fill-in', () => {
    const random = rng(2);
    for (let trial = 0; trial < 6; trial++) {
      const n = 30 + 15 * trial;
      // Ragged skyline: some columns reach far up, most entries inside it start at zero.
      const a = randomSpd(
        n,
        (j) => (random() < 0.15 ? Math.floor(random() * j) : Math.max(0, j - 1 - (j % 4))),
        random,
        0.3,
      );
      const m = fromDense(a);
      const b1 = Array.from({ length: n }, () => 2 * random() - 1);
      const b2 = Array.from({ length: n }, (_, i) => (i === trial ? 1 : 0));
      expect(m.factor().ok).toBe(true);
      // One factorisation serves any number of right-hand sides.
      expect(relativeError(m.solve(b1), denseSolve(a, b1))).toBeLessThan(1e-12);
      expect(relativeError(m.solve(b2), denseSolve(a, b2))).toBeLessThan(1e-12);
    }
  });

  it('gives the closed-form extension of a grounded spring chain', () => {
    // n springs in series from a fixed point, load P at the free end: u_i = P·Σ_{e<=i} 1/k_e.
    const k = [1000, 2500, 400, 800, 1600, 3200];
    const P = 12;
    const a = springChain(k.slice(1), k[0]);
    const m = fromDense(a);
    expect(m.factor().ok).toBe(true);
    const b = k.map((_, i) => (i === k.length - 1 ? P : 0));
    const u = m.solve(b);
    let expected = 0;
    k.forEach((ke, i) => {
      expected += P / ke;
      expect(u[i]).toBeCloseTo(expected, 13);
    });
  });

  it('solves the 1D Laplacian (closed form)', () => {
    // tridiag(−1, 2, −1)·x = 1 has x_i = i·(n + 1 − i)/2 for i = 1 … n.
    const n = 200;
    const path = gridGraph(n, 1);
    const identity = path.map((_, v) => v);
    const m = gridLaplacian(path, identity, 1);
    expect(m.size).toBe(2 * n - 1);
    expect(m.factor().ok).toBe(true);
    const x = m.solve(new Array<number>(n).fill(1));
    const exact = Array.from({ length: n }, (_, i) => ((i + 1) * (n - i)) / 2);
    expect(relativeError(x, exact)).toBeLessThan(1e-12);
  });

  it('solves the 2D Laplacian (residual and eigenvector solution)', () => {
    const nx = 24;
    const ny = 17;
    const grid = gridGraph(nx, ny);
    const identity = grid.map((_, v) => v);
    const m = gridLaplacian(grid, identity, 2);
    const original = m.clone();
    expect(m.factor().ok).toBe(true);

    const random = rng(3);
    const b = Float64Array.from(grid, () => 2 * random() - 1);
    const x = m.solve(b);
    expect(relativeError(original.multiply(x), b)).toBeLessThan(1e-12);

    // sin(p·π·i/(nx+1))·sin(q·π·j/(ny+1)) is an eigenvector with
    // λ = 4 − 2·cos(p·π/(nx+1)) − 2·cos(q·π/(ny+1)), so A·x = v has x = v/λ.
    const [p, q] = [2, 3];
    const v = Float64Array.from(grid, (_, id) => {
      const i = (id % nx) + 1;
      const j = Math.floor(id / nx) + 1;
      return Math.sin((p * Math.PI * i) / (nx + 1)) * Math.sin((q * Math.PI * j) / (ny + 1));
    });
    const lambda =
      4 - 2 * Math.cos((p * Math.PI) / (nx + 1)) - 2 * Math.cos((q * Math.PI) / (ny + 1));
    expect(
      relativeError(
        m.solve(v),
        v.map((value) => value / lambda),
      ),
    ).toBeLessThan(1e-12);
  });

  it('solves the 3D Laplacian (residual and eigenvector solution)', () => {
    const [nx, ny, nz] = [9, 7, 8];
    const grid = gridGraph(nx, ny, nz);
    const identity = grid.map((_, v) => v);
    const m = gridLaplacian(grid, identity, 3);
    const original = m.clone();
    expect(m.factor().ok).toBe(true);

    const random = rng(4);
    const b = Float64Array.from(grid, () => 2 * random() - 1);
    expect(relativeError(original.multiply(m.solve(b)), b)).toBeLessThan(1e-12);

    const v = Float64Array.from(grid, (_, id) => {
      const i = (id % nx) + 1;
      const j = (Math.floor(id / nx) % ny) + 1;
      const k = Math.floor(id / (nx * ny)) + 1;
      return (
        Math.sin((Math.PI * i) / (nx + 1)) *
        Math.sin((2 * Math.PI * j) / (ny + 1)) *
        Math.sin((3 * Math.PI * k) / (nz + 1))
      );
    });
    const lambda =
      6 -
      2 * Math.cos(Math.PI / (nx + 1)) -
      2 * Math.cos((2 * Math.PI) / (ny + 1)) -
      2 * Math.cos((3 * Math.PI) / (nz + 1));
    expect(
      relativeError(
        m.solve(v),
        v.map((value) => value / lambda),
      ),
    ).toBeLessThan(1e-12);
  });

  it('gives the same solution for any numbering of the equations', () => {
    const grid = gridGraph(12, 9);
    const n = grid.length;
    const random = rng(5);
    const b = Array.from({ length: n }, () => 2 * random() - 1);
    const natural = gridLaplacian(
      grid,
      grid.map((_, v) => v),
      2,
    );
    natural.factor();
    const reference = natural.solve(b);

    const position = invertPermutation(rcmOrder(relabel(grid, shuffled(n, random))));
    // `position` numbers the relabelled graph; apply it to a fresh random numbering instead
    // so that the permuted system is unrelated to the natural one.
    const scrambled = shuffled(n, random);
    for (const numbering of [position, scrambled]) {
      const m = gridLaplacian(grid, numbering, 2);
      expect(m.factor().ok).toBe(true);
      const permutedB = new Array<number>(n).fill(0);
      numbering.forEach((eq, v) => {
        permutedB[eq] = b[v];
      });
      const x = m.solve(permutedB);
      expect(
        relativeError(
          numbering.map((eq) => x[eq]),
          reference,
        ),
      ).toBeLessThan(1e-12);
    }
  });

  it('guards the call order', () => {
    const build = (): SkylineMatrix =>
      fromDense([
        [2, 1],
        [1, 2],
      ]);
    const fresh = build();
    expect(() => fresh.solve([1, 1])).toThrow(/factor\(\) first/);

    const m = build();
    m.factor();
    expect(() => m.factor()).toThrow(/already factorised/);
    expect(() => m.add(0, 0, 1)).toThrow(/already factorised/);
    expect(() => m.multiply([1, 1])).toThrow(/overwritten/);
    expect(() => m.solve([1])).toThrow(RangeError);
    expect(relativeError(m.solve([3, 3]), [1, 1])).toBeLessThan(1e-15);
  });
});

describe('SkylineMatrix.factor with singular pivots', () => {
  it("stops at the rigid-body mode of an unsupported spring chain ('stop')", () => {
    // Free-free chain: every equation can be eliminated except the last, whose pivot is
    // k − k = 0 (the chain can still translate as a whole).
    const m = fromDense(springChain([1000, 1000, 1000, 1000]));
    expect(m.factor()).toEqual({ ok: false, singular: [4] });
    expect(() => m.solve([0, 0, 0, 0, 0])).toThrow(/singular pivot/);
    expect(() => m.multiply([0, 0, 0, 0, 0])).toThrow();
    expect(() => m.factor()).toThrow();

    // Same with unequal stiffnesses, where the last pivot is rounding noise instead of 0.
    const uneven = fromDense(springChain([1234.5, 0.37, 9876.1, 55.5, 3.3e5, 71]));
    expect(uneven.factor({ onSingular: 'stop' })).toEqual({ ok: false, singular: [6] });
  });

  it('reports the first singular equation only', () => {
    // Two separate free-free chains: 0–1 and 2–3. Elimination stops at equation 1.
    const a = zeros(4, 4);
    for (const [i, j] of [
      [0, 1],
      [2, 3],
    ]) {
      a[i][i] += 5;
      a[j][j] += 5;
      a[i][j] -= 5;
      a[j][i] -= 5;
    }
    expect(fromDense(a).factor()).toEqual({ ok: false, singular: [1] });
  });

  it("'restrain' fixes the rigid-body mode of a free chain (closed form)", () => {
    // Load P at node 0 of a free-free chain. With the last node held, u_i = P·(n−1−i)/k.
    const n = 8;
    const k = 2000;
    const P = 5;
    const a = springChain(new Array<number>(n - 1).fill(k));
    const m = fromDense(a);
    expect(m.factor({ onSingular: 'restrain' })).toEqual({ ok: true, singular: [n - 1] });
    expect(m.diagonal(n - 1)).toBe(1);
    const b = new Array<number>(n).fill(0);
    b[0] = P;
    b[n - 1] = 123; // a load on the restrained equation goes straight to the "support"
    const u = m.solve(b);
    expect(u[n - 1]).toBe(0);
    for (let i = 0; i < n; i++) expect(u[i]).toBeCloseTo((P * (n - 1 - i)) / k, 14);

    // And it is the solution of the reduced system.
    const reduced = without(a, b, [n - 1]);
    expect(
      relativeError(Array.from(u).slice(0, n - 1), denseSolve(reduced.a, reduced.b)),
    ).toBeLessThan(1e-13);
  });

  it("'restrain' deletes a singular equation that later equations are coupled to", () => {
    // K = Σ k_e·v_e·v_eᵀ where every v_e has equal components 2 and 3: the matrix cannot
    // tell x_2 from x_3, so pivot 3 vanishes (to rounding) although equations 4 … 9 are
    // still coupled to it. Deleting row/column 3 leaves a positive definite system.
    const random = rng(6);
    const n = 10;
    const a = zeros(n, n);
    for (let e = 0; e < 40; e++) {
      const v = Array.from({ length: n }, () => 2 * random() - 1);
      v[3] = v[2];
      const ke = 1 + 9 * random();
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) a[i][j] += ke * v[i] * v[j];
    }
    const b = Array.from({ length: n }, () => 2 * random() - 1);
    const m = fromDense(a);
    expect(m.factor({ onSingular: 'restrain' })).toEqual({ ok: true, singular: [3] });
    const x = m.solve(b);
    expect(x[3]).toBe(0);

    const reduced = without(a, b, [3]);
    const dense = denseSolve(reduced.a, reduced.b);
    expect(
      relativeError(
        reduced.keep.map((i) => x[i]),
        dense,
      ),
    ).toBeLessThan(1e-11);
    // … and of the skyline solver applied to the explicitly reduced matrix.
    const small = fromDense(reduced.a);
    expect(small.factor()).toEqual({ ok: true, singular: [] });
    expect(
      relativeError(
        reduced.keep.map((i) => x[i]),
        small.solve(reduced.b),
      ),
    ).toBeLessThan(1e-11);
  });

  it("'restrain' handles several zero modes and a completely empty equation", () => {
    // Three free-free chains with interleaved equation numbers and equation 5 untouched by
    // any element (zero row and column, zero diagonal):
    //   chain A: 0 – 3 – 6 – 9,  chain B: 1 – 4 – 7 – 10,  chain C: 2 – 8 – 11.
    const n = 12;
    const chains: Array<{ eqs: number[]; k: number }> = [
      { eqs: [0, 3, 6, 9], k: 1500 },
      { eqs: [1, 4, 7, 10], k: 320 },
      { eqs: [2, 8, 11], k: 78000 },
    ];
    const a = zeros(n, n);
    for (const { eqs, k } of chains) {
      for (let e = 0; e + 1 < eqs.length; e++) {
        const [i, j] = [eqs[e], eqs[e + 1]];
        a[i][i] += k;
        a[j][j] += k;
        a[i][j] -= k;
        a[j][i] -= k;
      }
    }
    const random = rng(7);
    const b = Array.from({ length: n }, () => 2 * random() - 1);

    const stop = fromDense(a);
    expect(stop.factor()).toEqual({ ok: false, singular: [5] });

    const m = fromDense(a);
    // The empty equation first, then the last equation of each chain, in elimination order.
    expect(m.factor({ onSingular: 'restrain' })).toEqual({ ok: true, singular: [5, 9, 10, 11] });
    const x = m.solve(b);
    for (const j of [5, 9, 10, 11]) expect(x[j]).toBe(0);

    const reduced = without(a, b, [5, 9, 10, 11]);
    expect(
      relativeError(
        reduced.keep.map((i) => x[i]),
        denseSolve(reduced.a, reduced.b),
      ),
    ).toBeLessThan(1e-13);

    // Closed form for each chain held at its last node: the spring between positions e and
    // e + 1 carries the sum of the loads on positions 0 … e.
    for (const { eqs, k } of chains) {
      let u = 0;
      for (let e = eqs.length - 2; e >= 0; e--) {
        let force = 0;
        for (let p = 0; p <= e; p++) force += b[eqs[p]];
        u += force / k;
        expect(x[eqs[e]]).toBeCloseTo(u, 13);
      }
    }
  });

  it("'restrain' matches the reduced system for random unsupported spring networks", () => {
    const random = rng(8);
    for (let trial = 0; trial < 5; trial++) {
      // Several disconnected networks with shuffled equation numbers; each one is a ring
      // plus random chords with random stiffnesses, and nothing is supported.
      const sizes = [7, 1, 12, 5 + trial];
      const n = sizes.reduce((s, v) => s + v, 0);
      const label = shuffled(n, random);
      const a = zeros(n, n);
      const components: number[][] = [];
      let offset = 0;
      for (const size of sizes) {
        const eqs = Array.from({ length: size }, (_, i) => label[offset + i]);
        components.push(eqs);
        offset += size;
        const spring = (i: number, j: number): void => {
          const k = 10 ** (4 * random());
          a[i][i] += k;
          a[j][j] += k;
          a[i][j] -= k;
          a[j][i] -= k;
        };
        for (let i = 0; i + 1 < size; i++) spring(eqs[i], eqs[i + 1]);
        for (let c = 0; c < size; c++) {
          const i = eqs[Math.floor(random() * size)];
          const j = eqs[Math.floor(random() * size)];
          if (i !== j) spring(i, j);
        }
      }
      const b = Array.from({ length: n }, () => 2 * random() - 1);
      const m = fromDense(a);
      const result = m.factor({ onSingular: 'restrain' });
      // Exactly one rigid-body mode per network, found at its highest-numbered equation.
      const expected = components.map((eqs) => Math.max(...eqs)).sort((p, q) => p - q);
      expect(result).toEqual({ ok: true, singular: expected });

      const x = m.solve(b);
      for (const j of expected) expect(x[j]).toBe(0);
      const reduced = without(a, b, expected);
      expect(
        relativeError(
          reduced.keep.map((i) => x[i]),
          denseSolve(reduced.a, reduced.b),
        ),
      ).toBeLessThan(1e-9);
    }
  });

  it("'restrain' drops the coupling of a zero-diagonal equation", () => {
    // Equation 0 has no stiffness of its own but is coupled to equation 1; equation 3 too.
    const a = [
      [0, 1, 0, 0],
      [1, 4, 1, 2],
      [0, 1, 3, 1],
      [0, 2, 1, 0],
    ];
    const b = [9, 2, -1, 7];
    const m = fromDense(a);
    expect(m.factor({ onSingular: 'restrain' })).toEqual({ ok: true, singular: [0, 3] });
    const x = m.solve(b);
    // Remaining system [[4, 1], [1, 3]]·[x1, x2] = [2, −1]  →  x1 = 7/11, x2 = −6/11.
    expect(x[0]).toBe(0);
    expect(x[3]).toBe(0);
    expect(x[1]).toBeCloseTo(7 / 11, 14);
    expect(x[2]).toBeCloseTo(-6 / 11, 14);
  });

  it('restrains every equation of a zero matrix', () => {
    const m = new SkylineMatrix([0, 0, 0]);
    expect(m.factor({ onSingular: 'restrain' })).toEqual({ ok: true, singular: [0, 1, 2] });
    expect(Array.from(m.solve([1, 2, 3]))).toEqual([0, 0, 0]);
  });

  it('reports a negative pivot of an indefinite matrix', () => {
    // Pivot 1 = 1 − 2·2/1 = −3.
    const indefinite = [
      [1, 2],
      [2, 1],
    ];
    expect(fromDense(indefinite).factor()).toEqual({ ok: false, singular: [1] });
    // A negative diagonal is caught at once.
    expect(
      fromDense([
        [-2, 0],
        [0, 1],
      ]).factor(),
    ).toEqual({ ok: false, singular: [0] });

    const m = fromDense(indefinite);
    expect(m.factor({ onSingular: 'restrain' })).toEqual({ ok: true, singular: [1] });
    expect(Array.from(m.solve([3, 5]))).toEqual([3, 0]);
  });

  it('reports non-finite coefficients', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const diagonal = new SkylineMatrix([0, 0, 1]);
      diagonal.add(0, 0, 2);
      diagonal.add(1, 1, bad);
      diagonal.add(2, 2, 2);
      expect(diagonal.factor()).toEqual({ ok: false, singular: [1] });

      const coupling = new SkylineMatrix([0, 0, 1]);
      coupling.add(0, 0, 2);
      coupling.add(0, 1, bad);
      coupling.add(1, 1, 2);
      coupling.add(2, 2, 4);
      expect(coupling.factor({ onSingular: 'restrain' })).toEqual({ ok: true, singular: [1] });
      expect(Array.from(coupling.solve([2, 2, 2]))).toEqual([1, 0, 0.5]);
    }
  });

  it('scales the pivot test with the original diagonal', () => {
    // Pivot 1 = (1e12 + 1) − 1e12 = 1: positive and large in absolute terms, but only
    // 1e-12 of the original diagonal, i.e. cancellation noise.
    const cancelling = (): SkylineMatrix =>
      fromDense([
        [1e12, 1e12],
        [1e12, 1e12 + 1],
      ]);
    expect(cancelling().factor()).toEqual({ ok: false, singular: [1] });
    expect(cancelling().factor({ tol: 1e-13 })).toEqual({ ok: true, singular: [] });

    // Tiny but well-conditioned coefficients are not singular.
    const tiny = fromDense([
      [2e-15, 1e-15],
      [1e-15, 2e-15],
    ]);
    expect(tiny.factor()).toEqual({ ok: true, singular: [] });
    expect(relativeError(tiny.solve([3e-15, 3e-15]), [1, 1])).toBeLessThan(1e-14);

    // The tolerance is adjustable: pivot 1 = 1 − (1 − 1e-8)² ≈ 2e-8.
    const nearly = (): SkylineMatrix =>
      fromDense([
        [1, 1 - 1e-8],
        [1 - 1e-8, 1],
      ]);
    expect(nearly().factor().ok).toBe(true);
    expect(nearly().factor({ tol: 1e-6 })).toEqual({ ok: false, singular: [1] });
  });
});

describe('rcmOrder', () => {
  const isPermutation = (order: number[], n: number): boolean =>
    order.length === n && new Set(order).size === n && order.every((v) => v >= 0 && v < n);

  it('handles trivial graphs', () => {
    expect(rcmOrder([])).toEqual([]);
    expect(rcmOrder([[]])).toEqual([0]);
    expect(rcmOrder([[1], [0]]).sort()).toEqual([0, 1]);
  });

  it('returns a permutation for random graphs', () => {
    const random = rng(21);
    for (let trial = 0; trial < 20; trial++) {
      const n = 1 + Math.floor(random() * 60);
      const adjacency: number[][] = Array.from({ length: n }, () => []);
      const edges = Math.floor(random() * 2 * n);
      for (let e = 0; e < edges; e++) {
        const v = Math.floor(random() * n);
        const w = Math.floor(random() * n);
        adjacency[v].push(w);
        adjacency[w].push(v);
      }
      const order = rcmOrder(adjacency);
      expect(isPermutation(order, n)).toBe(true);
      expect(isPermutation(invertPermutation(order), n)).toBe(true);
    }
  });

  it('numbers a path from one end to the other, whatever its labels', () => {
    // A path has two peripheral vertices; starting anywhere else would at least double the
    // bandwidth, so this checks the pseudo-peripheral start.
    const random = rng(22);
    const n = 57;
    const label = shuffled(n, random);
    const path = relabel(gridGraph(n, 1), label);
    const order = rcmOrder(path);
    const along = order.map((v) => label.indexOf(v)); // position along the path
    const ascending = along.every((p, k) => p === k);
    const descending = along.every((p, k) => p === n - 1 - k);
    expect(ascending || descending).toBe(true);
    expect(bandwidth(path, invertPermutation(order))).toBe(1);
  });

  it('orders by increasing degree within a level and reverses the result', () => {
    // Vertex 0 is joined to 1, 2 and 3; vertex 2 carries two extra leaves (4, 5) and vertex
    // 3 one (6). Degrees: 3, 1, 3, 2, 1, 1, 1.
    //   Start: vertex 1 (minimum degree, lowest index); levels 1 | 0 | 2 3 | 4 5 6, depth 4.
    //   Farthest level → candidate 4; levels 4 | 2 | 0 5 | 1 3 | 6, depth 5: deeper, so
    //   move there. Its farthest level → candidate 6, depth 5 again: 4 is the root.
    //   Cuthill–McKee from 4: 4 | 2 | 5 (degree 1), 0 (degree 3) | 1 (degree 1), 3 (degree
    //   2) | 6, then reversed.
    const adjacency = [[1, 2, 3], [0], [0, 4, 5], [0, 6], [2], [2], [3]];
    expect(rcmOrder(adjacency)).toEqual([6, 3, 1, 0, 5, 2, 4]);
  });

  it('handles disconnected graphs and isolated vertices', () => {
    // Components {0, 4, 7} (path 4–0–7), {1, 5} and {3, 6, 8, 9} (star around 6); vertex 2 is isolated.
    const adjacency = [[4, 7], [5], [], [6], [0], [1], [3, 8, 9], [0], [6], [6]];
    const order = rcmOrder(adjacency);
    expect(isPermutation(order, 10)).toBe(true);
    // Every component occupies a contiguous block of the ordering.
    const position = invertPermutation(order);
    for (const component of [[0, 4, 7], [1, 5], [2], [3, 6, 8, 9]]) {
      const places = component.map((v) => position[v]).sort((p, q) => p - q);
      expect(places[places.length - 1] - places[0]).toBe(component.length - 1);
    }
    // The path is numbered end to end.
    expect(Math.abs(position[4] - position[7])).toBe(2);
    expect(bandwidth(adjacency, position)).toBeLessThanOrEqual(3);
    // Only isolated vertices.
    expect(rcmOrder([[], [], []]).sort()).toEqual([0, 1, 2]);
  });

  it('is deterministic and ignores how the adjacency lists are written', () => {
    const random = rng(23);
    const n = 15 * 11;
    const grid = relabel(gridGraph(15, 11), shuffled(n, random));
    const order = rcmOrder(grid);
    expect(rcmOrder(grid)).toEqual(order);
    expect(rcmOrder(grid.map((row) => row.slice()))).toEqual(order);
    // Reversed lists, duplicated neighbours and self-loops describe the same graph.
    const messy = grid.map((row, v) => [...row.slice().reverse(), v, ...row]);
    expect(rcmOrder(messy)).toEqual(order);
    // So do edges that are listed on one side only.
    const oneSided = grid.map((row, v) => row.filter((w) => w > v));
    expect(rcmOrder(oneSided)).toEqual(order);
  });

  it('rejects neighbours that are not vertices', () => {
    expect(() => rcmOrder([[1], [2]])).toThrow(RangeError);
    expect(() => rcmOrder([[-1]])).toThrow(RangeError);
    expect(() => rcmOrder([[0.5], []])).toThrow(RangeError);
  });

  it('reduces the profile of a shuffled 2D grid by a large factor', () => {
    const random = rng(24);
    const [nx, ny] = [40, 25];
    const n = nx * ny;
    const natural = gridGraph(nx, ny);
    const grid = relabel(natural, shuffled(n, random));
    const identity = grid.map((_, v) => v);

    const shuffledProfile = profileOf(grid, identity).size;
    const position = invertPermutation(rcmOrder(grid));
    const rcmProfile = profileOf(grid, position).size;
    // Numbering along the short side is what an engineer would do by hand: half-bandwidth ny.
    const byHand = profileOf(
      natural,
      natural.map((_, v) => {
        const i = v % nx;
        const j = Math.floor(v / nx);
        return j + ny * i;
      }),
    ).size;

    expect(shuffledProfile).toBeGreaterThan(0.25 * n * n); // nearly full triangle
    expect(shuffledProfile / rcmProfile).toBeGreaterThan(10);
    expect(rcmProfile).toBeLessThanOrEqual(byHand);
    // Levels of a breadth-first numbering from a corner are diagonals of at most ny vertices.
    expect(bandwidth(grid, position)).toBeLessThan(2 * ny);
  });

  it('keeps a slender 3D grid as narrow as its cross-section', () => {
    const random = rng(25);
    const [nx, ny, nz] = [30, 4, 3];
    const n = nx * ny * nz;
    const natural = gridGraph(nx, ny, nz);
    const grid = relabel(natural, shuffled(n, random));
    const position = invertPermutation(rcmOrder(grid));
    // Numbering cross-section by cross-section along the bar: half-bandwidth ny·nz.
    const sections = natural.map((_, v) => Math.floor(v / nx) + ny * nz * (v % nx));
    expect(bandwidth(natural, sections)).toBe(ny * nz);
    const byHand = profileOf(natural, sections).size;
    // Breadth-first levels from a corner are the planes i + j + k = const, which hold at most
    // ny·nz vertices, so consecutive levels span less than twice the cross-section. They cut
    // the bar obliquely, which costs a little against the by-hand numbering; a start in the
    // middle of the bar would double the level width and with it the profile.
    expect(bandwidth(grid, position)).toBeLessThan(2 * ny * nz);
    expect(profileOf(grid, position).size).toBeLessThan(1.25 * byHand);
  });
});

describe('invertPermutation', () => {
  it('maps a vertex to its place in the order', () => {
    expect(invertPermutation([2, 0, 3, 1])).toEqual([1, 3, 0, 2]);
    expect(invertPermutation([])).toEqual([]);
    expect(invertPermutation(Int32Array.from([1, 0]))).toEqual([1, 0]);
  });

  it('rejects anything that is not a permutation', () => {
    expect(() => invertPermutation([0, 0])).toThrow(/twice/);
    expect(() => invertPermutation([0, 2])).toThrow(RangeError);
    expect(() => invertPermutation([0.5, 1])).toThrow(RangeError);
  });
});

describe('adjacencyFromConnectivity', () => {
  it('makes all members of a list mutually adjacent', () => {
    // Two triangles sharing the edge 1–2, a repeated list and an unused vertex 4.
    const adjacency = adjacencyFromConnectivity(5, [[0, 1, 2], [2, 1, 3], [0, 1, 2], [3]]);
    expect(adjacency).toEqual([[1, 2], [0, 2, 3], [0, 1, 3], [1, 2], []]);
    expect(() => adjacencyFromConnectivity(3, [[0, 3]])).toThrow(RangeError);
  });

  it('feeds rcmOrder and fromConnectivity consistently', () => {
    // 2D mesh of 4-node elements (8 × 6 cells), node numbers shuffled.
    const random = rng(31);
    const [cx, cy] = [8, 6];
    const n = (cx + 1) * (cy + 1);
    const label = shuffled(n, random);
    const elements: number[][] = [];
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const a = i + (cx + 1) * j;
        elements.push([a, a + 1, a + cx + 2, a + cx + 1].map((v) => label[v]));
      }
    }
    const position = invertPermutation(rcmOrder(adjacencyFromConnectivity(n, elements)));
    const renumbered = elements.map((nodes) => nodes.map((v) => position[v]));
    const m = SkylineMatrix.fromConnectivity(n, renumbered);
    const before = SkylineMatrix.fromConnectivity(n, elements);
    // Reference: nodes numbered by hand along the short side of the mesh.
    const byHand = SkylineMatrix.fromConnectivity(
      n,
      elements.map((nodes) =>
        nodes.map((v) => {
          const original = label.indexOf(v);
          const i = original % (cx + 1);
          const j = Math.floor(original / (cx + 1));
          return j + (cy + 1) * i;
        }),
      ),
    );
    // Elements couple diagonal neighbours too, so the breadth-first levels from a corner
    // are L-shaped and somewhat wider than the straight lines of the by-hand numbering:
    // Cuthill–McKee is a heuristic and lands within a few percent of that optimum.
    expect(m.size).toBeLessThan(1.1 * byHand.size);
    expect(m.size).toBeLessThan(before.size / 2);
    // Every element entry fits in the profile.
    for (const nodes of renumbered) {
      for (const p of nodes) for (const q of nodes) expect(() => m.add(p, q, 1)).not.toThrow();
    }
  });
});

describe('performance', () => {
  it('factors an RCM-ordered 3D grid Laplacian with ~5000 unknowns quickly', () => {
    const side = 17;
    const grid = gridGraph(side, side, side);
    const n = grid.length;
    expect(n).toBe(4913);
    // Start from a bad (shuffled) numbering so that the ordering has real work to do.
    const scrambled = relabel(grid, shuffled(n, rng(41)));

    const start = performance.now();
    const position = invertPermutation(rcmOrder(scrambled));
    const m = gridLaplacian(scrambled, position, 3);
    const original = m.clone();
    const result = m.factor();
    const b = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
    const x = m.solve(b);
    const elapsed = performance.now() - start;

    expect(result).toEqual({ ok: true, singular: [] });
    expect(relativeError(original.multiply(x), b)).toBeLessThan(1e-11);
    // Planes of the cube are the best possible separators: profile ≈ n·side².
    expect(m.size).toBeLessThan(n * side * side);
    expect(elapsed).toBeLessThan(5000); // typically ~0.2 s
  }, 30000);

  it('factors 6000 equations with a half-bandwidth of 500 in a few seconds', () => {
    const n = 6000;
    const halfBand = 500;
    const firstRow = Int32Array.from({ length: n }, (_, j) => Math.max(0, j - halfBand));
    const m = new SkylineMatrix(firstRow);
    expect(m.size).toBe((halfBand + 1) * n - (halfBand * (halfBand + 1)) / 2);
    // Diagonally dominant: Σ_{d=1}^{500} 1/(1+d) < 6 on either side of a diagonal of 20.
    for (let j = 0; j < n; j++) {
      for (let i = firstRow[j]; i < j; i++) m.add(i, j, -1 / (1 + j - i));
      m.add(j, j, 20);
    }
    const exact = Float64Array.from({ length: n }, (_, i) => Math.cos(0.01 * i));
    const b = m.multiply(exact);

    const start = performance.now();
    const result = m.factor();
    const x = m.solve(b);
    const elapsed = performance.now() - start;

    expect(result).toEqual({ ok: true, singular: [] });
    expect(relativeError(x, exact)).toBeLessThan(1e-12);
    expect(elapsed).toBeLessThan(10000); // typically ~1 s
  }, 60000);
});
