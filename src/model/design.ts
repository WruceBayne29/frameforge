import { STEEL_GRADES, checkMember, getSection } from '../design-codes';
import type { DesignResult } from '../design-codes';
import type { AnalysisResult } from '../solver';
import type { Project } from './types';

export interface MemberDesign {
  memberId: string;
  section: string;
  result: DesignResult;
}

/**
 * Runs the IS 800:2007 check on every member that uses a rolled section. Members with
 * custom sections are skipped (their plastic modulus, radii of gyration etc. are unknown).
 */
export function designMembers(
  project: Project,
  analysis: AnalysisResult,
): Record<string, MemberDesign> {
  const grade = STEEL_GRADES.find((g) => g.name === project.design.grade) ?? STEEL_GRADES[0];
  const out: Record<string, MemberDesign> = {};
  for (const member of project.members) {
    const section = getSection(member.section);
    const forces = analysis.members[member.id];
    if (!section || !forces) continue;
    // Compression governs over tension when both occur along the member.
    const compression = forces.minAxial.value;
    const tension = forces.maxAxial.value;
    const axial = compression < -1e-9 ? compression : tension;
    const k = project.design.effectiveLengthFactor;
    out[member.id] = {
      memberId: member.id,
      section: member.section,
      result: checkMember({
        section,
        grade,
        E: project.E * 1000,
        length: forces.length,
        axial,
        moment: Math.abs(forces.maxAbsMoment.value),
        shear: Math.abs(forces.maxAbsShear.value),
        kz: k,
        ky: k,
        kLT: k,
        laterallyRestrained: project.design.laterallyRestrained,
      }),
    };
  }
  return out;
}

const SHORT_LABELS: Record<string, string> = {
  tension: 'Tension',
  compression: 'Compression buckling',
  shear: 'Shear',
  bending: 'Bending',
  'interaction-section': 'Axial + bending',
  'buckling-y': 'Buckling y-y + bending',
  'buckling-z': 'Buckling z-z + bending',
  'tension-bending': 'Tension + bending',
};

/** Compact name of a design check for tables, falling back to the full name. */
export function checkLabel(id: string, fallback: string): string {
  return SHORT_LABELS[id] ?? fallback;
}
