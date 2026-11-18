import { describe, expect, it } from 'vitest';
import { analyze3d } from './analyze';
import { influenceLine3d } from './influence';
import type { InfluenceTarget3D } from './influence';
import type { Member3D, StructureModel3D, Support3D } from './types';

const E = 2e8;
const G = E / 2.6;
const props = { E, G, A: 8e-3, Iy: 3e-5, Iz: 1.2e-4, J: 4e-6 };
const beam = (id: string, i: string, j: string, extra: Partial<Member3D> = {}): Member3D => ({
  id,
  i,
  j,
  type: 'beam',
  ...props,
  ...extra,
});
const fixed = (node: string): Support3D => ({
  node,
  ux: true,
  uy: true,
  uz: true,
  rx: true,
  ry: true,
  rz: true,
});

/** Simply supported beam along X, L = 8, pins with twist held at A. */
function simpleBeam(): StructureModel3D {
  return {
    nodes: [
      { id: 'A', x: 0, y: 0, z: 0 },
      { id: 'B', x: 8, y: 0, z: 0 },
    ],
    members: [beam('AB', 'A', 'B')],
    supports: [
      { node: 'A', ux: true, uy: true, uz: true, rx: true },
      { node: 'B', uy: true, uz: true },
    ],
    loads: [],
  };
}

const at = (line: ReturnType<typeof influenceLine3d>, x: number) =>
  line.ordinates.find((o) => Math.abs(o.x - x) < 1e-9)?.value ?? NaN;

describe('influence lines: Müller-Breslau closed forms', () => {
  const L = 8;
  const options = { pointsPerMember: 17 };

  it('simply supported beam, vertical load: R_A = 1 − x/L, Mz(L/2) = x/2', () => {
    const model = simpleBeam();
    const ra = influenceLine3d(model, { kind: 'reaction', node: 'A', component: 'fy' }, options);
    expect(at(ra, 2)).toBeCloseTo(0.75, 12);
    expect(at(ra, 6)).toBeCloseTo(0.25, 12);
    const mz = influenceLine3d(
      model,
      { kind: 'memberForce', member: 'AB', x: L / 2, component: 'Mz' },
      options,
    );
    expect(at(mz, 2)).toBeCloseTo(1, 12);
    expect(mz.max.value).toBeCloseTo(L / 4, 12);
    expect(mz.max.x).toBeCloseTo(L / 2, 12);
    // Shear at L/4: −x/L before the section, 1 − x/L after; the load on the section gives the
    // left limit.
    const vy = influenceLine3d(
      model,
      { kind: 'memberForce', member: 'AB', x: L / 4, component: 'Vy' },
      options,
    );
    // Vy sums the local-y forces on the part from A to the section: R_A − 1 before the load
    // passes the section, R_A after.
    expect(at(vy, 1)).toBeCloseTo(-1 / 8, 12);
    expect(at(vy, 4)).toBeCloseTo(0.5, 12);
    expect(at(vy, 2)).toBeCloseTo(0.75, 12);
  });

  it('lateral load along −Z gives the same shapes for Vz, My and the reaction fz', () => {
    const model = simpleBeam();
    const options3 = { ...options, direction: 'globalZ' as const };
    const my = influenceLine3d(
      model,
      { kind: 'memberForce', member: 'AB', x: L / 2, component: 'My' },
      options3,
    );
    expect(Math.abs(my.max.value) + Math.abs(my.min.value)).toBeCloseTo(L / 4, 12);
    const rz = influenceLine3d(model, { kind: 'reaction', node: 'B', component: 'fz' }, options3);
    expect(at(rz, 2)).toBeCloseTo(0.25, 12);
    // A vertical load causes no lateral reaction.
    expect(
      influenceLine3d(model, { kind: 'reaction', node: 'B', component: 'fz' }, options).max.value,
    ).toBeCloseTo(0, 12);
  });

  it('two-span continuous beam: R_B = x(3L² − x²)/2L³ over the first span', () => {
    const l = 5;
    const model: StructureModel3D = {
      nodes: [
        { id: 'A', x: 0, y: 0, z: 0 },
        { id: 'B', x: l, y: 0, z: 0 },
        { id: 'C', x: 2 * l, y: 0, z: 0 },
      ],
      members: [beam('AB', 'A', 'B'), beam('BC', 'B', 'C')],
      supports: [
        { node: 'A', ux: true, uy: true, uz: true, rx: true },
        { node: 'B', uy: true, uz: true },
        { node: 'C', uy: true, uz: true },
      ],
      loads: [],
    };
    const line = influenceLine3d(
      model,
      { kind: 'reaction', node: 'B', component: 'fy' },
      { path: ['AB'], pointsPerMember: 11 },
    );
    for (const x of [1.5, 2.5, 4]) {
      expect(at(line, x)).toBeCloseTo((x * (3 * l * l - x * x)) / (2 * l ** 3), 10);
    }
  });
});

describe('influence lines: every ordinate is a static analysis', () => {
  // L-shaped grillage on a fixed base and a spring: bending, torsion and a spring reaction.
  const model: StructureModel3D = {
    nodes: [
      { id: 'A', x: 0, y: 0, z: 0 },
      { id: 'B', x: 4, y: 0, z: 0 },
      { id: 'C', x: 4, y: 0, z: 3 },
      { id: 'D', x: 4, y: -3, z: 3 },
    ],
    members: [beam('AB', 'A', 'B'), beam('BC', 'B', 'C', { beta: 0.3 }), beam('CD', 'C', 'D')],
    supports: [fixed('A'), { node: 'D', spring: { uy: 5e3, ux: 2e3 } }],
    loads: [],
  };
  const targets: InfluenceTarget3D[] = [
    { kind: 'reaction', node: 'A', component: 'mx' },
    { kind: 'reaction', node: 'A', component: 'fy' },
    { kind: 'reaction', node: 'D', component: 'fy' },
    { kind: 'reaction', node: 'B', component: 'fy' },
    { kind: 'displacement', node: 'C', component: 'uy' },
    { kind: 'displacement', node: 'B', component: 'rx' },
    { kind: 'memberForce', member: 'AB', x: 1.3, component: 'T' },
    { kind: 'memberForce', member: 'AB', x: 1.3, component: 'Mz' },
    { kind: 'memberForce', member: 'BC', x: 1.2, component: 'My' },
    { kind: 'memberForce', member: 'BC', x: 1.2, component: 'Vz' },
    { kind: 'memberForce', member: 'CD', x: 0.6, component: 'N' },
  ];

  for (const target of targets) {
    it(JSON.stringify(target), () => {
      const line = influenceLine3d(model, target, {
        path: ['AB', 'BC'],
        pointsPerMember: 5,
        direction: 'globalY',
        magnitude: -2,
      });
      expect(line.ordinates).toHaveLength(10);
      for (const o of line.ordinates) {
        const r = analyze3d(
          {
            ...model,
            loads: [{ kind: 'point', member: o.member, direction: 'globalY', P: -2, a: o.x }],
          },
          { segments: 4 },
        );
        let expected: number;
        if (target.kind === 'reaction')
          expected = r.reactions[target.node]?.[target.component] ?? 0;
        else if (target.kind === 'displacement')
          expected = r.displacements[target.node][target.component];
        else {
          // Exact station at the section (loads never sit on it in this test).
          const fine = analyze3d(
            {
              ...model,
              loads: [{ kind: 'point', member: o.member, direction: 'globalY', P: -2, a: o.x }],
            },
            { segments: 400 },
          );
          const s = fine.members[target.member].stations.find(
            (x) => Math.abs(x.x - target.x) < 1e-9,
          );
          expect(s).toBeDefined();
          expected = s ? s[target.component] : NaN;
        }
        const scale = Math.max(Math.abs(expected), 1e-9);
        expect(Math.abs(o.value - expected) / scale, `${o.member} @ ${o.x}`).toBeLessThan(1e-9);
      }
    });
  }
});

describe('influence lines: errors', () => {
  it('rejects unknown targets and paths, and mechanisms', () => {
    const model = simpleBeam();
    expect(() => influenceLine3d(model, { kind: 'reaction', node: 'X', component: 'fy' })).toThrow(
      /does not exist/,
    );
    expect(() =>
      influenceLine3d(model, { kind: 'memberForce', member: 'X', x: 1, component: 'N' }),
    ).toThrow(/does not exist/);
    expect(() =>
      influenceLine3d(model, { kind: 'memberForce', member: 'AB', x: 9, component: 'N' }),
    ).toThrow(/must lie on/);
    expect(() =>
      influenceLine3d(model, { kind: 'reaction', node: 'A', component: 'fy' }, { path: ['X'] }),
    ).toThrow(/load path/);
    expect(() =>
      influenceLine3d(model, { kind: 'reaction', node: 'A', component: 'fy' }, { path: [] }),
    ).toThrow(/empty/);
    const loose = simpleBeam();
    loose.supports = [
      { node: 'A', uy: true, uz: true, rx: true },
      { node: 'B', uy: true, uz: true },
    ];
    expect(() => influenceLine3d(loose, { kind: 'reaction', node: 'A', component: 'fy' })).toThrow(
      /unstable/,
    );
    // A reaction component that is not restrained is zero.
    const free = influenceLine3d(model, { kind: 'reaction', node: 'B', component: 'fx' });
    expect(free.ordinates.every((o) => o.value === 0)).toBe(true);
  });
});
