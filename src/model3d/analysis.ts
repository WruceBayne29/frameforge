/**
 * Project-level analysis: converts a project to the solver model, runs the 3D solver and
 * tidies the result for display. In plane-frame mode the solver holds every node out of plane;
 * those hidden restraints are dropped from the reactions so only the real supports show.
 */
import { analyze3d } from '../solver3d';
import type { AnalysisOptions3D, AnalysisResult3D, Reaction3D } from '../solver3d';
import { isPlane, toSolverModel3D } from './convert';
import type { Project3D } from './types';

/** Relative size below which out-of-plane reactions count as round-off. */
const OUT_OF_PLANE_TOLERANCE = 1e-9;

/**
 * Reactions at the project's own supports. In plane mode, a node the plane restraint holds
 * but the user did not support is not a reaction point.
 */
export function supportReactions(
  project: Project3D,
  result: AnalysisResult3D,
): Record<string, Reaction3D> {
  if (!isPlane(project)) return result.reactions;
  const out: Record<string, Reaction3D> = {};
  for (const s of project.supports) {
    const r = result.reactions[s.node];
    if (r && s.restraints.some(Boolean)) out[s.node] = r;
  }
  return out;
}

/**
 * Analyses a project. Throws `SolverError` like `analyze3d`. In plane mode, a warning says so
 * when loads had out-of-plane components (the plane restraint carried them).
 */
export function analyzeProject3D(
  project: Project3D,
  options: AnalysisOptions3D = {},
): AnalysisResult3D {
  const result = analyze3d(toSolverModel3D(project), options);
  if (!isPlane(project)) return result;
  let inPlane = 0;
  let outOfPlane = 0;
  for (const r of Object.values(result.reactions)) {
    inPlane = Math.max(inPlane, Math.abs(r.fx), Math.abs(r.fy), Math.abs(r.mz));
    outOfPlane = Math.max(outOfPlane, Math.abs(r.fz), Math.abs(r.mx), Math.abs(r.my));
  }
  const warnings = [...result.warnings];
  if (outOfPlane > OUT_OF_PLANE_TOLERANCE * Math.max(inPlane, 1)) {
    warnings.push(
      'Some loads act out of the XY plane (along Z, or moments about X or Y). In plane frame ' +
        'mode the plane restraint carries them, so they have no effect on the results.',
    );
  }
  return { ...result, reactions: supportReactions(project, result), warnings };
}
