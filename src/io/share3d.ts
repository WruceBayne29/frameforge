/**
 * Shareable URLs for 3D projects. Same scheme as the 2D links (`share.ts`) — the whole
 * project is stored, compressed, in the URL fragment — but under the key `s` (`#s=…`) so a
 * link says which kind of model it carries.
 */
import type { Project3D } from '../model3d/types';
import { parseProject3D } from './projectFile3d';
import { decodeJson, encodeJson } from './share';

const PARAM = 's';

export async function encodeProject3D(project: Project3D): Promise<string> {
  // The JSON round trip drops undefined fields, which only bloat the URL.
  return encodeJson(JSON.parse(JSON.stringify(project)) as unknown);
}

export async function decodeProject3D(payload: string): Promise<Project3D> {
  return parseProject3D(await decodeJson(payload));
}

/** Builds a full share URL for the given page URL. */
export async function shareUrl3D(project: Project3D, pageUrl: string): Promise<string> {
  const url = new URL(pageUrl);
  url.hash = `${PARAM}=${await encodeProject3D(project)}`;
  return url.toString();
}

/** Extracts the 3D model payload from a URL fragment, if there is one. */
export function payloadFromHash3D(hash: string): string | null {
  const match = /^#?s=(.+)$/.exec(hash);
  return match ? match[1] : null;
}
