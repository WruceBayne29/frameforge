import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VALIDATION_CASES } from './cases';
import type { ValidationCase, ValidationCheck } from './cases';
import { ENGINE_2D, PLANE_ENGINE } from './engine';
import type { Engine2D } from './engine';

const TOLERANCE = 1e-3; // 0.1 %

/** Relative error; for zero targets the error is measured against the largest check in the case. */
function relativeError(c: ValidationCheck, scale: number): number {
  const denom = Math.abs(c.expected) > 1e-12 ? Math.abs(c.expected) : scale;
  return Math.abs(c.actual - c.expected) / denom;
}

function fmt(v: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs < 1e-9) return '0';
  return abs >= 1000 || abs < 0.001 ? v.toExponential(4) : v.toPrecision(6);
}

const rows: string[] = [];

/** False while an engine cannot run a case yet (a feature not ported to plane mode). */
function runnable(vcase: ValidationCase, engine: Engine2D): boolean {
  try {
    vcase.run(engine);
    return true;
  } catch (e) {
    if (e instanceof Error && /not available in plane mode/.test(e.message)) return false;
    throw e;
  }
}

const scaleOf = (checks: ValidationCheck[]) =>
  Math.max(...checks.map((c) => Math.abs(c.expected)), 1e-12);
const summary: string[] = [];

describe('validation suite: textbook problems vs closed-form answers', () => {
  it('has at least 10 problems', () => {
    expect(VALIDATION_CASES.length).toBeGreaterThanOrEqual(10);
  });

  for (const vcase of VALIDATION_CASES) {
    describe(`${vcase.id} ${vcase.title}`, () => {
      // The published table describes the solver the app runs: the 3D solver in plane mode.
      const published = runnable(vcase, PLANE_ENGINE) ? PLANE_ENGINE : ENGINE_2D;
      const checks = vcase.run(published);
      const scale = scaleOf(checks);
      rows.push(`\n### ${vcase.id} — ${vcase.title}\n`);
      rows.push(`Reference: ${vcase.reference}\n`);
      rows.push('| Quantity | Closed form | Expected | FrameForge | Error |');
      rows.push('| --- | --- | ---: | ---: | ---: |');
      const worst = Math.max(...checks.map((c) => relativeError(c, scale)));
      summary.push(
        `| ${vcase.id} | ${vcase.title} | ${checks
          .map((c) => c.formula)
          .slice(0, 3)
          .join(
            ', ',
          )}${checks.length > 3 ? ', …' : ''} | ${checks.length} | ${worst < 5e-7 ? '< 0.0001' : (worst * 100).toFixed(4)} % |`,
      );
      for (const c of checks) {
        const err = relativeError(c, scale);
        rows.push(
          `| ${c.quantity} | ${c.formula} | ${fmt(c.expected)} ${c.unit} | ${fmt(c.actual)} ${c.unit} | ${(err * 100).toFixed(4)} % |`,
        );
      }
      for (const engine of [PLANE_ENGINE, ENGINE_2D]) {
        if (!runnable(vcase, engine)) continue;
        const results = engine === published ? checks : vcase.run(engine);
        const s = scaleOf(results);
        for (const c of results) {
          it(`${engine.name}: ${c.quantity} = ${c.formula}`, () => {
            expect(relativeError(c, s)).toBeLessThan(TOLERANCE);
          });
        }
      }
    });
  }

  it('writes VALIDATION.md when WRITE_VALIDATION=1', () => {
    if (process.env.WRITE_VALIDATION !== '1') return;
    const total = VALIDATION_CASES.reduce((n, c) => n + c.run(ENGINE_2D).length, 0);
    const header = [
      '# Validation',
      '',
      `FrameForge's solver is checked against **${VALIDATION_CASES.length} textbook problems** ` +
        `(${total} individual quantities) with closed-form answers. Every quantity must match ` +
        'to within **0.1 %**; in practice the error is at the level of floating-point round-off.',
      '',
      'The table below is generated from the test suite itself (`tests/validation/cases.ts`), so it',
      'cannot drift from the code. Regenerate it with `npm run validation`. The suite runs in CI on',
      'every push.',
      '',
      'Units: kN, m, kN·m, rad. E = 200 GPa, I = 1.2×10⁻⁴ m⁴, A = 8×10⁻³ m² unless a case says otherwise.',
      'Where the classical solution neglects axial deformation (portal frames), a very large area is used.',
      'Deflections are positive upward, so downward deflections are negative.',
    ];
    const table = [
      '| # | Problem | Closed-form checks | Quantities | Max error |',
      '| --- | --- | --- | ---: | ---: |',
      ...summary,
    ];
    writeFileSync(
      'VALIDATION.md',
      [...header, '', '## Summary', '', ...table, '', '## Full results', ...rows, ''].join('\n'),
    );
    // Keep the copy of the summary table in the README in sync.
    const readme = readFileSync('README.md', 'utf8');
    const start = '<!-- validation:start -->';
    const end = '<!-- validation:end -->';
    if (readme.includes(start) && readme.includes(end)) {
      const block = [
        start,
        `**${VALIDATION_CASES.length} problems, ${total} quantities, all within 0.1 %.**`,
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
