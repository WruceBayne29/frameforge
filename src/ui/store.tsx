import { createContext, useContext, useMemo, useReducer } from 'react';
import type { Dispatch, ReactNode } from 'react';
import { designMembers, toSolverModel } from '../model';
import type { MemberDesign, Project, SupportKind } from '../model';
import { analyze, influenceLine, modalAnalysis, SolverError } from '../solver';
import type { AnalysisResult, InfluenceLine, InfluenceTarget, ModalResult } from '../solver';

export type Tool = 'select' | 'node' | 'member' | 'support' | 'load' | 'delete';
export type DiagramKind = 'none' | 'N' | 'V' | 'M';
export type LoadToolKind = 'nodal' | 'udl' | 'point';

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'member'; id: string }
  | { kind: 'load'; id: string }
  | null;

export interface ViewOptions {
  diagram: DiagramKind;
  deformed: boolean;
  reactions: boolean;
  loads: boolean;
  labels: boolean;
  utilisation: boolean;
  /** Multipliers applied on top of the automatic scales. */
  deformScale: number;
  diagramScale: number;
}

export interface ToolOptions {
  snap: boolean;
  grid: number;
  supportKind: SupportKind;
  loadKind: LoadToolKind;
  /** Magnitudes used by the load tool (kN, kN/m). Positive acts downward. */
  loadValue: number;
  memberType: 'frame' | 'truss';
  section: string;
}

/** Optional extra analyses, computed only when asked for. */
export interface AdvancedState {
  /** Natural frequencies have been requested. */
  modal: boolean;
  /** Index of the mode shape being animated, or null. */
  mode: number | null;
  /** Response whose influence line is shown, or null. */
  influence: InfluenceTarget | null;
}

export interface AppState {
  advanced: AdvancedState;
  project: Project;
  past: Project[];
  future: Project[];
  selection: Selection;
  tool: Tool;
  toolOptions: ToolOptions;
  view: ViewOptions;
  /** Incremented whenever the canvas should re-fit the model (new project, Fit button). */
  loadCount: number;
}

export type Action =
  | { type: 'load'; project: Project }
  | { type: 'edit'; project: Project; selection?: Selection }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; selection: Selection }
  | { type: 'tool'; tool: Tool }
  | { type: 'toolOptions'; options: Partial<ToolOptions> }
  | { type: 'view'; view: Partial<ViewOptions> }
  | { type: 'advanced'; advanced: Partial<AdvancedState> }
  | { type: 'fit' };

const HISTORY_LIMIT = 200;

export const DEFAULT_VIEW: ViewOptions = {
  diagram: 'M',
  deformed: true,
  reactions: true,
  loads: true,
  labels: true,
  utilisation: false,
  deformScale: 1,
  diagramScale: 1,
};

export function initialState(project: Project): AppState {
  return {
    advanced: { modal: false, mode: null, influence: null },
    project,
    past: [],
    future: [],
    selection: null,
    tool: 'select',
    toolOptions: {
      snap: true,
      grid: 0.5,
      supportKind: 'pinned',
      loadKind: 'nodal',
      loadValue: 10,
      memberType: 'frame',
      section: 'ISMB 300',
    },
    view: DEFAULT_VIEW,
    loadCount: 0,
  };
}

/** Drops a selection that refers to something no longer in the project. */
function validSelection(project: Project, selection: Selection): Selection {
  if (!selection) return null;
  const list =
    selection.kind === 'node'
      ? project.nodes
      : selection.kind === 'member'
        ? project.members
        : project.loads;
  return list.some((item) => item.id === selection.id) ? selection : null;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'load': {
      // Pick sensible view defaults for the new model: axial forces for pure trusses,
      // and no id labels on dense models where they would only add clutter.
      const members = action.project.members;
      const allTruss = members.length > 0 && members.every((m) => m.type === 'truss');
      return {
        ...state,
        project: action.project,
        // Loading is undoable, so opening an example never destroys unsaved work.
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: [],
        selection: null,
        tool: 'select',
        advanced: { modal: state.advanced.modal, mode: null, influence: null },
        view: {
          ...state.view,
          diagram: state.view.diagram === 'none' ? 'none' : allTruss ? 'N' : 'M',
          labels: members.length <= 24,
        },
        loadCount: state.loadCount + 1,
      };
    }
    case 'edit': {
      if (action.project === state.project) return state;
      const selection = action.selection === undefined ? state.selection : action.selection;
      return {
        ...state,
        project: action.project,
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: [],
        selection: validSelection(action.project, selection),
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
      };
    }
    case 'select':
      return { ...state, selection: action.selection };
    case 'tool':
      return { ...state, tool: action.tool };
    case 'toolOptions':
      return { ...state, toolOptions: { ...state.toolOptions, ...action.options } };
    case 'view':
      return { ...state, view: { ...state.view, ...action.view } };
    case 'advanced':
      return { ...state, advanced: { ...state.advanced, ...action.advanced } };
    case 'fit':
      return { ...state, loadCount: state.loadCount + 1 };
  }
}

export interface Solution {
  result: AnalysisResult | null;
  design: Record<string, MemberDesign>;
  error: { message: string; nodeId?: string; memberId?: string } | null;
}

/** Runs the analysis and design checks; never throws. */
export function solveProject(project: Project): Solution {
  if (project.nodes.length === 0 || project.members.length === 0) {
    return { result: null, design: {}, error: null };
  }
  try {
    const result = analyze(toSolverModel(project));
    return { result, design: designMembers(project, result), error: null };
  } catch (e) {
    if (e instanceof SolverError) {
      return {
        result: null,
        design: {},
        error: { message: e.message, nodeId: e.nodeId, memberId: e.memberId },
      };
    }
    return {
      result: null,
      design: {},
      error: { message: e instanceof Error ? e.message : 'Unexpected error during analysis.' },
    };
  }
}

export interface Extras {
  modal: ModalResult | null;
  modalError: string | null;
  influence: InfluenceLine | null;
  influenceError: string | null;
  /** Members the moving unit load travels along. */
  influencePath: string[];
}

/** Members a moving load would normally run along: the roughly horizontal ones. */
export function defaultLoadPath(project: Project): string[] {
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const flat = project.members.filter((m) => {
    const a = nodes.get(m.i);
    const b = nodes.get(m.j);
    if (!a || !b) return false;
    return Math.abs(b.y - a.y) <= 0.5 * Math.abs(b.x - a.x);
  });
  return (flat.length > 0 ? flat : project.members).map((m) => m.id);
}

const message = (e: unknown) => (e instanceof Error ? e.message : 'The calculation failed.');

/** Runs the optional analyses that have been switched on; never throws. */
export function solveExtras(project: Project, advanced: AdvancedState): Extras {
  const extras: Extras = {
    modal: null,
    modalError: null,
    influence: null,
    influenceError: null,
    influencePath: [],
  };
  if (project.members.length === 0) return extras;
  if (advanced.modal) {
    try {
      // Subdivide members so higher modes are captured, within a sensible problem size.
      const count = project.members.length;
      const subdivide = count <= 12 ? 6 : count <= 30 ? 3 : 1;
      extras.modal = modalAnalysis(toSolverModel(project), 6, { subdivide });
    } catch (e) {
      extras.modalError = message(e);
    }
  }
  if (advanced.influence) {
    extras.influencePath = defaultLoadPath(project);
    try {
      extras.influence = influenceLine(toSolverModel(project), advanced.influence, {
        path: extras.influencePath,
        pointsPerMember: 13,
      });
    } catch (e) {
      extras.influenceError = message(e);
    }
  }
  return extras;
}

interface StoreValue {
  state: AppState;
  dispatch: Dispatch<Action>;
  solution: Solution;
  extras: Extras;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ initial, children }: { initial: Project; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial, initialState);
  const solution = useMemo(() => solveProject(state.project), [state.project]);
  const { modal, influence } = state.advanced;
  const extras = useMemo(
    () => solveExtras(state.project, { modal, mode: null, influence }),
    [state.project, modal, influence],
  );
  const value = useMemo(() => ({ state, dispatch, solution, extras }), [state, solution, extras]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <StoreProvider>');
  return value;
}
