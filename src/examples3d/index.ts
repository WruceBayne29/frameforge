import { EXAMPLES } from '../examples';
import { from2D } from '../model3d/generate';
import { FIXED_SUPPORT, PINNED_SUPPORT } from '../model3d/types';
import type { CustomSection3D, Project3D, Restraints6 } from '../model3d/types';
import { buildProject3D } from './builder';

export const PLANE_CATEGORY = '2D frames & trusses';

export type ExampleCategory3D =
  'Trusses' | 'Frames' | 'Plates' | 'Solids' | 'Mixed' | typeof PLANE_CATEGORY;

export interface Example3D {
  id: string;
  name: string;
  category: ExampleCategory3D;
  summary: string;
  build: () => Project3D;
}

const STEEL = 'Steel';
const CONCRETE = 'Concrete M25';

/** Circular hollow section 114.3 × 5 mm. */
const TUBE: CustomSection3D = { name: 'CHS 114.3×5', A: 17.2, Iz: 257, Iy: 257, J: 514 };
/** Square hollow section 300 × 300 × 12 mm — equally stiff about both axes. */
const BOX: CustomSection3D = { name: 'SHS 300×12', A: 138.2, Iz: 19140, Iy: 19140, J: 28660 };
/** Solid 300 × 300 mm concrete column. */
const RC_COLUMN: CustomSection3D = {
  name: 'RC 300×300',
  A: 900,
  Iz: 67500,
  Iy: 67500,
  J: 114000,
};

const towerTruss = () =>
  buildProject3D(
    '25-bar transmission tower',
    'The classic 25-bar space truss: a 6 m tower on four pinned feet with vertical and ' +
      'transverse conductor loads at the two top nodes.',
    (b) => {
      b.custom(TUBE);
      const n = [
        b.node(-1, 6, 0),
        b.node(1, 6, 0),
        b.node(-1, 3, 1),
        b.node(1, 3, 1),
        b.node(1, 3, -1),
        b.node(-1, 3, -1),
        b.node(-2.5, 0, 2.5),
        b.node(2.5, 0, 2.5),
        b.node(2.5, 0, -2.5),
        b.node(-2.5, 0, -2.5),
      ];
      // Member list of the benchmark, by 1-based node numbers.
      const bars: Array<[number, number]> = [
        [1, 2],
        [1, 4],
        [2, 3],
        [1, 5],
        [2, 6],
        [2, 4],
        [2, 5],
        [1, 3],
        [1, 6],
        [3, 6],
        [4, 5],
        [3, 4],
        [5, 6],
        [3, 10],
        [6, 7],
        [4, 9],
        [5, 8],
        [4, 7],
        [3, 8],
        [5, 10],
        [6, 9],
        [6, 10],
        [3, 7],
        [4, 8],
        [5, 9],
      ];
      for (const [i, j] of bars) b.truss(n[i - 1], n[j - 1], TUBE.name);
      b.support(n.slice(6), PINNED_SUPPORT);
      b.nodal([n[0], n[1]], [0, -40, 40]);
      b.nodal(n[0], [5, 0, 0]);
      b.nodal([n[2], n[5]], [3, 0, 0]);
    },
  );

const spaceTrussRoof = () =>
  buildProject3D(
    'Double-layer space-truss roof',
    'A square-on-square offset grid, 10 m × 10 m and 1.2 m deep, resting on its top-chord ' +
      'perimeter nodes with a 12 kN load at every top node.',
    (b) => {
      b.custom(TUBE);
      const bays = 5;
      const a = 2;
      const depth = 1.2;
      const top: string[][] = [];
      for (let i = 0; i <= bays; i++) {
        top.push([]);
        for (let j = 0; j <= bays; j++) top[i].push(b.node(i * a, depth, j * a));
      }
      const bottom: string[][] = [];
      for (let i = 0; i < bays; i++) {
        bottom.push([]);
        for (let j = 0; j < bays; j++) bottom[i].push(b.node((i + 0.5) * a, 0, (j + 0.5) * a));
      }
      for (let i = 0; i <= bays; i++) {
        for (let j = 0; j <= bays; j++) {
          if (i < bays) b.truss(top[i][j], top[i + 1][j], TUBE.name);
          if (j < bays) b.truss(top[i][j], top[i][j + 1], TUBE.name);
        }
      }
      for (let i = 0; i < bays; i++) {
        for (let j = 0; j < bays; j++) {
          if (i < bays - 1) b.truss(bottom[i][j], bottom[i + 1][j], TUBE.name);
          if (j < bays - 1) b.truss(bottom[i][j], bottom[i][j + 1], TUBE.name);
          for (const [di, dj] of [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ]) {
            b.truss(bottom[i][j], top[i + di][j + dj], TUBE.name);
          }
        }
      }
      const edge = top.flatMap((row, i) =>
        row.filter((_, j) => i === 0 || i === bays || j === 0 || j === bays),
      );
      b.support(edge, PINNED_SUPPORT);
      b.nodal(top.flat(), [0, -12, 0]);
    },
  );

const buildingFrame = () =>
  buildProject3D(
    'Three-storey building frame',
    'A 2 × 2 bay, three-storey steel frame with box columns on fixed bases: 20 kN/m on ' +
      'every beam plus wind loads along X and Z at each floor.',
    (b) => {
      b.custom(BOX);
      const f = b.frame({
        baysX: 2,
        baysZ: 2,
        storeys: 3,
        bayWidthX: 6,
        bayWidthZ: 5,
        storeyHeight: 3.5,
        columnSection: BOX.name,
        beamSection: 'ISMB 400',
        material: STEEL,
        fixedBases: true,
      });
      b.udl([...f.beamsX, ...f.beamsZ], 20);
      const windX = [15, 25, 20];
      const windZ = [8, 12, 10];
      for (let level = 1; level <= 3; level++) {
        // Wind along +X on the x = 0 face and along +Z on the z = 0 face.
        b.nodal(f.grid[level][0], [windX[level - 1], 0, 0]);
        b.nodal(
          f.grid[level].map((row) => row[0]),
          [0, 0, windZ[level - 1]],
        );
      }
    },
  );

const hingedGrillage = () =>
  buildProject3D(
    'Portal frames with a pin-ended secondary beam',
    'Two fixed-base portals 5 m apart, tied at the eaves; a secondary beam with released ' +
      'end moments spans between the rafters and carries an off-centre 60 kN point load.',
    (b) => {
      const portal = (z: number) => {
        const base1 = b.node(0, 0, z);
        const eave1 = b.node(0, 4, z);
        const mid = b.node(3, 4, z);
        const eave2 = b.node(6, 4, z);
        const base2 = b.node(6, 0, z);
        b.beam(base1, eave1, 'ISMB 350');
        b.beam(eave1, mid, 'ISMB 400');
        b.beam(mid, eave2, 'ISMB 400');
        b.beam(base2, eave2, 'ISMB 350');
        b.support([base1, base2], FIXED_SUPPORT);
        return { eave1, mid, eave2 };
      };
      const front = portal(0);
      const back = portal(5);
      b.beam(front.eave1, back.eave1, 'ISMB 250');
      b.beam(front.eave2, back.eave2, 'ISMB 250');
      // Bending moments released at both ends: the secondary beam is simply supported.
      const pins = { my: true, mz: true };
      const secondary = b.beam(front.mid, back.mid, 'ISMB 300', {
        releaseI: pins,
        releaseJ: pins,
      });
      b.point(secondary, 60, 2);
      b.udl(secondary, 6);
      b.nodal([front.eave1, back.eave1], [12, 0, 0]);
    },
  );

const bracedFrame = () =>
  buildProject3D(
    'Braced tower frame',
    'A single-bay, three-storey frame on pinned bases, stabilised by diagonal truss ' +
      'bracing in all four faces, under floor loads and wind in both directions.',
    (b) => {
      b.custom(BOX);
      const storeys = 3;
      const f = b.frame({
        baysX: 1,
        baysZ: 1,
        storeys,
        bayWidthX: 5,
        bayWidthZ: 5,
        storeyHeight: 3.5,
        columnSection: BOX.name,
        beamSection: 'ISMB 300',
        material: STEEL,
        fixedBases: false,
      });
      for (let level = 0; level < storeys; level++) {
        const lower = f.grid[level];
        const upper = f.grid[level + 1];
        // One diagonal per face, alternating direction from storey to storey.
        const flip = level % 2;
        b.truss(lower[flip][0], upper[1 - flip][0], 'ISMC 150');
        b.truss(lower[flip][1], upper[1 - flip][1], 'ISMC 150');
        b.truss(lower[0][flip], upper[0][1 - flip], 'ISMC 150');
        b.truss(lower[1][flip], upper[1][1 - flip], 'ISMC 150');
      }
      b.udl([...f.beamsX, ...f.beamsZ], 15);
      for (let level = 1; level <= storeys; level++) {
        b.nodal(f.grid[level][0], [20, 0, 0]);
        b.nodal([f.grid[level][0][0], f.grid[level][1][0]], [0, 0, 12]);
      }
    },
  );

/** Only the vertical translation held: a simple (knife-edge) slab support. */
const VERTICAL_ONLY: Restraints6 = [false, true, false, false, false, false];

const simplySupportedSlab = () =>
  buildProject3D(
    'Simply supported slab',
    'A 5 m × 5 m, 180 mm concrete slab simply supported on all four edges under a uniform ' +
      '10 kN/m² pressure, meshed with 10 × 10 plates.',
    (b) => {
      const n = 10;
      const a = 5;
      // Corners ordered so that the plate normal (local z) points up.
      const slab = b.mesh({
        corners: [
          [0, 0, 0],
          [0, 0, a],
          [a, 0, a],
          [a, 0, 0],
        ],
        nx: n,
        ny: n,
        thickness: 180,
        material: CONCRETE,
      });
      const edge = slab.grid.flatMap((row, i) =>
        row.filter((_, j) => i === 0 || i === n || j === 0 || j === n),
      );
      b.support(edge, VERTICAL_ONLY);
      // Just enough in-plane restraint to stop the slab sliding or spinning.
      b.support(slab.grid[0][0], PINNED_SUPPORT);
      b.support(slab.grid[0][n], [false, true, true, false, false, false]);
      b.pressure(slab.plates, 10);
    },
  );

const slabOnBeams = () =>
  buildProject3D(
    'Slab on beams and columns',
    'A 6 m × 4 m, 150 mm concrete slab cast on steel edge beams that frame into four ' +
      'fixed-base columns; self-weight plus 8 kN/m² on the slab.',
    (b) => {
      const nx = 6;
      const nz = 4;
      const height = 3;
      const slab = b.mesh({
        corners: [
          [0, height, 0],
          [0, height, 4],
          [6, height, 4],
          [6, height, 0],
        ],
        nx: nz,
        ny: nx,
        thickness: 150,
        material: CONCRETE,
      });
      // grid[i][j]: i runs along Z (0…nz), j along X (0…nx).
      const g = slab.grid;
      const opts = { material: STEEL };
      for (let j = 0; j < nx; j++) {
        b.beam(g[0][j], g[0][j + 1], 'ISMB 300', opts);
        b.beam(g[nz][j], g[nz][j + 1], 'ISMB 300', opts);
      }
      for (let i = 0; i < nz; i++) {
        b.beam(g[i][0], g[i + 1][0], 'ISMB 300', opts);
        b.beam(g[i][nx], g[i + 1][nx], 'ISMB 300', opts);
      }
      for (const top of [g[0][0], g[0][nx], g[nz][nx], g[nz][0]]) {
        const p = b.project().nodes.find((node) => node.id === top);
        if (!p) continue;
        const base = b.node(p.x, 0, p.z);
        b.beam(base, top, 'ISMB 300', opts);
        b.support(base, FIXED_SUPPORT);
      }
      b.pressure(slab.plates, 8);
      b.selfWeight();
    },
  );

const solidCantilever = () =>
  buildProject3D(
    'Solid cantilever block',
    'A 2 m long, 0.3 m × 0.4 m concrete cantilever modelled with 8-node solids, built in ' +
      'at one end and loaded by a 50 kN/m² pressure on its top face.',
    (b) => {
      const block = b.block({
        origin: [0, 0, 0],
        size: [2, 0.4, 0.3],
        divisions: [12, 4, 2],
        material: CONCRETE,
      });
      b.support(block.boundary.xMin.nodes, PINNED_SUPPORT);
      b.face(block.boundary.yMax.solids, block.boundary.yMax.face, 50);
    },
  );

const footing = () =>
  buildProject3D(
    'Pad footing under a column',
    'A 2 m × 2 m × 0.6 m concrete pad modelled with solids on a rigid base. A 3 m concrete ' +
      'column, embedded to mid-depth for moment fixity, brings down 400 kN and a 20 kN shear.',
    (b) => {
      b.custom(RC_COLUMN);
      const pad = b.block({
        origin: [-1, -0.6, -1],
        size: [2, 0.6, 2],
        divisions: [4, 2, 4],
        material: CONCRETE,
      });
      b.support(pad.boundary.yMin.nodes, PINNED_SUPPORT);
      const top = b.node(0, 3, 0);
      const opts = { material: CONCRETE };
      // Solid nodes have no rotational stiffness, so the column gets its fixity from the
      // couple between the two nodes it is embedded through.
      b.beam(pad.grid[2][1][2], pad.grid[2][2][2], RC_COLUMN.name, opts);
      b.beam(pad.grid[2][2][2], top, RC_COLUMN.name, opts);
      // Nothing in the model resists the column spinning about its own axis; the
      // superstructure does, so the top is held against twist only.
      b.support(top, [false, false, false, false, true, false]);
      b.nodal(top, [20, -400, 0]);
    },
  );

export const EXAMPLES_3D: Example3D[] = [
  {
    id: 'building-frame',
    name: 'Building frame',
    category: 'Frames',
    summary: '2 × 2 bays, three storeys, floor loads and wind.',
    build: buildingFrame,
  },
  {
    id: 'braced-frame',
    name: 'Braced frame',
    category: 'Frames',
    summary: 'Pinned-base frame stabilised by truss bracing.',
    build: bracedFrame,
  },
  {
    id: 'hinged-secondary-beam',
    name: 'Portals with a pinned beam',
    category: 'Frames',
    summary: 'Member point load and released end moments.',
    build: hingedGrillage,
  },
  {
    id: 'tower-25-bar',
    name: '25-bar tower',
    category: 'Trusses',
    summary: 'The classic 25-bar space-truss tower.',
    build: towerTruss,
  },
  {
    id: 'space-truss-roof',
    name: 'Space-truss roof',
    category: 'Trusses',
    summary: 'Double-layer square-on-square offset grid.',
    build: spaceTrussRoof,
  },
  {
    id: 'simply-supported-slab',
    name: 'Simply supported slab',
    category: 'Plates',
    summary: 'Square slab under uniform pressure, 10 × 10 mesh.',
    build: simplySupportedSlab,
  },
  {
    id: 'solid-cantilever',
    name: 'Solid cantilever',
    category: 'Solids',
    summary: 'Cantilever block of solids under face pressure.',
    build: solidCantilever,
  },
  {
    id: 'slab-on-beams',
    name: 'Slab on beams and columns',
    category: 'Mixed',
    summary: 'Plates, edge beams and columns with self-weight.',
    build: slabOnBeams,
  },
  {
    id: 'pad-footing',
    name: 'Pad footing and column',
    category: 'Mixed',
    summary: 'Solid footing loaded through an embedded column.',
    build: footing,
  },
  // The 2D example library, converted to plane-frame projects.
  ...EXAMPLES.map((e): Example3D => ({
    id: `plane-${e.id}`,
    name: e.name,
    category: PLANE_CATEGORY,
    summary: e.summary,
    build: () => from2D(e.build()),
  })),
];

export function getExample3D(id: string): Example3D | undefined {
  return EXAMPLES_3D.find((e) => e.id === id);
}
