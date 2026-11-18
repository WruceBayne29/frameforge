/**
 * Application-level project model. Units: kN, m, kN·m; E in GPa; section area in cm²,
 * second moment of area in cm⁴; displacements reported by the solver in m.
 */
import type { LoadDirection, MemberType } from '../solver';

export type { LoadDirection, MemberType };

export interface ProjectNode {
  id: string;
  x: number;
  y: number;
}

/**
 * `rollerX` rolls along X (restrains Y only); `rollerY` rolls along Y (restrains X only).
 */
export type SupportKind = 'fixed' | 'pinned' | 'rollerX' | 'rollerY';

export interface ProjectSupport {
  node: string;
  kind: SupportKind;
}

export interface ProjectMember {
  id: string;
  i: string;
  j: string;
  type: MemberType;
  /** Section designation: a rolled section (e.g. "ISMB 300") or a custom section name. */
  section: string;
  releaseI?: boolean;
  releaseJ?: boolean;
}

export interface CustomSection {
  name: string;
  /** cm² */
  A: number;
  /** cm⁴ */
  I: number;
}

export interface NodalLoadP {
  id: string;
  kind: 'nodal';
  node: string;
  fx: number;
  fy: number;
  mz: number;
}

export interface DistributedLoadP {
  id: string;
  kind: 'distributed';
  member: string;
  direction: LoadDirection;
  w1: number;
  w2?: number;
  a?: number;
  b?: number;
}

export interface PointLoadP {
  id: string;
  kind: 'point';
  member: string;
  direction: LoadDirection;
  P: number;
  a: number;
}

export interface MomentLoadP {
  id: string;
  kind: 'moment';
  member: string;
  M: number;
  a: number;
}

export type ProjectLoad = NodalLoadP | DistributedLoadP | PointLoadP | MomentLoadP;

export interface DesignSettings {
  /** Steel grade name from the IS 2062 table, e.g. "E250". */
  grade: string;
  /** Compression flange laterally restrained (no lateral-torsional buckling). */
  laterallyRestrained: boolean;
  /** Effective length factor applied to both buckling axes. */
  effectiveLengthFactor: number;
}

export interface Project {
  version: 1;
  name: string;
  description?: string;
  /** Young's modulus, GPa. */
  E: number;
  nodes: ProjectNode[];
  members: ProjectMember[];
  supports: ProjectSupport[];
  loads: ProjectLoad[];
  customSections: CustomSection[];
  design: DesignSettings;
}

export const DEFAULT_DESIGN: DesignSettings = {
  grade: 'E250',
  laterallyRestrained: false,
  effectiveLengthFactor: 1,
};

export function emptyProject(name = 'Untitled'): Project {
  return {
    version: 1,
    name,
    E: 200,
    nodes: [],
    members: [],
    supports: [],
    loads: [],
    customSections: [],
    design: { ...DEFAULT_DESIGN },
  };
}
