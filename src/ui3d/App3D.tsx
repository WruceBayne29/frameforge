import { useCallback, useEffect, useRef, useState } from 'react';
import { EXAMPLES_3D } from '../examples3d';
import { parseProject3DText, serializeProject3D } from '../io/projectFile3d';
import { decodeProject3D, payloadFromHash3D } from '../io/share3d';
import type { FieldKind, Project3D } from '../model3d';
import { readStored, writeStored } from '../ui/storage';
import { useTheme } from '../ui/theme';
import { notify, Toasts } from '../ui/toast';
import { FIELDS_3D, mm } from './format3d';
import { Help3D } from './Help3D';
import { SidePanel3D } from './SidePanel3D';
import { deleteSelection, StoreProvider3D, useStore3D } from './store';
import type { Tool3D, ViewOptions3D } from './store';
import { Toolbar3D } from './Toolbar3D';
import { TopBar3D } from './TopBar3D';
import { Viewer } from './Viewer';
import type { ViewerHandle } from './Viewer';
import { ScaleControls, ViewBar3D, ViewPresets } from './ViewBar3D';
import '../ui/styles.css';
import './styles3d.css';

export const STORAGE_KEY_3D = 'frameforge-project-3d';

/** The model from the last visit, or the first example for new visitors. */
function initialProject(): Project3D {
  const saved = readStored(STORAGE_KEY_3D);
  if (saved) {
    try {
      const project = parseProject3DText(saved);
      if (project.nodes.length > 0) return project;
    } catch {
      // Fall through to the default example.
    }
  }
  return EXAMPLES_3D[0].build();
}

/** Opens `#s=` share links and keeps the model in local storage. */
function Persistence3D() {
  const { state, dispatch } = useStore3D();
  useEffect(() => {
    const load = () => {
      const payload = payloadFromHash3D(window.location.hash);
      if (!payload) return;
      decodeProject3D(payload)
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
    const timer = window.setTimeout(
      () => writeStored(STORAGE_KEY_3D, serializeProject3D(state.project)),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [state.project]);
  const latest = useRef(state.project);
  useEffect(() => {
    latest.current = state.project;
  }, [state.project]);
  useEffect(() => () => writeStored(STORAGE_KEY_3D, serializeProject3D(latest.current)), []);
  return null;
}

function StatusBar3D() {
  const { state, solution } = useStore3D();
  const p = state.project;
  const r = solution.result;
  return (
    <footer className="statusbar">
      <span>
        {p.nodes.length} nodes · {p.members.length} members · {p.plates.length} plates ·{' '}
        {p.solids.length} solids · {p.loads.length} loads
      </span>
      {r && (
        <span>
          {r.dofCount} equations · max deflection {mm(r.maxDisplacement)} mm
        </span>
      )}
      {solution.pending && <span>Analysing…</span>}
      <span className="spacer" />
      <span>Units: kN · m · MPa</span>
    </footer>
  );
}

const TOOL_KEYS: Record<string, Tool3D> = {
  v: 'select',
  n: 'node',
  m: 'member',
  p: 'plate',
  s: 'support',
  l: 'load',
  x: 'delete',
};
const DIAGRAM_KEYS: Record<string, ViewOptions3D['diagram']> = {
  '0': 'none',
  '1': 'N',
  '2': 'Vy',
  '3': 'Vz',
  '4': 'T',
  '5': 'My',
  '6': 'Mz',
};

/** Contour plots that make sense for the model, in menu order. */
function contourCycle(project: Project3D): Array<'none' | FieldKind> {
  const groups = new Set<string>();
  if (project.plates.length + project.solids.length > 0) groups.add('All');
  if (project.plates.length > 0) groups.add('Plates');
  if (project.solids.length > 0) groups.add('Solids');
  return ['none', ...FIELDS_3D.filter((f) => groups.has(f.group)).map((f) => f.id)];
}

function Shortcuts3D({ onHelp }: { onHelp: () => void }) {
  const { state, dispatch } = useStore3D();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (document.querySelector('.modal')) return;
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
        if (!state.selection) return;
        e.preventDefault();
        dispatch({
          type: 'edit',
          project: deleteSelection(state.project, state.selection),
          selection: null,
        });
        return;
      }
      if (key === 'escape') {
        if (state.pending.length > 0) dispatch({ type: 'pending', pending: [] });
        else {
          dispatch({ type: 'tool', tool: 'select' });
          dispatch({ type: 'select', selection: null });
        }
        return;
      }
      const view = state.view;
      if (key === '?') onHelp();
      else if (TOOL_KEYS[key]) dispatch({ type: 'tool', tool: TOOL_KEYS[key] });
      else if (DIAGRAM_KEYS[key]) dispatch({ type: 'view', view: { diagram: DIAGRAM_KEYS[key] } });
      else if (key === 'd') dispatch({ type: 'view', view: { deformed: !view.deformed } });
      else if (key === 'r') dispatch({ type: 'view', view: { reactions: !view.reactions } });
      else if (key === 'f') dispatch({ type: 'camera', preset: 'fit' });
      else if (key === 'g')
        dispatch({ type: 'toolOptions', options: { snap: !state.toolOptions.snap } });
      else if (key === 'c') {
        const cycle = contourCycle(state.project);
        const next = cycle[(cycle.indexOf(view.contour) + 1) % cycle.length];
        dispatch({ type: 'view', view: { contour: next } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, dispatch, onHelp]);
  return null;
}

function Stage3D() {
  const { state, solution } = useStore3D();
  const viewer = useRef<ViewerHandle>(null);
  const empty = state.project.nodes.length === 0;
  const saveImage = () => {
    const url = viewer.current?.capture();
    if (!url) {
      notify('Could not capture the view.', 'error');
      return;
    }
    const link = document.createElement('a');
    link.href = url;
    link.download = 'frameforge-3d.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  return (
    <section className="stage">
      <ViewBar3D onImage={saveImage} />
      <div className="canvas-wrap">
        <Viewer ref={viewer} />
        <ViewPresets />
        {!empty && <ScaleControls />}
        {empty && (
          <div className="empty-hint">
            <strong>Empty model</strong>
            <span>
              Press <kbd>N</kbd> to add nodes, <kbd>M</kbd> to draw members, use the Generate tab,
              or pick a structure from <em>Examples</em>.
            </span>
          </div>
        )}
        {solution.error && (
          <div className="error-banner" role="alert">
            <strong>Cannot analyse this structure.</strong> {solution.error.message}
            {solution.error.nodeId && <> (node {solution.error.nodeId})</>}
            {solution.error.elementId && <> (element {solution.error.elementId})</>}
          </div>
        )}
      </div>
    </section>
  );
}

export default function App3D({ incoming }: { incoming?: Project3D }) {
  const [theme, toggleTheme] = useTheme();
  const [help, setHelp] = useState(false);
  const [initial] = useState(() => incoming ?? initialProject());
  const openHelp = useCallback(() => setHelp(true), []);
  return (
    <StoreProvider3D initial={initial}>
      <div className="app app3d">
        <TopBar3D theme={theme} onToggleTheme={toggleTheme} onHelp={openHelp} />
        <Shortcuts3D onHelp={openHelp} />
        <Persistence3D />
        <div className="main">
          <Toolbar3D />
          <Stage3D />
          <SidePanel3D />
        </div>
        <StatusBar3D />
        <Toasts />
        {help && <Help3D onClose={() => setHelp(false)} />}
      </div>
    </StoreProvider3D>
  );
}
