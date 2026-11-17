import { createContext, useContext } from 'react';
import type { Project } from '../model';
import type { Project3D } from '../model3d/types';
import type { Workspace } from '../workspace';

export interface WorkspaceValue {
  workspace: Workspace;
  /** Shows the other workspace with whatever model it had last. */
  switchTo: (workspace: Workspace) => void;
  /** Shows the 2D workspace with this model. */
  open2D: (project: Project) => void;
  /** Shows the 3D workspace with this model. */
  open3D: (project: Project3D) => void;
}

const WorkspaceContext = createContext<WorkspaceValue>({
  workspace: '2d',
  switchTo: () => undefined,
  open2D: () => undefined,
  open3D: () => undefined,
});

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): WorkspaceValue {
  return useContext(WorkspaceContext);
}

/** The "2D | 3D" control shown in both top bars. */
export function WorkspaceSwitch() {
  const { workspace, switchTo } = useWorkspace();
  const item = (id: Workspace, label: string, title: string) => (
    <button
      type="button"
      title={title}
      aria-pressed={workspace === id}
      className={workspace === id ? 'active' : ''}
      onClick={() => workspace !== id && switchTo(id)}
    >
      {label}
    </button>
  );
  return (
    <div className="segmented workspace-switch" role="group" aria-label="Workspace">
      {item('2d', '2D', 'Plane frames, beams and trusses')}
      {item('3d', '3D', 'Space frames, plates and solids')}
    </div>
  );
}
