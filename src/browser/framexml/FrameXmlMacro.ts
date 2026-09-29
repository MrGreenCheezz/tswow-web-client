/**
 * The macro C API over this client's own macro store (`ui/Macros.ts`, `ui/MacroModel.ts`), for the
 * load-on-demand Blizzard_MacroUI (MacroFrame, MacroPopupFrame) and the action bar.
 *
 * Two numberings, as in the client. The store keeps each macro in a fixed slot, 1..36 account and
 * 37..54 character — the slot is the macro's identity, the number an action button holds
 * (`ACTION_BUTTON_MACRO`) and what `runMacro` runs; the client's macros-cache keeps such an id too.
 * The Lua API numbers macros by position instead: account macros 1..N and character macros
 * 37..36+M, with no gaps (Blizzard_MacroUI.lua walks `GetMacroInfo(macroBase + i)` for `i <=
 * numMacros`, and MacroFrame_DeleteMacro steps the selection back one when the last is removed).
 * Positions follow slot order, which is the order the native window has always shown; CreateMacro
 * takes the lowest free slot of its set and answers that slot's position. The client's own sort
 * order within a set cannot be read from any file here — only the owner's live client can show it.
 *
 * A body is stored as written, up to 255 characters, like the client stores it: the stock window has
 * no refusal path (MacroFrame_SaveMacro ignores EditMacro's answer), so what this client cannot run
 * is said when the macro is run (`runMacro` checks `macroProblems` first), not by losing the text.
 *
 * Icons are the client's macro icon list: every distinct `Interface\Icons\` texture of SpellIcon.dbc
 * in row order with the question mark first (gateway `/dbc/macro-icons`, fetched when the window
 * first opens). Until it arrives, or if it never does, the list is the question mark alone.
 *
 * A macro picked up (PickupMacro, MacroButton's OnDragStart and MacroFrameSelectedMacroButton's
 * OnClick) sits on the cursor as its slot: GetCursorInfo answers `"macro", position`, and the next
 * PlaceAction or action-button press puts it on that slot through CMSG_SET_ACTION_BUTTON (the same
 * `setActionButton` the native bar's drop uses).
 *
 * Running one: `RunMacro(id, button)` and `RunMacroText(text, button)` — a secure button's `macro`
 * and `macrotext` types (SecureTemplates.lua:366-381) — hand their lines to the macro runner
 * (macro/MacroRunner.ts) with the clicking mouse button, which `[btn:N]` reads; `StopMacro()` ends
 * the running macro after its line (`/stopmacro`, ChatFrame.lua:1398-1402); `GetClickFrame(name)` is
 * the frame of that name `/click` presses (ChatFrame.lua:1404-1416), from the frames the stock chat
 * publishes to the runner; the stock body itself refuses anything but a Button.
 */

import {
  MACRO_DEFAULT_ICON, MAX_ACCOUNT_MACROS, MAX_CHARACTER_MACROS, isAccountMacro,
  macroIcon, macroIndexes, trimMacroBody, trimMacroName, validMacroIcon, type Macro,
} from "../ui/MacroModel.js";
import {
  macroBodyLines, macroClickFrame, macroLineExecutor, runMacroLines, stopMacro, type MacroLineExecutor,
} from "../macro/MacroRunner.js";
import type { FrameXmlSeamBinding, FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";

/** Where the macros live; `ui/Macros.ts` answers it with the two account-data stores. */
export interface FrameXmlMacroStore {
  /** Every macro, both sets, in slot order. */
  list(): readonly Macro[];
  put(macro: Macro): void;
  remove(slot: number): void;
  /** Called when the store changed from outside (the server's copy landed, the native window). */
  subscribe?(listener: () => void): () => void;
  /** `SaveMacros`: send any pending write now. */
  flush?(): void;
}

/** The icon catalog; absent or empty until loaded. */
export interface FrameXmlMacroIcons {
  spellIcons(): readonly string[] | undefined;
  itemIcons?(): readonly string[] | undefined;
  /** Start (or join) the one fetch; resolves when the lists are in or the fetch failed. */
  load?(): Promise<void>;
}

export interface FrameXmlMacroHost {
  readonly store: FrameXmlMacroStore;
  readonly icons?: FrameXmlMacroIcons;
  /** `CMSG_SET_ACTION_BUTTON` for a 1-based stock action slot; false when there is no world. */
  placeOnActionBar?(actionSlot: number, macroSlot: number): boolean;
}

/** An in-memory store, for a seam that has no account data (tests, the offline preview). */
export function createFrameXmlMemoryMacroStore(initial: readonly Macro[] = []): FrameXmlMacroStore {
  let macros = [...initial].sort((left, right) => left.index - right.index);
  const listeners = new Set<() => void>();
  return {
    list: () => macros,
    put: (macro) => {
      macros = [...macros.filter((entry) => entry.index !== macro.index), macro].sort((left, right) => left.index - right.index);
    },
    remove: (slot) => { macros = macros.filter((entry) => entry.index !== slot); },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * `RunMacroText(text, button)`: the text's lines through the installed executor, else through
 * `fallback`. The button is SecureActionButton's («LeftButton»…); an add-on may pass a number.
 */
function runMacroText(text: unknown, button: unknown, fallback?: MacroLineExecutor): void {
  if (typeof text !== "string") return;
  const execute = macroLineExecutor() ?? fallback;
  const lines = macroBodyLines(text);
  if (!execute || lines.length === 0) return;
  const pressed = typeof button === "string" ? button : typeof button === "number" ? String(button) : undefined;
  runMacroLines(lines, execute, pressed);
}

export class FrameXmlMacroModel {
  readonly #host: FrameXmlMacroHost;
  #pump: FrameXmlSeamPump | undefined;
  #unsubscribe: (() => void) | undefined;
  /** The slot of the macro on the cursor. */
  #cursor: number | undefined;
  readonly #queued: string[] = [];

  constructor(host: FrameXmlMacroHost) {
    this.#host = host;
  }

  attach(pump: FrameXmlSeamPump): void {
    this.detach();
    this.#pump = pump;
    this.#unsubscribe = this.#host.store.subscribe?.(() => this.#changed());
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#pump = undefined;
    this.#cursor = undefined;
  }

  /** Start the icon fetch; the owner awaits it beside the add-on load. */
  loadIcons(): Promise<void> {
    return Promise.resolve(this.#host.icons?.load?.()).then(() => undefined, () => undefined);
  }

  /**
   * Events go out once the Lua call that caused them has returned (MacroPopupOkayButton_OnClick
   * creates, selects and repaints in one chain), in the order they were raised.
   */
  #fire(event: string): void {
    this.#queued.push(event);
    if (this.#queued.length > 1) return;
    queueMicrotask(() => {
      const events = this.#queued.splice(0);
      for (const name of events) this.#pump?.fire(name);
    });
  }

  #changed(): void {
    // A macro on the cursor that is gone stays gone.
    if (this.#cursor !== undefined && !this.#bySlot(this.#cursor)) this.clearCursor();
    if (!this.#queued.includes("UPDATE_MACROS")) this.#fire("UPDATE_MACROS");
  }

  #set(account: boolean): Macro[] {
    return this.#host.store.list().filter((macro) => isAccountMacro(macro.index) === account);
  }

  #bySlot(slot: number): Macro | undefined {
    return this.#host.store.list().find((macro) => macro.index === slot);
  }

  /** Lua position → stored macro. */
  #at(position: number): Macro | undefined {
    if (!Number.isInteger(position) || position < 1) return undefined;
    if (position <= MAX_ACCOUNT_MACROS) return this.#set(true)[position - 1];
    if (position <= MAX_ACCOUNT_MACROS + MAX_CHARACTER_MACROS) return this.#set(false)[position - MAX_ACCOUNT_MACROS - 1];
    return undefined;
  }

  /** Stored slot → Lua position, or 0. */
  position(slot: number): number {
    const account = isAccountMacro(slot);
    const index = this.#set(account).findIndex((macro) => macro.index === slot);
    if (index < 0) return 0;
    return account ? index + 1 : MAX_ACCOUNT_MACROS + index + 1;
  }

  /** A position or a name (GetMacroInfo, DeleteMacro and PickupMacro take either). */
  #resolve(id: unknown): Macro | undefined {
    if (typeof id === "string" && id.length > 0 && !/^\d+$/.test(id)) {
      const wanted = id.toLowerCase();
      return this.#host.store.list().find((macro) => macro.name.toLowerCase() === wanted);
    }
    const position = typeof id === "number" ? id : typeof id === "string" ? Number(id) : Number.NaN;
    return this.#at(Math.trunc(position));
  }

  /** `GetNumMacros()`: account count, character count. */
  counts(): readonly [number, number] {
    return [this.#set(true).length, this.#set(false).length];
  }

  /** `GetMacroInfo(id)`: name, texture, body. */
  info(id: unknown): readonly [string, string, string] | undefined {
    const macro = this.#resolve(id);
    return macro ? [macro.name, macroIcon(macro), macro.body] : undefined;
  }

  /** `GetMacroIndexByName(name)`: its position, or 0. */
  indexByName(name: unknown): number {
    if (typeof name !== "string" || name.length === 0) return 0;
    const wanted = name.toLowerCase();
    const macro = this.#host.store.list().find((entry) => entry.name.toLowerCase() === wanted);
    return macro ? this.position(macro.index) : 0;
  }

  /** The icon list (`GetMacroIconInfo`), never empty: the question mark stands alone until it loads. */
  #spellIcons(): readonly string[] {
    const icons = this.#host.icons?.spellIcons();
    return icons && icons.length > 0 ? icons : [MACRO_DEFAULT_ICON];
  }

  iconCount(): number {
    return this.#spellIcons().length;
  }

  icon(index: unknown): string | undefined {
    const position = Math.trunc(Number(index));
    return this.#spellIcons()[position - 1];
  }

  itemIconCount(): number {
    return this.#host.icons?.itemIcons?.()?.length ?? 0;
  }

  itemIcon(index: unknown): string | undefined {
    return this.#host.icons?.itemIcons?.()?.[Math.trunc(Number(index)) - 1];
  }

  /**
   * An icon argument as a texture: CreateMacro/EditMacro get the position MacroPopupFrame selected
   * (MacroPopupButton_SelectTexture); an add-on may pass a texture path instead.
   */
  #iconTexture(value: unknown): string | undefined {
    if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) return this.icon(value);
    if (typeof value !== "string" || value.length === 0) return undefined;
    return validMacroIcon(value.includes("\\") ? value : `Interface\\Icons\\${value}`);
  }

  /** `CreateMacro(name, icon, body, perCharacter)`: the new macro's position, or undefined when the set is full. */
  create(name: unknown, icon: unknown, body: unknown, perCharacter: unknown): number | undefined {
    const account = !(perCharacter === true || perCharacter === 1 || perCharacter === "1");
    const taken = new Set(this.#set(account).map((macro) => macro.index));
    const slot = macroIndexes(account).find((index) => !taken.has(index));
    if (slot === undefined) return undefined;
    const texture = this.#iconTexture(icon);
    this.#host.store.put({
      index: slot,
      name: trimMacroName(textOf(name) ?? ""),
      body: trimMacroBody(textOf(body) ?? ""),
      ...(texture === undefined || texture === MACRO_DEFAULT_ICON ? {} : { icon: texture }),
    });
    this.#changed();
    return this.position(slot);
  }

  /**
   * `EditMacro(id, name, icon, body)`: nil leaves that part as it was (MacroFrame_SaveMacro sends
   * only the body, the popup only name and icon). Answers the macro's position, which does not move.
   */
  edit(id: unknown, name: unknown, icon: unknown, body: unknown): number | undefined {
    const macro = this.#resolve(id);
    if (!macro) return undefined;
    const texture = icon === undefined || icon === null ? macro.icon : this.#iconTexture(icon) ?? macro.icon;
    const next: Macro = {
      index: macro.index,
      name: typeof name === "string" ? trimMacroName(name) : macro.name,
      body: typeof body === "string" ? trimMacroBody(body) : macro.body,
      ...(texture === undefined || texture === MACRO_DEFAULT_ICON ? {} : { icon: texture }),
    };
    this.#host.store.put(next);
    this.#changed();
    return this.position(macro.index);
  }

  /** `DeleteMacro(id)`. */
  remove(id: unknown): void {
    const macro = this.#resolve(id);
    if (!macro) return;
    this.#host.store.remove(macro.index);
    this.#changed();
  }

  /** `SaveMacros()`: the stores already mirror every change; send the pending server write now. */
  save(): void {
    this.#host.store.flush?.();
  }

  // ---- running ---------------------------------------------------------------------------------

  /** `RunMacro(id, button)`: the macro at that position or of that name. */
  run(id: unknown, button: unknown): void {
    const macro = this.#resolve(id);
    if (macro) this.runText(macro.body, button);
  }

  /** `RunMacroText(text, button)`. */
  runText(text: unknown, button: unknown): void {
    runMacroText(text, button, this.#executeChatLine);
  }

  /** With no executor installed, the client's own route: EXECUTE_CHAT_LINE to stock MacroEditBox. */
  readonly #executeChatLine = (line: string): void => {
    this.#pump?.fire("EXECUTE_CHAT_LINE", line);
  };

  // ---- the cursor ------------------------------------------------------------------------------

  /** `PickupMacro(id)`: the macro goes on the cursor; picking up the one already there drops it. */
  pickup(id: unknown): void {
    const macro = this.#resolve(id);
    if (!macro) return;
    if (this.#cursor === macro.index) {
      this.clearCursor();
      return;
    }
    this.#cursor = macro.index;
    this.#fire("CURSOR_UPDATE");
    this.#fire("ACTIONBAR_SHOWGRID");
  }

  cursorSlot(): number | undefined {
    return this.#cursor;
  }

  /** `GetCursorInfo()` while a macro is on the cursor: `"macro", position`. */
  cursorInfo(): readonly unknown[] | undefined {
    if (this.#cursor === undefined) return undefined;
    const position = this.position(this.#cursor);
    return position > 0 ? ["macro", position] : undefined;
  }

  clearCursor(): boolean {
    if (this.#cursor === undefined) return false;
    this.#cursor = undefined;
    this.#fire("CURSOR_UPDATE");
    this.#fire("ACTIONBAR_HIDEGRID");
    return true;
  }

  /**
   * `PlaceAction(slot)`, and an action button pressed with a macro on the cursor: the macro goes on
   * that 1-based stock slot and leaves the cursor. False when no macro is on the cursor, which
   * leaves the press to the button's own action.
   */
  placeCursor(actionSlot: unknown): boolean {
    const slot = Math.trunc(Number(actionSlot));
    const macro = this.#cursor;
    if (macro === undefined || !Number.isInteger(slot) || slot < 1) return false;
    this.#host.placeOnActionBar?.(slot, macro);
    this.clearCursor();
    return true;
  }

  // ---- the action bar --------------------------------------------------------------------------

  /** What an action button holding this macro slot shows: its name (GetActionText) … */
  slotName(slot: number): string | undefined {
    return this.#bySlot(slot)?.name;
  }

  /** … and its icon (GetActionTexture). Undefined for a slot whose macro was deleted. */
  slotTexture(slot: number): string | undefined {
    const macro = this.#bySlot(slot);
    return macro ? macroIcon(macro) : undefined;
  }
}

const NOTHING: readonly unknown[] = Object.freeze([]);

/**
 * The macro C API. Without a model every name answers the empty set: no macros, the question mark
 * as the only icon, and creation refused.
 */
export const FRAMEXML_MACRO_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  GetNumMacros: (seam) => seam.macros?.counts() ?? [0, 0],
  GetMacroInfo: (seam, args) => seam.macros?.info(args[0]) ?? NOTHING,
  GetMacroBody: (seam, args) => {
    const info = seam.macros?.info(args[0]);
    return info ? [info[2]] : NOTHING;
  },
  GetMacroIndexByName: (seam, args) => [seam.macros?.indexByName(args[0]) ?? 0],
  CreateMacro: (seam, args) => {
    const position = seam.macros?.create(args[0], args[1], args[2], args[3]);
    return position === undefined ? NOTHING : [position];
  },
  EditMacro: (seam, args) => {
    const position = seam.macros?.edit(args[0], args[1], args[2], args[3]);
    return position === undefined ? NOTHING : [position];
  },
  DeleteMacro: (seam, args) => { seam.macros?.remove(args[0]); return NOTHING; },
  GetNumMacroIcons: (seam) => [seam.macros?.iconCount() ?? 1],
  GetMacroIconInfo: (seam, args) => {
    const texture = seam.macros ? seam.macros.icon(args[0]) : Number(args[0]) === 1 ? MACRO_DEFAULT_ICON : undefined;
    return texture === undefined ? NOTHING : [texture];
  },
  GetNumMacroItemIcons: (seam) => [seam.macros?.itemIconCount() ?? 0],
  GetMacroItemIconInfo: (seam, args) => {
    const texture = seam.macros?.itemIcon(args[0]);
    return texture === undefined ? NOTHING : [texture];
  },
  PickupMacro: (seam, args) => {
    // One thing on the cursor: a macro picked up drops an item held there.
    if (seam.macros && seam.cursorHasItem()) seam.clearCursor();
    seam.macros?.pickup(args[0]);
    return NOTHING;
  },
  PlaceAction: (seam, args) => { seam.macros?.placeCursor(args[0]); return NOTHING; },
  SaveMacros: (seam) => { seam.macros?.save(); return NOTHING; },
  RunMacro: (seam, args) => { seam.macros?.run(args[0], args[1]); return NOTHING; },
  RunMacroText: (seam, args) => {
    if (seam.macros) seam.macros.runText(args[0], args[1]);
    else runMacroText(args[0], args[1]);
    return NOTHING;
  },
  StopMacro: () => { stopMacro(); return NOTHING; },
  // Any frame of that name (Wow.exe 0x564130 → 0x562990); the stock /click body checks it is a Button.
  GetClickFrame: (_seam, args) => {
    const name = typeof args[0] === "string" ? args[0] : "";
    const frame = name ? macroClickFrame(name) : undefined;
    return frame === undefined ? NOTHING : [frame];
  },
});
