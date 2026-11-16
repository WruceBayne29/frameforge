import { useEffect, useState } from 'react';
import { EXAMPLES } from '../examples';
import { deleteLoad, deleteMember, deleteNode } from '../model';
import { Canvas } from './Canvas';
import { SidePanel } from './SidePanel';
import { StoreProvider, useStore } from './store';
import type { DiagramKind, Tool } from './store';
import { Toolbar } from './Toolbar';
import { TopBar } from './TopBar';
import { ViewBar } from './ViewBar';
import { fmt, mm } from './format';
import './styles.css';

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('frameforge-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage may be unavailable (private mode); fall through to the system preference.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
function Shortcuts() {
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
      if (TOOL_KEYS[key]) dispatch({ type: 'tool', tool: TOOL_KEYS[key] });
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
  }, [state, dispatch]);
  return null;
}

function Stage() {
  const { solution } = useStore();
  return (
    <section className="stage">
      <ViewBar />
      <div className="canvas-wrap">
        <Canvas />
        {solution.error && (
          <div className="error-banner" role="alert">
            <strong>Cannot analyse this structure.</strong> {solution.error.message}
          </div>
        )}
      </div>
    </section>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('frameforge-theme', theme);
    } catch {
      // Ignore storage failures.
    }
  }, [theme]);

  return (
    <StoreProvider initial={EXAMPLES[0].build()}>
      <div className="app">
        <TopBar
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        />
        <Shortcuts />
        <div className="main">
          <Toolbar />
          <Stage />
          <SidePanel />
        </div>
        <StatusBar />
      </div>
    </StoreProvider>
  );
}
