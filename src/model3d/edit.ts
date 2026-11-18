/**
 * Pure editing operations on a 3D project. Every function returns a new project (or the same
 * object when nothing changes) so they compose with undo/redo history.
 */
import { nextId } from './ids';
import type {
  MemberType3D,
  Project3D,
  ProjectLoad3D,
  ProjectMember3D,
  ProjectNode3D,
  ProjectPlate3D,
  ProjectSolid3D,
  Restraints6,
} from './types';
import { DEFAULT_PLATE_THICKNESS, DEFAULT_SECTION_3D } from './types';

/** Default distance (m) below which two points count as the same node. */
export const NODE_TOLERANCE = 1e-6;

/** Distributive Omit so that each member of the load union keeps its own fields. */
export type NewLoad3D = ProjectLoad3D extends infer L
  ? L extends unknown
    ? Omit<L, 'id'>
    : never
  : never;

export type LoadTargetKind = 'nodes' | 'members' | 'plates' | 'solids';

/** What a load acts on: the kind of target and the ids. */
export function loadTargets(load: ProjectLoad3D): { kind: LoadTargetKind; ids: string[] } {
  switch (load.kind) {
    case 'nodal':
      return { kind: 'nodes', ids: load.nodes };
    case 'distributed':
    case 'point':
    case 'moment':
      return { kind: 'members', ids: load.members };
    case 'pressure':
    case 'platePoint':
      return { kind: 'plates', ids: load.plates };
    case 'face':
      return { kind: 'solids', ids: load.solids };
  }
}

/** The same load acting on a different list of targets. */
export function withLoadTargets(load: ProjectLoad3D, ids: string[]): ProjectLoad3D {
  switch (load.kind) {
    case 'nodal':
      return { ...load, nodes: ids };
    case 'distributed':
    case 'point':
    case 'moment':
      return { ...load, members: ids };
    case 'pressure':
    case 'platePoint':
      return { ...load, plates: ids };
    case 'face':
      return { ...load, solids: ids };
  }
}

/**
 * Maps the targets of every load of one kind (dropping `undefined`, removing repeats) and
 * removes loads that end up with no target. Returns the same array when nothing changes.
 */
function remapLoads(
  loads: ProjectLoad3D[],
  kind: LoadTargetKind,
  map: (id: string) => string | undefined,
): ProjectLoad3D[] {
  let changed = false;
  const out: ProjectLoad3D[] = [];
  for (const load of loads) {
    const targets = loadTargets(load);
    if (targets.kind !== kind) {
      out.push(load);
      continue;
    }
    const ids: string[] = [];
    for (const id of targets.ids) {
      const mapped = map(id);
      if (mapped !== undefined && !ids.includes(mapped)) ids.push(mapped);
    }
    const same = ids.length === targets.ids.length && ids.every((id, k) => id === targets.ids[k]);
    if (same) {
      out.push(load);
    } else {
      changed = true;
      if (ids.length > 0) out.push(withLoadTargets(load, ids));
    }
  }
  return changed ? out : loads;
}

const dropFrom = (removed: Set<string>) => (id: string) => (removed.has(id) ? undefined : id);

// ---- Nodes ------------------------------------------------------------------------------

export function findNodeAt3D(
  project: Project3D,
  x: number,
  y: number,
  z: number,
  tol = NODE_TOLERANCE,
): ProjectNode3D | undefined {
  return project.nodes.find(
    (n) => Math.abs(n.x - x) <= tol && Math.abs(n.y - y) <= tol && Math.abs(n.z - z) <= tol,
  );
}

/** Adds a node, or returns the existing node within `tol` of the same position. */
export function addNode(
  project: Project3D,
  x: number,
  y: number,
  z: number,
  tol = NODE_TOLERANCE,
): { project: Project3D; id: string } {
  const existing = findNodeAt3D(project, x, y, z, tol);
  if (existing) return { project, id: existing.id };
  const id = nextId(
    'N',
    project.nodes.map((n) => n.id),
  );
  return { project: { ...project, nodes: [...project.nodes, { id, x, y, z }] }, id };
}

export function moveNode(
  project: Project3D,
  id: string,
  x: number,
  y: number,
  z: number,
): Project3D {
  const node = project.nodes.find((n) => n.id === id);
  if (!node || (node.x === x && node.y === y && node.z === z)) return project;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return project;
  // Refuse to stack a node on top of another one.
  const clash = project.nodes.find(
    (n) =>
      n.id !== id &&
      Math.abs(n.x - x) <= NODE_TOLERANCE &&
      Math.abs(n.y - y) <= NODE_TOLERANCE &&
      Math.abs(n.z - z) <= NODE_TOLERANCE,
  );
  if (clash) return project;
  return { ...project, nodes: project.nodes.map((n) => (n.id === id ? { ...n, x, y, z } : n)) };
}

/** Deletes a node together with its elements, its support and the loads on any of them. */
export function deleteNode(project: Project3D, id: string): Project3D {
  if (!project.nodes.some((n) => n.id === id)) return project;
  const members = new Set(project.members.filter((m) => m.i === id || m.j === id).map((m) => m.id));
  const plates = new Set(project.plates.filter((p) => p.nodes.includes(id)).map((p) => p.id));
  const solids = new Set(project.solids.filter((s) => s.nodes.includes(id)).map((s) => s.id));
  let loads = remapLoads(project.loads, 'nodes', (n) => (n === id ? undefined : n));
  loads = remapLoads(loads, 'members', dropFrom(members));
  loads = remapLoads(loads, 'plates', dropFrom(plates));
  loads = remapLoads(loads, 'solids', dropFrom(solids));
  return {
    ...project,
    nodes: project.nodes.filter((n) => n.id !== id),
    members: project.members.filter((m) => !members.has(m.id)),
    plates: project.plates.filter((p) => !plates.has(p.id)),
    solids: project.solids.filter((s) => !solids.has(s.id)),
    supports: project.supports.filter((s) => s.node !== id),
    loads,
  };
}

// ---- Elements ---------------------------------------------------------------------------

const hasNodes = (project: Project3D, ids: readonly string[]): boolean => {
  const known = new Set(project.nodes.map((n) => n.id));
  return ids.every((id) => known.has(id));
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id));

export interface NewMember3D {
  type?: MemberType3D;
  section?: string;
  material?: string;
  beta?: number;
  releaseI?: ProjectMember3D['releaseI'];
  releaseJ?: ProjectMember3D['releaseJ'];
}

const defaultMaterial = (project: Project3D): string => project.materials[0]?.name ?? 'Steel';

/**
 * Adds a member between two existing nodes. Returns `id: null` when the ends coincide or a
 * node is missing, and the existing member's id when the two nodes are already joined.
 */
export function addMember(
  project: Project3D,
  i: string,
  j: string,
  options: NewMember3D = {},
): { project: Project3D; id: string | null } {
  if (i === j || !hasNodes(project, [i, j])) return { project, id: null };
  const duplicate = project.members.find(
    (m) => (m.i === i && m.j === j) || (m.i === j && m.j === i),
  );
  if (duplicate) return { project, id: duplicate.id };
  const id = nextId(
    'M',
    project.members.map((m) => m.id),
  );
  const member: ProjectMember3D = {
    id,
    i,
    j,
    type: options.type ?? 'beam',
    section: options.section ?? DEFAULT_SECTION_3D,
    material: options.material ?? defaultMaterial(project),
  };
  if (options.beta) member.beta = options.beta;
  if (options.releaseI) member.releaseI = options.releaseI;
  if (options.releaseJ) member.releaseJ = options.releaseJ;
  return { project: { ...project, members: [...project.members, member] }, id };
}

/**
 * Adds a plate on four distinct existing nodes (listed around the perimeter). Returns
 * `id: null` for a degenerate plate and the existing plate's id when one already uses the
 * same four nodes.
 */
export function addPlate(
  project: Project3D,
  nodes: readonly string[],
  options: { thickness?: number; material?: string } = {},
): { project: Project3D; id: string | null } {
  if (nodes.length !== 4 || new Set(nodes).size !== 4 || !hasNodes(project, nodes)) {
    return { project, id: null };
  }
  const duplicate = project.plates.find((p) => sameSet(p.nodes, nodes));
  if (duplicate) return { project, id: duplicate.id };
  const id = nextId(
    'P',
    project.plates.map((p) => p.id),
  );
  const plate: ProjectPlate3D = {
    id,
    nodes: [nodes[0], nodes[1], nodes[2], nodes[3]],
    thickness: options.thickness ?? DEFAULT_PLATE_THICKNESS,
    material: options.material ?? defaultMaterial(project),
  };
  return { project: { ...project, plates: [...project.plates, plate] }, id };
}

/**
 * Adds a solid on eight distinct existing nodes (nodes 1–4 one face, 5–8 the opposite face).
 * Returns `id: null` for a degenerate solid and the existing solid's id for a duplicate.
 */
export function addSolid(
  project: Project3D,
  nodes: readonly string[],
  options: { material?: string } = {},
): { project: Project3D; id: string | null } {
  if (nodes.length !== 8 || new Set(nodes).size !== 8 || !hasNodes(project, nodes)) {
    return { project, id: null };
  }
  const duplicate = project.solids.find((s) => sameSet(s.nodes, nodes));
  if (duplicate) return { project, id: duplicate.id };
  const id = nextId(
    'S',
    project.solids.map((s) => s.id),
  );
  const solid: ProjectSolid3D = {
    id,
    nodes: [nodes[0], nodes[1], nodes[2], nodes[3], nodes[4], nodes[5], nodes[6], nodes[7]],
    material: options.material ?? defaultMaterial(project),
  };
  return { project: { ...project, solids: [...project.solids, solid] }, id };
}

export function updateMember(
  project: Project3D,
  id: string,
  patch: Partial<ProjectMember3D>,
): Project3D {
  return {
    ...project,
    members: project.members.map((m) => (m.id === id ? { ...m, ...patch, id: m.id } : m)),
  };
}

export function updatePlate(
  project: Project3D,
  id: string,
  patch: Partial<ProjectPlate3D>,
): Project3D {
  return {
    ...project,
    plates: project.plates.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p)),
  };
}

export function updateSolid(
  project: Project3D,
  id: string,
  patch: Partial<ProjectSolid3D>,
): Project3D {
  return {
    ...project,
    solids: project.solids.map((s) => (s.id === id ? { ...s, ...patch, id: s.id } : s)),
  };
}

export function deleteMember(project: Project3D, id: string): Project3D {
  if (!project.members.some((m) => m.id === id)) return project;
  return {
    ...project,
    members: project.members.filter((m) => m.id !== id),
    loads: remapLoads(project.loads, 'members', (m) => (m === id ? undefined : m)),
  };
}

export function deletePlate(project: Project3D, id: string): Project3D {
  if (!project.plates.some((p) => p.id === id)) return project;
  return {
    ...project,
    plates: project.plates.filter((p) => p.id !== id),
    loads: remapLoads(project.loads, 'plates', (p) => (p === id ? undefined : p)),
  };
}

export function deleteSolid(project: Project3D, id: string): Project3D {
  if (!project.solids.some((s) => s.id === id)) return project;
  return {
    ...project,
    solids: project.solids.filter((s) => s.id !== id),
    loads: remapLoads(project.loads, 'solids', (s) => (s === id ? undefined : s)),
  };
}

// ---- Supports and loads -------------------------------------------------------------------

/**
 * Sets (or with `null` removes) the support at a node. A support with no restraint at all is
 * the same as no support.
 */
export function setSupport(
  project: Project3D,
  node: string,
  restraints: Restraints6 | null,
): Project3D {
  const others = project.supports.filter((s) => s.node !== node);
  if (!restraints || !restraints.some(Boolean)) {
    return others.length === project.supports.length ? project : { ...project, supports: others };
  }
  if (!project.nodes.some((n) => n.id === node)) return project;
  const copy: Restraints6 = [...restraints];
  return { ...project, supports: [...others, { node, restraints: copy }] };
}

export function addLoad(project: Project3D, load: NewLoad3D): { project: Project3D; id: string } {
  const id = nextId(
    'L',
    project.loads.map((l) => l.id),
  );
  return {
    project: { ...project, loads: [...project.loads, { ...load, id } as ProjectLoad3D] },
    id,
  };
}

export function updateLoad(project: Project3D, id: string, patch: Partial<NewLoad3D>): Project3D {
  return {
    ...project,
    loads: project.loads.map((l) =>
      l.id === id ? ({ ...l, ...patch, id: l.id, kind: l.kind } as ProjectLoad3D) : l,
    ),
  };
}

export function deleteLoad(project: Project3D, id: string): Project3D {
  return { ...project, loads: project.loads.filter((l) => l.id !== id) };
}

// ---- Clean-up -----------------------------------------------------------------------------

/** Removes nodes that no element uses, with their supports and nodal load targets. */
export function pruneOrphanNodes(project: Project3D): Project3D {
  const used = new Set<string>();
  for (const m of project.members) used.add(m.i).add(m.j);
  for (const p of project.plates) for (const id of p.nodes) used.add(id);
  for (const s of project.solids) for (const id of s.nodes) used.add(id);
  const nodes = project.nodes.filter((n) => used.has(n.id));
  if (nodes.length === project.nodes.length) return project;
  return {
    ...project,
    nodes,
    supports: project.supports.filter((s) => used.has(s.node)),
    loads: remapLoads(project.loads, 'nodes', (id) => (used.has(id) ? id : undefined)),
  };
}

/**
 * Merges nodes closer than `tolerance` (in every coordinate) into the earliest of them.
 * Elements, supports and loads are re-pointed; supports on merged nodes combine their
 * restraints; elements that collapse (a member whose ends merge, a plate or solid that would
 * use a node twice) or that duplicate an earlier element are removed with their load targets.
 */
export function mergeCoincidentNodes(project: Project3D, tolerance = NODE_TOLERANCE): Project3D {
  const tol = Math.max(tolerance, 0);
  const cell = tol > 0 ? 2 * tol : 1;
  const key = (a: number, b: number, c: number) => `${a},${b},${c}`;
  const buckets = new Map<string, ProjectNode3D[]>();
  const target = new Map<string, string>();
  const kept: ProjectNode3D[] = [];
  for (const node of project.nodes) {
    const cx = Math.floor(node.x / cell);
    const cy = Math.floor(node.y / cell);
    const cz = Math.floor(node.z / cell);
    let found: ProjectNode3D | undefined;
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dz = -1; dz <= 1 && !found; dz++) {
          found = buckets
            .get(key(cx + dx, cy + dy, cz + dz))
            ?.find(
              (n) =>
                Math.abs(n.x - node.x) <= tol &&
                Math.abs(n.y - node.y) <= tol &&
                Math.abs(n.z - node.z) <= tol,
            );
        }
      }
    }
    if (found) {
      target.set(node.id, found.id);
    } else {
      kept.push(node);
      const k = key(cx, cy, cz);
      const bucket = buckets.get(k);
      if (bucket) bucket.push(node);
      else buckets.set(k, [node]);
    }
  }
  if (target.size === 0) return project;
  const to = (id: string) => target.get(id) ?? id;

  const removedMembers = new Set<string>();
  const members: ProjectMember3D[] = [];
  const memberKeys = new Set<string>();
  for (const m of project.members) {
    const i = to(m.i);
    const j = to(m.j);
    const k = i < j ? `${i}|${j}` : `${j}|${i}`;
    if (i === j || memberKeys.has(k)) {
      removedMembers.add(m.id);
      continue;
    }
    memberKeys.add(k);
    members.push(i === m.i && j === m.j ? m : { ...m, i, j });
  }

  const remapElements = <T extends { id: string; nodes: string[] }>(
    elements: T[],
    removed: Set<string>,
  ): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const el of elements) {
      const nodes = el.nodes.map(to);
      const k = [...nodes].sort().join('|');
      if (new Set(nodes).size !== nodes.length || seen.has(k)) {
        removed.add(el.id);
        continue;
      }
      seen.add(k);
      out.push(nodes.every((id, n) => id === el.nodes[n]) ? el : { ...el, nodes });
    }
    return out;
  };
  const removedPlates = new Set<string>();
  const removedSolids = new Set<string>();
  const plates = remapElements(project.plates, removedPlates);
  const solids = remapElements(project.solids, removedSolids);

  const supports: Project3D['supports'] = [];
  for (const s of project.supports) {
    const node = to(s.node);
    const existing = supports.findIndex((o) => o.node === node);
    if (existing < 0) {
      supports.push(node === s.node ? s : { node, restraints: [...s.restraints] });
    } else {
      const merged = supports[existing].restraints.map((r, k) => r || s.restraints[k]);
      supports[existing] = { node, restraints: merged as Restraints6 };
    }
  }

  let loads = remapLoads(project.loads, 'nodes', to);
  loads = remapLoads(loads, 'members', dropFrom(removedMembers));
  loads = remapLoads(loads, 'plates', dropFrom(removedPlates));
  loads = remapLoads(loads, 'solids', dropFrom(removedSolids));
  return { ...project, nodes: kept, members, plates, solids, supports, loads };
}

// ---- Plane frame mode ---------------------------------------------------------------------

/** Nodes that keep a project from being a plane frame: those off the z = 0 plane. */
export function nodesOffPlane(project: Project3D, tol = NODE_TOLERANCE): string[] {
  return project.nodes.filter((n) => Math.abs(n.z) > tol).map((n) => n.id);
}

/**
 * Switches plane frame mode on or off. Turning it on needs every node on the z = 0 plane
 * (returns null otherwise); nodes within the tolerance are moved exactly onto it.
 */
export function setPlaneMode(project: Project3D, on: boolean): Project3D | null {
  if (!on) {
    if (project.plane === undefined) return project;
    const next = { ...project };
    delete next.plane;
    return next;
  }
  if (project.plane === 'XY') return project;
  if (nodesOffPlane(project).length > 0) return null;
  return {
    ...project,
    plane: 'XY',
    nodes: project.nodes.map((n) => (n.z === 0 ? n : { ...n, z: 0 })),
  };
}
