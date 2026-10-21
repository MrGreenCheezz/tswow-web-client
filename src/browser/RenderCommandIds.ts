/**
 * 22.10 ARC-2 S4a: ids the main thread gives the things it asks the world renderer to play — a spell visual, a
 * melee swing — so that later commands (cancel, retime, release) and results (swing progress) name them by a
 * number instead of by a live renderer object. One counter for every caller, because one renderer keeps them all;
 * never 0, never reused within a page.
 */

let lastRenderId = 0;

export function allocateRenderId(): number {
  return ++lastRenderId;
}
