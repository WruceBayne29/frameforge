import { describe, expect, it } from 'vitest';
import { addNode, emptyProject3D } from '../model3d';
import type { Project3D } from '../model3d';
import { clickAction, pickKindsFor, toolHint, usesPlane } from './interaction';
import type { ClickHit } from './interaction';
import { initialState3D, reducer3D } from './state';
import type { Action3D, AppState3D, Tool3D } from './state';

const miss: ClickHit = { pick: null, plane: null, additive: false };

function nodes(): Project3D {
  let p = emptyProject3D();
  for (const [x, z] of [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ]) {
    p = addNode(p, x, 0, z).project;
  }
  return p;
}

function withTool(tool: Tool3D, project = nodes()): AppState3D {
  return reducer3D(initialState3D(project), { type: 'tool', tool });
}

/** Clicks and applies the resulting action. */
function click(state: AppState3D, hit: Partial<ClickHit>): AppState3D {
  const action = clickAction(state, { ...miss, ...hit });
  return action ? reducer3D(state, action as Action3D) : state;
}
const node = (id: string) => ({ pick: { kind: 'node' as const, id } });

describe('tool picking', () => {
  it('lists what each tool can click', () => {
    expect(pickKindsFor('select', { loadKind: 'nodal' })).toContain('solid');
    expect(pickKindsFor('member', { loadKind: 'nodal' })).toEqual(['node']);
    expect(pickKindsFor('load', { loadKind: 'pressure' })).toEqual(['plate']);
    expect(usesPlane('node')).toBe(true);
    expect(usesPlane('select')).toBe(false);
  });
});

describe('clickAction', () => {
  it('select tool selects and shift-adds', () => {
    let s = withTool('select');
    s = click(s, node('N1'));
    s = click(s, { ...node('N2'), additive: true });
    expect(s.selection).toEqual({ kind: 'node', ids: ['N1', 'N2'] });
    s = click(s, {});
    expect(s.selection).toBeNull();
  });

  it('node tool adds a node on the plane', () => {
    let s = withTool('node');
    s = click(s, { plane: [2, 0, 1] });
    expect(s.project.nodes).toHaveLength(5);
    expect(s.selection).toEqual({ kind: 'node', ids: ['N5'] });
    expect(clickAction(s, miss)).toBeNull();
  });

  it('member tool joins clicked nodes and chains', () => {
    let s = withTool('member');
    s = click(s, node('N1'));
    expect(s.pending).toEqual(['N1']);
    s = click(s, node('N2'));
    s = click(s, node('N3'));
    expect(s.project.members.map((m) => [m.i, m.j])).toEqual([
      ['N1', 'N2'],
      ['N2', 'N3'],
    ]);
    expect(s.pending).toEqual(['N3']);
    // A grid click creates the end node.
    s = click(s, { plane: [0, 0, 6] });
    expect(s.project.members).toHaveLength(3);
    expect(s.project.nodes).toHaveLength(5);
  });

  it('plate tool needs four distinct nodes', () => {
    let s = withTool('plate');
    for (const id of ['N1', 'N2', 'N2', 'N3']) s = click(s, node(id));
    expect(s.project.plates).toHaveLength(0);
    expect(s.pending).toEqual(['N1', 'N2', 'N3']);
    s = click(s, node('N4'));
    expect(s.project.plates).toHaveLength(1);
    expect(s.project.plates[0].nodes).toEqual(['N1', 'N2', 'N3', 'N4']);
    expect(s.pending).toEqual([]);
  });

  it('support, load and delete tools', () => {
    let s = withTool('support');
    s = click(s, node('N1'));
    expect(s.project.supports).toHaveLength(1);
    s = reducer3D(s, { type: 'tool', tool: 'load' });
    s = click(s, node('N2'));
    expect(s.project.loads).toHaveLength(1);
    expect(s.selection?.kind).toBe('load');
    expect(clickAction(s, { ...miss, pick: { kind: 'member', id: 'M1' } })).toBeNull();
    s = reducer3D(s, { type: 'tool', tool: 'delete' });
    s = click(s, node('N2'));
    expect(s.project.nodes).toHaveLength(3);
    expect(s.project.loads).toHaveLength(0);
  });

  it('gives a hint for every tool but select', () => {
    for (const tool of ['node', 'member', 'plate', 'support', 'load', 'delete'] as Tool3D[]) {
      expect(toolHint(withTool(tool))).toBeTruthy();
    }
    expect(toolHint(withTool('select'))).toBeNull();
  });
});
