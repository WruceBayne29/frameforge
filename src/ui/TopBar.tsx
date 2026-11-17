import { useRef, useState } from 'react';
import { EXAMPLES } from '../examples';
import { parseProjectText, ProjectFormatError, serializeProject } from '../io/projectFile';
import { shareUrl } from '../io/share';
import { emptyProject } from '../model';
import { useStore } from './store';
import { notify } from './toast';
import { useWorkspace, WorkspaceSwitch } from './workspace';

export interface TopBarProps {
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

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'frameforge'
  );
}

export function TopBar({ theme, onToggleTheme, onHelp }: TopBarProps) {
  const { state, dispatch, solution } = useStore();
  const { open3D } = useWorkspace();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const project = state.project;
  const categories = ['Beams', 'Frames', 'Trusses'] as const;

  const openFile = async (file: File) => {
    try {
      const text = await file.text();
      // The 3D file code is loaded on demand so it does not slow down the first page load.
      const io3d = await import('../io/projectFile3d');
      if (io3d.detectProjectKind(text) === '3d') {
        // A space-structure file belongs to the 3D workspace.
        open3D(io3d.parseProject3DText(text));
        return;
      }
      dispatch({ type: 'load', project: parseProjectText(text) });
      notify(`Opened ${file.name}`);
    } catch (e) {
      notify(e instanceof ProjectFormatError ? e.message : 'Could not read that file.', 'error');
    }
  };

  const share = async () => {
    try {
      const url = await shareUrl(project, window.location.href);
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

  const report = async () => {
    if (!solution.result) {
      notify('Fix the model so it can be analysed before exporting a report.', 'error');
      return;
    }
    setBusy(true);
    try {
      // The PDF library is loaded on demand so it does not slow down the first page load.
      const [{ buildReport, reportFileName }, link] = await Promise.all([
        import('../io/report'),
        shareUrl(project, window.location.href).catch(() => undefined),
      ]);
      buildReport({
        project,
        result: solution.result,
        design: solution.design,
        shareUrl: link,
      }).save(reportFileName(project));
      notify('PDF report downloaded.');
    } catch {
      notify('Could not create the PDF report.', 'error');
    } finally {
      setBusy(false);
    }
  };

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
      <WorkspaceSwitch />
      <select
        className="example-picker"
        data-tour="examples"
        aria-label="Load an example structure"
        value=""
        onChange={(e) => {
          const example = EXAMPLES.find((x) => x.id === e.target.value);
          if (example) dispatch({ type: 'load', project: example.build() });
          // Return focus to the page so keyboard shortcuts work straight away.
          e.target.blur();
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
      <div className="file-actions" data-tour="export">
        <button
          type="button"
          className="ghost"
          title="Start an empty model"
          onClick={() => dispatch({ type: 'load', project: emptyProject() })}
        >
          New
        </button>
        <button
          type="button"
          className="ghost"
          title="Open a saved .json model"
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
              new Blob([serializeProject(project)], { type: 'application/json' }),
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
        <button
          type="button"
          className="ghost"
          title="Convert this model to a 3D model and continue in the 3D workspace"
          disabled={project.nodes.length === 0}
          onClick={() => {
            import('../model3d/generate')
              .then(({ from2D }) => open3D(from2D(project)))
              .catch(() => notify('Could not convert the model to 3D.', 'error'));
          }}
        >
          Open in 3D
        </button>
        <button
          type="button"
          className="primary"
          title="Download a PDF calculation report"
          disabled={busy}
          onClick={report}
        >
          {busy ? 'Building…' : 'PDF report'}
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
        title="Keyboard shortcuts and tour (?)"
        onClick={onHelp}
      >
        Help
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
