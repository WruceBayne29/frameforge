/**
 * Modal analysis of 3D structures: the lowest natural frequencies and mode shapes from
 * K·φ = ω²·M·φ with consistent element mass matrices (beams, trusses, plates, solids) plus
 * lumped nodal masses. The stiffness is factorised once (skyline LDLᵀ) and the eigenpairs are
 * found by subspace iteration, so models with thousands of equations stay fast.
 */
import { SolverError } from '../solver/errors';
import { assembleStiffness, pickDofs, prepareSystem } from './analyze';
import { lineMass, lineShape } from './line';
import { plateMass } from './plate';
import { solidMass } from './solid';
import { subspaceIteration } from './eigen';
import { SkylineMatrix } from './sparse';
import type { Member3D, NodeDisplacement3D, StructureModel3D } from './types';

export interface ModeStation3D {
  /** Distance from node i. */
  x: number;
  /** Displacements in the member's local axes. */
  u: number;
  v: number;
  w: number;
}

export interface Mode3D {
  /** Circular frequency ω, rad/s. */
  omega: number;
  /** Natural frequency, Hz. */
  frequency: number;
  /** Period, s. */
  period: number;
  /**
   * Nodal mode shape, scaled so the largest translation is 1 (a mode without translation,
   * such as pure torsion, so that its largest rotation times the model size is 1).
   */
  displacements: Record<string, NodeDisplacement3D>;
  /** Shape along every original member (local axes), joined across its sub-elements. */
  members: Record<string, ModeStation3D[]>;
  /**
   * Effective modal mass fractions along global X, Y and Z: (φᵀ·M·r)² / (φᵀ·M·φ · Σm), with r
   * the unit rigid-body translation. They add up to 1 over all modes of an unrestrained model.
   */
  massFraction: [number, number, number];
}

export interface ModalResult3D {
  modes: Mode3D[];
  /** Total translational mass (elements + nodal masses). */
  totalMass: number;
  /** Number of dynamic degrees of freedom (free, active equations). */
  dofCount: number;
  warnings: string[];
}

export interface ModalOptions3D {
  /** Number of elements each beam member is divided into (default 1). */
  subdivide?: number;
}

const SEPARATOR = '#';

/**
 * Splits every beam member into `parts` equal elements; truss members are left alone (a
 * pin-ended bar cannot be subdivided without creating a mechanism). Intermediate nodes are
 * named `member#k`; end releases stay on the first and last element. Loads are dropped (modal
 * analysis does not use them).
 */
export function refineModel3D(model: StructureModel3D, parts: number): StructureModel3D {
  const n = Math.max(1, Math.round(parts));
  if (n === 1) return { ...model, loads: [] };
  const nodes = model.nodes.slice();
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const members: Member3D[] = [];
  for (const m of model.members ?? []) {
    const a = byId.get(m.i);
    const b = byId.get(m.j);
    if (m.type === 'truss' || !a || !b) {
      members.push(m);
      continue;
    }
    for (let k = 0; k < n; k++) {
      const start = k === 0 ? m.i : `${m.id}${SEPARATOR}${k}`;
      const end = k === n - 1 ? m.j : `${m.id}${SEPARATOR}${k + 1}`;
      if (k < n - 1) {
        const t = (k + 1) / n;
        nodes.push({
          id: end,
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        });
      }
      const part: Member3D = { ...m, id: `${m.id}${SEPARATOR}${k}`, i: start, j: end };
      if (k > 0) delete part.releaseI;
      if (k < n - 1) delete part.releaseJ;
      members.push(part);
    }
  }
  return { ...model, nodes, members, loads: [] };
}

/**
 * Lowest `count` natural frequencies and mode shapes. Elements need a mass density (`mass`)
 * or nodes a lumped mass; loads are ignored; supports, springs, releases and `restrainAll`
 * are respected. Throws `SolverError` for an invalid model, a model without mass, or an
 * unstable one (a mechanism has no natural frequency).
 */
export function modalAnalysis3d(
  original: StructureModel3D,
  count = 6,
  options: ModalOptions3D = {},
): ModalResult3D {
  const parts = Math.max(1, Math.round(options.subdivide ?? 1));
  const model = refineModel3D(original, parts);
  const sys = prepareSystem(model);
  const { nodes, nodeIndex, equation, dofOfEquation, neq, all, ndof } = sys;
  const warnings = [...sys.warnings];

  // ---- Mass: elements + nodal masses, on the stiffness profile ---------------------------
  const M = SkylineMatrix.fromConnectivity(
    neq,
    all.map(({ dofs }) => dofs.map((dof) => equation[dof]).filter((e) => e >= 0)),
  );
  const mDiagonal = new Float64Array(neq);
  let totalMass = 0;
  const scatter = (m: number[][], dofs: number[]) => {
    for (let a = 0; a < dofs.length; a++) {
      const ea = equation[dofs[a]];
      if (ea < 0) continue;
      mDiagonal[ea] += m[a][a];
      for (let b = a; b < dofs.length; b++) {
        const eb = equation[dofs[b]];
        if (eb >= 0 && m[a][b] !== 0) M.add(ea, eb, m[a][b]);
      }
    }
  };
  /** Rigid-body translational mass of an element matrix: Σ over one direction of M_ab. */
  const translational = (m: number[][], perNode: number) => {
    let sum = 0;
    for (let a = 0; a < m.length; a += perNode) {
      for (let b = 0; b < m.length; b += perNode) sum += m[a][b];
    }
    return sum;
  };
  for (const { el, dofs } of sys.lines) {
    const m = lineMass(el);
    totalMass += translational(m, el.dofsPerNode);
    scatter(m, dofs);
  }
  for (const { el, dofs } of sys.plates) {
    const m = plateMass(el);
    totalMass += translational(m, 6);
    scatter(m, dofs);
  }
  for (const { el, dofs } of sys.solids) {
    const m = solidMass(el, el.nodes.map(sys.position));
    totalMass += translational(m, 3);
    scatter(m, dofs);
  }
  for (const lumped of model.masses ?? []) {
    const idx = nodeIndex.get(lumped.node);
    if (idx === undefined) {
      throw new SolverError('INVALID_MODEL', `A mass refers to missing node "${lumped.node}".`);
    }
    if (!(lumped.mass >= 0) || !Number.isFinite(lumped.mass)) {
      throw new SolverError('INVALID_MODEL', `The mass at node "${lumped.node}" is invalid.`, {
        nodeId: lumped.node,
      });
    }
    totalMass += lumped.mass;
    for (let d = 0; d < 3; d++) {
      const e = equation[6 * idx + d];
      if (e < 0) continue;
      M.add(e, e, lumped.mass);
      mDiagonal[e] += lumped.mass;
    }
  }
  if (!(totalMass > 0)) {
    throw new SolverError(
      'INVALID_MODEL',
      'The model has no mass: give the materials a density or add nodal masses.',
    );
  }
  if (neq === 0) return { modes: [], totalMass, dofCount: 0, warnings };

  // ---- Stiffness, factorised once ---------------------------------------------------------
  const K = assembleStiffness(sys);
  const kDiagonal = new Float64Array(neq);
  for (let e = 0; e < neq; e++) kDiagonal[e] = K.diagonal(e);
  // An unfactorised copy for the Rayleigh–Ritz projection.
  const Kplain = K.clone();
  const held = K.factor({ onSingular: 'restrain' }).singular;
  const heldSet = new Set(held);
  // Held equations are taken out of the eigenproblem (no mass, no stiffness).
  const multiplyM = (x: Float64Array) => {
    const y = M.multiply(x);
    for (const e of heldSet) y[e] = 0;
    return y;
  };
  const multiplyK = (x: Float64Array) => {
    const y = Kplain.multiply(x);
    for (const e of heldSet) y[e] = 0;
    return y;
  };
  for (const e of held) {
    const dof = dofOfEquation[e];
    const node = nodes[Math.floor(dof / 6)];
    // A free mass on a mechanism has a zero frequency: the structure is unstable.
    if (mDiagonal[e] > 1e-12 * totalMass && dof % 6 < 3) {
      throw new SolverError(
        'UNSTABLE',
        `The structure is unstable (a mechanism at node "${node.id}"), so it has no natural ` +
          'frequencies. Check the supports and releases.',
        { nodeId: node.id },
      );
    }
    warnings.push(
      `Node "${node.id}" is free to move without resistance in one direction; that freedom ` +
        'was held for the modal analysis.',
    );
  }
  for (const e of heldSet) mDiagonal[e] = 0;
  const dofCount = neq - held.length;
  // Model size, for scaling rotation-only modes.
  let size = 0;
  for (const a of nodes) {
    for (const b of [nodes[0]]) size = Math.max(size, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  }
  size = Math.max(size, 1e-9);

  const eig = subspaceIteration(K, multiplyK, multiplyM, kDiagonal, mDiagonal, count);
  // A mode with (practically) zero frequency means the structure can move as a mechanism
  // that round-off kept the factorisation from detecting (e.g. a plate mesh free to spin in
  // its own plane, which its drilling stiffness does not resist).
  const ratios: number[] = [];
  for (let e = 0; e < neq; e++) if (mDiagonal[e] > 0) ratios.push(kDiagonal[e] / mDiagonal[e]);
  ratios.sort((a, b) => a - b);
  const reference = ratios[Math.floor(ratios.length / 2)] ?? 0;
  if (eig.values.length > 0 && eig.values[0] < 1e-9 * reference) {
    throw new SolverError(
      'UNSTABLE',
      'The structure has a zero-frequency mode: it can move as a mechanism (for example a ' +
        'slab free to slide or spin in its own plane). Add supports that stop rigid-body ' +
        'motion in every direction.',
    );
  }
  if (!eig.converged) {
    warnings.push(
      `The eigenvalue iteration stopped after ${eig.iterations} iterations before reaching ` +
        'full accuracy; the higher frequencies may be approximate.',
    );
  }

  // Rigid-body translation vectors r_d (1 on every translation along d) times M.
  const rigid = [0, 1, 2].map((d) => {
    const r = new Float64Array(neq);
    for (let e = 0; e < neq; e++) if (dofOfEquation[e] % 6 === d) r[e] = 1;
    return M.multiply(r);
  });

  const modes: Mode3D[] = eig.values.map((lambda, k) => {
    const phi = eig.vectors[k];
    const omega = Math.sqrt(Math.max(lambda, 0));
    // φ is M-orthonormal: participation Γ_d = φᵀ·M·r_d, effective mass Γ_d².
    const massFraction = rigid.map((mr) => {
      let g = 0;
      for (let e = 0; e < neq; e++) g += phi[e] * mr[e];
      return (g * g) / totalMass;
    }) as [number, number, number];

    const full = new Float64Array(ndof);
    for (let e = 0; e < neq; e++) full[dofOfEquation[e]] = phi[e];
    // Scale so the largest translation is +1. A mode with (almost) no translation, such as
    // pure torsion, is scaled by its largest rotation times the model size instead, so its
    // round-off translations are not blown up.
    let peak = 0;
    let peakRotation = 0;
    for (let i = 0; i < ndof; i++) {
      if (i % 6 < 3) {
        if (Math.abs(full[i]) > Math.abs(peak)) peak = full[i];
      } else if (Math.abs(full[i]) > Math.abs(peakRotation)) peakRotation = full[i];
    }
    const rotational = Math.abs(peak) <= 1e-6 * Math.abs(peakRotation) * size;
    const scale = rotational ? 1 / (peakRotation * size) : peak !== 0 ? 1 / peak : 1;
    for (let i = 0; i < ndof; i++) full[i] *= scale;

    const displacements: Record<string, NodeDisplacement3D> = {};
    for (const node of original.nodes) {
      const b = 6 * (nodeIndex.get(node.id) as number);
      displacements[node.id] = {
        ux: full[b],
        uy: full[b + 1],
        uz: full[b + 2],
        rx: full[b + 3],
        ry: full[b + 4],
        rz: full[b + 5],
      };
    }
    // Shape along each original member, joined across its sub-elements.
    const members: Record<string, ModeStation3D[]> = {};
    for (const { el, dofs } of sys.lines) {
      const id = el.member.id;
      const hash = id.lastIndexOf(SEPARATOR);
      const refined = parts > 1 && el.member.type === 'beam' && hash > 0;
      const owner = refined ? id.slice(0, hash) : id;
      const index = refined ? Number(id.slice(hash + 1)) : 0;
      const shape = lineShape(
        el,
        pickDofs(full, dofs),
        refined ? Math.max(3, Math.ceil(12 / parts)) : 12,
      );
      const list = (members[owner] ??= []);
      for (const s of index === 0 ? shape : shape.slice(1)) {
        list.push({ x: s.x + index * el.L, u: s.u, v: s.v, w: s.w });
      }
    }
    return {
      omega,
      frequency: omega / (2 * Math.PI),
      period: omega > 0 ? (2 * Math.PI) / omega : Infinity,
      displacements,
      members,
      massFraction,
    };
  });
  return { modes, totalMass, dofCount, warnings };
}
