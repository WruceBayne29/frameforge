import { describe, expect, it } from 'vitest';
import { EXAMPLES_3D } from '../../examples3d';
import {
  addLoad,
  addMember,
  addNode,
  emptyProject3D,
  nodalField,
  resultScales3D,
  setSupport,
  solidBlock,
  toSolverModel3D,
} from '../../model3d';
import type { Project3D } from '../../model3d';
import { analyze3d } from '../../solver3d';
import {
  deformedMemberSegments,
  diagramAxis,
  displacedPositions,
  exteriorFaces,
  gridSegments,
  idLabels,
  loadArrows,
  memberDiagram,
  niceSpacing,
  plateSurface,
  reactionArrows,
  snap,
  solidSurface,
  subsetProject,
  supportGlyphs,
  symbolSizes,
  typicalLength,
  nodePositions,
} from './build';

const example = (id: string) =>
  (EXAMPLES_3D.find((e) => e.id === id) as { build: () => Project3D }).build();

/** A 4 m cantilever along X with a tip load −10 kN in Y. */
function cantilever(): Project3D {
  let p = emptyProject3D();
  p = addNode(p, 0, 0, 0).project;
  p = addNode(p, 4, 0, 0).project;
  p = addMember(p, 'N1', 'N2').project;
  p = setSupport(p, 'N1', [true, true, true, true, true, true]);
  p = addLoad(p, {
    kind: 'nodal',
    nodes: ['N2'],
    fx: 0,
    fy: -10,
    fz: 0,
    mx: 0,
    my: 0,
    mz: 0,
  }).project;
  return p;
}

describe('deformed members', () => {
  it('follow the station deflections, not a straight chord', () => {
    const p = cantilever();
    const r = analyze3d(toSolverModel3D(p));
    const segments = deformedMemberSegments(p, r, 1);
    const stations = r.members.M1.stations.length;
    expect(segments.length).toBe((stations - 1) * 6);
    // Start at the support, end at the displaced tip.
    expect(segments[0]).toBeCloseTo(0);
    const tipY = segments[segments.length - 2];
    expect(tipY).toBeCloseTo(r.displacements.N2.uy, 9);
    // Mid-span point lies below the chord (cantilever curvature).
    const midIndex = Math.floor((stations - 1) / 2) * 6;
    const midX = segments[midIndex];
    const midY = segments[midIndex + 1];
    const chordY = (r.displacements.N2.uy * midX) / 4;
    expect(Math.abs(midY)).toBeLessThan(Math.abs(chordY));
    const pos = displacedPositions(p, r, 2);
    expect(pos.get('N2')?.[1]).toBeCloseTo(2 * r.displacements.N2.uy);
  });
});

describe('member diagrams', () => {
  it('draws moments on the tension side and labels the peak', () => {
    const p = cantilever();
    const r = analyze3d(toSolverModel3D(p));
    const d = memberDiagram(p, r, 'Mz', 0.1);
    expect(diagramAxis('Mz')).toEqual({ axis: 'y', sign: -1 });
    expect(d.peak).toBeCloseTo(40);
    expect(d.labels).toHaveLength(1);
    expect(d.labels[0].text).toBe('-40.0');
    // Hogging (negative Mz) at the support is drawn above the member (+Y): tension on top.
    expect(d.labels[0].position[1]).toBeCloseTo(4, 6);
    expect(d.negative.length).toBeGreaterThan(0);
    expect(d.positive.length).toBe(0);
    expect(d.outline.length % 6).toBe(0);
  });

  it('splits fills at sign changes and limits labels on big models', () => {
    const p = example('building-frame');
    const r = analyze3d(toSolverModel3D(p));
    const scales = resultScales3D(p, r);
    const d = memberDiagram(p, r, 'Mz', scales.diagram.Mz, new Set(['M1']), 5);
    expect(d.positive.length).toBeGreaterThan(0);
    expect(d.negative.length).toBeGreaterThan(0);
    expect(d.labels.length).toBeLessThanOrEqual(6);
    const axial = memberDiagram(
      example('tower-25-bar'),
      analyze3d(toSolverModel3D(example('tower-25-bar'))),
      'N',
      0.01,
    );
    expect(axial.labels.length).toBeLessThanOrEqual(16);
  });
});

describe('surfaces', () => {
  it('meshes plates with contour colours and unique edges', () => {
    const p = example('simply-supported-slab');
    const r = analyze3d(toSolverModel3D(p));
    const field = nodalField(p, r, 'displacement');
    const s = plateSurface(p, nodePositions(p), field);
    expect(s.positions.length).toBe(p.plates.length * 6 * 3);
    expect(s.owners).toHaveLength(p.plates.length * 2);
    expect(s.colors?.length).toBe(s.positions.length);
    // 10 × 10 mesh: 2 × 10 × 11 edges.
    expect(s.edges.length / 6).toBe(220);
  });

  it('shows only the outside faces of solids, facing out', () => {
    const block = solidBlock(emptyProject3D(), { size: [2, 1, 1], divisions: [2, 1, 1] }).project;
    const faces = exteriorFaces(block);
    expect(faces).toHaveLength(10);
    const s = solidSurface(block, nodePositions(block));
    expect(s.owners).toHaveLength(20);
    // Every normal points away from the block centre (1, 0.5, 0.5).
    for (let t = 0; t < s.positions.length / 9; t++) {
      const k = t * 9;
      const c = [0, 1, 2].map(
        (a) => (s.positions[k + a] + s.positions[k + 3 + a] + s.positions[k + 6 + a]) / 3,
      );
      const n = [s.normals[k], s.normals[k + 1], s.normals[k + 2]];
      const out = (c[0] - 1) * n[0] + (c[1] - 0.5) * n[1] + (c[2] - 0.5) * n[2];
      expect(out).toBeGreaterThan(0);
    }
  });
});

describe('symbols', () => {
  it('reflects the restrained degrees of freedom', () => {
    let p = cantilever();
    expect(supportGlyphs(p).map((g) => g.shape)).toEqual(['base']);
    p = setSupport(p, 'N1', [true, true, true, false, false, false]);
    expect(supportGlyphs(p).map((g) => g.shape)).toEqual(['pyramid']);
    p = setSupport(p, 'N1', [false, true, false, false, false, false]);
    expect(supportGlyphs(p).map((g) => g.shape)).toEqual(['pyramid', 'roller']);
    p = setSupport(p, 'N1', [true, false, true, false, false, true]);
    expect(supportGlyphs(p).map((g) => g.shape)).toEqual(['cone', 'cone', 'cube']);
  });

  it('sizes symbols to the model', () => {
    const p = example('simply-supported-slab');
    expect(typicalLength(p, 5)).toBeCloseTo(0.5);
    const s = symbolSizes(p, 5);
    expect(s.node).toBeLessThan(0.1);
    expect(s.truss).toBeLessThan(s.beam);
  });
});

describe('load arrows', () => {
  it('draws every load kind with one label each', () => {
    let p = cantilever();
    p = addLoad(p, {
      kind: 'distributed',
      members: ['M1'],
      direction: 'globalY',
      w1: -5,
      w2: -10,
      a: 1,
      b: 3,
    }).project;
    p = addLoad(p, { kind: 'point', members: ['M1'], direction: 'localZ', P: 3, a: 2 }).project;
    p = addLoad(p, { kind: 'moment', members: ['M1'], direction: 'localX', M: 2, a: 1 }).project;
    const set = loadArrows(p, 1);
    expect(set.labels).toHaveLength(4);
    const nodal = set.arrows.find((a) => a.owner === 'L1');
    expect(nodal?.tip).toEqual([4, 0, 0]);
    expect(nodal?.direction).toEqual([0, -1, 0]);
    const udl = set.arrows.filter((a) => a.owner === 'L2');
    expect(udl.length).toBeGreaterThan(2);
    expect(udl[0].tip[0]).toBeCloseTo(1);
    expect(udl[udl.length - 1].tip[0]).toBeCloseTo(3);
    expect(udl[udl.length - 1].length).toBeGreaterThan(udl[0].length);
    expect(set.lines.length).toBe((udl.length - 1) * 6);
    expect(set.arrows.find((a) => a.owner === 'L4')?.moment).toBe(true);
  });

  it('points face pressures into the solid and plate pressures along the normal', () => {
    const slab = example('simply-supported-slab');
    const s = loadArrows(slab, 1);
    expect(s.arrows).toHaveLength(slab.plates.length);
    expect(loadArrows(slab, 1, 10).arrows).toHaveLength(10);
    expect(s.arrows[0].direction[1]).toBeCloseTo(-1);
    const block = solidBlock(emptyProject3D(), { size: [1, 1, 1], divisions: [1, 1, 1] }).project;
    const top = addLoad(block, {
      kind: 'face',
      solids: ['S1'],
      face: 2,
      direction: 'normal',
      p: 10,
    }).project;
    const face = loadArrows(top, 1).arrows[0];
    expect(face.direction[1]).toBeCloseTo(-1);
    expect(face.tip[1]).toBeCloseTo(1);
  });
});

describe('reactions', () => {
  it('balance the load and are labelled', () => {
    const p = cantilever();
    const r = analyze3d(toSolverModel3D(p));
    const set = reactionArrows(p, r, 1, 0.1);
    const fy = set.arrows.find((a) => !a.moment && a.direction[1] !== 0);
    expect(fy?.direction).toEqual([0, 1, 0]);
    expect(fy?.tip[1]).toBeCloseTo(-0.1);
    expect(set.labels.map((l) => l.text)).toContain('Fy 10.0');
    expect(set.arrows.some((a) => a.moment)).toBe(true);
  });
});

describe('labels, subsets and grid', () => {
  it('labels ids up to a limit', () => {
    const p = example('solid-cantilever');
    expect(idLabels(p, 50)).toHaveLength(0);
    expect(idLabels(p)).toHaveLength(p.nodes.length + p.solids.length);
    expect(idLabels(cantilever()).map((l) => l.text)).toEqual(['M1', 'N1', 'N2']);
  });

  it('restricts a project to a selection', () => {
    const p = cantilever();
    expect(subsetProject(p, 'member', ['M1']).members).toHaveLength(1);
    expect(subsetProject(p, 'node', ['N1']).nodes).toHaveLength(1);
    expect(subsetProject(p, 'load', ['L1']).loads).toHaveLength(1);
  });

  it('snaps and spaces the grid', () => {
    expect(snap(0.74, 0.5)).toBe(0.5);
    expect(snap(0.3000001, 0.1)).toBe(0.3);
    expect(snap(1.234, 0)).toBe(1.234);
    expect(niceSpacing(20, 20)).toBe(1);
    expect(niceSpacing(70, 20)).toBe(5);
    const [minor, major] = gridSegments({ cx: 0, cz: 0, half: 2, y: 1, spacing: 1, majorEvery: 2 });
    expect((minor.length + major.length) / 6).toBe(10);
    expect(major[1]).toBe(1);
  });
});
