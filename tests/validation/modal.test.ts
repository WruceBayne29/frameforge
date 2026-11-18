/**
 * Modal analysis in plane frame mode reproduces the 2D app: every 2D example, converted with
 * `from2D` and run through the 3D modal analysis with the same member subdivision, gives the
 * same natural frequencies and mode shapes.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../src/examples';
import { toSolverModel } from '../../src/model';
import { from2D, modalProject3D } from '../../src/model3d';
import { modalAnalysis } from '../../src/solver';

describe('modal analysis in plane frame mode reproduces the 2D app', () => {
  for (const example of EXAMPLES) {
    it(example.name, () => {
      const project = example.build();
      const count = project.members.length;
      const subdivide = count <= 12 ? 6 : count <= 30 ? 3 : 1;
      const model = toSolverModel(project);
      const a = modalAnalysis(model, 6, { subdivide });
      const at = new Map(model.nodes.map((n) => [n.id, n]));
      const flipped = new Set(
        model.members
          .filter((m) => {
            const p = at.get(m.i)!;
            const q = at.get(m.j)!;
            return (q.x - p.x) / Math.hypot(q.x - p.x, q.y - p.y) <= -1e-9;
          })
          .map((m) => m.id),
      );
      const b = modalProject3D(from2D(project), 6, subdivide);
      expect(b.warnings).toEqual([]);
      expect(Math.abs(b.totalMass - a.totalMass) / a.totalMass).toBeLessThan(1e-12);
      expect(b.modes).toHaveLength(a.modes.length);
      a.modes.forEach((mode, k) => {
        const other = b.modes[k];
        expect(Math.abs(other.omega - mode.omega) / mode.omega, `mode ${k + 1}`).toBeLessThan(1e-8);
        // Shapes: same up to sign, compared on the nodal translations.
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (const [id, d] of Object.entries(mode.displacements)) {
          const e = other.displacements[id];
          dot += d.ux * e.ux + d.uy * e.uy;
          na += d.ux ** 2 + d.uy ** 2;
          nb += e.ux ** 2 + e.uy ** 2;
          expect(Math.abs(e.uz)).toBe(0);
        }
        // ... and along the members (local axes; 3D local y is reversed on members pointing
        // in −X, see from2D).
        for (const [id, list] of Object.entries(mode.members)) {
          const s = flipped.has(id) ? -1 : 1;
          const other3 = other.members[id];
          expect(other3).toHaveLength(list.length);
          list.forEach((p, i) => {
            const q = other3[i];
            expect(Math.abs(q.x - p.x)).toBeLessThan(1e-12);
            dot += p.u * q.u + p.v * s * q.v;
            na += p.u ** 2 + p.v ** 2;
            nb += q.u ** 2 + q.v ** 2;
          });
        }
        // Modes with (nearly) repeated frequencies may mix; the examples have none.
        expect(Math.abs(dot) / Math.sqrt(na * nb), `mode ${k + 1} shape`).toBeGreaterThan(1 - 1e-8);
      });
    });
  }
});
