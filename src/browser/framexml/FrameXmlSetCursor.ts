import { cursorCss, onCursorPicture, pathCursorName, stockCursorFile } from "../input/Cursors.js";

/**
 * 05.10-5.17: `SetCursor` and `ResetCursor`, the stock C API a frame's OnEnter/OnLeave uses to change
 * the pointer (ShowInspectCursor UIParent.lua:2918, the glyph cursor Blizzard_GlyphUI.lua:227, the
 * vehicle seats VehicleMenuBar.lua:1039, the chat frame's resize grip FloatingChatFrame.xml:552,
 * GameTooltip_HideResetCursor and the many OnLeave handlers that call ResetCursor).
 *
 * Wow.exe 12340 (`.runtime/re-2026-10-02/a9-p2/r1.c`, `r2.c`; registration .data 0x00ac8260/0x00ac8268):
 *
 * - `SetCursor` 0x005104A0: an argument that is not a string or number (nil included) is
 *   `ResetCursor` and returns nothing. A name equal, without case, to one of the 52 table names
 *   (POINT_CURSOR … VEHICLE_ERROR_CURSOR) selects that cursor id (0x00616800) and returns 1. Any other
 *   string is a file path (0x00616830, cursor id 53): loaded from that path, a picture that cannot be
 *   loaded leaves the cursor blank; it returns 1, or nil when the load of a new path failed.
 * - `ResetCursor` 0x00510920 → 0x00616920: back to the cursor the current mode puts under everything
 *   (0x00616270 keeps it; here the body-class cursors of style.css: a pending spell, the repair mode).
 * - Either raises CURSOR_UPDATE (0x113) when the cursor id changes.
 *
 * Here the chosen cursor is drawn over the stock interface (`#framexml-world-stage`) through
 * `--framexml-set-cursor` and the body class `framexml-set-cursor`, from the same pictures as the
 * hover cursor (input/Cursors.ts). The world canvas keeps its own: in the client the world frame's
 * mouse-over (0x004F8190) picks a cursor on every move, so the pointer reaching the world ends the
 * interface's choice — modelled by forgetting it when the pointer enters the canvas.
 *
 * Not modelled: CURSOR_UPDATE on these changes (no stock handler reads the pointer's picture, and the
 * world hover here does not raise it either); the nil a failing new path returns (the picture
 * arrives after the call, so the call answers 1).
 */

const NOTHING: readonly unknown[] = Object.freeze([]);
const ONE: readonly unknown[] = Object.freeze([1]);
const SET_CLASS = "framexml-set-cursor";
const SET_VARIABLE = "--framexml-set-cursor";

/** The picture key the interface chose, undefined for the mode's own. */
let chosen: string | undefined;
let stopPictures: (() => void) | undefined;
let watchingWorld = false;

/** The cursor `SetCursor` chose and the pointer still shows over the interface: a file or `path:` key. */
export function frameXmlChosenCursor(): string | undefined {
  return chosen;
}

/** `SetCursor(name)`: the stock call's answer (see the module comment). */
export function frameXmlSetCursor(value: unknown): readonly unknown[] {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
    frameXmlResetCursor();
    return NOTHING;
  }
  const name = String(value);
  choose(stockCursorFile(name) ?? pathCursorName(name));
  return ONE;
}

/** `ResetCursor()`. */
export function frameXmlResetCursor(): readonly unknown[] {
  choose(undefined);
  return NOTHING;
}

function choose(name: string | undefined): void {
  if (name === chosen) return;
  chosen = name;
  draw();
}

function draw(): void {
  if (typeof document === "undefined" || !document.body) return;
  const root = document.documentElement;
  if (chosen === undefined) {
    document.body.classList.remove(SET_CLASS);
    root?.style.removeProperty(SET_VARIABLE);
    return;
  }
  watchWorld();
  stopPictures ??= onCursorPicture(() => { if (chosen !== undefined) draw(); });
  // cursorCss answers "" for the stylesheet's own (a path still on its way): the default arrow.
  root?.style.setProperty(SET_VARIABLE, cursorCss(chosen) || "default");
  document.body.classList.add(SET_CLASS);
}

/** The pointer entering the world canvas ends the interface's choice (0x004F8190 picks there). */
function watchWorld(): void {
  if (watchingWorld || typeof document === "undefined") return;
  watchingWorld = true;
  document.addEventListener("pointerover", (event) => {
    if (chosen !== undefined && (event.target as { id?: unknown } | null)?.id === "world-canvas") choose(undefined);
  }, { passive: true });
}

/** The bindings, spread into the seam table after the bank's inert `ResetCursor`. */
export const FRAMEXML_SET_CURSOR_BINDINGS: Readonly<Record<string, (seam: unknown, args: readonly unknown[]) => readonly unknown[]>> =
  Object.freeze({
    SetCursor: (_seam, args) => frameXmlSetCursor(args[0]),
    ResetCursor: () => frameXmlResetCursor(),
  });
