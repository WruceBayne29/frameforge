import { describe, expect, it } from 'vitest';
import { designMembers, toSolverModel } from '../model';
import { analyze } from '../solver';
import { EXAMPLES, getExample } from './index';

describe('example library', () => {
  it('has at least six examples including a transmission tower', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(6);
    expect(getExample('transmission-tower')).toBeDefined();
    expect(getExample('nope')).toBeUndefined();
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
  });

  for (const example of EXAMPLES) {
    it(`${example.name} solves, is in equilibrium and passes its design check`, () => {
      const project = example.build();
      const result = analyze(toSolverModel(project));
      expect(result.warnings).toEqual([]);
      const scale = project.loads.reduce((s, l) => {
        if (l.kind === 'nodal') return s + Math.abs(l.fx) + Math.abs(l.fy);
        if (l.kind === 'distributed') return s + Math.abs(l.w1) * 5;
        if (l.kind === 'point') return s + Math.abs(l.P);
        return s + Math.abs(l.M);
      }, 1);
      for (const residual of result.equilibrium) {
        expect(Math.abs(residual) / scale).toBeLessThan(1e-7);
      }
      expect(result.maxDisplacement).toBeGreaterThan(0);
      expect(result.maxDisplacement).toBeLessThan(0.5);

      const design = designMembers(project, result);
      const ratios = Object.values(design).map((d) => d.result.utilisation);
      expect(ratios.length).toBe(project.members.length);
      for (const r of ratios) expect(Number.isFinite(r)).toBe(true);
      // Examples should be sensibly proportioned: every member passes its check.
      expect(Math.max(...ratios)).toBeLessThan(1.0);
    });
  }
});
