import { describe, expect, it } from 'vitest';
import {
  addLoad,
  addMember,
  addNode,
  deleteLoad,
  deleteMember,
  deleteNode,
  moveNode,
  pruneOrphanNodes,
  setSupport,
  splitMember,
  updateLoad,
  updateMember,
} from './edit';
import { toSolverModel } from './convert';
import { nextId } from './ids';
import { emptyProject } from './types';
import type { Project } from './types';
import { analyze } from '../solver';

function beam(): Project {
  let p = emptyProject('test');
  p = addNode(p, 0, 0).project;
  p = addNode(p, 6, 0).project;
  p = addMember(p, 'N1', 'N2', 'frame', 'ISMB 300').project;
  p = setSupport(p, 'N1', 'pinned');
  p = setSupport(p, 'N2', 'rollerX');
  return p;
}

describe('ids', () => {
  it('finds the next free id', () => {
    expect(nextId('N', [])).toBe('N1');
    expect(nextId('N', ['N1', 'N7', 'M9', 'Nx'])).toBe('N8');
  });
});

describe('editing operations', () => {
  it('adds nodes without duplicating positions', () => {
    const p = beam();
    expect(addNode(p, 6, 0)).toEqual({ project: p, id: 'N2' });
    const added = addNode(p, 3, 2);
    expect(added.id).toBe('N3');
    expect(added.project.nodes).toHaveLength(3);
  });

  it('moves nodes but never onto another node', () => {
    const p = beam();
    expect(moveNode(p, 'N2', 8, 1).nodes[1]).toEqual({ id: 'N2', x: 8, y: 1 });
    expect(moveNode(p, 'N2', 0, 0)).toBe(p);
    expect(moveNode(p, 'N2', 6, 0)).toBe(p);
    expect(moveNode(p, 'nope', 1, 1)).toBe(p);
  });

  it('adds members without duplicates or zero length', () => {
    const p = beam();
    expect(addMember(p, 'N1', 'N1', 'frame', 'ISMB 300').id).toBeNull();
    expect(addMember(p, 'N2', 'N1', 'truss', 'ISMB 300')).toEqual({ project: p, id: 'M1' });
    const q = addNode(p, 3, 3).project;
    const r = addMember(q, 'N1', 'N3', 'truss', 'ISMC 100');
    expect(r.id).toBe('M2');
    expect(updateMember(r.project, 'M2', { section: 'ISMC 150' }).members[1].section).toBe(
      'ISMC 150',
    );
  });

  it('manages supports and loads', () => {
    let p = beam();
    p = setSupport(p, 'N1', 'fixed');
    expect(p.supports.find((s) => s.node === 'N1')?.kind).toBe('fixed');
    p = setSupport(p, 'N1', null);
    expect(p.supports).toHaveLength(1);
    const added = addLoad(p, { kind: 'nodal', node: 'N2', fx: 0, fy: -5, mz: 0 });
    expect(added.id).toBe('L1');
    p = updateLoad(added.project, 'L1', { fy: -9 });
    expect(p.loads[0]).toMatchObject({ id: 'L1', fy: -9 });
    expect(deleteLoad(p, 'L1').loads).toHaveLength(0);
  });

  it('cascades deletions', () => {
    let p = beam();
    p = addLoad(p, { kind: 'distributed', member: 'M1', direction: 'globalY', w1: -4 }).project;
    p = addLoad(p, { kind: 'nodal', node: 'N2', fx: 1, fy: 0, mz: 0 }).project;
    expect(deleteMember(p, 'M1').loads).toHaveLength(1);
    const q = deleteNode(p, 'N2');
    expect(q.members).toHaveLength(0);
    expect(q.loads).toHaveLength(0);
    expect(q.supports).toHaveLength(1);
    expect(pruneOrphanNodes(q).nodes).toHaveLength(0);
    expect(pruneOrphanNodes(p)).toBe(p);
  });

  it('splits a member and keeps the structural response unchanged', () => {
    let p = beam();
    p = updateMember(p, 'M1', { releaseJ: true });
    p = addLoad(p, {
      kind: 'distributed',
      member: 'M1',
      direction: 'globalY',
      w1: -4,
      w2: -10,
    }).project;
    p = addLoad(p, { kind: 'point', member: 'M1', direction: 'globalY', P: -7, a: 4.5 }).project;
    p = addLoad(p, { kind: 'point', member: 'M1', direction: 'globalY', P: -3, a: 1 }).project;
    p = addLoad(p, {
      kind: 'distributed',
      member: 'M1',
      direction: 'globalY',
      w1: -2,
      a: 3,
      b: 5,
    }).project;
    p = addLoad(p, {
      kind: 'distributed',
      member: 'M1',
      direction: 'globalY',
      w1: -2,
      a: 0,
      b: 1,
    }).project;
    const before = analyze(toSolverModel(p));
    const split = splitMember(p, 'M1', 3);
    expect(split.nodeId).toBe('N3');
    expect(split.project.members.map((m) => [m.id, m.i, m.j, m.releaseJ])).toEqual([
      ['M1', 'N1', 'N3', undefined],
      ['M2', 'N3', 'N2', true],
    ]);
    const after = analyze(toSolverModel(split.project));
    expect(after.reactions.N1.fy).toBeCloseTo(before.reactions.N1.fy, 8);
    expect(after.reactions.N2.fy).toBeCloseTo(before.reactions.N2.fy, 8);
    expect(after.members.M1.end.M).toBeCloseTo(
      before.members.M1.stations.find((s) => Math.abs(s.x - 3) < 1e-9)?.M ?? NaN,
      8,
    );
  });

  it('returns the end node when splitting at an end, and ignores unknown members', () => {
    const p = beam();
    expect(splitMember(p, 'M1', 0)).toEqual({ project: p, nodeId: 'N1' });
    expect(splitMember(p, 'M1', 6)).toEqual({ project: p, nodeId: 'N2' });
    expect(splitMember(p, 'zz', 1)).toEqual({ project: p, nodeId: null });
  });
});
