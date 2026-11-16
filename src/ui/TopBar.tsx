import { EXAMPLES } from '../examples';
import { useStore } from './store';

export interface TopBarProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export function TopBar({ theme, onToggleTheme }: TopBarProps) {
  const { state, dispatch } = useStore();
  const categories = ['Beams', 'Frames', 'Trusses'] as const;
  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
          <rect width="64" height="64" rx="12" className="brand-bg" />
          <path
            d="M10 50 L32 14 L54 50 Z M21 32 L43 32 M32 14 L32 50 M21 32 L32 50 L43 32"
            className="brand-mark"
          />
        </svg>
        <span>FrameForge</span>
      </div>
      <select
        className="example-picker"
        data-tour="examples"
        aria-label="Load an example structure"
        value=""
        onChange={(e) => {
          const example = EXAMPLES.find((x) => x.id === e.target.value);
          if (example) dispatch({ type: 'load', project: example.build() });
        }}
      >
        <option value="" disabled>
          Examples…
        </option>
        {categories.map((category) => (
          <optgroup key={category} label={category}>
            {EXAMPLES.filter((x) => x.category === category).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} — {x.summary}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="project-name" title={state.project.description}>
        {state.project.name}
      </span>
      <div className="spacer" />
      <button
        type="button"
        className="ghost"
        title="Undo (Ctrl+Z)"
        disabled={state.past.length === 0}
        onClick={() => dispatch({ type: 'undo' })}
      >
        Undo
      </button>
      <button
        type="button"
        className="ghost"
        title="Redo (Ctrl+Shift+Z)"
        disabled={state.future.length === 0}
        onClick={() => dispatch({ type: 'redo' })}
      >
        Redo
      </button>
      <button
        type="button"
        className="ghost"
        title="Toggle dark / light mode"
        onClick={onToggleTheme}
      >
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>
      <a
        className="ghost link"
        href="https://github.com/WruceBayne29/frameforge"
        target="_blank"
        rel="noreferrer"
      >
        GitHub
      </a>
    </header>
  );
}
