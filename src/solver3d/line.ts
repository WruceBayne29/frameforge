/**
 * 3D line elements: the truss bar (2 nodes × 3 translations) and the Euler–Bernoulli
 * space-frame beam (2 nodes × 6 DOF), with member loads, end releases and exact result
 * recovery.
 *
 * Local DOF order (both types use 12 local values internally):
 *   [u, v, w, θx, θy, θz] at node i, then the same six at node j,
 * with u, v, w along local x, y, z and the rotations about them (right-hand rule). Bending
 * in the local x–y plane couples v and θz (= dv/dx) and uses E·Iz; bending in the local x–z
 * plane couples w and θy (= −dw/dx) and uses E·Iy.
 */
import { SolverError } from '../solver/errors';
import { matMul, matVec, transpose, zeros } from '../solver/linalg';
import type { ElementMatrices } from './contract';
import type { LineAxes, LocalLineLoads, SectionForces } from './lineLoads';
import {
  equivalentLineLoads,
  internalForces,
  lineBreakpoints,
  resolveLineLoads,
} from './lineLoads';
import { cross, dot, normalize, sub } from './math';
import type {
  EndRelease,
  Extreme3D,
  Member3D,
  MemberLoad3D,
  MemberResult3D,
  Station3D,
  Vec3,
} from './types';

/** One line member prepared for assembly, with the data needed to recover its results. */
export interface LineElement extends ElementMatrices {
  /** The member this element was built from. */
  member: Member3D;
  /** Member length. */
  L: number;
  /** Unit vectors of the local axes in global coordinates. */
  axes: LineAxes;
  /** Local 12 × 12 stiffness after condensing the end releases. */
  kLocal: number[][];
  /** Local equivalent nodal loads (12 values) after condensing the end releases. */
  fLocal: number[];
  /** Member loads (self-weight included) resolved into local axes. */
  loads: LocalLineLoads;
  /** Which of the 12 local DOFs are released (always all false for a truss). */
  released: boolean[];
  /** Notes about loads that could not be applied (e.g. a torque on a truss member). */
  warnings: string[];
}

const RELEASE_KEYS = ['fx', 'fy', 'fz', 'mx', 'my', 'mz'] as const;

/** Gauss–Legendre points and weights on [-1, 1] (3-point rule, exact up to degree 5). */
const GAUSS_3: ReadonlyArray<readonly [number, number]> = [
  [-Math.sqrt(3 / 5), 5 / 9],
  [0, 8 / 9],
  [Math.sqrt(3 / 5), 5 / 9],
];

/**
 * Length and local axes of a member from node i (`xi`) to node j (`xj`), following the
 * convention documented on `Member3D`: local x runs from i to j; with `beta = 0` local z is
 * horizontal (x × Y) and local y = z × x has a positive global-Y component, except for a
 * vertical member where local z = global Z. `beta` (radians) then rotates y and z about
 * local x by the right-hand rule. The returned axes are unit vectors in global coordinates
 * and form a right-handed triad (x × y = z).
 */
export function memberAxes(xi: Vec3, xj: Vec3, beta = 0): { L: number; x: Vec3; y: Vec3; z: Vec3 } {
  const d = sub(xj, xi);
  const L = Math.hypot(d[0], d[1], d[2]);
  if (!(L > 0) || !Number.isFinite(L)) {
    throw new SolverError('INVALID_MODEL', 'A member has zero length or invalid coordinates.');
  }
  const x: Vec3 = [d[0] / L, d[1] / L, d[2] / L];
  // `+ 0` turns the −0 components a cross product can produce into +0.
  const tidy = (v: Vec3): Vec3 => [v[0] + 0, v[1] + 0, v[2] + 0];
  // Vertical when the horizontal projection of the unit axis vanishes.
  const vertical = Math.hypot(x[0], x[2]) < 1e-9;
  let y0: Vec3;
  let z0: Vec3;
  if (vertical) {
    // z = global Z, y = z × x. Built as y = Z × x (normalised) and z = x × y so that the
    // triad stays exactly orthonormal when the member is only vertical to within the tolerance.
    y0 = tidy(normalize(cross([0, 0, 1], x)));
    z0 = tidy(cross(x, y0));
  } else {
    z0 = tidy(normalize(cross(x, [0, 1, 0])));
    y0 = tidy(cross(z0, x));
  }
  if (beta === 0) return { L, x, y: y0, z: z0 };
  const c = Math.cos(beta);
  const s = Math.sin(beta);
  const y: Vec3 = [c * y0[0] + s * z0[0], c * y0[1] + s * z0[1], c * y0[2] + s * z0[2]];
  const z: Vec3 = [c * z0[0] - s * y0[0], c * z0[1] - s * y0[1], c * z0[2] - s * y0[2]];
  return { L, x, y, z };
}

/**
 * 12 × 12 local stiffness of a line member for DOFs [u, v, w, θx, θy, θz]_i then _j.
 * `ea`, `gj`, `eiy`, `eiz` are the rigidities E·A, G·J, E·Iy and E·Iz; a truss passes zero
 * for the last three and keeps only the axial terms.
 */
export function localStiffness3D(
  L: number,
  ea: number,
  gj: number,
  eiy: number,
  eiz: number,
): number[][] {
  const k = zeros(12, 12);
  const set = (a: number, b: number, value: number) => {
    k[a][b] = value;
    k[b][a] = value;
  };
  set(0, 0, ea / L);
  set(0, 6, -ea / L);
  set(6, 6, ea / L);
  set(3, 3, gj / L);
  set(3, 9, -gj / L);
  set(9, 9, gj / L);

  // Bending in the x–y plane: DOFs v_i, θz_i, v_j, θz_j (θz = dv/dx), as in the 2D solver.
  const z1 = (12 * eiz) / L ** 3;
  const z2 = (6 * eiz) / L ** 2;
  set(1, 1, z1);
  set(1, 5, z2);
  set(1, 7, -z1);
  set(1, 11, z2);
  set(5, 5, (4 * eiz) / L);
  set(5, 7, -z2);
  set(5, 11, (2 * eiz) / L);
  set(7, 7, z1);
  set(7, 11, -z2);
  set(11, 11, (4 * eiz) / L);

  // Bending in the x–z plane: DOFs w_i, θy_i, w_j, θy_j. Because θy = −dw/dx the terms that
  // couple a translation with a rotation change sign.
  const y1 = (12 * eiy) / L ** 3;
  const y2 = (6 * eiy) / L ** 2;
  set(2, 2, y1);
  set(2, 4, -y2);
  set(2, 8, -y1);
  set(2, 10, -y2);
  set(4, 4, (4 * eiy) / L);
  set(4, 8, y2);
  set(4, 10, (2 * eiy) / L);
  set(8, 8, y1);
  set(8, 10, y2);
  set(10, 10, (4 * eiy) / L);
  return k;
}

/** Local DOF indices (0–11) released by the two `EndRelease` records. */
export function releasedDofs3D(releaseI?: EndRelease, releaseJ?: EndRelease): number[] {
  const released: number[] = [];
  RELEASE_KEYS.forEach((key, d) => {
    if (releaseI?.[key]) released.push(d);
  });
  RELEASE_KEYS.forEach((key, d) => {
    if (releaseJ?.[key]) released.push(6 + d);
  });
  return released;
}

/**
 * Static condensation of released local DOFs, in place. Afterwards the released rows and
 * columns of `k` are exactly zero and `f` (the equivalent nodal loads) is adjusted so the
 * retained DOFs see the correct loads:
 *   k* = k_kk − k_kr·k_rr⁻¹·k_rk,   f* = f_k − k_kr·k_rr⁻¹·f_r.
 *
 * When a pivot has already vanished because the releases leave the member free to move as a
 * rigid body in that mode (e.g. torsion released at both ends), the DOF is simply removed:
 * the element then has no stiffness in that mode. If the member carries load in such a mode
 * nothing can resist it and a `SolverError('UNSTABLE')` is thrown.
 */
export function condenseReleases(
  k: number[][],
  f: number[],
  released: number[],
  L: number,
  memberId: string,
): void {
  const n = k.length;
  const diagonal = k.map((row, i) => Math.abs(row[i]));
  // Force scale of the load vector (moments divided by L), to judge "no load in this mode".
  let scale = 0;
  f.forEach((value, i) => {
    scale = Math.max(scale, Math.abs(value) / (i % 6 >= 3 ? L : 1));
  });

  for (const r of released) {
    const krr = k[r][r];
    if (krr > 1e-9 * diagonal[r]) {
      const row = k[r].slice();
      const fr = f[r];
      for (let i = 0; i < n; i++) {
        if (i === r) continue;
        const factor = k[i][r] / krr;
        if (factor === 0) continue;
        for (let j = 0; j < n; j++) k[i][j] -= factor * row[j];
        f[i] -= factor * fr;
      }
    } else if (Math.abs(f[r]) / (r % 6 >= 3 ? L : 1) > 1e-9 * scale) {
      throw new SolverError(
        'UNSTABLE',
        `The end releases of member "${memberId}" leave it free to move as a rigid body ` +
          `(${RELEASE_KEYS[r % 6]} is released at both ends or in a combination that forms a ` +
          'mechanism), but it carries load in that direction. Remove one of the releases.',
        { memberId },
      );
    }
    for (let i = 0; i < n; i++) {
      k[r][i] = 0;
      k[i][r] = 0;
    }
    f[r] = 0;
  }
}

/** 12 × 12 transformation T = diag(R, R, R, R) with u_local = T · u_global, R = [x; y; z]. */
function transformation(axes: LineAxes): number[][] {
  const r = [axes.x, axes.y, axes.z];
  const t = zeros(12, 12);
  for (let block = 0; block < 4; block++) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) t[3 * block + a][3 * block + b] = r[a][b];
    }
  }
  return t;
}

function invalid(member: Member3D, message: string): never {
  throw new SolverError('INVALID_MODEL', message, { memberId: member.id });
}

function positive(value: number | undefined): value is number {
  return value !== undefined && value > 0 && Number.isFinite(value);
}

/** Checks the section properties, throwing `INVALID_MODEL` on the first problem. */
function validateMember(member: Member3D): void {
  const id = member.id;
  if (member.type !== 'beam' && member.type !== 'truss') {
    invalid(member, `Member "${id}" has an unknown type "${String(member.type)}".`);
  }
  if (!positive(member.E)) invalid(member, `Member "${id}" needs a positive Young's modulus E.`);
  if (!positive(member.A)) invalid(member, `Member "${id}" needs a positive area A.`);
  if (member.density !== undefined && !(member.density >= 0 && Number.isFinite(member.density))) {
    invalid(member, `Member "${id}" has an invalid density.`);
  }
  if (member.type === 'truss') return;
  if (!positive(member.G)) invalid(member, `Beam "${id}" needs a positive shear modulus G.`);
  if (!positive(member.Iy)) {
    invalid(member, `Beam "${id}" needs a positive second moment of area Iy.`);
  }
  if (!positive(member.Iz)) {
    invalid(member, `Beam "${id}" needs a positive second moment of area Iz.`);
  }
  if (!positive(member.J)) invalid(member, `Beam "${id}" needs a positive torsion constant J.`);
  if (member.beta !== undefined && !Number.isFinite(member.beta)) {
    invalid(member, `Beam "${id}" has an invalid roll angle beta.`);
  }
}

/**
 * Builds the stiffness matrix and equivalent nodal load vector of one line member in GLOBAL
 * axes, plus the local data needed by `lineResult`.
 *
 *  - `xi`, `xj`: coordinates of nodes i and j.
 *  - `loads`: the member loads that name this member (positions measured from node i).
 *  - `gravity`: summed self-weight vector g; a member with a `density` receives the uniform
 *    global load density · A · g per unit length.
 *
 * A beam returns 12 × 12 / 12 values in the DOF order [ux, uy, uz, rx, ry, rz]_i then _j; a
 * truss returns 6 × 6 / 6 values in [ux, uy, uz]_i then _j (`beta`, `G`, `Iy`, `Iz`, `J` and
 * the releases are ignored for trusses). End releases are applied in local axes by static
 * condensation. Throws `SolverError('INVALID_MODEL')` for bad geometry, properties or load
 * positions, and `SolverError('UNSTABLE')` if the releases make the loaded member a mechanism.
 */
export function lineElement(
  member: Member3D,
  xi: Vec3,
  xj: Vec3,
  loads: MemberLoad3D[],
  gravity: Vec3,
): LineElement {
  validateMember(member);
  const isTruss = member.type === 'truss';
  if (![...xi, ...xj].every(Number.isFinite)) {
    invalid(member, `Member "${member.id}" has invalid node coordinates.`);
  }
  const d = sub(xj, xi);
  if (!(Math.hypot(d[0], d[1], d[2]) > 1e-9)) {
    invalid(member, `Member "${member.id}" has zero length.`);
  }
  const { L, x, y, z } = memberAxes(xi, xj, isTruss ? 0 : (member.beta ?? 0));
  const axes: LineAxes = { x, y, z };
  const warnings: string[] = [];

  const local = resolveLineLoads(loads, axes, L, member.id);
  if (member.density !== undefined && member.density > 0) {
    // Self-weight: density · A · g per unit length of member, resolved into local axes.
    const q = member.density * member.A;
    const w: Vec3 = [q * dot(x, gravity), q * dot(y, gravity), q * dot(z, gravity)];
    if (!w.every(Number.isFinite)) invalid(member, 'The self-weight vector is invalid.');
    if (w.some((value) => value !== 0)) local.distributed.push({ a: 0, b: L, w1: w, w2: w });
  }
  if (isTruss) {
    // A pin-ended bar spins freely about its own axis: a torque about local x has nothing to
    // act on. Like the 2D solver does for moments at all-pinned joints, drop it and say so.
    let scale = 0;
    for (const m of local.moments) scale = Math.max(scale, Math.hypot(m.m[0], m.m[1], m.m[2]));
    let dropped = false;
    for (const m of local.moments) {
      if (Math.abs(m.m[0]) > 1e-12 * scale) dropped = true;
      m.m[0] = 0;
    }
    if (dropped) {
      warnings.push(
        `A moment on truss member "${member.id}" has a component about the member's own ` +
          'axis, which a pin-ended bar cannot resist. That component was ignored.',
      );
    }
  }

  const ea = member.E * member.A;
  const kLocal = isTruss
    ? localStiffness3D(L, ea, 0, 0, 0)
    : localStiffness3D(
        L,
        ea,
        (member.G as number) * (member.J as number),
        member.E * (member.Iy as number),
        member.E * (member.Iz as number),
      );
  const fLocal = equivalentLineLoads(local, L, member.type);
  const releasedList = isTruss ? [] : releasedDofs3D(member.releaseI, member.releaseJ);
  condenseReleases(kLocal, fLocal, releasedList, L, member.id);
  const released = new Array<boolean>(12).fill(false);
  for (const r of releasedList) released[r] = true;

  const T = transformation(axes);
  const kGlobal = matMul(matMul(transpose(T), kLocal), T);
  const fGlobal = matVec(transpose(T), fLocal);
  const common = { member, L, axes, kLocal, fLocal, loads: local, released, warnings };
  if (!isTruss) {
    return { nodes: [member.i, member.j], dofsPerNode: 6, k: kGlobal, f: fGlobal, ...common };
  }
  // Truss: keep the translations only (the rotational rows and columns are zero).
  const keep = [0, 1, 2, 6, 7, 8];
  return {
    nodes: [member.i, member.j],
    dofsPerNode: 3,
    k: keep.map((r) => keep.map((c) => kGlobal[r][c])),
    f: keep.map((r) => fGlobal[r]),
    ...common,
  };
}

interface Section {
  x: number;
  side: -1 | 1;
}

/** Section positions along a member: equal divisions plus load discontinuities. */
function sectionPositions(L: number, segments: number, loads: LocalLineLoads): Section[] {
  const tol = 1e-9 * L;
  const { kinks, jumps } = lineBreakpoints(loads);
  const xs: number[] = [];
  for (let i = 0; i <= segments; i++) xs.push((L * i) / segments);
  for (const k of kinks) xs.push(k);
  for (const j of jumps) xs.push(j);
  xs.sort((a, b) => a - b);

  const sections: Section[] = [];
  let last = -Infinity;
  for (const x of xs) {
    if (x - last <= tol) continue;
    last = x;
    const interior = x > tol && x < L - tol;
    const jump = interior ? jumps.find((j) => Math.abs(j - x) <= tol) : undefined;
    if (jump !== undefined) {
      // Snap to the exact load position so the left/right limits bracket the jump.
      sections.push({ x: jump, side: -1 }, { x: jump, side: 1 });
    } else {
      sections.push({ x: x <= tol ? 0 : x >= L - tol ? L : x, side: x <= tol ? 1 : -1 });
    }
  }
  return sections;
}

/**
 * Roots t in (0, 1) of the parabola through (0, v0), (½, vm), (1, v1). Between two load
 * discontinuities the shear is at most quadratic, so this locates its zeros exactly.
 */
function parabolaRoots(v0: number, vm: number, v1: number): number[] {
  const a = 2 * v0 - 4 * vm + 2 * v1;
  const b = -3 * v0 + 4 * vm - v1;
  const scale = Math.max(Math.abs(v0), Math.abs(vm), Math.abs(v1));
  const roots: number[] = [];
  if (Math.abs(a) <= 1e-9 * scale) {
    if (b !== 0) roots.push(-v0 / b);
  } else {
    const disc = b * b - 4 * a * v0;
    if (disc > 0) {
      // Numerically stable form of the quadratic formula.
      const q = -(b + (b >= 0 ? 1 : -1) * Math.sqrt(disc)) / 2;
      roots.push(q / a, v0 / q);
    }
  }
  return roots.filter((t) => t > 1e-9 && t < 1 - 1e-9);
}

/**
 * Adds sections at the points of zero shear in either bending plane, so that the extremes
 * of Mz and My are captured exactly.
 */
function addZeroShearSections(
  base: Section[],
  L: number,
  endForces: number[],
  at: (x: number, side: -1 | 1) => SectionForces,
): Section[] {
  // Shears below this are rounding noise, not a genuine sign change.
  let scale = 0;
  endForces.forEach((value, i) => {
    scale = Math.max(scale, Math.abs(value) / (i % 6 >= 3 ? L : 1));
  });
  for (const s of base) {
    const f = at(s.x, s.side);
    scale = Math.max(scale, Math.abs(f.Vy), Math.abs(f.Vz));
  }
  const noise = 1e-10 * scale;

  const sections: Section[] = [];
  for (let k = 0; k < base.length; k++) {
    sections.push(base[k]);
    const next = base[k + 1];
    if (!next || next.x - base[k].x <= 1e-9 * L) continue;
    const x0 = base[k].x;
    const h = next.x - x0;
    const f0 = at(x0, 1);
    const fm = at(x0 + h / 2, -1);
    const f1 = at(next.x, -1);
    const roots: number[] = [];
    for (const pick of [(f: SectionForces) => f.Vy, (f: SectionForces) => f.Vz]) {
      const v0 = pick(f0);
      const vm = pick(fm);
      const v1 = pick(f1);
      if (Math.max(Math.abs(v0), Math.abs(vm), Math.abs(v1)) <= noise) continue;
      roots.push(...parabolaRoots(v0, vm, v1));
    }
    roots.sort((a, b) => a - b);
    let last = -Infinity;
    for (const t of roots) {
      if (t - last <= 1e-9) continue;
      last = t;
      sections.push({ x: x0 + t * h, side: -1 });
    }
  }
  return sections;
}

/**
 * Constants of the deflected shape v(x) = c0 + c1·x + d(x) in one bending plane, where d is
 * the twice-integrated curvature with d(0) = d′(0) = 0. The two constants come from the end
 * conditions that are NOT released: the two end translations when both are available (as in
 * the 2D solver), otherwise a translation and the slope of an end whose moment is not
 * released. `dL`, `sL` are d(L) and d′(L); `slopeI`, `slopeJ` the joint slopes dv/dx.
 */
function bendingConstants(
  L: number,
  dL: number,
  sL: number,
  end: { vi: number; vj: number; slopeI: number; slopeJ: number },
  rel: { vi: boolean; vj: boolean; slopeI: boolean; slopeJ: boolean },
): [number, number] {
  const chord = (end.vj - end.vi - dL) / L;
  if (!rel.vi && !rel.vj) return [end.vi, chord];
  const c1 = !rel.slopeI ? end.slopeI : !rel.slopeJ ? end.slopeJ - sL : chord;
  if (rel.vi && !rel.vj) return [end.vj - c1 * L - dL, c1];
  // Translation released at j only, or at both ends (the member floats: keep joint i).
  return [end.vi, c1];
}

function extreme(stations: Station3D[], pick: (s: Station3D) => number, sign: 1 | -1): Extreme3D {
  let best = stations[0];
  for (const s of stations) if (sign * pick(s) > sign * pick(best)) best = s;
  return { value: pick(best), x: best.x };
}

function absExtreme(stations: Station3D[], pick: (s: Station3D) => number): Extreme3D {
  let best = stations[0];
  for (const s of stations) if (Math.abs(pick(s)) > Math.abs(pick(best))) best = s;
  return { value: pick(best), x: best.x };
}

/**
 * Recovers end forces, internal-force diagrams and the deflected shape of one member.
 *
 *  - `u`: element displacements in GLOBAL axes in element DOF order — beam
 *    [ux, uy, uz, rx, ry, rz]_i then _j (12 values); truss [ux, uy, uz]_i then _j (6 values).
 *  - `segments`: number of equal divisions for the diagrams. Extra stations are added at
 *    every load discontinuity (two stations, left and right limit, at concentrated loads)
 *    and at the points of zero shear in each bending plane.
 *
 * `endForces` are the 12 local values k·u − f (forces exerted by the joints on the member;
 * released components are exactly zero, and a truss reports zeros for its moments). Station
 * values follow the sign conventions of `Station3D`. Deflections come from exact integration
 * of N/EA, T/GJ, Mz/EIz and My/EIy and are the member's own, so at a released end they may
 * differ from the joint's. A truss reports the straight chord between its displaced ends for
 * v and w, and zero twist.
 */
export function lineResult(el: LineElement, u: number[], segments: number): MemberResult3D {
  const { member, L, axes, kLocal, fLocal, loads, released } = el;
  const isTruss = member.type === 'truss';
  if (u.length !== el.k.length) {
    throw new SolverError(
      'INVALID_MODEL',
      `Member "${member.id}" expects ${el.k.length} displacements but received ${u.length}.`,
      { memberId: member.id },
    );
  }

  // Global → local, one 3-vector at a time (a truss has no rotations).
  const uLocal = new Array<number>(12).fill(0);
  const r = [axes.x, axes.y, axes.z];
  const perNode = el.dofsPerNode;
  for (let node = 0; node < 2; node++) {
    for (let block = 0; block < perNode / 3; block++) {
      const g = perNode * node + 3 * block;
      const vec: Vec3 = [u[g], u[g + 1], u[g + 2]];
      for (let a = 0; a < 3; a++) uLocal[6 * node + 3 * block + a] = dot(r[a], vec);
    }
  }
  const endForces = matVec(kLocal, uLocal).map((v, i) => v - fLocal[i]);
  const at = (x: number, side: -1 | 1) => internalForces(x, side, endForces, loads);

  const count = Math.max(1, Math.round(segments) || 1);
  const sections = addZeroShearSections(sectionPositions(L, count, loads), L, endForces, at);

  // Integrate N/EA and T/GJ once and the curvatures Mz/EIz, My/EIy twice between sections.
  // The integrands are polynomials of degree <= 4 there, so 3-point Gauss is exact.
  const ea = member.E * member.A;
  const gj = isTruss ? 0 : (member.G as number) * (member.J as number);
  const eiz = isTruss ? 0 : member.E * (member.Iz as number);
  const eiy = isTruss ? 0 : member.E * (member.Iy as number);
  const axial = [0];
  const twist = [0];
  const slopeY = [0];
  const deflY = [0];
  const slopeZ = [0];
  const deflZ = [0];
  for (let k = 1; k < sections.length; k++) {
    const x0 = sections[k - 1].x;
    const x1 = sections[k].x;
    const half = (x1 - x0) / 2;
    let iN = 0;
    let iT = 0;
    let iMz = 0;
    let iMy = 0;
    let iMzArm = 0;
    let iMyArm = 0;
    if (half > 0) {
      for (const [xi, weight] of GAUSS_3) {
        const x = x0 + half * (1 + xi);
        const f = at(x, -1);
        const w = weight * half;
        iN += w * f.N;
        iT += w * f.T;
        iMz += w * f.Mz;
        iMy += w * f.My;
        iMzArm += w * (x1 - x) * f.Mz;
        iMyArm += w * (x1 - x) * f.My;
      }
    }
    axial.push(axial[k - 1] + iN / ea);
    if (isTruss) continue;
    twist.push(twist[k - 1] + iT / gj);
    deflY.push(deflY[k - 1] + slopeY[k - 1] * (x1 - x0) + iMzArm / eiz);
    slopeY.push(slopeY[k - 1] + iMz / eiz);
    deflZ.push(deflZ[k - 1] + slopeZ[k - 1] * (x1 - x0) + iMyArm / eiy);
    slopeZ.push(slopeZ[k - 1] + iMy / eiy);
  }
  const last = sections.length - 1;

  // Axial displacement and twist: start from a joint the member is actually attached to in
  // that mode (an end whose fx / mx is not released) and integrate from there.
  const anchor = (index: number, integral: number[]): number =>
    released[index] && !released[index + 6] ? uLocal[index + 6] - integral[last] : uLocal[index];
  const u0 = anchor(0, axial);
  const twist0 = isTruss ? 0 : anchor(3, twist);

  // Transverse deflections: v with θz = +dv/dx, w with θy = −dw/dx.
  const [cy0, cy1] = isTruss
    ? [uLocal[1], (uLocal[7] - uLocal[1]) / L]
    : bendingConstants(
        L,
        deflY[last],
        slopeY[last],
        { vi: uLocal[1], vj: uLocal[7], slopeI: uLocal[5], slopeJ: uLocal[11] },
        { vi: released[1], vj: released[7], slopeI: released[5], slopeJ: released[11] },
      );
  const [cz0, cz1] = isTruss
    ? [uLocal[2], (uLocal[8] - uLocal[2]) / L]
    : bendingConstants(
        L,
        deflZ[last],
        slopeZ[last],
        { vi: uLocal[2], vj: uLocal[8], slopeI: -uLocal[4], slopeJ: -uLocal[10] },
        { vi: released[2], vj: released[8], slopeI: released[4], slopeJ: released[10] },
      );

  const stations: Station3D[] = sections.map((s, k) => {
    const f = at(s.x, s.side);
    return {
      x: s.x,
      N: f.N,
      Vy: f.Vy,
      Vz: f.Vz,
      T: f.T,
      My: f.My,
      Mz: f.Mz,
      u: u0 + axial[k],
      v: cy0 + cy1 * s.x + (isTruss ? 0 : deflY[k]),
      w: cz0 + cz1 * s.x + (isTruss ? 0 : deflZ[k]),
      twist: isTruss ? 0 : twist0 + twist[k],
    };
  });

  // Transverse deflection relative to the chord joining the member's displaced ends.
  const first = stations[0];
  const end = stations[last];
  const sag = (s: Station3D) =>
    Math.hypot(
      s.v - (first.v + ((end.v - first.v) * s.x) / L),
      s.w - (first.w + ((end.w - first.w) * s.x) / L),
    );

  return {
    id: member.id,
    length: L,
    axes: { x: [...axes.x], y: [...axes.y], z: [...axes.z] },
    endForces,
    stations,
    maxAxial: extreme(stations, (s) => s.N, 1),
    minAxial: extreme(stations, (s) => s.N, -1),
    maxAbsVy: absExtreme(stations, (s) => s.Vy),
    maxAbsVz: absExtreme(stations, (s) => s.Vz),
    maxAbsTorsion: absExtreme(stations, (s) => s.T),
    maxAbsMy: absExtreme(stations, (s) => s.My),
    maxAbsMz: absExtreme(stations, (s) => s.Mz),
    maxAbsDeflection: absExtreme(stations, sag),
  };
}
