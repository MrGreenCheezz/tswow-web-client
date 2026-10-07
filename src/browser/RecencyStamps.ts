/**
 * P1-10 (MEM-2): recency stamps written in place instead of `Map` `delete` + `set`.
 *
 * Re-inserting a key to move it to the back of a `Map` spends a slot of the hash table and, every
 * `capacity − size` touches, rebuilds the whole table; a hot LRU touched hundreds of times a frame
 * rebuilt its table every few frames. A cache instead stamps each entry with a strictly increasing
 * per-cache counter on every insertion and touch, and eviction looks for the smallest stamp — the
 * same "oldest first" order the re-insertion kept, because every action that used to move a key
 * now gives it a new stamp.
 *
 * The counter stays a small integer: on reaching `RECENCY_STAMP_LIMIT` the cache renumbers its
 * stamps 1..n in the same order and carries on from n.
 */

/** 2^29: under the 31-bit Smi limit, ≈1.75 h at ≈85 000 touches a second before a renumbering. */
export const RECENCY_STAMP_LIMIT = 1 << 29;

/**
 * The renumbering threshold every cache compares its clock with (a live binding). Always
 * `RECENCY_STAMP_LIMIT` outside tests; a test lowers it so a renumbering happens within a few
 * hundred touches.
 */
export let recencyStampLimit = RECENCY_STAMP_LIMIT;

/** Tests only: lower the renumbering threshold; no argument restores `RECENCY_STAMP_LIMIT`. */
export function setRecencyStampLimitForTests(limit: number = RECENCY_STAMP_LIMIT): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RECENCY_STAMP_LIMIT) {
    throw new RangeError("recency stamp limit must be an integer in 1..RECENCY_STAMP_LIMIT");
  }
  recencyStampLimit = limit;
}

/** Renumbers the stamps of a key → stamp map to 1..n, keeping their order; returns n. */
export function renumberRecency<K>(stamps: Map<K, number>): number {
  const ordered = [...stamps].sort((left, right) => left[1] - right[1]);
  let next = 0;
  for (const [key] of ordered) stamps.set(key, ++next);
  return next;
}

/** Renumbers entries carrying a `used` stamp to 1..n, keeping their order; returns n. */
export function renumberByUsed(entries: Iterable<{ used: number }>): number {
  const ordered = [...entries].sort((left, right) => left.used - right.used);
  let next = 0;
  for (const entry of ordered) entry.used = ++next;
  return next;
}
