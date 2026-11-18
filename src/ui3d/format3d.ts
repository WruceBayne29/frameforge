/** Text and units for the 3D workspace. */
import type {
  DiagramKind3D,
  FieldKind,
  MemberLoadDirection,
  ProjectLoad3D,
  Restraints6,
} from '../model3d';
import type { AnalysisResult3D } from '../solver3d';
import { fmt } from './format';

export { fmt, mm } from './format';

export const DIAGRAMS_3D: Array<{ id: DiagramKind3D; label: string; title: string; unit: string }> =
  [
    { id: 'N', label: 'N', title: 'Axial force (tension positive)', unit: 'kN' },
    { id: 'Vy', label: 'Vy', title: 'Shear along local y', unit: 'kN' },
    { id: 'Vz', label: 'Vz', title: 'Shear along local z', unit: 'kN' },
    { id: 'T', label: 'T', title: 'Torsion', unit: 'kN·m' },
    { id: 'My', label: 'My', title: 'Bending about local y (minor axis)', unit: 'kN·m' },
    { id: 'Mz', label: 'Mz', title: 'Bending about local z (major axis)', unit: 'kN·m' },
  ];

export interface FieldInfo {
  id: FieldKind;
  label: string;
  /** Unit the values are shown in. */
  unit: string;
  /** Multiplier from solver units (m, kN/m², kN·m/m) to the shown unit. */
  factor: number;
  group: 'All' | 'Plates' | 'Solids';
}

export const FIELDS_3D: FieldInfo[] = [
  { id: 'displacement', label: 'Displacement', unit: 'mm', factor: 1000, group: 'All' },
  {
    id: 'plateVonMisesTop',
    label: 'von Mises, top',
    unit: 'MPa',
    factor: 1e-3,
    group: 'Plates',
  },
  {
    id: 'plateVonMisesBottom',
    label: 'von Mises, bottom',
    unit: 'MPa',
    factor: 1e-3,
    group: 'Plates',
  },
  { id: 'plateMx', label: 'Moment Mx', unit: 'kN·m/m', factor: 1, group: 'Plates' },
  { id: 'plateMy', label: 'Moment My', unit: 'kN·m/m', factor: 1, group: 'Plates' },
  { id: 'plateMxy', label: 'Moment Mxy', unit: 'kN·m/m', factor: 1, group: 'Plates' },
  { id: 'solidVonMises', label: 'von Mises', unit: 'MPa', factor: 1e-3, group: 'Solids' },
  { id: 'solidS1', label: 'Principal S1', unit: 'MPa', factor: 1e-3, group: 'Solids' },
  { id: 'solidS3', label: 'Principal S3', unit: 'MPa', factor: 1e-3, group: 'Solids' },
];

export function fieldInfo(kind: FieldKind): FieldInfo {
  return FIELDS_3D.find((f) => f.id === kind) ?? FIELDS_3D[0];
}

/** Title of a contour legend, e.g. "Plates · von Mises, top (MPa)". */
export function fieldTitle(kind: FieldKind): string {
  const info = fieldInfo(kind);
  return `${info.group === 'All' ? '' : `${info.group} · `}${info.label} (${info.unit})`;
}

/** Evenly spaced legend values from max down to min, in the shown unit. */
export function legendTicks(min: number, max: number, factor: number, count = 5): string[] {
  const ticks: string[] = [];
  for (let k = 0; k < count; k++) {
    const t = count === 1 ? 0 : k / (count - 1);
    ticks.push(fmt((max + (min - max) * t) * factor));
  }
  return ticks;
}

const DOF_NAMES = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'] as const;

/** Short description of a support: "Fixed", "Pinned", "Roller" or the restrained DOFs. */
export function restraintLabel(restraints: Restraints6): string {
  const [ux, uy, uz, rx, ry, rz] = restraints;
  if (restraints.every(Boolean)) return 'Fixed';
  if (ux && uy && uz && !rx && !ry && !rz) return 'Pinned';
  if (!ux && uy && !uz && !rx && !ry && !rz) return 'Roller';
  const held = DOF_NAMES.filter((_, k) => restraints[k]);
  return held.length > 0 ? held.join(' ') : 'Free';
}

export const DIRECTION_LABEL: Record<MemberLoadDirection, string> = {
  globalX: 'Global X',
  globalY: 'Global Y (vertical)',
  globalZ: 'Global Z',
  localX: 'Local x (along member)',
  localY: 'Local y',
  localZ: 'Local z',
};

const AXIS: Record<string, string> = {
  globalX: 'X',
  globalY: 'Y',
  globalZ: 'Z',
  localX: 'x',
  localY: 'y',
  localZ: 'z',
  normal: 'n',
};

export function loadSummary3D(load: ProjectLoad3D): string {
  switch (load.kind) {
    case 'nodal':
      return 'Nodal load';
    case 'distributed':
      return load.w2 !== undefined && load.w2 !== load.w1 ? 'Trapezoidal load' : 'Uniform load';
    case 'point':
      return 'Member point load';
    case 'moment':
      return 'Member moment';
    case 'pressure':
      return 'Plate pressure';
    case 'platePoint':
      return 'Plate point load';
    case 'face':
      return 'Solid face load';
  }
}

/** The value shown next to a load in the viewer, e.g. "12 kN/m Y". */
export function loadValueText(load: ProjectLoad3D): string {
  switch (load.kind) {
    case 'nodal': {
      const parts: string[] = [];
      const f = Math.hypot(load.fx, load.fy, load.fz);
      const m = Math.hypot(load.mx, load.my, load.mz);
      if (f > 0) parts.push(`${fmt(f)} kN`);
      if (m > 0) parts.push(`${fmt(m)} kN·m`);
      return parts.join(' + ');
    }
    case 'distributed': {
      const w2 = load.w2 ?? load.w1;
      const value = w2 === load.w1 ? fmt(load.w1) : `${fmt(load.w1)} → ${fmt(w2)}`;
      return `${value} kN/m ${AXIS[load.direction]}`;
    }
    case 'point':
      return `${fmt(load.P)} kN ${AXIS[load.direction]}`;
    case 'moment':
      return `${fmt(load.M)} kN·m ${AXIS[load.direction]}`;
    case 'pressure':
      return `${fmt(load.p)} kN/m² ${AXIS[load.direction]}`;
    case 'platePoint':
      return `${fmt(load.P)} kN ${AXIS[load.direction]}`;
    case 'face':
      return `${fmt(load.p)} kN/m² ${AXIS[load.direction]}`;
  }
}

/** "3 members", "1 node": what a list of ids is, in words. */
export function countText(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A compact list of ids for tables: "N1, N2, N3 … (12)". */
export function idList(ids: readonly string[], shown = 4): string {
  if (ids.length <= shown) return ids.join(', ');
  return `${ids.slice(0, shown).join(', ')} … (${ids.length})`;
}

/** Parses "N1, N2 N3" into ids, keeping only known ones and removing repeats. */
export function parseIdList(text: string, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const token of text.split(/[\s,;]+/)) {
    const id = token.trim();
    if (id && known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** File-name-safe version of a project name. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'frameforge-3d'
  );
}

/** Out-of-balance force as a fraction of the applied load (the equilibrium check). */
export function equilibriumError(
  result: Pick<AnalysisResult3D, 'appliedLoad' | 'equilibrium'>,
): number {
  const applied = Math.max(Math.hypot(...result.appliedLoad), 1e-9);
  const [fx, fy, fz] = result.equilibrium;
  return Math.hypot(fx, fy, fz) / applied;
}
