/**
 * The solvers a validation case can run on. Both take and return the 2D shapes, so one set of
 * closed-form checks applies to both:
 *  - `ENGINE_2D`: the original 2D solver, kept in the repository as the reference;
 *  - `PLANE_ENGINE`: the 3D solver in plane-frame mode — the path the app runs.
 */
import { analyze, influenceLine, modalAnalysis } from '../../src/solver';
import { analyze3d } from '../../src/solver3d';
import { planeModel3D, planeResult2D } from './plane2d';

export interface Engine2D {
  name: string;
  analyze: typeof analyze;
  influenceLine: typeof influenceLine;
  modalAnalysis: typeof modalAnalysis;
}

export const ENGINE_2D: Engine2D = { name: '2D reference', analyze, influenceLine, modalAnalysis };

const notYet = (what: string) => () => {
  throw new Error(`${what} is not available in plane mode yet`);
};

export const PLANE_ENGINE: Engine2D = {
  name: '3D plane frame',
  analyze: (model, options) => planeResult2D(model, analyze3d(planeModel3D(model), options)),
  influenceLine: notYet('influenceLine'),
  modalAnalysis: notYet('modalAnalysis'),
};
