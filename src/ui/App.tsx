import { useCallback, useEffect, useRef, useState } from 'react';
import { EXAMPLES } from '../examples';
import { parseProjectText, serializeProject } from '../io/projectFile';
import { decodeProject, payloadFromHash } from '../io/share';
import type { Project } from '../model';
import { deleteLoad, deleteMember, deleteNode } from '../model';
import { Canvas } from './Canvas';
import { Help } from './Help';
import { SidePanel } from './SidePanel';
import { StoreProvider, useStore } from './store';
import type { DiagramKind, Tool } from './store';
import { notify, Toasts } from './toast';
import { Toolbar } from './Toolbar';
import { TopBar } from './TopBar';
import { Tour } from './Tour';
import { CanvasControls, ViewBar } from './ViewBar';
import { fmt, mm } from './format';
import { readStored as read, writeStored as write } from './storage';
import { useTheme } from './theme';
import './styles.css';

const STORAGE_KEY = 'frameforge-project';
const TOUR_KEY = 'frameforge-tour-done';

/** The model from the last visit, or the first example for new visitors. */
function initialProject(): Project {
  const saved = read(STORAGE_KEY);
  if (saved) {
    try {
      const project = parseProjectText(saved);
      if (project.nodes.length > 0) return project;
    } catch {
      // Fall through to the default example.
    }
  }
  return EXAMPLES[0].build();
}

/** Loads a model from a share link, and keeps the last model in local storage. */
function Persistence() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    const load = () => {
      const payload = payloadFromHash(window.location.hash);
      if (!payload) return;
      decodeProject(payload)
        .then((project) => {
          dispatch({ type: 'load', project });
          notify(`Opened shared model "${project.name}".`);
        })
        .catch((e: unknown) =>
          notify(e instanceof Error ? e.message : 'Could not open that link.', 'error'),
        );
    };
    load();
    window.addEventListener('hashchange', load);
    return () => window.removeEventListener('hashchange', load);
  }, [dispatch]);
  useEffect(() => {
    const timer = window.setTimeout(() => write(STORAGE_KEY, serializeProject(state.project)), 400);
    return () => window.clearTimeout(timer);
  }, [state.project]);
  // Save straight away when leaving for the 3D workspace, so no recent edit is lost.
  const latest = useRef(state.project);
  useEffect(() => {
    latest.current = state.project;
  }, [state.project]);
  useEffect(() => () => write(STORAGE_KEY, serializeProject(latest.current)), []);
  return null;
}

function StatusBar() {
  const { state, solution } = useStore();
  const { project } = state;
  const r = solution.result;
  let maxM = 0;
  if (r)
    for (const m of Object.values(r.members)) maxM = Math.max(maxM, Math.abs(m.maxAbsMoment.value));
  return (
    <footer className="statusbar">
      <span>
        {project.nodes.length} nodes · {project.members.length} members · {project.loads.length}{' '}
        loads
      </span>
      {r && (
        <span>
          {r.dofCount} DOF · max deflection {mm(r.maxDisplacement)} mm · max |M| {fmt(maxM)} kN·m
        </span>
      )}
      <span className="spacer" />
      <span>Units: kN · m · kN·m</span>
    </footer>
  );
}

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  n: 'node',
  m: 'member',
  s: 'support',
  l: 'load',
  x: 'delete',
};
const DIAGRAM_KEYS: Record<string, DiagramKind> = { '0': 'none', '1': 'N', '2': 'V', '3': 'M' };

/** Global keyboard shortcuts. Ignored while typing in a form field. */
function Shortcuts({ onHelp }: { onHelp: () => void }) {
  const { state, dispatch } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && key === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        dispatch({ type: 'redo' });
        return;
      }
      if (mod || e.altKey) return;
      if (key === 'delete' || key === 'backspace') {
        const sel = state.selection;
        if (!sel) return;
        e.preventDefault();
        const p = state.project;
        const next =
          sel.kind === 'node'
            ? deleteNode(p, sel.id)
            : sel.kind === 'member'
              ? deleteMember(p, sel.id)
              : deleteLoad(p, sel.id);
        dispatch({ type: 'edit', project: next, selection: null });
        return;
      }
      if (key === 'escape') {
        dispatch({ type: 'tool', tool: 'select' });
        dispatch({ type: 'select', selection: null });
        return;
      }
      if (key === '?') onHelp();
      else if (TOOL_KEYS[key]) dispatch({ type: 'tool', tool: TOOL_KEYS[key] });
      else if (DIAGRAM_KEYS[key]) dispatch({ type: 'view', view: { diagram: DIAGRAM_KEYS[key] } });
      else if (key === 'd') dispatch({ type: 'view', view: { deformed: !state.view.deformed } });
      else if (key === 'r') dispatch({ type: 'view', view: { reactions: !state.view.reactions } });
      else if (key === 'u')
        dispatch({ type: 'view', view: { utilisation: !state.view.utilisation } });
      else if (key === 'f') dispatch({ type: 'fit' });
      else if (key === 'g')
        dispatch({ type: 'toolOptions', options: { snap: !state.toolOptions.snap } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, dispatch, onHelp]);
  return null;
}

function Stage() {
  const { state, solution } = useStore();
  const empty = state.project.nodes.length === 0;
  return (
    <section className="stage">
      <ViewBar />
      <div className="canvas-wrap">
        <Canvas />
        {!empty && <CanvasControls />}
        {empty && (
          <div className="empty-hint">
            <strong>Empty model</strong>
            <span>
              Press <kbd>M</kbd> and click on the grid to draw members, or pick a structure from{' '}
              <em>Examples</em>.
            </span>
          </div>
        )}
        {solution.error && (
          <div className="error-banner" role="alert">
            <strong>Cannot analyse this structure.</strong> {solution.error.message}
          </div>
        )}
      </div>
    </section>
  );
}

export function App({ incoming }: { incoming?: Project }) {
  const [theme, toggleTheme] = useTheme();

  const [help, setHelp] = useState(false);
  const [tour, setTour] = useState(() => read(TOUR_KEY) !== '1' && !navigator.webdriver);
  const [initial] = useState(() => incoming ?? initialProject());
  const openHelp = useCallback(() => setHelp(true), []);
  const closeTour = useCallback(() => {
    setTour(false);
    write(TOUR_KEY, '1');
  }, []);

  return (
    <StoreProvider initial={initial}>
      <div className="app">
        <TopBar theme={theme} onToggleTheme={toggleTheme} onHelp={openHelp} />
        <Shortcuts onHelp={openHelp} />
        <Persistence />
        <div className="main">
          <Toolbar />
          <Stage />
          <SidePanel />
        </div>
        <StatusBar />
        <Toasts />
        {help && (
          <Help
            onClose={() => setHelp(false)}
            onTour={() => {
              setHelp(false);
              setTour(true);
            }}
          />
        )}
        {tour && <Tour onClose={closeTour} />}
      </div>
    </StoreProvider>
  );
}
