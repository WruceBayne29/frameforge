/**
 * Opening anything FrameForge ever saved. The app used to have a separate 2D workspace with
 * its own file format, share links (`#m=`) and autosave; all of them still open, converted to
 * plane-frame 3D projects with `from2D`.
 */
import { from2D } from '../model3d/generate';
import type { Project3D } from '../model3d/types';
import { parseProjectText } from './projectFile';
import { detectProjectKind, parseProject3DText } from './projectFile3d';
import { decodeProject, payloadFromHash } from './share';
import { decodeProject3D, payloadFromHash3D } from './share3d';

/** Local-storage keys of the former 2D workspace. */
export const LEGACY_2D_PROJECT_KEY = 'frameforge-project';
export const LEGACY_WORKSPACE_KEY = 'frameforge-workspace';

export interface Opened {
  project: Project3D;
  /** True when the input was a 2D model, converted to a plane frame. */
  converted: boolean;
}

/** Parses the text of a 3D or 2D project file (2D files are converted). */
export function openProjectText(text: string): Opened {
  if (detectProjectKind(text) === '2d')
    return { project: from2D(parseProjectText(text)), converted: true };
  return { project: parseProject3DText(text), converted: false };
}

/**
 * The model in a share-link fragment: `#s=` (3D) or a former 2D `#m=` link (converted).
 * Null when the fragment holds no model. Rejects with `ProjectFormatError` for a damaged link.
 */
export async function openShareHash(hash: string): Promise<Opened | null> {
  const space = payloadFromHash3D(hash);
  if (space) return { project: await decodeProject3D(space), converted: false };
  const plane = payloadFromHash(hash);
  if (plane) return { project: from2D(await decodeProject(plane)), converted: true };
  return null;
}

export interface StartUp {
  /** The model to start with (null: show the default example). */
  initial: Project3D | null;
  /** A model to open straight after, so Undo returns to `initial`. */
  then: Project3D | null;
  /** What to tell the user about a converted 2D autosave. */
  message: string | null;
}

const usable = (project: Project3D | null) =>
  project && project.nodes.length > 0 ? project : null;

function tryParse<T>(text: string | null, parse: (text: string) => T): T | null {
  if (!text) return null;
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/**
 * The model to open on start-up, from the stored 3D autosave and the former 2D workspace's
 * autosave (converted once; the caller then removes the 2D keys). When both exist, the one
 * from the workspace used last is opened and the other is one Undo away.
 */
export function startUp(stored: {
  project3d: string | null;
  project2d: string | null;
  workspace: string | null;
}): StartUp {
  const saved = usable(tryParse(stored.project3d, parseProject3DText));
  const old = usable(tryParse(stored.project2d, (text) => from2D(parseProjectText(text))));
  if (!old) return { initial: saved, then: null, message: null };
  const name = `"${old.name}"`;
  if (!saved) {
    return {
      initial: old,
      then: null,
      message: `Your 2D model ${name} was converted to a plane frame in the 3D app.`,
    };
  }
  if (stored.workspace === '2d') {
    return {
      initial: saved,
      then: old,
      message:
        `Your 2D model ${name} was converted to a plane frame in the 3D app. ` +
        'Undo returns to your 3D model.',
    };
  }
  return {
    initial: old,
    then: saved,
    message: `Your saved 2D model ${name} was converted to a plane frame — press Undo to open it.`,
  };
}
