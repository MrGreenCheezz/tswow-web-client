/**
 * 22.10 ARC-2 S4a: the renderer's side of melee swing timing. The main thread's cues (game/SwingReactionCues.ts)
 * time a victim's parry and wound by how far the attacker's swing has played. That used to be a call back into the
 * main thread in the middle of `draw` (`afterUnits`), which asked `meleeSwingProgress(guid, token, now)` and read
 * the live queue entry. Now the swing is queued under an id main allocated; at the same point of the frame the
 * renderer writes each watched swing's progress into RenderResults.ts `swings`, and main ticks its cues from that
 * record after `draw` returns. A swing is watched from `playUnitAction` until main releases its id (its cue record
 * dropped) or the world's resources are cleared.
 */

import type { RenderResults, SwingResult } from "./RenderResults.js";
import { toMainTime } from "./RenderClock.js";

/** What the watch reads of a queued swing (UnitActionArbiter.ts `UnitActionEntry`). */
export interface WatchedSwingEntry {
  readonly started: boolean;
  readonly payload: { readonly swingSeconds?: number | undefined };
}

/** The renderer's progress question, as `meleeSwingProgress` answered it. */
export type SwingProgressOf<Entry> = (guid: bigint, entry: Entry, now: number) => number | null | undefined;

interface Watched<Entry> {
  readonly guid: bigint;
  readonly entry: Entry;
  readonly row: SwingResult;
}

export class SwingProgressWatch<Entry extends WatchedSwingEntry> {
  readonly #watched = new Map<number, Watched<Entry>>();

  get size(): number {
    return this.#watched.size;
  }

  has(id: number): boolean {
    return this.#watched.has(id);
  }

  watch(id: number, guid: bigint, entry: Entry): void {
    this.#watched.set(id, { guid, entry, row: { progress: undefined, started: false, swingSeconds: undefined } });
  }

  release(id: number): void {
    this.#watched.delete(id);
  }

  clear(): void {
    this.#watched.clear();
  }

  /** Once per frame, where `afterUnits(now)` ran: every watched swing's progress at the frame's `now`. */
  publish(results: RenderResults, now: number, progressOf: SwingProgressOf<Entry>): void {
    const swings = results.swings;
    swings.clear();
    for (const [id, watched] of this.#watched) {
      const row = watched.row;
      row.progress = progressOf(watched.guid, watched.entry, now);
      row.started = watched.entry.started === true;
      row.swingSeconds = watched.entry.payload.swingSeconds;
      swings.set(id, row);
    }
    results.swingFrame++;
    results.swingNow = toMainTime(now);
  }
}
