/**
 * The former 2D project model. The app is 3D only now; this is kept because old 2D files,
 * share links and autosaves are converted with `from2D`, and because the 2D validation and
 * equivalence tests compare the 3D plane-frame results with the original 2D solver.
 */
export { toSolverModel } from './convert';
export { designMembers } from './design';
export type { MemberDesign } from './design';
export { DEFAULT_DESIGN, emptyProject } from './types';
export type * from './types';
