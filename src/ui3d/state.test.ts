import { describe, expect, it } from 'vitest';
import { EXAMPLES_3D } from '../examples3d';
import { addMember, addNode, emptyProject3D, setSupport } from '../model3d';
import type { Project3D } from '../model3d';
import {
  adaptView,
  applySupport,
  applyToolLoad,
  DEFAULT_TOOL_OPTIONS_3D,
  deleteSelection,
  HISTORY_LIMIT,
  initialState3D,
  pickSelection,
  presetOf,
  reducer3D,
  selectAll,
  solveProject3D,
  toolLoad,
  validSelection,
  viewFor,
} from './state';

function cantilever(): Project3D {
  let p = emptyProject3D('Cantilever');
  p = addNode(p, 0, 0, 0).project;
  p = addNode(p, 4, 0, 0).project;
  p = addMember(p, 'N1', 'N2').project;
  p = setSupport(p, 'N1', [true, true, true, true, true, true]);
  return p;
}

describe('pickSelection', () => {
  it('replaces, toggles and clears', () => {
    const one = pickSelection(null, { kind: 'node', id: 'N1' }, false);
    expect(one).toEqual({ kind: 'node', ids: ['N1'] });
    const two = pickSelection(one, { kind: 'node', id: 'N2' }, true);
    expect(two).toEqual({ kind: 'node', ids: ['N1', 'N2'] });
    expect(pickSelection(two, { kind: 'node', id: 'N1' }, true)).toEqual({
      kind: 'node',
      ids: ['N2'],
    });
    expect(pickSelection(two, { kind: 'member', id: 'M1' }, true)).toEqual({
      kind: 'member',
      ids: ['M1'],
    });
    expect(pickSelection(two, null, true)).toBe(two);
    expect(pickSelection(two, null, false)).toBeNull();
    expect(pickSelection(one, { kind: 'node', id: 'N1' }, true)).toBeNull();
  });
});

describe('reducer3D', () => {
  it('records edits for undo and redo', () => {
    const p = cantilever();
    let s = initialState3D(p);
    const moved = { ...p, name: 'Renamed' };
    s = reducer3D(s, { type: 'edit', project: moved });
    expect(s.past).toHaveLength(1);
    s = reducer3D(s, { type: 'undo' });
    expect(s.project).toBe(p);
    expect(s.future).toHaveLength(1);
    s = reducer3D(s, { type: 'redo' });
    expect(s.project).toBe(moved);
    expect(reducer3D(s, { type: 'redo' })).toBe(s);
  });

  it('limits history and makes loading undoable', () => {
    let s = initialState3D(cantilever());
    for (let k = 0; k < HISTORY_LIMIT + 10; k++) {
      s = reducer3D(s, { type: 'edit', project: { ...s.project, name: `v${k}` } });
    }
    expect(s.past).toHaveLength(HISTORY_LIMIT);
    const example = EXAMPLES_3D[0].build();
    const loaded = reducer3D(s, { type: 'load', project: example });
    expect(loaded.project).toBe(example);
    expect(loaded.camera.count).toBe(s.camera.count + 1);
    expect(reducer3D(loaded, { type: 'undo' }).project).toBe(s.project);
  });

  it('drops selected ids that disappear', () => {
    let s = initialState3D(cantilever());
    s = reducer3D(s, { type: 'select', selection: { kind: 'node', ids: ['N1', 'N2', 'N9'] } });
    expect(s.selection?.ids).toEqual(['N1', 'N2']);
    s = reducer3D(s, {
      type: 'edit',
      project: deleteSelection(s.project, { kind: 'node', ids: ['N2'] }),
    });
    expect(s.selection?.ids).toEqual(['N1']);
  });

  it('clears pending picks when the tool changes', () => {
    let s = initialState3D(cantilever());
    s = reducer3D(s, { type: 'tool', tool: 'member' });
    s = reducer3D(s, { type: 'pending', pending: ['N1'] });
    s = reducer3D(s, { type: 'tool', tool: 'plate' });
    expect(s.pending).toEqual([]);
  });

  it('applies view and tool options and camera requests', () => {
    let s = initialState3D(cantilever());
    s = reducer3D(s, { type: 'view', view: { diagram: 'N' } });
    s = reducer3D(s, { type: 'toolOptions', options: { elevation: 3 } });
    s = reducer3D(s, { type: 'camera', preset: 'top' });
    expect(s.view.diagram).toBe('N');
    expect(s.toolOptions.elevation).toBe(3);
    expect(s.camera).toEqual({ preset: 'top', count: 1 });
  });
});

describe('view defaults', () => {
  it('suit the model', () => {
    const slab = EXAMPLES_3D.find((e) => e.id === 'simply-supported-slab')?.build();
    const truss = EXAMPLES_3D.find((e) => e.id === 'tower-25-bar')?.build();
    const solid = EXAMPLES_3D.find((e) => e.id === 'solid-cantilever')?.build();
    const base = initialState3D(cantilever()).view;
    expect(viewFor(slab as Project3D, base)).toMatchObject({
      diagram: 'none',
      contour: 'plateVonMisesTop',
      labels: false,
    });
    expect(viewFor(truss as Project3D, base).diagram).toBe('N');
    expect(viewFor(solid as Project3D, base).contour).toBe('solidVonMises');
  });
});

describe('adaptView', () => {
  it('turns on contours and diagrams for new kinds of element and drops labels on growth', () => {
    const empty = emptyProject3D();
    const base = initialState3D(empty).view;
    const slab = EXAMPLES_3D.find((e) => e.id === 'simply-supported-slab')?.build() as Project3D;
    const v = adaptView(empty, slab, { ...base, contour: 'none', labels: true });
    expect(v.contour).toBe('plateVonMisesTop');
    expect(v.labels).toBe(false);
    const frame = adaptView(empty, cantilever(), { ...base, diagram: 'none' });
    expect(frame.diagram).toBe('Mz');
    const same = { ...base, contour: 'displacement' as const };
    expect(adaptView(slab, slab, same)).toBe(same);
  });
});

describe('selection helpers', () => {
  it('select all, validate and delete', () => {
    const p = cantilever();
    expect(selectAll(p, 'node')).toEqual({ kind: 'node', ids: ['N1', 'N2'] });
    expect(selectAll(p, 'plate')).toBeNull();
    expect(validSelection(p, { kind: 'member', ids: ['M9'] })).toBeNull();
    const next = deleteSelection(p, { kind: 'member', ids: ['M1'] });
    expect(next.members).toHaveLength(0);
    expect(deleteSelection(p, null)).toBe(p);
  });
});

describe('supports and loads from the tools', () => {
  it('applies presets and recognises them', () => {
    const p = cantilever();
    const pinned = applySupport(p, ['N2'], {
      supportPreset: 'pinned',
      restraints: DEFAULT_TOOL_OPTIONS_3D.restraints,
    });
    expect(presetOf(pinned.supports.find((s) => s.node === 'N2')?.restraints)).toBe('pinned');
    const custom = applySupport(p, ['N2'], {
      supportPreset: 'custom',
      restraints: [false, true, true, false, false, false],
    });
    expect(presetOf(custom.supports.find((s) => s.node === 'N2')?.restraints)).toBe('custom');
    const removed = applySupport(p, ['N1'], {
      supportPreset: 'none',
      restraints: DEFAULT_TOOL_OPTIONS_3D.restraints,
    });
    expect(removed.supports).toHaveLength(0);
    expect(presetOf(undefined)).toBe('none');
  });

  it('builds the load the tool would add, only for matching targets', () => {
    const p = cantilever();
    const o = { ...DEFAULT_TOOL_OPTIONS_3D, loadKind: 'point' as const, loadValue: -5 };
    expect(toolLoad(p, o, 'node', ['N1'])).toBeNull();
    expect(toolLoad(p, o, 'member', ['M1'])).toEqual({
      kind: 'point',
      members: ['M1'],
      direction: 'globalY',
      P: -5,
      a: 2,
    });
    const nodal = toolLoad(p, { ...o, loadKind: 'nodal', loadDirection: 'globalX' }, 'node', [
      'N2',
    ]);
    expect(nodal).toMatchObject({ kind: 'nodal', fx: -5, fy: 0, fz: 0 });
    const r = applyToolLoad(p, { ...o, loadKind: 'distributed' }, 'member', ['M1']);
    expect(r?.project.loads[0]).toMatchObject({ kind: 'distributed', w1: -5, id: r?.id });
    expect(toolLoad(p, { ...o, loadKind: 'face', loadFace: 3 }, 'solid', ['S1'])).toMatchObject({
      face: 3,
    });
    expect(toolLoad(p, { ...o, loadKind: 'pressure' }, 'plate', ['P1'])).toMatchObject({ p: -5 });
  });
});

describe('solveProject3D', () => {
  it('solves, reports nothing for an empty model and never throws', () => {
    expect(solveProject3D(emptyProject3D())).toMatchObject({ result: null, error: null });
    const r = applyToolLoad(
      cantilever(),
      { ...DEFAULT_TOOL_OPTIONS_3D, loadKind: 'nodal' },
      'node',
      ['N2'],
    );
    const solved = solveProject3D(r?.project as Project3D);
    expect(solved.error).toBeNull();
    expect(solved.result?.maxDisplacement).toBeGreaterThan(0);
    const unsupported = solveProject3D({ ...cantilever(), supports: [] });
    expect(unsupported.result).toBeNull();
    expect(unsupported.error?.message).toBeTruthy();
  });

  it('solves every example', () => {
    for (const example of EXAMPLES_3D) {
      const s = solveProject3D(example.build());
      expect(s.error, example.id).toBeNull();
      expect(s.result?.dofCount, example.id).toBeGreaterThan(0);
    }
  });
});
