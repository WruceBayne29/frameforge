/**
 * 3D solver data model. The solver is unit-agnostic: any consistent unit system works
 * (e.g. kN, m, kN/m², m², m⁴).
 *
 * Global axes are right-handed with **Y up** (X and Z horizontal), so the 2D solver's XY plane
 * is the z = 0 plane of this one. Every node has six degrees of freedom in the order
 * [ux, uy, uz, rx, ry, rz]; rotations and moments follow the right-hand rule.
 *
 * Four element families share the nodes:
 *  - truss  : 2-node line element, 3 translations per node (6 DOF), axial force only
 *  - beam   : 2-node line element, 6 DOF per node (12 DOF), axial + biaxial bending + torsion
 *  - plate  : 4-node flat shell (membrane + bending), 6 DOF per node (24 DOF)
 *  - solid  : 8-node hexahedron, 3 translations per node (24 DOF)
 */

export type Vec3 = [number, number, number];

export type Dof6 = 'ux' | 'uy' | 'uz' | 'rx' | 'ry' | 'rz';

export interface Node3D {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface Support3D {
  node: string;
  /** Restrain translation along global X / Y / Z. */
  ux?: boolean;
  uy?: boolean;
  uz?: boolean;
  /** Restrain rotation about global X / Y / Z. */
  rx?: boolean;
  ry?: boolean;
  rz?: boolean;
  /** Prescribed displacements of restrained DOFs (support settlement). */
  settlement?: Partial<Record<Dof6, number>>;
  /** Elastic spring stiffnesses on otherwise free DOFs. */
  spring?: Partial<Record<Dof6, number>>;
}

export type MemberType3D = 'beam' | 'truss';

/** Local-axis force/moment components released (set to zero) at one end of a beam. */
export interface EndRelease {
  fx?: boolean;
  fy?: boolean;
  fz?: boolean;
  mx?: boolean;
  my?: boolean;
  mz?: boolean;
}

/**
 * Line member. Local x runs from node i to node j. With `beta = 0`:
 *  - member not vertical: local z is horizontal (z = x × Y, normalised) and local y = z × x,
 *    so local y always has a positive global-Y component ("web up");
 *  - member vertical (parallel to global Y): local z = global Z and local y = z × x.
 * `beta` then rotates local y and z about local x (right-hand rule).
 * A member along global +X therefore has local axes equal to the global axes.
 */
export interface Member3D {
  id: string;
  i: string;
  j: string;
  /** `beam` carries axial force, shear, biaxial bending and torsion; `truss` is axial only. */
  type: MemberType3D;
  /** Young's modulus. */
  E: number;
  /** Shear modulus (beams only). */
  G?: number;
  /** Cross-sectional area. */
  A: number;
  /** Second moment of area about local y (bending in the local x–z plane). Beams only. */
  Iy?: number;
  /** Second moment of area about local z (bending in the local x–y plane). Beams only. */
  Iz?: number;
  /** Torsion constant. Beams only. */
  J?: number;
  /** Roll angle about local x, in radians. Defaults to 0. */
  beta?: number;
  /** Releases at the start / end node, in local axes. Beams only. */
  releaseI?: EndRelease;
  releaseJ?: EndRelease;
  /** Weight per unit volume, used by `selfWeight` loads. */
  density?: number;
  /** Mass per unit volume, used by modal analysis. */
  mass?: number;
}

/**
 * 4-node flat shell. Nodes are listed counter-clockwise when seen from the +local-z side.
 * Local axes: z = (n3 − n1) × (n4 − n2) normalised; x points from the midpoint of edge 4–1 to
 * the midpoint of edge 2–3, made perpendicular to z; y = z × x.
 */
export interface Plate3D {
  id: string;
  nodes: [string, string, string, string];
  E: number;
  /** Poisson's ratio. */
  nu: number;
  /** Thickness. */
  t: number;
  /** Weight per unit volume, used by `selfWeight` loads. */
  density?: number;
  /** Mass per unit volume, used by modal analysis. */
  mass?: number;
}

/**
 * 8-node hexahedron. Nodes 1–4 form one face, ordered so that their normal (right-hand rule)
 * points towards the opposite face; nodes 5–8 form that opposite face with node 5 connected
 * to node 1, 6 to 2, 7 to 3 and 8 to 4 (the usual finite-element ordering).
 */
export interface Solid3D {
  id: string;
  nodes: [string, string, string, string, string, string, string, string];
  E: number;
  nu: number;
  /** Weight per unit volume, used by `selfWeight` loads. */
  density?: number;
  /** Mass per unit volume, used by modal analysis. */
  mass?: number;
}

/** Direction of a member load: along a local member axis or a global axis. */
export type MemberLoadDirection =
  'localX' | 'localY' | 'localZ' | 'globalX' | 'globalY' | 'globalZ';

export type GlobalDirection = 'globalX' | 'globalY' | 'globalZ';

export interface NodalLoad3D {
  kind: 'nodal';
  node: string;
  fx?: number;
  fy?: number;
  fz?: number;
  mx?: number;
  my?: number;
  mz?: number;
}

/**
 * Uniform (UDL) or linearly varying load over part or all of a member. Intensities are per
 * unit length of the member, positive along the + axis, for both local and global directions.
 */
export interface MemberDistributedLoad3D {
  kind: 'distributed';
  member: string;
  direction: MemberLoadDirection;
  /** Intensity at the start of the loaded length. */
  w1: number;
  /** Intensity at the end of the loaded length. Defaults to `w1` (uniform). */
  w2?: number;
  /** Distance from node i to the start of the load. Defaults to 0. */
  a?: number;
  /** Distance from node i to the end of the load. Defaults to the member length. */
  b?: number;
}

/** Concentrated force on a member at distance `a` from node i. */
export interface MemberPointLoad3D {
  kind: 'point';
  member: string;
  direction: MemberLoadDirection;
  P: number;
  a: number;
}

/** Concentrated moment on a member about the given axis (right-hand rule). */
export interface MemberMoment3D {
  kind: 'moment';
  member: string;
  direction: MemberLoadDirection;
  M: number;
  a: number;
}

/**
 * Uniform pressure on a plate (force per unit area of the plate), positive along the + axis.
 * `localZ` is the plate normal.
 */
export interface PlatePressure3D {
  kind: 'pressure';
  plate: string;
  direction: 'localZ' | GlobalDirection;
  p: number;
}

/**
 * Concentrated force on a plate at natural coordinates (xi, eta), each in [−1, 1]:
 * (−1, −1) is node 1, (1, −1) node 2, (1, 1) node 3 and (−1, 1) node 4.
 */
export interface PlatePointLoad3D {
  kind: 'platePoint';
  plate: string;
  direction: 'localZ' | GlobalDirection;
  P: number;
  xi: number;
  eta: number;
}

/**
 * Faces of a solid: 1 = nodes 1-2-3-4, 2 = 5-6-7-8, 3 = 1-2-6-5, 4 = 2-3-7-6, 5 = 3-4-8-7,
 * 6 = 4-1-5-8.
 */
export type SolidFace = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Uniform load on one face of a solid, per unit area of the face. `normal` is a pressure:
 * positive pushes into the solid. Global directions are tractions, positive along the + axis.
 */
export interface SolidFaceLoad3D {
  kind: 'face';
  solid: string;
  face: SolidFace;
  direction: 'normal' | GlobalDirection;
  p: number;
}

/**
 * Self-weight of every element that has a `density`: a body force of `factor × density` per
 * unit volume along the given global axis (gravity is `globalY` with factor −1).
 */
export interface SelfWeight3D {
  kind: 'selfWeight';
  direction: GlobalDirection;
  factor: number;
}

export type MemberLoad3D = MemberDistributedLoad3D | MemberPointLoad3D | MemberMoment3D;
export type PlateLoad3D = PlatePressure3D | PlatePointLoad3D;
export type Load3D = NodalLoad3D | MemberLoad3D | PlateLoad3D | SolidFaceLoad3D | SelfWeight3D;

export interface StructureModel3D {
  nodes: Node3D[];
  members?: Member3D[];
  plates?: Plate3D[];
  solids?: Solid3D[];
  supports: Support3D[];
  loads: Load3D[];
}

export interface AnalysisOptions3D {
  /** Number of equal segments each member is divided into for diagrams (default 20). */
  segments?: number;
}

export interface NodeDisplacement3D {
  ux: number;
  uy: number;
  uz: number;
  rx: number;
  ry: number;
  rz: number;
}

export interface Reaction3D {
  fx: number;
  fy: number;
  fz: number;
  mx: number;
  my: number;
  mz: number;
}

/**
 * Values at one section of a member, in local axes.
 *  - `N`  axial force, tension positive.
 *  - `Vy`, `Vz` shear: the sum of the local-y / local-z forces acting on the part of the
 *    member between node i and the section.
 *  - `T`  torque: the local-x moment the j-side part exerts on the i-side part.
 *  - `Mz` bending in the local x–y plane, positive when E·Iz·v″ = Mz (curving towards +y);
 *    `My` bending in the local x–z plane, positive when E·Iy·w″ = My (curving towards +z).
 *    Hence dMz/dx = Vy and dMy/dx = Vz, and a beam in the XY plane gives the same V and M as
 *    the 2D solver.
 *  - `u`, `v`, `w` displacements along local x, y, z; `twist` rotation about local x.
 */
export interface Station3D {
  x: number;
  N: number;
  Vy: number;
  Vz: number;
  T: number;
  My: number;
  Mz: number;
  u: number;
  v: number;
  w: number;
  twist: number;
}

export interface Extreme3D {
  value: number;
  x: number;
}

export interface MemberResult3D {
  id: string;
  length: number;
  /** Unit vectors of the local axes in global coordinates. */
  axes: { x: Vec3; y: Vec3; z: Vec3 };
  /**
   * Forces exerted by the joints on the member ends, in local axes (right-hand rule):
   * [Fx, Fy, Fz, Mx, My, Mz] at node i, then the same six at node j.
   */
  endForces: number[];
  stations: Station3D[];
  /** Largest tension (>= 0) and largest compression (<= 0) along the member. */
  maxAxial: Extreme3D;
  minAxial: Extreme3D;
  maxAbsVy: Extreme3D;
  maxAbsVz: Extreme3D;
  maxAbsTorsion: Extreme3D;
  maxAbsMy: Extreme3D;
  maxAbsMz: Extreme3D;
  /** Largest transverse deflection relative to the chord joining the displaced ends. */
  maxAbsDeflection: Extreme3D;
}

/** In-plane stresses at one surface of a plate, in the plate's local axes. */
export interface SurfaceStress {
  sx: number;
  sy: number;
  txy: number;
  /** Principal stresses, s1 >= s2. */
  s1: number;
  s2: number;
  vonMises: number;
}

/**
 * Stress resultants per unit width at one point of a plate, in the plate's local axes.
 *  - `Nx`, `Ny`, `Nxy` membrane forces (∫σ dz).
 *  - `Mx`, `My`, `Mxy` bending moments (∫σ·z dz): positive `Mx` puts the +z (top) surface in
 *    tension in the local x direction.
 *  - `Qx`, `Qy` transverse shear forces (∫τxz dz, ∫τyz dz).
 * `top` is the surface at z = +t/2, `bottom` at z = −t/2.
 */
export interface PlateStress {
  Nx: number;
  Ny: number;
  Nxy: number;
  Mx: number;
  My: number;
  Mxy: number;
  Qx: number;
  Qy: number;
  top: SurfaceStress;
  bottom: SurfaceStress;
}

export interface PlateResult3D {
  id: string;
  area: number;
  /** Unit vectors of the local axes in global coordinates. */
  axes: { x: Vec3; y: Vec3; z: Vec3 };
  center: PlateStress;
  /** Values at the four nodes, in node order. */
  corners: [PlateStress, PlateStress, PlateStress, PlateStress];
  /** Largest von Mises stress over both surfaces at the centre and corners. */
  maxVonMises: number;
}

/** Stress tensor at one point of a solid, in global axes. */
export interface StressState {
  sxx: number;
  syy: number;
  szz: number;
  txy: number;
  tyz: number;
  tzx: number;
  /** Principal stresses, s1 >= s2 >= s3. */
  s1: number;
  s2: number;
  s3: number;
  vonMises: number;
}

export interface SolidResult3D {
  id: string;
  volume: number;
  center: StressState;
  /** Values at the eight nodes, in node order. */
  corners: StressState[];
  maxVonMises: number;
}

export interface AnalysisResult3D {
  displacements: Record<string, NodeDisplacement3D>;
  /** Reactions at supported nodes (including spring supports). */
  reactions: Record<string, Reaction3D>;
  members: Record<string, MemberResult3D>;
  plates: Record<string, PlateResult3D>;
  solids: Record<string, SolidResult3D>;
  /** Largest translation magnitude anywhere in the structure (nodes and along members). */
  maxDisplacement: number;
  /**
   * Sum of applied loads + reactions; should be ~0.
   * [ΣFx, ΣFy, ΣFz, ΣMx, ΣMy, ΣMz], moments taken about the origin.
   */
  equilibrium: [number, number, number, number, number, number];
  /** Total applied load [ΣFx, ΣFy, ΣFz], useful for checking the load input. */
  appliedLoad: Vec3;
  warnings: string[];
  /** Number of equations solved (free, active degrees of freedom). */
  dofCount: number;
}
