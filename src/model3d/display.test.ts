import { describe, expect, it } from 'vitest';
import { analyze3d } from '../solver3d';
import { toSolverModel3D } from './convert';
import {
  colorMap,
  colorMapCss,
  fieldFraction,
  FIELD_KINDS,
  modelBounds3D,
  modelCenter3D,
  modelSize3D,
  nodalField,
  resultPeaks3D,
  resultScales3D,
} from './display';
import { addLoad } from './edit';
import { gridFrame, plateMesh, solidBlock } from './generate';
import { emptyProject3D, FIXED_SUPPORT, PINNED_SUPPORT } from './types';
import type { Project3D } from './types';

describe('model extents', () => {
  it('gives a default box for an empty project', () => {
    const p = emptyProject3D();
    expect(modelBounds3D(p)).toEqual({ min: [-2, 0, -2], max: [10, 6, 10] });
    expect(modelSize3D(p)).toBe(12);
  });

  it('bounds, size and centre of a model', () => {
    const p = emptyProject3D();
    p.nodes = [
      { id: 'a', x: -1, y: 0, z: 2 },
      { id: 'b', x: 3, y: 7, z: -4 },
      { id: 'c', x: 0, y: 1, z: 0 },
    ];
    expect(modelBounds3D(p)).toEqual({ min: [-1, 0, -4], max: [3, 7, 2] });
    expect(modelSize3D(p)).toBe(7);
    expect(modelCenter3D(p)).toEqual([1, 3.5, -1]);
    p.nodes = [{ id: 'a', x: 5, y: 5, z: 5 }];
    expect(modelSize3D(p)).toBe(1);
  });
});

/** Cantilever along X, 4 m, with a tip load in −Y and in +Z and a tip torque. */
function cantilever(): Project3D {
  const p = emptyProject3D();
  p.nodes = [
    { id: 'N1', x: 0, y: 0, z: 0 },
    { id: 'N2', x: 4, y: 0, z: 0 },
  ];
  p.members = [
    { id: 'M1', i: 'N1', j: 'N2', type: 'beam', section: 'ISMB 300', material: 'Steel' },
  ];
  p.supports = [{ node: 'N1', restraints: [...FIXED_SUPPORT] }];
  p.loads = [
    { id: 'L1', kind: 'nodal', nodes: ['N2'], fx: 30, fy: -10, fz: 2, mx: 1.5, my: 0, mz: 0 },
  ];
  return p;
}

describe('resultPeaks3D and resultScales3D', () => {
  it('reports the largest member forces of a cantilever', () => {
    const p = cantilever();
    const result = analyze3d(toSolverModel3D(p));
    const peaks = resultPeaks3D(result);
    expect(peaks.N).toBeCloseTo(30, 9);
    expect(peaks.Vy).toBeCloseTo(10, 9);
    expect(peaks.Vz).toBeCloseTo(2, 9);
    expect(peaks.T).toBeCloseTo(1.5, 9);
    expect(peaks.Mz).toBeCloseTo(40, 9);
    expect(peaks.My).toBeCloseTo(8, 9);
    expect(peaks.displacement).toBe(result.maxDisplacement);
    expect(peaks.plateVonMises).toBe(0);
    expect(peaks.solidVonMises).toBe(0);

    const scales = resultScales3D(p, result);
    expect(scales.deform * result.maxDisplacement).toBeCloseTo(0.045 * 4, 12);
    expect(scales.diagram.Mz * peaks.Mz).toBeCloseTo(0.11 * 4, 12);
    expect(scales.diagram.N * peaks.N).toBeCloseTo(0.11 * 4, 12);
    const doubled = resultScales3D(p, result, 2, 3);
    expect(doubled.deform).toBeCloseTo(2 * scales.deform, 12);
    expect(doubled.diagram.Vy).toBeCloseTo(3 * scales.diagram.Vy, 12);
  });

  it('gives zero scales when nothing happens', () => {
    const p = cantilever();
    p.loads = [];
    const result = analyze3d(toSolverModel3D(p));
    expect(resultScales3D(p, result)).toEqual({
      deform: 0,
      diagram: { N: 0, Vy: 0, Vz: 0, T: 0, My: 0, Mz: 0 },
    });
  });
});

describe('nodalField', () => {
  it('displacement: translation magnitude at every node', () => {
    const p = cantilever();
    const result = analyze3d(toSolverModel3D(p));
    const field = nodalField(p, result, 'displacement');
    const tip = result.displacements.N2;
    expect(field.values.N1).toBe(0);
    expect(field.values.N2).toBeCloseTo(Math.hypot(tip.ux, tip.uy, tip.uz), 15);
    expect(field.min).toBe(0);
    expect(field.max).toBe(field.values.N2);
    // plate and solid fields are empty for a frame
    expect(nodalField(p, result, 'plateMx')).toEqual({
      kind: 'plateMx',
      values: {},
      min: 0,
      max: 0,
    });
    expect(nodalField(p, result, 'solidS1').values).toEqual({});
  });

  it('plates: a strip in uniform bending has the same moment and stress at every node', () => {
    // Strip along local x with nu = 0, bent by equal and opposite end moments: Mx constant.
    let p = emptyProject3D();
    p.materials = [{ name: 'Test', E: 30, nu: 0, density: 0 }];
    const t = 0.2;
    const mesh = plateMesh(p, {
      // local z = +Y; local x of each plate runs along global Z (corner 1 → 2)
      corners: [
        [0, 0, 0],
        [0, 0, 4],
        [1, 0, 4],
        [1, 0, 0],
      ],
      nx: 4,
      ny: 1,
      thickness: t * 1000,
      material: 'Test',
    });
    p = mesh.project;
    const start = mesh.grid[0];
    const end = mesh.grid[4];
    p.supports = [
      { node: start[0], restraints: [true, true, true, false, false, false] },
      { node: start[1], restraints: [false, true, true, false, false, false] },
      { node: end[0], restraints: [true, true, false, false, false, false] },
      { node: end[1], restraints: [false, true, false, false, false, false] },
    ];
    // Moment per unit width m = 12 kN·m/m about global X over a width of 1 m: 6 kN·m per node.
    const m = 12;
    p = addLoad(p, {
      kind: 'nodal',
      nodes: start,
      fx: 0,
      fy: 0,
      fz: 0,
      mx: m / 2,
      my: 0,
      mz: 0,
    }).project;
    p = addLoad(p, {
      kind: 'nodal',
      nodes: end,
      fx: 0,
      fy: 0,
      fz: 0,
      mx: -m / 2,
      my: 0,
      mz: 0,
    }).project;
    const result = analyze3d(toSolverModel3D(p));
    expect(result.warnings).toEqual([]);

    const mx = nodalField(p, result, 'plateMx');
    expect(Object.keys(mx.values)).toHaveLength(10);
    // +mx at the start (z = 0) and −mx at the end sag the strip (uy < 0 at mid-span): bottom
    // in tension, which is a negative Mx in the solver's convention.
    const mid = result.displacements[mesh.grid[2][0]].uy;
    expect(mid).toBeLessThan(0);
    for (const v of Object.values(mx.values)) expect(v).toBeCloseTo(-m, 6);
    expect(mx.min).toBeCloseTo(-m, 6);
    expect(mx.max).toBeCloseTo(-m, 6);
    for (const v of Object.values(nodalField(p, result, 'plateMy').values))
      expect(v).toBeCloseTo(0, 6);
    for (const v of Object.values(nodalField(p, result, 'plateMxy').values))
      expect(v).toBeCloseTo(0, 6);
    // surface stress 6·M/t² on both faces
    const sigma = (6 * m) / (t * t);
    for (const kind of ['plateVonMisesTop', 'plateVonMisesBottom'] as const) {
      for (const v of Object.values(nodalField(p, result, kind).values)) {
        expect(v / sigma).toBeCloseTo(1, 8);
      }
    }
    expect(resultPeaks3D(result).plateVonMises / sigma).toBeCloseTo(1, 8);
    // mid-span deflection of a beam under uniform moment: M·L²/(8·E·I)
    const EI = (30e6 * t ** 3) / 12;
    expect(mid).toBeCloseTo((-m * 16) / (8 * EI), 8);
  });

  it('solids: a block in uniform compression has σ3 = −p, σ1 = 0 and von Mises = p', () => {
    let p = emptyProject3D();
    p.materials = [{ name: 'Test', E: 20, nu: 0, density: 0 }];
    const block = solidBlock(p, { size: [1, 2, 1], divisions: [2, 2, 2], material: 'Test' });
    p = block.project;
    p.supports = block.boundary.yMin.nodes.map((node) => ({
      node,
      restraints: [...PINNED_SUPPORT],
    }));
    const pressure = 500;
    p = addLoad(p, {
      kind: 'face',
      solids: block.boundary.yMax.solids,
      face: block.boundary.yMax.face,
      direction: 'normal',
      p: pressure,
    }).project;
    const result = analyze3d(toSolverModel3D(p));
    const vm = nodalField(p, result, 'solidVonMises');
    const s1 = nodalField(p, result, 'solidS1');
    const s3 = nodalField(p, result, 'solidS3');
    expect(Object.keys(vm.values)).toHaveLength(27);
    for (const node of p.nodes) {
      expect(vm.values[node.id]).toBeCloseTo(pressure, 6);
      expect(s1.values[node.id]).toBeCloseTo(0, 6);
      expect(s3.values[node.id]).toBeCloseTo(-pressure, 6);
    }
    expect(resultPeaks3D(result).solidVonMises).toBeCloseTo(pressure, 6);
    // shortening p·h/E at the top
    const top = nodalField(p, result, 'displacement');
    expect(top.max).toBeCloseTo((pressure * 2) / 20e6, 12);
  });

  it('averages the corner values of the elements meeting at a node', () => {
    const p = emptyProject3D();
    const mesh = plateMesh(p, {
      corners: [
        [0, 0, 0],
        [0, 0, 2],
        [2, 0, 2],
        [2, 0, 0],
      ],
      nx: 2,
      ny: 2,
    });
    let q = mesh.project;
    q.supports = [mesh.grid[0][0], mesh.grid[0][2], mesh.grid[2][0], mesh.grid[2][2]].map(
      (node) => ({
        node,
        restraints: [...FIXED_SUPPORT],
      }),
    );
    q = addLoad(q, {
      kind: 'pressure',
      plates: [mesh.plateGrid[0][0]],
      direction: 'globalY',
      p: -20,
    }).project;
    const result = analyze3d(toSolverModel3D(q));
    for (const kind of FIELD_KINDS.filter((k) => k.startsWith('plate'))) {
      const field = nodalField(q, result, kind);
      const pick = (id: string, corner: number): number => {
        const s = result.plates[id].corners[corner];
        switch (kind) {
          case 'plateVonMisesTop':
            return s.top.vonMises;
          case 'plateVonMisesBottom':
            return s.bottom.vonMises;
          case 'plateMx':
            return s.Mx;
          case 'plateMy':
            return s.My;
          default:
            return s.Mxy;
        }
      };
      // centre node: corner 3 of plate [0][0], 2 of [0][1]… by the generator's node order
      const g = mesh.plateGrid;
      const centre =
        (pick(g[0][0], 2) + pick(g[1][0], 3) + pick(g[1][1], 0) + pick(g[0][1], 1)) / 4;
      expect(field.values[mesh.grid[1][1]]).toBeCloseTo(centre, 9);
      // corner node of the mesh: one plate only
      expect(field.values[mesh.grid[0][0]]).toBeCloseTo(pick(g[0][0], 0), 9);
      expect(field.max).toBeGreaterThanOrEqual(field.min);
    }
  });

  it('works on a frame generated by gridFrame (nodes without plates are left out)', () => {
    const f = gridFrame(emptyProject3D(), {
      baysX: 1,
      baysZ: 1,
      storeys: 1,
      bayWidthX: 4,
      bayWidthZ: 4,
      storeyHeight: 3,
    });
    const g = f.grid[1];
    const slab = plateMesh(f.project, {
      corners: [
        [0, 3, 0],
        [0, 3, 4],
        [4, 3, 4],
        [4, 3, 0],
      ],
      nx: 1,
      ny: 1,
    });
    expect(slab.nodes).toEqual([]);
    const p = addLoad(slab.project, {
      kind: 'pressure',
      plates: slab.plates,
      direction: 'globalY',
      p: -5,
    }).project;
    const result = analyze3d(toSolverModel3D(p));
    const field = nodalField(p, result, 'plateVonMisesTop');
    expect(Object.keys(field.values).sort()).toEqual(g.flat().sort());
    expect(Object.keys(nodalField(p, result, 'displacement').values)).toHaveLength(8);
  });
});

describe('colour map', () => {
  it('runs blue → cyan → green → yellow → red', () => {
    expect(colorMap(0)).toEqual([0, 0, 255]);
    expect(colorMap(0.25)).toEqual([0, 255, 255]);
    expect(colorMap(0.5)).toEqual([0, 255, 0]);
    expect(colorMap(0.75)).toEqual([255, 255, 0]);
    expect(colorMap(1)).toEqual([255, 0, 0]);
    expect(colorMap(0.125)).toEqual([0, 128, 255]);
    expect(colorMap(0.875)).toEqual([255, 128, 0]);
  });

  it('clamps out-of-range values and greys out NaN', () => {
    expect(colorMap(-3)).toEqual(colorMap(0));
    expect(colorMap(7)).toEqual(colorMap(1));
    expect(colorMap(Infinity)).toEqual(colorMap(1));
    expect(colorMap(NaN)).toEqual([156, 163, 175]);
    expect(colorMapCss(0.5)).toBe('rgb(0 255 0)');
  });

  it('fieldFraction places a value within the range of a field', () => {
    expect(fieldFraction({ min: 2, max: 6 }, 3)).toBe(0.25);
    expect(fieldFraction({ min: 2, max: 6 }, 9)).toBe(1);
    expect(fieldFraction({ min: 2, max: 6 }, -9)).toBe(0);
    expect(fieldFraction({ min: 4, max: 4 }, 4)).toBe(0.5);
    expect(fieldFraction({ min: 0, max: 1 }, NaN)).toBe(0.5);
  });
});
