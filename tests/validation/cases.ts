/**
 * Validation suite: textbook problems with closed-form answers.
 * Units: kN, m. Every check must match the closed-form value to within 0.1 %.
 */
import type { Engine2D } from './engine';
import type {
  AnalysisResult,
  SolverLoad,
  SolverMember,
  SolverNode,
  SolverSupport,
  StructureModel,
} from '../../src/solver';

export interface ValidationCheck {
  quantity: string;
  formula: string;
  expected: number;
  actual: number;
  unit: string;
}

export interface ValidationCase {
  id: string;
  title: string;
  reference: string;
  /** Runs the case with the given solver (the 2D reference or the 3D plane-frame path). */
  run: (engine: Engine2D) => ValidationCheck[];
}

const E = 2e8; // kN/m² (200 GPa)
const I = 1.2e-4; // m⁴
const A = 8e-3; // m²
/** Very large area used where the classical solution neglects axial deformation. */
const A_RIGID = 1e4;

const frame = (
  id: string,
  i: string,
  j: string,
  extra: Partial<SolverMember> = {},
): SolverMember => ({
  id,
  i,
  j,
  type: 'frame',
  E,
  A,
  I,
  ...extra,
});
const bar = (id: string, i: string, j: string, area = A): SolverMember => ({
  id,
  i,
  j,
  type: 'truss',
  E,
  A: area,
  I: 0,
});
const node = (id: string, x: number, y: number): SolverNode => ({ id, x, y });
const fixed = (n: string): SolverSupport => ({ node: n, ux: true, uy: true, rz: true });
const pinned = (n: string): SolverSupport => ({ node: n, ux: true, uy: true });
const roller = (n: string): SolverSupport => ({ node: n, uy: true });
const udl = (member: string, w: number): SolverLoad => ({
  kind: 'distributed',
  member,
  direction: 'globalY',
  w1: -w,
});

const solve = (
  engine: Engine2D,
  nodes: SolverNode[],
  members: SolverMember[],
  supports: SolverSupport[],
  loads: SolverLoad[],
): AnalysisResult => engine.analyze({ nodes, members, supports, loads } satisfies StructureModel);

const check = (
  quantity: string,
  formula: string,
  expected: number,
  actual: number,
  unit: string,
): ValidationCheck => ({ quantity, formula, expected, actual, unit });

/** Value of a station quantity at the station closest to x. */
const at = (r: AnalysisResult, member: string, x: number, key: 'M' | 'V' | 'N' | 'v'): number => {
  const stations = r.members[member].stations;
  let best = stations[0];
  for (const s of stations) if (Math.abs(s.x - x) < Math.abs(best.x - x)) best = s;
  return best[key];
};

export const VALIDATION_CASES: ValidationCase[] = [
  {
    id: 'V01',
    title: 'Cantilever with a point load at the tip',
    reference: 'Hibbeler, Structural Analysis, beam deflection tables',
    run: (engine) => {
      const L = 4;
      const P = 25;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [fixed('A')],
        [{ kind: 'nodal', node: 'B', fy: -P }],
      );
      return [
        check('Tip deflection', 'PL³/3EI', -(P * L ** 3) / (3 * E * I), r.displacements.B.uy, 'm'),
        check('Tip rotation', 'PL²/2EI', -(P * L ** 2) / (2 * E * I), r.displacements.B.rz, 'rad'),
        check('Fixed-end moment', 'PL (hogging)', -P * L, r.members.AB.start.M, 'kN·m'),
        check('Vertical reaction', 'P', P, r.reactions.A.fy, 'kN'),
        check('Reaction moment', 'PL', P * L, r.reactions.A.mz, 'kN·m'),
      ];
    },
  },
  {
    id: 'V02',
    title: 'Cantilever with a uniformly distributed load',
    reference: 'Hibbeler, Structural Analysis, beam deflection tables',
    run: (engine) => {
      const L = 3.5;
      const w = 12;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [fixed('A')],
        [udl('AB', w)],
      );
      return [
        check('Tip deflection', 'wL⁴/8EI', -(w * L ** 4) / (8 * E * I), r.displacements.B.uy, 'm'),
        check('Tip rotation', 'wL³/6EI', -(w * L ** 3) / (6 * E * I), r.displacements.B.rz, 'rad'),
        check(
          'Fixed-end moment',
          'wL²/2 (hogging)',
          (-w * L * L) / 2,
          r.members.AB.start.M,
          'kN·m',
        ),
        check('Vertical reaction', 'wL', w * L, r.reactions.A.fy, 'kN'),
        check(
          'Mid-length deflection',
          '17wL⁴/384EI',
          (-17 * w * L ** 4) / (384 * E * I),
          at(r, 'AB', L / 2, 'v'),
          'm',
        ),
      ];
    },
  },
  {
    id: 'V03',
    title: 'Simply supported beam with a central point load',
    reference: 'Gere & Goodno, Mechanics of Materials, App. G',
    run: (engine) => {
      const L = 6;
      const P = 40;
      const r = solve(
        engine,
        [node('A', 0, 0), node('C', L / 2, 0), node('B', L, 0)],
        [frame('AC', 'A', 'C'), frame('CB', 'C', 'B')],
        [pinned('A'), roller('B')],
        [{ kind: 'nodal', node: 'C', fy: -P }],
      );
      return [
        check(
          'Midspan deflection',
          'PL³/48EI',
          -(P * L ** 3) / (48 * E * I),
          r.displacements.C.uy,
          'm',
        ),
        check('Midspan moment', 'PL/4', (P * L) / 4, r.members.AC.end.M, 'kN·m'),
        check(
          'End rotation',
          'PL²/16EI',
          -(P * L ** 2) / (16 * E * I),
          r.displacements.A.rz,
          'rad',
        ),
        check('Left reaction', 'P/2', P / 2, r.reactions.A.fy, 'kN'),
        check('Right reaction', 'P/2', P / 2, r.reactions.B.fy, 'kN'),
      ];
    },
  },
  {
    id: 'V04',
    title: 'Simply supported beam with a UDL (single element)',
    reference: 'Gere & Goodno, Mechanics of Materials, App. G',
    run: (engine) => {
      const L = 8;
      const w = 15;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [pinned('A'), roller('B')],
        [udl('AB', w)],
      );
      return [
        check(
          'Midspan deflection',
          '5wL⁴/384EI',
          (-5 * w * L ** 4) / (384 * E * I),
          at(r, 'AB', L / 2, 'v'),
          'm',
        ),
        check('Maximum moment', 'wL²/8', (w * L * L) / 8, r.members.AB.maxMoment.value, 'kN·m'),
        check(
          'End rotation',
          'wL³/24EI',
          -(w * L ** 3) / (24 * E * I),
          r.displacements.A.rz,
          'rad',
        ),
        check('Support reaction', 'wL/2', (w * L) / 2, r.reactions.A.fy, 'kN'),
        check('End shear', 'wL/2', (w * L) / 2, r.members.AB.start.V, 'kN'),
      ];
    },
  },
  {
    id: 'V05',
    title: 'Simply supported beam with an off-centre point load (member load)',
    reference: 'Gere & Goodno, Mechanics of Materials, App. G',
    run: (engine) => {
      const L = 7;
      const a = 2.5;
      const b = L - a;
      const P = 60;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [pinned('A'), roller('B')],
        [{ kind: 'point', member: 'AB', direction: 'globalY', P: -P, a }],
      );
      return [
        check('Left reaction', 'Pb/L', (P * b) / L, r.reactions.A.fy, 'kN'),
        check('Right reaction', 'Pa/L', (P * a) / L, r.reactions.B.fy, 'kN'),
        check('Moment under load', 'Pab/L', (P * a * b) / L, r.members.AB.maxMoment.value, 'kN·m'),
        check(
          'Deflection under load',
          'Pa²b²/3EIL',
          -(P * a * a * b * b) / (3 * E * I * L),
          at(r, 'AB', a, 'v'),
          'm',
        ),
        check(
          'Rotation at A',
          'Pab(L+b)/6EIL',
          -(P * a * b * (L + b)) / (6 * E * I * L),
          r.displacements.A.rz,
          'rad',
        ),
      ];
    },
  },
  {
    id: 'V06',
    title: 'Propped cantilever with a UDL',
    reference: 'Hibbeler, Structural Analysis, ch. 10 (force method)',
    run: (engine) => {
      const L = 5;
      const w = 20;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [fixed('A'), roller('B')],
        [udl('AB', w)],
      );
      return [
        check('Prop reaction', '3wL/8', (3 * w * L) / 8, r.reactions.B.fy, 'kN'),
        check('Fixed-end reaction', '5wL/8', (5 * w * L) / 8, r.reactions.A.fy, 'kN'),
        check(
          'Fixed-end moment',
          'wL²/8 (hogging)',
          (-w * L * L) / 8,
          r.members.AB.start.M,
          'kN·m',
        ),
        check(
          'Max sagging moment',
          '9wL²/128',
          (9 * w * L * L) / 128,
          r.members.AB.maxMoment.value,
          'kN·m',
        ),
        check(
          'Position of max moment',
          '5L/8 from fixed end',
          (5 * L) / 8,
          r.members.AB.maxMoment.x,
          'm',
        ),
        check(
          'Midspan deflection',
          'wL⁴/192EI',
          -(w * L ** 4) / (192 * E * I),
          at(r, 'AB', L / 2, 'v'),
          'm',
        ),
      ];
    },
  },
  {
    id: 'V07',
    title: 'Fixed-fixed beam with a UDL',
    reference: 'Kassimali, Matrix Analysis of Structures, fixed-end moment tables',
    run: (engine) => {
      const L = 6;
      const w = 18;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [fixed('A'), fixed('B')],
        [udl('AB', w)],
      );
      return [
        check('End moment', 'wL²/12 (hogging)', (-w * L * L) / 12, r.members.AB.start.M, 'kN·m'),
        check('Midspan moment', 'wL²/24', (w * L * L) / 24, r.members.AB.maxMoment.value, 'kN·m'),
        check(
          'Midspan deflection',
          'wL⁴/384EI',
          -(w * L ** 4) / (384 * E * I),
          at(r, 'AB', L / 2, 'v'),
          'm',
        ),
        check('Reaction moment at A', 'wL²/12', (w * L * L) / 12, r.reactions.A.mz, 'kN·m'),
      ];
    },
  },
  {
    id: 'V08',
    title: 'Fixed-fixed beam with a central point load',
    reference: 'Kassimali, Matrix Analysis of Structures, fixed-end moment tables',
    run: (engine) => {
      const L = 5;
      const P = 80;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [fixed('A'), fixed('B')],
        [{ kind: 'point', member: 'AB', direction: 'localY', P: -P, a: L / 2 }],
      );
      return [
        check('End moment', 'PL/8 (hogging)', (-P * L) / 8, r.members.AB.start.M, 'kN·m'),
        check('Midspan moment', 'PL/8', (P * L) / 8, r.members.AB.maxMoment.value, 'kN·m'),
        check(
          'Midspan deflection',
          'PL³/192EI',
          -(P * L ** 3) / (192 * E * I),
          at(r, 'AB', L / 2, 'v'),
          'm',
        ),
      ];
    },
  },
  {
    id: 'V09',
    title: 'Two-span continuous beam, equal spans, UDL',
    reference: 'Hibbeler, Structural Analysis, three-moment equation',
    run: (engine) => {
      const L = 6;
      const w = 10;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0), node('C', 2 * L, 0)],
        [frame('AB', 'A', 'B'), frame('BC', 'B', 'C')],
        [pinned('A'), roller('B'), roller('C')],
        [udl('AB', w), udl('BC', w)],
      );
      return [
        check('End reaction', '3wL/8', (3 * w * L) / 8, r.reactions.A.fy, 'kN'),
        check('Central reaction', '10wL/8', (10 * w * L) / 8, r.reactions.B.fy, 'kN'),
        check('Support moment', 'wL²/8 (hogging)', (-w * L * L) / 8, r.members.AB.end.M, 'kN·m'),
        check(
          'Max span moment',
          '9wL²/128',
          (9 * w * L * L) / 128,
          r.members.AB.maxMoment.value,
          'kN·m',
        ),
        check('Position of max span moment', '3L/8', (3 * L) / 8, r.members.AB.maxMoment.x, 'm'),
      ];
    },
  },
  {
    id: 'V10',
    title: 'Three-span continuous beam, equal spans, UDL',
    reference: 'Reynolds & Steedman, continuous-beam coefficients',
    run: (engine) => {
      const L = 4;
      const w = 24;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0), node('C', 2 * L, 0), node('D', 3 * L, 0)],
        [frame('AB', 'A', 'B'), frame('BC', 'B', 'C'), frame('CD', 'C', 'D')],
        [pinned('A'), roller('B'), roller('C'), roller('D')],
        [udl('AB', w), udl('BC', w), udl('CD', w)],
      );
      return [
        check('End reaction', '0.4wL', 0.4 * w * L, r.reactions.A.fy, 'kN'),
        check('Interior reaction', '1.1wL', 1.1 * w * L, r.reactions.B.fy, 'kN'),
        check(
          'Interior support moment',
          '0.1wL² (hogging)',
          -0.1 * w * L * L,
          r.members.AB.end.M,
          'kN·m',
        ),
        check(
          'End-span max moment',
          '0.08wL²',
          0.08 * w * L * L,
          r.members.AB.maxMoment.value,
          'kN·m',
        ),
        check(
          'Centre-span midspan moment',
          '0.025wL²',
          0.025 * w * L * L,
          r.members.BC.maxMoment.value,
          'kN·m',
        ),
      ];
    },
  },
  {
    id: 'V11',
    title: 'Fixed-base portal frame with a lateral load',
    reference: 'Kleinlogel, Rigid Frame Formulas (slope-deflection, axial deformation neglected)',
    run: (engine) => {
      const h = 4;
      const L = 6;
      const P = 50;
      const Ic = 1.0e-4;
      const Ib = 2.5e-4;
      const k = (Ib * h) / (Ic * L);
      const col = { A: A_RIGID, I: Ic };
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', 0, h), node('C', L, h), node('D', L, 0)],
        [
          frame('AB', 'A', 'B', col),
          frame('BC', 'B', 'C', { A: A_RIGID, I: Ib }),
          frame('DC', 'D', 'C', col),
        ],
        [fixed('A'), fixed('D')],
        [{ kind: 'nodal', node: 'B', fx: P }],
      );
      const mBase = (P * h * (3 * k + 1)) / (2 * (6 * k + 1));
      const mTop = (P * h * 3 * k) / (2 * (6 * k + 1));
      return [
        check('Base moment', 'Ph(3k+1)/[2(6k+1)]', mBase, Math.abs(r.members.AB.start.M), 'kN·m'),
        check('Knee moment', '3Phk/[2(6k+1)]', mTop, Math.abs(r.members.AB.end.M), 'kN·m'),
        check('Horizontal reaction', 'P/2', -P / 2, r.reactions.A.fx, 'kN'),
        check('Vertical reaction', '2·M_knee/L', (2 * mTop) / L, r.reactions.D.fy, 'kN'),
        check(
          'Sway',
          'Ph³(3k+2)/[12EIc(6k+1)]',
          (P * h ** 3 * (3 * k + 2)) / (12 * E * Ic * (6 * k + 1)),
          r.displacements.B.ux,
          'm',
        ),
      ];
    },
  },
  {
    id: 'V12',
    title: 'Pinned-base portal frame with a UDL on the beam',
    reference: 'Kleinlogel, Rigid Frame Formulas (axial deformation neglected)',
    run: (engine) => {
      const h = 5;
      const L = 8;
      const w = 16;
      const Ic = 1.5e-4;
      const Ib = 3.0e-4;
      const k = (Ib * h) / (Ic * L);
      const col = { A: A_RIGID, I: Ic };
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', 0, h), node('C', L, h), node('D', L, 0)],
        [
          frame('AB', 'A', 'B', col),
          frame('BC', 'B', 'C', { A: A_RIGID, I: Ib }),
          frame('DC', 'D', 'C', col),
        ],
        [pinned('A'), pinned('D')],
        [udl('BC', w)],
      );
      const H = (w * L * L) / (4 * h * (2 * k + 3));
      return [
        check('Horizontal thrust', 'wL²/[4h(2k+3)]', H, r.reactions.A.fx, 'kN'),
        check('Knee moment', 'H·h (hogging)', -H * h, r.members.BC.start.M, 'kN·m'),
        check(
          'Beam midspan moment',
          'wL²/8 − H·h',
          (w * L * L) / 8 - H * h,
          r.members.BC.maxMoment.value,
          'kN·m',
        ),
        check('Vertical reaction', 'wL/2', (w * L) / 2, r.reactions.A.fy, 'kN'),
      ];
    },
  },
  {
    id: 'V13',
    title: 'Pratt truss, 4 panels, loads at the bottom-chord joints',
    reference: 'Method of joints / sections and unit-load method (Hibbeler ch. 3, 8)',
    run: (engine) => {
      const a = 4;
      const h = 3;
      const P = 30;
      const d = Math.hypot(a, h);
      const sin = h / d;
      const nodes = [
        node('L0', 0, 0),
        node('L1', a, 0),
        node('L2', 2 * a, 0),
        node('L3', 3 * a, 0),
        node('L4', 4 * a, 0),
        node('U1', a, h),
        node('U2', 2 * a, h),
        node('U3', 3 * a, h),
      ];
      const members = [
        bar('L0L1', 'L0', 'L1'),
        bar('L1L2', 'L1', 'L2'),
        bar('L2L3', 'L2', 'L3'),
        bar('L3L4', 'L3', 'L4'),
        bar('U1U2', 'U1', 'U2'),
        bar('U2U3', 'U2', 'U3'),
        bar('L0U1', 'L0', 'U1'),
        bar('L4U3', 'L4', 'U3'),
        bar('L1U1', 'L1', 'U1'),
        bar('L2U2', 'L2', 'U2'),
        bar('L3U3', 'L3', 'U3'),
        bar('U1L2', 'U1', 'L2'),
        bar('U3L2', 'U3', 'L2'),
      ];
      const r = solve(
        engine,
        nodes,
        members,
        [pinned('L0'), roller('L4')],
        ['L1', 'L2', 'L3'].map((n) => ({ kind: 'nodal', node: n, fy: -P }) as SolverLoad),
      );
      // Unit-load method for the midspan deflection: δ = Σ N·n·L / EA (symmetric halves ×2).
      const half: Array<[number, number, number]> = [
        [(1.5 * P * a) / h, (0.5 * a) / h, a], // L0L1
        [(1.5 * P * a) / h, (0.5 * a) / h, a], // L1L2
        [(-2 * P * a) / h, -a / h, a], // U1U2
        [(-1.5 * P) / sin, -0.5 / sin, d], // L0U1
        [P, 0, h], // L1U1
        [(0.5 * P) / sin, 0.5 / sin, d], // U1L2
      ];
      const delta = (2 * half.reduce((s, [N, n, len]) => s + N * n * len, 0)) / (E * A);
      const N = (id: string) => r.members[id].start.N;
      return [
        check('End post L0U1', '−1.5P/sinθ', (-1.5 * P) / sin, N('L0U1'), 'kN'),
        check('Bottom chord L0L1', '1.5Pa/h', (1.5 * P * a) / h, N('L0L1'), 'kN'),
        check('Top chord U1U2', '−2Pa/h', (-2 * P * a) / h, N('U1U2'), 'kN'),
        check('Vertical L1U1', 'P', P, N('L1U1'), 'kN'),
        check('Diagonal U1L2', '0.5P/sinθ', (0.5 * P) / sin, N('U1L2'), 'kN'),
        check('Centre vertical L2U2', '0 (zero-force member)', 0, N('L2U2'), 'kN'),
        check('Midspan deflection', 'ΣNnL/EA', -delta, r.displacements.L2.uy, 'm'),
      ];
    },
  },
  {
    id: 'V14',
    title: 'Warren truss (equilateral), loads at the bottom-chord joints',
    reference: 'Method of joints / sections (Hibbeler ch. 3)',
    run: (engine) => {
      const a = 3;
      const h = (a * Math.sqrt(3)) / 2;
      const P = 45;
      const nodes = [
        node('B0', 0, 0),
        node('B1', a, 0),
        node('B2', 2 * a, 0),
        node('B3', 3 * a, 0),
        node('T0', a / 2, h),
        node('T1', (3 * a) / 2, h),
        node('T2', (5 * a) / 2, h),
      ];
      const members = [
        bar('B0B1', 'B0', 'B1'),
        bar('B1B2', 'B1', 'B2'),
        bar('B2B3', 'B2', 'B3'),
        bar('T0T1', 'T0', 'T1'),
        bar('T1T2', 'T1', 'T2'),
        bar('B0T0', 'B0', 'T0'),
        bar('T0B1', 'T0', 'B1'),
        bar('B1T1', 'B1', 'T1'),
        bar('T1B2', 'T1', 'B2'),
        bar('B2T2', 'B2', 'T2'),
        bar('T2B3', 'T2', 'B3'),
      ];
      const r = solve(
        engine,
        nodes,
        members,
        [pinned('B0'), roller('B3')],
        [
          { kind: 'nodal', node: 'B1', fy: -P },
          { kind: 'nodal', node: 'B2', fy: -P },
        ],
      );
      const N = (id: string) => r.members[id].start.N;
      const s3 = Math.sqrt(3);
      return [
        check('End diagonal B0T0', '−2P/√3', (-2 * P) / s3, N('B0T0'), 'kN'),
        check('Diagonal T0B1', '2P/√3', (2 * P) / s3, N('T0B1'), 'kN'),
        check('Diagonal B1T1', '0 (zero shear panel)', 0, N('B1T1'), 'kN'),
        check('Bottom chord B0B1', 'P/√3', P / s3, N('B0B1'), 'kN'),
        check('Bottom chord B1B2', '2P/√3', (2 * P) / s3, N('B1B2'), 'kN'),
        check('Top chord T0T1', '−2P/√3', (-2 * P) / s3, N('T0T1'), 'kN'),
        check('Support reaction', 'P', P, r.reactions.B0.fy, 'kN'),
      ];
    },
  },
  {
    id: 'V15',
    title: 'Symmetric two-bar truss',
    reference: 'Gere & Goodno, Mechanics of Materials, ch. 2',
    run: (engine) => {
      const b = 3;
      const h = 4;
      const P = 100;
      const len = Math.hypot(b, h);
      const sin = h / len;
      const r = solve(
        engine,
        [node('A', -b, 0), node('B', b, 0), node('C', 0, h)],
        [bar('AC', 'A', 'C'), bar('BC', 'B', 'C')],
        [pinned('A'), pinned('B')],
        [{ kind: 'nodal', node: 'C', fy: -P }],
      );
      return [
        check('Bar force', '−P/(2 sinθ)', -P / (2 * sin), r.members.AC.start.N, 'kN'),
        check(
          'Apex deflection',
          'PL/(2EA sin²θ)',
          -(P * len) / (2 * E * A * sin * sin),
          r.displacements.C.uy,
          'm',
        ),
        check('Horizontal thrust', 'P/(2 tanθ)', (P * b) / (2 * h), r.reactions.A.fx, 'kN'),
      ];
    },
  },
  {
    id: 'V16',
    title: 'Compound beam with an internal hinge (member end release)',
    reference: 'Statics: Gerber beam, cantilever + drop-in span',
    run: (engine) => {
      const L1 = 3;
      const L2 = 4;
      const w = 14;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L1, 0), node('C', L1 + L2, 0)],
        [frame('AB', 'A', 'B'), frame('BC', 'B', 'C', { releaseI: true })],
        [fixed('A'), roller('C')],
        [udl('BC', w)],
      );
      const hingeShear = (w * L2) / 2;
      return [
        check('Roller reaction', 'wL₂/2', hingeShear, r.reactions.C.fy, 'kN'),
        check('Moment at the hinge', '0', 0, r.members.BC.start.M, 'kN·m'),
        check(
          'Fixed-end moment',
          '(wL₂/2)·L₁ (hogging)',
          -hingeShear * L1,
          r.members.AB.start.M,
          'kN·m',
        ),
        check(
          'Hinge deflection',
          '(wL₂/2)·L₁³/3EI',
          -(hingeShear * L1 ** 3) / (3 * E * I),
          r.displacements.B.uy,
          'm',
        ),
        check(
          'Drop-in span max moment',
          'wL₂²/8',
          (w * L2 * L2) / 8,
          r.members.BC.maxMoment.value,
          'kN·m',
        ),
      ];
    },
  },
  {
    id: 'V17',
    title: 'Fixed-fixed beam with a support settlement',
    reference: 'Kassimali, Matrix Analysis of Structures, slope-deflection',
    run: (engine) => {
      const L = 5;
      const delta = 0.012;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [fixed('A'), { ...fixed('B'), settlement: { uy: -delta } }],
        [],
      );
      return [
        check('End moment', '6EIΔ/L²', (6 * E * I * delta) / L ** 2, r.reactions.A.mz, 'kN·m'),
        check('End shear', '12EIΔ/L³', (12 * E * I * delta) / L ** 3, r.reactions.A.fy, 'kN'),
        check('Moment at B', '6EIΔ/L²', (6 * E * I * delta) / L ** 2, r.members.AB.end.M, 'kN·m'),
      ];
    },
  },
  {
    id: 'V18',
    title: 'Simply supported beam with a triangular load',
    reference: 'Gere & Goodno, Mechanics of Materials, App. G',
    run: (engine) => {
      const L = 6;
      const w = 30;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [pinned('A'), roller('B')],
        [{ kind: 'distributed', member: 'AB', direction: 'globalY', w1: 0, w2: -w }],
      );
      return [
        check('Reaction at the zero end', 'wL/6', (w * L) / 6, r.reactions.A.fy, 'kN'),
        check('Reaction at the peak end', 'wL/3', (w * L) / 3, r.reactions.B.fy, 'kN'),
        check(
          'Maximum moment',
          'wL²/(9√3)',
          (w * L * L) / (9 * Math.sqrt(3)),
          r.members.AB.maxMoment.value,
          'kN·m',
        ),
        check('Position of max moment', 'L/√3', L / Math.sqrt(3), r.members.AB.maxMoment.x, 'm'),
        check(
          'Midspan deflection',
          '5wL⁴/768EI',
          (-5 * w * L ** 4) / (768 * E * I),
          at(r, 'AB', L / 2, 'v'),
          'm',
        ),
      ];
    },
  },
  {
    id: 'V19',
    title: 'Fixed-fixed beam with a triangular load',
    reference: 'Kassimali, Matrix Analysis of Structures, fixed-end moment tables',
    run: (engine) => {
      const L = 5;
      const w = 24;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [fixed('A'), fixed('B')],
        [{ kind: 'distributed', member: 'AB', direction: 'localY', w1: 0, w2: -w }],
      );
      return [
        check('Moment at the zero end', 'wL²/30', (w * L * L) / 30, r.reactions.A.mz, 'kN·m'),
        check('Moment at the peak end', 'wL²/20', (-w * L * L) / 20, r.reactions.B.mz, 'kN·m'),
        check('Reaction at the zero end', '3wL/20', (3 * w * L) / 20, r.reactions.A.fy, 'kN'),
        check('Reaction at the peak end', '7wL/20', (7 * w * L) / 20, r.reactions.B.fy, 'kN'),
      ];
    },
  },
  {
    id: 'V20',
    title: 'Simply supported beam with a counter-clockwise moment at midspan',
    reference: 'Gere & Goodno, Mechanics of Materials, App. G',
    run: (engine) => {
      const L = 6;
      const M0 = 90;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [pinned('A'), roller('B')],
        [{ kind: 'moment', member: 'AB', M: M0, a: L / 2 }],
      );
      return [
        check('Reaction at A', 'M₀/L', M0 / L, r.reactions.A.fy, 'kN'),
        check('Reaction at B', '−M₀/L', -M0 / L, r.reactions.B.fy, 'kN'),
        check('Moment just left of midspan', 'M₀/2', M0 / 2, r.members.AB.maxMoment.value, 'kN·m'),
        check(
          'Moment just right of midspan',
          '−M₀/2',
          -M0 / 2,
          r.members.AB.minMoment.value,
          'kN·m',
        ),
        check('Rotation at A', '−M₀L/24EI', -(M0 * L) / (24 * E * I), r.displacements.A.rz, 'rad'),
      ];
    },
  },
  {
    id: 'V21',
    title: 'Inclined simply supported rafter under gravity load',
    reference: 'Statics: load per unit length of member on an inclined beam',
    run: (engine) => {
      const Lh = 6;
      const rise = 2.5;
      const len = Math.hypot(Lh, rise);
      const w = 8;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', Lh, rise)],
        [frame('AB', 'A', 'B')],
        [pinned('A'), roller('B')],
        [udl('AB', w)],
      );
      return [
        check('Vertical reaction', 'wL/2', (w * len) / 2, r.reactions.A.fy, 'kN'),
        check(
          'Maximum moment',
          'w·L·L_h/8',
          (w * len * Lh) / 8,
          r.members.AB.maxMoment.value,
          'kN·m',
        ),
        check(
          'Axial force at the lower end',
          '−(wL/2)·sinα',
          (-(w * len) / 2) * (rise / len),
          r.members.AB.start.N,
          'kN',
        ),
        check(
          'Shear at the lower end',
          '(wL/2)·cosα',
          ((w * len) / 2) * (Lh / len),
          r.members.AB.start.V,
          'kN',
        ),
      ];
    },
  },
  {
    id: 'V22',
    title: 'Cantilever propped by a spring',
    reference: 'Compatibility: beam and spring in parallel',
    run: (engine) => {
      const L = 4;
      const P = 36;
      const ks = 2500;
      const kb = (3 * E * I) / L ** 3;
      const r = solve(
        engine,
        [node('A', 0, 0), node('B', L, 0)],
        [frame('AB', 'A', 'B')],
        [fixed('A'), { node: 'B', spring: { ky: ks } }],
        [{ kind: 'nodal', node: 'B', fy: -P }],
      );
      return [
        check('Tip deflection', 'P/(k_s + 3EI/L³)', -P / (ks + kb), r.displacements.B.uy, 'm'),
        check('Spring force', 'P·k_s/(k_s + 3EI/L³)', (P * ks) / (ks + kb), r.reactions.B.fy, 'kN'),
        check(
          'Fixed-end moment',
          '(P − F_s)·L (hogging)',
          -(P - (P * ks) / (ks + kb)) * L,
          r.members.AB.start.M,
          'kN·m',
        ),
      ];
    },
  },
  {
    id: 'V23',
    title: 'Natural frequencies of a simply supported beam (modal analysis)',
    reference: 'Chopra, Dynamics of Structures, ch. 16: ω_n = (nπ)²·√(EI/mL⁴)',
    run: (engine) => {
      const L = 6;
      const n = 12;
      const m = A * 7.85;
      const nodes = Array.from({ length: n + 1 }, (_, k) => node(`N${k}`, (L * k) / n, 0));
      const members = Array.from({ length: n }, (_, k) =>
        frame(`M${k}`, `N${k}`, `N${k + 1}`, { massPerLength: m, A: A_RIGID }),
      );
      const r = engine.modalAnalysis(
        { nodes, members, supports: [pinned('N0'), roller(`N${n}`)], loads: [] },
        3,
      );
      const omega = (k: number) => (k * Math.PI) ** 2 * Math.sqrt((E * I) / (m * L ** 4));
      return [
        check('1st circular frequency', 'π²·√(EI/mL⁴)', omega(1), r.modes[0].omega, 'rad/s'),
        check('2nd circular frequency', '4π²·√(EI/mL⁴)', omega(2), r.modes[1].omega, 'rad/s'),
        check('3rd circular frequency', '9π²·√(EI/mL⁴)', omega(3), r.modes[2].omega, 'rad/s'),
        check('1st frequency', 'ω₁/2π', omega(1) / (2 * Math.PI), r.modes[0].frequency, 'Hz'),
      ];
    },
  },
  {
    id: 'V24',
    title: 'Natural frequencies of a cantilever (modal analysis)',
    reference: 'Chopra, Dynamics of Structures, ch. 16: ω_n = (β_n L)²·√(EI/mL⁴)',
    run: (engine) => {
      const L = 4;
      const n = 12;
      const m = A * 7.85;
      const nodes = Array.from({ length: n + 1 }, (_, k) => node(`N${k}`, (L * k) / n, 0));
      const members = Array.from({ length: n }, (_, k) =>
        frame(`M${k}`, `N${k}`, `N${k + 1}`, { massPerLength: m, A: A_RIGID }),
      );
      const r = engine.modalAnalysis({ nodes, members, supports: [fixed('N0')], loads: [] }, 2);
      const base = Math.sqrt((E * I) / (m * L ** 4));
      return [
        check(
          '1st circular frequency',
          '1.8751²·√(EI/mL⁴)',
          1.8751040687 ** 2 * base,
          r.modes[0].omega,
          'rad/s',
        ),
        check(
          '2nd circular frequency',
          '4.6941²·√(EI/mL⁴)',
          4.694091133 ** 2 * base,
          r.modes[1].omega,
          'rad/s',
        ),
        check(
          '1st period',
          '2π/ω₁',
          (2 * Math.PI) / (1.8751040687 ** 2 * base),
          r.modes[0].period,
          's',
        ),
      ];
    },
  },
  {
    id: 'V25',
    title: 'Influence lines for a simply supported beam',
    reference: 'Hibbeler, Structural Analysis, ch. 6 (unit load moving across the span)',
    run: (engine) => {
      const L = 8;
      const model: StructureModel = {
        nodes: [node('A', 0, 0), node('B', L, 0)],
        members: [frame('AB', 'A', 'B')],
        supports: [pinned('A'), roller('B')],
        loads: [],
      };
      const options = { pointsPerMember: 17, magnitude: -1 };
      const reaction = engine.influenceLine(
        model,
        { kind: 'reaction', node: 'A', component: 'fy' },
        options,
      );
      const moment = engine.influenceLine(
        model,
        { kind: 'memberForce', member: 'AB', x: L / 2, component: 'M' },
        options,
      );
      const quarter = engine.influenceLine(
        model,
        { kind: 'memberForce', member: 'AB', x: L / 4, component: 'M' },
        options,
      );
      const atX = (line: typeof reaction, x: number) =>
        line.ordinates.find((o) => Math.abs(o.x - x) < 1e-9)?.value ?? NaN;
      return [
        check('R_A with the load at L/4', '1 − x/L', 0.75, atX(reaction, L / 4), 'kN/kN'),
        check('R_A with the load at 3L/4', '1 − x/L', 0.25, atX(reaction, (3 * L) / 4), 'kN/kN'),
        check('Peak of the midspan-moment line', 'L/4', L / 4, moment.max.value, 'kN·m/kN'),
        check('Midspan moment, load at L/4', 'x/2', L / 8, atX(moment, L / 4), 'kN·m/kN'),
        check(
          'Peak of the quarter-point moment line',
          '3L/16',
          (3 * L) / 16,
          quarter.max.value,
          'kN·m/kN',
        ),
        check('Position of that peak', 'L/4', L / 4, quarter.max.x, 'm'),
      ];
    },
  },
  {
    id: 'V26',
    title: 'Influence line for the central reaction of a two-span continuous beam',
    reference: 'Müller-Breslau / three-moment equation: R_B = x(3L² − x²)/2L³',
    run: (engine) => {
      const L = 5;
      const model: StructureModel = {
        nodes: [node('A', 0, 0), node('B', L, 0), node('C', 2 * L, 0)],
        members: [frame('AB', 'A', 'B'), frame('BC', 'B', 'C')],
        supports: [pinned('A'), roller('B'), roller('C')],
        loads: [],
      };
      const line = engine.influenceLine(
        model,
        { kind: 'reaction', node: 'B', component: 'fy' },
        { pointsPerMember: 11, path: ['AB'] },
      );
      const rb = (x: number) => (x * (3 * L * L - x * x)) / (2 * L ** 3);
      const atX = (x: number) => line.ordinates.find((o) => Math.abs(o.x - x) < 1e-9)?.value ?? NaN;
      const support = engine.influenceLine(
        model,
        { kind: 'memberForce', member: 'AB', x: L, component: 'M' },
        { pointsPerMember: 11, path: ['AB'] },
      );
      return [
        check('R_B with the load at 0.3L', 'x(3L² − x²)/2L³', rb(0.3 * L), atX(0.3 * L), 'kN/kN'),
        check('R_B with the load at 0.5L', 'x(3L² − x²)/2L³', rb(0.5 * L), atX(0.5 * L), 'kN/kN'),
        check('R_B with the load at 0.8L', 'x(3L² − x²)/2L³', rb(0.8 * L), atX(0.8 * L), 'kN/kN'),
        check('R_B with the load over B', '1', 1, atX(L), 'kN/kN'),
        check(
          'Support moment, load at 0.5L',
          '−x(L² − x²)/4L²',
          -(0.5 * L * (L * L - 0.25 * L * L)) / (4 * L * L),
          support.ordinates.find((o) => Math.abs(o.x - 0.5 * L) < 1e-9)?.value ?? NaN,
          'kN·m/kN',
        ),
        check(
          'Worst position for the support moment',
          'L/√3 (between 0.5L and 0.6L)',
          0.6 * L,
          support.min.x,
          'm',
        ),
      ];
    },
  },
];
