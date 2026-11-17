/**
 * Presentation helpers for the 3D viewer and reports: model extents, result peaks, automatic
 * scales, nodal averaging of plate / solid results into per-node scalar fields for contour
 * plots, and the contour colour map.
 */
import type { AnalysisResult3D, PlateStress, StressState } from '../solver3d/types';
import type { Project3D } from './types';

export interface Bounds3D {
  min: [number, number, number];
  max: [number, number, number];
}

export function modelBounds3D(project: Project3D): Bounds3D {
  if (project.nodes.length === 0) return { min: [-2, 0, -2], max: [10, 6, 10] };
  const min: Bounds3D['min'] = [Infinity, Infinity, Infinity];
  const max: Bounds3D['max'] = [-Infinity, -Infinity, -Infinity];
  for (const n of project.nodes) {
    const p = [n.x, n.y, n.z];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

/** Characteristic size of the model (largest extent, at least 1 m). */
export function modelSize3D(project: Project3D): number {
  const b = modelBounds3D(project);
  return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1);
}

/** Centre of the model's bounding box. */
export function modelCenter3D(project: Project3D): [number, number, number] {
  const b = modelBounds3D(project);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export interface Peaks3D {
  /** Largest absolute member forces anywhere in the structure. */
  N: number;
  Vy: number;
  Vz: number;
  T: number;
  My: number;
  Mz: number;
  /** Largest translation (nodes and along members), m. */
  displacement: number;
  /** Largest von Mises stress in any plate (either surface) / solid, kN/m². */
  plateVonMises: number;
  solidVonMises: number;
}

export function resultPeaks3D(result: AnalysisResult3D): Peaks3D {
  const peak: Peaks3D = {
    N: 0,
    Vy: 0,
    Vz: 0,
    T: 0,
    My: 0,
    Mz: 0,
    displacement: result.maxDisplacement,
    plateVonMises: 0,
    solidVonMises: 0,
  };
  for (const m of Object.values(result.members)) {
    peak.N = Math.max(peak.N, Math.abs(m.maxAxial.value), Math.abs(m.minAxial.value));
    peak.Vy = Math.max(peak.Vy, Math.abs(m.maxAbsVy.value));
    peak.Vz = Math.max(peak.Vz, Math.abs(m.maxAbsVz.value));
    peak.T = Math.max(peak.T, Math.abs(m.maxAbsTorsion.value));
    peak.My = Math.max(peak.My, Math.abs(m.maxAbsMy.value));
    peak.Mz = Math.max(peak.Mz, Math.abs(m.maxAbsMz.value));
  }
  for (const p of Object.values(result.plates)) {
    peak.plateVonMises = Math.max(peak.plateVonMises, p.maxVonMises);
  }
  for (const s of Object.values(result.solids)) {
    peak.solidVonMises = Math.max(peak.solidVonMises, s.maxVonMises);
  }
  return peak;
}

export type DiagramKind3D = 'N' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz';

export interface ResultScales3D {
  /** World metres of deformation drawn per metre of real displacement. */
  deform: number;
  /** World metres of diagram ordinate per unit of each member force. */
  diagram: Record<DiagramKind3D, number>;
}

/** Automatic scales so the largest deformation / diagram ordinate is a fixed share of the model. */
export function resultScales3D(
  project: Project3D,
  result: AnalysisResult3D,
  deformFactor = 1,
  diagramFactor = 1,
): ResultScales3D {
  const size = modelSize3D(project);
  const peak = resultPeaks3D(result);
  const unit = (p: number) => (p > 1e-9 ? (0.11 * size * diagramFactor) / p : 0);
  return {
    deform:
      result.maxDisplacement > 1e-12 ? (0.045 * size * deformFactor) / result.maxDisplacement : 0,
    diagram: {
      N: unit(peak.N),
      Vy: unit(peak.Vy),
      Vz: unit(peak.Vz),
      T: unit(peak.T),
      My: unit(peak.My),
      Mz: unit(peak.Mz),
    },
  };
}

export const FIELD_KINDS = [
  'displacement',
  'plateVonMisesTop',
  'plateVonMisesBottom',
  'plateMx',
  'plateMy',
  'plateMxy',
  'solidVonMises',
  'solidS1',
  'solidS3',
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number];

export interface NodalField {
  kind: FieldKind;
  /** Value at each node that has one (nodes not touched by a relevant element are absent). */
  values: Record<string, number>;
  /** Range of the values; both 0 when the field is empty. */
  min: number;
  max: number;
}

const PLATE_PICK: Partial<Record<FieldKind, (s: PlateStress) => number>> = {
  plateVonMisesTop: (s) => s.top.vonMises,
  plateVonMisesBottom: (s) => s.bottom.vonMises,
  plateMx: (s) => s.Mx,
  plateMy: (s) => s.My,
  plateMxy: (s) => s.Mxy,
};

const SOLID_PICK: Partial<Record<FieldKind, (s: StressState) => number>> = {
  solidVonMises: (s) => s.vonMises,
  solidS1: (s) => s.s1,
  solidS3: (s) => s.s3,
};

/**
 * A scalar value per node for contour plots.
 *  - `displacement`: magnitude of the node's translation, m.
 *  - `plate…`: the corner values of every plate meeting at the node, averaged. Moments and
 *    surfaces refer to each plate's local axes, so the average is meaningful where the plates
 *    around a node share their orientation (a flat mesh made by `plateMesh` does).
 *  - `solid…`: the corner values of every solid meeting at the node, averaged (global axes).
 */
export function nodalField(
  project: Project3D,
  result: AnalysisResult3D,
  kind: FieldKind,
): NodalField {
  const sum = new Map<string, number>();
  const hits = new Map<string, number>();
  const add = (node: string, value: number) => {
    if (!Number.isFinite(value)) return;
    sum.set(node, (sum.get(node) ?? 0) + value);
    hits.set(node, (hits.get(node) ?? 0) + 1);
  };

  const platePick = PLATE_PICK[kind];
  const solidPick = SOLID_PICK[kind];
  if (kind === 'displacement') {
    for (const node of project.nodes) {
      const d = result.displacements[node.id];
      if (d) add(node.id, Math.hypot(d.ux, d.uy, d.uz));
    }
  } else if (platePick) {
    for (const plate of project.plates) {
      const r = result.plates[plate.id];
      if (r) plate.nodes.forEach((node, k) => add(node, platePick(r.corners[k])));
    }
  } else if (solidPick) {
    for (const solid of project.solids) {
      const r = result.solids[solid.id];
      if (r) solid.nodes.forEach((node, k) => add(node, solidPick(r.corners[k])));
    }
  }

  const values: Record<string, number> = {};
  let min = Infinity;
  let max = -Infinity;
  for (const [node, total] of sum) {
    const value = total / (hits.get(node) as number);
    values[node] = value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return sum.size === 0 ? { kind, values, min: 0, max: 0 } : { kind, values, min, max };
}

/** Position of a value within a field's range, in [0, 1] (0.5 for a constant field). */
export function fieldFraction(field: Pick<NodalField, 'min' | 'max'>, value: number): number {
  const span = field.max - field.min;
  if (!(span > 0) || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, (value - field.min) / span));
}

const COLOR_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 255], // blue
  [0, 255, 255], // cyan
  [0, 255, 0], // green
  [255, 255, 0], // yellow
  [255, 0, 0], // red
];

/**
 * Contour colour for a value in [0, 1]: blue → cyan → green → yellow → red, as [r, g, b] with
 * components 0–255. Values outside the range are clamped; NaN gives a neutral grey.
 */
export function colorMap(value: number): [number, number, number] {
  if (Number.isNaN(value)) return [156, 163, 175];
  const t = Math.min(1, Math.max(0, value)) * (COLOR_STOPS.length - 1);
  const k = Math.min(Math.floor(t), COLOR_STOPS.length - 2);
  const f = t - k;
  const a = COLOR_STOPS[k];
  const b = COLOR_STOPS[k + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function colorMapCss(value: number): string {
  const [r, g, b] = colorMap(value);
  return `rgb(${r} ${g} ${b})`;
}
