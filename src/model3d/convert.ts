/**
 * Conversion of a 3D project (engineering units) into the 3D solver's consistent-unit model
 * (kN, m): GPa → kN/m², cm² → m², cm⁴ → m⁴, mm → m, degrees → radians.
 */
import { getSection } from '../design-codes';
import type { SteelSection } from '../design-codes';
import type { Load3D, Member3D, StructureModel3D, Support3D } from '../solver3d';
import type { Material3D, Project3D, ProjectMember3D, Restraints6 } from './types';
import { GRAVITY, STEEL } from './types';

/** kN/m² per GPa */
const GPA = 1e6;
/** m² per cm² */
const CM2 = 1e-4;
/** m⁴ per cm⁴ */
const CM4 = 1e-8;
/** m per mm */
const MM = 1e-3;

export interface SectionProps3D {
  /** cm² */
  A: number;
  /** Second moment of area about local z (major axis of an upright I-section), cm⁴ */
  Iz: number;
  /** Second moment of area about local y (minor axis), cm⁴ */
  Iy: number;
  /** Torsion constant, cm⁴ */
  J: number;
  /** True when the section comes from the rolled-steel table. */
  rolled: boolean;
}

/**
 * St Venant torsion constant of a rolled I- or channel section treated as a thin-walled open
 * section: Σ b·t³/3 over the two flanges and the web (clear depth between flanges), cm⁴.
 * Fillets and the flange taper are ignored, so this is slightly below handbook values.
 */
export function torsionConstant(section: SteelSection): number {
  const flanges = (2 * section.bf * section.tf ** 3) / 3;
  const web = ((section.D - 2 * section.tf) * section.tw ** 3) / 3;
  return (flanges + web) / 1e4;
}

/** Resolves a section designation to its properties, or undefined if unknown. */
export function sectionProps3D(project: Project3D, name: string): SectionProps3D | undefined {
  const rolled = getSection(name);
  if (rolled) {
    return {
      A: rolled.A,
      Iz: rolled.Izz,
      Iy: rolled.Iyy,
      J: torsionConstant(rolled),
      rolled: true,
    };
  }
  const custom = project.customSections.find((s) => s.name === name);
  if (custom) return { A: custom.A, Iz: custom.Iz, Iy: custom.Iy, J: custom.J, rolled: false };
  return undefined;
}

/** Section properties used when a member refers to a section that no longer exists. */
export const FALLBACK_SECTION_3D: SectionProps3D = {
  A: 50,
  Iz: 5000,
  Iy: 500,
  J: 20,
  rolled: false,
};

export function memberProps3D(project: Project3D, member: ProjectMember3D): SectionProps3D {
  return sectionProps3D(project, member.section) ?? FALLBACK_SECTION_3D;
}

/** The named material; an unknown name falls back to the project's first material. */
export function materialOf(project: Project3D, name: string): Material3D {
  return project.materials.find((m) => m.name === name) ?? project.materials[0] ?? STEEL;
}

/** Shear modulus of an isotropic material, in the units of E. */
export function shearModulus(material: Material3D): number {
  return material.E / (2 * (1 + material.nu));
}

export function supportFromRestraints(node: string, restraints: Restraints6): Support3D {
  const [ux, uy, uz, rx, ry, rz] = restraints;
  return { node, ux, uy, uz, rx, ry, rz };
}

/** True when the project is a plane frame (lies in z = 0 and only moves in that plane). */
export function isPlane(project: Pick<Project3D, 'plane'>): boolean {
  return project.plane === 'XY';
}

/** Mass per unit volume (t/m³) of a material from its weight density (kN/m³). */
export function massDensity(material: Material3D): number {
  return material.density / GRAVITY;
}

/**
 * Converts the project into the solver's model. Each multi-target load becomes one solver
 * load per target; targets (and supports) that refer to something that no longer exists are
 * skipped, so a project that is being edited always converts.
 */
export function toSolverModel3D(project: Project3D): StructureModel3D {
  const nodeIds = new Set(project.nodes.map((n) => n.id));
  const memberIds = new Set(project.members.map((m) => m.id));
  const plateIds = new Set(project.plates.map((p) => p.id));
  const solidIds = new Set(project.solids.map((s) => s.id));

  const members: Member3D[] = project.members.map((m) => {
    const props = memberProps3D(project, m);
    const material = materialOf(project, m.material);
    const member: Member3D = {
      id: m.id,
      i: m.i,
      j: m.j,
      type: m.type,
      E: material.E * GPA,
      G: shearModulus(material) * GPA,
      A: props.A * CM2,
      Iy: props.Iy * CM4,
      Iz: props.Iz * CM4,
      J: props.J * CM4,
      beta: ((m.beta ?? 0) * Math.PI) / 180,
      density: material.density,
      mass: massDensity(material),
    };
    if (m.releaseI) member.releaseI = { ...m.releaseI };
    if (m.releaseJ) member.releaseJ = { ...m.releaseJ };
    return member;
  });

  const loads: Load3D[] = [];
  for (const load of project.loads) {
    switch (load.kind) {
      case 'nodal':
        for (const node of load.nodes) {
          if (!nodeIds.has(node)) continue;
          const { fx, fy, fz, mx, my, mz } = load;
          loads.push({ kind: 'nodal', node, fx, fy, fz, mx, my, mz });
        }
        break;
      case 'distributed':
        for (const member of load.members) {
          if (!memberIds.has(member)) continue;
          const { direction, w1, w2, a, b } = load;
          loads.push({ kind: 'distributed', member, direction, w1, w2, a, b });
        }
        break;
      case 'point':
        for (const member of load.members) {
          if (!memberIds.has(member)) continue;
          loads.push({
            kind: 'point',
            member,
            direction: load.direction,
            P: load.P,
            a: load.a,
          });
        }
        break;
      case 'moment':
        for (const member of load.members) {
          if (!memberIds.has(member)) continue;
          loads.push({
            kind: 'moment',
            member,
            direction: load.direction,
            M: load.M,
            a: load.a,
          });
        }
        break;
      case 'pressure':
        for (const plate of load.plates) {
          if (!plateIds.has(plate)) continue;
          loads.push({ kind: 'pressure', plate, direction: load.direction, p: load.p });
        }
        break;
      case 'platePoint':
        for (const plate of load.plates) {
          if (!plateIds.has(plate)) continue;
          const { direction, P, xi, eta } = load;
          loads.push({ kind: 'platePoint', plate, direction, P, xi, eta });
        }
        break;
      case 'face':
        for (const solid of load.solids) {
          if (!solidIds.has(solid)) continue;
          const { face, direction, p } = load;
          loads.push({ kind: 'face', solid, face, direction, p });
        }
        break;
    }
  }
  if (project.selfWeight) loads.push({ kind: 'selfWeight', direction: 'globalY', factor: -1 });

  return {
    nodes: project.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, z: n.z })),
    members,
    plates: project.plates.map((p) => {
      const material = materialOf(project, p.material);
      return {
        id: p.id,
        nodes: [...p.nodes],
        E: material.E * GPA,
        nu: material.nu,
        t: p.thickness * MM,
        density: material.density,
        mass: massDensity(material),
      };
    }),
    solids: project.solids.map((s) => {
      const material = materialOf(project, s.material);
      return {
        id: s.id,
        nodes: [...s.nodes],
        E: material.E * GPA,
        nu: material.nu,
        density: material.density,
        mass: massDensity(material),
      };
    }),
    supports: project.supports
      .filter((s) => nodeIds.has(s.node))
      .map((s) => supportFromRestraints(s.node, s.restraints)),
    loads,
    ...(isPlane(project) ? { restrainAll: { uz: true, rx: true, ry: true } } : {}),
    ...(project.masses && project.masses.length > 0
      ? { masses: project.masses.filter((m) => nodeIds.has(m.node)).map((m) => ({ ...m })) }
      : {}),
  };
}
