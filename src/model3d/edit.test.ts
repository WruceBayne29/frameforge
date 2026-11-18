import { describe, expect, it } from 'vitest';
import {
  addLoad,
  addMember,
  addNode,
  addPlate,
  addSolid,
  deleteLoad,
  deleteMember,
  deleteNode,
  deletePlate,
  deleteSolid,
  findNodeAt3D,
  loadTargets,
  mergeCoincidentNodes,
  setNodeMass,
  moveNode,
  pruneOrphanNodes,
  setSupport,
  updateLoad,
  updateMember,
  updatePlate,
  updateSolid,
  withLoadTargets,
} from './edit';
import { idSequence, nextId } from './ids';
import { emptyProject3D, FIXED_SUPPORT, PINNED_SUPPORT } from './types';
import type { Project3D } from './types';

/** A unit cube of nodes N1…N8 (bottom face N1–N4, top face N5–N8). */
function cube(): Project3D {
  let p = emptyProject3D();
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
  for (const [x, y, z] of pts) p = addNode(p, x, y, z).project;
  return p;
}
const ALL = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'];

describe('ids', () => {
  it('nextId and idSequence continue after the largest number in use', () => {
    expect(nextId('N', ['N1', 'N7', 'M9', 'Nx'])).toBe('N8');
    const next = idSequence('P', ['P3']);
    expect([next(), next()]).toEqual(['P4', 'P5']);
  });
});

describe('nodes', () => {
  it('addNode reuses a node within the tolerance', () => {
    const p0 = emptyProject3D();
    const a = addNode(p0, 1, 2, 3);
    expect(a.id).toBe('N1');
    expect(p0.nodes).toHaveLength(0); // immutable
    const b = addNode(a.project, 1 + 1e-9, 2, 3);
    expect(b.id).toBe('N1');
    expect(b.project).toBe(a.project);
    const c = addNode(a.project, 1.01, 2, 3);
    expect(c.id).toBe('N2');
    expect(addNode(a.project, 1.01, 2, 3, 0.05).id).toBe('N1');
    expect(findNodeAt3D(c.project, 1.01, 2, 3)?.id).toBe('N2');
    expect(findNodeAt3D(c.project, 1.01, 2, 4)).toBeUndefined();
  });

  it('moveNode moves, but not onto another node or to an invalid position', () => {
    const p = cube();
    const moved = moveNode(p, 'N1', -1, 0, 0);
    expect(moved.nodes[0]).toEqual({ id: 'N1', x: -1, y: 0, z: 0 });
    expect(p.nodes[0].x).toBe(0);
    expect(moveNode(p, 'N1', 0, 0, 1)).toBe(p);
    expect(moveNode(p, 'N1', 0, 0, 0)).toBe(p);
    expect(moveNode(p, 'N1', NaN, 0, 0)).toBe(p);
    expect(moveNode(p, 'nope', 5, 5, 5)).toBe(p);
  });

  it('deleteNode cascades to elements, supports and load targets', () => {
    let p = cube();
    p = addNode(p, 2, 0, 0).project; // N9
    const m1 = addMember(p, 'N1', 'N2');
    const m2 = addMember(m1.project, 'N4', 'N9');
    const pl = addPlate(m2.project, ['N1', 'N2', 'N3', 'N4']);
    const so = addSolid(pl.project, ALL);
    p = setSupport(so.project, 'N1', FIXED_SUPPORT);
    p = setSupport(p, 'N9', PINNED_SUPPORT);
    p = addLoad(p, {
      kind: 'nodal',
      nodes: ['N1', 'N9'],
      fx: 1,
      fy: 0,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    }).project;
    p = addLoad(p, {
      kind: 'nodal',
      nodes: ['N1'],
      fx: 2,
      fy: 0,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    }).project;
    p = addLoad(p, {
      kind: 'distributed',
      members: ['M1', 'M2'],
      direction: 'globalY',
      w1: -1,
    }).project;
    p = addLoad(p, { kind: 'point', members: ['M1'], direction: 'globalY', P: -1, a: 0.5 }).project;
    p = addLoad(p, { kind: 'pressure', plates: ['P1'], direction: 'localZ', p: 1 }).project;
    p = addLoad(p, { kind: 'face', solids: ['S1'], face: 2, direction: 'normal', p: 1 }).project;

    const after = deleteNode(p, 'N1');
    expect(after.nodes.map((n) => n.id)).not.toContain('N1');
    expect(after.members.map((m) => m.id)).toEqual(['M2']);
    expect(after.plates).toEqual([]);
    expect(after.solids).toEqual([]);
    expect(after.supports.map((s) => s.node)).toEqual(['N9']);
    // L1 loses a target, L3 loses a target, L2/L4/L5/L6 lose all their targets
    expect(after.loads.map((l) => l.id)).toEqual(['L1', 'L3']);
    expect(loadTargets(after.loads[0]).ids).toEqual(['N9']);
    expect(loadTargets(after.loads[1]).ids).toEqual(['M2']);
    // the original is untouched
    expect(p.loads).toHaveLength(6);
    expect(p.members).toHaveLength(2);
    expect(deleteNode(p, 'nope')).toBe(p);
  });
});

describe('elements', () => {
  it('addMember rejects degenerate members and reuses duplicates', () => {
    const p = cube();
    expect(addMember(p, 'N1', 'N1').id).toBeNull();
    expect(addMember(p, 'N1', 'nope').id).toBeNull();
    const a = addMember(p, 'N1', 'N2', { type: 'truss', section: 'ISMC 150', beta: 30 });
    expect(a.project.members[0]).toEqual({
      id: 'M1',
      i: 'N1',
      j: 'N2',
      type: 'truss',
      section: 'ISMC 150',
      material: 'Steel',
      beta: 30,
    });
    const again = addMember(a.project, 'N2', 'N1');
    expect(again.id).toBe('M1');
    expect(again.project).toBe(a.project);
    const b = addMember(a.project, 'N2', 'N3', { releaseI: { mz: true }, releaseJ: { my: true } });
    expect(b.project.members[1]).toMatchObject({
      id: 'M2',
      type: 'beam',
      section: 'ISMB 300',
      releaseI: { mz: true },
      releaseJ: { my: true },
    });
  });

  it('addPlate rejects degenerate plates and reuses duplicates', () => {
    const p = cube();
    expect(addPlate(p, ['N1', 'N2', 'N3']).id).toBeNull();
    expect(addPlate(p, ['N1', 'N2', 'N3', 'N3']).id).toBeNull();
    expect(addPlate(p, ['N1', 'N2', 'N3', 'nope']).id).toBeNull();
    const a = addPlate(p, ['N1', 'N2', 'N3', 'N4'], { thickness: 200, material: 'Concrete M25' });
    expect(a.project.plates[0]).toEqual({
      id: 'P1',
      nodes: ['N1', 'N2', 'N3', 'N4'],
      thickness: 200,
      material: 'Concrete M25',
    });
    // same four nodes in another order is the same plate
    expect(addPlate(a.project, ['N3', 'N4', 'N1', 'N2']).id).toBe('P1');
    expect(addPlate(a.project, ['N5', 'N6', 'N7', 'N8']).project.plates[1]).toMatchObject({
      id: 'P2',
      thickness: 150,
      material: 'Steel',
    });
  });

  it('addSolid rejects degenerate solids and reuses duplicates', () => {
    const p = cube();
    expect(addSolid(p, ALL.slice(0, 7)).id).toBeNull();
    expect(addSolid(p, [...ALL.slice(0, 7), 'N1']).id).toBeNull();
    expect(addSolid(p, [...ALL.slice(0, 7), 'nope']).id).toBeNull();
    const a = addSolid(p, ALL, { material: 'Concrete M25' });
    expect(a.project.solids[0]).toEqual({ id: 'S1', nodes: ALL, material: 'Concrete M25' });
    expect(addSolid(a.project, [...ALL].reverse()).id).toBe('S1');
  });

  it('update* patch elements without changing ids; delete* drop load targets', () => {
    let p = cube();
    p = addMember(p, 'N1', 'N2').project;
    p = addMember(p, 'N2', 'N3').project;
    p = addPlate(p, ['N1', 'N2', 'N3', 'N4']).project;
    p = addPlate(p, ['N5', 'N6', 'N7', 'N8']).project;
    p = addSolid(p, ALL).project;
    p = updateMember(p, 'M1', { section: 'ISMB 400', id: 'hack' });
    p = updatePlate(p, 'P1', { thickness: 220, id: 'hack' });
    p = updateSolid(p, 'S1', { material: 'Concrete M25', id: 'hack' });
    expect(p.members[0]).toMatchObject({ id: 'M1', section: 'ISMB 400' });
    expect(p.plates[0]).toMatchObject({ id: 'P1', thickness: 220 });
    expect(p.solids[0]).toMatchObject({ id: 'S1', material: 'Concrete M25' });

    p = addLoad(p, {
      kind: 'distributed',
      members: ['M1', 'M2'],
      direction: 'globalY',
      w1: -1,
    }).project;
    p = addLoad(p, { kind: 'moment', members: ['M1'], direction: 'localX', M: 1, a: 0.5 }).project;
    p = addLoad(p, { kind: 'pressure', plates: ['P1', 'P2'], direction: 'localZ', p: 1 }).project;
    p = addLoad(p, {
      kind: 'platePoint',
      plates: ['P1'],
      direction: 'localZ',
      P: 1,
      xi: 0,
      eta: 0,
    }).project;
    p = addLoad(p, { kind: 'face', solids: ['S1'], face: 1, direction: 'globalX', p: 1 }).project;

    const a = deleteMember(p, 'M1');
    expect(a.members.map((m) => m.id)).toEqual(['M2']);
    expect(a.loads.map((l) => l.id)).toEqual(['L1', 'L3', 'L4', 'L5']);
    expect(loadTargets(a.loads[0])).toEqual({ kind: 'members', ids: ['M2'] });
    const b = deletePlate(a, 'P1');
    expect(b.loads.map((l) => l.id)).toEqual(['L1', 'L3', 'L5']);
    expect(loadTargets(b.loads[1])).toEqual({ kind: 'plates', ids: ['P2'] });
    const c = deleteSolid(b, 'S1');
    expect(c.solids).toEqual([]);
    expect(c.loads.map((l) => l.id)).toEqual(['L1', 'L3']);
    expect(deleteMember(c, 'nope')).toBe(c);
    expect(deletePlate(c, 'nope')).toBe(c);
    expect(deleteSolid(c, 'nope')).toBe(c);
  });
});

describe('supports and loads', () => {
  it('setSupport sets, replaces and removes', () => {
    const p = cube();
    const a = setSupport(p, 'N1', FIXED_SUPPORT);
    expect(a.supports).toEqual([{ node: 'N1', restraints: [true, true, true, true, true, true] }]);
    expect(a.supports[0].restraints).not.toBe(FIXED_SUPPORT);
    const b = setSupport(a, 'N1', PINNED_SUPPORT);
    expect(b.supports).toHaveLength(1);
    expect(b.supports[0].restraints).toEqual(PINNED_SUPPORT);
    expect(setSupport(b, 'N1', null).supports).toEqual([]);
    expect(setSupport(b, 'N1', [false, false, false, false, false, false]).supports).toEqual([]);
    expect(setSupport(p, 'N1', null)).toBe(p);
    expect(setSupport(p, 'nope', FIXED_SUPPORT)).toBe(p);
  });

  it('addLoad / updateLoad / deleteLoad', () => {
    let p = cube();
    const a = addLoad(p, {
      kind: 'nodal',
      nodes: ['N1'],
      fx: 1,
      fy: 0,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    });
    expect(a.id).toBe('L1');
    p = addLoad(a.project, {
      kind: 'nodal',
      nodes: ['N2'],
      fx: 0,
      fy: -3,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    }).project;
    expect(p.loads.map((l) => l.id)).toEqual(['L1', 'L2']);
    p = updateLoad(p, 'L2', { fy: -9, nodes: ['N2', 'N3'] });
    expect(p.loads[1]).toMatchObject({ id: 'L2', kind: 'nodal', fy: -9, nodes: ['N2', 'N3'] });
    p = deleteLoad(p, 'L1');
    expect(p.loads.map((l) => l.id)).toEqual(['L2']);
    // ids are not reused below the largest one in use
    expect(
      addLoad(p, { kind: 'nodal', nodes: ['N1'], fx: 1, fy: 0, fz: 0, mx: 0, my: 0, mz: 0 }).id,
    ).toBe('L3');
  });

  it('withLoadTargets swaps the targets of every kind of load', () => {
    const p = cube();
    const kinds = [
      addLoad(p, { kind: 'nodal', nodes: ['a'], fx: 1, fy: 0, fz: 0, mx: 0, my: 0, mz: 0 }),
      addLoad(p, { kind: 'distributed', members: ['a'], direction: 'globalY', w1: -1 }),
      addLoad(p, { kind: 'pressure', plates: ['a'], direction: 'localZ', p: 1 }),
      addLoad(p, { kind: 'face', solids: ['a'], face: 1, direction: 'normal', p: 1 }),
    ].map((r) => r.project.loads[0]);
    expect(kinds.map((l) => loadTargets(l).kind)).toEqual(['nodes', 'members', 'plates', 'solids']);
    for (const load of kinds) {
      const swapped = withLoadTargets(load, ['x', 'y']);
      expect(loadTargets(swapped).ids).toEqual(['x', 'y']);
      expect(swapped.kind).toBe(load.kind);
      expect(loadTargets(load).ids).toEqual(['a']);
    }
  });
});

describe('clean-up', () => {
  it('pruneOrphanNodes removes unused nodes with their supports and load targets', () => {
    let p = cube();
    p = addMember(p, 'N1', 'N2').project;
    p = addPlate(p, ['N1', 'N2', 'N3', 'N4']).project;
    p = setSupport(p, 'N8', FIXED_SUPPORT);
    p = setSupport(p, 'N1', FIXED_SUPPORT);
    p = addLoad(p, {
      kind: 'nodal',
      nodes: ['N1', 'N8'],
      fx: 1,
      fy: 0,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    }).project;
    p = addLoad(p, {
      kind: 'nodal',
      nodes: ['N7'],
      fx: 1,
      fy: 0,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    }).project;
    const pruned = pruneOrphanNodes(p);
    expect(pruned.nodes.map((n) => n.id)).toEqual(['N1', 'N2', 'N3', 'N4']);
    expect(pruned.supports.map((s) => s.node)).toEqual(['N1']);
    expect(pruned.loads).toHaveLength(1);
    expect(loadTargets(pruned.loads[0]).ids).toEqual(['N1']);
    expect(pruneOrphanNodes(pruned)).toBe(pruned);
    // nodes of solids count as used
    const withSolid = addSolid(cube(), ALL).project;
    expect(pruneOrphanNodes(withSolid)).toBe(withSolid);
  });

  it('mergeCoincidentNodes re-points everything and drops collapsed elements', () => {
    let p = emptyProject3D();
    // two unit squares side by side whose shared edge was modelled with separate nodes
    const pts: Array<[number, number, number]> = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
      [1.0004, 0, 0], // ≈ N2
      [2, 0, 0],
      [2, 0, 1],
      [1, 0, 1.0004], // ≈ N3
      [1, 0, 0.0002], // ≈ N2 as well
    ];
    p = { ...p, nodes: pts.map(([x, y, z], k) => ({ id: `N${k + 1}`, x, y, z })) };
    p = addPlate(p, ['N1', 'N2', 'N3', 'N4']).project;
    p = addPlate(p, ['N5', 'N6', 'N7', 'N8']).project;
    p = addMember(p, 'N1', 'N2').project; // M1
    p = addMember(p, 'N1', 'N5').project; // M2 duplicates M1 after the merge
    p = addMember(p, 'N2', 'N9').project; // M3 collapses
    p = addMember(p, 'N5', 'N6').project; // M4 becomes N2–N6
    p = setSupport(p, 'N2', [true, false, false, false, false, false]);
    p = setSupport(p, 'N5', [false, true, false, false, false, false]);
    p = setSupport(p, 'N6', PINNED_SUPPORT);
    p = addLoad(p, {
      kind: 'nodal',
      nodes: ['N2', 'N5', 'N9', 'N6'],
      fx: 1,
      fy: 0,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    }).project;
    p = addLoad(p, {
      kind: 'distributed',
      members: ['M2', 'M3'],
      direction: 'globalY',
      w1: -1,
    }).project;
    p = addLoad(p, {
      kind: 'distributed',
      members: ['M1', 'M3', 'M4'],
      direction: 'globalY',
      w1: -1,
    }).project;

    expect(mergeCoincidentNodes(p)).toBe(p); // nothing within the default 1e-6
    const merged = mergeCoincidentNodes(p, 1e-3);
    expect(merged.nodes.map((n) => n.id)).toEqual(['N1', 'N2', 'N3', 'N4', 'N6', 'N7']);
    expect(merged.plates.map((pl) => pl.nodes)).toEqual([
      ['N1', 'N2', 'N3', 'N4'],
      ['N2', 'N6', 'N7', 'N3'],
    ]);
    expect(merged.members.map((m) => [m.id, m.i, m.j])).toEqual([
      ['M1', 'N1', 'N2'],
      ['M4', 'N2', 'N6'],
    ]);
    expect(merged.supports).toEqual([
      { node: 'N2', restraints: [true, true, false, false, false, false] },
      { node: 'N6', restraints: PINNED_SUPPORT },
    ]);
    expect(merged.loads.map((l) => [l.id, loadTargets(l).ids])).toEqual([
      ['L1', ['N2', 'N6']],
      ['L3', ['M1', 'M4']],
    ]);
    // input untouched
    expect(p.nodes).toHaveLength(9);
    expect(p.plates[1].nodes).toEqual(['N5', 'N6', 'N7', 'N8']);
  });

  it('mergeCoincidentNodes drops plates and solids that collapse or repeat', () => {
    let p = cube();
    p = addNode(p, 0, 0, 0.0001).project; // N9 ≈ N1
    p = addNode(p, 0, 1, 0.0001).project; // N10 ≈ N5
    p = addPlate(p, ['N1', 'N2', 'N3', 'N4']).project;
    p = addPlate(p, ['N9', 'N2', 'N3', 'N4']).project; // repeats P1
    p = addPlate(p, ['N1', 'N9', 'N3', 'N4']).project; // collapses
    p = addSolid(p, ALL).project;
    p = addSolid(p, ['N9', 'N2', 'N3', 'N4', 'N10', 'N6', 'N7', 'N8']).project; // repeats S1
    p = addLoad(p, { kind: 'pressure', plates: ['P2', 'P3'], direction: 'localZ', p: 1 }).project;
    p = addLoad(p, {
      kind: 'face',
      solids: ['S1', 'S2'],
      face: 1,
      direction: 'normal',
      p: 1,
    }).project;
    const merged = mergeCoincidentNodes(p, 1e-3);
    expect(merged.nodes).toHaveLength(8);
    expect(merged.plates.map((pl) => pl.id)).toEqual(['P1']);
    expect(merged.solids.map((s) => s.id)).toEqual(['S1']);
    expect(merged.loads.map((l) => [l.id, loadTargets(l).ids])).toEqual([['L2', ['S1']]]);
  });
});

describe('lumped nodal masses', () => {
  it('sets, replaces and removes masses; deleting a node drops its mass', () => {
    let p = emptyProject3D();
    p = addNode(p, 0, 0, 0).project;
    p = addNode(p, 1, 0, 0).project;
    p = setNodeMass(p, ['N1', 'N2', 'missing'], 2);
    expect(p.masses).toEqual([
      { node: 'N1', mass: 2 },
      { node: 'N2', mass: 2 },
    ]);
    p = setNodeMass(p, ['N1'], 5);
    expect(p.masses).toEqual([
      { node: 'N2', mass: 2 },
      { node: 'N1', mass: 5 },
    ]);
    expect(setNodeMass(p, ['N1'], -1)).toBe(p);
    expect(deleteNode(p, 'N1').masses).toEqual([{ node: 'N2', mass: 2 }]);
    expect(setNodeMass(setNodeMass(p, ['N1'], 0), ['N2'], 0).masses).toBeUndefined();
  });
});
