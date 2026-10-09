/**
 * The micro buttons' hints from the binding table (WORK_PLAN 4.10).
 *
 * The page markup carried each button's key in a static title attribute («Персонаж (C)») and
 * `aria-keyshortcuts="C"`, which lied as soon as a key was rebound and already lied for the buttons
 * whose action had a key the markup did not mention. The stock buttons build the same text at run
 * time — `MicroButtonTooltipText(NAME, "COMMAND")` (MainMenuBarMicroButtons.lua:11): the name, and
 * the bound key in brackets when there is one — and so does this, from the native table, with the
 * names from GlobalStrings (`nativeString`) and the hint in the interface's own tooltip (`setTip`).
 *
 * Runs at start-up and after every change to the table (`onBindingsChanged`): never per frame.
 */

import { describeChord, keysOf, onBindingsChanged, type InputAction } from "../input/Bindings.js";
import { nativeString } from "./Strings.js";
import { setTip } from "./Widgets.js";

export interface MicroButton {
  readonly id: string;
  /** The action the button and its key share; undefined for a button with no key at all. */
  readonly action?: InputAction;
  /** A fixed key the table does not hold: Escape is the game menu's (Controls.backOut). */
  readonly fixedChord?: string;
  /** The GlobalStrings name the stock button uses, and the literal for a checkout without data. */
  readonly nameKey?: string;
  readonly fallback: string;
}

/** The buttons of `index.html`'s micro bar, in its order. */
export const MICRO_BUTTONS: readonly MicroButton[] = [
  { id: "character-toggle", action: "toggleCharacter", nameKey: "CHARACTER_BUTTON", fallback: "Персонаж" },
  // No stock micro button opens every bag; the native one keeps its own word.
  { id: "inventory-toggle", action: "toggleBags", fallback: "Инвентарь" },
  { id: "spellbook-toggle", action: "toggleSpellbook", nameKey: "SPELLBOOK_ABILITIES_BUTTON", fallback: "Книга заклинаний" },
  { id: "talents-toggle", action: "toggleTalents", nameKey: "TALENTS_BUTTON", fallback: "Таланты" },
  { id: "quest-toggle", action: "toggleQuestLog", nameKey: "QUESTLOG_BUTTON", fallback: "Журнал заданий" },
  { id: "social-toggle", action: "toggleSocial", nameKey: "SOCIAL_BUTTON", fallback: "Общение" },
  { id: "worldmap-toggle", action: "toggleWorldMap", nameKey: "WORLDMAP_BUTTON", fallback: "Карта мира" },
  { id: "calendar-toggle", fallback: "Календарь" },
  { id: "lfg-toggle", action: "toggleLfd", nameKey: "DUNGEONS_BUTTON", fallback: "Поиск подземелий" },
  { id: "game-menu-toggle", fixedChord: "Escape", nameKey: "MAINMENU_BUTTON", fallback: "Меню игры" },
];

/** The first key on an action, or the button's fixed one. */
export function microButtonChord(button: MicroButton): string {
  if (button.fixedChord) return button.fixedChord;
  if (!button.action) return "";
  const [first, second] = keysOf(button.action);
  return first || second;
}

/** The stock hint: the name, and the key in brackets when there is one. */
export function microButtonCaption(button: MicroButton): string {
  const name = button.nameKey ? nativeString(button.nameKey, button.fallback) : button.fallback;
  const chord = microButtonChord(button);
  return chord ? `${name} (${describeChord(chord)})` : name;
}

const W3C_MODIFIERS: Readonly<Record<string, string>> = { Ctrl: "Control", Alt: "Alt", Shift: "Shift" };

/**
 * A chord in the form `aria-keyshortcuts` wants (WAI-ARIA: modifiers, then the key's `key` value):
 * `Shift+KeyB` → `Shift+B`, `Ctrl+Shift+KeyF` → `Control+Shift+F`, `Digit1` → `1`, `F2` → `F2`.
 */
export function ariaKeyShortcut(chord: string): string {
  if (!chord) return "";
  const parts = chord.split("+");
  const code = parts.pop()!;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3)
    : /^Digit[0-9]$/.test(code) ? code.slice(5)
      : code === "Space" ? "Space" : code;
  return [...parts.map((part) => W3C_MODIFIERS[part] ?? part), key].join("+");
}

/** Writes every micro button's hint, name and key shortcut from the table as it stands. */
export function refreshMicroButtons(doc: Pick<Document, "getElementById"> = document): void {
  for (const button of MICRO_BUTTONS) {
    const element = doc.getElementById(button.id);
    if (!element) continue;
    // The static markup hint goes: the browser would show it beside ours, and it was stale anyway.
    element.removeAttribute("title");
    setTip(element, microButtonCaption(button));
    element.setAttribute("aria-label", button.nameKey ? nativeString(button.nameKey, button.fallback) : button.fallback);
    const shortcut = ariaKeyShortcut(microButtonChord(button));
    if (shortcut) element.setAttribute("aria-keyshortcuts", shortcut);
    else element.removeAttribute("aria-keyshortcuts");
  }
}

let installed = false;

/** Writes the hints now and after every change to the table. Idempotent. */
export function installHudKeys(doc: Pick<Document, "getElementById"> = document): void {
  refreshMicroButtons(doc);
  if (installed) return;
  installed = true;
  onBindingsChanged(() => refreshMicroButtons(doc));
}
