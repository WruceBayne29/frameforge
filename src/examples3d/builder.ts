import { addLoad } from '../model3d/edit';
import type { NewLoad3D, NewMember3D } from '../model3d/edit';
import { gridFrame, plateMesh, solidBlock } from '../model3d/generate';
import type {
  GridFrame,
  GridFrameOptions,
  PlateMesh,
  PlateMeshOptions,
  SolidBlock,
  SolidBlockOptions,
} from '../model3d/generate';
import type {
  CustomSection3D,
  MemberLoadDirection,
  Project3D,
  ProjectMember3D,
  Restraints6,
  SolidFace,
} from '../model3d/types';
import { DEFAULT_SECTION_3D, emptyProject3D } from '../model3d/types';

/** Small fluent helper for writing 3D example structures compactly. */
export interface Builder3D {
  /** The project built so far. */
  project: () => Project3D;
  node: (x: number, y: number, z: number) => string;
  member: (i: string, j: string, options?: NewMember3D) => string;
  beam: (i: string, j: string, section?: string, options?: NewMember3D) => string;
  truss: (i: string, j: string, section?: string, options?: NewMember3D) => string;
  support: (nodes: string | string[], restraints: Restraints6) => void;
  load: (load: NewLoad3D) => void;
  /** Force (kN) and optional moment (kN·m) on one or several nodes. */
  nodal: (
    nodes: string | string[],
    force: [number, number, number],
    moment?: [number, number, number],
  ) => void;
  /** Uniform load of intensity `w` (kN/m); the default direction is gravity (−globalY). */
  udl: (members: string | string[], w: number, direction?: MemberLoadDirection) => void;
  /** Point load `P` (kN) at `a` from node i; the default direction is gravity (−globalY). */
  point: (
    members: string | string[],
    P: number,
    a: number,
    direction?: MemberLoadDirection,
  ) => void;
  /** Pressure `p` (kN/m²) on plates, acting downwards (−globalY). */
  pressure: (plates: string[], p: number) => void;
  /** Uniform load on a face of solids; `normal` pushes into the solid. */
  face: (
    solids: string[],
    face: SolidFace,
    p: number,
    direction?: 'normal' | 'globalX' | 'globalY' | 'globalZ',
  ) => void;
  custom: (section: CustomSection3D) => void;
  selfWeight: (on?: boolean) => void;
  frame: (options: GridFrameOptions) => GridFrame;
  mesh: (options: PlateMeshOptions) => PlateMesh;
  block: (options: SolidBlockOptions) => SolidBlock;
}

const many = (ids: string | string[]): string[] => (typeof ids === 'string' ? [ids] : ids);

export function buildProject3D(
  name: string,
  description: string,
  define: (b: Builder3D) => void,
): Project3D {
  let project: Project3D = { ...emptyProject3D(name), description };
  const material = () => project.materials[0].name;

  const member = (i: string, j: string, options: NewMember3D = {}): string => {
    const id = `M${project.members.length + 1}`;
    const m: ProjectMember3D = {
      id,
      i,
      j,
      type: options.type ?? 'beam',
      section: options.section ?? DEFAULT_SECTION_3D,
      material: options.material ?? material(),
    };
    if (options.beta) m.beta = options.beta;
    if (options.releaseI) m.releaseI = options.releaseI;
    if (options.releaseJ) m.releaseJ = options.releaseJ;
    project.members.push(m);
    return id;
  };
  const load = (l: NewLoad3D) => {
    project = addLoad(project, l).project;
  };

  define({
    project: () => project,
    node: (x, y, z) => {
      const id = `N${project.nodes.length + 1}`;
      project.nodes.push({ id, x, y, z });
      return id;
    },
    member,
    beam: (i, j, section, options) => member(i, j, { ...options, type: 'beam', section }),
    truss: (i, j, section, options) => member(i, j, { ...options, type: 'truss', section }),
    support: (nodes, restraints) => {
      for (const node of many(nodes)) {
        project.supports = project.supports.filter((s) => s.node !== node);
        project.supports.push({ node, restraints: [...restraints] });
      }
    },
    load,
    nodal: (nodes, [fx, fy, fz], [mx, my, mz] = [0, 0, 0]) =>
      load({ kind: 'nodal', nodes: many(nodes), fx, fy, fz, mx, my, mz }),
    udl: (members, w, direction = 'globalY') =>
      load({
        kind: 'distributed',
        members: many(members),
        direction,
        w1: direction === 'globalY' ? 0 - w : w,
      }),
    point: (members, P, a, direction = 'globalY') =>
      load({
        kind: 'point',
        members: many(members),
        direction,
        P: direction === 'globalY' ? 0 - P : P,
        a,
      }),
    pressure: (plates, p) => load({ kind: 'pressure', plates, direction: 'globalY', p: 0 - p }),
    face: (solids, face, p, direction = 'normal') =>
      load({ kind: 'face', solids, face, direction, p }),
    custom: (section) => {
      project.customSections.push(section);
    },
    selfWeight: (on = true) => {
      project.selfWeight = on;
    },
    // The generators return a new project whose arrays are fresh copies, so the builder can
    // keep pushing to them afterwards.
    frame: (options) => {
      const made = gridFrame(project, options);
      project = made.project;
      return made;
    },
    mesh: (options) => {
      const made = plateMesh(project, options);
      project = made.project;
      return made;
    },
    block: (options) => {
      const made = solidBlock(project, options);
      project = made.project;
      return made;
    },
  });
  return project;
}
