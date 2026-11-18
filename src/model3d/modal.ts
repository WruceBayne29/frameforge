/**
 * Project-level modal analysis: masses come from the material densities (weight density / g)
 * plus the project's lumped nodal masses; beam members are subdivided so the higher modes
 * are accurate, as in the 2D app.
 */
import { memberAxes, modalAnalysis3d } from '../solver3d';
import type { AnalysisResult3D, Mode3D, ModalResult3D, Vec3 } from '../solver3d';
import { toSolverModel3D } from './convert';
import type { Project3D } from './types';

/** Elements per beam member: finer for small models, none for large ones (as in 2D). */
export function defaultSubdivision(project: Project3D): number {
  const count = project.members.length;
  if (count <= 12) return 6;
  if (count <= 30) return 3;
  if (count <= 150) return 2;
  return 1;
}

export function modalProject3D(
  project: Project3D,
  count = 6,
  subdivide = defaultSubdivision(project),
): ModalResult3D {
  return modalAnalysis3d(toSolverModel3D(project), count, { subdivide });
}

/**
 * A mode shape dressed up as an analysis result (displacements and member deflections only,
 * no forces), so the viewer can draw — and animate — it like a deflected shape.
 */
export function modeAsResult(project: Project3D, mode: Mode3D): AnalysisResult3D {
  const pos = new Map(project.nodes.map((n) => [n.id, [n.x, n.y, n.z] as Vec3]));
  const members: AnalysisResult3D['members'] = {};
  let maxDisplacement = 0;
  for (const d of Object.values(mode.displacements)) {
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(d.ux, d.uy, d.uz));
  }
  const none = { value: 0, x: 0 };
  for (const m of project.members) {
    const list = mode.members[m.id];
    const a = pos.get(m.i);
    const b = pos.get(m.j);
    if (!list || !a || !b) continue;
    const axes = memberAxes(a, b, m.type === 'truss' ? 0 : ((m.beta ?? 0) * Math.PI) / 180);
    for (const p of list) maxDisplacement = Math.max(maxDisplacement, Math.hypot(p.u, p.v, p.w));
    members[m.id] = {
      id: m.id,
      length: axes.L,
      axes: { x: axes.x, y: axes.y, z: axes.z },
      endForces: new Array<number>(12).fill(0),
      stations: list.map((p) => ({
        x: p.x,
        N: 0,
        Vy: 0,
        Vz: 0,
        T: 0,
        My: 0,
        Mz: 0,
        u: p.u,
        v: p.v,
        w: p.w,
        twist: 0,
      })),
      maxAxial: none,
      minAxial: none,
      maxAbsVy: none,
      maxAbsVz: none,
      maxAbsTorsion: none,
      maxAbsMy: none,
      maxAbsMz: none,
      maxAbsDeflection: none,
    };
  }
  return {
    displacements: mode.displacements,
    reactions: {},
    members,
    plates: {},
    solids: {},
    maxDisplacement,
    equilibrium: [0, 0, 0, 0, 0, 0],
    appliedLoad: [0, 0, 0],
    warnings: [],
    dofCount: 0,
  };
}
