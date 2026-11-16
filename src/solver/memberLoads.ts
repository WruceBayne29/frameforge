import { SolverError } from './errors';
import type { Vector } from './linalg';
import { gauss3 } from './linalg';
import type { LoadDirection, MemberLoad, MemberType } from './types';

/** Member loads resolved into local axes. */
export interface LocalDistributed {
  a: number;
  b: number;
  wx1: number;
  wx2: number;
  wy1: number;
  wy2: number;
}
export interface LocalPoint {
  a: number;
  px: number;
  py: number;
}
export interface LocalMoment {
  a: number;
  m: number;
}
export interface LocalMemberLoads {
  distributed: LocalDistributed[];
  points: LocalPoint[];
  moments: LocalMoment[];
}

export function emptyLoads(): LocalMemberLoads {
  return { distributed: [], points: [], moments: [] };
}

/** Resolves a force of magnitude `value` acting along `direction` into local (x, y). */
function resolve(
  value: number,
  direction: LoadDirection,
  cos: number,
  sin: number,
): [number, number] {
  switch (direction) {
    case 'localX':
      return [value, 0];
    case 'localY':
      return [0, value];
    case 'globalX':
      return [value * cos, -value * sin];
    case 'globalY':
      return [value * sin, value * cos];
  }
}

function checkPosition(load: MemberLoad, a: number, L: number): number {
  const tol = 1e-9 * Math.max(1, L);
  if (!Number.isFinite(a) || a < -tol || a > L + tol) {
    throw new SolverError(
      'INVALID_MODEL',
      `A load on member "${load.member}" is positioned outside the member (0 to ${L.toFixed(3)}).`,
      { memberId: load.member },
    );
  }
  return Math.min(Math.max(a, 0), L);
}

/** Converts the loads applied to one member into local-axis components. */
export function resolveMemberLoads(
  loads: MemberLoad[],
  cos: number,
  sin: number,
  L: number,
): LocalMemberLoads {
  const out = emptyLoads();
  for (const load of loads) {
    if (load.kind === 'distributed') {
      const a = checkPosition(load, load.a ?? 0, L);
      const b = checkPosition(load, load.b ?? L, L);
      if (b < a) {
        throw new SolverError(
          'INVALID_MODEL',
          `Distributed load on member "${load.member}" ends before it starts.`,
          { memberId: load.member },
        );
      }
      if (b - a < 1e-12 * L) continue;
      const [wx1, wy1] = resolve(load.w1, load.direction, cos, sin);
      const [wx2, wy2] = resolve(load.w2 ?? load.w1, load.direction, cos, sin);
      out.distributed.push({ a, b, wx1, wx2, wy1, wy2 });
    } else if (load.kind === 'point') {
      const a = checkPosition(load, load.a, L);
      const [px, py] = resolve(load.P, load.direction, cos, sin);
      out.points.push({ a, px, py });
    } else {
      const a = checkPosition(load, load.a, L);
      out.moments.push({ a, m: load.M });
    }
  }
  return out;
}

/** Hermite cubic shape functions [N_vi, N_θi, N_vj, N_θj] at x. */
function hermite(x: number, L: number): [number, number, number, number] {
  const xi = x / L;
  const xi2 = xi * xi;
  const xi3 = xi2 * xi;
  return [1 - 3 * xi2 + 2 * xi3, L * (xi - 2 * xi2 + xi3), 3 * xi2 - 2 * xi3, L * (-xi2 + xi3)];
}

/** First derivatives of the Hermite shape functions at x. */
function hermiteSlope(x: number, L: number): [number, number, number, number] {
  const xi = x / L;
  const xi2 = xi * xi;
  return [(-6 * xi + 6 * xi2) / L, 1 - 4 * xi + 3 * xi2, (6 * xi - 6 * xi2) / L, -2 * xi + 3 * xi2];
}

/**
 * Work-equivalent nodal loads f = ∫ Nᵀ·w dx in local axes, [Fx_i, Fy_i, Mz_i, Fx_j, Fy_j, Mz_j].
 * Frame members use Hermite cubics for transverse loads (giving fixed-end forces and moments);
 * truss members use linear shape functions (simply supported reactions, no end moments).
 */
export function equivalentNodalLoads(loads: LocalMemberLoads, L: number, type: MemberType): Vector {
  const f = [0, 0, 0, 0, 0, 0];
  const linear = (x: number): [number, number] => [1 - x / L, x / L];

  for (const d of loads.distributed) {
    const span = d.b - d.a;
    const wx = (x: number) => d.wx1 + ((d.wx2 - d.wx1) * (x - d.a)) / span;
    const wy = (x: number) => d.wy1 + ((d.wy2 - d.wy1) * (x - d.a)) / span;
    f[0] += gauss3((x) => linear(x)[0] * wx(x), d.a, d.b);
    f[3] += gauss3((x) => linear(x)[1] * wx(x), d.a, d.b);
    if (type === 'truss') {
      f[1] += gauss3((x) => linear(x)[0] * wy(x), d.a, d.b);
      f[4] += gauss3((x) => linear(x)[1] * wy(x), d.a, d.b);
    } else {
      f[1] += gauss3((x) => hermite(x, L)[0] * wy(x), d.a, d.b);
      f[2] += gauss3((x) => hermite(x, L)[1] * wy(x), d.a, d.b);
      f[4] += gauss3((x) => hermite(x, L)[2] * wy(x), d.a, d.b);
      f[5] += gauss3((x) => hermite(x, L)[3] * wy(x), d.a, d.b);
    }
  }

  for (const p of loads.points) {
    const [l1, l2] = linear(p.a);
    f[0] += l1 * p.px;
    f[3] += l2 * p.px;
    if (type === 'truss') {
      f[1] += l1 * p.py;
      f[4] += l2 * p.py;
    } else {
      const n = hermite(p.a, L);
      f[1] += n[0] * p.py;
      f[2] += n[1] * p.py;
      f[4] += n[2] * p.py;
      f[5] += n[3] * p.py;
    }
  }

  for (const m of loads.moments) {
    if (type === 'truss') {
      f[1] += -m.m / L;
      f[4] += m.m / L;
    } else {
      const dn = hermiteSlope(m.a, L);
      f[1] += dn[0] * m.m;
      f[2] += dn[1] * m.m;
      f[4] += dn[2] * m.m;
      f[5] += dn[3] * m.m;
    }
  }
  return f;
}

/**
 * Internal forces at distance x from node i, from a free body of the part of the member to
 * the left of the section. `side` selects the limit at a concentrated load: -1 just to the
 * left of x (loads at x excluded), +1 just to the right (loads at x included).
 */
export function internalForcesAt(
  x: number,
  side: -1 | 1,
  endForces: Vector,
  loads: LocalMemberLoads,
): { N: number; V: number; M: number } {
  let fx = endForces[0];
  let fy = endForces[1];
  // Sagging-positive moment = clockwise moment of left-hand forces about the section.
  let m = -endForces[2] + endForces[1] * x;

  for (const d of loads.distributed) {
    const e = Math.min(x, d.b);
    const t = e - d.a;
    if (t <= 0) continue;
    const span = d.b - d.a;
    const kx = (d.wx2 - d.wx1) / span;
    const ky = (d.wy2 - d.wy1) / span;
    fx += d.wx1 * t + (kx * t * t) / 2;
    fy += d.wy1 * t + (ky * t * t) / 2;
    const arm = x - d.a;
    m += d.wy1 * (arm * t - (t * t) / 2) + ky * ((arm * t * t) / 2 - (t * t * t) / 3);
  }
  const included = (a: number) => (side === 1 ? a <= x : a < x);
  for (const p of loads.points) {
    if (!included(p.a)) continue;
    fx += p.px;
    fy += p.py;
    m += p.py * (x - p.a);
  }
  for (const mo of loads.moments) {
    if (!included(mo.a)) continue;
    m -= mo.m;
  }
  return { N: -fx, V: fy, M: m };
}

/** Positions where the internal-force diagrams have kinks or jumps. */
export function loadBreakpoints(loads: LocalMemberLoads): { kinks: number[]; jumps: number[] } {
  const kinks: number[] = [];
  const jumps: number[] = [];
  for (const d of loads.distributed) kinks.push(d.a, d.b);
  for (const p of loads.points) jumps.push(p.a);
  for (const m of loads.moments) jumps.push(m.a);
  return { kinks, jumps };
}
