import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples';
import { EXAMPLES_3D } from '../examples3d';
import { emptyProject3D, from2D } from '../model3d';
import { parseProject, serializeProject } from './projectFile';
import {
  detectProjectKind,
  parseProject3D,
  parseProject3DText,
  ProjectFormatError,
  serializeProject3D,
} from './projectFile3d';
import { decodeProject, encodeJson, payloadFromHash } from './share';
import { decodeProject3D, encodeProject3D, payloadFromHash3D, shareUrl3D } from './share3d';

const square = [
  { id: 'a', x: 0, y: 0, z: 0 },
  { id: 'b', x: 1, y: 0, z: 0 },
  { id: 'c', x: 1, y: 0, z: 1 },
  { id: 'd', x: 0, y: 0, z: 1 },
];
const cubeNodes = [
  ...square,
  { id: 'e', x: 0, y: 1, z: 0 },
  { id: 'f', x: 1, y: 1, z: 0 },
  { id: 'g', x: 1, y: 1, z: 1 },
  { id: 'h', x: 0, y: 1, z: 1 },
];

describe('3D project files', () => {
  it('round-trips every 3D example and converted 2D example', () => {
    for (const example of EXAMPLES_3D) {
      const project = example.build();
      const text = serializeProject3D(project);
      expect(JSON.parse(text)).toMatchObject({ format: 'frameforge-project', kind: 'space' });
      expect(parseProject3DText(text)).toEqual(project);
    }
    for (const example of EXAMPLES) {
      const project = from2D(example.build());
      expect(parseProject3DText(serializeProject3D(project))).toEqual(project);
    }
    const empty = emptyProject3D('Empty');
    expect(parseProject3DText(serializeProject3D(empty))).toEqual(empty);
  });

  it('fills in defaults for a minimal file', () => {
    const p = parseProject3D({ nodes: [{ id: 'a', x: 0, y: 0 }] });
    expect(p).toMatchObject({
      version: 1,
      kind: 'space',
      name: 'Untitled',
      members: [],
      plates: [],
      solids: [],
      loads: [],
      selfWeight: false,
    });
    expect(p.nodes[0].z).toBe(0);
    expect(p.materials.map((m) => m.name)).toEqual(['Steel', 'Concrete M25']);
    expect(p.design).toEqual({ grade: 'E250', laterallyRestrained: false, kz: 1, ky: 1 });
  });

  it('reads plane mode and lumped masses', () => {
    const p = parseProject3D({
      kind: 'space',
      plane: 'XY',
      nodes: [{ id: 'a', x: 0, y: 0, z: 0 }],
      masses: [
        { node: 'a', mass: 1.5 },
        { node: 'a', mass: 0 },
      ],
    });
    expect(p.plane).toBe('XY');
    expect(p.masses).toEqual([{ node: 'a', mass: 1.5 }]);
    expect(parseProject3D(JSON.parse(serializeProject3D(p)))).toEqual(p);
    expect(() => parseProject3D({ kind: 'space', plane: 'XZ' })).toThrow(/Plane/);
    expect(() =>
      parseProject3D({
        kind: 'space',
        nodes: [{ id: 'a', x: 0, y: 0, z: 0 }],
        masses: [{ node: 'a', mass: -1 }],
      }),
    ).toThrow(/negative/);
    expect(() => parseProject3D({ kind: 'space', masses: [3] })).toThrow(/malformed/);
  });

  it('reads per-axis effective length factors, falling back to the single older factor', () => {
    const base = {
      kind: 'space',
      nodes: [
        { id: 'a', x: 0, y: 0, z: 0 },
        { id: 'b', x: 1, y: 0, z: 0 },
      ],
      members: [{ id: 'm', i: 'a', j: 'b', type: 'beam', section: 'ISMB 300', kz: 0.7 }],
    };
    expect(parseProject3D({ ...base, design: { effectiveLengthFactor: 2 } }).design).toMatchObject({
      kz: 2,
      ky: 2,
    });
    expect(parseProject3D({ ...base, design: { kz: 0.8, ky: 0.5 } }).design).toMatchObject({
      kz: 0.8,
      ky: 0.5,
    });
    const p = parseProject3D(base);
    expect(p.members[0].kz).toBe(0.7);
    expect(p.members[0].ky).toBeUndefined();
    expect(() => parseProject3D({ ...base, members: [{ ...base.members[0], ky: 0 }] })).toThrow(
      /positive effective length factor ky/,
    );
  });

  it('keeps optional fields, cleans releases and gives loads unique ids', () => {
    const p = parseProject3D({
      kind: 'space',
      name: '  Demo  ',
      description: 'hello',
      selfWeight: true,
      nodes: cubeNodes,
      materials: [
        { name: 'Timber', E: 11, nu: 0.35, density: 6 },
        { name: 'Bare', E: 5 },
      ],
      members: [
        {
          id: 'm',
          i: 'a',
          j: 'b',
          type: 'beam',
          section: 'ISMB 200',
          material: 'Timber',
          beta: 45,
          releaseI: { mz: true, my: false, junk: true },
          releaseJ: { fx: false },
        },
        { id: 'n', i: 'b', j: 'c', type: 'truss', section: 'Rod', beta: 0 },
      ],
      plates: [{ id: 'p', nodes: ['a', 'b', 'c', 'd'], thickness: 120 }],
      solids: [{ id: 's', nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], material: 'Bare' }],
      supports: [
        { node: 'a', restraints: [true, true, true, false, false, false] },
        { node: 'a', restraints: [true, true, true, true, true, true] },
      ],
      loads: [
        { kind: 'nodal', nodes: ['b', 'b', 'c'], fy: -1 },
        {
          id: 'L1',
          kind: 'distributed',
          members: ['m'],
          direction: 'localZ',
          w1: 1,
          w2: 2,
          a: 0.1,
          b: 0.9,
        },
        { id: 'L1', kind: 'point', members: ['m', 'n'], direction: 'globalY', P: -3, a: 0.5 },
        { kind: 'moment', members: ['m'], direction: 'localX', M: 2, a: 0.5 },
        { kind: 'pressure', plates: ['p'], direction: 'localZ', p: -4 },
        { kind: 'platePoint', plates: ['p'], direction: 'globalY', P: -4 },
        { kind: 'face', solids: ['s'], face: 2, direction: 'normal', p: 9 },
      ],
      customSections: [{ name: 'Rod', A: 3, Iz: 1, Iy: 1, J: 2 }],
      design: { grade: 'E350', laterallyRestrained: true, effectiveLengthFactor: -2 },
    });
    expect(p.name).toBe('Demo');
    expect(p.description).toBe('hello');
    expect(p.selfWeight).toBe(true);
    expect(p.materials[1]).toEqual({ name: 'Bare', E: 5, nu: 0.3, density: 0 });
    expect(p.members[0]).toEqual({
      id: 'm',
      i: 'a',
      j: 'b',
      type: 'beam',
      section: 'ISMB 200',
      material: 'Timber',
      beta: 45,
      releaseI: { mz: true },
    });
    // missing material → the first one; zero roll angle is dropped
    expect(p.members[1]).toEqual({
      id: 'n',
      i: 'b',
      j: 'c',
      type: 'truss',
      section: 'Rod',
      material: 'Timber',
    });
    expect(p.plates[0]).toEqual({
      id: 'p',
      nodes: ['a', 'b', 'c', 'd'],
      thickness: 120,
      material: 'Timber',
    });
    expect(p.solids[0].material).toBe('Bare');
    expect(p.supports).toEqual([
      { node: 'a', restraints: [true, true, true, false, false, false] },
    ]);
    expect(p.loads.map((l) => l.id)).toEqual(['L1', "L1'", "L1''", 'L4', 'L5', 'L6', 'L7']);
    expect(p.loads[0]).toEqual({
      id: 'L1',
      kind: 'nodal',
      nodes: ['b', 'c'],
      fx: 0,
      fy: -1,
      fz: 0,
      mx: 0,
      my: 0,
      mz: 0,
    });
    expect(p.loads[1]).toMatchObject({ w2: 2, a: 0.1, b: 0.9, direction: 'localZ' });
    expect(p.loads[5]).toMatchObject({ kind: 'platePoint', xi: 0, eta: 0 });
    expect(p.loads[6]).toMatchObject({ kind: 'face', face: 2, direction: 'normal', p: 9 });
    expect(p.design).toEqual({ grade: 'E350', laterallyRestrained: true, kz: 1, ky: 1 });
    // parsing is idempotent
    expect(parseProject3D(JSON.parse(serializeProject3D(p)))).toEqual(p);
  });

  it('rejects malformed input with a readable message', () => {
    const member = { id: 'm', i: 'a', j: 'b', type: 'beam', section: 'ISMB 200' };
    const plate = { id: 'p', nodes: ['a', 'b', 'c', 'd'], thickness: 100 };
    const solid = { id: 's', nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] };
    const base = { nodes: cubeNodes, members: [member], plates: [plate], solids: [solid] };
    const bad: Array<[unknown, RegExp]> = [
      [null, /not a FrameForge project/],
      [[], /not a FrameForge project/],
      [{ format: 'something-else' }, /not a FrameForge project/],
      [{ version: 2 }, /newer version/],
      [{ kind: 'plane' }, /not a 3D/],
      [{ nodes: 'x' }, /nodes must be a list/],
      [{ nodes: [5] }, /Node 1 is malformed/],
      [{ nodes: [{ id: '', x: 0, y: 0, z: 0 }] }, /Node 1 id/],
      [{ nodes: [{ id: 'a', x: 'x', y: 0, z: 0 }] }, /Node 1 x must be a number/],
      [{ nodes: [{ id: 'a', x: 0, y: 0, z: Infinity }] }, /Node 1 z/],
      [{ nodes: [square[0], square[0]] }, /Two nodes share/],
      [{ nodes: square, materials: [3] }, /Material 1 is malformed/],
      [{ nodes: square, materials: [{ name: 'X', E: 0 }] }, /positive E/],
      [{ nodes: square, materials: [{ name: 'X', E: 1, nu: 0.5 }] }, /Poisson/],
      [{ nodes: square, materials: [{ name: 'X', E: 1, density: -1 }] }, /negative density/],
      [
        {
          nodes: square,
          materials: [
            { name: 'X', E: 1 },
            { name: 'X', E: 2 },
          ],
        },
        /Two materials/,
      ],
      [{ nodes: square, members: [7] }, /Member 1 is malformed/],
      [{ nodes: square, members: [{ ...member, j: 'zz' }] }, /node "zz", which does not exist/],
      [{ nodes: square, members: [{ ...member, j: 'a' }] }, /same node/],
      [{ nodes: square, members: [{ ...member, type: 'frame' }] }, /type must be one of/],
      [{ nodes: square, members: [{ ...member, beta: 'x' }] }, /roll angle/],
      [{ nodes: square, members: [{ ...member, releaseI: 4 }] }, /start release is malformed/],
      [{ nodes: square, members: [member, member] }, /Two members share/],
      [{ nodes: square, plates: [null] }, /Plate 1 is malformed/],
      [{ nodes: square, plates: [{ ...plate, nodes: ['a', 'b', 'c'] }] }, /exactly 4 nodes/],
      [{ nodes: square, plates: [{ ...plate, nodes: ['a', 'b', 'c', 'c'] }] }, /more than once/],
      [{ nodes: square, plates: [{ ...plate, nodes: ['a', 'b', 'c', 'q'] }] }, /node "q"/],
      [{ nodes: square, plates: [{ ...plate, thickness: 0 }] }, /positive thickness/],
      [{ nodes: square, plates: [plate, plate] }, /Two plates share/],
      [{ nodes: cubeNodes, solids: ['x'] }, /Solid 1 is malformed/],
      [{ nodes: cubeNodes, solids: [{ ...solid, nodes: ['a'] }] }, /exactly 8 nodes/],
      [{ nodes: cubeNodes, solids: [solid, solid] }, /Two solids share/],
      [{ nodes: square, supports: [1] }, /Support 1 is malformed/],
      [{ nodes: square, supports: [{ node: 'zz', restraints: [] }] }, /node "zz"/],
      [{ nodes: square, supports: [{ node: 'a', restraints: [true, true] }] }, /six true\/false/],
      [
        { nodes: square, supports: [{ node: 'a', restraints: [1, 1, 1, 1, 1, 1] }] },
        /six true\/false/,
      ],
      [{ ...base, loads: ['x'] }, /Load 1 is malformed/],
      [{ ...base, loads: [{ kind: 'wind' }] }, /unknown kind/],
      [{ ...base, loads: [{ kind: 'nodal', nodes: [] }] }, /needs a list of nodes/],
      [{ ...base, loads: [{ kind: 'nodal', nodes: ['zz'] }] }, /node "zz"/],
      [{ ...base, loads: [{ kind: 'nodal', nodes: ['a'], fx: 'big' }] }, /fx must be a number/],
      [
        { ...base, loads: [{ kind: 'distributed', members: ['zz'], direction: 'globalY', w1: 1 }] },
        /member "zz"/,
      ],
      [
        { ...base, loads: [{ kind: 'distributed', members: ['m'], direction: 'down', w1: 1 }] },
        /direction must be one of/,
      ],
      [
        { ...base, loads: [{ kind: 'distributed', members: ['m'], direction: 'globalY' }] },
        /w1 must be a number/,
      ],
      [
        { ...base, loads: [{ kind: 'point', members: ['m'], direction: 'globalY', P: 1 }] },
        /position/,
      ],
      [
        { ...base, loads: [{ kind: 'moment', members: ['m'], direction: 'globalY', a: 1 }] },
        /M must be a number/,
      ],
      [
        { ...base, loads: [{ kind: 'pressure', plates: ['p'], direction: 'localY', p: 1 }] },
        /direction/,
      ],
      [
        { ...base, loads: [{ kind: 'pressure', plates: ['m'], direction: 'localZ', p: 1 }] },
        /plate "m"/,
      ],
      [
        {
          ...base,
          loads: [{ kind: 'platePoint', plates: ['p'], direction: 'localZ', P: 1, xi: 2 }],
        },
        /between -1 and 1/,
      ],
      [
        { ...base, loads: [{ kind: 'face', solids: ['s'], face: 7, direction: 'normal', p: 1 }] },
        /face must be one of/,
      ],
      [
        { ...base, loads: [{ kind: 'face', solids: ['s'], face: 1, direction: 'localZ', p: 1 }] },
        /direction/,
      ],
      [
        { ...base, loads: [{ kind: 'face', solids: ['p'], face: 1, direction: 'normal', p: 1 }] },
        /solid "p"/,
      ],
      [{ nodes: square, customSections: [0] }, /Custom section 1 is malformed/],
      [{ nodes: square, customSections: [{ name: 'B', A: 1, Iz: 1, Iy: 1 }] }, /torsion constant/],
      [
        { nodes: square, customSections: [{ name: 'B', A: 1, Iz: 1, Iy: 0, J: 1 }] },
        /positive A, Iz, Iy and J/,
      ],
    ];
    for (const [data, message] of bad) {
      expect(() => parseProject3D(data), JSON.stringify(data)).toThrow(ProjectFormatError);
      expect(() => parseProject3D(data), JSON.stringify(data)).toThrow(message);
    }
    expect(() => parseProject3DText('{nope')).toThrow(/not valid JSON/);
    expect(() => parseProject3D({ nodes: new Array(100001).fill(square[0]) })).toThrow(/too long/);
  });
});

describe('detectProjectKind', () => {
  it('tells 3D files from 2D files, from text or parsed data', () => {
    for (const example of EXAMPLES_3D.slice(0, 3)) {
      const text = serializeProject3D(example.build());
      expect(detectProjectKind(text)).toBe('3d');
      expect(detectProjectKind(JSON.parse(text))).toBe('3d');
    }
    for (const example of EXAMPLES.slice(0, 3)) {
      const text = serializeProject(example.build());
      expect(detectProjectKind(text)).toBe('2d');
      expect(detectProjectKind(JSON.parse(text))).toBe('2d');
    }
    expect(detectProjectKind({})).toBe('2d');
    expect(detectProjectKind(null)).toBe('2d');
    expect(detectProjectKind({ kind: 'something' })).toBe('2d');
    // unmarked data with obvious 3D content
    expect(detectProjectKind({ nodes: [], plates: [{}] })).toBe('3d');
    expect(detectProjectKind({ nodes: [], solids: [{}] })).toBe('3d');
    expect(detectProjectKind({ nodes: [], materials: [] })).toBe('3d');
    expect(detectProjectKind({ nodes: [], plates: [] })).toBe('2d');
    expect(() => detectProjectKind('{nope')).toThrow(ProjectFormatError);
  });

  it('leaves the 2D parser alone: 2D files still parse to the same project', () => {
    for (const example of EXAMPLES) {
      const project = example.build();
      expect(parseProject(JSON.parse(serializeProject(project)))).toEqual(project);
    }
  });
});

describe('3D share links', () => {
  it('round-trips every example through the URL payload', async () => {
    for (const example of EXAMPLES_3D) {
      const project = example.build();
      const payload = await encodeProject3D(project);
      expect(payload).toMatch(/^[01]\.[A-Za-z0-9_-]+$/);
      expect(await decodeProject3D(payload)).toEqual(project);
    }
  });

  it('compresses meshed models well below their JSON size', async () => {
    const project = EXAMPLES_3D.find((e) => e.id === 'solid-cantilever')?.build();
    if (!project) throw new Error('example missing');
    const payload = await encodeProject3D(project);
    expect(payload.startsWith('1.')).toBe(true);
    expect(payload.length).toBeLessThan(JSON.stringify(project).length / 3);
  });

  it('uses the #s= fragment, distinct from the 2D #m= fragment', async () => {
    const project = EXAMPLES_3D[0].build();
    const url = await shareUrl3D(project, 'https://example.org/frameforge/?x=1#old');
    const hash = new URL(url).hash;
    expect(hash.startsWith('#s=')).toBe(true);
    expect(new URL(url).search).toBe('?x=1');
    const payload = payloadFromHash3D(hash);
    expect(payload).not.toBeNull();
    expect(await decodeProject3D(payload as string)).toEqual(project);
    expect(payloadFromHash3D('s=abc')).toBe('abc');
    expect(payloadFromHash3D('#m=abc')).toBeNull();
    expect(payloadFromHash3D('')).toBeNull();
    expect(payloadFromHash(hash)).toBeNull();
  });

  it('rejects damaged links and payloads of the wrong kind', async () => {
    await expect(decodeProject3D('garbage')).rejects.toThrow(ProjectFormatError);
    await expect(decodeProject3D('9.abc')).rejects.toThrow(/does not contain/);
    await expect(decodeProject3D('1.!!!!')).rejects.toThrow(/damaged/);
    await expect(decodeProject3D('0.e25vcGU')).rejects.toThrow(/damaged/);
    // a 3D model whose content is invalid
    const bad = `0.${btoa(JSON.stringify({ kind: 'space', nodes: 'x' })).replace(/=+$/, '')}`;
    await expect(decodeProject3D(bad)).rejects.toThrow(/nodes must be a list/);
  });

  it('2D share links still round-trip after exporting the shared helpers', async () => {
    const project = EXAMPLES[0].build();
    expect(await decodeProject(await encodeJson(project))).toEqual(project);
    await expect(decodeProject('garbage')).rejects.toThrow(ProjectFormatError);
  });
});
