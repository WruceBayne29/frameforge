/**
 * The IS 800 check of a plane-frame project reproduces the 2D app's design results for every
 * 2D example: the same members checked, the same section class, the same checks in the same
 * order, and the same ratios (to round-off, since the 3D solver's forces agree with the 2D
 * solver's to ~1e-12).
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../src/examples';
import { designMembers, toSolverModel } from '../../src/model';
import { analyzeProject3D, designMembers3D, from2D } from '../../src/model3d';
import { analyze } from '../../src/solver';

describe('IS 800 check in plane frame mode reproduces the 2D design', () => {
  for (const example of EXAMPLES) {
    it(example.name, () => {
      const project = example.build();
      const d2 = designMembers(project, analyze(toSolverModel(project)));
      const plane = from2D(project);
      const d3 = designMembers3D(plane, analyzeProject3D(plane));
      expect(Object.keys(d3).sort()).toEqual(Object.keys(d2).sort());
      for (const [id, a] of Object.entries(d2)) {
        const b = d3[id].result;
        expect(b.sectionClass, id).toBe(a.result.sectionClass);
        expect(b.governing, id).toBe(a.result.governing);
        expect(
          b.checks.map((c) => c.id),
          id,
        ).toEqual(a.result.checks.map((c) => c.id));
        expect(b.warnings, id).toEqual(a.result.warnings);
        expect(b.ok, id).toBe(a.result.ok);
        expect(Math.abs(b.utilisation - a.result.utilisation), id).toBeLessThan(1e-9);
        a.result.checks.forEach((c, k) => {
          expect(Math.abs(b.checks[k].ratio - c.ratio), `${id} ${c.id}`).toBeLessThan(1e-9);
          expect(Math.abs(b.checks[k].capacity - c.capacity) / c.capacity).toBeLessThan(1e-12);
        });
        expect(b.slendernessY).toBe(a.result.slendernessY);
        expect(b.slendernessZ).toBe(a.result.slendernessZ);
      }
    });
  }
});
