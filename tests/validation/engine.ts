/**
 * The solvers a validation case can run on. Both take and return the 2D shapes, so one set of
 * closed-form checks applies to both:
 *  - `ENGINE_2D`: the original 2D solver, kept in the repository as the reference;
 *  - `PLANE_ENGINE`: the 3D solver in plane-frame mode — the path the app runs.
 */
import { analyze, influenceLine, modalAnalysis } from '../../src/solver';
import { analyze3d, influenceLine3d, modalAnalysis3d } from '../../src/solver3d';
import {
  planeInfluence2D,
  planeModal2D,
  planeModel3D,
  planeResult2D,
  planeTarget,
} from './plane2d';

export interface Engine2D {
  name: string;
  analyze: typeof analyze;
  influenceLine: typeof influenceLine;
  modalAnalysis: typeof modalAnalysis;
}

export const ENGINE_2D: Engine2D = { name: '2D reference', analyze, influenceLine, modalAnalysis };

export const PLANE_ENGINE: Engine2D = {
  name: '3D plane frame',
  analyze: (model, options) => planeResult2D(model, analyze3d(planeModel3D(model), options)),
  influenceLine: (model, target, options = {}) => {
    const mapped = planeTarget(model, target);
    const line = influenceLine3d(planeModel3D(model), mapped.target, options);
    return planeInfluence2D(target, line, mapped.sign);
  },
  modalAnalysis: (model, count, options) =>
    planeModal2D(model, modalAnalysis3d(planeModel3D(model), count, options)),
};
