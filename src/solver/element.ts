import { SolverError } from './errors';
import type { Matrix, Vector } from './linalg';
import { matMul, transpose, zeros } from './linalg';
import type { SolverMember, SolverNode } from './types';

export interface ElementGeometry {
  L: number;
  cos: number;
  sin: number;
}

export function elementGeometry(
  member: SolverMember,
  ni: SolverNode,
  nj: SolverNode,
): ElementGeometry {
  const dx = nj.x - ni.x;
  const dy = nj.y - ni.y;
  const L = Math.hypot(dx, dy);
  if (!(L > 1e-9)) {
    throw new SolverError('INVALID_MODEL', `Member "${member.id}" has zero length.`, {
      memberId: member.id,
    });
  }
  return { L, cos: dx / L, sin: dy / L };
}

/**
 * 6×6 local stiffness matrix for DOFs [u_i, v_i, θ_i, u_j, v_j, θ_j].
 * Truss members only have the axial (EA/L) terms.
 */
export function localStiffness(member: SolverMember, L: number): Matrix {
  const { E, A, I } = member;
  const k = zeros(6, 6);
  const ea = (E * A) / L;
  k[0][0] = ea;
  k[0][3] = -ea;
  k[3][0] = -ea;
  k[3][3] = ea;
  if (member.type === 'truss') return k;

  const ei = E * I;
  const k1 = (12 * ei) / L ** 3;
  const k2 = (6 * ei) / L ** 2;
  const k3 = (4 * ei) / L;
  const k4 = (2 * ei) / L;
  k[1][1] = k1;
  k[1][2] = k2;
  k[1][4] = -k1;
  k[1][5] = k2;
  k[2][1] = k2;
  k[2][2] = k3;
  k[2][4] = -k2;
  k[2][5] = k4;
  k[4][1] = -k1;
  k[4][2] = -k2;
  k[4][4] = k1;
  k[4][5] = -k2;
  k[5][1] = k2;
  k[5][2] = k4;
  k[5][4] = -k2;
  k[5][5] = k3;
  return k;
}

/** Local DOF indices released by the member's end hinges. */
export function releasedDofs(member: SolverMember): number[] {
  if (member.type === 'truss') return [];
  const released: number[] = [];
  if (member.releaseI) released.push(2);
  if (member.releaseJ) released.push(5);
  return released;
}

/**
 * Static condensation of released DOFs, in place. After condensation the released rows and
 * columns of `k` are zero and `f` (the equivalent nodal load vector) is modified so that the
 * retained DOFs see the correct loads: k* = k_kk − k_kr·k_rr⁻¹·k_rk, f* = f_k − k_kr·k_rr⁻¹·f_r.
 */
export function condense(k: Matrix, f: Vector, released: number[]): void {
  const n = k.length;
  for (const r of released) {
    const krr = k[r][r];
    if (Math.abs(krr) < 1e-300) continue;
    const row = k[r].slice();
    const fr = f[r];
    for (let i = 0; i < n; i++) {
      if (i === r) continue;
      const factor = k[i][r] / krr;
      if (factor === 0) continue;
      for (let j = 0; j < n; j++) k[i][j] -= factor * row[j];
      f[i] -= factor * fr;
    }
    for (let i = 0; i < n; i++) {
      k[r][i] = 0;
      k[i][r] = 0;
    }
    f[r] = 0;
  }
}

/** 6×6 transformation matrix T with u_local = T · u_global. */
export function transformation(cos: number, sin: number): Matrix {
  const t = zeros(6, 6);
  for (const o of [0, 3]) {
    t[o][o] = cos;
    t[o][o + 1] = sin;
    t[o + 1][o] = -sin;
    t[o + 1][o + 1] = cos;
    t[o + 2][o + 2] = 1;
  }
  return t;
}

/** k_global = Tᵀ · k_local · T */
export function toGlobal(kLocal: Matrix, T: Matrix): Matrix {
  return matMul(matMul(transpose(T), kLocal), T);
}
