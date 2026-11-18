import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples';
import { EXAMPLES_3D } from '../examples3d';
import { serializeProject } from '../io/projectFile';
import { serializeProject3D } from '../io/projectFile3d';
import { analyzeProject3D } from '../model3d/analysis';
import { SolverError } from '../solver3d';
import { issueText } from './common';
import { detectFormat, importJson, importModelText, MAX_MODEL_TEXT } from './model';
import { analyzeToJson, resultsJson } from './results';

import schemaText from '../../docs/model.schema.json?raw';
import cantilever from '../../public/samples/cantilever.json?raw';
import portalFrame from '../../public/samples/portal-frame.std?raw';
import spaceFrameZUp from '../../public/samples/space-frame-zup.std?raw';
import warrenTruss from '../../public/samples/warren-truss.csv?raw';

const FILES: Record<string, string> = {
  'public/samples/cantilever.json': cantilever,
  'public/samples/portal-frame.std': portalFrame,
  'public/samples/space-frame-zup.std': spaceFrameZUp,
  'public/samples/warren-truss.csv': warrenTruss,
};
const read = (path: string) => FILES[path];
const schema = JSON.parse(schemaText) as object;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

describe('docs/model.schema.json', () => {
  it('accepts every built-in example as saved', () => {
    for (const example of EXAMPLES_3D) {
      const data = JSON.parse(serializeProject3D(example.build())) as unknown;
      expect(validate(data), `${example.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('accepts the interchange shortcuts the importer accepts', () => {
    const data = JSON.parse(read('public/samples/cantilever.json')) as unknown;
    expect(validate(data), JSON.stringify(validate.errors)).toBe(true);
    expect(importJson(data).project).not.toBeNull();
    const shortcuts = {
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 1, y: 0 },
      ],
      members: [{ id: 'm', i: 'a', j: 'b', section: 'ISMB 200' }],
      supports: [
        { node: 'a', restraints: '111111' },
        { node: 'b', restraints: { uy: true } },
      ],
      loads: [{ kind: 'distributed', member: 'm', direction: 'globalY', w1: -1 }],
    };
    expect(validate(shortcuts), JSON.stringify(validate.errors)).toBe(true);
    const p = importJson(shortcuts).project!;
    expect(p.supports[1].restraints).toEqual([false, true, false, false, false, false]);
    expect(p.loads[0]).toMatchObject({ members: ['m'] });
  });

  it('rejects what the importer rejects', () => {
    const bad: unknown[] = [
      { nodes: [{ id: 'a', x: 0 }] },
      { members: [{ id: 'm', i: 'a', j: 'b' }] },
      { members: [{ id: 'm', i: 'a', j: 'b', section: 'X', type: 'cable' }] },
      { supports: [{ node: 'a', restraints: 'clamped' }] },
      { supports: [{ node: 'a', restraints: [true, false] }] },
      { loads: [{ kind: 'wind' }] },
      { loads: [{ kind: 'point', members: ['m'], direction: 'globalY', P: 1 }] },
      { materials: [{ name: 'x', E: 0 }] },
      { customSections: [{ name: 'x', A: 1, Iz: 1, Iy: 1 }] },
      { plane: 'XZ' },
    ];
    for (const data of bad) {
      expect(validate(data), JSON.stringify(data)).toBe(false);
      expect(
        importJson({ nodes: [{ id: 'a', x: 0, y: 0 }], ...(data as object) }).project,
      ).toBeNull();
    }
  });
});

describe('detectFormat', () => {
  it('uses the extension, then the content', () => {
    expect(detectFormat('anything', 'model.JSON')).toBe('json');
    expect(detectFormat('anything', 'https://x.org/a/frame.std?raw=1')).toBe('std');
    expect(detectFormat('  {"nodes": []}')).toBe('json');
    expect(detectFormat(read('public/samples/portal-frame.std'), 'frame.txt')).toBe('std');
    expect(detectFormat(read('public/samples/warren-truss.csv'), 'truss.csv')).toBe('csv');
    expect(detectFormat('id,x,y\n1,0,0', 'nodes.csv')).toBeNull();
  });
});

describe('importModelText', () => {
  it('imports every sample file into a model that analyses', () => {
    for (const name of [
      'portal-frame.std',
      'space-frame-zup.std',
      'warren-truss.csv',
      'cantilever.json',
    ]) {
      const result = importModelText(read(`public/samples/${name}`), { filename: name });
      expect(result.errors.map(issueText), name).toEqual([]);
      const r = analyzeProject3D(result.project!);
      const [fx, fy, fz] = r.equilibrium;
      expect(Math.hypot(fx, fy, fz), name).toBeLessThan(1e-6);
    }
  });

  it('passes options on and forces a format when asked', () => {
    const std = importModelText(read('public/samples/portal-frame.std'), {
      loadCase: 2,
      name: 'Wind',
    });
    expect(std.project?.name).toBe('Wind');
    expect(std.project?.loads).toHaveLength(1);
    const csv = importModelText('[nodes]\n1,0,0\n2,4,0\n[members]\n1,1,2\n[supports]\n1,fixed', {
      plane: 'none',
    });
    expect(csv.format).toBe('csv');
    expect(csv.project?.plane).toBeUndefined();
    expect(importModelText('{"nodes": []}', { format: 'std' }).format).toBe('std');
  });

  it('reports unknown formats, oversized text and broken JSON', () => {
    expect(importModelText('hello').errors[0].message).toMatch(/Unrecognised model format/);
    expect(
      importModelText(' '.repeat(MAX_MODEL_TEXT + 1), { format: 'csv' }).errors[0].message,
    ).toMatch(/too large/);
    expect(importModelText('{nope').errors[0].message).toBe('This file is not valid JSON.');
    expect(importJson(42).errors[0].message).toBe('This is not a FrameForge project file.');
  });

  it('converts files of the former 2D app to plane frames', () => {
    const text = serializeProject(EXAMPLES[0].build());
    for (const result of [importModelText(text), importJson(JSON.parse(text))]) {
      expect(result.project?.plane).toBe('XY');
      expect(result.warnings[0].message).toMatch(/converted to a plane frame/);
    }
  });
});

describe('results JSON', () => {
  it('reports displacements, reactions and member forces of a cantilever', () => {
    const project = importJson(JSON.parse(read('public/samples/cantilever.json'))).project!;
    const json = analyzeToJson(project);
    expect(json.format).toBe('frameforge-results');
    expect(json.model).toEqual({
      name: project.name,
      plane: true,
      nodes: 2,
      members: 1,
      plates: 0,
      solids: 0,
    });
    expect(json.reactions.A.fy).toBeCloseTo(15, 9);
    expect(json.reactions.A.mz).toBeCloseTo(45, 9);
    const m = json.members.AB;
    expect(m.length).toBe(3);
    // Hogging moment at the fixed end: E·I·v″ = Mz < 0 for a downward tip load.
    expect(m.start.Mz).toBeCloseTo(-45, 9);
    expect(m.end.Mz).toBeCloseTo(0, 9);
    expect(m.start.Vy).toBeCloseTo(15, 9);
    // The extremes keep their sign: the value where the magnitude is largest.
    expect(m.max.Mz).toBeCloseTo(-45, 9);
    expect(m.endForces).toHaveLength(12);
    expect(m.stations).toBeUndefined();
    expect(json.displacements.B.uy).toBeLessThan(0);
    expect(json.appliedLoad[1]).toBeCloseTo(-15, 12);
    // Plain JSON: survives a round trip unchanged.
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('can include stations and reports plates and solids', () => {
    const plates = EXAMPLES_3D.find((e) => e.build().plates.length > 0)!.build();
    const result = analyzeProject3D(plates);
    const json = resultsJson(plates, result, { stations: true });
    expect(Object.keys(json.plates)).toHaveLength(plates.plates.length);
    const solids = EXAMPLES_3D.find((e) => e.build().solids.length > 0)!.build();
    const sj = analyzeToJson(solids);
    expect(Object.values(sj.solids)[0].maxVonMises).toBeGreaterThan(0);
    const frame = EXAMPLES_3D.find((e) => e.build().members.length > 0)!.build();
    const fj = analyzeToJson(frame, { stations: true });
    const first = Object.values(fj.members)[0];
    expect(first.stations?.length).toBeGreaterThan(2);
    expect(first.stations?.[0].x).toBe(0);
  });

  it('throws the solver error for a model that cannot be analysed', () => {
    const p = importJson({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 1, y: 0 },
      ],
      members: [{ id: 'm', i: 'a', j: 'b', section: 'ISMB 200' }],
    }).project!;
    expect(() => analyzeToJson(p)).toThrow(SolverError);
  });
});
