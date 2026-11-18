/**
 * Application-level model of a 3D ("space") project.
 *
 * Units: kN, m, kN·m; E in GPa; section area in cm², second moments of area and torsion
 * constant in cm⁴; plate thickness in mm; weight density in kN/m³; pressures in kN/m²;
 * angles in degrees. Global axes are right-handed with Y up. Loads are positive along the
 * + axis, so gravity loads are negative global-Y values.
 *
 * One load can act on many targets (e.g. one pressure on every plate of a slab), which keeps
 * meshed models readable and small.
 */
import type {
  EndRelease,
  GlobalDirection,
  MemberLoadDirection,
  MemberType3D,
  SolidFace,
} from '../solver3d/types';

export type { EndRelease, GlobalDirection, MemberLoadDirection, MemberType3D, SolidFace };

export interface ProjectNode3D {
  id: string;
  x: number;
  y: number;
  z: number;
}

/** Restrained degrees of freedom in the order [ux, uy, uz, rx, ry, rz]. */
export type Restraints6 = [boolean, boolean, boolean, boolean, boolean, boolean];

export interface ProjectSupport3D {
  node: string;
  restraints: Restraints6;
}

export const FIXED_SUPPORT: Restraints6 = [true, true, true, true, true, true];
export const PINNED_SUPPORT: Restraints6 = [true, true, true, false, false, false];
/** Roller free to slide in the horizontal plane: only the vertical translation is held. */
export const ROLLER_SUPPORT: Restraints6 = [false, true, false, false, false, false];

export interface Material3D {
  name: string;
  /** Young's modulus, GPa. */
  E: number;
  /** Poisson's ratio. */
  nu: number;
  /** Weight density, kN/m³ (used by self-weight). */
  density: number;
}

export interface CustomSection3D {
  name: string;
  /** cm² */
  A: number;
  /** Second moment of area about local z — the major axis of an upright I-section. cm⁴ */
  Iz: number;
  /** Second moment of area about local y (minor axis). cm⁴ */
  Iy: number;
  /** Torsion constant. cm⁴ */
  J: number;
}

/** Steel design settings for the IS 800 check (one grade and set of factors per project). */
export interface DesignSettings3D {
  /** Steel grade name from the IS 2062 table, e.g. "E250". */
  grade: string;
  /** Compression flange laterally restrained (no lateral-torsional buckling). */
  laterallyRestrained: boolean;
  /** Effective length factor for buckling about the major axis (local z, z-z). */
  kz: number;
  /**
   * Effective length factor for buckling about the minor axis (local y, y-y); also used for
   * the lateral-torsional buckling length.
   */
  ky: number;
}

export const DEFAULT_DESIGN_3D: DesignSettings3D = {
  grade: 'E250',
  laterallyRestrained: false,
  kz: 1,
  ky: 1,
};

export interface ProjectMember3D {
  id: string;
  i: string;
  j: string;
  type: MemberType3D;
  /** Section designation: a rolled section (e.g. "ISMB 300") or a custom section name. */
  section: string;
  /** Material name. */
  material: string;
  /** Roll angle about the member axis, degrees. */
  beta?: number;
  releaseI?: EndRelease;
  releaseJ?: EndRelease;
  /** Effective length factors for this member, overriding the project's `design.kz` / `ky`. */
  kz?: number;
  ky?: number;
}

export interface ProjectPlate3D {
  id: string;
  /** Corner nodes, counter-clockwise seen from the plate's +local-z side. */
  nodes: [string, string, string, string];
  /** mm */
  thickness: number;
  material: string;
}

export interface ProjectSolid3D {
  id: string;
  /** Nodes 1–4 on one face, 5–8 on the opposite face (5 above 1, 6 above 2, …). */
  nodes: [string, string, string, string, string, string, string, string];
  material: string;
}

export interface NodalLoad3P {
  id: string;
  kind: 'nodal';
  nodes: string[];
  fx: number;
  fy: number;
  fz: number;
  mx: number;
  my: number;
  mz: number;
}

/** Uniform (UDL) or linearly varying line load on members, kN/m. */
export interface MemberDistributedLoad3P {
  id: string;
  kind: 'distributed';
  members: string[];
  direction: MemberLoadDirection;
  w1: number;
  w2?: number;
  /** Start / end of the loaded length measured from node i, m. Default: the whole member. */
  a?: number;
  b?: number;
}

/** Concentrated force on members at distance `a` (m) from node i, kN. */
export interface MemberPointLoad3P {
  id: string;
  kind: 'point';
  members: string[];
  direction: MemberLoadDirection;
  P: number;
  a: number;
}

/** Concentrated moment on members about the given axis at distance `a` from node i, kN·m. */
export interface MemberMomentLoad3P {
  id: string;
  kind: 'moment';
  members: string[];
  direction: MemberLoadDirection;
  M: number;
  a: number;
}

/** Uniform pressure on plates, kN/m². `localZ` is the plate normal. */
export interface PlatePressureLoad3P {
  id: string;
  kind: 'pressure';
  plates: string[];
  direction: 'localZ' | GlobalDirection;
  p: number;
}

/** Concentrated force on plates at natural coordinates (xi, eta) in [−1, 1], kN. */
export interface PlatePointLoad3P {
  id: string;
  kind: 'platePoint';
  plates: string[];
  direction: 'localZ' | GlobalDirection;
  P: number;
  xi: number;
  eta: number;
}

/** Uniform load on one face of solids, kN/m². `normal` is a pressure pushing into the solid. */
export interface SolidFaceLoad3P {
  id: string;
  kind: 'face';
  solids: string[];
  face: SolidFace;
  direction: 'normal' | GlobalDirection;
  p: number;
}

export type ProjectLoad3D =
  | NodalLoad3P
  | MemberDistributedLoad3P
  | MemberPointLoad3P
  | MemberMomentLoad3P
  | PlatePressureLoad3P
  | PlatePointLoad3P
  | SolidFaceLoad3P;

/**
 * Plane in which a "plane frame" project lies. With `plane: 'XY'` every node is held out of
 * plane (uz, rx, ry) by the solver model, so the structure behaves exactly like a 2D frame or
 * truss; these restraints are not shown as supports or reactions.
 */
export type ProjectPlane = 'XY';

export interface Project3D {
  version: 1;
  /** Distinguishes 3D projects from 2D ones in files and share links. */
  kind: 'space';
  name: string;
  description?: string;
  nodes: ProjectNode3D[];
  members: ProjectMember3D[];
  plates: ProjectPlate3D[];
  solids: ProjectSolid3D[];
  supports: ProjectSupport3D[];
  loads: ProjectLoad3D[];
  materials: Material3D[];
  customSections: CustomSection3D[];
  /** Include the self-weight of every element (gravity along −Y). */
  selfWeight: boolean;
  design: DesignSettings3D;
  /** Plane frame mode: the structure lies in the z = 0 plane and only moves in it. */
  plane?: ProjectPlane;
}

/** Standard gravity, m/s². Mass density (t/m³) = weight density (kN/m³) / GRAVITY. */
export const GRAVITY = 9.80665;

export const STEEL: Material3D = { name: 'Steel', E: 200, nu: 0.3, density: 77 };
export const CONCRETE: Material3D = { name: 'Concrete M25', E: 25, nu: 0.2, density: 25 };

export const DEFAULT_SECTION_3D = 'ISMB 300';
export const DEFAULT_PLATE_THICKNESS = 150;

export function emptyProject3D(name = 'Untitled'): Project3D {
  return {
    version: 1,
    kind: 'space',
    name,
    nodes: [],
    members: [],
    plates: [],
    solids: [],
    supports: [],
    loads: [],
    materials: [{ ...STEEL }, { ...CONCRETE }],
    customSections: [],
    selfWeight: false,
    design: { ...DEFAULT_DESIGN_3D },
  };
}
