/**
 * The 2D validation problems run through the 3D solver in plane-frame mode.
 *
 * `planeModel3D` turns a 2D solver model into the 3D solver model a plane-frame project
 * produces: the same rules as `from2D` (frame → beam with releases about local z, local-y
 * loads flipped on members whose 3D "web up" axis is opposite to the 2D one, moments about
 * global Z) plus the plane restraint (uz, rx, ry held at every node, as `toSolverModel3D`
 * does for `plane: 'XY'`). `planeResult2D` reads the 3D result back in the 2D result shape so
 * the same closed-form checks apply to both solvers.
 */
import type {
  AnalysisResult,
  Extreme,
  MemberResult,
  Station,
  StructureModel,
} from '../../src/solver';
import type {
  AnalysisResult3D,
  Load3D,
  Member3D,
  StructureModel3D,
  Support3D,
} from '../../src/solver3d';

/** Shear modulus used for the (inactive) torsion of plane beams. */
const G_RATIO = 1 / 2.6;

/** Members whose 3D local y points opposite to their 2D local y: axis with a −X component. */
export function flippedMembers(model: StructureModel): Set<string> {
  const pos = new Map(model.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  for (const m of model.members) {
    const a = pos.get(m.i);
    const b = pos.get(m.j);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 0 && (b.x - a.x) / length <= -1e-9) out.add(m.id);
  }
  return out;
}

export function planeModel3D(model: StructureModel): StructureModel3D {
  const flipped = flippedMembers(model);
  const members: Member3D[] = model.members.map((m) => {
    const member: Member3D = {
      id: m.id,
      i: m.i,
      j: m.j,
      type: m.type === 'truss' ? 'truss' : 'beam',
      E: m.E,
      A: m.A,
    };
    if (m.type !== 'truss') {
      Object.assign(member, { G: m.E * G_RATIO, Iz: m.I, Iy: m.I, J: m.I });
      if (m.releaseI) member.releaseI = { mz: true };
      if (m.releaseJ) member.releaseJ = { mz: true };
    }
    if (m.massPerLength !== undefined) member.mass = m.massPerLength / m.A;
    return member;
  });
  const own = new Map(model.supports.map((s) => [s.node, s]));
  const supports: Support3D[] = model.nodes.map((n) => {
    const s = own.get(n.id);
    const support: Support3D = {
      node: n.id,
      ux: !!s?.ux,
      uy: !!s?.uy,
      uz: true,
      rx: true,
      ry: true,
      rz: !!s?.rz,
    };
    if (s?.settlement) {
      support.settlement = {
        ux: s.settlement.ux,
        uy: s.settlement.uy,
        rz: s.settlement.rz,
      };
    }
    if (s?.spring) {
      support.spring = { ux: s.spring.kx, uy: s.spring.ky, rz: s.spring.kr };
    }
    return support;
  });
  const loads: Load3D[] = model.loads.map((load): Load3D => {
    switch (load.kind) {
      case 'nodal':
        return { kind: 'nodal', node: load.node, fx: load.fx, fy: load.fy, mz: load.mz };
      case 'distributed': {
        const s = load.direction === 'localY' && flipped.has(load.member) ? -1 : 1;
        return {
          kind: 'distributed',
          member: load.member,
          direction: load.direction,
          w1: s * load.w1,
          w2: load.w2 === undefined ? undefined : s * load.w2,
          a: load.a,
          b: load.b,
        };
      }
      case 'point': {
        const s = load.direction === 'localY' && flipped.has(load.member) ? -1 : 1;
        return {
          kind: 'point',
          member: load.member,
          direction: load.direction,
          P: s * load.P,
          a: load.a,
        };
      }
      case 'moment':
        return { kind: 'moment', member: load.member, direction: 'globalZ', M: load.M, a: load.a };
    }
  });
  return {
    nodes: model.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, z: 0 })),
    members,
    supports,
    loads,
  };
}

function extreme(stations: Station[], pick: (s: Station) => number, sign: 1 | -1): Extreme {
  let best = stations[0];
  for (const s of stations) if (sign * pick(s) > sign * pick(best)) best = s;
  return { value: pick(best), x: best.x };
}

function absExtreme(stations: Station[], pick: (s: Station) => number): Extreme {
  let best = stations[0];
  for (const s of stations) if (Math.abs(pick(s)) > Math.abs(pick(best))) best = s;
  return { value: pick(best), x: best.x };
}

/** The 3D plane-frame result in the 2D result shape. */
export function planeResult2D(model: StructureModel, r: AnalysisResult3D): AnalysisResult {
  const flipped = flippedMembers(model);
  const displacements: AnalysisResult['displacements'] = {};
  for (const [id, d] of Object.entries(r.displacements)) {
    displacements[id] = { ux: d.ux, uy: d.uy, rz: d.rz };
  }
  const reactions: AnalysisResult['reactions'] = {};
  for (const s of model.supports) {
    const q = r.reactions[s.node];
    if (q && (s.ux || s.uy || s.rz || s.spring))
      reactions[s.node] = { fx: q.fx, fy: q.fy, mz: q.mz };
  }
  const members: Record<string, MemberResult> = {};
  for (const m of model.members) {
    const q = r.members[m.id];
    const s = flipped.has(m.id) ? -1 : 1;
    const stations: Station[] = q.stations.map((st) => ({
      x: st.x,
      N: st.N,
      V: s * st.Vy,
      M: s * st.Mz,
      u: st.u,
      v: s * st.v,
    }));
    const f = q.endForces;
    const first = stations[0];
    const last = stations[stations.length - 1];
    members[m.id] = {
      id: m.id,
      length: q.length,
      cos: q.axes.x[0],
      sin: q.axes.x[1],
      endForces: [f[0], s * f[1], s * f[5], f[6], s * f[7], s * f[11]],
      start: { N: first.N, V: first.V, M: first.M },
      end: { N: last.N, V: last.V, M: last.M },
      stations,
      maxMoment: extreme(stations, (x) => x.M, 1),
      minMoment: extreme(stations, (x) => x.M, -1),
      maxAbsMoment: absExtreme(stations, (x) => x.M),
      maxAbsShear: absExtreme(stations, (x) => x.V),
      maxAxial: extreme(stations, (x) => x.N, 1),
      minAxial: extreme(stations, (x) => x.N, -1),
      maxAbsDeflection: absExtreme(stations, (x) => x.v),
    };
  }
  return {
    displacements,
    reactions,
    members,
    maxDisplacement: r.maxDisplacement,
    equilibrium: [r.equilibrium[0], r.equilibrium[1], r.equilibrium[5]],
    warnings: r.warnings,
    dofCount: r.dofCount,
  };
}
