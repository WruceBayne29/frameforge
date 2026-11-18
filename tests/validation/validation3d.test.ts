import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VALIDATION_CASES_3D } from './cases3d';
import type { ValidationCheck } from './cases';

/** Relative error; for zero targets the error is measured against the largest check in the case. */
function relativeError(c: ValidationCheck, scale: number): number {
  const denom = Math.abs(c.expected) > 1e-12 ? Math.abs(c.expected) : scale;
  return Math.abs(c.actual - c.expected) / denom;
}

function fmt(v: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs < 1e-12) return '0';
  return abs >= 1000 || abs < 0.001 ? v.toExponential(4) : v.toPrecision(6);
}

/** "0.1 %", "1 %", "0.5 %". */
function percent(tolerance: number): string {
  return `${Number((tolerance * 100).toPrecision(3))} %`;
}

const rows: string[] = [];
const summary: string[] = [];
let total = 0;

describe('3D validation suite: textbook problems and FE benchmarks', () => {
  it('has at least 14 problems with unique ids', () => {
    expect(VALIDATION_CASES_3D.length).toBeGreaterThanOrEqual(14);
    expect(new Set(VALIDATION_CASES_3D.map((c) => c.id)).size).toBe(VALIDATION_CASES_3D.length);
  });

  for (const vcase of VALIDATION_CASES_3D) {
    describe(`${vcase.id} ${vcase.title}`, () => {
      const checks = vcase.run();
      total += checks.length;
      const scale = Math.max(...checks.map((c) => Math.abs(c.expected)), 1e-12);
      rows.push(`\n### ${vcase.id} — ${vcase.title}\n`);
      rows.push(`Reference: ${vcase.reference}. Tolerance: ${percent(vcase.tolerance)}.\n`);
      rows.push('| Quantity | Reference value | Expected | FrameForge | Error |');
      rows.push('| --- | --- | ---: | ---: | ---: |');
      const worst = Math.max(...checks.map((c) => relativeError(c, scale)));
      summary.push(
        `| ${vcase.id} | ${vcase.title} | ${checks.length} | ${percent(vcase.tolerance)} | ${
          worst < 5e-7 ? '< 0.0001' : (worst * 100).toFixed(4)
        } % |`,
      );
      for (const c of checks) {
        const err = relativeError(c, scale);
        rows.push(
          `| ${c.quantity} | ${c.formula} | ${fmt(c.expected)} ${c.unit} | ${fmt(c.actual)} ${c.unit} | ${(err * 100).toFixed(4)} % |`,
        );
        it(`${c.quantity} = ${c.formula}`, () => {
          expect(Number.isFinite(c.actual)).toBe(true);
          expect(err).toBeLessThan(vcase.tolerance);
        });
      }
    });
  }

  it('writes VALIDATION_3D.md when WRITE_VALIDATION=1', () => {
    if (process.env.WRITE_VALIDATION !== '1') return;
    const header = [
      '# 3D validation',
      '',
      `FrameForge's 3D solver is checked against **${VALIDATION_CASES_3D.length} problems** ` +
        `(${total} individual quantities): closed-form answers for space trusses and frames, and ` +
        'published thin-plate, shell and elasticity solutions for the plate and solid elements. ' +
        'Every case runs through the public `analyze3d` API exactly as the app does.',
      '',
      'Each case has its own tolerance, shown in the table. Truss and beam elements are exact for',
      'the loads they carry, so those cases must match to **0.1 %**, like the 2D suite. Plate and',
      'solid cases compare a finite-element mesh with a continuum solution; their tolerance is the',
      'accuracy that mesh is expected to reach, stated before the run, and the mesh is named in the',
      'title.',
      '',
      'The tables below are generated from the test suite itself (`tests/validation/cases3d.ts`),',
      'so they cannot drift from the code. Regenerate them with `npm run validation3d`.',
      '',
      'Units: kN, m (stresses kN/m², plate moments kN·m/m). Global Y is up. Unless a case says',
      'otherwise, line members use E = 200 GPa, G = E/2.6, A = 0.01 m², Iz = 1.2×10⁻⁴ m⁴,',
      'Iy = 4×10⁻⁵ m⁴, J = 2.5×10⁻⁵ m⁴. Where the classical solution neglects axial deformation',
      '(B04), a very large area is used. For a zero reference value the error is measured against',
      'the largest reference value of the case.',
    ];
    const table = [
      '| # | Problem | Quantities | Tolerance | Max error |',
      '| --- | --- | ---: | ---: | ---: |',
      ...summary,
    ];
    writeFileSync(
      'VALIDATION_3D.md',
      [...header, '', '## Summary', '', ...table, '', '## Full results', ...rows, ''].join('\n'),
    );
    // Keep the copy of the summary table in the README in sync.
    const readme = readFileSync('README.md', 'utf8');
    const start = '<!-- validation3d:start -->';
    const end = '<!-- validation3d:end -->';
    if (readme.includes(start) && readme.includes(end)) {
      const block = [
        start,
        `**${VALIDATION_CASES_3D.length} problems, ${total} quantities, each within its stated tolerance.**`,
        '',
        ...table,
        end,
      ].join('\n');
      writeFileSync(
        'README.md',
        readme.slice(0, readme.indexOf(start)) +
          block +
          readme.slice(readme.indexOf(end) + end.length),
      );
    }
  });
});
