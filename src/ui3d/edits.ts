/**
 * Editing helpers used by the 3D panels that act on several items at once, or on the
 * project's materials and sections. Pure functions on `Project3D`.
 */
import { addLoad, loadTargets, moveNode, updateMember, updatePlate, updateSolid } from '../model3d';
import type {
  CustomSection3D,
  Material3D,
  NewLoad3D,
  Project3D,
  ProjectLoad3D,
  ProjectMember3D,
  ProjectPlate3D,
  ProjectSolid3D,
} from '../model3d';
import type { SelectionKind } from './state';

export function updateMembers(
  project: Project3D,
  ids: readonly string[],
  patch: Partial<ProjectMember3D>,
): Project3D {
  return ids.reduce((p, id) => updateMember(p, id, patch), project);
}

export function updatePlates(
  project: Project3D,
  ids: readonly string[],
  patch: Partial<ProjectPlate3D>,
): Project3D {
  return ids.reduce((p, id) => updatePlate(p, id, patch), project);
}

export function updateSolids(
  project: Project3D,
  ids: readonly string[],
  patch: Partial<ProjectSolid3D>,
): Project3D {
  return ids.reduce((p, id) => updateSolid(p, id, patch), project);
}

/** Sets one coordinate of several nodes (nodes that would land on another node stay put). */
export function setNodeCoordinate(
  project: Project3D,
  ids: readonly string[],
  axis: 'x' | 'y' | 'z',
  value: number,
): Project3D {
  return ids.reduce((p, id) => {
    const n = p.nodes.find((node) => node.id === id);
    if (!n) return p;
    const next = { x: n.x, y: n.y, z: n.z, [axis]: value };
    return moveNode(p, id, next.x, next.y, next.z);
  }, project);
}

/** The common value of a property over several items, or undefined when they differ. */
export function common<T, V>(items: readonly T[], get: (item: T) => V): V | undefined {
  if (items.length === 0) return undefined;
  const first = get(items[0]);
  return items.every((item) => get(item) === first) ? first : undefined;
}

const TARGET_KIND: Record<string, SelectionKind> = {
  nodes: 'node',
  members: 'member',
  plates: 'plate',
  solids: 'solid',
};

/** Loads acting on any of the given items. */
export function loadsOn(
  project: Project3D,
  kind: SelectionKind,
  ids: readonly string[],
): ProjectLoad3D[] {
  const wanted = new Set(ids);
  return project.loads.filter((load) => {
    const t = loadTargets(load);
    return TARGET_KIND[t.kind] === kind && t.ids.some((id) => wanted.has(id));
  });
}

export type NewLoadKind = ProjectLoad3D['kind'];

/** Which load kinds can act on a kind of item. */
export const LOAD_KINDS_FOR: Partial<
  Record<SelectionKind, Array<{ kind: NewLoadKind; label: string }>>
> = {
  node: [{ kind: 'nodal', label: 'Nodal force / moment' }],
  member: [
    { kind: 'distributed', label: 'Distributed load (UDL)' },
    { kind: 'point', label: 'Point load' },
    { kind: 'moment', label: 'Point moment' },
  ],
  plate: [
    { kind: 'pressure', label: 'Pressure' },
    { kind: 'platePoint', label: 'Point load' },
  ],
  solid: [{ kind: 'face', label: 'Face load' }],
};

/** A new load of the given kind with sensible defaults (gravity direction, 10 units). */
export function defaultLoad(kind: NewLoadKind, ids: string[], memberLength = 0): NewLoad3D {
  switch (kind) {
    case 'nodal':
      return { kind, nodes: ids, fx: 0, fy: -10, fz: 0, mx: 0, my: 0, mz: 0 };
    case 'distributed':
      return { kind, members: ids, direction: 'globalY', w1: -10 };
    case 'point':
      return { kind, members: ids, direction: 'globalY', P: -10, a: memberLength / 2 };
    case 'moment':
      return { kind, members: ids, direction: 'localZ', M: 10, a: memberLength / 2 };
    case 'pressure':
      return { kind, plates: ids, direction: 'globalY', p: -5 };
    case 'platePoint':
      return { kind, plates: ids, direction: 'globalY', P: -10, xi: 0, eta: 0 };
    case 'face':
      return { kind, solids: ids, face: 2, direction: 'normal', p: 100 };
  }
}

export function memberLength(project: Project3D, id: string): number {
  const m = project.members.find((x) => x.id === id);
  const a = project.nodes.find((n) => n.id === m?.i);
  const b = project.nodes.find((n) => n.id === m?.j);
  return a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0;
}

/** Adds a default load of `kind` on the items. */
export function addDefaultLoad(
  project: Project3D,
  kind: NewLoadKind,
  ids: string[],
): { project: Project3D; id: string } {
  const length = ids.length > 0 ? memberLength(project, ids[0]) : 0;
  return addLoad(project, defaultLoad(kind, ids, length));
}

// ---- Materials and sections -------------------------------------------------------------

function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  let k = 2;
  while (names.has(`${base} ${k}`)) k++;
  return `${base} ${k}`;
}

export function addMaterial(project: Project3D): Project3D {
  const name = uniqueName(
    'Material',
    project.materials.map((m) => m.name),
  );
  return { ...project, materials: [...project.materials, { name, E: 200, nu: 0.3, density: 77 }] };
}

/** Changes a material; a new name is carried over to every element that used the old one. */
export function updateMaterial(
  project: Project3D,
  name: string,
  patch: Partial<Material3D>,
): Project3D {
  if (patch.name !== undefined) {
    const next = patch.name.trim();
    if (!next || (next !== name && project.materials.some((m) => m.name === next))) return project;
    patch = { ...patch, name: next };
  }
  const rename = patch.name !== undefined && patch.name !== name ? patch.name : null;
  const swap = <T extends { material: string }>(list: T[]): T[] =>
    rename ? list.map((x) => (x.material === name ? { ...x, material: rename } : x)) : list;
  return {
    ...project,
    materials: project.materials.map((m) => (m.name === name ? { ...m, ...patch } : m)),
    members: swap(project.members),
    plates: swap(project.plates),
    solids: swap(project.solids),
  };
}

/** True when some element uses the material. */
export function materialInUse(project: Project3D, name: string): boolean {
  return (
    project.members.some((m) => m.material === name) ||
    project.plates.some((p) => p.material === name) ||
    project.solids.some((s) => s.material === name)
  );
}

/** Removes an unused material (the last material can never be removed). */
export function deleteMaterial(project: Project3D, name: string): Project3D {
  if (project.materials.length <= 1 || materialInUse(project, name)) return project;
  return { ...project, materials: project.materials.filter((m) => m.name !== name) };
}

export function addCustomSection(project: Project3D): Project3D {
  const name = uniqueName(
    'Custom section',
    project.customSections.map((s) => s.name),
  );
  const section: CustomSection3D = { name, A: 50, Iz: 5000, Iy: 500, J: 20 };
  return { ...project, customSections: [...project.customSections, section] };
}

/** Changes a custom section; a new name is carried over to the members that used it. */
export function updateCustomSection(
  project: Project3D,
  name: string,
  patch: Partial<CustomSection3D>,
): Project3D {
  if (patch.name !== undefined) {
    const next = patch.name.trim();
    if (!next || (next !== name && project.customSections.some((s) => s.name === next))) {
      return project;
    }
    patch = { ...patch, name: next };
  }
  const rename = patch.name !== undefined && patch.name !== name ? patch.name : null;
  return {
    ...project,
    customSections: project.customSections.map((s) => (s.name === name ? { ...s, ...patch } : s)),
    members: rename
      ? project.members.map((m) => (m.section === name ? { ...m, section: rename } : m))
      : project.members,
  };
}

export function deleteCustomSection(project: Project3D, name: string): Project3D {
  if (project.members.some((m) => m.section === name)) return project;
  return { ...project, customSections: project.customSections.filter((s) => s.name !== name) };
}
