import { describe, expect, it } from 'vitest';
import { getSection } from '../design-codes';
import { analyze3d } from '../solver3d';
import {
  FALLBACK_SECTION_3D,
  materialOf,
  memberProps3D,
  sectionProps3D,
  torsionConstant,
  toSolverModel3D,
} from './convert';
import { emptyProject3D, FIXED_SUPPORT } from './types';
import type { Project3D } from './types';

function cantilever(): Project3D {
  const p = emptyProject3D('Cantilever');
  p.nodes = [
    { id: 'N1', x: 0, y: 0, z: 0 },
    { id: 'N2', x: 4, y: 0, z: 0 },
  ];
  p.members = [
    { id: 'M1', i: 'N1', j: 'N2', type: 'beam', section: 'ISMB 300', material: 'Steel' },
  ];
  p.supports = [{ node: 'N1', restraints: [...FIXED_SUPPORT] }];
  return p;
}

describe('sectionProps3D', () => {
  it('reads rolled sections with Iz as the major axis and a thin-walled J', () => {
    const p = emptyProject3D();
    const s = sectionProps3D(p, 'ISMB 300');
    expect(s).toMatchObject({ A: 56.26, Iz: 8603.6, Iy: 453.9, rolled: true });
    // 2 × 140 × 12.4³/3 + (300 − 24.8) × 7.5³/3 = 177 952 + 38 700 = 216 652 mm⁴ = 21.665 cm⁴
    const expected = ((2 * 140 * 12.4 ** 3) / 3 + (275.2 * 7.5 ** 3) / 3) / 1e4;
    expect(s?.J).toBeCloseTo(expected, 10);
    expect(s?.J).toBeCloseTo(21.665, 3);
    const rolled = getSection('ISMB 300');
    expect(rolled && torsionConstant(rolled)).toBeCloseTo(expected, 10);
  });

  it('reads custom sections and falls back for unknown names', () => {
    const p = emptyProject3D();
    p.customSections = [{ name: 'Box', A: 100, Iz: 9000, Iy: 8000, J: 12000 }];
    expect(sectionProps3D(p, 'Box')).toEqual({
      A: 100,
      Iz: 9000,
      Iy: 8000,
      J: 12000,
      rolled: false,
    });
    expect(sectionProps3D(p, 'Nope')).toBeUndefined();
    const member = {
      id: 'M1',
      i: 'a',
      j: 'b',
      type: 'beam' as const,
      section: 'Nope',
      material: '',
    };
    expect(memberProps3D(p, member)).toEqual(FALLBACK_SECTION_3D);
  });
});

describe('toSolverModel3D', () => {
  it('converts units: GPa, cm², cm⁴, degrees, mm', () => {
    const p = cantilever();
    p.members[0].beta = 90;
    p.members[0].releaseJ = { mz: true };
    p.nodes.push({ id: 'N3', x: 4, y: 0, z: 2 }, { id: 'N4', x: 0, y: 0, z: 2 });
    p.plates = [
      { id: 'P1', nodes: ['N1', 'N2', 'N3', 'N4'], thickness: 150, material: 'Concrete M25' },
    ];
    const model = toSolverModel3D(p);
    const m = model.members?.[0];
    expect(m?.E).toBe(200e6);
    expect(m?.G).toBeCloseTo(200e6 / 2.6, 3);
    expect(m?.A).toBeCloseTo(56.26e-4, 12);
    expect(m?.Iz).toBeCloseTo(8603.6e-8, 14);
    expect(m?.Iy).toBeCloseTo(453.9e-8, 14);
    expect(m?.J).toBeCloseTo(21.66516e-8, 12);
    expect(m?.beta).toBeCloseTo(Math.PI / 2, 12);
    expect(m?.density).toBe(77);
    expect(m?.releaseJ).toEqual({ mz: true });
    expect(m?.releaseI).toBeUndefined();
    expect(model.plates?.[0]).toEqual({
      id: 'P1',
      nodes: ['N1', 'N2', 'N3', 'N4'],
      E: 25e6,
      nu: 0.2,
      t: 0.15,
      density: 25,
    });
    expect(model.supports).toEqual([
      { node: 'N1', ux: true, uy: true, uz: true, rx: true, ry: true, rz: true },
    ]);
  });

  it('uses the first material when the name is unknown', () => {
    const p = cantilever();
    p.members[0].material = 'Unobtainium';
    expect(materialOf(p, 'Unobtainium').name).toBe('Steel');
    expect(toSolverModel3D(p).members?.[0].E).toBe(200e6);
    p.materials = [];
    expect(materialOf(p, 'x').name).toBe('Steel');
  });

  it('expands multi-target loads and skips targets that no longer exist', () => {
    const p = cantilever();
    p.nodes.push({ id: 'N3', x: 8, y: 0, z: 0 });
    p.members.push({
      id: 'M2',
      i: 'N2',
      j: 'N3',
      type: 'beam',
      section: 'ISMB 300',
      material: 'Steel',
    });
    p.supports.push({ node: 'gone', restraints: [...FIXED_SUPPORT] });
    p.loads = [
      {
        id: 'L1',
        kind: 'nodal',
        nodes: ['N2', 'gone', 'N3'],
        fx: 1,
        fy: -2,
        fz: 3,
        mx: 0,
        my: 0,
        mz: 4,
      },
      {
        id: 'L2',
        kind: 'distributed',
        members: ['M1', 'M2', 'gone'],
        direction: 'globalY',
        w1: -5,
      },
      { id: 'L3', kind: 'point', members: ['M2'], direction: 'localY', P: -7, a: 1 },
      { id: 'L4', kind: 'moment', members: ['M2', 'gone'], direction: 'globalZ', M: 2, a: 1 },
      { id: 'L5', kind: 'pressure', plates: ['gone'], direction: 'localZ', p: 1 },
      { id: 'L6', kind: 'platePoint', plates: ['gone'], direction: 'localZ', P: 1, xi: 0, eta: 0 },
      { id: 'L7', kind: 'face', solids: ['gone'], face: 1, direction: 'normal', p: 1 },
    ];
    const model = toSolverModel3D(p);
    expect(model.supports).toHaveLength(1);
    expect(model.loads.map((l) => l.kind)).toEqual([
      'nodal',
      'nodal',
      'distributed',
      'distributed',
      'point',
      'moment',
    ]);
    expect(model.loads[1]).toEqual({
      kind: 'nodal',
      node: 'N3',
      fx: 1,
      fy: -2,
      fz: 3,
      mx: 0,
      my: 0,
      mz: 4,
    });
    expect(model.loads[3]).toMatchObject({ kind: 'distributed', member: 'M2', w1: -5 });
    // The converted model analyses.
    const result = analyze3d(model);
    expect(result.appliedLoad[1]).toBeCloseTo(-2 * 2 - 5 * 8 - 7, 9);
  });

  it('expands plate and solid loads', () => {
    const p = emptyProject3D();
    const pts = [
      [0, 0, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
    ];
    p.nodes = pts.map(([x, y, z], k) => ({ id: `N${k + 1}`, x, y, z }));
    const ids = p.nodes.map((n) => n.id);
    p.solids = [
      { id: 'S1', nodes: ids as Project3D['solids'][number]['nodes'], material: 'Concrete M25' },
    ];
    p.plates = [
      { id: 'P1', nodes: ['N5', 'N6', 'N7', 'N8'], thickness: 100, material: 'Concrete M25' },
    ];
    p.supports = ids
      .slice(0, 4)
      .map((node) => ({ node, restraints: [true, true, true, false, false, false] }));
    p.loads = [
      { id: 'L1', kind: 'pressure', plates: ['P1'], direction: 'globalY', p: -10 },
      { id: 'L2', kind: 'platePoint', plates: ['P1'], direction: 'localZ', P: -4, xi: 0, eta: 0 },
      { id: 'L3', kind: 'face', solids: ['S1'], face: 2, direction: 'normal', p: 6 },
    ];
    const model = toSolverModel3D(p);
    expect(model.loads).toEqual([
      { kind: 'pressure', plate: 'P1', direction: 'globalY', p: -10 },
      { kind: 'platePoint', plate: 'P1', direction: 'localZ', P: -4, xi: 0, eta: 0 },
      { kind: 'face', solid: 'S1', face: 2, direction: 'normal', p: 6 },
    ]);
    const result = analyze3d(model);
    // plate normal is +Y, so the localZ point load of −4 acts downwards
    expect(result.appliedLoad[1]).toBeCloseTo(-10 - 4 - 6, 9);
    expect(result.equilibrium.every((v) => Math.abs(v) < 1e-8)).toBe(true);
  });

  it('self-weight: gravity along −Y with every element given its density', () => {
    const p = cantilever();
    p.selfWeight = true;
    const model = toSolverModel3D(p);
    expect(model.loads).toEqual([{ kind: 'selfWeight', direction: 'globalY', factor: -1 }]);
    const result = analyze3d(model);
    const weight = 56.26e-4 * 77 * 4;
    expect(result.reactions.N1.fy).toBeCloseTo(weight, 9);
    expect(result.reactions.N1.mz).toBeCloseTo((weight * 4) / 2, 9);
    // tip deflection w·L⁴/(8·E·I)
    const w = 56.26e-4 * 77;
    expect(result.displacements.N2.uy).toBeCloseTo((-w * 4 ** 4) / (8 * 200e6 * 8603.6e-8), 9);
  });
});
