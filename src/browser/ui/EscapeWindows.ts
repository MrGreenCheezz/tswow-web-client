/**
 * The windows Escape closes.
 *
 * This was a nine-element array written out twice, once to ask whether anything was open and once
 * to close it, and the two could not disagree only because nobody had touched them since. Every
 * window built at run time — the bank, the guild, the calendar, the scoreboard — was missing from
 * both, so Escape walked straight past them into the game menu. A panel registers itself here
 * instead, and the list is one list.
 *
 * The order is the order of registration, and it matters: Escape closes the open ones in that order.
 */
export interface EscapableWindow {
  isOpen(): boolean;
  close(): void;
}

const ESCAPABLE: EscapableWindow[] = [];

export function registerEscapable(entry: EscapableWindow): () => void {
  ESCAPABLE.push(entry);
  return () => {
    const index = ESCAPABLE.indexOf(entry);
    if (index >= 0) ESCAPABLE.splice(index, 1);
  };
}

/** The live list, in order; a close that unregisters its entry changes it under the reader. */
export function escapableWindows(): readonly EscapableWindow[] {
  return ESCAPABLE;
}
