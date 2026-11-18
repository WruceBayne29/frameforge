/**
 * Influence lines in 3D: the value of one response (a reaction, a displacement or an internal
 * force at a section of a member) as a unit load moves along a path of members. The stiffness
 * is factorised once; every load position is one more right-hand side.
 */
import { SolverError } from './errors';
import { assembleStiffness, pickDofs, prepareSystem } from './analyze';
import { lineElement, lineForcesAt } from './line';
import type { LineElement } from './line';
import type { Dof6, GlobalDirection, MemberLoadDirection, StructureModel3D } from './types';

export type ReactionComponent3D = 'fx' | 'fy' | 'fz' | 'mx' | 'my' | 'mz';
export type ForceComponent3D = 'N' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz';

export type InfluenceTarget3D =
  | { kind: 'reaction'; node: string; component: ReactionComponent3D }
  | { kind: 'displacement'; node: string; component: Dof6 }
  | { kind: 'memberForce'; member: string; x: number; component: ForceComponent3D };

export interface InfluenceOptions3D {
  /** Members the unit load travels along. Defaults to every member. */
  path?: string[];
  /** Load positions per member, including both ends (default 11). */
  pointsPerMember?: number;
  /** Direction of the load (default global Y). */
  direction?: MemberLoadDirection;
  /** Magnitude and sense (default −1: a unit load acting downward along −Y). */
  magnitude?: number;
}

export interface InfluenceOrdinate3D {
  member: string;
  /** Distance of the load from node i of the member. */
  x: number;
  value: number;
}

export interface InfluenceLine3D {
  target: InfluenceTarget3D;
  ordinates: InfluenceOrdinate3D[];
  max: InfluenceOrdinate3D;
  min: InfluenceOrdinate3D;
}

const REACTION_INDEX: Record<ReactionComponent3D, number> = {
  fx: 0,
  fy: 1,
  fz: 2,
  mx: 3,
  my: 4,
  mz: 5,
};
const DOF_INDEX: Record<Dof6, number> = { ux: 0, uy: 1, uz: 2, rx: 3, ry: 4, rz: 5 };

const invalid = (message: string): never => {
  throw new SolverError('INVALID_MODEL', message);
};

/**
 * Influence line of `target` for a load of `magnitude` along `direction` moving over the
 * members of the path. At a section that the load sits on exactly, internal forces are taken
 * just before the section (the left limit), as the 2D app did. Throws `SolverError` for an
 * invalid model or target, or a structure the load would turn into a mechanism.
 */
export function influenceLine3d(
  model: StructureModel3D,
  target: InfluenceTarget3D,
  options: InfluenceOptions3D = {},
): InfluenceLine3D {
  const sys = prepareSystem({ ...model, loads: [] });
  const { nodeIndex, equation, neq, ndof, restrained, springs, position } = sys;
  const lineOf = new Map(sys.lines.map((placed) => [placed.el.member.id, placed]));
  if (target.kind === 'memberForce') {
    const line = lineOf.get(target.member);
    if (!line) invalid(`Member "${target.member}" does not exist.`);
    else if (!(target.x >= 0 && target.x <= line.el.L + 1e-9)) {
      invalid(`The section must lie on member "${target.member}" (0 to ${line.el.L} m).`);
    }
  } else if (!nodeIndex.has(target.node)) {
    invalid(`Node "${target.node}" does not exist.`);
  }
  const path = options.path ?? [...lineOf.keys()];
  if (path.length === 0) invalid('The load path is empty.');
  for (const id of path) {
    if (!lineOf.has(id)) invalid(`Member "${id}" on the load path does not exist.`);
  }
  const points = Math.max(2, Math.round(options.pointsPerMember ?? 11));
  const direction = options.direction ?? ('globalY' satisfies GlobalDirection);
  const magnitude = options.magnitude ?? -1;

  const K = assembleStiffness(sys);
  const held = K.factor({ onSingular: 'restrain' }).singular;
  for (const e of held) {
    const dof = sys.dofOfEquation[e];
    if (dof % 6 < 3) {
      const node = sys.nodes[Math.floor(dof / 6)];
      throw new SolverError(
        'UNSTABLE',
        `The structure is unstable (a mechanism at node "${node.id}"), so a moving load ` +
          'cannot be carried. Check the supports and releases.',
        { nodeId: node.id },
      );
    }
  }

  // Elements meeting the target node (for reactions).
  const targetNode = target.kind === 'memberForce' ? -1 : (nodeIndex.get(target.node) as number);
  const atNode =
    target.kind === 'reaction' ? sys.all.filter(({ el }) => el.nodes.includes(target.node)) : [];

  const ordinates: InfluenceOrdinate3D[] = [];
  const zero: [number, number, number] = [0, 0, 0];
  for (const id of path) {
    const placed = lineOf.get(id) as { el: LineElement; dofs: number[] };
    const { member, L } = placed.el;
    for (let k = 0; k < points; k++) {
      const x = (L * k) / (points - 1);
      const loaded = lineElement(
        member,
        position(member.i),
        position(member.j),
        [{ kind: 'point', member: id, direction, P: magnitude, a: x }],
        zero,
      );
      const rhs = new Float64Array(neq);
      placed.dofs.forEach((dof, a) => {
        const e = equation[dof];
        if (e >= 0) rhs[e] += loaded.f[a];
      });
      const solution = K.solve(rhs);
      const u = new Float64Array(ndof);
      for (let e = 0; e < neq; e++) u[sys.dofOfEquation[e]] = solution[e];

      let value = 0;
      if (target.kind === 'displacement') {
        value = u[6 * targetNode + DOF_INDEX[target.component]];
      } else if (target.kind === 'reaction') {
        const dof = 6 * targetNode + REACTION_INDEX[target.component];
        if (restrained[dof]) {
          for (const { el, dofs } of atNode) {
            const a = dofs.indexOf(dof);
            if (a < 0) continue;
            const isLoaded = el === placed.el;
            const row = (isLoaded ? loaded : el).k[a];
            let sum = -(isLoaded ? loaded.f[a] : el.f[a]);
            dofs.forEach((d, b) => {
              sum += row[b] * u[d];
            });
            value += sum;
          }
        } else if (springs[dof] > 0) {
          value = -springs[dof] * u[dof];
        }
      } else {
        const t = lineOf.get(target.member) as { el: LineElement; dofs: number[] };
        const el = target.member === id ? loaded : t.el;
        value = lineForcesAt(el, pickDofs(u, t.dofs), target.x, -1)[target.component];
      }
      ordinates.push({ member: id, x, value });
    }
  }
  let max = ordinates[0];
  let min = ordinates[0];
  for (const o of ordinates) {
    if (o.value > max.value) max = o;
    if (o.value < min.value) min = o;
  }
  return { target, ordinates, max, min };
}
