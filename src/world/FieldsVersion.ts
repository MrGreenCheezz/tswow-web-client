/**
 * 22.10 ARC-2 S2c: a counter per object fields Map that moves whenever its words are written, so a cache over
 * what an object's fields say (game/RenderLookupsBuilder.ts, the renderer's unit-model table) can tell an
 * unchanged object apart without reading its words again.
 *
 * Keyed by the Map itself, not by the object: a replacement Map starts its own count. Every writer of a world
 * object's fields bumps it — WorldState (create and values blocks, `setField`, `patchField`) and the canned
 * FrameXML PvP session. A writer that does not would leave a cached answer stale; add the bump with the write.
 *
 * 22.10 ARC-2 S5: an object's `speeds` Map counts the same way (WorldState `setSpeed` and the create block's
 * nine rates), so the frame encoder (FrameInputEncoder.ts) re-sends the rates only when they were written.
 */

const versions = new WeakMap<ReadonlyMap<unknown, number>, number>();

/** Marks `fields` as written. */
export function bumpFieldsVersion(fields: ReadonlyMap<unknown, number>): void {
  versions.set(fields, (versions.get(fields) ?? 0) + 1);
}

/** How many times `fields` has been marked written (0 before the first). */
export function fieldsVersion(fields: ReadonlyMap<unknown, number>): number {
  return versions.get(fields) ?? 0;
}
