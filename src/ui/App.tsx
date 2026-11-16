import { useEffect, useState } from 'react';
import { EXAMPLES } from '../examples';
import { Canvas } from './Canvas';
import { StoreProvider, useStore } from './store';
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
        <div className="main">
          <Stage />
        </div>
        <StatusBar />
      </div>
    </StoreProvider>
  );
}
