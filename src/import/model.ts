/**
 * One entry point for every input route (file, URL, JavaScript API, command line): works out
 * whether a text is a FrameForge / interchange JSON model, a CSV bundle or a STAAD.Pro file
 * and imports it.
 */
import { openProjectText } from '../io/migrate';
import { from2D } from '../model3d/generate';
import { ProjectFormatError, parseProject } from '../io/projectFile';
import { detectProjectKind, parseProject3D } from '../io/projectFile3d';
import type { ImportFormat, ImportResult, PlaneOption, Units } from './common';
import { finishProject } from './common';
import type { StaadImportResult } from './staad';
import { importStaad, looksLikeStaad } from './staad';
import { importBundle, looksLikeBundle } from './tables';

export interface ModelImportOptions {
  /** Forces the format instead of detecting it. */
  format?: ImportFormat;
  /** File name or URL, used to detect the format from its extension. */
  filename?: string;
  /** CSV only: units of the values. */
  units?: Partial<Units>;
  /** Plane-frame choice for CSV and STAAD ('auto' / 'XY' / 'none'); JSON keeps its own. */
  plane?: PlaneOption;
  /** STAAD only: the load case to import. */
  loadCase?: number;
  name?: string;
}

/** Largest model text accepted (characters). */
export const MAX_MODEL_TEXT = 20_000_000;

/** The format of a model text, from the file name when it has a telling extension. */
export function detectFormat(text: string, filename = ''): ImportFormat | null {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(filename)?.[1]?.toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'std') return 'std';
  const t = text.trimStart();
  if (t.startsWith('{')) return 'json';
  if (looksLikeStaad(text)) return 'std';
  if (looksLikeBundle(text)) return 'csv';
  return null;
}

/**
 * Imports a FrameForge project or interchange JSON (a string or already-parsed data). Files
 * of the former 2D app are converted to plane frames, like Open does.
 */
export function importJson(input: unknown): ImportResult {
  const fail = (message: string): ImportResult => ({
    project: null,
    errors: [{ message }],
    warnings: [],
    counts: {},
    planeSuggested: false,
    format: 'json',
  });
  try {
    let project;
    let converted = false;
    if (typeof input === 'string') {
      const opened = openProjectText(input);
      project = opened.project;
      converted = opened.converted;
    } else if (detectProjectKind(input) === '2d') {
      project = from2D(parseProject(input));
      converted = true;
    } else project = parseProject3D(input);
    const errors: ImportResult['errors'] = [];
    const plane = project.plane ?? 'none';
    const finished = finishProject(project, plane, errors);
    return {
      ...finished,
      errors,
      warnings: converted ? [{ message: 'A 2D model: converted to a plane frame.' }] : [],
      counts: {
        nodes: project.nodes.length,
        members: project.members.length,
        plates: project.plates.length,
        solids: project.solids.length,
        supports: project.supports.length,
        loads: project.loads.length,
      },
      format: 'json',
    };
  } catch (e) {
    return fail(e instanceof ProjectFormatError ? e.message : 'This is not a valid model.');
  }
}

/** Imports a model text in any supported format. */
export function importModelText(
  text: string,
  options: ModelImportOptions = {},
): ImportResult | StaadImportResult {
  const format = options.format ?? detectFormat(text, options.filename);
  if (text.length > MAX_MODEL_TEXT) {
    return {
      project: null,
      errors: [{ message: 'The model is too large to import.' }],
      warnings: [],
      counts: {},
      planeSuggested: false,
      format: format ?? 'json',
    };
  }
  if (format === 'json') return importJson(text);
  if (format === 'std') return importStaad(text, options);
  if (format === 'csv') return importBundle(text, options);
  return {
    project: null,
    errors: [
      {
        message:
          'Unrecognised model format: expected FrameForge JSON, a CSV bundle starting with ' +
          '[nodes], or a STAAD.Pro file (STAAD SPACE / PLANE).',
      },
    ],
    warnings: [],
    counts: {},
    planeSuggested: false,
    format: 'json',
  };
}
