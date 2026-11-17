/**
 * Loads on 3D line members (beam and truss): resolution into local axes, work-equivalent
 * nodal loads and internal forces by statics.
 *
 * Everything here works in the member's LOCAL axes (see `memberAxes` in `line.ts`). Local
 * 12-vectors are ordered [Fx, Fy, Fz, Mx, My, Mz] at node i, then the same six at node j.
 *
 * Bending in the local x–z plane is the mirror image of bending in the x–y plane: seen from
 * the right-handed frame (x, y′ = z, z′ = −y) it is ordinary "x–y" bending with
 *   v′ = w,  θz′ = −θy,  Fy′ = Fz,  Mz′ = −My,
 * which is where every sign difference between the two planes below comes from.
 */
import { SolverError } from '../solver/errors';
import { gauss3 } from '../solver/linalg';
import type { MemberLoad3D, MemberLoadDirection, MemberType3D, Vec3 } from './types';

/** Unit vectors of the member's local axes, in global coordinates. */
export interface LineAxes {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** Linearly varying force per unit length between `a` and `b`, local components [x, y, z]. */
export interface LocalDistributed3D {
  a: number;
  b: number;
  /** Intensity at `a`. */
  w1: Vec3;
  /** Intensity at `b`. */
  w2: Vec3;
}

/** Concentrated force at distance `a` from node i, local components [x, y, z]. */
export interface LocalPoint3D {
  a: number;
  p: Vec3;
}

/** Concentrated moment at distance `a` from node i, local components [x, y, z]. */
export interface LocalMoment3D {
  a: number;
  m: Vec3;
}

/** Member loads resolved into local axes. */
export interface LocalLineLoads {
  distributed: LocalDistributed3D[];
  points: LocalPoint3D[];
  moments: LocalMoment3D[];
}

/** Internal forces at one section, with the sign conventions of `Station3D`. */
export interface SectionForces {
  N: number;
  Vy: number;
  Vz: number;
  T: number;
  My: number;
  Mz: number;
}

/** An empty set of member loads. */
export function emptyLineLoads(): LocalLineLoads {
  return { distributed: [], points: [], moments: [] };
}

/**
 * Resolves a vector of magnitude `value` along `direction` into local components [x, y, z].
 * Works for forces and for moments (both are vectors, right-hand rule).
 */
export function resolveDirection(
  value: number,
  direction: MemberLoadDirection,
  axes: LineAxes,
): Vec3 {
  switch (direction) {
    case 'localX':
      return [value, 0, 0];
    case 'localY':
      return [0, value, 0];
    case 'localZ':
      return [0, 0, value];
    case 'globalX':
      return [value * axes.x[0], value * axes.y[0], value * axes.z[0]];
    case 'globalY':
      return [value * axes.x[1], value * axes.y[1], value * axes.z[1]];
    case 'globalZ':
      return [value * axes.x[2], value * axes.y[2], value * axes.z[2]];
    default:
      throw new SolverError('INVALID_MODEL', `Unknown load direction "${String(direction)}".`);
  }
}

function invalid(memberId: string, message: string): never {
  throw new SolverError('INVALID_MODEL', message, { memberId });
}

function checkPosition(memberId: string, a: number, L: number): number {
  const tol = 1e-9 * Math.max(1, L);
  if (!Number.isFinite(a) || a < -tol || a > L + tol) {
    invalid(
      memberId,
      `A load on member "${memberId}" is positioned outside the member (0 to ${L.toFixed(3)}).`,
    );
  }
  return Math.min(Math.max(a, 0), L);
}

function checkValue(memberId: string, value: number): number {
  if (!Number.isFinite(value)) {
    invalid(memberId, `A load on member "${memberId}" has an invalid magnitude.`);
  }
  return value;
}

/**
 * Converts the loads applied to one member into local-axis components. Positions are
 * distances from node i along the member; global-direction distributed intensities are per
 * unit length of member. Throws `INVALID_MODEL` for loads positioned outside the member.
 */
export function resolveLineLoads(
  loads: MemberLoad3D[],
  axes: LineAxes,
  L: number,
  memberId: string,
): LocalLineLoads {
  const out = emptyLineLoads();
  for (const load of loads) {
    if (load.kind === 'distributed') {
      const a = checkPosition(memberId, load.a ?? 0, L);
      const b = checkPosition(memberId, load.b ?? L, L);
      if (b < a) {
        invalid(memberId, `Distributed load on member "${memberId}" ends before it starts.`);
      }
      const w1 = resolveDirection(checkValue(memberId, load.w1), load.direction, axes);
      const w2 = resolveDirection(checkValue(memberId, load.w2 ?? load.w1), load.direction, axes);
      if (b - a < 1e-12 * L) continue;
      out.distributed.push({ a, b, w1, w2 });
    } else if (load.kind === 'point') {
      const a = checkPosition(memberId, load.a, L);
      out.points.push({ a, p: resolveDirection(checkValue(memberId, load.P), load.direction, axes) });
    } else {
      const a = checkPosition(memberId, load.a, L);
      out.moments.push({ a, m: resolveDirection(checkValue(memberId, load.M), load.direction, axes) });
    }
  }
  return out;
}

/** Hermite cubic shape functions [N_vi, N_θi, N_vj, N_θj] at x (θ = dv/dx). */
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

// Local DOF indices of the two bending planes, as [translation_i, rotation_i, translation_j,
// rotation_j], and the sign that converts the plane's slope into the rotation DOF:
// θz = +dv/dx in the x–y plane, θy = −dw/dx in the x–z plane.
const PLANE_Y = { dofs: [1, 5, 7, 11], axis: 1, rot: 1 } as const;
const PLANE_Z = { dofs: [2, 4, 8, 10], axis: 2, rot: -1 } as const;

/**
 * Work-equivalent nodal loads f = ∫ Nᵀ·w dx in local axes, 12 values
 * [Fx, Fy, Fz, Mx, My, Mz]_i then _j. They are exact for the supported load types.
 *
 * Beams use Hermite cubics for transverse forces (and their derivatives for moments about
 * local y / z) and linear shape functions for axial force and torque. Trusses use linear
 * shape functions throughout, i.e. transverse loads go to the joints as simple-beam
 * reactions (a moment M about a transverse axis becomes the couple ∓M/L) and there are no
 * end moments; a torque about the axis of a truss member cannot be carried and is not
 * included (see `lineElement`, which drops it with a warning).
 */
export function equivalentLineLoads(loads: LocalLineLoads, L: number, type: MemberType3D): number[] {
  const f = new Array<number>(12).fill(0);
  const l1 = (x: number) => 1 - x / L;
  const l2 = (x: number) => x / L;

  for (const d of loads.distributed) {
    const span = d.b - d.a;
    const w = (c: number) => (x: number) => d.w1[c] + ((d.w2[c] - d.w1[c]) * (x - d.a)) / span;
    const wx = w(0);
    f[0] += gauss3((x) => l1(x) * wx(x), d.a, d.b);
    f[6] += gauss3((x) => l2(x) * wx(x), d.a, d.b);
    for (const plane of [PLANE_Y, PLANE_Z]) {
      const wt = w(plane.axis);
      const [ti, ri, tj, rj] = plane.dofs;
      if (type === 'truss') {
        f[ti] += gauss3((x) => l1(x) * wt(x), d.a, d.b);
        f[tj] += gauss3((x) => l2(x) * wt(x), d.a, d.b);
      } else {
        // Cubic × linear is quartic: 3-point Gauss is exact.
        f[ti] += gauss3((x) => hermite(x, L)[0] * wt(x), d.a, d.b);
        f[ri] += plane.rot * gauss3((x) => hermite(x, L)[1] * wt(x), d.a, d.b);
        f[tj] += gauss3((x) => hermite(x, L)[2] * wt(x), d.a, d.b);
        f[rj] += plane.rot * gauss3((x) => hermite(x, L)[3] * wt(x), d.a, d.b);
      }
    }
  }

  for (const p of loads.points) {
    f[0] += l1(p.a) * p.p[0];
    f[6] += l2(p.a) * p.p[0];
    for (const plane of [PLANE_Y, PLANE_Z]) {
      const value = p.p[plane.axis];
      const [ti, ri, tj, rj] = plane.dofs;
      if (type === 'truss') {
        f[ti] += l1(p.a) * value;
        f[tj] += l2(p.a) * value;
      } else {
        const n = hermite(p.a, L);
        f[ti] += n[0] * value;
        f[ri] += plane.rot * n[1] * value;
        f[tj] += n[2] * value;
        f[rj] += plane.rot * n[3] * value;
      }
    }
  }

  for (const m of loads.moments) {
    if (type === 'beam') {
      f[3] += l1(m.a) * m.m[0];
      f[9] += l2(m.a) * m.m[0];
    }
    for (const plane of [PLANE_Y, PLANE_Z]) {
      // Moment conjugate to the plane's slope: Mz for dv/dx, −My for dw/dx.
      const value = plane.rot * m.m[plane.axis === 1 ? 2 : 1];
      const [ti, ri, tj, rj] = plane.dofs;
      if (type === 'truss') {
        f[ti] += -value / L;
        f[tj] += value / L;
      } else {
        const dn = hermiteSlope(m.a, L);
        f[ti] += dn[0] * value;
        f[ri] += plane.rot * dn[1] * value;
        f[tj] += dn[2] * value;
        f[rj] += plane.rot * dn[3] * value;
      }
    }
  }
  return f;
}

/**
 * Internal forces at distance x from node i, from a free body of the part of the member
 * between node i and the section, using the member end forces (12 local values, forces
 * exerted by the joints on the member) and the loads on that part. `side` selects the limit
 * at a concentrated load: −1 just before x (loads at x excluded), +1 just after (included).
 *
 * Sign conventions are those of `Station3D`: N tension positive; Vy, Vz the sum of the
 * local-y / local-z forces on the i-side part; T the local-x moment the j-side part exerts on
 * the i-side part; Mz and My such that E·Iz·v″ = Mz and E·Iy·w″ = My.
 */
export function internalForces(
  x: number,
  side: -1 | 1,
  endForces: number[],
  loads: LocalLineLoads,
): SectionForces {
  let fx = endForces[0];
  let fy = endForces[1];
  let fz = endForces[2];
  let mx = endForces[3];
  // Mz: clockwise (about −z) moment of the i-side forces about the section, as in 2D.
  let mz = -endForces[5] + endForces[1] * x;
  // My: the same expression in the mirrored plane (Fy → Fz, Mz → −My).
  let my = endForces[4] + endForces[2] * x;

  for (const d of loads.distributed) {
    const t = Math.min(x, d.b) - d.a;
    if (t <= 0) continue;
    const span = d.b - d.a;
    const kx = (d.w2[0] - d.w1[0]) / span;
    const ky = (d.w2[1] - d.w1[1]) / span;
    const kz = (d.w2[2] - d.w1[2]) / span;
    fx += d.w1[0] * t + (kx * t * t) / 2;
    fy += d.w1[1] * t + (ky * t * t) / 2;
    fz += d.w1[2] * t + (kz * t * t) / 2;
    // ∫ w(s)·(x − s) ds over the loaded length to the left of the section.
    const arm = x - d.a;
    const uniform = arm * t - (t * t) / 2;
    const ramp = (arm * t * t) / 2 - (t * t * t) / 3;
    mz += d.w1[1] * uniform + ky * ramp;
    my += d.w1[2] * uniform + kz * ramp;
  }
  const included = (a: number) => (side === 1 ? a <= x : a < x);
  for (const p of loads.points) {
    if (!included(p.a)) continue;
    fx += p.p[0];
    fy += p.p[1];
    fz += p.p[2];
    mz += p.p[1] * (x - p.a);
    my += p.p[2] * (x - p.a);
  }
  for (const m of loads.moments) {
    if (!included(m.a)) continue;
    mx += m.m[0];
    my += m.m[1];
    mz -= m.m[2];
  }
  return { N: -fx, Vy: fy, Vz: fz, T: -mx, My: my, Mz: mz };
}

/** Positions where the internal-force diagrams have kinks (load start/end) or jumps. */
export function lineBreakpoints(loads: LocalLineLoads): { kinks: number[]; jumps: number[] } {
  const kinks: number[] = [];
  const jumps: number[] = [];
  for (const d of loads.distributed) kinks.push(d.a, d.b);
  for (const p of loads.points) jumps.push(p.a);
  for (const m of loads.moments) jumps.push(m.a);
  return { kinks, jumps };
}

/**
 * Resultant of the member loads in local axes: [Fx, Fy, Fz, Mx, My, Mz] with the moments
 * taken about node i. Used to check the equivalent nodal loads against statics.
 */
export function loadResultant(loads: LocalLineLoads): number[] {
  const r = [0, 0, 0, 0, 0, 0];
  // A force (fx, fy, fz) at (a, 0, 0) has moment (0, −a·fz, a·fy) about node i.
  const addForce = (a: number, fx: number, fy: number, fz: number) => {
    r[0] += fx;
    r[1] += fy;
    r[2] += fz;
    r[4] -= a * fz;
    r[5] += a * fy;
  };
  for (const d of loads.distributed) {
    const span = d.b - d.a;
    // A trapezoid is a uniform part at mid-span plus a triangle at the two-thirds point.
    addForce(d.a + span / 2, d.w1[0] * span, d.w1[1] * span, d.w1[2] * span);
    addForce(
      d.a + (2 * span) / 3,
      ((d.w2[0] - d.w1[0]) * span) / 2,
      ((d.w2[1] - d.w1[1]) * span) / 2,
      ((d.w2[2] - d.w1[2]) * span) / 2,
    );
  }
  for (const p of loads.points) addForce(p.a, p.p[0], p.p[1], p.p[2]);
  for (const m of loads.moments) {
    r[3] += m.m[0];
    r[4] += m.m[1];
    r[5] += m.m[2];
  }
  return r;
}
