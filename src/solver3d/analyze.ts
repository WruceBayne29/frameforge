/**
 * Linear elastic analysis of 3D structures (space trusses and frames, flat-shell plates and
 * hexahedral solids sharing the same nodes) by the direct stiffness method.
 *
 * The assembler knows nothing about element formulations: every element module hands it a
 * stiffness matrix and an equivalent nodal load vector in global axes (see `contract.ts`),
 * and gets its own displacement vector back for result recovery.
 */
import { SolverError } from '../solver/errors';
import type { ElementMatrices } from './contract';
import type { LineElement } from './line';
import { lineElement, lineResult } from './line';
import type { PlateElement } from './plate';
import { plateElement, plateResult } from './plate';
import type { SolidElement } from './solid';
import { solidElement, solidResult } from './solid';
import { adjacencyFromConnectivity, rcmOrder, SkylineMatrix } from './sparse';
import type {
  AnalysisOptions3D,
  AnalysisResult3D,
  Dof6,
  MemberLoad3D,
  MemberResult3D,
  NodeDisplacement3D,
  PlateLoad3D,
  PlateResult3D,
  Reaction3D,
  SolidFaceLoad3D,
  SolidResult3D,
  StructureModel3D,
  Vec3,
} from './types';

const DOFS: readonly Dof6[] = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
const NODAL_KEYS = ['fx', 'fy', 'fz', 'mx', 'my', 'mz'] as const;
const AXIS_NAMES = ['X', 'Y', 'Z'] as const;
const GLOBAL_DIRECTIONS = ['globalX', 'globalY', 'globalZ'] as const;

/** A DOF without stiffness: its diagonal is below this fraction of the largest of its kind. */
const INACTIVE_TOLERANCE = 1e-12;
/** A held mechanism counts as "not excited" when its holding force is below this fraction. */
const RESIDUAL_TOLERANCE = 1e-6;

function invalid(message: string, where: { nodeId?: string; memberId?: string } = {}): never {
  throw new SolverError('INVALID_MODEL', message, where);
}

/** "translation along X" / "rotation about Z" for a DOF index 0–5. */
function dofText(d: number): string {
  return d < 3 ? `translation along ${AXIS_NAMES[d]}` : `rotation about ${AXIS_NAMES[d - 3]}`;
}

function unstable(nodeId: string, d: number): SolverError {
  return new SolverError(
    'UNSTABLE',
    `The structure is unstable: a mechanism was detected at node "${nodeId}" ` +
      `(${dofText(d)}). Check that the supports prevent rigid-body motion in all three ` +
      'directions (including spinning about a line of supports) and that member end ' +
      'releases or pin-ended truss members do not form a mechanism.',
    { nodeId },
  );
}

function allFinite(values: (number | undefined)[]): boolean {
  return values.every((v) => v === undefined || Number.isFinite(v));
}

/** Checks one family of elements: unique ids, existing nodes, no node used twice. */
function validateElements(
  kind: 'Member' | 'Plate' | 'Solid',
  elements: { id: string; nodes: string[] }[],
  nodeIds: Set<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) {
    const where = { memberId: el.id };
    if (ids.has(el.id)) invalid(`Duplicate ${kind.toLowerCase()} id "${el.id}".`, where);
    ids.add(el.id);
    if (!el.nodes.every((id) => nodeIds.has(id))) {
      invalid(`${kind} "${el.id}" refers to a node that does not exist.`, where);
    }
    if (new Set(el.nodes).size !== el.nodes.length) {
      invalid(
        kind === 'Member'
          ? `Member "${el.id}" starts and ends at the same node.`
          : `${kind} "${el.id}" uses the same node more than once.`,
        where,
      );
    }
  }
  return ids;
}

/**
 * Validates the model, throwing a descriptive `SolverError` on the first problem found.
 * Element properties and geometry are checked later by the element modules, which report
 * the element id in `memberId`.
 */
export function validateModel3d(model: StructureModel3D): void {
  const members = model.members ?? [];
  const plates = model.plates ?? [];
  const solids = model.solids ?? [];
  if (model.nodes.length === 0) invalid('The model has no nodes.');
  if (members.length + plates.length + solids.length === 0) {
    invalid('The model has no elements (members, plates or solids).');
  }

  const nodeIds = new Set<string>();
  for (const n of model.nodes) {
    if (nodeIds.has(n.id)) invalid(`Duplicate node id "${n.id}".`, { nodeId: n.id });
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) {
      invalid(`Node "${n.id}" has invalid coordinates.`, { nodeId: n.id });
    }
    nodeIds.add(n.id);
  }

  const memberIds = validateElements(
    'Member',
    members.map((m) => ({ id: m.id, nodes: [m.i, m.j] })),
    nodeIds,
  );
  const plateIds = validateElements('Plate', plates, nodeIds);
  const solidIds = validateElements('Solid', solids, nodeIds);

  let anyRestraint = false;
  for (const s of model.supports) {
    const where = { nodeId: s.node };
    if (!nodeIds.has(s.node)) invalid(`A support refers to missing node "${s.node}".`);
    for (const dof of DOFS) {
      const k = s.spring?.[dof];
      if (k !== undefined && !(k >= 0 && Number.isFinite(k))) {
        invalid(`The ${dof} spring at node "${s.node}" needs a stiffness of zero or more.`, where);
      }
      if (!allFinite([s.settlement?.[dof]])) {
        invalid(`The ${dof} settlement at node "${s.node}" is not a valid number.`, where);
      }
      if (s[dof] || (k ?? 0) > 0) anyRestraint = true;
    }
  }
  if (!anyRestraint) {
    throw new SolverError(
      'UNSTABLE',
      'The structure has no supports. Add at least one support so it cannot move freely.',
    );
  }

  for (const load of model.loads) {
    switch (load.kind) {
      case 'nodal':
        if (!nodeIds.has(load.node)) invalid(`A load refers to missing node "${load.node}".`);
        if (!allFinite(NODAL_KEYS.map((key) => load[key]))) {
          invalid(`A load at node "${load.node}" is not a valid number.`, { nodeId: load.node });
        }
        break;
      case 'distributed':
      case 'point':
      case 'moment':
        if (!memberIds.has(load.member)) {
          invalid(`A load refers to missing member "${load.member}".`);
        }
        break;
      case 'pressure':
      case 'platePoint':
        if (!plateIds.has(load.plate)) invalid(`A load refers to missing plate "${load.plate}".`);
        break;
      case 'face':
        if (!solidIds.has(load.solid)) invalid(`A load refers to missing solid "${load.solid}".`);
        break;
      case 'selfWeight':
        if (!GLOBAL_DIRECTIONS.includes(load.direction) || !Number.isFinite(load.factor)) {
          invalid('A self-weight load needs a global direction and a finite factor.');
        }
        break;
      default:
        invalid(`Unknown load kind "${String((load as { kind?: unknown }).kind)}".`);
    }
  }
}

/** One element of any family with the global DOF index of each of its DOFs. */
interface Placed<T extends ElementMatrices> {
  el: T;
  dofs: number[];
}

function groupBy<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/** Element displacement vector picked from the global one. */
function pick(u: Float64Array, dofs: number[]): number[] {
  return dofs.map((d) => u[d]);
}

/**
 * Linear elastic analysis of a 3D structure. Throws `SolverError` for invalid models
 * (`INVALID_MODEL`) and for structures that cannot carry their loads (`UNSTABLE`).
 *
 * Degrees of freedom without any stiffness (rotations at joints of trusses or solids, nodes
 * without elements) are left out of the equations. A mechanism that the loading does not
 * excite — for example a beam on two pins that is free to spin about its own axis — is held
 * automatically and reported in `warnings`; one that the loading does push on is an error.
 */
export function analyze3d(
  model: StructureModel3D,
  options: AnalysisOptions3D = {},
): AnalysisResult3D {
  validateModel3d(model);
  const segments = Math.max(2, Math.round(options.segments ?? 20));
  const nodes = model.nodes;
  const n = nodes.length;
  const ndof = 6 * n;
  const nodeIndex = new Map(nodes.map((node, idx) => [node.id, idx]));
  const position = (id: string): Vec3 => {
    const node = nodes[nodeIndex.get(id) as number];
    return [node.x, node.y, node.z];
  };
  const warnings: string[] = [];

  // ---- Loads -----------------------------------------------------------------------------
  const nodal = new Float64Array(ndof);
  const gravity: Vec3 = [0, 0, 0];
  const memberLoads = new Map<string, MemberLoad3D[]>();
  const plateLoads = new Map<string, PlateLoad3D[]>();
  const solidLoads = new Map<string, SolidFaceLoad3D[]>();
  for (const load of model.loads) {
    if (load.kind === 'nodal') {
      const base = 6 * (nodeIndex.get(load.node) as number);
      NODAL_KEYS.forEach((key, d) => {
        nodal[base + d] += load[key] ?? 0;
      });
    } else if (load.kind === 'selfWeight') {
      gravity[GLOBAL_DIRECTIONS.indexOf(load.direction)] += load.factor;
    } else if (load.kind === 'pressure' || load.kind === 'platePoint') {
      groupBy(plateLoads, load.plate, load);
    } else if (load.kind === 'face') {
      groupBy(solidLoads, load.solid, load);
    } else {
      groupBy(memberLoads, load.member, load);
    }
  }

  // ---- Elements --------------------------------------------------------------------------
  const lines: Placed<LineElement>[] = [];
  const plates: Placed<PlateElement>[] = [];
  const solids: Placed<SolidElement>[] = [];
  const all: Placed<ElementMatrices>[] = [];
  const connectivity: number[][] = [];
  const connected = new Array<boolean>(n).fill(false);
  /** Accumulated diagonal of the global stiffness, and the element equivalent loads. */
  const diagonal = new Float64Array(ndof);
  const equivalent = new Float64Array(ndof);

  const place = <T extends ElementMatrices>(el: T, into: Placed<T>[]): void => {
    const indices = el.nodes.map((id) => nodeIndex.get(id) as number);
    const dofs: number[] = [];
    for (const idx of indices) {
      connected[idx] = true;
      for (let d = 0; d < el.dofsPerNode; d++) dofs.push(6 * idx + d);
    }
    dofs.forEach((dof, a) => {
      diagonal[dof] += el.k[a][a];
      equivalent[dof] += el.f[a];
    });
    if (el.warnings) warnings.push(...el.warnings);
    connectivity.push(indices);
    into.push({ el, dofs });
    all.push({ el, dofs });
  };

  for (const member of model.members ?? []) {
    const loads = memberLoads.get(member.id) ?? [];
    place(lineElement(member, position(member.i), position(member.j), loads, gravity), lines);
  }
  for (const plate of model.plates ?? []) {
    const coords = plate.nodes.map(position);
    place(plateElement(plate, coords, plateLoads.get(plate.id) ?? [], gravity), plates);
  }
  for (const solid of model.solids ?? []) {
    const coords = solid.nodes.map(position);
    place(solidElement(solid, coords, solidLoads.get(solid.id) ?? [], gravity), solids);
  }

  // ---- Supports --------------------------------------------------------------------------
  const restrained = new Array<boolean>(ndof).fill(false);
  const prescribed = new Float64Array(ndof);
  const springs = new Float64Array(ndof);
  for (const s of model.supports) {
    const base = 6 * (nodeIndex.get(s.node) as number);
    DOFS.forEach((dof, d) => {
      if (s[dof]) {
        restrained[base + d] = true;
        const settlement = s.settlement?.[dof];
        if (settlement !== undefined) prescribed[base + d] = settlement;
      }
    });
  }
  for (const s of model.supports) {
    const base = 6 * (nodeIndex.get(s.node) as number);
    DOFS.forEach((dof, d) => {
      const k = s.spring?.[dof] ?? 0;
      if (k > 0 && !restrained[base + d]) {
        springs[base + d] += k;
        diagonal[base + d] += k;
      }
    });
  }

  // ---- Inactive DOFs: no stiffness from any element or spring, and not restrained ---------
  let loadScale = 0;
  for (let i = 0; i < ndof; i++)
    loadScale = Math.max(loadScale, Math.abs(nodal[i] + equivalent[i]));
  const largest = [0, 0];
  for (let i = 0; i < ndof; i++) {
    const kind = i % 6 < 3 ? 0 : 1;
    largest[kind] = Math.max(largest[kind], Math.abs(diagonal[i]));
  }
  const inactive = new Array<boolean>(ndof).fill(false);
  nodes.forEach((node, idx) => {
    const ignored: number[] = [];
    for (let d = 0; d < 6; d++) {
      const dof = 6 * idx + d;
      if (restrained[dof]) continue;
      if (Math.abs(diagonal[dof]) > INACTIVE_TOLERANCE * largest[d < 3 ? 0 : 1]) continue;
      inactive[dof] = true;
      if (connected[idx] && d < 3) {
        // Nothing at all resists this translation (e.g. a bar loaded across its axis).
        if (Math.abs(nodal[dof] + equivalent[dof]) > 1e-9 * loadScale) throw unstable(node.id, d);
      } else if (nodal[dof] !== 0) {
        ignored.push(d);
        nodal[dof] = 0;
      }
    }
    if (!connected[idx]) {
      warnings.push(`Node "${node.id}" is not connected to any element and was ignored.`);
      if (ignored.length > 0) {
        warnings.push(`The load applied at unconnected node "${node.id}" was ignored.`);
      }
    } else if (ignored.length > 0) {
      const about = ignored.map((d) => `${AXIS_NAMES[d - 3]} (${DOFS[d]})`).join(', ');
      warnings.push(
        `A moment about ${about} is applied at node "${node.id}", but no element there can ` +
          'resist it (only truss members, solids or released member ends meet at the node). ' +
          'It was ignored.',
      );
    }
  });

  // ---- Equation numbering: free active DOFs, node by node in reverse Cuthill–McKee order ---
  const order = rcmOrder(adjacencyFromConnectivity(n, connectivity));
  const equation = new Int32Array(ndof).fill(-1);
  const dofOfEquation: number[] = [];
  for (const idx of order) {
    for (let d = 0; d < 6; d++) {
      const dof = 6 * idx + d;
      if (restrained[dof] || inactive[dof]) continue;
      equation[dof] = dofOfEquation.length;
      dofOfEquation.push(dof);
    }
  }
  const neq = dofOfEquation.length;

  // ---- Assemble K_ff and the right-hand side F_f − K_fr·u_r, then solve --------------------
  const u = Float64Array.from(prescribed);
  let held: number[] = [];
  if (neq > 0) {
    const K = SkylineMatrix.fromConnectivity(
      neq,
      all.map(({ dofs }) => dofs.map((dof) => equation[dof]).filter((e) => e >= 0)),
    );
    const rhs = new Float64Array(neq);
    for (let e = 0; e < neq; e++) rhs[e] = nodal[dofOfEquation[e]] + equivalent[dofOfEquation[e]];
    for (const { el, dofs } of all) {
      const size = dofs.length;
      const settled = dofs.some((dof) => prescribed[dof] !== 0);
      for (let a = 0; a < size; a++) {
        const ea = equation[dofs[a]];
        if (ea < 0) continue;
        const row = el.k[a];
        for (let b = a; b < size; b++) {
          const eb = equation[dofs[b]];
          if (eb >= 0) K.add(ea, eb, row[b]);
        }
        if (settled) {
          let sum = 0;
          for (let b = 0; b < size; b++) sum += row[b] * prescribed[dofs[b]];
          rhs[ea] -= sum;
        }
      }
    }
    for (let e = 0; e < neq; e++) {
      const k = springs[dofOfEquation[e]];
      if (k > 0) K.add(e, e, k);
    }

    held = K.factor({ onSingular: 'restrain' }).singular;
    const solution = K.solve(rhs);
    for (let e = 0; e < neq; e++) {
      if (!Number.isFinite(solution[e])) {
        throw new SolverError(
          'UNSTABLE',
          'The structure is unstable: the solution did not converge.',
        );
      }
      u[dofOfEquation[e]] = solution[e];
    }
  }

  // ---- Nodal forces the elements need, r = Σ (k_e·u_e − f_e), and the reactions ------------
  const internal = new Float64Array(ndof);
  for (const { el, dofs } of all) {
    const ue = pick(u, dofs);
    dofs.forEach((dof, a) => {
      const row = el.k[a];
      let sum = -el.f[a];
      for (let b = 0; b < ue.length; b++) sum += row[b] * ue[b];
      internal[dof] += sum;
    });
  }

  const reactions: Record<string, Reaction3D> = {};
  let reactionScale = 0;
  for (const s of model.supports) {
    if (reactions[s.node]) continue;
    const base = 6 * (nodeIndex.get(s.node) as number);
    const r = [0, 0, 0, 0, 0, 0];
    for (let d = 0; d < 6; d++) {
      const dof = base + d;
      if (restrained[dof]) r[d] = internal[dof] - nodal[dof];
      else if (springs[dof] > 0) r[d] = -springs[dof] * u[dof];
      reactionScale = Math.max(reactionScale, Math.abs(r[d]));
    }
    reactions[s.node] = { fx: r[0], fy: r[1], fz: r[2], mx: r[3], my: r[4], mz: r[5] };
  }

  // ---- Mechanisms: equations the factorisation had to hold ---------------------------------
  // The force needed to hold each one tells whether the loading pushes on the mechanism.
  const scale = loadScale > 0 ? loadScale : reactionScale;
  for (const e of [...held].sort((a, b) => dofOfEquation[a] - dofOfEquation[b])) {
    const dof = dofOfEquation[e];
    const d = dof % 6;
    const node = nodes[(dof - d) / 6];
    const residual = internal[dof] - nodal[dof];
    if (!(Math.abs(residual) <= RESIDUAL_TOLERANCE * scale)) throw unstable(node.id, d);
    const motion = d < 3 ? `move along ${AXIS_NAMES[d]}` : `rotate about ${AXIS_NAMES[d - 3]}`;
    warnings.push(
      `Node "${node.id}" is free to ${motion} (${DOFS[d]}) without resistance; it was held ` +
        'automatically. Check supports or member releases.',
    );
  }

  // ---- Results ------------------------------------------------------------------------------
  const displacements: Record<string, NodeDisplacement3D> = {};
  const equilibrium: AnalysisResult3D['equilibrium'] = [0, 0, 0, 0, 0, 0];
  const appliedLoad: Vec3 = [0, 0, 0];
  let maxDisplacement = 0;
  nodes.forEach((node, idx) => {
    const base = 6 * idx;
    displacements[node.id] = {
      ux: u[base],
      uy: u[base + 1],
      uz: u[base + 2],
      rx: u[base + 3],
      ry: u[base + 4],
      rz: u[base + 5],
    };
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(u[base], u[base + 1], u[base + 2]));

    const applied = [0, 0, 0, 0, 0, 0];
    for (let d = 0; d < 6; d++) applied[d] = nodal[base + d] + equivalent[base + d];
    for (let d = 0; d < 3; d++) appliedLoad[d] += applied[d];
    const r = reactions[node.id];
    const fx = applied[0] + (r?.fx ?? 0);
    const fy = applied[1] + (r?.fy ?? 0);
    const fz = applied[2] + (r?.fz ?? 0);
    equilibrium[0] += fx;
    equilibrium[1] += fy;
    equilibrium[2] += fz;
    equilibrium[3] += applied[3] + (r?.mx ?? 0) + node.y * fz - node.z * fy;
    equilibrium[4] += applied[4] + (r?.my ?? 0) + node.z * fx - node.x * fz;
    equilibrium[5] += applied[5] + (r?.mz ?? 0) + node.x * fy - node.y * fx;
  });

  const memberResults: Record<string, MemberResult3D> = {};
  for (const { el, dofs } of lines) {
    const result = lineResult(el, pick(u, dofs), segments);
    memberResults[el.member.id] = result;
    for (const s of result.stations) {
      maxDisplacement = Math.max(maxDisplacement, Math.hypot(s.u, s.v, s.w));
    }
  }
  const plateResults: Record<string, PlateResult3D> = {};
  for (const { el, dofs } of plates) plateResults[el.plate.id] = plateResult(el, pick(u, dofs));
  const solidResults: Record<string, SolidResult3D> = {};
  for (const { el, dofs } of solids) solidResults[el.solid.id] = solidResult(el, pick(u, dofs));

  return {
    displacements,
    reactions,
    members: memberResults,
    plates: plateResults,
    solids: solidResults,
    maxDisplacement,
    equilibrium,
    appliedLoad,
    warnings,
    dofCount: neq,
  };
}
