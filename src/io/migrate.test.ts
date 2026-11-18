import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples';
import { getExample3D } from '../examples3d';
import { from2D } from '../model3d';
import { openProjectText, openShareHash, startUp } from './migrate';
import { ProjectFormatError, serializeProject } from './projectFile';
import { serializeProject3D } from './projectFile3d';
import { encodeJson } from './share';
import { encodeProject3D } from './share3d';

const old2D = () => EXAMPLES.find((e) => e.id === 'portal-frame')!.build();
const space = () => getExample3D('building-frame')!.build();

describe('opening files and links of the former 2D workspace', () => {
  it('converts a 2D .json file to a plane frame and opens 3D files as they are', () => {
    const opened = openProjectText(serializeProject(old2D()));
    expect(opened.converted).toBe(true);
    expect(opened.project.plane).toBe('XY');
    expect(opened.project).toEqual(from2D(old2D()));
    const again = openProjectText(serializeProject3D(space()));
    expect(again.converted).toBe(false);
    expect(again.project.name).toBe(space().name);
    expect(() => openProjectText('not json')).toThrow(ProjectFormatError);
  });

  it('opens #m= links converted, #s= links as they are', async () => {
    const m = await openShareHash(`#m=${await encodeJson(old2D())}`);
    expect(m?.converted).toBe(true);
    expect(m?.project).toEqual(from2D(old2D()));
    const s = await openShareHash(`#s=${await encodeProject3D(space())}`);
    expect(s?.converted).toBe(false);
    expect(s?.project.nodes.length).toBe(space().nodes.length);
    expect(await openShareHash('')).toBeNull();
    expect(await openShareHash('#x=1')).toBeNull();
    await expect(openShareHash('#m=9.zzz')).rejects.toThrow(ProjectFormatError);
  });
});

describe('start-up migration of the 2D autosave', () => {
  const text2d = serializeProject(old2D());
  const text3d = serializeProject3D(space());

  it('nothing saved: the default example', () => {
    expect(startUp({ project3d: null, project2d: null, workspace: null })).toEqual({
      initial: null,
      then: null,
      message: null,
    });
  });

  it('only a 3D autosave: opened as it is', () => {
    const r = startUp({ project3d: text3d, project2d: null, workspace: '3d' });
    expect(r.initial?.name).toBe(space().name);
    expect(r.then).toBeNull();
    expect(r.message).toBeNull();
  });

  it('only a 2D autosave: converted and opened, with a message', () => {
    const r = startUp({ project3d: null, project2d: text2d, workspace: '2d' });
    expect(r.initial).toEqual(from2D(old2D()));
    expect(r.then).toBeNull();
    expect(r.message).toMatch(/converted to a plane frame/);
  });

  it('both, last used 2D: the converted model opens and Undo returns to the 3D one', () => {
    const r = startUp({ project3d: text3d, project2d: text2d, workspace: '2d' });
    expect(r.initial?.name).toBe(space().name);
    expect(r.then).toEqual(from2D(old2D()));
    expect(r.message).toMatch(/Undo returns to your 3D model/);
  });

  it('both, last used 3D: the 3D model opens and the converted one is one Undo away', () => {
    const r = startUp({ project3d: text3d, project2d: text2d, workspace: '3d' });
    expect(r.initial).toEqual(from2D(old2D()));
    expect(r.then?.name).toBe(space().name);
    expect(r.message).toMatch(/press Undo to open it/);
  });

  it('ignores damaged or empty autosaves', () => {
    const empty = serializeProject({ ...old2D(), nodes: [], members: [], supports: [], loads: [] });
    expect(startUp({ project3d: '{', project2d: empty, workspace: '2d' })).toEqual({
      initial: null,
      then: null,
      message: null,
    });
  });
});
