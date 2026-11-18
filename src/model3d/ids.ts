/** Returns the next free id of the form `${prefix}${n}` given the ids already in use. */
export function nextId(prefix: string, existing: Iterable<string>): string {
  let max = 0;
  for (const id of existing) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/**
 * Returns a function that hands out consecutive free ids `${prefix}${n}`, starting after the
 * largest number already in use. Cheaper than calling `nextId` once per new item when many
 * items are created at once (mesh generators).
 */
export function idSequence(prefix: string, existing: Iterable<string>): () => string {
  let n = Number(nextId(prefix, existing).slice(prefix.length));
  return () => `${prefix}${n++}`;
}
