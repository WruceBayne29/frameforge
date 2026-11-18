import { describe, expect, it } from 'vitest';
import { getExample3D } from '../examples3d';
import { analyzeProject3D, designMembers3D, modalProject3D } from '../model3d';
import type { Project3D } from '../model3d';
import { buildReport3D, pdfText, projector, reportFileName, VIEWS } from './report';

/** A 1 × 1 transparent PNG. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function report(id: string, extra: { modal?: boolean; images?: boolean } = {}) {
  const project = getExample3D(id)!.build();
  const result = analyzeProject3D(project);
  const doc = buildReport3D({
    project,
    result,
    design: designMembers3D(project, result),
    modal: extra.modal ? modalProject3D(project, 4) : null,
    images: extra.images ? [{ title: 'Contours', dataUrl: PNG, aspect: 1.5 }] : [],
    date: new Date('2026-01-02T00:00:00Z'),
    shareUrl: 'https://example.org/#s=1.abc',
    compress: false,
  });
  const text = doc.output();
  return { doc, text, project };
}

describe('3D PDF report', () => {
  for (const id of [
    'building-frame',
    'tower-25-bar',
    'simply-supported-slab',
    'pad-footing',
    'slab-on-beams',
    'hinged-secondary-beam',
  ]) {
    it(`builds a multi-page PDF for ${id}`, () => {
      const { doc, text } = report(id, { modal: true, images: true });
      expect(text.startsWith('%PDF-')).toBe(true);
      expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(3);
      expect(text).toContain('Isometric');
      expect(text).toContain('Front and top views');
      expect(text).toContain('Natural frequencies');
      expect(text).toContain('Contours');
      expect(text).toContain('/Subtype /Image');
    });
  }

  it('in plane mode draws the figures of the 2D report: front views, N / V / M', () => {
    const { text } = report('plane-portal-frame');
    for (const title of [
      'Structural calculation report - plane frame',
      'Model, loads and support reactions',
      // Parentheses are escaped in the PDF text, so the titles are matched up to them.
      'Bending moment diagram ',
      'Shear force diagram ',
      'Axial force diagram ',
      'tension blue, compression red',
      'Deflected shape ',
      'Utilisation ratio per member',
      'Support node',
    ]) {
      expect(text, title).toContain(title);
    }
    expect(text).not.toContain('Isometric');
    expect(text).not.toContain('Bending moment My');
    expect(text).not.toContain('Natural frequencies');
  });

  it('lists every load kind, custom sections, masses and member releases', () => {
    const project = getExample3D('hinged-secondary-beam')!.build();
    const p: Project3D = {
      ...project,
      customSections: [{ name: 'Box', A: 40, Iz: 3000, Iy: 3000, J: 4000 }],
      masses: [{ node: project.nodes[0].id, mass: 2 }],
      design: { ...project.design, kz: 0.8, ky: 1.2 },
    };
    p.members = p.members.map((m, k) => (k === 0 ? { ...m, section: 'Box' } : m));
    const m0 = p.members[1].id;
    p.loads = [
      ...p.loads,
      { id: 'Lm', kind: 'moment', members: [m0], direction: 'localZ', M: 3, a: 1 },
      {
        id: 'Lt',
        kind: 'distributed',
        members: [m0],
        direction: 'localY',
        w1: 1,
        w2: 3,
        a: 0.5,
        b: 2,
      },
      { id: 'Ln', kind: 'nodal', nodes: [p.nodes[1].id], fx: 1, fy: 0, fz: 2, mx: 1, my: 0, mz: 0 },
    ];
    const result = analyzeProject3D(p);
    const doc = buildReport3D({
      project: p,
      result,
      design: designMembers3D(p, result),
      compress: false,
    });
    const text = doc.output();
    expect(text).toContain('Trapezoidal');
    expect(text).toContain('Custom section');
    expect(text).toContain('Lumped mass');
    expect(text).toContain('Kz = 0.800');
  });

  it('reports a model without rolled sections and cuts very long tables', () => {
    const project = getExample3D('pad-footing')!.build();
    // 450 extra (unconnected) nodes make the node tables longer than 400 rows.
    for (let k = 0; k < 450; k++) project.nodes.push({ id: `X${k}`, x: k, y: 10, z: 0 });
    const result = analyzeProject3D(project);
    const text = buildReport3D({ project, result, design: {}, compress: false }).output();
    expect(text).toContain('no design checks were run');
    expect(text).toMatch(/Only the first 400 of \d+ /);
  });

  it('projects views and sanitises text', () => {
    const project = getExample3D('plane-simple-beam')!.build();
    const front = projector(project, VIEWS.front, { x: 0, y: 0, w: 100, h: 50 });
    expect(front.direction([0, 0, 1])).toBeNull();
    expect(front.direction([0, 1, 0])).toEqual([0, -1]);
    const iso = projector(project, VIEWS.iso, { x: 0, y: 0, w: 100, h: 50 });
    expect(iso.direction([0, 0, 1])).not.toBeNull();
    expect(pdfText('σ ≤ ω → ξη ☃')).toBe('sigma <= omega -> xieta ?');
    expect(reportFileName({ name: 'Slab on beams' })).toBe('slab-on-beams-report.pdf');
    expect(reportFileName({ name: '!!' })).toBe('frameforge-report.pdf');
  });
});
