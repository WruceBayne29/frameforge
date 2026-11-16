import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VALIDATION_CASES } from './cases';
import type { ValidationCheck } from './cases';

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

describe('validation suite: textbook problems vs closed-form answers', () => {
  it('has at least 10 problems', () => {
    expect(VALIDATION_CASES.length).toBeGreaterThanOrEqual(10);
  });

  for (const vcase of VALIDATION_CASES) {
    describe(`${vcase.id} ${vcase.title}`, () => {
      const checks = vcase.run();
      const scale = Math.max(...checks.map((c) => Math.abs(c.expected)), 1e-12);
      rows.push(`\n### ${vcase.id} — ${vcase.title}\n`);
      rows.push(`Reference: ${vcase.reference}\n`);
      rows.push('| Quantity | Closed form | Expected | FrameForge | Error |');
      rows.push('| --- | --- | ---: | ---: | ---: |');
      for (const c of checks) {
        const err = relativeError(c, scale);
        rows.push(
          `| ${c.quantity} | ${c.formula} | ${fmt(c.expected)} ${c.unit} | ${fmt(c.actual)} ${c.unit} | ${(err * 100).toFixed(4)} % |`,
        );
        it(`${c.quantity} = ${c.formula}`, () => {
          expect(err).toBeLessThan(TOLERANCE);
        });
      }
    });
  }

  it('writes VALIDATION.md when WRITE_VALIDATION=1', () => {
    if (process.env.WRITE_VALIDATION !== '1') return;
    const total = VALIDATION_CASES.reduce((n, c) => n + c.run().length, 0);
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
    writeFileSync('VALIDATION.md', [...header, ...rows, ''].join('\n'));
  });
});
