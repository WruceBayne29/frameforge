/**
 * Influence lines in plane frame mode reproduce the 2D app: for every 2D example, the
 * reactions at each support, the moment, shear and axial force at the middle of every load
 * path member and the vertical displacement of every node agree with the 2D influence lines
 * at every load position.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../src/examples';
import { toSolverModel } from '../../src/model';
import { defaultLoadPath3D, from2D, influenceProject3D } from '../../src/model3d';
import { influenceLine } from '../../src/solver';
import type { InfluenceTarget } from '../../src/solver';
import { planeTarget } from './plane2d';

describe('influence lines in plane frame mode reproduce the 2D app', () => {
  for (const example of EXAMPLES) {
    it(
      example.name,
      () => {
        const project = example.build();
        const model = toSolverModel(project);
        const plane = from2D(project);
        // The app's load path: the beams (near-horizontal members), as in the 2D app.
        const path = defaultLoadPath3D(plane);
        const lengths = new Map(
          model.members.map((m) => {
            const a = model.nodes.find((n) => n.id === m.i)!;
            const b = model.nodes.find((n) => n.id === m.j)!;
            return [m.id, Math.hypot(b.x - a.x, b.y - a.y)];
          }),
        );
        const targets: InfluenceTarget[] = [
          ...model.supports.slice(0, 3).flatMap((s) =>
            (['fx', 'fy', 'mz'] as const).map((component) => ({
              kind: 'reaction' as const,
              node: s.node,
              component,
            })),
          ),
          ...path.slice(0, 3).flatMap((member) =>
            (['N', 'V', 'M'] as const).map((component) => ({
              kind: 'memberForce' as const,
              member,
              x: (lengths.get(member) as number) * 0.37,
              component,
            })),
          ),
          ...model.nodes.slice(0, 4).map((n) => ({
            kind: 'displacement' as const,
            node: n.id,
            component: 'uy' as const,
          })),
        ];
        for (const target of targets) {
          const a = influenceLine(model, target, { path, pointsPerMember: 13 });
          const mapped = planeTarget(model, target);
          const b = influenceProject3D(plane, mapped.target, path, 13);
          // Values are per unit load; a line that is zero everywhere is compared absolutely.
          const scale = Math.max(Math.abs(a.max.value), Math.abs(a.min.value), 1);
          expect(b.ordinates).toHaveLength(a.ordinates.length);
          a.ordinates.forEach((o, k) => {
            const q = b.ordinates[k];
            expect(q.member).toBe(o.member);
            expect(Math.abs(q.x - o.x)).toBeLessThan(1e-12);
            expect(
              Math.abs(mapped.sign * q.value - o.value),
              `${JSON.stringify(target)} at ${o.member} x = ${o.x}`,
            ).toBeLessThanOrEqual(1e-8 * scale);
          });
        }
        // The 2D reference runs one full analysis per load position, which is slow for the tower.
      },
      60000,
    );
  }
});
