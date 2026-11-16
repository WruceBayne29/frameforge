import type { Project } from '../model/types';
import { buildProject } from './builder';

export interface Example {
  id: string;
  name: string;
  category: 'Beams' | 'Frames' | 'Trusses';
  summary: string;
  build: () => Project;
}

const simpleBeam = () =>
  buildProject(
    'Simply supported beam',
    'An 8 m ISMB 400 beam carrying a 20 kN/m UDL and a 50 kN point load.',
    (b) => {
      b.design({ laterallyRestrained: true });
      const a = b.node(0, 0);
      const c = b.node(8, 0);
      const m = b.member(a, c, 'ISMB 400');
      b.support(a, 'pinned');
      b.support(c, 'rollerX');
      b.udl(m, 20);
      b.point(m, 50, 3);
    },
  );

const continuousBeam = () =>
  buildProject(
    'Three-span continuous beam',
    'Spans of 6 m, 8 m and 6 m in ISMB 350 under 25 kN/m, with pattern loading on the centre span.',
    (b) => {
      b.design({ laterallyRestrained: true });
      const xs = [0, 6, 14, 20];
      const nodes = xs.map((x) => b.node(x, 0));
      const spans = [0, 1, 2].map((k) => b.member(nodes[k], nodes[k + 1], 'ISMB 350'));
      b.support(nodes[0], 'pinned');
      nodes.slice(1).forEach((n) => b.support(n, 'rollerX'));
      spans.forEach((m) => b.udl(m, 25));
      b.point(spans[1], 60, 4);
    },
  );

const gerberBeam = () =>
  buildProject(
    'Propped beam with an internal hinge',
    'A fixed cantilever carrying a drop-in span through a hinge — a classic Gerber beam.',
    (b) => {
      b.design({ laterallyRestrained: true });
      const a = b.node(0, 0);
      const h = b.node(4, 0);
      const c = b.node(9, 0);
      const d = b.node(11, 0);
      const m1 = b.member(a, h, 'ISMB 400');
      const m2 = b.member(h, c, 'ISMB 400', 'frame', { i: true });
      const m3 = b.member(c, d, 'ISMB 400');
      b.support(a, 'fixed');
      b.support(c, 'rollerX');
      b.udl(m1, 12);
      b.udl(m2, 18);
      b.distributed(m3, 18, 0);
      b.nodal(d, 0, -15);
    },
  );

const portalFrame = () =>
  buildProject(
    'Portal frame',
    'A fixed-base 8 m × 5 m portal with gravity load on the beam and a lateral wind load.',
    (b) => {
      b.design({ laterallyRestrained: true });
      const a = b.node(0, 0);
      const bb = b.node(0, 5);
      const c = b.node(8, 5);
      const d = b.node(8, 0);
      b.member(a, bb, 'ISMB 400');
      const beam = b.member(bb, c, 'ISMB 450');
      b.member(d, c, 'ISMB 400');
      b.support(a, 'fixed');
      b.support(d, 'fixed');
      b.udl(beam, 30);
      b.nodal(bb, 40, 0);
    },
  );

const gableFrame = () =>
  buildProject(
    'Pitched-roof (gable) frame',
    'A pinned-base industrial shed frame, 16 m span with a 10° roof pitch.',
    (b) => {
      b.design({ laterallyRestrained: true });
      const eaves = 6;
      const ridge = eaves + 8 * Math.tan((10 * Math.PI) / 180);
      const a = b.node(0, 0);
      const bb = b.node(0, eaves);
      const c = b.node(8, Number(ridge.toFixed(3)));
      const d = b.node(16, eaves);
      const e = b.node(16, 0);
      b.member(a, bb, 'ISMB 500');
      const r1 = b.member(bb, c, 'ISMB 450');
      const r2 = b.member(c, d, 'ISMB 450');
      b.member(e, d, 'ISMB 500');
      b.support(a, 'pinned');
      b.support(e, 'pinned');
      b.udl(r1, 9);
      b.udl(r2, 9);
      b.nodal(bb, 18, 0);
    },
  );

const multiStorey = () =>
  buildProject(
    'Three-storey, two-bay frame',
    'A rigid-jointed building frame with floor loads and lateral loads at each storey.',
    (b) => {
      b.design({ laterallyRestrained: true });
      const bays = [0, 6, 12];
      const storey = 3.5;
      const grid: string[][] = [];
      for (let level = 0; level <= 3; level++) {
        grid.push(bays.map((x) => b.node(x, level * storey)));
      }
      grid[0].forEach((n) => b.support(n, 'fixed'));
      const lateral = [20, 30, 40];
      for (let level = 1; level <= 3; level++) {
        bays.forEach((_, col) =>
          b.member(grid[level - 1][col], grid[level][col], level === 1 ? 'ISMB 450' : 'ISMB 350'),
        );
        for (let col = 0; col < bays.length - 1; col++) {
          const beam = b.member(grid[level][col], grid[level][col + 1], 'ISMB 400');
          b.udl(beam, level === 3 ? 18 : 28);
        }
        b.nodal(grid[level][0], lateral[level - 1], 0);
      }
    },
  );

const prattTruss = () =>
  buildProject(
    'Pratt truss bridge',
    'An 18 m, six-panel Pratt truss with deck loads at the bottom-chord joints.',
    (b) => {
      const panels = 6;
      const a = 3;
      const h = 3;
      const chord = 'ISMB 250';
      const web = 'ISMC 150';
      const bottom = Array.from({ length: panels + 1 }, (_, k) => b.node(k * a, 0));
      const top = Array.from({ length: panels - 1 }, (_, k) => b.node((k + 1) * a, h));
      for (let k = 0; k < panels; k++) b.member(bottom[k], bottom[k + 1], chord, 'truss');
      for (let k = 0; k < panels - 2; k++) b.member(top[k], top[k + 1], chord, 'truss');
      b.member(bottom[0], top[0], chord, 'truss');
      b.member(bottom[panels], top[panels - 2], chord, 'truss');
      for (let k = 0; k < panels - 1; k++) b.member(bottom[k + 1], top[k], web, 'truss');
      // Diagonals slope down towards midspan so they act in tension under gravity.
      const mid = panels / 2;
      for (let k = 0; k < panels - 1; k++) {
        const joint = k + 1;
        if (joint < mid) b.member(top[k], bottom[joint + 1], web, 'truss');
        else if (joint > mid) b.member(top[k], bottom[joint - 1], web, 'truss');
      }
      b.support(bottom[0], 'pinned');
      b.support(bottom[panels], 'rollerX');
      for (let k = 1; k < panels; k++) b.nodal(bottom[k], 0, -60);
    },
  );

const warrenTruss = () =>
  buildProject(
    'Warren roof truss',
    'An 18 m Warren truss with equal panels and roof loads applied at the top chord.',
    (b) => {
      const panels = 6;
      const a = 3;
      const h = 2.6;
      const bottom = Array.from({ length: panels + 1 }, (_, k) => b.node(k * a, 0));
      const top = Array.from({ length: panels }, (_, k) => b.node((k + 0.5) * a, h));
      for (let k = 0; k < panels; k++) b.member(bottom[k], bottom[k + 1], 'ISMC 200', 'truss');
      for (let k = 0; k < panels - 1; k++) b.member(top[k], top[k + 1], 'ISMC 200', 'truss');
      for (let k = 0; k < panels; k++) {
        b.member(bottom[k], top[k], 'ISMC 150', 'truss');
        b.member(top[k], bottom[k + 1], 'ISMC 150', 'truss');
      }
      b.support(bottom[0], 'pinned');
      b.support(bottom[panels], 'rollerX');
      top.forEach((n, k) => b.nodal(n, 0, k === 0 || k === panels - 1 ? -20 : -35));
    },
  );

const transmissionTower = () =>
  buildProject(
    'Transmission tower',
    'A 32.5 m lattice tower with X-braced panels, three pairs of cross-arms, conductor loads and ' +
      'transverse wind. Real towers use angle sections; I and channel sections from the built-in ' +
      'table stand in for them here.',
    (b) => {
      const heights = [0, 3, 6, 9, 12, 15, 18, 20.5, 23, 25.5, 28, 30.5];
      const halfWidth = (y: number) => (y >= 20.5 ? 1 : 3.5 - (2.5 * y) / 20.5);
      const round = (v: number) => Number(v.toFixed(3));
      const left = heights.map((y) => b.node(round(-halfWidth(y)), y));
      const right = heights.map((y) => b.node(round(halfWidth(y)), y));
      for (let k = 0; k < heights.length - 1; k++) {
        const lower = heights[k] < 18;
        const leg = lower ? 'ISMB 250' : 'ISMB 200';
        const brace = lower ? 'ISMC 150' : 'ISMC 100';
        b.member(left[k], left[k + 1], leg, 'truss');
        b.member(right[k], right[k + 1], leg, 'truss');
        // X-bracing connected at the crossing point, which halves the buckling length.
        const w0 = halfWidth(heights[k]);
        const w1 = halfWidth(heights[k + 1]);
        const t = w0 / (w0 + w1);
        const centre = b.node(0, round(heights[k] + t * (heights[k + 1] - heights[k])));
        for (const corner of [left[k], right[k], left[k + 1], right[k + 1]]) {
          b.member(corner, centre, brace, 'truss');
        }
        if (heights[k + 1] >= 18) b.member(left[k + 1], right[k + 1], 'ISMC 100', 'truss');
      }
      const last = heights.length - 1;
      const peak = b.node(0, 32.5);
      b.member(left[last], peak, 'ISMC 100', 'truss');
      b.member(right[last], peak, 'ISMC 100', 'truss');
      // Cross-arms: [body level index, reach from the tower centre-line].
      const arms: Array<[number, number]> = [
        [8, 3.8],
        [9, 3.4],
        [10, 3.0],
      ];
      for (const [level, reach] of arms) {
        const y = heights[level];
        const tipL = b.node(-reach, y);
        const tipR = b.node(reach, y);
        b.member(left[level], tipL, 'ISMC 150', 'truss');
        b.member(left[level + 1], tipL, 'ISMC 100', 'truss');
        b.member(right[level], tipR, 'ISMC 150', 'truss');
        b.member(right[level + 1], tipR, 'ISMC 100', 'truss');
        // Conductor weight plus transverse wind on the conductors.
        b.nodal(tipL, 6, -16);
        b.nodal(tipR, 6, -16);
      }
      b.nodal(peak, 3, -6);
      // Wind on the tower body.
      for (let k = 1; k < heights.length; k++) b.nodal(left[k], 2.5, 0);
      b.support(left[0], 'pinned');
      b.support(right[0], 'pinned');
    },
  );

export const EXAMPLES: Example[] = [
  {
    id: 'portal-frame',
    name: 'Portal frame',
    category: 'Frames',
    summary: 'Fixed-base portal, gravity + wind',
    build: portalFrame,
  },
  {
    id: 'simple-beam',
    name: 'Simply supported beam',
    category: 'Beams',
    summary: 'UDL + point load on an 8 m span',
    build: simpleBeam,
  },
  {
    id: 'continuous-beam',
    name: 'Continuous beam',
    category: 'Beams',
    summary: 'Three spans, statically indeterminate',
    build: continuousBeam,
  },
  {
    id: 'gerber-beam',
    name: 'Beam with a hinge',
    category: 'Beams',
    summary: 'Internal hinge (moment release)',
    build: gerberBeam,
  },
  {
    id: 'gable-frame',
    name: 'Gable frame',
    category: 'Frames',
    summary: 'Pitched-roof industrial shed',
    build: gableFrame,
  },
  {
    id: 'multi-storey',
    name: 'Multi-storey frame',
    category: 'Frames',
    summary: '3 storeys × 2 bays, lateral loads',
    build: multiStorey,
  },
  {
    id: 'pratt-truss',
    name: 'Pratt truss bridge',
    category: 'Trusses',
    summary: '18 m span, six panels',
    build: prattTruss,
  },
  {
    id: 'warren-truss',
    name: 'Warren roof truss',
    category: 'Trusses',
    summary: '18 m span, top-chord loads',
    build: warrenTruss,
  },
  {
    id: 'transmission-tower',
    name: 'Transmission tower',
    category: 'Trusses',
    summary: '32.5 m lattice tower with cross-arms',
    build: transmissionTower,
  },
];

export function getExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
