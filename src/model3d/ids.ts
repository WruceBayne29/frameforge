import { nextId } from '../model/ids';

export { nextId };

/** Id prefixes used by 3D projects. */
export const ID_PREFIX = { node: 'N', member: 'M', plate: 'P', solid: 'S', load: 'L' } as const;

/**
 * Returns a function that hands out consecutive free ids `${prefix}${n}`, starting after the
 * largest number already in use. Cheaper than calling `nextId` once per new item when many
 * items are created at once (mesh generators).
 */
export function idSequence(prefix: string, existing: Iterable<string>): () => string {
  let n = Number(nextId(prefix, existing).slice(prefix.length));
  return () => `${prefix}${n++}`;
}
