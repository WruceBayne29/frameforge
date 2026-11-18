import { describe, expect, it } from 'vitest';
import { matMul, transpose } from '../solver/linalg';
import type { Matrix } from '../solver/linalg';
import { jacobiEigen } from '../solver/modal';
import {
  add,
  cross,
  dot,
  GAUSS2,
  invert,
  norm,
  normalize,
  planeStress,
  principal3,
  scale,
  sub,
  vonMises3,
} from './math';
import type { Vec3 } from './types';

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

const randomVec = (random: () => number): Vec3 => [
  20 * random() - 10,
  20 * random() - 10,
  20 * random() - 10,
];

/** Rotation matrix Rz(c)·Ry(b)·Rx(a) (angles in radians). */
function rotation(a: number, b: number, c: number): Matrix {
  const rx = [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ];
  const ry = [
    [Math.cos(b), 0, Math.sin(b)],
    [0, 1, 0],
    [-Math.sin(b), 0, Math.cos(b)],
  ];
  const rz = [
    [Math.cos(c), -Math.sin(c), 0],
    [Math.sin(c), Math.cos(c), 0],
    [0, 0, 1],
  ];
  return matMul(matMul(rz, ry), rx);
}

/** Stress tensor with principal values p in the axes given by the columns of r: R·diag(p)·Rᵀ. */
function rotatedState(p: number[], r: Matrix): Matrix {
  const diag = [
    [p[0], 0, 0],
    [0, p[1], 0],
    [0, 0, p[2]],
  ];
  return matMul(matMul(r, diag), transpose(r));
}

/** principal3 / vonMises3 take (sxx, syy, szz, txy, tyz, tzx). */
const components = (s: Matrix): [number, number, number, number, number, number] => [
  s[0][0],
  s[1][1],
  s[2][2],
  s[0][1],
  s[1][2],
  s[2][0],
];

const determinant3 = (s: Matrix): number =>
  s[0][0] * (s[1][1] * s[2][2] - s[1][2] * s[2][1]) -
  s[0][1] * (s[1][0] * s[2][2] - s[1][2] * s[2][0]) +
  s[0][2] * (s[1][0] * s[2][1] - s[1][1] * s[2][0]);

describe('vec3 helpers', () => {
  it('adds, subtracts and scales component-wise', () => {
    expect(add([1, 2, 3], [10, -20, 30])).toEqual([11, -18, 33]);
    expect(sub([1, 2, 3], [10, -20, 30])).toEqual([-9, 22, -27]);
    expect(scale([1, -2, 3], -2)).toEqual([-2, 4, -6]);
    // Inputs are not modified.
    const a: Vec3 = [1, 2, 3];
    const b: Vec3 = [4, 5, 6];
    add(a, b);
    sub(a, b);
    scale(a, 3);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([4, 5, 6]);
  });

  it('computes dot products and norms', () => {
    expect(dot([1, 2, 3], [4, -5, 6])).toBe(12);
    expect(dot([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(norm([3, 4, 12])).toBe(13);
    expect(norm([0, 0, 0])).toBe(0);
    // No overflow or underflow in the intermediate squares.
    expect(norm([3e200, 4e200, 0])).toBeCloseTo(5e200, -187);
    expect(norm([3e-200, 4e-200, 0])).toBeGreaterThan(4.9e-200);
  });

  it('computes right-handed cross products', () => {
    const x: Vec3 = [1, 0, 0];
    const y: Vec3 = [0, 1, 0];
    const z: Vec3 = [0, 0, 1];
    expect(cross(x, y)).toEqual(z);
    expect(cross(y, z)).toEqual(x);
    expect(cross(z, x)).toEqual(y);
    expect(cross(y, x)).toEqual([0, 0, -1]);
    expect(cross([1, 2, 3], [4, 5, 6])).toEqual([-3, 6, -3]);
    expect(cross([2, -1, 7], [2, -1, 7])).toEqual([0, 0, 0]);
  });

  it('satisfies the vector identities', () => {
    const random = rng(1);
    for (let trial = 0; trial < 50; trial++) {
      const a = randomVec(random);
      const b = randomVec(random);
      const c = randomVec(random);
      const s = 4 * random() - 2;
      const axb = cross(a, b);
      // a × b is perpendicular to both and anti-commutative.
      expect(dot(axb, a)).toBeCloseTo(0, 9);
      expect(dot(axb, b)).toBeCloseTo(0, 9);
      expect(add(axb, cross(b, a))).toEqual([0, 0, 0]);
      // Lagrange: |a × b|² = |a|²·|b|² − (a·b)².
      expect(norm(axb) ** 2).toBeCloseTo(dot(a, a) * dot(b, b) - dot(a, b) ** 2, 7);
      // Scalar triple product is cyclic.
      expect(dot(a, cross(b, c))).toBeCloseTo(dot(b, cross(c, a)), 8);
      // Vector triple product: a × (b × c) = b·(a·c) − c·(a·b).
      const lhs = cross(a, cross(b, c));
      const rhs = sub(scale(b, dot(a, c)), scale(c, dot(a, b)));
      for (let i = 0; i < 3; i++) expect(lhs[i]).toBeCloseTo(rhs[i], 8);
      // Linearity and the norm.
      expect(dot(scale(a, s), b)).toBeCloseTo(s * dot(a, b), 9);
      expect(dot(add(a, b), c)).toBeCloseTo(dot(a, c) + dot(b, c), 9);
      expect(dot(sub(a, b), c)).toBeCloseTo(dot(a, c) - dot(b, c), 9);
      expect(norm(a)).toBeCloseTo(Math.sqrt(dot(a, a)), 12);
      expect(norm(scale(a, s))).toBeCloseTo(Math.abs(s) * norm(a), 10);
    }
  });

  it('normalises to unit length and maps the zero vector to zero', () => {
    expect(normalize([0, 0, 5])).toEqual([0, 0, 1]);
    expect(normalize([3, 0, -4])).toEqual([0.6, 0, -0.8]);
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
    const random = rng(2);
    for (let trial = 0; trial < 20; trial++) {
      const a = randomVec(random);
      const u = normalize(a);
      expect(norm(u)).toBeCloseTo(1, 14);
      // Same direction: a × u = 0 and a·u = |a|.
      expect(norm(cross(a, u))).toBeCloseTo(0, 12);
      expect(dot(a, u)).toBeCloseTo(norm(a), 12);
    }
  });
});

describe('GAUSS2', () => {
  const integrate = (f: (x: number) => number): number => GAUSS2.reduce((s, x) => s + f(x), 0);

  it('holds the two-point Gauss–Legendre abscissae ±1/√3', () => {
    expect(GAUSS2).toHaveLength(2);
    expect(GAUSS2[0]).toBeCloseTo(-0.5773502691896257, 15);
    expect(GAUSS2[1]).toBe(-GAUSS2[0]);
  });

  it('integrates cubics over [−1, 1] exactly with unit weights', () => {
    expect(integrate(() => 1)).toBe(2);
    expect(integrate((x) => x)).toBeCloseTo(0, 15);
    expect(integrate((x) => x * x)).toBeCloseTo(2 / 3, 15);
    expect(integrate((x) => x ** 3)).toBeCloseTo(0, 15);
    // ∫ (4x³ − 3x² + 2x + 5) dx = −2 + 10 = 8.
    expect(integrate((x) => 4 * x ** 3 - 3 * x * x + 2 * x + 5)).toBeCloseTo(8, 14);
    // … but not quartics: ∫ x⁴ dx = 2/5, the rule gives 2/9.
    expect(integrate((x) => x ** 4)).toBeCloseTo(2 / 9, 15);
  });
});

describe('invert', () => {
  const expectMatrixClose = (actual: Matrix | null, expected: Matrix, digits = 12): void => {
    expect(actual).not.toBeNull();
    expected.forEach((row, i) =>
      row.forEach((v, j) => {
        expect(actual![i][j]).toBeCloseTo(v, digits);
      }),
    );
  };

  it('inverts 1 × 1 and 2 × 2 matrices', () => {
    expectMatrixClose(invert([[4]]), [[0.25]]);
    // det = 10: inverse = [[6, −7], [−2, 4]] / 10.
    expectMatrixClose(
      invert([
        [4, 7],
        [2, 6],
      ]),
      [
        [0.6, -0.7],
        [-0.2, 0.4],
      ],
    );
  });

  it('inverts a 3 × 3 matrix with a known integer inverse', () => {
    expectMatrixClose(
      invert([
        [1, 2, 3],
        [0, 1, 4],
        [5, 6, 0],
      ]),
      [
        [-24, 18, 5],
        [20, -15, -4],
        [-5, 4, 1],
      ],
    );
  });

  it('inverts the identity, diagonal and rotation matrices', () => {
    const identity = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    expect(invert(identity)).toEqual(identity);
    expectMatrixClose(
      invert([
        [2, 0, 0],
        [0, -4, 0],
        [0, 0, 0.5],
      ]),
      [
        [0.5, 0, 0],
        [0, -0.25, 0],
        [0, 0, 2],
      ],
    );
    // A rotation is orthogonal: R⁻¹ = Rᵀ.
    const r = rotation(0.3, -1.1, 2.2);
    expectMatrixClose(invert(r), transpose(r), 14);
  });

  it('pivots when the leading entry is zero', () => {
    // A permutation matrix is its own transpose-inverse.
    const p = [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ];
    expect(invert(p)).toEqual(transpose(p));
    expectMatrixClose(
      invert([
        [0, 2],
        [3, 1],
      ]),
      [
        [-1 / 6, 1 / 3],
        [0.5, 0],
      ],
    );
  });

  it('gives A·A⁻¹ = I for random matrices and leaves the input untouched', () => {
    const random = rng(3);
    for (const n of [2, 3, 4, 6, 9]) {
      const a = Array.from({ length: n }, () => Array.from({ length: n }, () => 2 * random() - 1));
      const copy = a.map((row) => row.slice());
      const inverse = invert(a);
      expect(a).toEqual(copy);
      expect(inverse).not.toBeNull();
      const product = matMul(a, inverse!);
      const other = matMul(inverse!, a);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          expect(product[i][j]).toBeCloseTo(i === j ? 1 : 0, 9);
          expect(other[i][j]).toBeCloseTo(i === j ? 1 : 0, 9);
        }
      }
    }
  });

  it('is independent of the overall scale of the matrix', () => {
    // Jacobians in metres or millimetres, stiffnesses in N/m: the singularity test is relative.
    for (const factor of [1e-9, 1e9]) {
      expectMatrixClose(
        invert([
          [4 * factor, 7 * factor],
          [2 * factor, 6 * factor],
        ])!.map((row) => row.map((v) => v * factor)),
        [
          [0.6, -0.7],
          [-0.2, 0.4],
        ],
      );
    }
  });

  it('returns null for singular matrices', () => {
    expect(invert([[0]])).toBeNull();
    expect(
      invert([
        [0, 0],
        [0, 0],
      ]),
    ).toBeNull();
    // Proportional rows.
    expect(
      invert([
        [1, 2],
        [2, 4],
      ]),
    ).toBeNull();
    // Third row = first + second (rank 2).
    expect(
      invert([
        [1, 2, 3],
        [4, 5, 6],
        [5, 7, 9],
      ]),
    ).toBeNull();
    // A zero column.
    expect(
      invert([
        [1, 0, 2],
        [3, 0, 4],
        [5, 0, 6],
      ]),
    ).toBeNull();
    // Singular to working precision: the rows differ by one part in 1e16.
    expect(
      invert([
        [1, 1],
        [1, 1 + 1e-16],
      ]),
    ).toBeNull();
  });
});

describe('vonMises3', () => {
  it('equals |σ| in uniaxial stress along any axis', () => {
    expect(vonMises3(250, 0, 0, 0, 0, 0)).toBeCloseTo(250, 12);
    expect(vonMises3(0, -250, 0, 0, 0, 0)).toBeCloseTo(250, 12);
    expect(vonMises3(0, 0, 80, 0, 0, 0)).toBeCloseTo(80, 12);
  });

  it('equals √3·|τ| in pure shear on any plane', () => {
    expect(vonMises3(0, 0, 0, 100, 0, 0)).toBeCloseTo(100 * Math.sqrt(3), 12);
    expect(vonMises3(0, 0, 0, 0, -100, 0)).toBeCloseTo(100 * Math.sqrt(3), 12);
    expect(vonMises3(0, 0, 0, 0, 0, 40)).toBeCloseTo(40 * Math.sqrt(3), 12);
    // Pure shear written in principal axes: (τ, −τ, 0).
    expect(vonMises3(100, -100, 0, 0, 0, 0)).toBeCloseTo(100 * Math.sqrt(3), 12);
  });

  it('vanishes for hydrostatic stress and ignores a superposed pressure', () => {
    expect(vonMises3(-75, -75, -75, 0, 0, 0)).toBe(0);
    expect(vonMises3(0, 0, 0, 0, 0, 0)).toBe(0);
    expect(vonMises3(120 + 500, -30 + 500, 45 + 500, 60, -20, 35)).toBeCloseTo(
      vonMises3(120, -30, 45, 60, -20, 35),
      10,
    );
  });

  it('matches the hand-computed value of a general state', () => {
    // ½·[(100−40)² + (40+20)² + (−20−100)²] + 3·(30² + 10² + 20²) = 10800 + 4200.
    expect(vonMises3(100, 40, -20, 30, 10, 20)).toBeCloseTo(Math.sqrt(15000), 12);
  });

  it('is invariant under rotation and equals the principal-stress formula', () => {
    const random = rng(4);
    for (let trial = 0; trial < 25; trial++) {
      const p = [200 * random() - 100, 200 * random() - 100, 200 * random() - 100];
      const s = rotatedState(p, rotation(6 * random(), 6 * random(), 6 * random()));
      const expected = Math.sqrt(
        0.5 * ((p[0] - p[1]) ** 2 + (p[1] - p[2]) ** 2 + (p[2] - p[0]) ** 2),
      );
      expect(vonMises3(...components(s))).toBeCloseTo(expected, 9);
    }
  });
});

describe('principal3', () => {
  it('returns the mean stress three times for a hydrostatic state', () => {
    expect(principal3(-75, -75, -75, 0, 0, 0)).toEqual([-75, -75, -75]);
    expect(principal3(0, 0, 0, 0, 0, 0)).toEqual([0, 0, 0]);
    expect(principal3(1e6, 1e6, 1e6, 0, 0, 0)).toEqual([1e6, 1e6, 1e6]);
  });

  it('returns (σ, 0, 0) for uniaxial tension and (0, 0, −σ) for compression', () => {
    for (const [sxx, syy, szz] of [
      [250, 0, 0],
      [0, 250, 0],
      [0, 0, 250],
    ]) {
      const tension = principal3(sxx, syy, szz, 0, 0, 0);
      expect(tension[0]).toBeCloseTo(250, 11);
      expect(tension[1]).toBeCloseTo(0, 11);
      expect(tension[2]).toBeCloseTo(0, 11);
      const compression = principal3(-sxx, -syy, -szz, 0, 0, 0);
      expect(compression[0]).toBeCloseTo(0, 11);
      expect(compression[1]).toBeCloseTo(0, 11);
      expect(compression[2]).toBeCloseTo(-250, 11);
    }
  });

  it('returns (τ, 0, −τ) for pure shear on any plane', () => {
    for (const shear of [
      [80, 0, 0],
      [0, -80, 0],
      [0, 0, 80],
    ]) {
      const p = principal3(0, 0, 0, shear[0], shear[1], shear[2]);
      expect(p[0]).toBeCloseTo(80, 11);
      expect(p[1]).toBeCloseTo(0, 11);
      expect(p[2]).toBeCloseTo(-80, 11);
    }
  });

  it('sorts the stresses of an axis-aligned state', () => {
    expect(principal3(10, 30, 20, 0, 0, 0).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([
      30, 20, 10,
    ]);
    expect(principal3(-5, -50, 40, 0, 0, 0).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([
      40, -5, -50,
    ]);
  });

  it('solves a plane state with an out-of-plane stress', () => {
    // In-plane: centre 50, radius hypot(30, 40) = 50 → 100 and 0; out-of-plane stress 20.
    const p = principal3(80, 20, 20, 40, 0, 0);
    expect(p[0]).toBeCloseTo(100, 11);
    expect(p[1]).toBeCloseTo(20, 11);
    expect(p[2]).toBeCloseTo(0, 11);
  });

  it('finds the eigenvalues of a hand-checked full tensor', () => {
    // [[3, 1, 1], [1, 3, 1], [1, 1, 3]] = 2·I + ones: eigenvalues 5, 2, 2.
    const equal = principal3(3, 3, 3, 1, 1, 1);
    expect(equal[0]).toBeCloseTo(5, 11);
    expect(equal[1]).toBeCloseTo(2, 11);
    expect(equal[2]).toBeCloseTo(2, 11);
    // [[2, 0, 1], [0, 3, 0], [1, 0, 2]]: eigenvalues 3, 3, 1 (tzx couples x and z).
    const coupled = principal3(2, 3, 2, 0, 0, 1);
    expect(coupled[0]).toBeCloseTo(3, 11);
    expect(coupled[1]).toBeCloseTo(3, 11);
    expect(coupled[2]).toBeCloseTo(1, 11);
    // [[1, 2, 0], [2, 1, 2], [0, 2, 1]]: eigenvalues 1 + 2√2, 1, 1 − 2√2 (tyz couples y and z).
    const chain = principal3(1, 1, 1, 2, 2, 0);
    expect(chain[0]).toBeCloseTo(1 + 2 * Math.SQRT2, 11);
    expect(chain[1]).toBeCloseTo(1, 11);
    expect(chain[2]).toBeCloseTo(1 - 2 * Math.SQRT2, 11);
  });

  it('satisfies the invariants of a general state: sum = trace, product = determinant', () => {
    const s = [
      [120, 60, 35],
      [60, -30, -20],
      [35, -20, 45],
    ];
    const [s1, s2, s3] = principal3(...components(s));
    expect(s1).toBeGreaterThanOrEqual(s2);
    expect(s2).toBeGreaterThanOrEqual(s3);
    // I1 = trace, I2 = sum of principal minors, I3 = determinant.
    expect(s1 + s2 + s3).toBeCloseTo(120 - 30 + 45, 10);
    const i2 = 120 * -30 + -30 * 45 + 45 * 120 - 60 * 60 - 20 * 20 - 35 * 35;
    expect(s1 * s2 + s2 * s3 + s3 * s1).toBeCloseTo(i2, 8);
    expect(s1 * s2 * s3).toBeCloseTo(determinant3(s), 6);
    // Each one is a root of the characteristic polynomial det(S − λ·I) = 0.
    for (const lambda of [s1, s2, s3]) {
      const shifted = s.map((row, i) => row.map((v, j) => (i === j ? v - lambda : v)));
      expect(determinant3(shifted) / 1e6).toBeCloseTo(0, 10);
    }
    // And the von Mises stress follows from the principal values.
    expect(Math.sqrt(0.5 * ((s1 - s2) ** 2 + (s2 - s3) ** 2 + (s3 - s1) ** 2))).toBeCloseTo(
      vonMises3(...components(s)),
      10,
    );
  });

  it('recovers known principal stresses from any orientation, in sorted order', () => {
    const random = rng(5);
    const cases: Array<() => number[]> = [
      () => [200 * random() - 100, 200 * random() - 100, 200 * random() - 100], // general
      () => [250, 0, 0], // uniaxial tension: repeated lower pair
      () => [0, 0, -250], // uniaxial compression: repeated upper pair
      () => [120, 120, -40], // equibiaxial
      () => [80, 0, -80], // pure shear
      () => [1e6 + 1, 1e6, 1e6 - 1], // small deviator on a large pressure
      () => [100 + 1e-7, 100, 100 - 1e-7], // nearly hydrostatic
    ];
    for (const generate of cases) {
      for (let trial = 0; trial < 200; trial++) {
        const expected = generate().sort((a, b) => b - a);
        const s = rotatedState(expected, rotation(6 * random(), 6 * random(), 6 * random()));
        const p = principal3(...components(s));
        const magnitude = Math.max(...expected.map(Math.abs));
        expect(p[0]).toBeGreaterThanOrEqual(p[1]);
        expect(p[1]).toBeGreaterThanOrEqual(p[2]);
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(p[i] - expected[i])).toBeLessThan(1e-12 * magnitude);
        }
      }
    }
  });

  it('agrees with the Jacobi eigenvalue solver of the 2D package', () => {
    const random = rng(6);
    for (let trial = 0; trial < 50; trial++) {
      const s = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      for (let i = 0; i < 3; i++) {
        for (let j = i; j < 3; j++) {
          s[i][j] = 300 * random() - 150;
          s[j][i] = s[i][j];
        }
      }
      const reference = jacobiEigen(s).values; // ascending
      const p = principal3(...components(s));
      for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo(reference[2 - i], 9);
    }
  });

  it('scales linearly with the stress unit', () => {
    // The same state in kPa and in Pa-like magnitudes, and with tiny values.
    const base = principal3(120, -30, 45, 60, -20, 35);
    for (const factor of [1e-12, 1e-3, 1e9]) {
      const scaledState = principal3(
        120 * factor,
        -30 * factor,
        45 * factor,
        60 * factor,
        -20 * factor,
        35 * factor,
      );
      for (let i = 0; i < 3; i++) {
        expect(scaledState[i] / factor).toBeCloseTo(base[i], 9);
      }
    }
  });
});

describe('planeStress', () => {
  it('handles uniaxial stress in either direction', () => {
    expect(planeStress(250, 0, 0)).toEqual({ s1: 250, s2: 0, vonMises: 250 });
    expect(planeStress(0, 250, 0)).toEqual({ s1: 250, s2: 0, vonMises: 250 });
    expect(planeStress(-250, 0, 0)).toEqual({ s1: 0, s2: -250, vonMises: 250 });
  });

  it('gives ±τ and √3·|τ| in pure shear', () => {
    for (const tau of [80, -80]) {
      const r = planeStress(0, 0, tau);
      expect(r.s1).toBe(80);
      expect(r.s2).toBe(-80);
      expect(r.vonMises).toBeCloseTo(80 * Math.sqrt(3), 12);
    }
    // The same state in its principal axes.
    expect(planeStress(80, -80, 0).vonMises).toBeCloseTo(80 * Math.sqrt(3), 12);
  });

  it('gives equal principal stresses and vonMises = |p| for equal biaxial stress', () => {
    // The in-plane "hydrostatic" state: Mohr's circle shrinks to a point. The third
    // principal stress is zero, so von Mises is |p|, not 0.
    expect(planeStress(60, 60, 0)).toEqual({ s1: 60, s2: 60, vonMises: 60 });
    expect(planeStress(-60, -60, 0)).toEqual({ s1: -60, s2: -60, vonMises: 60 });
    expect(planeStress(0, 0, 0)).toEqual({ s1: 0, s2: 0, vonMises: 0 });
  });

  it("follows Mohr's circle for a general state", () => {
    // Centre 50, radius hypot(30, 40) = 50.
    const r = planeStress(80, 20, 40);
    expect(r.s1).toBeCloseTo(100, 12);
    expect(r.s2).toBeCloseTo(0, 12);
    expect(r.vonMises).toBeCloseTo(100, 12);
    // Centre −10, radius hypot(50, 120) = 130; vonMises² = 120² + 140² + 120·140.
    const q = planeStress(40, -60, -120);
    expect(q.s1).toBeCloseTo(120, 12);
    expect(q.s2).toBeCloseTo(-140, 12);
    expect(q.vonMises).toBeCloseTo(Math.sqrt(120 * 120 + 140 * 140 + 120 * 140), 12);
  });

  it('is consistent with the 3D functions with szz = tyz = tzx = 0', () => {
    const random = rng(7);
    for (let trial = 0; trial < 50; trial++) {
      const sx = 400 * random() - 200;
      const sy = 400 * random() - 200;
      const txy = 400 * random() - 200;
      const r = planeStress(sx, sy, txy);
      expect(r.s1).toBeGreaterThanOrEqual(r.s2);
      // Invariants of the 2 × 2 tensor.
      expect(r.s1 + r.s2).toBeCloseTo(sx + sy, 10);
      expect(r.s1 * r.s2).toBeCloseTo(sx * sy - txy * txy, 7);
      expect(r.vonMises).toBeCloseTo(vonMises3(sx, sy, 0, txy, 0, 0), 10);
      expect(r.vonMises).toBeCloseTo(Math.sqrt(r.s1 ** 2 - r.s1 * r.s2 + r.s2 ** 2), 10);
      // The 3D principal stresses are the two in-plane ones plus zero.
      const three = principal3(sx, sy, 0, txy, 0, 0);
      const expected = [r.s1, r.s2, 0].sort((a, b) => b - a);
      for (let i = 0; i < 3; i++) expect(three[i]).toBeCloseTo(expected[i], 10);
    }
  });
});
