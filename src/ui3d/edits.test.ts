import { describe, expect, it } from 'vitest';
import { addMember, addNode, addPlate, emptyProject3D } from '../model3d';
import type { Project3D } from '../model3d';
import {
  addCustomSection,
  addDefaultLoad,
  addMaterial,
  common,
  defaultLoad,
  deleteCustomSection,
  deleteMaterial,
  loadsOn,
  materialInUse,
  setNodeCoordinate,
  updateCustomSection,
  updateMaterial,
  updateMembers,
  updatePlates,
} from './edits';

function model(): Project3D {
  let p = emptyProject3D();
  for (const [x, z] of [
    [0, 0],
    [4, 0],
    [4, 3],
    [0, 3],
  ]) {
    p = addNode(p, x, 0, z).project;
  }
  p = addMember(p, 'N1', 'N2').project;
  p = addMember(p, 'N2', 'N3').project;
  p = addPlate(p, ['N1', 'N2', 'N3', 'N4']).project;
  return p;
}

describe('multi edits', () => {
  it('updates several members, plates and node coordinates', () => {
    const p = model();
    const m = updateMembers(p, ['M1', 'M2'], { type: 'truss' });
    expect(m.members.every((x) => x.type === 'truss')).toBe(true);
    expect(updatePlates(p, ['P1'], { thickness: 200 }).plates[0].thickness).toBe(200);
    const raised = setNodeCoordinate(p, ['N1', 'N2'], 'y', 3);
    expect(raised.nodes.filter((n) => n.y === 3)).toHaveLength(2);
    expect(common(raised.nodes, (n) => n.y)).toBeUndefined();
    expect(common(raised.nodes.slice(0, 2), (n) => n.y)).toBe(3);
    expect(common([], (n: number) => n)).toBeUndefined();
  });

  it('adds default loads and finds loads on items', () => {
    let p = model();
    p = addDefaultLoad(p, 'point', ['M1']).project;
    expect(p.loads[0]).toMatchObject({ kind: 'point', a: 2, P: -10 });
    p = addDefaultLoad(p, 'pressure', ['P1']).project;
    expect(loadsOn(p, 'member', ['M1'])).toHaveLength(1);
    expect(loadsOn(p, 'plate', ['P1'])).toHaveLength(1);
    expect(loadsOn(p, 'member', ['M2'])).toHaveLength(0);
    for (const kind of ['nodal', 'distributed', 'moment', 'platePoint', 'face'] as const) {
      expect(defaultLoad(kind, ['X']).kind).toBe(kind);
    }
  });
});

describe('materials and sections', () => {
  it('renames materials everywhere and protects used ones', () => {
    let p = addMaterial(model());
    expect(p.materials.map((m) => m.name)).toContain('Material');
    p = updateMaterial(p, 'Steel', { name: 'S355', E: 210 });
    expect(p.members.every((m) => m.material === 'S355')).toBe(true);
    expect(p.materials.find((m) => m.name === 'S355')?.E).toBe(210);
    expect(updateMaterial(p, 'S355', { name: 'Material' })).toBe(p);
    expect(materialInUse(p, 'S355')).toBe(true);
    expect(deleteMaterial(p, 'S355')).toBe(p);
    expect(deleteMaterial(p, 'Material').materials.some((m) => m.name === 'Material')).toBe(false);
  });

  it('renames custom sections on members and protects used ones', () => {
    let p = addCustomSection(model());
    const name = p.customSections[0].name;
    p = updateMembers(p, ['M1'], { section: name });
    p = updateCustomSection(p, name, { name: 'Box', A: 80 });
    expect(p.members[0].section).toBe('Box');
    expect(p.customSections[0].A).toBe(80);
    expect(deleteCustomSection(p, 'Box')).toBe(p);
    p = updateMembers(p, ['M1'], { section: 'ISMB 300' });
    expect(deleteCustomSection(p, 'Box').customSections).toHaveLength(0);
  });
});
