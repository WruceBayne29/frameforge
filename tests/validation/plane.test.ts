/**
 * Plane-frame mode must reproduce the 2D solver: every 2D example (through the project path
 * the app uses: `from2D` → `analyzeProject3D`) and every model analysed by a 2D validation
 * case (through the solver-level converter) must give the same displacements, reactions and
 * member N / V / M at every station, to 1e-8 relative.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../src/examples';
import { toSolverModel } from '../../src/model';
import { analyzeProject3D, from2D } from '../../src/model3d';
import { analyze } from '../../src/solver';
import type { AnalysisResult, StructureModel } from '../../src/solver';
import { analyze3d } from '../../src/solver3d';
import { VALIDATION_CASES } from './cases';
import { ENGINE_2D } from './engine';
import type { Engine2D } from './engine';
import { planeModel3D, planeResult2D } from './plane2d';

const REL = 1e-8;

/**
 * Agreement both solvers can reach: 1e-8, or more where round-off grows with the stiffness
 * spread (cases that idealise members as axially rigid with A = 10⁴ m² have axial stiffnesses
 * ~10⁹ times the bending ones, so ~10⁻¹⁶ round-off is amplified to ~10⁻⁷).
 */
function tolerance(model: StructureModel): number {
  const pos = new Map(model.nodes.map((n) => [n.id, n]));
  let axial = 0;
  let bending = Infinity;
  for (const m of model.members) {
    const a = pos.get(m.i);
    const b = pos.get(m.j);
    if (!a || !b) continue;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    axial = Math.max(axial, (m.E * m.A) / L);
    if (m.type === 'frame') bending = Math.min(bending, (m.E * m.I) / L ** 3);
  }
  return Number.isFinite(bending) ? Math.max(REL, 1e-15 * (axial / bending)) : REL;
}

/** Compares a 2D result with the plane-mode result read back into the 2D shape. */
function expectSame(model: StructureModel, a: AnalysisResult, b: AnalysisResult, label: string) {
  const rel = tolerance(model);
  let scaleU = a.maxDisplacement;
  let scaleR = 0;
  for (const d of Object.values(a.displacements)) {
    scaleU = Math.max(scaleU, Math.abs(d.ux), Math.abs(d.uy));
    scaleR = Math.max(scaleR, Math.abs(d.rz));
  }
  let scaleF = 0;
  let scaleM = 0;
  for (const r of Object.values(a.reactions)) {
    scaleF = Math.max(scaleF, Math.abs(r.fx), Math.abs(r.fy));
    scaleM = Math.max(scaleM, Math.abs(r.mz));
  }
  for (const m of Object.values(a.members)) {
    for (const s of m.stations) {
      scaleF = Math.max(scaleF, Math.abs(s.N), Math.abs(s.V));
      scaleM = Math.max(scaleM, Math.abs(s.M));
    }
  }
  scaleM = Math.max(scaleM, scaleF);
  const near = (x: number, y: number, scale: number, what: string) =>
    expect(Math.abs(x - y), `${label}: ${what} (${x} vs ${y})`).toBeLessThanOrEqual(
      rel * Math.max(scale, 1e-12),
    );

  const framed = new Set<string>();
  for (const m of model.members) if (m.type === 'frame') framed.add(m.i).add(m.j);
  for (const node of model.nodes) {
    const p = a.displacements[node.id];
    const q = b.displacements[node.id];
    near(p.ux, q.ux, scaleU, `${node.id} ux`);
    near(p.uy, q.uy, scaleU, `${node.id} uy`);
    if (framed.has(node.id)) near(p.rz, q.rz, scaleR, `${node.id} rz`);
  }
  expect(Object.keys(b.reactions).sort(), `${label}: reaction nodes`).toEqual(
    Object.keys(a.reactions).sort(),
  );
  for (const [node, p] of Object.entries(a.reactions)) {
    const q = b.reactions[node];
    near(p.fx, q.fx, scaleF, `${node} Rx`);
    near(p.fy, q.fy, scaleF, `${node} Ry`);
    near(p.mz, q.mz, scaleM, `${node} Mz`);
  }
  for (const m of model.members) {
    const p = a.members[m.id];
    const q = b.members[m.id];
    near(p.length, q.length, p.length, `${m.id} length`);
    // Stations are matched by position; at a concentrated load both solvers give the left
    // and the right limit, in that order.
    const tol = 1e-9 * p.length;
    let matched = 0;
    for (let k = 0; k < p.stations.length; k++) {
      const s = p.stations[k];
      const left = p.stations.filter((t, j) => j < k && Math.abs(t.x - s.x) <= tol).length;
      const same = q.stations.filter((t) => Math.abs(t.x - s.x) <= tol);
      const t = same[Math.min(left, same.length - 1)];
      if (!t) continue;
      matched++;
      near(s.N, t.N, scaleF, `${m.id} N at x = ${s.x}`);
      near(s.V, t.V, scaleF, `${m.id} V at x = ${s.x}`);
      near(s.M, t.M, scaleM, `${m.id} M at x = ${s.x}`);
      near(s.v, t.v, scaleU, `${m.id} v at x = ${s.x}`);
    }
    // Every equal-division station (and every load discontinuity) exists in both.
    expect(matched, `${label}: ${m.id} stations matched`).toBeGreaterThanOrEqual(21);
    // |max| only: at a jump either sign may be reported for an equal magnitude.
    near(Math.abs(p.maxAbsMoment.value), Math.abs(q.maxAbsMoment.value), scaleM, `${m.id} |M|`);
    near(Math.abs(p.maxAbsShear.value), Math.abs(q.maxAbsShear.value), scaleF, `${m.id} |V|`);
    near(p.maxAxial.value, q.maxAxial.value, scaleF, `${m.id} max N`);
    near(p.minAxial.value, q.minAxial.value, scaleF, `${m.id} min N`);
  }
}

describe('plane frame mode reproduces the 2D solver', () => {
  for (const example of EXAMPLES) {
    it(`example: ${example.name} (from2D → analyzeProject3D)`, () => {
      const project = example.build();
      const model = toSolverModel(project);
      const r3 = analyzeProject3D(from2D(project));
      expect(r3.warnings).toEqual([]);
      expectSame(model, analyze(model), planeResult2D(model, r3), example.name);
    });
  }

  for (const vcase of VALIDATION_CASES) {
    it(`validation ${vcase.id}: ${vcase.title}`, () => {
      const models: StructureModel[] = [];
      const recording: Engine2D = {
        ...ENGINE_2D,
        analyze: (model, options) => {
          models.push(model);
          return analyze(model, options);
        },
      };
      vcase.run(recording);
      for (const model of models) {
        const r2 = analyze(model);
        const r3 = planeResult2D(model, analyze3d(planeModel3D(model)));
        expectSame(model, r2, r3, vcase.id);
      }
    });
  }
});
