/**
 * Reading and writing projects as JSON. `parseProject` validates untrusted input (files the
 * user opens, data from a shared URL) and reports the first problem in plain language.
 */
import { DEFAULT_DESIGN } from '../model/types';
import type {
  CustomSection,
  LoadDirection,
  MemberType,
  Project,
  ProjectLoad,
  ProjectMember,
  ProjectNode,
  ProjectSupport,
  SupportKind,
} from '../model/types';

export const FILE_FORMAT = 'frameforge-project';

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

export function serializeProject(project: Project): string {
  return JSON.stringify({ format: FILE_FORMAT, ...project }, null, 2);
}

type Json = Record<string, unknown>;

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
  if (v.length > 5000) return fail(`${what} is too long.`);
  return v;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], what: string): T {
  if (typeof v !== 'string' || !options.includes(v as T)) {
    return fail(`${what} must be one of: ${options.join(', ')}.`);
  }
  return v as T;
}

const SUPPORT_KINDS: readonly SupportKind[] = ['fixed', 'pinned', 'rollerX', 'rollerY'];
const MEMBER_TYPES: readonly MemberType[] = ['frame', 'truss'];
const DIRECTIONS: readonly LoadDirection[] = ['localX', 'localY', 'globalX', 'globalY'];

/** Validates arbitrary parsed JSON and returns a clean `Project`. */
export function parseProject(data: unknown): Project {
  if (!isObject(data)) return fail('This is not a FrameForge project file.');
  if (data.version !== undefined && data.version !== 1) {
    return fail('This file was made by a newer version of FrameForge.');
  }

  const nodes: ProjectNode[] = list(data.nodes, 'nodes').map((raw, k) => {
    if (!isObject(raw)) return fail(`Node ${k + 1} is malformed.`);
    return {
      id: str(raw.id, `Node ${k + 1} id`),
      x: num(raw.x, `Node ${k + 1} x`),
      y: num(raw.y, `Node ${k + 1} y`),
    };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodeIds.size !== nodes.length) fail('Two nodes share the same id.');
  const needNode = (v: unknown, what: string) => {
    const id = str(v, what);
    if (!nodeIds.has(id)) fail(`${what} refers to node "${id}", which does not exist.`);
    return id;
  };

  const members: ProjectMember[] = list(data.members, 'members').map((raw, k) => {
    if (!isObject(raw)) return fail(`Member ${k + 1} is malformed.`);
    const what = `Member ${k + 1}`;
    const member: ProjectMember = {
      id: str(raw.id, `${what} id`),
      i: needNode(raw.i, `${what} start`),
      j: needNode(raw.j, `${what} end`),
      type: oneOf(raw.type, MEMBER_TYPES, `${what} type`),
      section: str(raw.section, `${what} section`),
    };
    if (member.i === member.j) fail(`${what} starts and ends at the same node.`);
    if (raw.releaseI === true) member.releaseI = true;
    if (raw.releaseJ === true) member.releaseJ = true;
    return member;
  });
  const memberIds = new Set(members.map((m) => m.id));
  if (memberIds.size !== members.length) fail('Two members share the same id.');
  const needMember = (v: unknown, what: string) => {
    const id = str(v, what);
    if (!memberIds.has(id)) fail(`${what} refers to member "${id}", which does not exist.`);
    return id;
  };

  const seenSupports = new Set<string>();
  const supports: ProjectSupport[] = [];
  list(data.supports, 'supports').forEach((raw, k) => {
    if (!isObject(raw)) return fail(`Support ${k + 1} is malformed.`);
    const node = needNode(raw.node, `Support ${k + 1}`);
    if (seenSupports.has(node)) return;
    seenSupports.add(node);
    supports.push({ node, kind: oneOf(raw.kind, SUPPORT_KINDS, `Support ${k + 1} kind`) });
  });

  const loadIds = new Set<string>();
  const loads: ProjectLoad[] = list(data.loads, 'loads').map((raw, k): ProjectLoad => {
    if (!isObject(raw)) return fail(`Load ${k + 1} is malformed.`);
    const what = `Load ${k + 1}`;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : `L${k + 1}`;
    while (loadIds.has(id)) id = `${id}'`;
    loadIds.add(id);
    switch (raw.kind) {
      case 'nodal':
        return {
          id,
          kind: 'nodal',
          node: needNode(raw.node, what),
          fx: optNum(raw.fx, `${what} fx`) ?? 0,
          fy: optNum(raw.fy, `${what} fy`) ?? 0,
          mz: optNum(raw.mz, `${what} mz`) ?? 0,
        };
      case 'distributed': {
        const load: ProjectLoad = {
          id,
          kind: 'distributed',
          member: needMember(raw.member, what),
          direction: oneOf(raw.direction, DIRECTIONS, `${what} direction`),
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
          member: needMember(raw.member, what),
          direction: oneOf(raw.direction, DIRECTIONS, `${what} direction`),
          P: num(raw.P, `${what} P`),
          a: num(raw.a, `${what} position`),
        };
      case 'moment':
        return {
          id,
          kind: 'moment',
          member: needMember(raw.member, what),
          M: num(raw.M, `${what} M`),
          a: num(raw.a, `${what} position`),
        };
      default:
        return fail(`${what} has an unknown kind.`);
    }
  });

  const customSections: CustomSection[] = list(data.customSections, 'customSections').map(
    (raw, k) => {
      if (!isObject(raw)) return fail(`Custom section ${k + 1} is malformed.`);
      const section = {
        name: str(raw.name, `Custom section ${k + 1} name`),
        A: num(raw.A, `Custom section ${k + 1} area`),
        I: num(raw.I, `Custom section ${k + 1} second moment of area`),
      };
      if (section.A <= 0 || section.I <= 0)
        fail(`Custom section "${section.name}" needs positive A and I.`);
      return section;
    },
  );

  const E = optNum(data.E, 'E') ?? 200;
  if (E <= 0) fail('E must be positive.');
  const design = isObject(data.design) ? data.design : {};
  const k = optNum(design.effectiveLengthFactor, 'Effective length factor') ?? 1;

  const project: Project = {
    version: 1,
    name:
      typeof data.name === 'string' && data.name.trim()
        ? data.name.trim().slice(0, 120)
        : 'Untitled',
    E,
    nodes,
    members,
    supports,
    loads,
    customSections,
    design: {
      grade: typeof design.grade === 'string' ? design.grade : DEFAULT_DESIGN.grade,
      laterallyRestrained: design.laterallyRestrained === true,
      effectiveLengthFactor: k > 0 ? k : 1,
    },
  };
  if (typeof data.description === 'string' && data.description) {
    project.description = data.description.slice(0, 600);
  }
  return project;
}

/** Parses the text of a project file. */
export function parseProjectText(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProjectFormatError('This file is not valid JSON.');
  }
  return parseProject(data);
}
