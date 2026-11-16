/**
 * Solver data model. The solver is unit-agnostic: any consistent unit system works
 * (e.g. kN, m, kN/m², m², m⁴). Global axes: X to the right, Y up, rotations
 * counter-clockwise positive. Each node has three degrees of freedom (ux, uy, rz).
 */

export interface SolverNode {
  id: string;
  x: number;
  y: number;
}

export interface SolverSupport {
  node: string;
  /** Restrain translation along global X. */
  ux?: boolean;
  /** Restrain translation along global Y. */
  uy?: boolean;
  /** Restrain rotation about Z. */
  rz?: boolean;
  /** Prescribed displacements of restrained DOFs (support settlement). */
  settlement?: { ux?: number; uy?: number; rz?: number };
  /** Elastic spring stiffnesses on otherwise free DOFs. */
  spring?: { kx?: number; ky?: number; kr?: number };
}

export type MemberType = 'frame' | 'truss';

export interface SolverMember {
  id: string;
  /** Start node id. Local x runs from i to j; local y is 90° counter-clockwise from x. */
  i: string;
  /** End node id. */
  j: string;
  /** `frame` carries axial force, shear and bending; `truss` is pin-ended (axial only). */
  type: MemberType;
  /** Young's modulus. */
  E: number;
  /** Cross-sectional area. */
  A: number;
  /** Second moment of area (ignored for the stiffness of truss members). */
  I: number;
  /** Moment release (internal hinge) at the start node. Frame members only. */
  releaseI?: boolean;
  /** Moment release (internal hinge) at the end node. Frame members only. */
  releaseJ?: boolean;
  /** Mass per unit length — only used by modal analysis. */
  massPerLength?: number;
}

/**
 * Direction of a member load. `local*` follow the member axes, `global*` follow the
 * global axes (intensity is per unit length of member, like self-weight).
 */
export type LoadDirection = 'localX' | 'localY' | 'globalX' | 'globalY';

export interface NodalLoad {
  kind: 'nodal';
  node: string;
  fx?: number;
  fy?: number;
  mz?: number;
}

/** Linearly varying (or uniform) distributed load over part or all of a member. */
export interface DistributedLoad {
  kind: 'distributed';
  member: string;
  direction: LoadDirection;
  /** Intensity at the start of the loaded length (positive along the +axis). */
  w1: number;
  /** Intensity at the end of the loaded length. Defaults to `w1` (uniform). */
  w2?: number;
  /** Distance from node i to the start of the load. Defaults to 0. */
  a?: number;
  /** Distance from node i to the end of the load. Defaults to the member length. */
  b?: number;
}

export interface MemberPointLoad {
  kind: 'point';
  member: string;
  direction: LoadDirection;
  P: number;
  /** Distance from node i. */
  a: number;
}

export interface MemberMoment {
  kind: 'moment';
  member: string;
  /** Counter-clockwise positive. */
  M: number;
  /** Distance from node i. */
  a: number;
}

export type MemberLoad = DistributedLoad | MemberPointLoad | MemberMoment;
export type SolverLoad = NodalLoad | MemberLoad;

export interface StructureModel {
  nodes: SolverNode[];
  members: SolverMember[];
  supports: SolverSupport[];
  loads: SolverLoad[];
}

export interface AnalysisOptions {
  /** Number of equal segments each member is divided into for diagrams (default 20). */
  segments?: number;
}

export interface NodeDisplacement {
  ux: number;
  uy: number;
  rz: number;
}

export interface Reaction {
  fx: number;
  fy: number;
  mz: number;
}

/**
 * Values at one section of a member. Sign conventions: `N` tension positive; `V` is the
 * sum of local-y forces to the left of the section; `M` sagging positive (EI·v'' = M).
 * `u`/`v` are displacements along local x / local y.
 */
export interface Station {
  x: number;
  N: number;
  V: number;
  M: number;
  u: number;
  v: number;
}

export interface Extreme {
  value: number;
  x: number;
}

export interface MemberResult {
  id: string;
  length: number;
  /** Direction cosines of the local x axis. */
  cos: number;
  sin: number;
  /**
   * Forces exerted by the joints on the member ends in local axes:
   * [Fx_i, Fy_i, Mz_i, Fx_j, Fy_j, Mz_j].
   */
  endForces: [number, number, number, number, number, number];
  /** Internal forces at the two ends in the diagram sign convention. */
  start: { N: number; V: number; M: number };
  end: { N: number; V: number; M: number };
  stations: Station[];
  maxMoment: Extreme;
  minMoment: Extreme;
  maxAbsMoment: Extreme;
  maxAbsShear: Extreme;
  /** Largest tension (>= 0) and largest compression (<= 0) along the member. */
  maxAxial: Extreme;
  minAxial: Extreme;
  /** Largest transverse deflection relative to the undeformed member (local v). */
  maxAbsDeflection: Extreme;
}

export interface AnalysisResult {
  displacements: Record<string, NodeDisplacement>;
  /** Reactions at supported nodes (including spring supports). */
  reactions: Record<string, Reaction>;
  members: Record<string, MemberResult>;
  /** Largest nodal translation magnitude. */
  maxDisplacement: number;
  /** Sum of applied loads + reactions; should be ~0. [ΣFx, ΣFy, ΣM about origin]. */
  equilibrium: [number, number, number];
  warnings: string[];
  dofCount: number;
}
