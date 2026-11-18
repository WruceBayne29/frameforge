import { useRef } from 'react';
import { EXAMPLES_3D, PLANE_CATEGORY } from '../examples3d';
import { parseProjectText, ProjectFormatError } from '../io/projectFile';
import { detectProjectKind, parseProject3DText, serializeProject3D } from '../io/projectFile3d';
import { shareUrl3D } from '../io/share3d';
import { emptyProject3D } from '../model3d';
import { notify } from '../ui/toast';
import { useWorkspace, WorkspaceSwitch } from '../ui/workspace';
import { slug } from './format3d';
import { useStore3D } from './store';

export interface TopBar3DProps {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onHelp: () => void;
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CATEGORIES = ['Frames', 'Trusses', 'Plates', 'Solids', 'Mixed', PLANE_CATEGORY] as const;

export function TopBar3D({ theme, onToggleTheme, onHelp }: TopBar3DProps) {
  const { state, dispatch } = useStore3D();
  const { open2D } = useWorkspace();
  const fileInput = useRef<HTMLInputElement>(null);
  const project = state.project;

  const openFile = async (file: File) => {
    try {
      const text = await file.text();
      if (detectProjectKind(text) === '2d') {
        // A plane-frame file belongs to the 2D workspace.
        open2D(parseProjectText(text));
        return;
      }
      dispatch({ type: 'load', project: parseProject3DText(text) });
      notify(`Opened ${file.name}`);
    } catch (e) {
      notify(e instanceof ProjectFormatError ? e.message : 'Could not read that file.', 'error');
    }
  };

  const share = async () => {
    try {
      const url = await shareUrl3D(project, window.location.href);
      window.history.replaceState(null, '', url);
      try {
        await navigator.clipboard.writeText(url);
        notify('Share link copied to the clipboard.');
      } catch {
        notify('Share link is in the address bar — copy it from there.');
      }
    } catch {
      notify('Could not create a share link.', 'error');
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
          <rect width="64" height="64" rx="12" className="brand-bg" />
          <path
            d="M14 46 L14 22 L32 12 L50 22 L50 46 L32 56 Z M14 22 L32 32 L50 22 M32 32 L32 56"
            className="brand-mark"
          />
        </svg>
        <span>FrameForge</span>
      </div>
      <WorkspaceSwitch />
      <select
        className="example-picker"
        aria-label="Load a 3D example"
        value=""
        onChange={(e) => {
          const example = EXAMPLES_3D.find((x) => x.id === e.target.value);
          if (example) dispatch({ type: 'load', project: example.build() });
          e.target.blur();
        }}
      >
        <option value="" disabled>
          Examples…
        </option>
        {CATEGORIES.map((category) => (
          <optgroup key={category} label={category}>
            {EXAMPLES_3D.filter((x) => x.category === category).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} — {x.summary}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div className="file-actions">
        <select
          className="new-picker"
          aria-label="Start a new model"
          title="Start an empty model"
          value=""
          onChange={(e) => {
            const project = emptyProject3D();
            if (e.target.value === 'plane') project.plane = 'XY';
            if (e.target.value) dispatch({ type: 'load', project });
            e.target.blur();
          }}
        >
          <option value="" disabled>
            New…
          </option>
          <option value="space">3D model</option>
          <option value="plane">Plane frame (2D)</option>
        </select>
        <button
          type="button"
          className="ghost"
          title="Open a saved .json model (2D files open in the 2D workspace)"
          onClick={() => fileInput.current?.click()}
        >
          Open
        </button>
        <button
          type="button"
          className="ghost"
          title="Save the model as a .json file"
          onClick={() =>
            download(
              `${slug(project.name)}.json`,
              new Blob([serializeProject3D(project)], { type: 'application/json' }),
            )
          }
        >
          Save
        </button>
        <button
          type="button"
          className="ghost"
          title="Copy a link that opens this exact model"
          onClick={share}
        >
          Share
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Open a model file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void openFile(file);
            e.target.value = '';
          }}
        />
      </div>
      <span className="project-name" title={project.description}>
        {project.name}
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
      <button
        type="button"
        className="ghost"
        title="Keyboard shortcuts and conventions (?)"
        onClick={onHelp}
      >
        Help
      </button>
    </header>
  );
}
