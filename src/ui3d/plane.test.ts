import { describe, expect, it } from 'vitest';
import { getExample3D } from '../examples3d';
import {
  addMember,
  addNode,
  analyzeProject3D,
  emptyProject3D,
  hasOutOfPlaneLoad,
  moveNode,
  nodesOffPlane,
  setPlaneMode,
  setSupport,
  SUPPORT_2D_RESTRAINTS,
  toSolverModel3D,
} from '../model3d';
import type { Project3D } from '../model3d';
import { gridSegments, influenceGeometry, supportGlyphs } from './viewer/build';
import {
  applySupport,
  DEFAULT_TOOL_OPTIONS_3D,
  initialState3D,
  optionsFor,
  presetOf,
  reducer3D,
  restraintsForPreset,
  viewFor,
  DEFAULT_VIEW_3D,
} from './state';
import { toolHint } from './interaction';

/** A plane portal: two columns and a beam, fixed feet, a sway load. */
function portal(): Project3D {
  let p = emptyProject3D('Portal');
  p.plane = 'XY';
  for (const [x, y] of [
    [0, 0],
    [0, 4],
    [6, 4],
    [6, 0],
  ])
    p = addNode(p, x, y, 0).project;
  p = addMember(p, 'N1', 'N2').project;
  p = addMember(p, 'N2', 'N3').project;
  p = addMember(p, 'N3', 'N4').project;
  p = setSupport(p, 'N1', [...SUPPORT_2D_RESTRAINTS.fixed]);
  p = setSupport(p, 'N4', [...SUPPORT_2D_RESTRAINTS.pinned]);
  p.loads.push({
    id: 'L1',
    kind: 'nodal',
    nodes: ['N2'],
    fx: 10,
    fy: 0,
    fz: 0,
    mx: 0,
    my: 0,
    mz: 0,
  });
  return p;
}

describe('plane frame mode: model', () => {
  it('holds every node out of plane in the solver model only', () => {
    const p = portal();
    const model = toSolverModel3D(p);
    expect(model.supports.map((s) => s.node)).toEqual(['N1', 'N4']);
    expect(model.restrainAll).toEqual({ uz: true, rx: true, ry: true });
    expect(toSolverModel3D({ ...p, plane: undefined }).restrainAll).toBeUndefined();
  });

  it('reports reactions only at the real supports, and no warnings', () => {
    const r = analyzeProject3D(portal());
    expect(Object.keys(r.reactions).sort()).toEqual(['N1', 'N4']);
    expect(r.warnings).toEqual([]);
    const sum = Object.values(r.reactions).reduce((s, v) => s + v.fx, 0);
    expect(sum).toBeCloseTo(-10, 9);
    for (const d of Object.values(r.displacements)) expect(d.uz).toBe(0);
  });

  it('warns when loads act out of plane', () => {
    const p = portal();
    p.loads.push({
      id: 'L2',
      kind: 'nodal',
      nodes: ['N3'],
      fx: 0,
      fy: 0,
      fz: 5,
      mx: 0,
      my: 0,
      mz: 0,
    });
    const r = analyzeProject3D(p);
    expect(r.warnings.some((w) => /out of the XY plane/.test(w))).toBe(true);
    // Equilibrium still closes: the plane restraint's reactions are counted.
    expect(Math.abs(r.equilibrium[2])).toBeLessThan(1e-9);
  });

  it('recognises out-of-plane loads of every kind', () => {
    const p = portal();
    const nodal = p.loads[0];
    const add = (load: Project3D['loads'][number]) =>
      hasOutOfPlaneLoad({ ...p, loads: [nodal, load] });
    expect(hasOutOfPlaneLoad(p)).toBe(false);
    expect(add({ id: 'a', kind: 'distributed', members: ['M2'], direction: 'localZ', w1: 1 })).toBe(
      true,
    );
    expect(
      add({ id: 'a', kind: 'distributed', members: ['M2'], direction: 'globalY', w1: 1 }),
    ).toBe(false);
    expect(
      add({ id: 'a', kind: 'distributed', members: ['M2'], direction: 'globalZ', w1: 0, w2: 2 }),
    ).toBe(true);
    expect(add({ id: 'a', kind: 'point', members: ['M2'], direction: 'globalZ', P: 1, a: 1 })).toBe(
      true,
    );
    expect(add({ id: 'a', kind: 'moment', members: ['M2'], direction: 'localZ', M: 1, a: 1 })).toBe(
      false,
    );
    expect(
      add({ id: 'a', kind: 'moment', members: ['M2'], direction: 'globalX', M: 1, a: 1 }),
    ).toBe(true);
    expect(add({ id: 'a', kind: 'pressure', plates: ['P1'], direction: 'localZ', p: 1 })).toBe(
      true,
    );
    expect(
      add({
        id: 'a',
        kind: 'platePoint',
        plates: ['P1'],
        direction: 'globalX',
        P: 1,
        xi: 0,
        eta: 0,
      }),
    ).toBe(false);
    expect(
      add({ id: 'a', kind: 'face', solids: ['S1'], face: 1, direction: 'globalZ', p: 1 }),
    ).toBe(true);
    expect(add({ id: 'a', kind: 'face', solids: ['S1'], face: 1, direction: 'normal', p: 1 })).toBe(
      false,
    );
  });

  it('switches on only when every node lies on z = 0', () => {
    const p = { ...portal(), plane: undefined };
    const on = setPlaneMode(p, true);
    expect(on?.plane).toBe('XY');
    expect(setPlaneMode(on as Project3D, true)).toBe(on);
    const off = setPlaneMode(on as Project3D, false) as Project3D;
    expect(off.plane).toBeUndefined();
    expect(setPlaneMode(off, false)).toBe(off);
    const lifted = moveNode(p, 'N3', 6, 4, 2);
    expect(nodesOffPlane(lifted)).toEqual(['N3']);
    expect(setPlaneMode(lifted, true)).toBeNull();
    // A node within the tolerance is put exactly on the plane.
    const near = { ...p, nodes: p.nodes.map((n) => (n.id === 'N3' ? { ...n, z: 1e-9 } : n)) };
    expect(setPlaneMode(near, true)?.nodes.find((n) => n.id === 'N3')?.z).toBe(0);
  });
});

describe('plane frame mode: supports', () => {
  it('classifies restraints by their in-plane components', () => {
    expect(presetOf(SUPPORT_2D_RESTRAINTS.fixed, true)).toBe('fixed');
    expect(presetOf(SUPPORT_2D_RESTRAINTS.pinned, true)).toBe('pinned');
    expect(presetOf(SUPPORT_2D_RESTRAINTS.rollerX, true)).toBe('rollerX');
    expect(presetOf(SUPPORT_2D_RESTRAINTS.rollerY, true)).toBe('rollerY');
    expect(presetOf([false, false, false, false, false, true], true)).toBe('custom');
    expect(presetOf([false, false, true, false, false, false], true)).toBe('none');
    expect(presetOf([true, true, true, false, false, false], true)).toBe('pinned');
    expect(restraintsForPreset('rollerY', [false, false, false, false, false, false])).toEqual(
      SUPPORT_2D_RESTRAINTS.rollerY,
    );
    const p = applySupport(portal(), ['N2'], {
      supportPreset: 'rollerX',
      restraints: DEFAULT_TOOL_OPTIONS_3D.restraints,
    });
    expect(p.supports.find((s) => s.node === 'N2')?.restraints).toEqual(
      SUPPORT_2D_RESTRAINTS.rollerX,
    );
  });

  it('draws the 2D support symbols', () => {
    const p = portal();
    p.supports.push({ node: 'N2', restraints: [...SUPPORT_2D_RESTRAINTS.rollerY] });
    p.supports.push({ node: 'N3', restraints: [false, false, true, true, true, true] });
    const glyphs = supportGlyphs(p);
    const of = (node: string) => glyphs.filter((g) => g.node === node).map((g) => g.shape);
    expect(of('N1')).toEqual(['base']);
    expect(of('N4')).toEqual(['pyramid']);
    expect(of('N2')).toEqual(['pyramid', 'roller']);
    expect(glyphs.find((g) => g.node === 'N2')?.direction).toEqual([1, 0, 0]);
    expect(of('N3')).toEqual(['cube']);
    const roller: Project3D = {
      ...p,
      supports: [{ node: 'N1', restraints: [false, true, true, true, true, true] }],
    };
    expect(supportGlyphs(roller).map((g) => g.shape)).toEqual(['pyramid', 'roller', 'cube']);
  });

  it('draws the grid in the z = 0 plane', () => {
    const [minor, major] = gridSegments({
      cx: 2,
      cz: 3,
      half: 2,
      y: 7,
      spacing: 1,
      majorEvery: 2,
      plane: 'XY',
    });
    for (const array of [minor, major]) {
      for (let k = 2; k < array.length; k += 3) expect(array[k]).toBe(0);
    }
    expect(Math.max(...major.filter((_, k) => k % 3 === 1))).toBe(6); // centre snapped to a major line (y = 4) ± 2
  });
});

describe('plane frame mode: workspace state', () => {
  it('opens plane projects in the front view with 2D tool options', () => {
    const p = portal();
    const state = initialState3D(p);
    expect(state.camera.preset).toBe('front');
    const options = optionsFor(p, {
      ...DEFAULT_TOOL_OPTIONS_3D,
      supportPreset: 'roller',
      loadDirection: 'globalZ',
      loadKind: 'face',
    });
    expect(options).toMatchObject({
      supportPreset: 'fixed',
      loadDirection: 'globalY',
      loadKind: 'nodal',
    });
    expect(
      optionsFor({ ...p, plane: undefined }, { ...options, supportPreset: 'rollerY' })
        .supportPreset,
    ).toBe('roller');
    const unchanged = { ...DEFAULT_TOOL_OPTIONS_3D };
    expect(optionsFor({ ...p, plane: undefined }, unchanged)).toBe(unchanged);
    expect(viewFor(p, DEFAULT_VIEW_3D).diagram).toBe('Mz');
    expect(toolHint({ ...state, tool: 'node' })).toMatch(/z = 0/);
  });

  it('follows plane mode on and off through edits, undo and redo', () => {
    const p = portal();
    let state = initialState3D({ ...p, plane: undefined });
    state = reducer3D(state, { type: 'view', view: { diagram: 'My' } });
    expect(state.camera.preset).toBe('iso');
    state = reducer3D(state, { type: 'edit', project: p });
    expect(state.camera.preset).toBe('front');
    expect(state.view.diagram).toBe('Mz');
    state = reducer3D(state, { type: 'undo' });
    expect(state.camera.preset).toBe('iso');
    state = reducer3D(state, { type: 'redo' });
    expect(state.camera.preset).toBe('front');
  });

  it('drags a node with one undo step for the whole drag', () => {
    let state = initialState3D(portal());
    const before = state.project;
    state = reducer3D(state, { type: 'dragStart', node: 'N2' });
    expect(state.selection).toEqual({ kind: 'node', ids: ['N2'] });
    for (const x of [0.5, 1, 1.5]) {
      state = reducer3D(state, { type: 'drag', project: moveNode(state.project, 'N2', x, 4, 0) });
    }
    expect(state.project.nodes.find((n) => n.id === 'N2')?.x).toBe(1.5);
    expect(state.past).toHaveLength(1);
    expect(reducer3D(state, { type: 'drag', project: state.project })).toBe(state);
    state = reducer3D(state, { type: 'undo' });
    expect(state.project).toBe(before);
  });

  it('every converted 2D example opens as a plane frame', () => {
    const example = getExample3D('plane-portal-frame');
    expect(example?.category).toBe('2D frames & trusses');
    const project = example?.build() as Project3D;
    expect(project.plane).toBe('XY');
    expect(initialState3D(project).camera.preset).toBe('front');
  });
});

describe('influence line geometry', () => {
  it('plots each ordinate above its load position and marks the target', () => {
    const p = portal();
    const line = {
      target: { kind: 'memberForce' as const, member: 'M2', x: 3, component: 'Mz' as const },
      ordinates: [
        { member: 'M2', x: 0, value: 0 },
        { member: 'M2', x: 3, value: 1.5 },
        { member: 'M2', x: 6, value: -0.5 },
      ],
      max: { member: 'M2', x: 3, value: 1.5 },
      min: { member: 'M2', x: 6, value: -0.5 },
    };
    const g = influenceGeometry(p, line, 3);
    // Two segments: (0,4)-(3,7) and (3,7)-(6,3).
    expect(Array.from(g.outline)).toEqual([0, 4, 0, 3, 7, 0, 3, 7, 0, 6, 3, 0]);
    expect(g.fill.length).toBe(2 * 6 * 3);
    expect(g.labels.map((l) => Number(l.text))).toEqual([1.5, -0.5]);
    expect(g.marker).toEqual([3, 4, 0]);
    const reaction = influenceGeometry(
      p,
      { ...line, target: { kind: 'reaction', node: 'N1', component: 'fy' } },
      3,
    );
    expect(reaction.marker).toEqual([0, 0, 0]);
  });
});
