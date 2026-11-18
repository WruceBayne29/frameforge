import { describe, expect, it } from 'vitest';
import { EXAMPLES_3D } from '../examples3d';
import type { Project3D } from '../model3d';
import type { ApiHost, ImportReport } from './api';
import {
  API_VERSION,
  createApi,
  fetchModelText,
  FrameForgeImportError,
  modelUrl,
  parseRequest,
  runRequest,
  withinSize,
} from './api';

function host(initial: Project3D = EXAMPLES_3D[0].build()) {
  const state = { project: initial, reports: [] as ImportReport[] };
  const h: ApiHost = {
    getProject: () => state.project,
    setProject: (project, report) => {
      state.project = project;
      state.reports.push(report);
    },
  };
  return { state, api: createApi(h) };
}

const MODEL = {
  name: 'Cantilever',
  nodes: [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 3, y: 0 },
  ],
  members: [{ id: 'AB', i: 'A', j: 'B', section: 'ISMB 250' }],
  supports: [{ node: 'A', restraints: 'fixed' }],
  loads: [{ kind: 'nodal', node: 'B', fy: -15 }],
};

const STD = `STAAD PLANE
UNIT METER KN
JOINT COORDINATES
1 0 0 0; 2 4 0 0
MEMBER INCIDENCES
1 1 2
MEMBER PROPERTY INDIAN
1 TABLE ST ISMB300
SUPPORTS
1 FIXED
LOAD 1
JOINT LOAD
2 FY -10
`;

describe('window.frameforge API', () => {
  it('loads a model, analyses it and gives it back', () => {
    const { state, api } = host();
    expect(api.version).toBe(API_VERSION);
    const report = api.load(MODEL);
    expect(report).toEqual({
      name: 'Cantilever',
      format: 'json',
      counts: { nodes: 2, members: 1, plates: 0, solids: 0, supports: 1, loads: 1 },
      plane: false,
      warnings: [],
    });
    expect(state.project.name).toBe('Cantilever');
    expect(api.analyze().reactions.A.fy).toBeCloseTo(15, 9);
    expect(api.analyze({ stations: true }).members.AB.stations?.length).toBeGreaterThan(2);
    const model = api.getModel();
    expect(model).toMatchObject({
      format: 'frameforge-project',
      kind: 'space',
      name: 'Cantilever',
    });
    // A copy: changing it does not change the app's model.
    model.nodes[0].x = 99;
    expect(state.project.nodes[0].x).toBe(0);
    expect(api.load(JSON.stringify(MODEL)).name).toBe('Cantilever');
  });

  it('imports tables, bundles, STAAD text and any detected format', () => {
    const { api } = host();
    const tables = api.importCsv(
      { nodes: 'id,x,y\n1,0,0\n2,4,0', members: 'id,i,j\n1,1,2', supports: 'node,type\n1,fixed' },
      { name: 'T' },
    );
    expect(tables).toMatchObject({ name: 'T', format: 'csv', plane: true });
    expect(tables.warnings).toContain('members: 1 member(s) had no section and use ISMB 300.');
    expect(api.importCsv('[nodes]\n1,0,0\n2,4,0\n[members]\n1,1,2').counts.members).toBe(1);
    expect(api.importStd(STD)).toMatchObject({ format: 'std', plane: true });
    expect(api.importText(STD, { name: 'Detected' }).name).toBe('Detected');
  });

  it('throws FrameForgeImportError with every problem', () => {
    const { state, api } = host();
    const before = state.project;
    const attempts: Array<() => unknown> = [
      () => api.load({ nodes: [{ id: 'a' }] }),
      () => api.importCsv({ nodes: 'id,x,y\n1,a,0' }),
      () => api.importCsv({ joints: 'x' } as never),
      () => api.importCsv(42 as never),
      () => api.importStd(42 as never),
      () => api.importText(null as never),
      () => api.importText('hello'),
    ];
    for (const attempt of attempts) {
      let error: unknown;
      try {
        attempt();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(FrameForgeImportError);
      expect((error as FrameForgeImportError).errors.length).toBeGreaterThan(0);
    }
    expect(state.project).toBe(before);
    const many = new FrameForgeImportError(['1', '2', '3', '4', '5', '6']);
    expect(many.message).toMatch(/ …$/);
  });
});

describe('postMessage requests', () => {
  it('accepts only well-formed requests', () => {
    expect(parseRequest({ frameforge: 'load', model: MODEL, id: 1 })).not.toBeNull();
    expect(
      parseRequest({ frameforge: 'importStd', text: STD, options: { loadCase: 1 } }),
    ).not.toBeNull();
    expect(parseRequest({ frameforge: 'importCsv', tables: { nodes: '1,0,0' } })).not.toBeNull();
    expect(parseRequest({ frameforge: 'importCsv', tables: '[nodes]' })).not.toBeNull();
    expect(parseRequest({ frameforge: 'analyze' })).not.toBeNull();
    for (const bad of [
      null,
      'load',
      [],
      { type: 'load' },
      { frameforge: 'eval', code: '1' },
      { frameforge: 'toString' },
      { frameforge: 'load' },
      { frameforge: 'load', model: MODEL, id: {} },
      { frameforge: 'load', model: MODEL, options: [] },
      { frameforge: 'importStd', text: 42 },
      { frameforge: 'importCsv', tables: { nodes: 1 } },
      { frameforge: 'importCsv', tables: { script: 'x' } },
    ]) {
      expect(parseRequest(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(withinSize({ a: 'x' })).toBe(true);
    expect(withinSize({ a: 'x'.repeat(20_000_001) })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(withinSize(cyclic)).toBe(false);
  });

  it('answers reads only after the embedding page loaded a model', () => {
    const { api } = host();
    const read = runRequest(api, { frameforge: 'getModel', id: 'r1' }, false);
    expect(read.reply).toMatchObject({ frameforge: 'result', id: 'r1', ok: false });
    expect(read.reply.error).toMatch(/Load a model first/);
    const load = runRequest(api, { frameforge: 'load', model: MODEL, id: 2 }, false);
    expect(load).toMatchObject({ loaded: true, reply: { ok: true, id: 2 } });
    const analyse = runRequest(api, { frameforge: 'analyze' }, true);
    expect(analyse.loaded).toBe(false);
    expect(
      (analyse.reply.result as { reactions: Record<string, { fy: number }> }).reactions.A.fy,
    ).toBeCloseTo(15, 9);
    expect(runRequest(api, { frameforge: 'getModel' }, true).reply.ok).toBe(true);
    for (const request of [
      { frameforge: 'importCsv' as const, tables: '[nodes]\n1,0,0\n2,1,0\n[members]\n1,1,2' },
      { frameforge: 'importStd' as const, text: STD },
      { frameforge: 'importText' as const, text: STD },
    ]) {
      expect(runRequest(api, request, false).reply.ok).toBe(true);
    }
  });

  it('replies with the errors of a failed request', () => {
    const { api } = host();
    const failed = runRequest(
      api,
      { frameforge: 'importStd', text: 'STAAD SPACE\nJOINT COORDINATES\n1 0 0 x' },
      false,
    );
    expect(failed.loaded).toBe(false);
    expect(failed.reply.ok).toBe(false);
    expect(failed.reply.errors).toEqual(['line 3: A joint line must contain only numbers.']);
    // A mechanism cannot be analysed: an error without a list.
    runRequest(api, { frameforge: 'load', model: { ...MODEL, supports: [] } }, false);
    const mechanism = runRequest(api, { frameforge: 'analyze' }, true);
    expect(mechanism.reply.ok).toBe(false);
    expect(mechanism.reply.errors).toBeUndefined();
  });
});

describe('?model= URLs', () => {
  const page = 'https://wrucebayne29.github.io/frameforge/';
  it('allows https anywhere and this site itself', () => {
    expect(modelUrl('https://raw.githubusercontent.com/a/b/main/frame.std', page)?.host).toBe(
      'raw.githubusercontent.com',
    );
    expect(modelUrl('samples/portal-frame.std', page)?.href).toBe(
      `${page}samples/portal-frame.std`,
    );
    expect(modelUrl('/x.json', 'http://localhost:5173/')?.href).toBe(
      'http://localhost:5173/x.json',
    );
    expect(modelUrl('http://example.com/x.std', page)).toBeNull();
    expect(modelUrl('javascript:alert(1)', page)).toBeNull();
    expect(modelUrl('data:text/plain,STAAD', page)).toBeNull();
    expect(modelUrl('http://[bad', page)).toBeNull();
  });

  it('fetches the text and explains failures', async () => {
    const url = new URL('https://example.org/m.std');
    const ok = (async () => new Response('STAAD SPACE')) as typeof fetch;
    await expect(fetchModelText(url, ok)).resolves.toBe('STAAD SPACE');
    const blocked = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(fetchModelText(url, blocked)).rejects.toThrow(/CORS/);
    const missing = (async () => new Response('', { status: 404 })) as typeof fetch;
    await expect(fetchModelText(url, missing)).rejects.toThrow('The model URL returned HTTP 404.');
    const slow = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as typeof fetch;
    await expect(fetchModelText(url, slow, 10)).rejects.toThrow(/took too long/);
    const huge = (async () => new Response('x'.repeat(20_000_001))) as typeof fetch;
    await expect(fetchModelText(url, huge)).rejects.toThrow(/too large/);
  });
});
