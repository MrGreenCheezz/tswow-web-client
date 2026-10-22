/**
 * 22.10 ARC-2 S7: what the render worker's own advance (MirrorMotion.ts, RenderInputSmoothing.ts) changed on the
 * mirror world, kept so it can be put back. The mirror must be the page's exact input before the next frame message is
 * applied (each message is a difference against what the page sent, not against what the worker drew) and before a
 * lockstep draw (a bench screenshot draws the exact input). Values are written back in place: the renderer's caches
 * key on the identities of the object, its position and its seat.
 */

import type { WorldObjectState } from "../world/WorldState.js";

interface Saved {
  object: WorldObjectState;
  x: number;
  y: number;
  z: number;
  orientation: number;
  hasPosition: boolean;
  flags: number;
  seat: WorldObjectState["transport"];
  seatX: number;
  seatY: number;
  seatZ: number;
  seatOrientation: number;
  motion: WorldObjectState["motion"];
  latch: WorldObjectState["splineTier"];
  latchTier: number | undefined;
}

export class MirrorRestore {
  readonly #saved: Saved[] = [];
  #count = 0;
  readonly #touched = new Set<WorldObjectState>();

  /** Objects changed since the last `restore`. */
  get size(): number {
    return this.#count;
  }

  /** Records the object as it stands, once per advance: call before the first write to it. */
  touch(object: WorldObjectState): void {
    const touched = this.#touched;
    if (touched.has(object)) return;
    touched.add(object);
    const saved = this.#saved[this.#count] ??= {
      object, x: 0, y: 0, z: 0, orientation: 0, hasPosition: false, flags: 0, seat: undefined, seatX: 0, seatY: 0,
      seatZ: 0, seatOrientation: 0, motion: undefined, latch: undefined, latchTier: undefined,
    };
    this.#count++;
    saved.object = object;
    const position = object.position;
    saved.hasPosition = position !== undefined;
    if (position !== undefined) {
      saved.x = position.x;
      saved.y = position.y;
      saved.z = position.z;
      saved.orientation = position.orientation;
    }
    saved.flags = object.movementFlags;
    const seat = object.transport;
    saved.seat = seat;
    if (seat !== undefined) {
      saved.seatX = seat.x;
      saved.seatY = seat.y;
      saved.seatZ = seat.z;
      saved.seatOrientation = seat.orientation;
    }
    saved.motion = object.motion;
    saved.latch = object.splineTier;
    saved.latchTier = object.splineTier?.tier;
  }

  /** Every touched object back to its recorded values, in place. */
  restore(): void {
    const count = this.#count;
    if (count === 0) return;
    const saved = this.#saved;
    for (let index = 0; index < count; index++) {
      const entry = saved[index]!;
      const object = entry.object;
      const position = object.position;
      if (entry.hasPosition && position !== undefined) {
        position.x = entry.x;
        position.y = entry.y;
        position.z = entry.z;
        position.orientation = entry.orientation;
      }
      object.movementFlags = entry.flags;
      const seat = entry.seat;
      if (seat !== undefined) {
        seat.x = entry.seatX;
        seat.y = entry.seatY;
        seat.z = entry.seatZ;
        seat.orientation = entry.seatOrientation;
      }
      object.motion = entry.motion;
      object.splineTier = entry.latch;
      if (entry.latch !== undefined) entry.latch.tier = entry.latchTier;
      // No reference kept past the restore: a removed object is not held alive by the pool.
      entry.object = undefined as unknown as WorldObjectState;
      entry.seat = undefined;
      entry.motion = undefined;
      entry.latch = undefined;
    }
    this.#count = 0;
    this.#touched.clear();
  }
}
