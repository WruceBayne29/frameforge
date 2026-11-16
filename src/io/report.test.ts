import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples';
import { designMembers, toSolverModel } from '../model';
import { analyze } from '../solver';
import { buildReport, pdfText, reportFileName } from './report';

describe('PDF report', () => {
  for (const id of ['portal-frame', 'gerber-beam', 'transmission-tower']) {
    it(`builds a multi-page PDF for ${id}`, () => {
      const project = EXAMPLES.find((e) => e.id === id)!.build();
      const result = analyze(toSolverModel(project));
      const doc = buildReport({
        project,
        result,
        design: designMembers(project, result),
        date: new Date('2026-01-02T00:00:00Z'),
        shareUrl: 'https://example.org/#m=0.abc',
      });
      const bytes = new Uint8Array(doc.output('arraybuffer'));
      expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
      expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(3);
      expect(bytes.length).toBeGreaterThan(8000);
    });
  }

  it('handles a model with custom sections, moments and no design checks', () => {
    const project = EXAMPLES[1].build();
    project.customSections.push({ name: 'Box', A: 40, I: 3000 });
    project.members[0].section = 'Box';
    project.loads.push({ id: 'Lm', kind: 'moment', member: project.members[0].id, M: 12, a: 2 });
    project.loads.push({
      id: 'Ln',
      kind: 'nodal',
      node: project.nodes[1].id,
      fx: 4,
      fy: 5,
      mz: -3,
    });
    project.loads.push({
      id: 'Lp',
      kind: 'point',
      member: project.members[0].id,
      direction: 'localX',
      P: 2,
      a: 1,
    });
    project.supports[1].kind = 'rollerY';
    project.supports[0].kind = 'fixed';
    const result = analyze(toSolverModel(project));
    const doc = buildReport({ project, result, design: designMembers(project, result) });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(2);
  });

  it('sanitises text for the built-in fonts and names the file', () => {
    expect(pdfText('δ ≤ L/250 → OK · 5 cm² ⁴ ☃')).toBe('d <= L/250 -> OK · 5 cm² 4 ?');
    expect(reportFileName(EXAMPLES[0].build())).toBe('portal-frame-report.pdf');
    expect(reportFileName({ ...EXAMPLES[0].build(), name: '!!!' })).toBe('frameforge-report.pdf');
  });
});
