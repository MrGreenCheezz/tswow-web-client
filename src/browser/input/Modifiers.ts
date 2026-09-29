/**
 * The keyboard modifiers held now and the mouse button of the current click — what the stock UI
 * reads through `IsShiftKeyDown`, `IsLeftAltKeyDown`, `IsModifiedClick("CHATLINK")` and
 * `MODIFIER_STATE_CHANGED`.
 *
 * One page-wide tracker, fed by capture-phase listeners on `window`. Capture on the window runs
 * before any element's own handler, so when the FrameXML renderer fires a button's `OnClick` for a
 * `click`/`mouseup`, the state already holds that very event's modifiers and button: a click is
 * read with the keys it was made with, as in the client. A pointer or key event also carries the
 * whole modifier state in `shiftKey`/`ctrlKey`/`altKey`, which repairs a key released while the
 * page had no focus; a lost focus lets go of everything.
 *
 * Sides come from `KeyboardEvent.code` (`ShiftLeft`, `ControlRight`, …). A modifier seen held on a
 * pointer event with no key press of it recorded counts as the left one.
 */

export type ModifierKey = "LSHIFT" | "RSHIFT" | "LCTRL" | "RCTRL" | "LALT" | "RALT";

export interface ModifierState {
  readonly LSHIFT: boolean;
  readonly RSHIFT: boolean;
  readonly LCTRL: boolean;
  readonly RCTRL: boolean;
  readonly LALT: boolean;
  readonly RALT: boolean;
  /** The current click's mouse button, 1 left, 2 right, 3 middle, 4 and 5; 0 before any click. */
  readonly button: number;
}

export interface ModifierSource {
  state(): ModifierState;
  /** Each side of a modifier going down or up, in order; returns the unsubscribe. */
  onChange?(listener: (key: ModifierKey, down: boolean) => void): () => void;
}

const KEY_CODES: Readonly<Record<string, ModifierKey>> = Object.freeze({
  ShiftLeft: "LSHIFT", ShiftRight: "RSHIFT",
  ControlLeft: "LCTRL", ControlRight: "RCTRL",
  AltLeft: "LALT", AltRight: "RALT",
});

/** `MouseEvent.button` → the client's button number (`BUTTON1` left, `BUTTON2` right, `BUTTON3` middle). */
const MOUSE_BUTTONS: readonly number[] = Object.freeze([1, 3, 2, 4, 5]);

const PAIRS: readonly (readonly [left: ModifierKey, right: ModifierKey, flag: "shiftKey" | "ctrlKey" | "altKey"])[] = [
  ["LSHIFT", "RSHIFT", "shiftKey"], ["LCTRL", "RCTRL", "ctrlKey"], ["LALT", "RALT", "altKey"],
];

interface EventModifiers {
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}

/**
 * The tracker itself, without the window: tests and a second page feed it events directly.
 */
export class ModifierTracker implements ModifierSource {
  readonly #held: Record<ModifierKey, boolean> = {
    LSHIFT: false, RSHIFT: false, LCTRL: false, RCTRL: false, LALT: false, RALT: false,
  };
  #button = 0;
  readonly #listeners = new Set<(key: ModifierKey, down: boolean) => void>();

  state(): ModifierState {
    return { ...this.#held, button: this.#button };
  }

  onChange(listener: (key: ModifierKey, down: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #set(key: ModifierKey, down: boolean): void {
    if (this.#held[key] === down) return;
    this.#held[key] = down;
    for (const listener of [...this.#listeners]) listener(key, down);
  }

  /** Bring both sides of each modifier in line with what an event says is held. */
  #reconcile(event: EventModifiers): void {
    for (const [left, right, flag] of PAIRS) {
      const held = event[flag];
      if (held === undefined) continue;
      if (!held) {
        this.#set(left, false);
        this.#set(right, false);
      } else if (!this.#held[left] && !this.#held[right]) {
        this.#set(left, true);
      }
    }
  }

  key(event: EventModifiers & { readonly code: string; readonly type: string }): void {
    const key = KEY_CODES[event.code];
    const down = event.type === "keydown";
    // The key's own flag in a keydown/keyup already says whether any side of it is still held;
    // the side itself comes from the code.
    if (key !== undefined) this.#set(key, down);
    this.#reconcile(key === undefined ? event : withoutPair(event, key));
  }

  pointer(event: EventModifiers & { readonly button?: number }): void {
    const button = event.button === undefined ? undefined : MOUSE_BUTTONS[event.button];
    if (button !== undefined) this.#button = button;
    this.#reconcile(event);
  }

  release(): void {
    for (const key of Object.keys(this.#held) as ModifierKey[]) this.#set(key, false);
  }
}

/** The event with the flag of `key`'s own pair left out: that pair was just set from the code. */
function withoutPair(event: EventModifiers, key: ModifierKey): EventModifiers {
  const own = PAIRS.find(([left, right]) => left === key || right === key)?.[2];
  const flags: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {};
  for (const [, , flag] of PAIRS) {
    const held = event[flag];
    if (flag !== own && held !== undefined) flags[flag] = held;
  }
  return flags;
}

let page: ModifierTracker | undefined;

/**
 * The page's tracker, listening from the first call on. Without a `window` (Node) it is a tracker
 * nothing feeds: nothing is held and no button was pressed.
 */
export function pageModifiers(): ModifierTracker {
  if (page) return page;
  const tracker = new ModifierTracker();
  page = tracker;
  const target = typeof window === "undefined" ? undefined : window;
  if (!target || typeof target.addEventListener !== "function") return tracker;
  const key = (event: KeyboardEvent): void => tracker.key(event);
  const pointer = (event: MouseEvent): void => tracker.pointer(event);
  target.addEventListener("keydown", key, true);
  target.addEventListener("keyup", key, true);
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu"]) {
    target.addEventListener(type, pointer as EventListener, true);
  }
  target.addEventListener("blur", () => tracker.release());
  return tracker;
}
