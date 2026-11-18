/**
 * Generators for regular pieces of structure: a rectangular building frame, a quadrilateral
 * plate mesh, a block of solids, and the conversion of a 2D project into the z = 0 plane.
 *
 * The mesh generators append to a project (never mutating it) and return the new project
 * with the ids they created. New nodes that coincide with existing ones are merged into
 * them, so generated parts connect to what is already there and to each other.
 */
import type { Project, ProjectLoad, SupportKind } from '../model/types';
import type { SolidFace } from '../solver3d/types';
import { NODE_TOLERANCE } from './edit';
import { idSequence } from './ids';
import type {
  Project3D,
  ProjectLoad3D,
  ProjectMember3D,
  ProjectNode3D,
  ProjectPlate3D,
  ProjectSolid3D,
  ProjectSupport3D,
  Restraints6,
} from './types';
import {
  CONCRETE,
  DEFAULT_PLATE_THICKNESS,
  DEFAULT_SECTION_3D,
  emptyProject3D,
  FIXED_SUPPORT,
  GRAVITY,
  PINNED_SUPPORT,
  STEEL,
} from './types';

export type Point3 = [number, number, number];

/** A project and the ids a generator added to it. */
export interface Generated {
  project: Project3D;
  /** Nodes created (existing nodes that were reused are not listed). */
  nodes: string[];
  members: string[];
  plates: string[];
  solids: string[];
}

/** Mutable copy of a project that generators add to; `finish` returns the result. */
interface Draft {
  node: (x: number, y: number, z: number) => string;
  /** Returns the id of the new member, or of the member that already joins the two nodes. */
  member: (i: string, j: string, rest: Omit<ProjectMember3D, 'id' | 'i' | 'j'>) => string | null;
  plate: (
    nodes: ProjectPlate3D['nodes'],
    rest: { thickness: number; material: string },
  ) => string | null;
  solid: (nodes: ProjectSolid3D['nodes'], material: string) => string | null;
  support: (node: string, restraints: Restraints6) => void;
  finish: () => Generated;
}

function draft(project: Project3D, tolerance = NODE_TOLERANCE): Draft {
  const nodes = [...project.nodes];
  const members = [...project.members];
  const plates = [...project.plates];
  const solids = [...project.solids];
  let supports = project.supports;
  const created: Omit<Generated, 'project'> = { nodes: [], members: [], plates: [], solids: [] };

  const nextNode = idSequence(
    'N',
    nodes.map((n) => n.id),
  );
  const nextMember = idSequence(
    'M',
    members.map((m) => m.id),
  );
  const nextPlate = idSequence(
    'P',
    plates.map((p) => p.id),
  );
  const nextSolid = idSequence(
    'S',
    solids.map((s) => s.id),
  );

  // Spatial hash for merging coincident nodes.
  const tol = Math.max(tolerance, 0);
  const cell = tol > 0 ? 2 * tol : 1;
  const buckets = new Map<string, ProjectNode3D[]>();
  const bucketKey = (n: { x: number; y: number; z: number }, dx = 0, dy = 0, dz = 0) =>
    `${Math.floor(n.x / cell) + dx},${Math.floor(n.y / cell) + dy},${Math.floor(n.z / cell) + dz}`;
  const remember = (n: ProjectNode3D) => {
    const key = bucketKey(n);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(n);
    else buckets.set(key, [n]);
  };
  nodes.forEach(remember);

  const pair = (i: string, j: string) => (i < j ? `${i}|${j}` : `${j}|${i}`);
  const setKey = (ids: readonly string[]) => [...ids].sort().join('|');
  const memberByPair = new Map(members.map((m) => [pair(m.i, m.j), m.id]));
  const plateBySet = new Map(plates.map((p) => [setKey(p.nodes), p.id]));
  const solidBySet = new Map(solids.map((s) => [setKey(s.nodes), s.id]));

  return {
    node: (x, y, z) => {
      const p = { x, y, z };
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const hit = buckets
              .get(bucketKey(p, dx, dy, dz))
              ?.find(
                (n) =>
                  Math.abs(n.x - x) <= tol && Math.abs(n.y - y) <= tol && Math.abs(n.z - z) <= tol,
              );
            if (hit) return hit.id;
          }
        }
      }
      const node: ProjectNode3D = { id: nextNode(), x, y, z };
      nodes.push(node);
      remember(node);
      created.nodes.push(node.id);
      return node.id;
    },
    member: (i, j, rest) => {
      if (i === j) return null;
      const key = pair(i, j);
      const existing = memberByPair.get(key);
      if (existing) return existing;
      const id = nextMember();
      members.push({ id, i, j, ...rest });
      memberByPair.set(key, id);
      created.members.push(id);
      return id;
    },
    plate: (ids, rest) => {
      if (new Set(ids).size !== 4) return null;
      const key = setKey(ids);
      const existing = plateBySet.get(key);
      if (existing) return existing;
      const id = nextPlate();
      plates.push({ id, nodes: ids, ...rest });
      plateBySet.set(key, id);
      created.plates.push(id);
      return id;
    },
    solid: (ids, material) => {
      if (new Set(ids).size !== 8) return null;
      const key = setKey(ids);
      const existing = solidBySet.get(key);
      if (existing) return existing;
      const id = nextSolid();
      solids.push({ id, nodes: ids, material });
      solidBySet.set(key, id);
      created.solids.push(id);
      return id;
    },
    support: (node, restraints) => {
      supports = [
        ...supports.filter((s) => s.node !== node),
        { node, restraints: [...restraints] },
      ];
    },
    finish: () => ({
      project: { ...project, nodes, members, plates, solids, supports },
      ...created,
    }),
  };
}

const firstMaterial = (project: Project3D): string => project.materials[0]?.name ?? STEEL.name;

const count = (value: number, least: number, what: string): number => {
  if (!Number.isInteger(value) || value < least) {
    throw new RangeError(`${what} must be a whole number of at least ${least}.`);
  }
  return value;
};

const positive = (value: number, what: string): number => {
  if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`${what} must be positive.`);
  return value;
};

// ---- Building frame ---------------------------------------------------------------------

export interface GridFrameOptions {
  /** Number of bays along X (>= 1) and Z (>= 0; 0 gives a single plane frame). */
  baysX: number;
  baysZ: number;
  storeys: number;
  /** m */
  bayWidthX: number;
  bayWidthZ: number;
  storeyHeight: number;
  /** Position of the first column base. Default [0, 0, 0]. */
  origin?: Point3;
  columnSection?: string;
  beamSection?: string;
  material?: string;
  /** Fixed column bases (default) or pinned ones. */
  fixedBases?: boolean;
}

export interface GridFrame extends Generated {
  /** Node ids as `grid[level][ix][iz]`; level 0 is the bases. */
  grid: string[][][];
  /** Column member ids, as `columns[storey][ix][iz]` flattened in that order. */
  columns: string[];
  /** Beams along X and along Z, storey by storey (existing members that were reused included). */
  beamsX: string[];
  beamsZ: string[];
  /** Beams of each floor, `floorBeams[storey]` (X beams then Z beams). */
  floorBeams: string[][];
}

/** A rectangular multi-bay, multi-storey frame: columns along Y, beams along X and Z. */
export function gridFrame(project: Project3D, options: GridFrameOptions): GridFrame {
  const baysX = count(options.baysX, 1, 'baysX');
  const baysZ = count(options.baysZ, 0, 'baysZ');
  const storeys = count(options.storeys, 1, 'storeys');
  const wx = positive(options.bayWidthX, 'bayWidthX');
  const wz = baysZ > 0 ? positive(options.bayWidthZ, 'bayWidthZ') : 0;
  const h = positive(options.storeyHeight, 'storeyHeight');
  const [ox, oy, oz] = options.origin ?? [0, 0, 0];
  const material = options.material ?? firstMaterial(project);
  const column = {
    type: 'beam' as const,
    section: options.columnSection ?? DEFAULT_SECTION_3D,
    material,
  };
  const beam = {
    type: 'beam' as const,
    section: options.beamSection ?? DEFAULT_SECTION_3D,
    material,
  };

  const d = draft(project);
  const grid: string[][][] = [];
  for (let level = 0; level <= storeys; level++) {
    const plane: string[][] = [];
    for (let ix = 0; ix <= baysX; ix++) {
      const row: string[] = [];
      for (let iz = 0; iz <= baysZ; iz++) {
        row.push(d.node(ox + ix * wx, oy + level * h, oz + iz * wz));
      }
      plane.push(row);
    }
    grid.push(plane);
  }
  const keep = (list: string[], id: string | null) => {
    if (id) list.push(id);
  };
  const columns: string[] = [];
  const beamsX: string[] = [];
  const beamsZ: string[] = [];
  const floorBeams: string[][] = [];
  for (let level = 1; level <= storeys; level++) {
    for (let ix = 0; ix <= baysX; ix++) {
      for (let iz = 0; iz <= baysZ; iz++) {
        keep(columns, d.member(grid[level - 1][ix][iz], grid[level][ix][iz], column));
      }
    }
    const floor: string[] = [];
    for (let iz = 0; iz <= baysZ; iz++) {
      for (let ix = 0; ix < baysX; ix++) {
        keep(floor, d.member(grid[level][ix][iz], grid[level][ix + 1][iz], beam));
      }
    }
    beamsX.push(...floor);
    const along = floor.length;
    for (let ix = 0; ix <= baysX; ix++) {
      for (let iz = 0; iz < baysZ; iz++) {
        keep(floor, d.member(grid[level][ix][iz], grid[level][ix][iz + 1], beam));
      }
    }
    beamsZ.push(...floor.slice(along));
    floorBeams.push(floor);
  }
  const base = options.fixedBases === false ? PINNED_SUPPORT : FIXED_SUPPORT;
  for (const row of grid[0]) for (const node of row) d.support(node, base);
  return { ...d.finish(), grid, columns, beamsX, beamsZ, floorBeams };
}

// ---- Plate mesh -------------------------------------------------------------------------

export interface PlateMeshOptions {
  /** The four corners of the region, in order around its perimeter. */
  corners: [Point3, Point3, Point3, Point3];
  /** Elements along the edge corner 1 → 2 and along the edge corner 1 → 4. */
  nx: number;
  ny: number;
  /** mm */
  thickness?: number;
  material?: string;
}

export interface PlateMesh extends Generated {
  /** Node ids as `grid[i][j]`, i = 0…nx along corner 1 → 2, j = 0…ny along corner 1 → 4. */
  grid: string[][];
  /** Plate ids as `plateGrid[i][j]`, i = 0…nx−1, j = 0…ny−1. */
  plateGrid: string[][];
}

/**
 * Meshes a quadrilateral region with nx × ny plates by bilinear mapping of the corners. Every
 * plate lists its nodes in the same sense as the corners, so the local z of every plate is
 * the normal for which the corners run counter-clockwise: (c2 − c1) × (c4 − c1).
 */
export function plateMesh(project: Project3D, options: PlateMeshOptions): PlateMesh {
  const nx = count(options.nx, 1, 'nx');
  const ny = count(options.ny, 1, 'ny');
  const [c1, c2, c3, c4] = options.corners;
  const rest = {
    thickness: options.thickness ?? DEFAULT_PLATE_THICKNESS,
    material: options.material ?? firstMaterial(project),
  };
  const d = draft(project);
  const grid: string[][] = [];
  for (let i = 0; i <= nx; i++) {
    const s = i / nx;
    const row: string[] = [];
    for (let j = 0; j <= ny; j++) {
      const t = j / ny;
      const at = (k: 0 | 1 | 2) =>
        (1 - s) * (1 - t) * c1[k] + s * (1 - t) * c2[k] + s * t * c3[k] + (1 - s) * t * c4[k];
      row.push(d.node(at(0), at(1), at(2)));
    }
    grid.push(row);
  }
  const plateGrid: string[][] = [];
  for (let i = 0; i < nx; i++) {
    const row: string[] = [];
    for (let j = 0; j < ny; j++) {
      const id = d.plate([grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]], rest);
      if (id) row.push(id);
    }
    plateGrid.push(row);
  }
  return { ...d.finish(), grid, plateGrid };
}

// ---- Solid block ------------------------------------------------------------------------

export type BlockSide = 'xMin' | 'xMax' | 'yMin' | 'yMax' | 'zMin' | 'zMax';

/** Solid face number lying on each side of a block made by `solidBlock`. */
export const BLOCK_FACE: Record<BlockSide, SolidFace> = {
  yMin: 1,
  yMax: 2,
  xMin: 3,
  zMax: 4,
  xMax: 5,
  zMin: 6,
};

export interface SolidBlockOptions {
  /** Corner of the block with the smallest x, y and z. Default [0, 0, 0]. */
  origin?: Point3;
  /** Side lengths along X, Y, Z, m. */
  size: Point3;
  /** Number of solids along X, Y, Z. */
  divisions: [number, number, number];
  material?: string;
}

export interface SolidBlock extends Generated {
  /** Node ids as `grid[i][j][k]` along X, Y, Z. */
  grid: string[][][];
  /** Solid ids as `solidGrid[i][j][k]`. */
  solidGrid: string[][][];
  /** The solids on each side of the block with the face number that lies on that side. */
  boundary: Record<BlockSide, { solids: string[]; face: SolidFace; nodes: string[] }>;
}

/**
 * An axis-aligned block of nx × ny × nz hexahedra. Each solid lists its bottom (y-min) face
 * first, counter-clockwise seen from above, then the top face, which gives the positive
 * Jacobian the solver needs. Face numbers therefore are: 1 bottom (y-min), 2 top (y-max),
 * 3 x-min, 4 z-max, 5 x-max, 6 z-min — see `BLOCK_FACE`.
 */
export function solidBlock(project: Project3D, options: SolidBlockOptions): SolidBlock {
  const [nx, ny, nz] = options.divisions.map((n, k) => count(n, 1, `divisions[${k}]`));
  const [lx, ly, lz] = options.size.map((l, k) => positive(l, `size[${k}]`));
  const [ox, oy, oz] = options.origin ?? [0, 0, 0];
  const material = options.material ?? firstMaterial(project);
  const d = draft(project);
  const grid: string[][][] = [];
  for (let i = 0; i <= nx; i++) {
    const plane: string[][] = [];
    for (let j = 0; j <= ny; j++) {
      const row: string[] = [];
      for (let k = 0; k <= nz; k++) {
        row.push(d.node(ox + (i * lx) / nx, oy + (j * ly) / ny, oz + (k * lz) / nz));
      }
      plane.push(row);
    }
    grid.push(plane);
  }
  const side = (name: BlockSide) => ({
    solids: [] as string[],
    face: BLOCK_FACE[name],
    nodes: [] as string[],
  });
  const boundary: SolidBlock['boundary'] = {
    xMin: side('xMin'),
    xMax: side('xMax'),
    yMin: side('yMin'),
    yMax: side('yMax'),
    zMin: side('zMin'),
    zMax: side('zMax'),
  };
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      for (let k = 0; k <= nz; k++) {
        const id = grid[i][j][k];
        if (i === 0) boundary.xMin.nodes.push(id);
        if (i === nx) boundary.xMax.nodes.push(id);
        if (j === 0) boundary.yMin.nodes.push(id);
        if (j === ny) boundary.yMax.nodes.push(id);
        if (k === 0) boundary.zMin.nodes.push(id);
        if (k === nz) boundary.zMax.nodes.push(id);
      }
    }
  }
  const solidGrid: string[][][] = [];
  for (let i = 0; i < nx; i++) {
    const plane: string[][] = [];
    for (let j = 0; j < ny; j++) {
      const row: string[] = [];
      for (let k = 0; k < nz; k++) {
        const layer = (jj: number): [string, string, string, string] => [
          grid[i][jj][k],
          grid[i][jj][k + 1],
          grid[i + 1][jj][k + 1],
          grid[i + 1][jj][k],
        ];
        const id = d.solid([...layer(j), ...layer(j + 1)], material);
        if (!id) continue;
        row.push(id);
        if (i === 0) boundary.xMin.solids.push(id);
        if (i === nx - 1) boundary.xMax.solids.push(id);
        if (j === 0) boundary.yMin.solids.push(id);
        if (j === ny - 1) boundary.yMax.solids.push(id);
        if (k === 0) boundary.zMin.solids.push(id);
        if (k === nz - 1) boundary.zMax.solids.push(id);
      }
      plane.push(row);
    }
    solidGrid.push(plane);
  }
  return { ...d.finish(), grid, solidGrid, boundary };
}

// ---- 2D → 3D ----------------------------------------------------------------------------

/**
 * Restraints of a 2D support placed in the z = 0 plane. Every support also holds the node
 * out of plane (uz, rx, ry) so the plane structure cannot fall over; the in-plane behaviour
 * is that of the 2D support.
 */
export const SUPPORT_2D_RESTRAINTS: Record<SupportKind, Restraints6> = {
  fixed: [true, true, true, true, true, true],
  pinned: [true, true, true, true, true, false],
  rollerX: [false, true, true, true, true, false],
  rollerY: [true, false, true, true, true, false],
};

/** Mass density of steel used by the 2D app's modal analysis, t/m³. */
export const STEEL_MASS_2D = 7.85;

/**
 * Converts a 2D project into a plane-frame (`plane: 'XY'`) 3D project lying in the z = 0 plane that analyses to the same
 * in-plane result: frame members become beams, truss members stay trusses, sections and
 * loads are kept.
 *
 * Two conventions differ and are translated:
 *  - 2D local y is always 90° counter-clockwise from the member axis, whereas the 3D "web
 *    up" local y points to the +Y side. They are opposite for members whose axis has a
 *    negative X component, so `localY` loads on those members change sign.
 *  - 2D moments are counter-clockwise, i.e. about global +Z; a 2D end release is a release
 *    of the moment about local z.
 *
 * A 2D custom section has only A and I; the copy uses I for both bending axes and for the
 * torsion constant, which do not matter while the model stays in its plane.
 */
export function from2D(source: Project): Project3D {
  const project = emptyProject3D(source.name);
  if (source.description) project.description = source.description;
  project.plane = 'XY';
  // The 2D app took steel as 7.85 t/m³ for modal analysis; keep the same mass.
  project.materials = [
    { ...STEEL, E: source.E, density: STEEL_MASS_2D * GRAVITY },
    { ...CONCRETE },
  ];
  project.design = {
    grade: source.design.grade,
    laterallyRestrained: source.design.laterallyRestrained,
    kz: source.design.effectiveLengthFactor,
    ky: source.design.effectiveLengthFactor,
  };
  project.customSections = source.customSections.map((s) => ({
    name: s.name,
    A: s.A,
    Iz: s.I,
    Iy: s.I,
    J: s.I,
  }));
  project.nodes = source.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, z: 0 }));
  const position = new Map(source.nodes.map((n) => [n.id, n]));

  /** Members whose 3D local y is opposite to their 2D local y. */
  const flipped = new Set<string>();
  project.members = source.members.map((m) => {
    const a = position.get(m.i);
    const b = position.get(m.j);
    if (a && b) {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      // Same test as the solver: a member is vertical when its axis has no horizontal part.
      if (length > 0 && (b.x - a.x) / length <= -1e-9) flipped.add(m.id);
    }
    const member: ProjectMember3D = {
      id: m.id,
      i: m.i,
      j: m.j,
      type: m.type === 'truss' ? 'truss' : 'beam',
      section: m.section,
      material: STEEL.name,
    };
    if (m.releaseI) member.releaseI = { mz: true };
    if (m.releaseJ) member.releaseJ = { mz: true };
    return member;
  });
  project.supports = source.supports.map((s): ProjectSupport3D => ({
    node: s.node,
    restraints: [...SUPPORT_2D_RESTRAINTS[s.kind]],
  }));
  project.loads = source.loads.map((load: ProjectLoad): ProjectLoad3D => {
    switch (load.kind) {
      case 'nodal':
        return {
          id: load.id,
          kind: 'nodal',
          nodes: [load.node],
          fx: load.fx,
          fy: load.fy,
          fz: 0,
          mx: 0,
          my: 0,
          mz: load.mz,
        };
      case 'distributed': {
        const flip = load.direction === 'localY' && flipped.has(load.member);
        const signed = (v: number) => (flip ? 0 - v : v);
        const out: ProjectLoad3D = {
          id: load.id,
          kind: 'distributed',
          members: [load.member],
          direction: load.direction,
          w1: signed(load.w1),
        };
        if (load.w2 !== undefined) out.w2 = signed(load.w2);
        if (load.a !== undefined) out.a = load.a;
        if (load.b !== undefined) out.b = load.b;
        return out;
      }
      case 'point': {
        const flip = load.direction === 'localY' && flipped.has(load.member);
        return {
          id: load.id,
          kind: 'point',
          members: [load.member],
          direction: load.direction,
          P: flip ? 0 - load.P : load.P,
          a: load.a,
        };
      }
      case 'moment':
        return {
          id: load.id,
          kind: 'moment',
          members: [load.member],
          direction: 'globalZ',
          M: load.M,
          a: load.a,
        };
    }
  });
  return project;
}
