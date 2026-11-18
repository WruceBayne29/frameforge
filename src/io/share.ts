/**
 * Share-link payloads: the whole project is stored in the URL fragment, so sharing needs no
 * server and the model never leaves the browser. Payload: `1.` + base64url(deflate(JSON))
 * where the browser supports CompressionStream, otherwise `0.` + base64url(JSON). 3D links
 * use the key `s` (`share3d.ts`); links of the former 2D workspace (`#m=…`) are still read,
 * and opened as plane frames (`migrate.ts`).
 */
import type { Project } from '../model/types';
import { parseProject, ProjectFormatError } from './projectFile';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}

/**
 * Encodes any JSON value as a share payload (`1.` + deflated or `0.` + plain, base64url).
 * Shared by the 2D and 3D share links.
 */
export async function encodeJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (typeof CompressionStream === 'function') {
    return `1.${toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')))}`;
  }
  return `0.${toBase64Url(bytes)}`;
}

/** Decodes a share payload back into the JSON value, which is still untrusted data. */
export async function decodeJson(payload: string): Promise<unknown> {
  const dot = payload.indexOf('.');
  const mode = payload.slice(0, dot);
  const body = payload.slice(dot + 1);
  if (dot < 1 || (mode !== '0' && mode !== '1')) {
    throw new ProjectFormatError('This link does not contain a FrameForge model.');
  }
  try {
    let bytes = fromBase64Url(body);
    if (mode === '1') {
      if (typeof DecompressionStream !== 'function') {
        throw new ProjectFormatError('This browser cannot open compressed share links.');
      }
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (e) {
    if (e instanceof ProjectFormatError) throw e;
    throw new ProjectFormatError('This link is damaged or incomplete.');
  }
}

export async function decodeProject(payload: string): Promise<Project> {
  return parseProject(await decodeJson(payload));
}

/** Extracts a former 2D (`#m=`) model payload from a URL fragment, if there is one. */
export function payloadFromHash(hash: string): string | null {
  const match = /^#?m=(.+)$/.exec(hash);
  return match ? match[1] : null;
}
