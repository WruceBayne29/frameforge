/**
 * Project-level analysis: converts a project to the solver model and runs the 3D solver. In
 * plane-frame mode the solver model holds every node out of plane (`restrainAll`); those
 * restraints are not supports, so the solver reports reactions only at the real supports.
 */
import { analyze3d } from '../solver3d';
import type { AnalysisOptions3D, AnalysisResult3D } from '../solver3d';
import { isPlane, toSolverModel3D } from './convert';
import type { Project3D } from './types';

/**
 * True when some load has a component out of the XY plane: a force along Z or a moment about
 * X or Y (member loads along local z are out of plane for members lying in the plane with no
 * roll; plate loads along the normal or Z are out of plane for plates in the plane).
 */
export function hasOutOfPlaneLoad(project: Project3D): boolean {
  return project.loads.some((load) => {
    switch (load.kind) {
      case 'nodal':
        return load.fz !== 0 || load.mx !== 0 || load.my !== 0;
      case 'distributed':
        return (
          (load.direction === 'globalZ' || load.direction === 'localZ') &&
          (load.w1 !== 0 || (load.w2 ?? 0) !== 0)
        );
      case 'point':
        return (load.direction === 'globalZ' || load.direction === 'localZ') && load.P !== 0;
      case 'moment':
        return load.direction !== 'globalZ' && load.direction !== 'localZ' && load.M !== 0;
      case 'pressure':
        return (load.direction === 'globalZ' || load.direction === 'localZ') && load.p !== 0;
      case 'platePoint':
        return (load.direction === 'globalZ' || load.direction === 'localZ') && load.P !== 0;
      case 'face':
        return load.direction === 'globalZ' && load.p !== 0;
    }
  });
}

/**
 * Analyses a project. Throws `SolverError` like `analyze3d`. In plane mode, a warning says so
 * when loads have out-of-plane components (the plane restraint carries them).
 */
export function analyzeProject3D(
  project: Project3D,
  options: AnalysisOptions3D = {},
): AnalysisResult3D {
  const result = analyze3d(toSolverModel3D(project), options);
  if (!isPlane(project) || !hasOutOfPlaneLoad(project)) return result;
  return {
    ...result,
    warnings: [
      ...result.warnings,
      'Some loads act out of the XY plane (along Z, or moments about X or Y). In plane frame ' +
        'mode the plane restraint carries them, so they have no effect on the results.',
    ],
  };
}
