/**
 * IS 800:2007 check of every rolled-steel member of a 3D project.
 *
 * Axis mapping: the section's major axis (Izz) is the member's local z axis (Iz = Izz, see
 * `sectionProps3D`), so Mz and Vy are major-axis bending and its shear (along the web), My and
 * Vz minor-axis bending and its shear (across the flanges). A plane-frame member has My = Vz =
 * T = 0 and gets exactly the checks of the 2D app.
 */
import { checkMember, getSection, STEEL_GRADES } from '../design-codes';
import type { DesignResult } from '../design-codes';
import type { AnalysisResult3D } from '../solver3d';
import { materialOf } from './convert';
import type { Project3D, ProjectMember3D } from './types';

export interface MemberDesign3D {
  memberId: string;
  section: string;
  /** Effective length factors used (member override or project value). */
  kz: number;
  ky: number;
  result: DesignResult;
}

/** Effective length factors of a member: its own override, else the project's. */
export function effectiveLengthFactors(
  project: Project3D,
  member: ProjectMember3D,
): { kz: number; ky: number } {
  return { kz: member.kz ?? project.design.kz, ky: member.ky ?? project.design.ky };
}

/**
 * Runs the check on every member with a rolled ISMB / ISMC section. Members with custom
 * sections are skipped (their plastic moduli and radii of gyration are unknown). The demands
 * are the largest values along the member (not necessarily at the same section), which is
 * conservative; compression governs over tension when both occur.
 */
export function designMembers3D(
  project: Project3D,
  analysis: AnalysisResult3D,
): Record<string, MemberDesign3D> {
  const grade = STEEL_GRADES.find((g) => g.name === project.design.grade) ?? STEEL_GRADES[0];
  const out: Record<string, MemberDesign3D> = {};
  for (const member of project.members) {
    const section = getSection(member.section);
    const forces = analysis.members[member.id];
    if (!section || !forces) continue;
    const compression = forces.minAxial.value;
    const tension = forces.maxAxial.value;
    const axial = compression < -1e-9 ? compression : tension;
    const { kz, ky } = effectiveLengthFactors(project, member);
    out[member.id] = {
      memberId: member.id,
      section: member.section,
      kz,
      ky,
      result: checkMember({
        section,
        grade,
        E: materialOf(project, member.material).E * 1000,
        length: forces.length,
        axial,
        moment: Math.abs(forces.maxAbsMz.value),
        shear: Math.abs(forces.maxAbsVy.value),
        momentY: Math.abs(forces.maxAbsMy.value),
        shearZ: Math.abs(forces.maxAbsVz.value),
        torsion: Math.abs(forces.maxAbsTorsion.value),
        kz,
        ky,
        kLT: ky,
        laterallyRestrained: project.design.laterallyRestrained,
      }),
    };
  }
  return out;
}

const SHORT_LABELS: Record<string, string> = {
  tension: 'Tension',
  compression: 'Compression buckling',
  shear: 'Shear (web)',
  'shear-z': 'Shear (flanges)',
  bending: 'Bending z-z',
  'bending-y': 'Bending y-y',
  biaxial: 'Biaxial bending',
  'interaction-section': 'Axial + bending',
  'buckling-y': 'Buckling y-y + bending',
  'buckling-z': 'Buckling z-z + bending',
  'tension-bending': 'Tension + bending',
};

/** Compact name of a design check for tables, falling back to the full name. */
export function checkLabel3D(id: string, fallback: string): string {
  return SHORT_LABELS[id] ?? fallback;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** Colour for a utilisation ratio: green → amber → red, magenta when the member fails. */
export function utilisationRgb(ratio: number): [number, number, number] {
  if (!Number.isFinite(ratio)) return [156, 163, 175];
  if (ratio > 1) return [192, 38, 211];
  return hslToRgb(140 - 140 * Math.min(Math.max(ratio, 0), 1), 0.78, 0.42);
}

/** CSS colour for a utilisation ratio (comma syntax, which three.js `Color` also parses). */
export function utilisationColor(ratio: number): string {
  const [r, g, b] = utilisationRgb(ratio);
  return `rgb(${r}, ${g}, ${b})`;
}
