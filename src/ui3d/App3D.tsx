import { useCallback, useEffect, useRef, useState } from 'react';
import { EXAMPLES_3D } from '../examples3d';
import { LEGACY_2D_PROJECT_KEY, LEGACY_WORKSPACE_KEY, openShareHash, startUp } from '../io/migrate';
import type { StartUp } from '../io/migrate';
import { serializeProject3D } from '../io/projectFile3d';
import { isPlane } from '../model3d';
import type { FieldKind, Project3D } from '../model3d';
import { readStored, removeStored, writeStored } from './storage';
import { useTheme } from './theme';
import { notify, Toasts } from './toast';
import { FIELDS_3D, mm } from './format3d';
import { Help3D } from './Help3D';
import { ImportDialog } from './ImportDialog';
import type { ImportSource } from './ImportDialog';
import { ApiBridge3D, UrlModel3D } from './Integration3D';
import { SidePanel3D } from './SidePanel3D';
import { deleteSelection, PLANE_DIAGRAMS, StoreProvider3D, useStore3D } from './store';
import type { Tool3D, ViewOptions3D } from './store';
import { Toolbar3D } from './Toolbar3D';
import { TopBar3D } from './TopBar3D';
import { Viewer } from './Viewer';
import type { ViewerHandle } from './Viewer';
import { ScaleControls, ViewBar3D, ViewPresets } from './ViewBar3D';
import './styles.css';
import './styles3d.css';

export const STORAGE_KEY_3D = 'frameforge-project-3d';

/** What to open on start-up: the last 3D model and, once, the former 2D workspace's model. */
function readStartUp(): StartUp {
  return startUp({
    project3d: readStored(STORAGE_KEY_3D),
    project2d: readStored(LEGACY_2D_PROJECT_KEY),
    workspace: readStored(LEGACY_WORKSPACE_KEY),
  });
}

/**
 * Opens share links (`#s=`, and former 2D `#m=` links, converted to plane frames), finishes
 * the one-off migration of the 2D autosave and keeps the model in local storage.
 */
function Persistence3D({ start }: { start: StartUp }) {
  const { state, dispatch } = useStore3D();
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current) return;
    migrated.current = true;
    if (start.then) dispatch({ type: 'load', project: start.then });
    if (start.message) notify(start.message);
    // The former 2D workspace's autosave has been converted: do not convert it again.
    removeStored(LEGACY_2D_PROJECT_KEY);
    removeStored(LEGACY_WORKSPACE_KEY);
  }, [start, dispatch]);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    const load = () => {
      const hash = window.location.hash;
      // A link is opened once (effects can run twice, and the hash stays in the address bar).
      if (!hash || hash === opened.current) return;
      opened.current = hash;
      openShareHash(hash)
        .then((opened) => {
          if (!opened) return;
          dispatch({ type: 'load', project: opened.project });
          notify(
            opened.converted
              ? `Opened the 2D model "${opened.project.name}", converted to a plane frame.`
              : `Opened shared model "${opened.project.name}".`,
          );
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
      else if (DIAGRAM_KEYS[key]) {
        // Plane frames only have N, Vy and Mz.
        const diagram = DIAGRAM_KEYS[key];
        if (!isPlane(state.project) || PLANE_DIAGRAMS.includes(diagram)) {
          dispatch({ type: 'view', view: { diagram } });
        }
      } else if (key === 'd') dispatch({ type: 'view', view: { deformed: !view.deformed } });
      else if (key === 'r') dispatch({ type: 'view', view: { reactions: !view.reactions } });
      else if (key === 'u') dispatch({ type: 'view', view: { utilisation: !view.utilisation } });
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

function Import3D({ source, onClose }: { source: ImportSource | null; onClose: () => void }) {
  const { dispatch } = useStore3D();
  return (
    <ImportDialog
      initial={source}
      onClose={onClose}
      onImport={(project, result) => {
        dispatch({ type: 'load', project });
        const warn = result.warnings.length;
        notify(
          `Imported "${project.name}": ${project.nodes.length} nodes, ${project.members.length} members` +
            (warn > 0 ? `, ${warn} warning${warn === 1 ? '' : 's'}.` : '.'),
        );
        onClose();
      }}
    />
  );
}

export default function App3D() {
  const [theme, toggleTheme] = useTheme();
  const [help, setHelp] = useState(false);
  // false: closed; null: open empty; a source: open with that file.
  const [importing, setImporting] = useState<ImportSource | null | false>(false);
  const openImport = useCallback((source: ImportSource | null) => setImporting(source), []);
  const [start] = useState(readStartUp);
  const [initial] = useState(() => start.initial ?? EXAMPLES_3D[0].build());
  const openHelp = useCallback(() => setHelp(true), []);
  return (
    <StoreProvider3D initial={initial}>
      <div className="app app3d">
        <TopBar3D
          theme={theme}
          onToggleTheme={toggleTheme}
          onHelp={openHelp}
          onImport={openImport}
        />
        <Shortcuts3D onHelp={openHelp} />
        <Persistence3D start={start} />
        <ApiBridge3D />
        <UrlModel3D onProblem={openImport} />
        <div className="main">
          <Toolbar3D />
          <Stage3D />
          <SidePanel3D />
        </div>
        <StatusBar3D />
        <Toasts />
        {help && <Help3D onClose={() => setHelp(false)} />}
        {importing !== false && <Import3D source={importing} onClose={() => setImporting(false)} />}
      </div>
    </StoreProvider3D>
  );
}
