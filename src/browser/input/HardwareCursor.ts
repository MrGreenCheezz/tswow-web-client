/**
 * 5.17 (11.11): the cursor the pointer shows, as one identity, and CURSOR_UPDATE when it changes.
 *
 * Wow.exe 12340 keeps one current cursor (0x00C26DE8: a table id, or 0x35 for a file) and raises event 0x113
 * CURSOR_UPDATE whenever it changes — 0x00616800 (a table id other than the current one), 0x00616920 (back to
 * the mode's cursor, when that differs) and 0x00616830 (a file: when the path differs from the last one loaded, or
 * the current cursor is not the file one) — whoever asks: the world frame's hover on every move (0x004F8190),
 * `SetCursor` / `ResetCursor` (0x005104A0 / 0x00510920), the item and spell cursors (0x00520770, 0x00520D30,
 * 0x00522FB0, raised by FrameXmlCursor.ts). Read-only Ghidra: `.runtime/re-2026-10-02/a9-p2/r1.c`, `r2.c`, `r3.c`;
 * the event's call sites `.runtime/re-2026-11-11/moves/errcalls.mjs` (0x0081B530 with 0x113), `m2.c`.
 *
 * Here the pointer shows the interface's `SetCursor` choice where it has one (FrameXmlSetCursor.ts), else the
 * world hover's file ("" for the mode's own, input/Controls.ts); both use the cursor file keys of input/Cursors.ts,
 * so the same cursor from either side is one identity. When this client changes its cursor is its own (the hover
 * resets when the pointer leaves the canvas): the event follows what is drawn.
 */

let worldKey = "";
let interfaceKey: string | undefined;
let shown = "";
const listeners = new Set<() => void>();

/** The identity the pointer shows ("" is the mode's cursor). */
export function hardwareCursor(): string {
  return shown;
}

/** The world hover's cursor file ("" for the mode's own). */
export function setWorldCursor(key: string): void {
  worldKey = key;
  refresh();
}

/** The interface's `SetCursor` choice; undefined once `ResetCursor` or the world ends it. */
export function setInterfaceCursor(key: string | undefined): void {
  interfaceKey = key;
  refresh();
}

/** CURSOR_UPDATE's source; returns the unsubscribe. */
export function onHardwareCursorChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function refresh(): void {
  const next = interfaceKey ?? worldKey;
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}
