/**
 * State of the 3D workspace and its reducer. Pure (no React), so it is unit-tested directly.
 */
import {
  addLoad,
  deleteLoad,
  deleteMember,
  deleteNode,
  deletePlate,
  deleteSolid,
  DEFAULT_PLATE_THICKNESS,
  DEFAULT_SECTION_3D,
  FIXED_SUPPORT,
  PINNED_SUPPORT,
  ROLLER_SUPPORT,
  setSupport,
  toSolverModel3D,
} from '../model3d';
import type {
  DiagramKind3D,
  FieldKind,
  GlobalDirection,
  MemberType3D,
  NewLoad3D,
  Project3D,
  Restraints6,
  SolidFace,
} from '../model3d';
import { analyze3d, SolverError } from '../solver3d';
import type { AnalysisResult3D } from '../solver3d';

export type Tool3D = 'select' | 'node' | 'member' | 'plate' | 'support' | 'load' | 'delete';
export type SelectionKind = 'node' | 'member' | 'plate' | 'solid' | 'load';

export interface Selection3D {
  kind: SelectionKind;
  ids: string[];
}

/** One thing under the pointer. */
export interface Pick3D {
  kind: SelectionKind;
  id: string;
}

export type SupportPreset = 'fixed' | 'pinned' | 'roller' | 'custom' | 'none';
export type LoadToolKind = 'nodal' | 'distributed' | 'point' | 'pressure' | 'face';
export type CameraPreset = 'iso' | 'top' | 'front' | 'side' | 'fit';

export interface ViewOptions3D {
  diagram: 'none' | DiagramKind3D;
  contour: 'none' | FieldKind;
  deformed: boolean;
  reactions: boolean;
  loads: boolean;
  supports: boolean;
  labels: boolean;
  grid: boolean;
  /** Multipliers applied on top of the automatic scales. */
  deformScale: number;
  diagramScale: number;
}

export interface ToolOptions3D {
  snap: boolean;
  /** Snap spacing on the working plane, m. */
  grid: number;
  /** Height (global Y) of the horizontal working plane new nodes are placed on, m. */
  elevation: number;
  memberType: MemberType3D;
  section: string;
  /** Plate thickness for the plate tool, mm. */
  thickness: number;
  supportPreset: SupportPreset;
  /** Restraints used by the "custom" support preset. */
  restraints: Restraints6;
  loadKind: LoadToolKind;
  /** kN, kN/m or kN/m² depending on the kind; positive acts along the + axis. */
  loadValue: number;
  loadDirection: GlobalDirection;
  /** Face used by solid face loads. */
  loadFace: SolidFace;
}

export interface AppState3D {
  project: Project3D;
  past: Project3D[];
  future: Project3D[];
  selection: Selection3D | null;
  tool: Tool3D;
  /** Nodes clicked so far by the member / plate tool. */
  pending: string[];
  toolOptions: ToolOptions3D;
  view: ViewOptions3D;
  /** Latest camera request; `count` changes whenever the viewer should act on it. */
  camera: { preset: CameraPreset; count: number };
}

export type Action3D =
  | { type: 'load'; project: Project3D }
  | { type: 'edit'; project: Project3D; selection?: Selection3D | null; pending?: string[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; selection: Selection3D | null }
  | { type: 'pick'; pick: Pick3D | null; additive: boolean }
  | { type: 'tool'; tool: Tool3D }
  | { type: 'pending'; pending: string[] }
  | { type: 'toolOptions'; options: Partial<ToolOptions3D> }
  | { type: 'view'; view: Partial<ViewOptions3D> }
  | { type: 'camera'; preset: CameraPreset };

export const HISTORY_LIMIT = 100;

export const DEFAULT_VIEW_3D: ViewOptions3D = {
  diagram: 'Mz',
  contour: 'none',
  deformed: true,
  reactions: true,
  loads: true,
  supports: true,
  labels: true,
  grid: true,
  deformScale: 1,
  diagramScale: 1,
};

export const DEFAULT_TOOL_OPTIONS_3D: ToolOptions3D = {
  snap: true,
  grid: 0.5,
  elevation: 0,
  memberType: 'beam',
  section: DEFAULT_SECTION_3D,
  thickness: DEFAULT_PLATE_THICKNESS,
  supportPreset: 'fixed',
  restraints: [true, true, true, false, false, false],
  loadKind: 'nodal',
  loadValue: -10,
  loadDirection: 'globalY',
  loadFace: 2,
};

/** View defaults that suit a model: what to plot depends on what it is made of. */
export function viewFor(project: Project3D, current: ViewOptions3D): ViewOptions3D {
  const { members, plates, solids } = project;
  const allTruss = members.length > 0 && members.every((m) => m.type === 'truss');
  const elements = members.length + plates.length + solids.length;
  return {
    ...current,
    diagram: members.length === 0 ? 'none' : allTruss ? 'N' : 'Mz',
    contour:
      plates.length > 0 ? 'plateVonMisesTop' : solids.length > 0 ? 'solidVonMises' : 'none',
    labels: elements <= 40 && project.nodes.length <= 40,
  };
}

export function initialState3D(project: Project3D): AppState3D {
  return {
    project,
    past: [],
    future: [],
    selection: null,
    tool: 'select',
    pending: [],
    toolOptions: DEFAULT_TOOL_OPTIONS_3D,
    view: viewFor(project, DEFAULT_VIEW_3D),
    camera: { preset: 'iso', count: 0 },
  };
}

function idsOf(project: Project3D, kind: SelectionKind): Array<{ id: string }> {
  switch (kind) {
    case 'node':
      return project.nodes;
    case 'member':
      return project.members;
    case 'plate':
      return project.plates;
    case 'solid':
      return project.solids;
    case 'load':
      return project.loads;
  }
}

/** Drops selected ids that no longer exist in the project. */
export function validSelection(
  project: Project3D,
  selection: Selection3D | null,
): Selection3D | null {
  if (!selection) return null;
  const known = new Set(idsOf(project, selection.kind).map((item) => item.id));
  const ids = selection.ids.filter((id) => known.has(id));
  if (ids.length === selection.ids.length) return selection.ids.length > 0 ? selection : null;
  return ids.length > 0 ? { kind: selection.kind, ids } : null;
}

/**
 * Selection after clicking something. A plain click selects just that item (or nothing when
 * the click hit empty space). An additive (shift) click toggles the item in a selection of
 * the same kind, starts a new selection for another kind and keeps the selection on a miss.
 */
export function pickSelection(
  current: Selection3D | null,
  pick: Pick3D | null,
  additive: boolean,
): Selection3D | null {
  if (!pick) return additive ? current : null;
  if (!additive || !current || current.kind !== pick.kind) {
    return { kind: pick.kind, ids: [pick.id] };
  }
  const ids = current.ids.includes(pick.id)
    ? current.ids.filter((id) => id !== pick.id)
    : [...current.ids, pick.id];
  return ids.length > 0 ? { kind: pick.kind, ids } : null;
}

export function isSelected(selection: Selection3D | null, kind: SelectionKind, id: string) {
  return !!selection && selection.kind === kind && selection.ids.includes(id);
}

/** Every item of one kind, as a selection. */
export function selectAll(project: Project3D, kind: SelectionKind): Selection3D | null {
  const ids = idsOf(project, kind).map((item) => item.id);
  return ids.length > 0 ? { kind, ids } : null;
}

/** Deletes everything in the selection. */
export function deleteSelection(project: Project3D, selection: Selection3D | null): Project3D {
  if (!selection) return project;
  const remove = {
    node: deleteNode,
    member: deleteMember,
    plate: deletePlate,
    solid: deleteSolid,
    load: deleteLoad,
  }[selection.kind];
  return selection.ids.reduce((p, id) => remove(p, id), project);
}

export function restraintsForPreset(
  preset: SupportPreset,
  custom: Restraints6,
): Restraints6 | null {
  switch (preset) {
    case 'fixed':
      return [...FIXED_SUPPORT];
    case 'pinned':
      return [...PINNED_SUPPORT];
    case 'roller':
      return [...ROLLER_SUPPORT];
    case 'custom':
      return [...custom];
    case 'none':
      return null;
  }
}

/** Which support preset a set of restraints is, for display. */
export function presetOf(restraints: Restraints6 | undefined): SupportPreset {
  if (!restraints || !restraints.some(Boolean)) return 'none';
  const same = (other: Restraints6) => other.every((v, k) => v === restraints[k]);
  if (same(FIXED_SUPPORT)) return 'fixed';
  if (same(PINNED_SUPPORT)) return 'pinned';
  if (same(ROLLER_SUPPORT)) return 'roller';
  return 'custom';
}

/** Applies the support tool to nodes: sets the preset, or removes supports for "none". */
export function applySupport(
  project: Project3D,
  nodes: readonly string[],
  options: Pick<ToolOptions3D, 'supportPreset' | 'restraints'>,
): Project3D {
  const restraints = restraintsForPreset(options.supportPreset, options.restraints);
  return nodes.reduce((p, node) => setSupport(p, node, restraints), project);
}

/** The kind of element a load-tool kind is applied to. */
export const LOAD_TOOL_TARGET: Record<LoadToolKind, SelectionKind> = {
  nodal: 'node',
  distributed: 'member',
  point: 'member',
  pressure: 'plate',
  face: 'solid',
};

export const LOAD_TOOL_UNIT: Record<LoadToolKind, string> = {
  nodal: 'kN',
  distributed: 'kN/m',
  point: 'kN',
  pressure: 'kN/m²',
  face: 'kN/m²',
};

/** The load the load tool would put on the given targets, or null when the kind mismatches. */
export function toolLoad(
  project: Project3D,
  options: Pick<ToolOptions3D, 'loadKind' | 'loadValue' | 'loadDirection' | 'loadFace'>,
  kind: SelectionKind,
  ids: string[],
): NewLoad3D | null {
  if (ids.length === 0 || LOAD_TOOL_TARGET[options.loadKind] !== kind) return null;
  const { loadValue: value, loadDirection: direction } = options;
  switch (options.loadKind) {
    case 'nodal':
      return {
        kind: 'nodal',
        nodes: ids,
        fx: direction === 'globalX' ? value : 0,
        fy: direction === 'globalY' ? value : 0,
        fz: direction === 'globalZ' ? value : 0,
        mx: 0,
        my: 0,
        mz: 0,
      };
    case 'distributed':
      return { kind: 'distributed', members: ids, direction, w1: value };
    case 'point': {
      // Mid-span of the first member; edit the position afterwards in Properties.
      const member = project.members.find((m) => m.id === ids[0]);
      const a = project.nodes.find((n) => n.id === member?.i);
      const b = project.nodes.find((n) => n.id === member?.j);
      const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0;
      return { kind: 'point', members: ids, direction, P: value, a: length / 2 };
    }
    case 'pressure':
      return { kind: 'pressure', plates: ids, direction, p: value };
    case 'face':
      return { kind: 'face', solids: ids, face: options.loadFace, direction, p: value };
  }
}

/** Adds the load tool's load to the targets; returns null when nothing can be added. */
export function applyToolLoad(
  project: Project3D,
  options: ToolOptions3D,
  kind: SelectionKind,
  ids: string[],
): { project: Project3D; id: string } | null {
  const load = toolLoad(project, options, kind, ids);
  return load ? addLoad(project, load) : null;
}

export function reducer3D(state: AppState3D, action: Action3D): AppState3D {
  switch (action.type) {
    case 'load':
      return {
        ...state,
        project: action.project,
        // Loading is undoable, so opening an example never destroys unsaved work.
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: [],
        selection: null,
        pending: [],
        tool: 'select',
        view: viewFor(action.project, state.view),
        camera: { preset: 'iso', count: state.camera.count + 1 },
      };
    case 'edit': {
      if (action.project === state.project) {
        if (action.selection === undefined && action.pending === undefined) return state;
        return {
          ...state,
          selection:
            action.selection === undefined
              ? state.selection
              : validSelection(state.project, action.selection),
          pending: action.pending ?? state.pending,
        };
      }
      const selection = action.selection === undefined ? state.selection : action.selection;
      const nodes = new Set(action.project.nodes.map((n) => n.id));
      return {
        ...state,
        project: action.project,
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: [],
        selection: validSelection(action.project, selection),
        pending: (action.pending ?? state.pending).filter((id) => nodes.has(id)),
      };
    }
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state,
        project: previous,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future],
        selection: validSelection(previous, state.selection),
        pending: [],
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        project: next,
        past: [...state.past, state.project],
        future: state.future.slice(1),
        selection: validSelection(next, state.selection),
        pending: [],
      };
    }
    case 'select':
      return { ...state, selection: validSelection(state.project, action.selection) };
    case 'pick':
      return {
        ...state,
        selection: pickSelection(state.selection, action.pick, action.additive),
      };
    case 'tool':
      return state.tool === action.tool && state.pending.length === 0
        ? state
        : { ...state, tool: action.tool, pending: [] };
    case 'pending':
      return { ...state, pending: action.pending };
    case 'toolOptions':
      return { ...state, toolOptions: { ...state.toolOptions, ...action.options } };
    case 'view':
      return { ...state, view: { ...state.view, ...action.view } };
    case 'camera':
      return { ...state, camera: { preset: action.preset, count: state.camera.count + 1 } };
  }
}

export interface SolveError3D {
  message: string;
  nodeId?: string;
  /** Id of the member, plate or solid the solver blames, when it names one. */
  elementId?: string;
}

export interface Solution3D {
  /** The project this solution belongs to. */
  project: Project3D;
  result: AnalysisResult3D | null;
  error: SolveError3D | null;
  /** True while a large model waits to be re-analysed. */
  pending: boolean;
}

/** Rough number of equations, used to decide whether to analyse immediately. */
export function estimatedEquations(project: Project3D): number {
  const shells = project.members.some((m) => m.type === 'beam') || project.plates.length > 0;
  return project.nodes.length * (shells ? 6 : 3);
}

/** Runs the analysis; never throws. */
export function solveProject3D(project: Project3D): Solution3D {
  const empty = project.members.length + project.plates.length + project.solids.length === 0;
  if (project.nodes.length === 0 || empty) {
    return { project, result: null, error: null, pending: false };
  }
  try {
    return { project, result: analyze3d(toSolverModel3D(project)), error: null, pending: false };
  } catch (e) {
    if (e instanceof SolverError) {
      return {
        project,
        result: null,
        error: { message: e.message, nodeId: e.nodeId, elementId: e.memberId },
        pending: false,
      };
    }
    return {
      project,
      result: null,
      error: { message: e instanceof Error ? e.message : 'Unexpected error during analysis.' },
      pending: false,
    };
  }
}
