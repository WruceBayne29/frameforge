import {
  condense,
  elementGeometry,
  localStiffness,
  releasedDofs,
  toGlobal,
  transformation,
} from './element';
import type { ElementGeometry } from './element';
import { SolverError } from './errors';
import type { Matrix, Vector } from './linalg';
import { cholesky, choleskySolve, gauss3, matVec, transpose, zeros } from './linalg';
import type { LocalMemberLoads } from './memberLoads';
import {
  equivalentNodalLoads,
  internalForcesAt,
  loadBreakpoints,
  resolveMemberLoads,
} from './memberLoads';
import type {
  AnalysisOptions,
  AnalysisResult,
  Extreme,
  MemberLoad,
  MemberResult,
  NodeDisplacement,
  Reaction,
  SolverMember,
  Station,
  StructureModel,
} from './types';

const DOF_NAMES = ['horizontal translation', 'vertical translation', 'rotation'] as const;

/** Per-member data produced during assembly and reused for force recovery. */
export interface AssembledElement {
  member: SolverMember;
  geometry: ElementGeometry;
  /** Global DOF indices of the six element DOFs. */
  dofs: number[];
  /** Condensed local stiffness. */
  kLocal: Matrix;
  /** Condensed local equivalent nodal load vector. */
  fLocal: Vector;
  T: Matrix;
  loads: LocalMemberLoads;
}

export interface AssembledSystem {
  /** Global stiffness matrix (springs included), size 3·nodes. */
  K: Matrix;
  /** Global load vector (nodal loads + equivalent member loads). */
  F: Vector;
  elements: AssembledElement[];
  nodeIndex: Map<string, number>;
  /** DOFs fixed by supports. */
  restrained: boolean[];
  /** Prescribed displacement of every DOF (zero unless a settlement is given). */
  prescribed: Vector;
  /** DOFs with no stiffness that are removed from the system (e.g. rotations at truss joints). */
  inactive: boolean[];
  /** Spring stiffness added to each DOF. */
  springs: Vector;
  warnings: string[];
}

function invalid(message: string, where: { nodeId?: string; memberId?: string } = {}): never {
  throw new SolverError('INVALID_MODEL', message, where);
}

/** Validates the model, throwing a descriptive `SolverError` on the first problem found. */
export function validateModel(model: StructureModel): void {
  if (model.nodes.length === 0) invalid('The model has no nodes.');
  if (model.members.length === 0) invalid('The model has no members.');

  const nodeIds = new Set<string>();
  for (const n of model.nodes) {
    if (nodeIds.has(n.id)) invalid(`Duplicate node id "${n.id}".`, { nodeId: n.id });
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      invalid(`Node "${n.id}" has invalid coordinates.`, { nodeId: n.id });
    }
    nodeIds.add(n.id);
  }

  const memberIds = new Set<string>();
  for (const m of model.members) {
    const where = { memberId: m.id };
    if (memberIds.has(m.id)) invalid(`Duplicate member id "${m.id}".`, where);
    memberIds.add(m.id);
    if (!nodeIds.has(m.i) || !nodeIds.has(m.j)) {
      invalid(`Member "${m.id}" refers to a node that does not exist.`, where);
    }
    if (m.i === m.j) invalid(`Member "${m.id}" starts and ends at the same node.`, where);
    if (!(m.E > 0) || !Number.isFinite(m.E)) {
      invalid(`Member "${m.id}" needs a positive Young's modulus E.`, where);
    }
    if (!(m.A > 0) || !Number.isFinite(m.A)) {
      invalid(`Member "${m.id}" needs a positive area A.`, where);
    }
    if (m.type === 'frame' && (!(m.I > 0) || !Number.isFinite(m.I))) {
      invalid(`Frame member "${m.id}" needs a positive second moment of area I.`, where);
    }
  }

  let anyRestraint = false;
  for (const s of model.supports) {
    if (!nodeIds.has(s.node)) invalid(`A support refers to missing node "${s.node}".`);
    if (s.ux || s.uy || s.rz) anyRestraint = true;
    const sp = s.spring;
    if (sp && ((sp.kx ?? 0) > 0 || (sp.ky ?? 0) > 0 || (sp.kr ?? 0) > 0)) anyRestraint = true;
  }
  if (!anyRestraint) {
    throw new SolverError(
      'UNSTABLE',
      'The structure has no supports. Add at least one support so it cannot move freely.',
    );
  }

  for (const load of model.loads) {
    if (load.kind === 'nodal') {
      if (!nodeIds.has(load.node)) invalid(`A load refers to missing node "${load.node}".`);
    } else if (!memberIds.has(load.member)) {
      invalid(`A load refers to missing member "${load.member}".`);
    }
  }
}

/** Builds the global stiffness matrix and load vector. */
export function assemble(model: StructureModel): AssembledSystem {
  validateModel(model);
  const n = model.nodes.length;
  const ndof = 3 * n;
  const nodeIndex = new Map(model.nodes.map((node, idx) => [node.id, idx]));
  const K = zeros(ndof, ndof);
  const F = new Array<number>(ndof).fill(0);
  const warnings: string[] = [];

  const memberLoads = new Map<string, MemberLoad[]>();
  for (const load of model.loads) {
    if (load.kind === 'nodal') {
      const base = 3 * (nodeIndex.get(load.node) as number);
      F[base] += load.fx ?? 0;
      F[base + 1] += load.fy ?? 0;
      F[base + 2] += load.mz ?? 0;
    } else {
      const list = memberLoads.get(load.member) ?? [];
      list.push(load);
      memberLoads.set(load.member, list);
    }
  }

  const connected = new Array<boolean>(n).fill(false);
  const elements: AssembledElement[] = [];
  for (const member of model.members) {
    const ia = nodeIndex.get(member.i) as number;
    const ib = nodeIndex.get(member.j) as number;
    connected[ia] = true;
    connected[ib] = true;
    const geometry = elementGeometry(member, model.nodes[ia], model.nodes[ib]);
    const loads = resolveMemberLoads(
      memberLoads.get(member.id) ?? [],
      geometry.cos,
      geometry.sin,
      geometry.L,
    );
    const kLocal = localStiffness(member, geometry.L);
    const fLocal = equivalentNodalLoads(loads, geometry.L, member.type);
    condense(kLocal, fLocal, releasedDofs(member));
    const T = transformation(geometry.cos, geometry.sin);
    const kGlobal = toGlobal(kLocal, T);
    const fGlobal = matVec(transpose(T), fLocal);
    const dofs = [3 * ia, 3 * ia + 1, 3 * ia + 2, 3 * ib, 3 * ib + 1, 3 * ib + 2];
    for (let r = 0; r < 6; r++) {
      F[dofs[r]] += fGlobal[r];
      for (let c = 0; c < 6; c++) K[dofs[r]][dofs[c]] += kGlobal[r][c];
    }
    elements.push({ member, geometry, dofs, kLocal, fLocal, T, loads });
  }

  const restrained = new Array<boolean>(ndof).fill(false);
  const prescribed = new Array<number>(ndof).fill(0);
  const springs = new Array<number>(ndof).fill(0);
  for (const s of model.supports) {
    const base = 3 * (nodeIndex.get(s.node) as number);
    const flags = [s.ux, s.uy, s.rz];
    const settle = [s.settlement?.ux, s.settlement?.uy, s.settlement?.rz];
    const spring = [s.spring?.kx, s.spring?.ky, s.spring?.kr];
    for (let d = 0; d < 3; d++) {
      if (flags[d]) {
        restrained[base + d] = true;
        prescribed[base + d] = settle[d] ?? 0;
      } else if ((spring[d] ?? 0) > 0) {
        springs[base + d] += spring[d] as number;
        K[base + d][base + d] += spring[d] as number;
      }
    }
  }

  // DOFs without any stiffness are removed from the system: all DOFs of unconnected nodes,
  // and rotations of joints where every connected member is pin-ended.
  let maxDiag = 0;
  for (let i = 0; i < ndof; i++) maxDiag = Math.max(maxDiag, Math.abs(K[i][i]));
  const inactive = new Array<boolean>(ndof).fill(false);
  model.nodes.forEach((node, idx) => {
    if (!connected[idx]) {
      warnings.push(`Node "${node.id}" is not connected to any member and was ignored.`);
      for (let d = 0; d < 3; d++) if (!restrained[3 * idx + d]) inactive[3 * idx + d] = true;
      return;
    }
    const rot = 3 * idx + 2;
    if (!restrained[rot] && Math.abs(K[rot][rot]) <= 1e-12 * maxDiag) {
      inactive[rot] = true;
      if (Math.abs(F[rot]) > 0) {
        warnings.push(
          `A moment is applied at node "${node.id}", but no member there can resist it ` +
            '(all connected members are pin-ended). It was ignored.',
        );
      }
    }
  });

  return { K, F, elements, nodeIndex, restrained, prescribed, inactive, springs, warnings };
}

/** Solves K_ff·u_f = F_f − K_fr·u_r and returns the full displacement vector. */
export function solveDisplacements(system: AssembledSystem, model: StructureModel): Vector {
  const { K, F, restrained, prescribed, inactive } = system;
  const ndof = F.length;
  const free: number[] = [];
  for (let i = 0; i < ndof; i++) if (!restrained[i] && !inactive[i]) free.push(i);

  const u = prescribed.slice();
  if (free.length === 0) return u;

  const settled: number[] = [];
  for (let i = 0; i < ndof; i++) if (restrained[i] && prescribed[i] !== 0) settled.push(i);

  const Kff = zeros(free.length, free.length);
  const rhs = new Array<number>(free.length).fill(0);
  for (let a = 0; a < free.length; a++) {
    const row = K[free[a]];
    for (let b = 0; b < free.length; b++) Kff[a][b] = row[free[b]];
    let value = F[free[a]];
    for (const r of settled) value -= row[r] * prescribed[r];
    rhs[a] = value;
  }

  const factor = cholesky(Kff);
  if (!factor.ok) {
    const dof = free[factor.pivotIndex];
    const node = model.nodes[Math.floor(dof / 3)];
    throw new SolverError(
      'UNSTABLE',
      `The structure is unstable: a mechanism was detected at node "${node.id}" ` +
        `(${DOF_NAMES[dof % 3]}). Check that the supports prevent rigid-body motion and that ` +
        'member end releases or pin-ended truss members do not form a mechanism.',
      { nodeId: node.id },
    );
  }
  const uf = choleskySolve(factor.L, rhs);
  for (let a = 0; a < free.length; a++) u[free[a]] = uf[a];
  if (uf.some((v) => !Number.isFinite(v))) {
    throw new SolverError('UNSTABLE', 'The structure is unstable: the solution did not converge.');
  }
  return u;
}

interface Section {
  x: number;
  side: -1 | 1;
}

/** Section positions along a member: equal divisions plus load discontinuities. */
function sectionPositions(L: number, segments: number, loads: LocalMemberLoads): Section[] {
  const tol = 1e-9 * L;
  const { kinks, jumps } = loadBreakpoints(loads);
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
    const isJump = interior && jumps.some((j) => Math.abs(j - x) <= tol);
    if (isJump) {
      // Snap to the exact load position so the left/right limits bracket the jump.
      const exact = jumps.find((j) => Math.abs(j - x) <= tol) as number;
      sections.push({ x: exact, side: -1 }, { x: exact, side: 1 });
    } else {
      sections.push({ x: x <= tol ? 0 : x >= L - tol ? L : x, side: x <= tol ? 1 : -1 });
    }
  }
  return sections;
}

function extreme(stations: Station[], pick: (s: Station) => number, sign: 1 | -1): Extreme {
  let best = stations[0];
  for (const s of stations) if (sign * pick(s) > sign * pick(best)) best = s;
  return { value: pick(best), x: best.x };
}

function absExtreme(stations: Station[], pick: (s: Station) => number): Extreme {
  let best = stations[0];
  for (const s of stations) if (Math.abs(pick(s)) > Math.abs(pick(best))) best = s;
  return { value: pick(best), x: best.x };
}

/** Recovers end forces, internal-force diagrams and the deflected shape of one member. */
export function memberResult(el: AssembledElement, u: Vector, segments: number): MemberResult {
  const { member, geometry, kLocal, fLocal, T, loads } = el;
  const { L } = geometry;
  const uLocal = matVec(
    T,
    el.dofs.map((d) => u[d]),
  );
  const ku = matVec(kLocal, uLocal);
  const endForces = ku.map((v, i) => v - fLocal[i]);
  const at = (x: number, side: -1 | 1) => internalForcesAt(x, side, endForces, loads);

  // Sections, refined with points of zero shear so that moment extremes are captured.
  const base = sectionPositions(L, segments, loads);
  const sections: Section[] = [];
  for (let k = 0; k < base.length; k++) {
    sections.push(base[k]);
    const next = base[k + 1];
    if (!next || next.x - base[k].x <= 1e-9 * L) continue;
    const va = at(base[k].x, 1).V;
    const vb = at(next.x, -1).V;
    if (va * vb < 0) {
      let lo = base[k].x;
      let hi = next.x;
      for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        if (at(mid, -1).V * va > 0) lo = mid;
        else hi = mid;
      }
      sections.push({ x: (lo + hi) / 2, side: -1 });
    }
  }

  // Deflected shape: integrate N/EA once and M/EI twice between sections (exact for the
  // polynomial load types supported), then enforce the end displacement v(L) = v_j.
  const ea = member.E * member.A;
  const ei = member.E * member.I;
  const axial: number[] = [uLocal[0]];
  const slope: number[] = [0];
  const defl: number[] = [0];
  for (let k = 1; k < sections.length; k++) {
    const x0 = sections[k - 1].x;
    const x1 = sections[k].x;
    if (x1 - x0 <= 0) {
      axial.push(axial[k - 1]);
      slope.push(slope[k - 1]);
      defl.push(defl[k - 1]);
      continue;
    }
    const inside = (x: number) => at(x, -1);
    axial.push(axial[k - 1] + gauss3((x) => inside(x).N, x0, x1) / ea);
    if (ei > 0) {
      slope.push(slope[k - 1] + gauss3((x) => inside(x).M, x0, x1) / ei);
      defl.push(
        defl[k - 1] + slope[k - 1] * (x1 - x0) + gauss3((x) => (x1 - x) * inside(x).M, x0, x1) / ei,
      );
    } else {
      slope.push(0);
      defl.push(0);
    }
  }
  const theta0 = (uLocal[4] - uLocal[1] - defl[defl.length - 1]) / L;

  const stations: Station[] = sections.map((s, k) => {
    const f = at(s.x, s.side);
    return {
      x: s.x,
      N: f.N,
      V: f.V,
      M: f.M,
      u: axial[k],
      v: uLocal[1] + theta0 * s.x + defl[k],
    };
  });

  // Deflection relative to the chord joining the displaced ends.
  const chord = (s: Station) => s.v - (uLocal[1] + ((uLocal[4] - uLocal[1]) * s.x) / L);
  const worst = absExtreme(stations, chord);
  const first = stations[0];
  const lastStation = stations[stations.length - 1];

  return {
    id: member.id,
    length: L,
    cos: geometry.cos,
    sin: geometry.sin,
    endForces: endForces as MemberResult['endForces'],
    start: { N: first.N, V: first.V, M: first.M },
    end: { N: lastStation.N, V: lastStation.V, M: lastStation.M },
    stations,
    maxMoment: extreme(stations, (s) => s.M, 1),
    minMoment: extreme(stations, (s) => s.M, -1),
    maxAbsMoment: absExtreme(stations, (s) => s.M),
    maxAbsShear: absExtreme(stations, (s) => s.V),
    maxAxial: extreme(stations, (s) => s.N, 1),
    minAxial: extreme(stations, (s) => s.N, -1),
    maxAbsDeflection: worst,
  };
}

/**
 * Linear elastic analysis of a 2D frame/truss by the direct stiffness method.
 * Throws `SolverError` for invalid models and unstable structures.
 */
export function analyze(model: StructureModel, options: AnalysisOptions = {}): AnalysisResult {
  const segments = Math.max(2, Math.round(options.segments ?? 20));
  const system = assemble(model);
  const u = solveDisplacements(system, model);
  const { K, F, restrained, springs, nodeIndex } = system;

  const displacements: Record<string, NodeDisplacement> = {};
  let maxDisplacement = 0;
  model.nodes.forEach((node, idx) => {
    const d = { ux: u[3 * idx], uy: u[3 * idx + 1], rz: u[3 * idx + 2] };
    displacements[node.id] = d;
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(d.ux, d.uy));
  });

  // Reactions: R = K·u − F at restrained DOFs; −k·u at spring DOFs.
  const reactions: Record<string, Reaction> = {};
  const equilibrium: [number, number, number] = [0, 0, 0];
  const Ku = matVec(K, u);
  for (const support of model.supports) {
    const idx = nodeIndex.get(support.node) as number;
    const r = [0, 0, 0];
    for (let d = 0; d < 3; d++) {
      const dof = 3 * idx + d;
      if (restrained[dof]) r[d] = Ku[dof] - F[dof];
      else if (springs[dof] > 0) r[d] = -springs[dof] * u[dof];
    }
    const prev = reactions[support.node];
    reactions[support.node] = prev
      ? { fx: prev.fx + r[0], fy: prev.fy + r[1], mz: prev.mz + r[2] }
      : { fx: r[0], fy: r[1], mz: r[2] };
  }
  model.nodes.forEach((node, idx) => {
    const r = reactions[node.id];
    const fx = F[3 * idx] + (r?.fx ?? 0);
    const fy = F[3 * idx + 1] + (r?.fy ?? 0);
    const mz = F[3 * idx + 2] + (r?.mz ?? 0);
    equilibrium[0] += fx;
    equilibrium[1] += fy;
    equilibrium[2] += mz + node.x * fy - node.y * fx;
  });

  const members: Record<string, MemberResult> = {};
  for (const el of system.elements) {
    const result = memberResult(el, u, segments);
    members[el.member.id] = result;
    for (const s of result.stations) {
      maxDisplacement = Math.max(maxDisplacement, Math.hypot(s.u, s.v));
    }
  }

  return {
    displacements,
    reactions,
    members,
    maxDisplacement,
    equilibrium,
    warnings: system.warnings,
    dofCount: F.length,
  };
}
