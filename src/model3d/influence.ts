/**
 * Project-level influence lines: a unit load (default −Y) moves along the near-horizontal
 * members — in plane frame mode, the beams — and the chosen response is recorded.
 */
import { influenceLine3d } from '../solver3d';
import type { InfluenceLine3D, InfluenceTarget3D } from '../solver3d';
import { toSolverModel3D } from './convert';
import type { Project3D } from './types';

/** Members a moving load would normally run along: the roughly horizontal ones. */
export function defaultLoadPath3D(project: Project3D): string[] {
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const flat = project.members.filter((m) => {
    const a = nodes.get(m.i);
    const b = nodes.get(m.j);
    if (!a || !b) return false;
    return Math.abs(b.y - a.y) <= 0.5 * Math.hypot(b.x - a.x, b.z - a.z);
  });
  return (flat.length > 0 ? flat : project.members).map((m) => m.id);
}

export function influenceProject3D(
  project: Project3D,
  target: InfluenceTarget3D,
  path = defaultLoadPath3D(project),
  pointsPerMember = 13,
): InfluenceLine3D {
  return influenceLine3d(toSolverModel3D(project), target, { path, pointsPerMember });
}
