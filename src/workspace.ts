/** Which of the two workspaces (plane frames or space structures) the app shows. */
export type Workspace = '2d' | '3d';

export const WORKSPACE_KEY = 'frameforge-workspace';

/** A share link says which workspace it belongs to: `#m=` is a 2D model, `#s=` a 3D one. */
export function workspaceFromHash(hash: string): Workspace | null {
  if (/^#?s=.+/.test(hash)) return '3d';
  if (/^#?m=.+/.test(hash)) return '2d';
  return null;
}

/** Workspace to open: a share link wins, then the last choice, then 2D. */
export function initialWorkspace(hash: string, saved: string | null): Workspace {
  return workspaceFromHash(hash) ?? (saved === '3d' ? '3d' : '2d');
}
