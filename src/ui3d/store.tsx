import { createContext, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import type { Dispatch, ReactNode } from 'react';
import type { Project3D } from '../model3d';
import { estimatedEquations, initialState3D, reducer3D, solveProject3D } from './state';
import type { Action3D, AppState3D, Solution3D } from './state';

export * from './state';

/** Models up to this many equations are analysed immediately on every edit. */
const IMMEDIATE_LIMIT = 1500;
/** Larger models wait for a pause in the editing before they are re-analysed, ms. */
const ANALYSIS_DELAY = 220;

interface StoreValue {
  state: AppState3D;
  dispatch: Dispatch<Action3D>;
  /** Solution of `state.project`; `pending` (with no result) while a large model waits. */
  solution: Solution3D;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider3D({
  initial,
  children,
}: {
  initial: Project3D;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer3D, initial, initialState3D);
  const project = state.project;
  const immediate = estimatedEquations(project) <= IMMEDIATE_LIMIT;
  const direct = useMemo(() => (immediate ? solveProject3D(project) : null), [project, immediate]);
  const [delayed, setDelayed] = useState<Solution3D | null>(null);
  useEffect(() => {
    if (immediate) return;
    const timer = window.setTimeout(() => setDelayed(solveProject3D(project)), ANALYSIS_DELAY);
    return () => window.clearTimeout(timer);
  }, [project, immediate]);
  const solution = useMemo<Solution3D>(
    () =>
      direct ??
      (delayed && delayed.project === project
        ? delayed
        : { project, result: null, error: null, pending: true }),
    [direct, delayed, project],
  );
  const value = useMemo(() => ({ state, dispatch, solution }), [state, solution]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore3D(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore3D must be used inside <StoreProvider3D>');
  return value;
}
