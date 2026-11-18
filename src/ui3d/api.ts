/**
 * The in-page JavaScript API (`window.frameforge`) and its postMessage twin, for embedding
 * FrameForge in another page and for automation. Everything goes through the same importers
 * and validation as the Import dialog. See docs/IMPORT.md.
 */
import type {
  ImportResult,
  ModelImportOptions,
  ResultsJson,
  StaadImportOptions,
  TableImportOptions,
  TableTexts,
} from '../import';
import {
  analyzeToJson,
  importBundle,
  importJson,
  importModelText,
  importStaad,
  importTables,
  issueText,
  TABLE_NAMES,
} from '../import';
import { serializeProject3D } from '../io/projectFile3d';
import type { Project3D } from '../model3d';

export const API_VERSION = 1;

export interface ImportReport {
  name: string;
  format: ImportResult['format'];
  counts: {
    nodes: number;
    members: number;
    plates: number;
    solids: number;
    supports: number;
    loads: number;
  };
  plane: boolean;
  warnings: string[];
}

/** Thrown when a model cannot be imported; `errors` lists every problem found. */
export class FrameForgeImportError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(
      `The model could not be imported: ${errors.slice(0, 5).join(' ')}${errors.length > 5 ? ' …' : ''}`,
    );
    this.name = 'FrameForgeImportError';
    this.errors = errors;
  }
}

export interface FrameForgeApi {
  version: number;
  /** Loads a FrameForge / interchange JSON model (object or JSON text). */
  load(model: unknown): ImportReport;
  /** Imports tables: `{ nodes, members, supports, nodalLoads, memberLoads, sections, materials }` (CSV text each), or the text of a CSV bundle. */
  importCsv(tables: TableTexts | string, options?: TableImportOptions): ImportReport;
  /** Imports the text of a STAAD.Pro .std file. */
  importStd(text: string, options?: StaadImportOptions): ImportReport;
  /** Imports a model text in any supported format (detected). */
  importText(text: string, options?: ModelImportOptions): ImportReport;
  /** Analyses the current model; throws when it cannot be analysed. */
  analyze(options?: { stations?: boolean }): ResultsJson;
  /** A copy of the current model in the saved-file format. */
  getModel(): Project3D;
}

export interface ApiHost {
  getProject: () => Project3D;
  setProject: (project: Project3D, report: ImportReport) => void;
}

function finish(host: ApiHost, result: ImportResult): ImportReport {
  if (!result.project) throw new FrameForgeImportError(result.errors.map(issueText));
  const p = result.project;
  const report: ImportReport = {
    name: p.name,
    format: result.format,
    counts: {
      nodes: p.nodes.length,
      members: p.members.length,
      plates: p.plates.length,
      solids: p.solids.length,
      supports: p.supports.length,
      loads: p.loads.length,
    },
    plane: p.plane === 'XY',
    warnings: result.warnings.map(issueText),
  };
  host.setProject(p, report);
  return report;
}

/** Plain-data copy of a value (drops prototypes, functions and cycles' surprises). */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function isTables(value: unknown): value is TableTexts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([k, v]) =>
      (TABLE_NAMES as readonly string[]).includes(k) && (v === undefined || typeof v === 'string'),
  );
}

export function createApi(host: ApiHost): FrameForgeApi {
  return {
    version: API_VERSION,
    load(model) {
      return finish(host, typeof model === 'string' ? importJson(model) : importJson(plain(model)));
    },
    importCsv(tables, options) {
      if (typeof tables === 'string') return finish(host, importBundle(tables, options));
      if (!isTables(tables)) {
        throw new FrameForgeImportError([
          `importCsv needs CSV text or an object with text for any of: ${TABLE_NAMES.join(', ')}.`,
        ]);
      }
      return finish(host, importTables(tables, options));
    },
    importStd(text, options) {
      if (typeof text !== 'string')
        throw new FrameForgeImportError(['importStd needs the text of a .std file.']);
      return finish(host, importStaad(text, options));
    },
    importText(text, options) {
      if (typeof text !== 'string') throw new FrameForgeImportError(['importText needs a text.']);
      return finish(host, importModelText(text, options));
    },
    analyze(options) {
      return analyzeToJson(host.getProject(), { stations: options?.stations === true });
    },
    getModel() {
      return JSON.parse(serializeProject3D(host.getProject())) as Project3D;
    },
  };
}

/** Commands accepted by postMessage, and the field that carries each one's input. */
const MESSAGE_COMMANDS = {
  load: 'model',
  importCsv: 'tables',
  importStd: 'text',
  importText: 'text',
  analyze: null,
  getModel: null,
} as const;
export type MessageCommand = keyof typeof MESSAGE_COMMANDS;

export interface ApiRequest {
  frameforge: MessageCommand;
  id?: string | number;
  model?: unknown;
  tables?: TableTexts | string;
  text?: string;
  options?: Record<string, unknown>;
}

export interface ApiReply {
  frameforge: 'result';
  id?: string | number;
  ok: boolean;
  result?: unknown;
  error?: string;
  errors?: string[];
}

/** Largest message payload accepted, in characters of its JSON. */
const MAX_MESSAGE = 20_000_000;

/** Checks that a message is a FrameForge request (anything else is ignored). */
export function parseRequest(data: unknown): ApiRequest | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.frameforge !== 'string' || !Object.hasOwn(MESSAGE_COMMANDS, d.frameforge))
    return null;
  if (d.id !== undefined && typeof d.id !== 'string' && typeof d.id !== 'number') return null;
  if (
    d.options !== undefined &&
    (typeof d.options !== 'object' || d.options === null || Array.isArray(d.options))
  ) {
    return null;
  }
  const field = MESSAGE_COMMANDS[d.frameforge as MessageCommand];
  if (field === 'text' && typeof d.text !== 'string') return null;
  if (field === 'tables' && typeof d.tables !== 'string' && !isTables(d.tables)) return null;
  if (field === 'model' && d.model === undefined) return null;
  return d as unknown as ApiRequest;
}

/**
 * Runs one postMessage request. Reading the model back (`analyze`, `getModel`) is only
 * answered after the embedding page has loaded a model itself (`canRead`), so a page that
 * frames FrameForge cannot read a model the user made or opened.
 */
export function runRequest(
  api: FrameForgeApi,
  request: ApiRequest,
  canRead: boolean,
): { reply: ApiReply; loaded: boolean } {
  const base = {
    frameforge: 'result' as const,
    ...(request.id !== undefined ? { id: request.id } : {}),
  };
  const options = (request.options ?? {}) as never;
  try {
    let result: unknown;
    switch (request.frameforge) {
      case 'load':
        result = api.load(request.model);
        break;
      case 'importCsv':
        result = api.importCsv(request.tables as TableTexts | string, options);
        break;
      case 'importStd':
        result = api.importStd(request.text as string, options);
        break;
      case 'importText':
        result = api.importText(request.text as string, options);
        break;
      case 'analyze':
      case 'getModel':
        if (!canRead) {
          return {
            reply: {
              ...base,
              ok: false,
              error: 'Load a model first: only a model sent by this page can be read back.',
            },
            loaded: false,
          };
        }
        result = request.frameforge === 'analyze' ? api.analyze(options) : api.getModel();
        break;
    }
    const loaded = request.frameforge !== 'analyze' && request.frameforge !== 'getModel';
    return { reply: { ...base, ok: true, result }, loaded };
  } catch (e) {
    const errors = e instanceof FrameForgeImportError ? e.errors : undefined;
    return {
      reply: {
        ...base,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        ...(errors ? { errors } : {}),
      },
      loaded: false,
    };
  }
}

/** True when a message is small enough to handle. */
export function withinSize(data: unknown): boolean {
  try {
    return JSON.stringify(data).length <= MAX_MESSAGE;
  } catch {
    return false;
  }
}

/** Where `?model=` may fetch from: https anywhere, or this site itself. Null when not allowed. */
export function modelUrl(param: string, page: string): URL | null {
  let url: URL;
  try {
    url = new URL(param, page);
  } catch {
    return null;
  }
  const here = new URL(page);
  if (url.protocol === 'https:' || url.origin === here.origin) return url;
  return null;
}

/** Fetches a model text for `?model=`, with messages a person can act on. */
export async function fetchModelText(
  url: URL,
  fetcher: typeof fetch = fetch,
  timeoutMs = 20000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetcher(url.href, { signal: controller.signal, credentials: 'omit' });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    const message = aborted
      ? `Fetching the model from ${url.host} took too long.`
      : `Could not fetch the model from ${url.href}. The server must allow cross-origin ` +
        'requests (CORS) from this site — raw.githubusercontent.com and GitHub Gists do; ' +
        'otherwise download the file and use Import.';
    throw new Error(message, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`The model URL returned HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > 20_000_000) throw new Error('The model at that URL is too large.');
  return text;
}

export { MESSAGE_COMMANDS };
