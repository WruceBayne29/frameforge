/**
 * Analysis results as plain JSON for other software (the JavaScript API and the command-line
 * analyser). Units: kN, m, kN·m, rad. See docs/IMPORT.md for the meaning of each field.
 */
import { analyzeProject3D } from '../model3d/analysis';
import type { AnalysisResult3D } from '../solver3d';
import type { Project3D } from '../model3d/types';

export interface SectionForces {
  N: number;
  Vy: number;
  Vz: number;
  T: number;
  My: number;
  Mz: number;
}

export interface ResultsJson {
  format: 'frameforge-results';
  version: 1;
  units: { force: 'kN'; length: 'm'; moment: 'kN·m'; rotation: 'rad'; stress: 'kN/m²' };
  model: {
    name: string;
    plane: boolean;
    nodes: number;
    members: number;
    plates: number;
    solids: number;
  };
  warnings: string[];
  maxDisplacement: number;
  appliedLoad: [number, number, number];
  equilibrium: [number, number, number, number, number, number];
  displacements: Record<
    string,
    { ux: number; uy: number; uz: number; rx: number; ry: number; rz: number }
  >;
  reactions: Record<
    string,
    { fx: number; fy: number; fz: number; mx: number; my: number; mz: number }
  >;
  members: Record<
    string,
    {
      length: number;
      /** Internal forces at the start (i) and end (j) of the member, local axes. */
      start: SectionForces;
      end: SectionForces;
      /** Forces the joints exert on the member ends, local axes: [Fx…Mz]_i, [Fx…Mz]_j. */
      endForces: number[];
      max: {
        tension: number;
        compression: number;
        Vy: number;
        Vz: number;
        T: number;
        My: number;
        Mz: number;
        deflection: number;
      };
      stations?: Array<SectionForces & { x: number; u: number; v: number; w: number }>;
    }
  >;
  plates: Record<string, { maxVonMises: number }>;
  solids: Record<string, { maxVonMises: number }>;
}

/** Rounds away floating-point noise so the JSON stays readable (12 significant digits). */
const r = (v: number) => (v === 0 ? 0 : Number(v.toPrecision(12)));

function forces(s: {
  N: number;
  Vy: number;
  Vz: number;
  T: number;
  My: number;
  Mz: number;
}): SectionForces {
  return { N: r(s.N), Vy: r(s.Vy), Vz: r(s.Vz), T: r(s.T), My: r(s.My), Mz: r(s.Mz) };
}

export function resultsJson(
  project: Project3D,
  result: AnalysisResult3D,
  options: { stations?: boolean } = {},
): ResultsJson {
  const members: ResultsJson['members'] = {};
  for (const [id, m] of Object.entries(result.members)) {
    const first = m.stations[0];
    const last = m.stations[m.stations.length - 1];
    members[id] = {
      length: r(m.length),
      start: forces(first),
      end: forces(last),
      endForces: m.endForces.map(r),
      max: {
        tension: r(m.maxAxial.value),
        compression: r(m.minAxial.value),
        Vy: r(m.maxAbsVy.value),
        Vz: r(m.maxAbsVz.value),
        T: r(m.maxAbsTorsion.value),
        My: r(m.maxAbsMy.value),
        Mz: r(m.maxAbsMz.value),
        deflection: r(m.maxAbsDeflection.value),
      },
    };
    if (options.stations) {
      members[id].stations = m.stations.map((s) => ({
        x: r(s.x),
        ...forces(s),
        u: r(s.u),
        v: r(s.v),
        w: r(s.w),
      }));
    }
  }
  const map = <T extends object>(o: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [
        k,
        Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, r(vv as number)])),
      ]),
    );
  return {
    format: 'frameforge-results',
    version: 1,
    units: { force: 'kN', length: 'm', moment: 'kN·m', rotation: 'rad', stress: 'kN/m²' },
    model: {
      name: project.name,
      plane: project.plane === 'XY',
      nodes: project.nodes.length,
      members: project.members.length,
      plates: project.plates.length,
      solids: project.solids.length,
    },
    warnings: [...result.warnings],
    maxDisplacement: r(result.maxDisplacement),
    appliedLoad: result.appliedLoad.map(r) as [number, number, number],
    equilibrium: result.equilibrium.map(r) as ResultsJson['equilibrium'],
    displacements: map(result.displacements) as ResultsJson['displacements'],
    reactions: map(result.reactions) as ResultsJson['reactions'],
    members,
    plates: Object.fromEntries(
      Object.entries(result.plates).map(([id, p]) => [id, { maxVonMises: r(p.maxVonMises) }]),
    ),
    solids: Object.fromEntries(
      Object.entries(result.solids).map(([id, s]) => [id, { maxVonMises: r(s.maxVonMises) }]),
    ),
  };
}

/** Analyses a project and returns the results JSON. Throws `SolverError` like the solver. */
export function analyzeToJson(
  project: Project3D,
  options: { stations?: boolean } = {},
): ResultsJson {
  return resultsJson(project, analyzeProject3D(project), options);
}
