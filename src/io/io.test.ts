import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples';
import { emptyProject } from '../model';
import {
  parseProject,
  parseProjectText,
  ProjectFormatError,
  serializeProject,
} from './projectFile';
import { decodeProject, encodeProject, payloadFromHash, shareUrl } from './share';

describe('project files', () => {
  it('round-trips every example', () => {
    for (const example of EXAMPLES) {
      const project = example.build();
      expect(parseProjectText(serializeProject(project))).toEqual(project);
    }
  });

  it('fills in defaults for a minimal file', () => {
    const p = parseProject({ nodes: [{ id: 'a', x: 0, y: 0 }] });
    expect(p).toMatchObject({ version: 1, name: 'Untitled', E: 200, members: [], loads: [] });
    expect(p.design).toEqual({
      grade: 'E250',
      laterallyRestrained: false,
      effectiveLengthFactor: 1,
    });
  });

  it('keeps optional load fields and gives loads unique ids', () => {
    const p = parseProject({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 4, y: 0 },
      ],
      members: [
        {
          id: 'm',
          i: 'a',
          j: 'b',
          type: 'frame',
          section: 'ISMB 200',
          releaseI: true,
          releaseJ: true,
        },
      ],
      supports: [
        { node: 'a', kind: 'fixed' },
        { node: 'a', kind: 'pinned' },
      ],
      loads: [
        { kind: 'distributed', member: 'm', direction: 'globalY', w1: -1, w2: -2, a: 1, b: 3 },
        { id: 'L1', kind: 'point', member: 'm', direction: 'localY', P: 3, a: 1 },
        { kind: 'moment', member: 'm', M: 3, a: 1 },
        { kind: 'nodal', node: 'b' },
      ],
      customSections: [{ name: 'Box', A: 10, I: 100 }],
      design: { grade: 'E350', laterallyRestrained: true, effectiveLengthFactor: -2 },
      description: 'hello',
    });
    expect(p.members[0]).toMatchObject({ releaseI: true, releaseJ: true });
    expect(p.supports).toEqual([{ node: 'a', kind: 'fixed' }]);
    expect(p.loads.map((l) => l.id)).toEqual(['L1', "L1'", 'L3', 'L4']);
    expect(p.loads[0]).toMatchObject({ w2: -2, a: 1, b: 3 });
    expect(p.loads[3]).toMatchObject({ fx: 0, fy: 0, mz: 0 });
    expect(p.design).toEqual({
      grade: 'E350',
      laterallyRestrained: true,
      effectiveLengthFactor: 1,
    });
    expect(p.description).toBe('hello');
  });

  it('rejects malformed input with a readable message', () => {
    const bad = (data: unknown, pattern: RegExp) => {
      expect(() => parseProject(data)).toThrow(ProjectFormatError);
      expect(() => parseProject(data)).toThrow(pattern);
    };
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 0 },
    ];
    const member = { id: 'm', i: 'a', j: 'b', type: 'frame', section: 'ISMB 200' };
    bad(null, /not a FrameForge project/);
    bad([], /not a FrameForge project/);
    bad({ version: 2 }, /newer version/);
    bad({ nodes: 'x' }, /must be a list/);
    bad({ nodes: Array.from({ length: 5001 }, () => 1) }, /too long/);
    bad({ nodes: [1] }, /Node 1 is malformed/);
    bad({ nodes: [{ id: 'a', x: 'q', y: 0 }] }, /must be a number/);
    bad({ nodes: [{ id: '', x: 0, y: 0 }] }, /short text/);
    bad({ nodes: [nodes[0], nodes[0]] }, /share the same id/);
    bad({ nodes, members: [1] }, /Member 1 is malformed/);
    bad({ nodes, members: [{ ...member, j: 'z' }] }, /does not exist/);
    bad({ nodes, members: [{ ...member, j: 'a' }] }, /same node/);
    bad({ nodes, members: [{ ...member, type: 'cable' }] }, /must be one of/);
    bad({ nodes, members: [member, member] }, /Two members/);
    bad({ nodes, supports: [1] }, /Support 1 is malformed/);
    bad({ nodes, supports: [{ node: 'a', kind: 'glued' }] }, /must be one of/);
    bad({ nodes, loads: [1] }, /Load 1 is malformed/);
    bad({ nodes, loads: [{ kind: 'wind' }] }, /unknown kind/);
    bad(
      {
        nodes,
        members: [member],
        loads: [{ kind: 'point', member: 'q', direction: 'localY', P: 1, a: 0 }],
      },
      /member "q"/,
    );
    bad({ nodes, customSections: [1] }, /Custom section 1 is malformed/);
    bad({ nodes, customSections: [{ name: 'x', A: 0, I: 1 }] }, /positive A and I/);
    bad({ nodes, E: -1 }, /E must be positive/);
    expect(() => parseProjectText('{nope')).toThrow(/not valid JSON/);
  });
});

describe('share links', () => {
  it('round-trips a project through a URL', async () => {
    const project = EXAMPLES.find((e) => e.id === 'transmission-tower')?.build() ?? emptyProject();
    const url = await shareUrl(project, 'https://example.org/frameforge/?x=1#old');
    expect(url.startsWith('https://example.org/frameforge/?x=1#m=1.')).toBe(true);
    // Compression keeps even the largest example comfortably inside URL length limits.
    expect(url.length).toBeLessThan(4000);
    const payload = payloadFromHash(new URL(url).hash);
    expect(payload).not.toBeNull();
    expect(await decodeProject(payload as string)).toEqual(project);
  });

  it('reads uncompressed payloads', async () => {
    const project = emptyProject('Plain');
    const json = JSON.stringify(project);
    const payload = `0.${btoa(json).replace(/=+$/, '')}`;
    expect(await decodeProject(payload)).toEqual(project);
  });

  it('rejects damaged links', async () => {
    await expect(decodeProject('garbage')).rejects.toThrow(/does not contain/);
    await expect(decodeProject('7.abc')).rejects.toThrow(/does not contain/);
    await expect(decodeProject('1.!!!!')).rejects.toThrow(/damaged/);
    await expect(decodeProject(`0.${btoa('[1,2]')}`)).rejects.toThrow(/not a FrameForge project/);
    expect(payloadFromHash('#other')).toBeNull();
    expect(payloadFromHash('m=0.abc')).toBe('0.abc');
    expect((await encodeProject(emptyProject())).startsWith('1.')).toBe(true);
  });
});
