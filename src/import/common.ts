/**
 * Shared pieces of the importers (tables / CSV, STAAD.Pro, JSON): the result type, units,
 * name normalisation and the final step that runs every imported model through the same
 * validation as a saved project file (`parseProject3D`).
 */
import { getSection } from '../design-codes';
import { hasOutOfPlaneLoad } from '../model3d/analysis';
import type { MemberLoadDirection, Project3D } from '../model3d/types';
import { ProjectFormatError } from '../io/projectFile';
import { parseProject3D, serializeProject3D } from '../io/projectFile3d';

export interface ImportIssue {
  message: string;
  /** Table (CSV) or block (STAAD) the problem is in. */
  where?: string;
  /** 1-based line number in that table or file. */
  line?: number;
}

export type ImportFormat = 'json' | 'csv' | 'std';

export interface ImportResult {
  /** The imported model; null when there are errors. */
  project: Project3D | null;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** Rows / items read, by table or kind (nodes, members, …). */
  counts: Record<string, number>;
  /** Every node lies in z = 0, so plane-frame mode is an option. */
  planeSuggested: boolean;
  format: ImportFormat;
}

export type PlaneOption = 'auto' | 'XY' | 'none';

export type LengthUnit = 'm' | 'mm';
export type ForceUnit = 'kN' | 'N';
export interface Units {
  length: LengthUnit;
  force: ForceUnit;
}
export const DEFAULT_UNITS: Units = { length: 'm', force: 'kN' };

/** Metres per unit of length. */
export const LENGTH_FACTOR: Record<LengthUnit, number> = { m: 1, mm: 1e-3 };
/** Kilonewtons per unit of force. */
export const FORCE_FACTOR: Record<ForceUnit, number> = { kN: 1, N: 1e-3 };

/** One line of a problem report: "members line 4: …". */
export function issueText(issue: ImportIssue): string {
  const at = [issue.where, issue.line !== undefined ? `line ${issue.line}` : '']
    .filter(Boolean)
    .join(' ');
  return at ? `${at}: ${issue.message}` : issue.message;
}

/**
 * The built-in name of a rolled section written any common way: "ISMB300", "ismb 300",
 * "ISMB-300" → "ISMB 300". Undefined when it is not in the table.
 */
export function rolledSectionName(name: string): string | undefined {
  const m = /^\s*(ISMB|ISMC)[\s\-_]*(\d+)\s*$/i.exec(name);
  if (!m) return getSection(name.trim())?.designation;
  return getSection(`${m[1].toUpperCase()} ${Number(m[2])}`)?.designation;
}

const DIRECTIONS: Record<string, MemberLoadDirection> = {
  gx: 'globalX',
  gy: 'globalY',
  gz: 'globalZ',
  globalx: 'globalX',
  globaly: 'globalY',
  globalz: 'globalZ',
  x: 'localX',
  y: 'localY',
  z: 'localZ',
  lx: 'localX',
  ly: 'localY',
  lz: 'localZ',
  localx: 'localX',
  localy: 'localY',
  localz: 'localZ',
};

/**
 * A member-load direction: GX/GY/GZ or globalX… (global), X/Y/Z, LX… or localX… (member
 * axes, as in STAAD). Undefined when not recognised.
 */
export function memberDirection(text: string): MemberLoadDirection | undefined {
  return DIRECTIONS[
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '')
  ];
}

/**
 * Finishes an import: picks plane-frame mode, then validates the model exactly like a saved
 * file. Pushes an error (and returns null) when validation fails.
 */
export function finishProject(
  project: Project3D,
  plane: PlaneOption,
  errors: ImportIssue[],
): { project: Project3D | null; planeSuggested: boolean } {
  const flat = project.nodes.length > 0 && project.nodes.every((n) => n.z === 0);
  const lineOnly = project.plates.length + project.solids.length === 0;
  if (plane === 'XY') {
    if (!flat) errors.push({ message: 'Plane-frame mode needs every node at z = 0.' });
    else project.plane = 'XY';
  } else if (plane === 'auto' && flat && lineOnly && !hasOutOfPlaneLoad(project)) {
    project.plane = 'XY';
  } else delete project.plane;
  if (errors.length > 0) return { project: null, planeSuggested: flat };
  try {
    return {
      project: parseProject3D(JSON.parse(serializeProject3D(project))),
      planeSuggested: flat,
    };
  } catch (e) {
    errors.push({ message: e instanceof ProjectFormatError ? e.message : String(e) });
    return { project: null, planeSuggested: flat };
  }
}

/** Distinct, readable id for a generated item: base, base-2, base-3, … */
export function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let k = 2; taken.has(name); k++) name = `${base}-${k}`;
  taken.add(name);
  return name;
}
