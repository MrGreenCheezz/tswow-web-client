/**
 * The chat cache's LOCKED, DOCKED and UNINTERACTABLE flags, as the stock chat frames write them.
 *
 * `GetChatWindowInfo(id)` answers name, fontSize, r, g, b, alpha, shown, locked, docked and
 * uninteractable (FloatingChatFrame.lua:125). The seams own the first seven — the shown flag is
 * their `setChatWindowShown` — and this store owns the last three, which stock writes through
 * `SetChatWindowLocked` (FCF_SetLocked, :958; FCF_OpenNewWindow passes nil, :557),
 * `SetChatWindowUninteractable` (FCF_SetUninteractable, :982) and `SetChatWindowDocked`
 * (FCF_SaveDock writes each docked frame's position, :1570; FCF_UnDockFrame writes nil, :1508).
 *
 * What the round trip changes, measured against `FloatingChatFrame_Update` (:120-166): on every
 * UPDATE_CHAT_WINDOWS it re-applies `locked` and `uninteractable` to the frame and re-docks a
 * `docked` one — so without this store a frame the player unlocked or dragged out of the dock was
 * locked and docked again at the next zone crossing. A window the player undocked answers the shown
 * flag its own OnShow/OnHide wrote (the seams' map), because :138-146 hides and closes an undocked
 * window whose shown is false; a docked window keeps the seam's shown answer, whose reasons are with
 * {@link frameXmlCombatLogWindowInfo}.
 */
import type { FrameXmlChatWindowInfo } from "./FrameXmlWorldSeam.js";

/** `SetChatWindowDocked`'s value: the dock position stock passed, or false for its nil. */
export type FrameXmlChatWindowDock = number | false;

export class FrameXmlChatWindowFlags {
  readonly #locked = new Map<number, boolean>();
  readonly #uninteractable = new Map<number, boolean>();
  readonly #docked = new Map<number, FrameXmlChatWindowDock>();

  /** A new FrameXML load starts from the cache's defaults again. */
  reset(): void {
    this.#locked.clear();
    this.#uninteractable.clear();
    this.#docked.clear();
  }

  setLocked(windowId: number, locked: boolean): void {
    if (validWindow(windowId)) this.#locked.set(windowId, locked);
  }

  setUninteractable(windowId: number, uninteractable: boolean): void {
    if (validWindow(windowId)) this.#uninteractable.set(windowId, uninteractable);
  }

  setDocked(windowId: number, docked: FrameXmlChatWindowDock): void {
    if (validWindow(windowId)) this.#docked.set(windowId, docked);
  }

  /** The seam's answer with what stock wrote laid over it; `shown` is the seam's SHOWN map entry. */
  apply(windowId: number, base: FrameXmlChatWindowInfo, shown: boolean | undefined): FrameXmlChatWindowInfo {
    const docked = this.#docked.get(windowId) ?? base[8];
    const isDocked = docked !== false && docked !== 0;
    return [
      base[0], base[1], base[2], base[3], base[4], base[5],
      isDocked ? base[6] : (shown ?? base[6]),
      this.#locked.get(windowId) ?? base[7],
      docked,
      this.#uninteractable.get(windowId) ?? base[9],
    ];
  }
}

/** `NUM_CHAT_WINDOWS` is 10 (ChatFrame.lua); the cache has no rows beyond it. */
function validWindow(windowId: number): boolean {
  return Number.isInteger(windowId) && windowId >= 1 && windowId <= 10;
}

/** The part of the world seam the bindings read. */
export interface FrameXmlChatWindowFlagsHost {
  readonly chatWindows?: FrameXmlChatWindowFlags | undefined;
}

const NOTHING: readonly unknown[] = Object.freeze([]);

function windowOf(value: unknown): number {
  const id = Number(value);
  return Number.isFinite(id) ? Math.trunc(id) : 0;
}

/** Lua truthiness: stock passes 1/true, or nil/false. */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

export const FRAMEXML_CHAT_WINDOW_FLAG_BINDINGS: Readonly<Record<string,
  (host: FrameXmlChatWindowFlagsHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  SetChatWindowLocked: (host, args) => {
    host.chatWindows?.setLocked(windowOf(args[0]), truthy(args[1]));
    return NOTHING;
  },
  SetChatWindowUninteractable: (host, args) => {
    host.chatWindows?.setUninteractable(windowOf(args[0]), truthy(args[1]));
    return NOTHING;
  },
  SetChatWindowDocked: (host, args) => {
    const position = Number(args[1]);
    host.chatWindows?.setDocked(windowOf(args[0]),
      truthy(args[1]) && Number.isFinite(position) && position > 0 ? Math.trunc(position) : false);
    return NOTHING;
  },
});
