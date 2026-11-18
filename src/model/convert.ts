import { getSection } from '../design-codes';
import type { SolverLoad, SolverSupport, StructureModel } from '../solver';
import type { Project, ProjectMember, SupportKind } from './types';

/** kN/m² per GPa */
const GPA = 1e6;
/** m² per cm² */
const CM2 = 1e-4;
/** m⁴ per cm⁴ */
const CM4 = 1e-8;
/** Density of steel, t/m³ (so that kN, m, s units are consistent: 1 t·m/s² = 1 kN). */
const STEEL_DENSITY = 7.85;

export interface SectionProps {
  /** cm² */
  A: number;
  /** cm⁴ */
  I: number;
  /** True when the section comes from the rolled-steel table. */
  rolled: boolean;
}

/** Resolves a section designation to its properties, or undefined if unknown. */
export function sectionProps(project: Project, name: string): SectionProps | undefined {
  const rolled = getSection(name);
  if (rolled) return { A: rolled.A, I: rolled.Izz, rolled: true };
  const custom = project.customSections.find((s) => s.name === name);
  if (custom) return { A: custom.A, I: custom.I, rolled: false };
  return undefined;
}

const RESTRAINTS: Record<SupportKind, { ux: boolean; uy: boolean; rz: boolean }> = {
  fixed: { ux: true, uy: true, rz: true },
  pinned: { ux: true, uy: true, rz: false },
  rollerX: { ux: false, uy: true, rz: false },
  rollerY: { ux: true, uy: false, rz: false },
};

/** Section properties used when a member refers to a section that no longer exists. */
const FALLBACK: SectionProps = { A: 50, I: 5000, rolled: false };

export function memberProps(project: Project, member: ProjectMember): SectionProps {
  return sectionProps(project, member.section) ?? FALLBACK;
}

/** Converts the project (engineering units) into the solver's consistent-unit model. */
export function toSolverModel(project: Project): StructureModel {
  const supports: SolverSupport[] = project.supports.map((s) => ({
    node: s.node,
    ...RESTRAINTS[s.kind],
  }));
  const loads: SolverLoad[] = project.loads.map((load): SolverLoad => {
    switch (load.kind) {
      case 'nodal':
        return { kind: 'nodal', node: load.node, fx: load.fx, fy: load.fy, mz: load.mz };
      case 'distributed':
        return {
          kind: 'distributed',
          member: load.member,
          direction: load.direction,
          w1: load.w1,
          w2: load.w2,
          a: load.a,
          b: load.b,
        };
      case 'point':
        return {
          kind: 'point',
          member: load.member,
          direction: load.direction,
          P: load.P,
          a: load.a,
        };
      case 'moment':
        return { kind: 'moment', member: load.member, M: load.M, a: load.a };
    }
  });
  return {
    nodes: project.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
    members: project.members.map((m) => {
      const props = memberProps(project, m);
      return {
        id: m.id,
        i: m.i,
        j: m.j,
        type: m.type,
        E: project.E * GPA,
        A: props.A * CM2,
        I: props.I * CM4,
        releaseI: m.releaseI,
        releaseJ: m.releaseJ,
        massPerLength: props.A * CM2 * STEEL_DENSITY,
      };
    }),
    supports,
    loads,
  };
}
