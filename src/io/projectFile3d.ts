/**
 * Reading and writing 3D ("space") projects as JSON. `parseProject3D` validates untrusted
 * input (files the user opens, data from a shared URL) and reports the first problem in
 * plain language, like `projectFile.ts` does for 2D projects. Both kinds of file carry the
 * same `format` tag; 3D files are told apart by `kind: "space"` (see `detectProjectKind`).
 */
import { DEFAULT_DESIGN } from '../model/types';
import type {
  CustomSection3D,
  EndRelease,
  GlobalDirection,
  Material3D,
  MemberLoadDirection,
  MemberType3D,
  Project3D,
  ProjectLoad3D,
  ProjectMember3D,
  ProjectNode3D,
  ProjectPlate3D,
  ProjectSolid3D,
  ProjectSupport3D,
  Restraints6,
  SolidFace,
} from '../model3d/types';
import { CONCRETE, STEEL } from '../model3d/types';
import { FILE_FORMAT, ProjectFormatError } from './projectFile';

export { FILE_FORMAT, ProjectFormatError };

export const PROJECT_KIND_3D = 'space';

export function serializeProject3D(project: Project3D): string {
  return JSON.stringify({ format: FILE_FORMAT, ...project }, null, 2);
}

type Json = Record<string, unknown>;

/** Largest number of items of one kind (nodes, plates, …) accepted from a file. */
const MAX_ITEMS = 100000;

const fail = (message: string): never => {
  throw new ProjectFormatError(message);
};

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200)
    return fail(`${what} must be a short text value.`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${what} must be a number.`);
  return v;
}

function optNum(v: unknown, what: string): number | undefined {
  return v === undefined || v === null ? undefined : num(v, what);
}

function list(v: unknown, what: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return fail(`${what} must be a list.`);
  if (v.length > MAX_ITEMS) return fail(`${what} is too long.`);
  return v;
}

function oneOf<T extends string | number>(v: unknown, options: readonly T[], what: string): T {
  if (!options.includes(v as T)) return fail(`${what} must be one of: ${options.join(', ')}.`);
  return v as T;
}

const MEMBER_TYPES: readonly MemberType3D[] = ['beam', 'truss'];
const MEMBER_DIRECTIONS: readonly MemberLoadDirection[] = [
  'localX',
  'localY',
  'localZ',
  'globalX',
  'globalY',
  'globalZ',
];
const PLATE_DIRECTIONS: readonly ('localZ' | GlobalDirection)[] = [
  'localZ',
  'globalX',
  'globalY',
  'globalZ',
];
const FACE_DIRECTIONS: readonly ('normal' | GlobalDirection)[] = [
  'normal',
  'globalX',
  'globalY',
  'globalZ',
];
const FACES: readonly SolidFace[] = [1, 2, 3, 4, 5, 6];
const RELEASE_KEYS = ['fx', 'fy', 'fz', 'mx', 'my', 'mz'] as const;

/** Keeps only the components that are released; undefined when there are none. */
function release(v: unknown, what: string): EndRelease | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) return fail(`${what} is malformed.`);
  const out: EndRelease = {};
  for (const key of RELEASE_KEYS) if (v[key] === true) out[key] = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Tells a 3D project from a 2D one, given the text of a file or already-parsed JSON, so the
 * caller can pick `parseProject3D` or `parseProject`. Anything not marked as a space project
 * is treated as 2D (2D files have no `kind`), unless it clearly has 3D content.
 */
export function detectProjectKind(input: unknown): '2d' | '3d' {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input) as unknown;
    } catch {
      throw new ProjectFormatError('This file is not valid JSON.');
    }
  }
  if (!isObject(data)) return '2d';
  if (data.kind === PROJECT_KIND_3D) return '3d';
  if (data.kind !== undefined) return '2d';
  const filled = (v: unknown) => Array.isArray(v) && v.length > 0;
  return filled(data.plates) || filled(data.solids) || Array.isArray(data.materials) ? '3d' : '2d';
}

/** Validates arbitrary parsed JSON and returns a clean `Project3D`. */
export function parseProject3D(data: unknown): Project3D {
  if (!isObject(data)) return fail('This is not a FrameForge project file.');
  if (data.format !== undefined && data.format !== FILE_FORMAT) {
    return fail('This is not a FrameForge project file.');
  }
  if (data.version !== undefined && data.version !== 1) {
    return fail('This file was made by a newer version of FrameForge.');
  }
  if (data.kind !== undefined && data.kind !== PROJECT_KIND_3D) {
    return fail('This file is not a 3D (space) project.');
  }

  const nodes: ProjectNode3D[] = list(data.nodes, 'nodes').map((raw, k) => {
    if (!isObject(raw)) return fail(`Node ${k + 1} is malformed.`);
    return {
      id: str(raw.id, `Node ${k + 1} id`),
      x: num(raw.x, `Node ${k + 1} x`),
      y: num(raw.y, `Node ${k + 1} y`),
      z: optNum(raw.z, `Node ${k + 1} z`) ?? 0,
    };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodeIds.size !== nodes.length) fail('Two nodes share the same id.');
  const needNode = (v: unknown, what: string) => {
    const id = str(v, what);
    if (!nodeIds.has(id)) fail(`${what} refers to node "${id}", which does not exist.`);
    return id;
  };

  const materials: Material3D[] = list(data.materials, 'materials').map((raw, k) => {
    if (!isObject(raw)) return fail(`Material ${k + 1} is malformed.`);
    const what = `Material ${k + 1}`;
    const material: Material3D = {
      name: str(raw.name, `${what} name`),
      E: num(raw.E, `${what} E`),
      nu: optNum(raw.nu, `${what} Poisson's ratio`) ?? 0.3,
      density: optNum(raw.density, `${what} density`) ?? 0,
    };
    if (material.E <= 0) fail(`Material "${material.name}" needs a positive E.`);
    if (material.nu <= -1 || material.nu >= 0.5) {
      fail(`Material "${material.name}" needs a Poisson's ratio between -1 and 0.5.`);
    }
    if (material.density < 0) fail(`Material "${material.name}" has a negative density.`);
    return material;
  });
  if (new Set(materials.map((m) => m.name)).size !== materials.length) {
    fail('Two materials share the same name.');
  }
  if (materials.length === 0) materials.push({ ...STEEL }, { ...CONCRETE });
  const material = (v: unknown, what: string): string =>
    v === undefined || v === null ? materials[0].name : str(v, `${what} material`);

  const members: ProjectMember3D[] = list(data.members, 'members').map((raw, k) => {
    if (!isObject(raw)) return fail(`Member ${k + 1} is malformed.`);
    const what = `Member ${k + 1}`;
    const member: ProjectMember3D = {
      id: str(raw.id, `${what} id`),
      i: needNode(raw.i, `${what} start`),
      j: needNode(raw.j, `${what} end`),
      type: oneOf(raw.type, MEMBER_TYPES, `${what} type`),
      section: str(raw.section, `${what} section`),
      material: material(raw.material, what),
    };
    if (member.i === member.j) fail(`${what} starts and ends at the same node.`);
    const beta = optNum(raw.beta, `${what} roll angle`);
    if (beta !== undefined && beta !== 0) member.beta = beta;
    const releaseI = release(raw.releaseI, `${what} start release`);
    const releaseJ = release(raw.releaseJ, `${what} end release`);
    if (releaseI) member.releaseI = releaseI;
    if (releaseJ) member.releaseJ = releaseJ;
    return member;
  });
  const memberIds = new Set(members.map((m) => m.id));
  if (memberIds.size !== members.length) fail('Two members share the same id.');

  const corners = (v: unknown, n: number, what: string): string[] => {
    if (!Array.isArray(v) || v.length !== n) return fail(`${what} needs exactly ${n} nodes.`);
    const ids = v.map((id) => needNode(id, what));
    if (new Set(ids).size !== n) fail(`${what} uses the same node more than once.`);
    return ids;
  };

  const plates: ProjectPlate3D[] = list(data.plates, 'plates').map((raw, k) => {
    if (!isObject(raw)) return fail(`Plate ${k + 1} is malformed.`);
    const what = `Plate ${k + 1}`;
    const plate: ProjectPlate3D = {
      id: str(raw.id, `${what} id`),
      nodes: corners(raw.nodes, 4, what) as ProjectPlate3D['nodes'],
      thickness: num(raw.thickness, `${what} thickness`),
      material: material(raw.material, what),
    };
    if (plate.thickness <= 0) fail(`${what} needs a positive thickness.`);
    return plate;
  });
  const plateIds = new Set(plates.map((p) => p.id));
  if (plateIds.size !== plates.length) fail('Two plates share the same id.');

  const solids: ProjectSolid3D[] = list(data.solids, 'solids').map((raw, k) => {
    if (!isObject(raw)) return fail(`Solid ${k + 1} is malformed.`);
    const what = `Solid ${k + 1}`;
    return {
      id: str(raw.id, `${what} id`),
      nodes: corners(raw.nodes, 8, what) as ProjectSolid3D['nodes'],
      material: material(raw.material, what),
    };
  });
  const solidIds = new Set(solids.map((s) => s.id));
  if (solidIds.size !== solids.length) fail('Two solids share the same id.');

  const seenSupports = new Set<string>();
  const supports: ProjectSupport3D[] = [];
  list(data.supports, 'supports').forEach((raw, k) => {
    if (!isObject(raw)) return fail(`Support ${k + 1} is malformed.`);
    const what = `Support ${k + 1}`;
    const node = needNode(raw.node, what);
    const r = raw.restraints;
    if (!Array.isArray(r) || r.length !== 6 || !r.every((v) => typeof v === 'boolean')) {
      return fail(`${what} needs six true/false restraints (ux, uy, uz, rx, ry, rz).`);
    }
    if (seenSupports.has(node)) return;
    seenSupports.add(node);
    supports.push({ node, restraints: [...r] as Restraints6 });
  });

  /** A non-empty list of distinct ids of existing items. */
  const targets = (v: unknown, known: Set<string>, noun: string, what: string): string[] => {
    if (!Array.isArray(v) || v.length === 0) return fail(`${what} needs a list of ${noun}s.`);
    if (v.length > MAX_ITEMS) return fail(`${what} has too many ${noun}s.`);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const item of v) {
      const id = str(item, `${what} ${noun}`);
      if (!known.has(id)) fail(`${what} refers to ${noun} "${id}", which does not exist.`);
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  };

  const loadIds = new Set<string>();
  const loads: ProjectLoad3D[] = list(data.loads, 'loads').map((raw, k): ProjectLoad3D => {
    if (!isObject(raw)) return fail(`Load ${k + 1} is malformed.`);
    const what = `Load ${k + 1}`;
    let id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 200) : `L${k + 1}`;
    while (loadIds.has(id)) id = `${id}'`;
    loadIds.add(id);
    switch (raw.kind) {
      case 'nodal':
        return {
          id,
          kind: 'nodal',
          nodes: targets(raw.nodes, nodeIds, 'node', what),
          fx: optNum(raw.fx, `${what} fx`) ?? 0,
          fy: optNum(raw.fy, `${what} fy`) ?? 0,
          fz: optNum(raw.fz, `${what} fz`) ?? 0,
          mx: optNum(raw.mx, `${what} mx`) ?? 0,
          my: optNum(raw.my, `${what} my`) ?? 0,
          mz: optNum(raw.mz, `${what} mz`) ?? 0,
        };
      case 'distributed': {
        const load: ProjectLoad3D = {
          id,
          kind: 'distributed',
          members: targets(raw.members, memberIds, 'member', what),
          direction: oneOf(raw.direction, MEMBER_DIRECTIONS, `${what} direction`),
          w1: num(raw.w1, `${what} w1`),
        };
        const w2 = optNum(raw.w2, `${what} w2`);
        const a = optNum(raw.a, `${what} a`);
        const b = optNum(raw.b, `${what} b`);
        if (w2 !== undefined) load.w2 = w2;
        if (a !== undefined) load.a = a;
        if (b !== undefined) load.b = b;
        return load;
      }
      case 'point':
        return {
          id,
          kind: 'point',
          members: targets(raw.members, memberIds, 'member', what),
          direction: oneOf(raw.direction, MEMBER_DIRECTIONS, `${what} direction`),
          P: num(raw.P, `${what} P`),
          a: num(raw.a, `${what} position`),
        };
      case 'moment':
        return {
          id,
          kind: 'moment',
          members: targets(raw.members, memberIds, 'member', what),
          direction: oneOf(raw.direction, MEMBER_DIRECTIONS, `${what} direction`),
          M: num(raw.M, `${what} M`),
          a: num(raw.a, `${what} position`),
        };
      case 'pressure':
        return {
          id,
          kind: 'pressure',
          plates: targets(raw.plates, plateIds, 'plate', what),
          direction: oneOf(raw.direction, PLATE_DIRECTIONS, `${what} direction`),
          p: num(raw.p, `${what} pressure`),
        };
      case 'platePoint': {
        const load: ProjectLoad3D = {
          id,
          kind: 'platePoint',
          plates: targets(raw.plates, plateIds, 'plate', what),
          direction: oneOf(raw.direction, PLATE_DIRECTIONS, `${what} direction`),
          P: num(raw.P, `${what} P`),
          xi: optNum(raw.xi, `${what} xi`) ?? 0,
          eta: optNum(raw.eta, `${what} eta`) ?? 0,
        };
        if (Math.abs(load.xi) > 1 || Math.abs(load.eta) > 1) {
          fail(`${what} position (xi, eta) must lie between -1 and 1.`);
        }
        return load;
      }
      case 'face':
        return {
          id,
          kind: 'face',
          solids: targets(raw.solids, solidIds, 'solid', what),
          face: oneOf(raw.face, FACES, `${what} face`),
          direction: oneOf(raw.direction, FACE_DIRECTIONS, `${what} direction`),
          p: num(raw.p, `${what} pressure`),
        };
      default:
        return fail(`${what} has an unknown kind.`);
    }
  });

  const customSections: CustomSection3D[] = list(data.customSections, 'customSections').map(
    (raw, k) => {
      if (!isObject(raw)) return fail(`Custom section ${k + 1} is malformed.`);
      const what = `Custom section ${k + 1}`;
      const section: CustomSection3D = {
        name: str(raw.name, `${what} name`),
        A: num(raw.A, `${what} area`),
        Iz: num(raw.Iz, `${what} Iz`),
        Iy: num(raw.Iy, `${what} Iy`),
        J: num(raw.J, `${what} torsion constant`),
      };
      if (section.A <= 0 || section.Iz <= 0 || section.Iy <= 0 || section.J <= 0) {
        fail(`Custom section "${section.name}" needs positive A, Iz, Iy and J.`);
      }
      return section;
    },
  );

  const design = isObject(data.design) ? data.design : {};
  const k = optNum(design.effectiveLengthFactor, 'Effective length factor') ?? 1;

  const project: Project3D = {
    version: 1,
    kind: 'space',
    name:
      typeof data.name === 'string' && data.name.trim()
        ? data.name.trim().slice(0, 120)
        : 'Untitled',
    nodes,
    members,
    plates,
    solids,
    supports,
    loads,
    materials,
    customSections,
    selfWeight: data.selfWeight === true,
    design: {
      grade: typeof design.grade === 'string' ? design.grade : DEFAULT_DESIGN.grade,
      laterallyRestrained: design.laterallyRestrained === true,
      effectiveLengthFactor: k > 0 ? k : 1,
    },
  };
  if (typeof data.description === 'string' && data.description) {
    project.description = data.description.slice(0, 600);
  }
  if (data.plane !== undefined && data.plane !== null) {
    project.plane = oneOf(data.plane, ['XY'] as const, 'Plane');
  }
  return project;
}

/** Parses the text of a 3D project file. */
export function parseProject3DText(text: string): Project3D {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('This file is not valid JSON.');
  }
  return parseProject3D(data);
}
