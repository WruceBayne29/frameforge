import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { Project } from './model';
import type { Project3D } from './model3d/types';
import { App } from './ui/App';
import { readStored, writeStored } from './ui/storage';
import { WorkspaceProvider } from './ui/workspace';
import type { WorkspaceValue } from './ui/workspace';
import { initialWorkspace, WORKSPACE_KEY, workspaceFromHash } from './workspace';
import type { Workspace } from './workspace';

// The 3D workspace (and three.js with it) is a separate chunk, loaded when first shown.
const App3D = lazy(() => import('./ui3d/App3D'));

interface Shown {
  workspace: Workspace;
  /** A model handed over from the other workspace, opened instead of the saved one. */
  project2d?: Project;
  project3d?: Project3D;
}

/** Drops a share-link fragment so it is not opened again by the next workspace. */
function clearHash(): void {
  if (workspaceFromHash(window.location.hash)) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

export function Root() {
  const [shown, setShown] = useState<Shown>(() => ({
    workspace: initialWorkspace(window.location.hash, readStored(WORKSPACE_KEY)),
  }));

  useEffect(() => writeStored(WORKSPACE_KEY, shown.workspace), [shown.workspace]);

  useEffect(() => {
    const onHash = () => {
      const target = workspaceFromHash(window.location.hash);
      if (target) setShown((s) => (s.workspace === target ? s : { workspace: target }));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const switchTo = useCallback((workspace: Workspace) => {
    clearHash();
    setShown({ workspace });
  }, []);
  const open2D = useCallback((project2d: Project) => {
    clearHash();
    setShown({ workspace: '2d', project2d });
  }, []);
  const open3D = useCallback((project3d: Project3D) => {
    clearHash();
    setShown({ workspace: '3d', project3d });
  }, []);

  const value = useMemo<WorkspaceValue>(
    () => ({ workspace: shown.workspace, switchTo, open2D, open3D }),
    [shown.workspace, switchTo, open2D, open3D],
  );

  return (
    <WorkspaceProvider value={value}>
      {shown.workspace === '3d' ? (
        <Suspense fallback={<div className="workspace-loading">Loading the 3D workspace…</div>}>
          <App3D incoming={shown.project3d} />
        </Suspense>
      ) : (
        <App incoming={shown.project2d} />
      )}
    </WorkspaceProvider>
  );
}
