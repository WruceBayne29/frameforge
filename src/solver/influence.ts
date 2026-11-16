/**
 * Influence lines: the value of one response (a reaction, an internal force at a section or a
 * displacement) as a unit load moves across the structure. Computed directly from the
 * definition — one analysis per load position.
 */
import { analyze } from './analyze';
import { SolverError } from './errors';
import type { AnalysisResult, LoadDirection, StructureModel } from './types';

export type InfluenceTarget =
  | { kind: 'reaction'; node: string; component: 'fx' | 'fy' | 'mz' }
  | { kind: 'memberForce'; member: string; x: number; component: 'N' | 'V' | 'M' }
  | { kind: 'displacement'; node: string; component: 'ux' | 'uy' | 'rz' };

export interface InfluenceOptions {
  /** Members the unit load travels along. Defaults to every member. */
  path?: string[];
  /** Load positions per member, including both ends (default 11). */
  pointsPerMember?: number;
  /** Direction of the unit load (default global Y). */
  direction?: LoadDirection;
  /** Magnitude and sense of the load (default −1: a unit load acting downward). */
  magnitude?: number;
}

export interface InfluenceOrdinate {
  member: string;
  /** Distance of the load from the start of the member. */
  x: number;
  value: number;
}

export interface InfluenceLine {
  target: InfluenceTarget;
  ordinates: InfluenceOrdinate[];
  max: InfluenceOrdinate;
  min: InfluenceOrdinate;
}

/** Internal force at a section, interpolated between the stations either side of it. */
function sectionForce(
  result: AnalysisResult,
  member: string,
  x: number,
  component: 'N' | 'V' | 'M',
): number {
  const stations = result.members[member].stations;
  let k = 0;
  while (k < stations.length - 2 && stations[k + 1].x < x) k++;
  const a = stations[k];
  const b = stations[k + 1];
  if (b.x - a.x < 1e-12) return a[component];
  const t = Math.min(1, Math.max(0, (x - a.x) / (b.x - a.x)));
  return a[component] + (b[component] - a[component]) * t;
}

function response(result: AnalysisResult, target: InfluenceTarget): number {
  switch (target.kind) {
    case 'reaction':
      return result.reactions[target.node]?.[target.component] ?? 0;
    case 'displacement':
      return result.displacements[target.node][target.component];
    case 'memberForce':
      return sectionForce(result, target.member, target.x, target.component);
  }
}

export function influenceLine(
  model: StructureModel,
  target: InfluenceTarget,
  options: InfluenceOptions = {},
): InfluenceLine {
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const members = new Map(model.members.map((m) => [m.id, m]));
  if (target.kind === 'memberForce') {
    if (!members.has(target.member)) {
      throw new SolverError('INVALID_MODEL', `Member "${target.member}" does not exist.`);
    }
  } else if (!nodes.has(target.node)) {
    throw new SolverError('INVALID_MODEL', `Node "${target.node}" does not exist.`);
  }
  const path = options.path ?? model.members.map((m) => m.id);
  const points = Math.max(2, Math.round(options.pointsPerMember ?? 11));
  const direction = options.direction ?? 'globalY';
  const magnitude = options.magnitude ?? -1;

  const ordinates: InfluenceOrdinate[] = [];
  for (const id of path) {
    const member = members.get(id);
    const a = member && nodes.get(member.i);
    const b = member && nodes.get(member.j);
    if (!member || !a || !b) {
      throw new SolverError('INVALID_MODEL', `Member "${id}" on the load path does not exist.`);
    }
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    for (let k = 0; k < points; k++) {
      const x = (length * k) / (points - 1);
      const result = analyze(
        {
          ...model,
          loads: [{ kind: 'point', member: id, direction, P: magnitude, a: x }],
        },
        { segments: 8 },
      );
      ordinates.push({ member: id, x, value: response(result, target) });
    }
  }
  if (ordinates.length === 0) {
    throw new SolverError('INVALID_MODEL', 'The load path is empty.');
  }
  let max = ordinates[0];
  let min = ordinates[0];
  for (const o of ordinates) {
    if (o.value > max.value) max = o;
    if (o.value < min.value) min = o;
  }
  return { target, ordinates, max, min };
}
