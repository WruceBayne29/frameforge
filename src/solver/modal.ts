/**
 * Modal analysis: natural frequencies and mode shapes from the generalised eigenproblem
 * K·φ = ω²·M·φ, using consistent element mass matrices.
 */
import { assemble } from './analyze';
import type { AssembledElement } from './analyze';
import { localStiffness, releasedDofs } from './element';
import { SolverError } from './errors';
import type { Matrix, Vector } from './linalg';
import { cholesky, matMul, matVec, transpose, zeros } from './linalg';
import type { NodeDisplacement, StructureModel } from './types';

export interface Mode {
  /** Circular frequency ω, rad/s. */
  omega: number;
  /** Natural frequency, Hz. */
  frequency: number;
  /** Period, s. */
  period: number;
  /** Nodal mode shape, scaled so the largest translation is 1. */
  displacements: Record<string, NodeDisplacement>;
  /** Shape along each member in local axes (u along the member, v transverse). */
  members: Record<string, Array<{ x: number; u: number; v: number }>>;
}

export interface ModalResult {
  modes: Mode[];
  /** Total translational mass of the structure. */
  totalMass: number;
  /** Number of dynamic degrees of freedom. */
  dofCount: number;
}

/**
 * Consistent mass matrix of a member in local axes. Frame members use the Hermite cubic
 * (ρAL/420) matrix for transverse motion; truss members use linear shape functions for both
 * directions. End releases are handled by Guyan reduction with the same transformation that
 * static condensation applies to the stiffness matrix.
 */
export function localMass(el: AssembledElement): Matrix {
  const { member, geometry } = el;
  const L = geometry.L;
  const m = (member.massPerLength ?? 0) * L;
  const M = zeros(6, 6);
  M[0][0] = M[3][3] = m / 3;
  M[0][3] = M[3][0] = m / 6;
  if (member.type === 'truss') {
    M[1][1] = M[4][4] = m / 3;
    M[1][4] = M[4][1] = m / 6;
    return M;
  }
  const c = m / 420;
  const entries: Array<[number, number, number]> = [
    [1, 1, 156],
    [1, 2, 22 * L],
    [1, 4, 54],
    [1, 5, -13 * L],
    [2, 2, 4 * L * L],
    [2, 4, 13 * L],
    [2, 5, -3 * L * L],
    [4, 4, 156],
    [4, 5, -22 * L],
    [5, 5, 4 * L * L],
  ];
  for (const [i, j, v] of entries) {
    M[i][j] = c * v;
    M[j][i] = c * v;
  }
  const released = releasedDofs(member);
  if (released.length === 0) return M;

  // Γ expresses all six DOFs in terms of the retained ones: released rotations follow from
  // u_r = −k_rr⁻¹·k_rk·u_k (no moment at a hinge). Condense one release at a time.
  const k = localStiffness(member, L);
  const gamma = zeros(6, 6);
  for (let i = 0; i < 6; i++) gamma[i][i] = 1;
  for (const r of released) {
    const krr = k[r][r];
    const row = k[r].map((v, j) => (j === r ? 0 : -v / krr));
    // Substitute u_r in the stiffness (for the next release) and in Γ.
    for (let i = 0; i < 6; i++) {
      if (i === r) continue;
      const kir = k[i][r];
      for (let j = 0; j < 6; j++) k[i][j] += kir * row[j];
      k[i][r] = 0;
    }
    for (let j = 0; j < 6; j++) k[r][j] = 0;
    for (let i = 0; i < 6; i++) {
      const gir = gamma[i][r];
      if (gir === 0) continue;
      for (let j = 0; j < 6; j++) gamma[i][j] += gir * row[j];
      gamma[i][r] = 0;
    }
  }
  return matMul(matMul(transpose(gamma), M), gamma);
}

/**
 * Eigenvalues and eigenvectors of a symmetric matrix by the cyclic Jacobi method.
 * Returns eigenvalues in ascending order with the matching eigenvectors as columns.
 */
export function jacobiEigen(input: Matrix): { values: Vector; vectors: Matrix } {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const v = zeros(n, n);
  for (let i = 0; i < n; i++) v[i][i] = 1;

  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    let diag = 0;
    for (let i = 0; i < n; i++) {
      diag += a[i][i] * a[i][i];
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    }
    if (off <= 1e-26 * (diag + off)) break;
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
  return {
    values: order.map((i) => a[i][i]),
    vectors: v.map((row) => order.map((i) => row[i])),
  };
}

/** Shape of one member for given local end displacements, sampled at `segments` + 1 points. */
function memberShape(el: AssembledElement, uLocal: Vector, segments: number) {
  const L = el.geometry.L;
  const [ui, vi, , uj, vj] = uLocal;
  let ti = uLocal[2];
  let tj = uLocal[5];
  const chord = (vj - vi) / L;
  const member = el.member;
  if (member.type === 'truss' || (member.releaseI && member.releaseJ)) {
    ti = chord;
    tj = chord;
  } else if (member.releaseI) {
    ti = 1.5 * chord - 0.5 * tj;
  } else if (member.releaseJ) {
    tj = 1.5 * chord - 0.5 * ti;
  }
  const out: Array<{ x: number; u: number; v: number }> = [];
  for (let k = 0; k <= segments; k++) {
    const xi = k / segments;
    const xi2 = xi * xi;
    const xi3 = xi2 * xi;
    out.push({
      x: xi * L,
      u: ui + (uj - ui) * xi,
      v:
        (1 - 3 * xi2 + 2 * xi3) * vi +
        L * (xi - 2 * xi2 + xi3) * ti +
        (3 * xi2 - 2 * xi3) * vj +
        L * (-xi2 + xi3) * tj,
    });
  }
  return out;
}

/**
 * Splits every frame member into `parts` equal elements (truss members are left alone: a pin-ended
 * bar cannot be subdivided without creating a mechanism). Finer meshes give accurate higher modes.
 */
export function refineModel(model: StructureModel, parts: number): StructureModel {
  const n = Math.max(1, Math.round(parts));
  if (n === 1) return model;
  const nodes = model.nodes.slice();
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const members: StructureModel['members'] = [];
  for (const m of model.members) {
    const a = byId.get(m.i);
    const b = byId.get(m.j);
    if (m.type === 'truss' || !a || !b) {
      members.push(m);
      continue;
    }
    for (let k = 0; k < n; k++) {
      const start = k === 0 ? m.i : `${m.id}#${k}`;
      const end = k === n - 1 ? m.j : `${m.id}#${k + 1}`;
      if (k < n - 1) {
        const t = (k + 1) / n;
        nodes.push({ id: end, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
      members.push({
        ...m,
        id: `${m.id}#${k}`,
        i: start,
        j: end,
        releaseI: k === 0 ? m.releaseI : false,
        releaseJ: k === n - 1 ? m.releaseJ : false,
      });
    }
  }
  return { ...model, nodes, members };
}

export interface ModalOptions {
  /** Number of elements each frame member is divided into (default 1). */
  subdivide?: number;
}

/**
 * Computes the lowest `count` natural frequencies and mode shapes. Every member needs a
 * positive `massPerLength`. Loads are ignored; supports and releases are respected.
 */
export function modalAnalysis(
  original: StructureModel,
  count = 6,
  options: ModalOptions = {},
): ModalResult {
  for (const m of original.members) {
    if (!((m.massPerLength ?? 0) > 0)) {
      throw new SolverError(
        'INVALID_MODEL',
        `Member "${m.id}" needs a positive mass per unit length for modal analysis.`,
        { memberId: m.id },
      );
    }
  }
  const parts = Math.max(1, Math.round(options.subdivide ?? 1));
  const model = refineModel(original, parts);
  const system = assemble({ ...model, loads: [] });
  const ndof = system.F.length;
  const Mg = zeros(ndof, ndof);
  let totalMass = 0;
  for (const el of system.elements) {
    totalMass += (el.member.massPerLength ?? 0) * el.geometry.L;
    const mGlobal = matMul(matMul(transpose(el.T), localMass(el)), el.T);
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) Mg[el.dofs[r]][el.dofs[c]] += mGlobal[r][c];
    }
  }

  const free: number[] = [];
  for (let i = 0; i < ndof; i++) {
    if (!system.restrained[i] && !system.inactive[i]) free.push(i);
  }
  const n = free.length;
  if (n === 0) return { modes: [], totalMass, dofCount: 0 };
  const K = free.map((i) => free.map((j) => system.K[i][j]));
  const M = free.map((i) => free.map((j) => Mg[i][j]));

  const kFactor = cholesky(K);
  if (!kFactor.ok) {
    const node = model.nodes[Math.floor(free[kFactor.pivotIndex] / 3)];
    throw new SolverError(
      'UNSTABLE',
      `The structure is unstable (mechanism at node "${node.id}"), so it has no natural frequencies.`,
      { nodeId: node.id },
    );
  }
  const mFactor = cholesky(M, 1e-12);
  if (!mFactor.ok) {
    throw new SolverError('INVALID_MODEL', 'The mass matrix is singular; check member masses.');
  }

  // Reduce to a standard symmetric problem: A = L⁻¹·K·L⁻ᵀ with M = L·Lᵀ, then φ = L⁻ᵀ·y.
  const Lm = mFactor.L;
  const forward = (b: Vector): Vector => {
    const y = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      for (let k = 0; k < i; k++) s -= Lm[i][k] * y[k];
      y[i] = s / Lm[i][i];
    }
    return y;
  };
  const backward = (b: Vector): Vector => {
    const x = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let k = i + 1; k < n; k++) s -= Lm[k][i] * x[k];
      x[i] = s / Lm[i][i];
    }
    return x;
  };
  // half = L⁻¹·K (forward substitution on each column); A = half·L⁻ᵀ (on each row).
  const half = transpose(transpose(K).map(forward));
  const A = half.map(forward);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const avg = (A[i][j] + A[j][i]) / 2;
      A[i][j] = avg;
      A[j][i] = avg;
    }
  }
  const eig = jacobiEigen(A);

  const modes: Mode[] = [];
  for (let k = 0; k < Math.min(count, n); k++) {
    const lambda = Math.max(eig.values[k], 0);
    const omega = Math.sqrt(lambda);
    const phi = backward(eig.vectors.map((row) => row[k]));
    const full = new Array<number>(ndof).fill(0);
    free.forEach((dof, i) => (full[dof] = phi[i]));
    // Scale so the largest translation is +1 (sign chosen so the dominant component is positive).
    let peak = 0;
    for (let i = 0; i < ndof; i++) {
      if (i % 3 !== 2 && Math.abs(full[i]) > Math.abs(peak)) peak = full[i];
    }
    const scale = peak !== 0 ? 1 / peak : 1;
    for (let i = 0; i < ndof; i++) full[i] *= scale;

    const displacements: Record<string, NodeDisplacement> = {};
    original.nodes.forEach((node) => {
      const idx = system.nodeIndex.get(node.id) as number;
      displacements[node.id] = { ux: full[3 * idx], uy: full[3 * idx + 1], rz: full[3 * idx + 2] };
    });
    // Join the shapes of the sub-elements back into one curve per original member.
    const members: Mode['members'] = {};
    for (const el of system.elements) {
      const uLocal = matVec(
        el.T,
        el.dofs.map((d) => full[d]),
      );
      const hash = el.member.id.lastIndexOf('#');
      const refined = parts > 1 && el.member.type === 'frame' && hash > 0;
      const id = refined ? el.member.id.slice(0, hash) : el.member.id;
      const index = refined ? Number(el.member.id.slice(hash + 1)) : 0;
      const offset = index * el.geometry.L;
      const shape = memberShape(el, uLocal, refined ? Math.max(3, Math.ceil(12 / parts)) : 12);
      const list = (members[id] ??= []);
      for (const point of index === 0 ? shape : shape.slice(1)) {
        list.push({ x: point.x + offset, u: point.u, v: point.v });
      }
    }
    modes.push({
      omega,
      frequency: omega / (2 * Math.PI),
      period: omega > 0 ? (2 * Math.PI) / omega : Infinity,
      displacements,
      members,
    });
  }
  return { modes, totalMass, dofCount: n };
}
