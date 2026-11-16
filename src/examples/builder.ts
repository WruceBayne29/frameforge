import { DEFAULT_DESIGN } from '../model/types';
import type {
  CustomSection,
  DesignSettings,
  LoadDirection,
  MemberType,
  Project,
  ProjectLoad,
  ProjectMember,
  SupportKind,
} from '../model/types';

type LoadWithoutId = ProjectLoad extends infer L
  ? L extends unknown
    ? Omit<L, 'id'>
    : never
  : never;

/** Small fluent helper for writing example structures compactly. */
export interface Builder {
  node: (x: number, y: number) => string;
  member: (
    i: string,
    j: string,
    section: string,
    type?: MemberType,
    releases?: { i?: boolean; j?: boolean },
  ) => string;
  support: (node: string, kind: SupportKind) => void;
  nodal: (node: string, fx: number, fy: number, mz?: number) => void;
  /** Uniform load of intensity `w` (kN/m) along `direction` (default: gravity, −globalY). */
  udl: (member: string, w: number, direction?: LoadDirection) => void;
  distributed: (member: string, w1: number, w2: number, a?: number, b?: number) => void;
  point: (member: string, P: number, a: number, direction?: LoadDirection) => void;
  custom: (section: CustomSection) => void;
  design: (settings: Partial<DesignSettings>) => void;
}

export function buildProject(
  name: string,
  description: string,
  define: (b: Builder) => void,
): Project {
  const project: Project = {
    version: 1,
    name,
    description,
    E: 200,
    nodes: [],
    members: [],
    supports: [],
    loads: [],
    customSections: [],
    design: { ...DEFAULT_DESIGN },
  };
  const addLoad = (load: LoadWithoutId) => {
    project.loads.push({ ...load, id: `L${project.loads.length + 1}` } as ProjectLoad);
  };
  define({
    node: (x, y) => {
      const id = `N${project.nodes.length + 1}`;
      project.nodes.push({ id, x, y });
      return id;
    },
    member: (i, j, section, type = 'frame', releases = {}) => {
      const id = `M${project.members.length + 1}`;
      const member: ProjectMember = { id, i, j, type, section };
      if (releases.i) member.releaseI = true;
      if (releases.j) member.releaseJ = true;
      project.members.push(member);
      return id;
    },
    support: (node, kind) => {
      project.supports.push({ node, kind });
    },
    nodal: (node, fx, fy, mz = 0) => addLoad({ kind: 'nodal', node, fx, fy, mz }),
    udl: (member, w, direction = 'globalY') =>
      addLoad({ kind: 'distributed', member, direction, w1: direction === 'globalY' ? 0 - w : w }),
    distributed: (member, w1, w2, a, b) =>
      addLoad({ kind: 'distributed', member, direction: 'globalY', w1: 0 - w1, w2: 0 - w2, a, b }),
    point: (member, P, a, direction = 'globalY') =>
      addLoad({ kind: 'point', member, direction, P: direction === 'globalY' ? 0 - P : P, a }),
    custom: (section) => {
      project.customSections.push(section);
    },
    design: (settings) => {
      project.design = { ...project.design, ...settings };
    },
  });
  return project;
}
