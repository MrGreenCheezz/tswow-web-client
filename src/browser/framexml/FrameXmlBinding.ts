/**
 * The binding C API over this client's own table (`input/Bindings.ts`), for the stock action bars'
 * hotkeys, the micro buttons' tooltips and the load-on-demand Blizzard_BindingUI (KeyBindingFrame).
 *
 * Until this module the whole family was F2's neutral constants: `GetBindingKey` answered nil, so
 * every stock action button hid its hotkey, and `GetNumBindings` answered 0, so KeyBindingFrame
 * would have listed nothing. Now the stock names read and write the one table the keyboard obeys:
 *
 * - a stock command is the Bindings.xml name of the WebClient action that does the same thing
 *   (`MOVEFORWARD` is `moveForward`, `ACTIONBUTTON1` is `action1`, `MULTIACTIONBAR1BUTTON1` is
 *   `bottomLeftAction1`); `GetBinding(i)` lists them in Bindings.xml's own order and sections, with
 *   the stock `HEADER_*` rows, so KeyBindingFrame shows the client's own labels (BINDING_NAME_*);
 * - an action with no stock command (the diagnostics window, this client's `K` binding window) and
 *   every module action keep their row under two WebClient headers after the stock sections; a
 *   module action answers to a `WEBCLIENT_MODULE_*` alias, because stock GetBindingText cuts a
 *   command at its last `-` (it reads everything before as modifiers) and module ids have dashes;
 * - a key is the client's key name (`SHIFT-1`, `CTRL-SHIFT-F`, `NUMPADDIVIDE`, `-`), translated to
 *   and from the table's `event.code` chords (`Shift+Digit1`), modifiers in the client's ALT, CTRL,
 *   SHIFT order.
 *
 * GetBindingText and GetBindingFromClick are not here: they are Lua in the client's own UIParent.lua
 * (:2966, :3113), which read the KEY_ and BINDING_NAME_ strings and ask GetBindingByKey. The
 * prelude only gives the WebClient rows the BINDING_ strings those functions look up.
 *
 * What stays out: stock commands this client has no verb for (the camera wheel's two, the raid marks…; the views have one since DEC-B 3.11;
 * TOGGLESHEATH and the other rows of input/StockActions.ts have one since 3.11) are neither listed nor bindable — `SetBinding` refuses them rather than storing a key
 * that would do nothing. Mouse buttons and the wheel are refused too: the table holds keyboard
 * chords only (`Controls.ts` dispatches nothing else). Escape is the game menu and cannot move
 * (`Controls.backOut` owns it), so `GetBindingKey("TOGGLEGAMEMENU")` answers `ESCAPE` and nothing
 * can be bound to it. There is one binding set: `GetCurrentBindingSet` answers ACCOUNT_BINDINGS.
 *
 * Persistence is the table's own (`webclient.keybindings.v1` and the module blob), unchanged, so the
 * native window and this API read and write the same saved keys. The table persists every change as
 * it happens; the stock Save/Cancel pair is kept by a snapshot taken at the first change made
 * through this API: `LoadBindings(ACCOUNT_BINDINGS)` restores it (KeyBindingFrame's Cancel and
 * Escape), `SaveBindings` drops it (Okay).
 *
 * DOM-free: the verbs (`RunBinding`) and the CLICK bindings' button press come from the host.
 */

import {
  INPUT_ACTIONS, actionFor, addModuleAction, bindKey, keysOf, moduleActionFor, moduleActions,
  removeModuleActions, resetBindings, savedModuleBindingActions, useBindingStorage,
  clearAllOverrideBindings, clearOverrideBindings, overrideFor, setOverrideBinding,
  type BindingPair, type InputAction, type ModuleAction,
} from "../input/Bindings.js";
import type { FrameXmlSeamBinding, FrameXmlSeamPump } from "./FrameXmlWorldSeam.js";
import { STOCK_ACTIONS, withStockRows } from "../input/StockActions.js";
import { HELD_ACTIONS } from "../input/Bindings.js"; // L8 5.09
import { movementCommandInput, type MovementCommandInput } from "../input/MovementCommands.js"; // L8 5.09
import { FRAMEXML_MOVEMENT_BINDINGS } from "./FrameXmlMovementApi.js"; // L8 5.09

/** `DEFAULT_BINDINGS`, `ACCOUNT_BINDINGS`, `CHARACTER_BINDINGS` in Blizzard_BindingUI.lua. */
export const FRAMEXML_DEFAULT_BINDINGS = 0;
export const FRAMEXML_ACCOUNT_BINDINGS = 1;
export const FRAMEXML_CHARACTER_BINDINGS = 2;

/** The one binding this client keeps fixed: Escape is the game menu (Controls.backOut). */
export const FRAMEXML_GAME_MENU_COMMAND = "TOGGLEGAMEMENU";
const ESCAPE_KEY = "ESCAPE";

/** The two sections after the stock ones; their BINDING_HEADER_* texts are set by the prelude. */
export const FRAMEXML_WEBCLIENT_HEADER = "HEADER_WEBCLIENT";
export const FRAMEXML_WEBCLIENT_MODULES_HEADER = "HEADER_WEBCLIENT_MODULES";
/** A WebClient action with no Bindings.xml command answers to `WEBCLIENT_<ACTION>`. */
const WEBCLIENT_COMMAND_PREFIX = "WEBCLIENT_";
/** A module action answers to `WEBCLIENT_MODULE_<ID>`, its id in capitals with no punctuation. */
const MODULE_COMMAND_PREFIX = "WEBCLIENT_MODULE_";
/** The module a SetBindingClick action is registered under in the table (never listed). */
export const FRAMEXML_CLICK_BINDING_MODULE = "framexml:click";
/** The module SetBindingSpell/Item/Macro actions are registered under (never listed; 3.11 slice D). */
export const FRAMEXML_COMMAND_BINDING_MODULE = "framexml:command";

/** The three kinds of SetBinding{Spell,Item,Macro} command: `SPELL x`, `ITEM x`, `MACRO x`. */
export type FrameXmlBindingCommandKind = "SPELL" | "ITEM" | "MACRO";

/** A spell, item or macro name as a command's tail, or undefined for what cannot be one. */
function commandValue(kind: FrameXmlBindingCommandKind, value: unknown): string | undefined {
  if (kind === "MACRO" && typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 255 ? trimmed : undefined;
}

/** A Lua `isPriority` argument: nil and false are normal, anything else priority. */
function luaTrue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0;
}

type Row = readonly [command: string, action: InputAction];

function numbered(prefix: string, actionPrefix: string, count: number): Row[] {
  return Array.from({ length: count }, (_, index) =>
    [`${prefix}${index + 1}`, `${actionPrefix}${index + 1}` as InputAction] as const);
}

/**
 * Bindings.xml's sections that this client can answer, in the file's own order (Interface/FrameXML/
 * Bindings.xml in the client MPQs: MOVEMENT, CHAT, ACTIONBAR, TARGETING, INTERFACE, MISC,
 * MULTIACTIONBAR and its BLANK4-6 continuations), each row a stock command and the WebClient action
 * that does it. Within a section the rows keep Bindings.xml's order.
 */
export const FRAMEXML_STOCK_BINDING_SECTIONS: readonly { readonly header: string; readonly rows: readonly Row[] }[] = withStockRows([
  { header: "MOVEMENT", rows: [
    ["MOVEFORWARD", "moveForward"], ["MOVEBACKWARD", "moveBackward"],
    ["TURNLEFT", "turnLeft"], ["TURNRIGHT", "turnRight"],
    ["STRAFELEFT", "strafeLeft"], ["STRAFERIGHT", "strafeRight"],
    ["JUMP", "jump"], ["SITORSTAND", "sitOrStand"],
    ["TOGGLEAUTORUN", "toggleAutoRun"], ["TOGGLERUN", "toggleWalkRun"],
  ] },
  { header: "CHAT", rows: [["OPENCHAT", "openChat"], ["OPENCHATSLASH", "openChatSlash"], ["REPLY", "replyWhisper"]] },
  { header: "ACTIONBAR", rows: [...numbered("ACTIONBUTTON", "action", 12), ...numbered("ACTIONPAGE", "actionPage", 6)] },
  { header: "TARGETING", rows: [
    ["TARGETNEARESTENEMY", "targetNearestEnemy"], ["TARGETPREVIOUSENEMY", "targetPreviousEnemy"],
    ["TARGETSELF", "targetSelf"], ["NAMEPLATES", "toggleNamePlates"],
    ["INTERACTTARGET", "interact"], ["ATTACKTARGET", "attackTarget"],
    ["PETATTACK", "petAttack"], ["FOCUSTARGET", "setFocus"],
  ] },
  { header: "INTERFACE", rows: [
    // TOGGLECHARACTER4 is TogglePVPFrame and TOGGLECHARACTER1 ToggleCharacter("SkillFrame")
    // (Bindings.xml:647, :656). This client's bag key opens every bag, which is OPENALLBAGS.
    ["TOGGLECHARACTER0", "toggleCharacter"], ["OPENALLBAGS", "toggleBags"],
    ["TOGGLEKEYRING", "toggleKeyring"], ["TOGGLESPELLBOOK", "toggleSpellbook"],
    ["TOGGLETALENTS", "toggleTalents"], ["TOGGLECHARACTER4", "togglePvp"],
    ["TOGGLECHARACTER1", "toggleProfessions"], ["TOGGLEQUESTLOG", "toggleQuestLog"],
    ["TOGGLEWORLDMAP", "toggleWorldMap"], ["TOGGLELFGPARENT", "toggleLfd"],
  ] },
  { header: "MISC", rows: [["TOGGLEFPS", "toggleFps"]] },
  // DEC-B 3.11: Bindings.xml's CAMERA section — its view rows are input/StockActions.ts rows (withStockRows);
  // CAMERAZOOMIN/OUT, the wheel's, stay out.
  { header: "CAMERA", rows: [] },
  // The multi-bars' keys are the native extra rows' actions; the slot a key presses follows the HUD
  // on screen (Actions.runAction: under the stock HUD, the stock bar's own page — WORK_PLAN 4.16a).
  { header: "MULTIACTIONBAR", rows: numbered("MULTIACTIONBAR1BUTTON", "bottomLeftAction", 12) },
  { header: "BLANK4", rows: numbered("MULTIACTIONBAR2BUTTON", "bottomRightAction", 12) },
  { header: "BLANK5", rows: numbered("MULTIACTIONBAR3BUTTON", "rightAction", 12) },
  { header: "BLANK6", rows: numbered("MULTIACTIONBAR4BUTTON", "right2Action", 12) },
  // 11.02-input: Bindings.xml's VEHICLE section (after RAID_TARGET, which this client does not answer): its
  // nine rows are all input/StockActions.ts rows, which withStockRows puts here.
  { header: "VEHICLE", rows: [] },
// The stock commands added by 3.11 (input/StockActions.ts) join their own sections in Bindings.xml order.
], STOCK_ACTIONS);

const STOCK_COMMAND_OF = new Map<InputAction, string>();
for (const section of FRAMEXML_STOCK_BINDING_SECTIONS) {
  for (const [command, action] of section.rows) STOCK_COMMAND_OF.set(action, command);
}

/** The WebClient-only actions, in `INPUT_ACTIONS` order: every action no stock row answers. */
export const FRAMEXML_WEBCLIENT_BINDING_ROWS: readonly (readonly [command: string, action: InputAction, label: string])[] =
  INPUT_ACTIONS.filter((entry) => !STOCK_COMMAND_OF.has(entry.action))
    .map((entry) => [`${WEBCLIENT_COMMAND_PREFIX}${entry.action.toUpperCase()}`, entry.action, entry.label] as const);

const ACTION_OF_COMMAND = new Map<string, InputAction>();
for (const section of FRAMEXML_STOCK_BINDING_SECTIONS) {
  for (const [command, action] of section.rows) ACTION_OF_COMMAND.set(command, action);
}
for (const [command, action] of FRAMEXML_WEBCLIENT_BINDING_ROWS) ACTION_OF_COMMAND.set(command, action);
const COMMAND_OF_ACTION = new Map<InputAction, string>([...ACTION_OF_COMMAND].map(([command, action]) => [action, command]));

/** The stock command (or WEBCLIENT_ one) a WebClient action answers to. */
export function frameXmlBindingCommand(action: InputAction): string {
  return COMMAND_OF_ACTION.get(action)!;
}

// ---- key names ------------------------------------------------------------------------------

/**
 * `event.code` to the client's key name. Letters and digits are themselves, punctuation is the
 * character it prints on a US layout (the client's names are layout-independent too), and the
 * named keys are the KEY_* suffixes of GlobalStrings.lua (KEY_NUMPADDIVIDE, KEY_PAGEUP, …).
 * `NumpadEnter` has no key of its own in the client (there is no KEY_NUMPADENTER); it keeps a
 * distinct name here because the table can hold it apart from Enter.
 */
const CODE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  Space: "SPACE", Enter: "ENTER", Tab: "TAB", Escape: ESCAPE_KEY, Backspace: "BACKSPACE",
  Insert: "INSERT", Delete: "DELETE", Home: "HOME", End: "END", PageUp: "PAGEUP", PageDown: "PAGEDOWN",
  ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
  NumLock: "NUMLOCK", CapsLock: "CAPSLOCK", ScrollLock: "SCROLLLOCK", Pause: "PAUSE", PrintScreen: "PRINTSCREEN",
  NumpadDecimal: "NUMPADDECIMAL", NumpadDivide: "NUMPADDIVIDE", NumpadMultiply: "NUMPADMULTIPLY",
  NumpadSubtract: "NUMPADMINUS", NumpadAdd: "NUMPADPLUS", NumpadEnter: "NUMPADENTER",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  ShiftLeft: "LSHIFT", ShiftRight: "RSHIFT", ControlLeft: "LCTRL", ControlRight: "RCTRL",
  AltLeft: "LALT", AltRight: "RALT",
});
const KEY_CODES = new Map<string, string>(Object.entries(CODE_KEYS).map(([code, key]) => [key, code]));
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["LSHIFT", "RSHIFT", "LCTRL", "RCTRL", "LALT", "RALT"]);

/**
 * Every other key the browser reports is named by its code in capitals (`IntlBackslash`, the key
 * beside the left Shift on an ISO keyboard, is `INTLBACKSLASH`; `ContextMenu` is `CONTEXTMENU`).
 * The native window binds any key but a modifier, so a key without a name here was one the stock
 * window could neither show nor unbind (and its second key showed as the first). The client has no
 * such names, so one is accepted back only after a real code produced it — a press, or a saved
 * chord read by GetBindingKey — and an add-on's `BUTTON3` never becomes a chord. Meta is a
 * modifier the table never stores (`Bindings.chordOf`).
 */
const OTHER_CODES = new Map<string, string>();
const OTHER_CODE = /^[A-Z][A-Za-z0-9]*$/;
const UNNAMED_CODE = /^(?:Meta|OS)(?:Left|Right)$/;

/**
 * The client's name for one physical key, without modifiers: what the client hands a keyboard-
 * enabled frame's OnKeyDown. `UNKNOWN` for a key it has no name for (the stock handler ignores it).
 */
export function frameXmlKeyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `NUMPAD${code.slice(6)}`;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const named = CODE_KEYS[code];
  if (named !== undefined) return named;
  if (!OTHER_CODE.test(code) || UNNAMED_CODE.test(code)) return "UNKNOWN";
  const key = code.toUpperCase();
  if (KEY_CODES.has(key) || key === "UNKNOWN") return "UNKNOWN";
  OTHER_CODES.set(key, code);
  return key;
}

function codeOfKey(key: string): string | undefined {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^NUMPAD[0-9]$/.test(key)) return `Numpad${key.slice(6)}`;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  return KEY_CODES.get(key) ?? OTHER_CODES.get(key);
}

const MODIFIER_PREFIXES = [["ALT-", "Alt"], ["CTRL-", "Ctrl"], ["SHIFT-", "Shift"]] as const;

/**
 * A client key (`ALT-CTRL-SHIFT-X`, prefixes in any order, the key itself may be `-`) as the
 * table's chord (`Ctrl+Alt+Shift+KeyX`), or undefined for what the table cannot hold: a mouse
 * button, the wheel, a bare modifier, an unknown name, and Escape (the game menu's, fixed).
 */
export function frameXmlKeyToChord(key: unknown): string | undefined {
  if (typeof key !== "string" || key.length === 0) return undefined;
  let rest = key.toUpperCase();
  const held = new Set<string>();
  for (let matched = true; matched;) {
    matched = false;
    for (const [prefix, name] of MODIFIER_PREFIXES) {
      if (rest.length > prefix.length && rest.startsWith(prefix) && !held.has(name)) {
        held.add(name);
        rest = rest.slice(prefix.length);
        matched = true;
      }
    }
  }
  if (rest === ESCAPE_KEY || MODIFIER_KEYS.has(rest)) return undefined;
  const code = codeOfKey(rest);
  if (!code) return undefined;
  // Bindings.chordOf's order, so the same press always spells the same chord.
  return [...["Ctrl", "Alt", "Shift"].filter((name) => held.has(name)), code].join("+");
}

/** The table's chord as the client's key name, or undefined for a code the client has no name for. */
export function frameXmlChordToKey(chord: string): string | undefined {
  if (!chord) return undefined;
  const parts = chord.split("+");
  const code = parts.pop()!;
  const key = frameXmlKeyName(code);
  if (key === "UNKNOWN" || MODIFIER_KEYS.has(key)) return undefined;
  const held = new Set(parts);
  return `${held.has("Alt") ? "ALT-" : ""}${held.has("Ctrl") ? "CTRL-" : ""}${held.has("Shift") ? "SHIFT-" : ""}${key}`;
}

/**
 * The command a listed module action answers to: `WEBCLIENT_MODULE_` and its id without the
 * `module:` prefix, in capitals, every run of other characters one `_`; a numbered suffix when an
 * earlier action already took the name.
 */
export function frameXmlModuleBindingCommand(action: string, taken: ReadonlySet<string> = new Set()): string {
  const stem = action.replace(/^module:/i, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "ACTION";
  let command = `${MODULE_COMMAND_PREFIX}${stem}`;
  for (let suffix = 2; taken.has(command); suffix += 1) command = `${MODULE_COMMAND_PREFIX}${stem}_${suffix}`;
  return command;
}

// ---- the model ------------------------------------------------------------------------------

export interface FrameXmlBindingHost {
  /** The verb behind a compiled-in action (`Actions.runAction`); answers whether it did anything. */
  runAction?(action: InputAction): boolean;
  /** L8 5.09: the held machinery (input/MovementCommands.ts); the one Controls registers when absent. */
  movement?: MovementCommandInput;
}

type Snapshot = ReadonlyMap<string, BindingPair>;

/** `GetBinding`'s rows and the module aliases they use, rebuilt when the module actions change. */
interface BindingIndex {
  readonly signature: string;
  readonly rows: readonly (readonly [command: string, action?: string])[];
  readonly byAlias: ReadonlyMap<string, ModuleAction>;
  readonly aliasOf: ReadonlyMap<string, string>;
}

/** How often, in seam seconds, `tick` looks for a key changed outside this API. */
const OUTSIDE_CHANGE_SECONDS = 0.25;

/** A SetBindingClick action's command: the client's own `CLICK <button>:<mouse button>`. */
function clickCommand(button: string, mouseButton: string): string {
  return `CLICK ${button}:${mouseButton}`;
}

/**
 * The binding half of the world seam. Reads are answered from the live table on every call (the
 * native window, a module load or a reset may have changed it); writes go through `bindKey` and
 * `resetBindings`, which persist, and end in one coalesced UPDATE_BINDINGS.
 */
export class FrameXmlBindingModel {
  readonly #host: FrameXmlBindingHost;
  #pump: FrameXmlSeamPump | undefined;
  #snapshot: Snapshot | undefined;
  #click: ((button: string, mouseButton: string) => void) | undefined;
  #runCommand: ((kind: FrameXmlBindingCommandKind, value: string) => void) | undefined;
  #updateQueued = false;
  #seen: readonly BindingPair[] = [];
  #seenModules = "";
  #checkedAt = Number.NEGATIVE_INFINITY;
  #index: BindingIndex | undefined;

  constructor(host: FrameXmlBindingHost = {}) {
    this.#host = host;
    this.#remember();
  }

  attach(pump: FrameXmlSeamPump): void {
    this.#pump = pump;
    this.#remember();
  }

  detach(): void {
    this.#pump = undefined;
    this.#snapshot = undefined;
    this.#click = undefined;
    // A CLICK action's run() would press a button of the VM that is going away. The key stays in
    // the table's module blob and comes back with the add-on's next SetBindingClick.
    removeModuleActions(FRAMEXML_CLICK_BINDING_MODULE);
    // The same for SetBindingSpell/Item/Macro (3.11 D); the overrides belonged to this VM's frames.
    removeModuleActions(FRAMEXML_COMMAND_BINDING_MODULE);
    this.#runCommand = undefined;
    clearAllOverrideBindings();
  }

  /**
   * How a `SPELL`, `ITEM` or `MACRO` binding is pressed: the mount runs the stock
   * `CastSpellByName`, `UseItemByName` or `RunMacro` in its VM (FrameXmlMacroBindingMount.ts).
   */
  setCommandRunner(run: ((kind: FrameXmlBindingCommandKind, value: string) => void) | undefined): void {
    this.#runCommand = run;
  }

  /** The stock button press behind a CLICK binding; the mount supplies it once the VM exists. */
  setClicker(click: ((button: string, mouseButton: string) => void) | undefined): void {
    this.#click = click;
  }

  /**
   * UPDATE_BINDINGS for a change made outside this API — the native window, a reset there, a module
   * adding or dropping an action. The comparison is by pair identity (the table replaces a pair
   * when it changes it) and runs at most every {@link OUTSIDE_CHANGE_SECONDS} of seam time: nothing
   * outside this API changes a key faster than a person presses one.
   */
  tick(now?: number): void {
    if (now !== undefined) {
      if (now - this.#checkedAt < OUTSIDE_CHANGE_SECONDS) return;
      this.#checkedAt = now;
    }
    const current = this.#pairs();
    const modules = this.#moduleSignature();
    let changed = current.length !== this.#seen.length || modules !== this.#seenModules;
    for (let index = 0; !changed && index < current.length; index += 1) changed = current[index] !== this.#seen[index];
    if (!changed) return;
    this.#seen = current;
    this.#seenModules = modules;
    this.#pump?.fire("UPDATE_BINDINGS");
  }

  #pairs(): BindingPair[] {
    return INPUT_ACTIONS.map((entry) => keysOf(entry.action));
  }

  #moduleSignature(): string {
    let signature = "";
    for (const entry of moduleActions()) signature += `${entry.action}\u0001${keysOf(entry.action).join("\u0002")}\u0003`;
    return signature;
  }

  #remember(): void {
    this.#seen = this.#pairs();
    this.#seenModules = this.#moduleSignature();
  }

  /** One UPDATE_BINDINGS after the Lua call chain that changed the table has returned. */
  #changed(): void {
    this.#remember();
    if (this.#updateQueued) return;
    this.#updateQueued = true;
    queueMicrotask(() => {
      this.#updateQueued = false;
      this.#pump?.fire("UPDATE_BINDINGS");
    });
  }

  /** `GetBinding`'s rows and the module aliases, rebuilt only when the module actions change. */
  #indexed(): BindingIndex {
    const modules = moduleActions().filter((entry) => entry.module !== FRAMEXML_CLICK_BINDING_MODULE
      && entry.module !== FRAMEXML_COMMAND_BINDING_MODULE);
    const signature = modules.map((entry) => entry.action).join("\u0001");
    if (this.#index?.signature === signature) return this.#index;
    const rows: (readonly [command: string, action?: string])[] = [];
    for (const section of FRAMEXML_STOCK_BINDING_SECTIONS) {
      rows.push([`HEADER_${section.header}`]);
      for (const [command, action] of section.rows) rows.push([command, action]);
    }
    if (FRAMEXML_WEBCLIENT_BINDING_ROWS.length > 0) {
      rows.push([FRAMEXML_WEBCLIENT_HEADER]);
      for (const [command, action] of FRAMEXML_WEBCLIENT_BINDING_ROWS) rows.push([command, action]);
    }
    const byAlias = new Map<string, ModuleAction>();
    const aliasOf = new Map<string, string>();
    if (modules.length > 0) {
      rows.push([FRAMEXML_WEBCLIENT_MODULES_HEADER]);
      for (const entry of modules) {
        const alias = frameXmlModuleBindingCommand(entry.action, new Set(byAlias.keys()));
        byAlias.set(alias, entry);
        aliasOf.set(entry.action, alias);
        rows.push([alias, entry.action]);
      }
    }
    this.#index = { signature, rows, byAlias, aliasOf };
    return this.#index;
  }

  /** A registered module action by its alias, or a CLICK action by its own command. */
  #moduleAction(command: string): ModuleAction | undefined {
    const aliased = this.#indexed().byAlias.get(command);
    if (aliased) return aliased;
    const click = moduleActions().find((entry) => entry.action === command);
    return click?.module === FRAMEXML_CLICK_BINDING_MODULE || click?.module === FRAMEXML_COMMAND_BINDING_MODULE
      ? click : undefined;
  }

  /** The table's action name for a command: a compiled-in action, a listed module action or a CLICK. */
  #action(command: unknown): string | undefined {
    if (typeof command !== "string" || command.length === 0) return undefined;
    return ACTION_OF_COMMAND.get(command) ?? this.#moduleAction(command)?.action;
  }

  #keys(action: string): string[] {
    return keysOf(action).map(frameXmlChordToKey).filter((key): key is string => key !== undefined);
  }

  /** `GetNumBindings()`. */
  count(): number {
    return this.#indexed().rows.length;
  }

  /** `GetBinding(index)`: the command and every key on it; a header row has no keys. */
  binding(index: unknown): readonly unknown[] {
    const row = this.#indexed().rows[Math.trunc(Number(index)) - 1];
    if (!row) return [];
    return row[1] === undefined ? [row[0]] : [row[0], ...this.#keys(row[1])];
  }

  /** `GetBindingKey(command)`: every key on it, primary first, or nothing. */
  bindingKey(command: unknown): readonly string[] {
    if (command === FRAMEXML_GAME_MENU_COMMAND) return [ESCAPE_KEY];
    if (typeof command !== "string") return [];
    // A CLICK action unloaded right now still has the key the player gave it.
    return this.#keys(this.#action(command) ?? command);
  }

  /**
   * `GetBindingAction(key[, checkOverride])` and `GetBindingByKey(key)`: the command a key runs, or
   * undefined; with `checkOverride` an override binding's command first (3.11 D).
   */
  bindingAction(key: unknown, checkOverride?: unknown): string | undefined {
    if (typeof key === "string" && key.toUpperCase() === ESCAPE_KEY) return FRAMEXML_GAME_MENU_COMMAND;
    const chord = frameXmlKeyToChord(key);
    if (!chord) return undefined;
    if (luaTrue(checkOverride)) {
      const override = overrideFor(chord);
      if (override) return override.command;
    }
    const core = actionFor(chord);
    if (core) return frameXmlBindingCommand(core);
    const module = moduleActionFor(chord);
    return module ? this.#indexed().aliasOf.get(module.action) ?? module.action : undefined;
  }

  /** The label a WebClient-only, module or CLICK command shows where BINDING_NAME_* has none. */
  label(command: unknown): string | undefined {
    if (typeof command !== "string") return undefined;
    const own = FRAMEXML_WEBCLIENT_BINDING_ROWS.find(([name]) => name === command);
    if (own) return own[2];
    return this.#moduleAction(command)?.label;
  }

  #snapshotBeforeChange(): void {
    if (this.#snapshot) return;
    const snapshot = new Map<string, BindingPair>();
    for (const entry of INPUT_ACTIONS) snapshot.set(entry.action, keysOf(entry.action));
    for (const entry of moduleActions()) snapshot.set(entry.action, keysOf(entry.action));
    // A module that is not loaded keeps its key in the blob as well, and Defaults (resetBindings)
    // clears the blob whole: without these rows, Defaults then Cancel lost that key for good.
    for (const action of savedModuleBindingActions()) if (!snapshot.has(action)) snapshot.set(action, keysOf(action));
    this.#snapshot = snapshot;
  }

  #unbind(chord: string): boolean {
    let changed = false;
    const actions = [...INPUT_ACTIONS.map((entry) => entry.action as string), ...moduleActions().map((entry) => entry.action)];
    for (const action of actions) {
      const pair = keysOf(action);
      for (const slot of [0, 1] as const) {
        if (pair[slot] !== chord) continue;
        bindKey(action, slot, "");
        changed = true;
      }
    }
    return changed;
  }

  #bind(action: string, chord: string): void {
    const [primary, secondary] = keysOf(action);
    if (primary === chord || secondary === chord) return;
    // The stock window unbinds both keys and binds them back in the order it wants them
    // (KeyBindingFrame_OnKeyDown), so «the first empty slot» is exactly its key1/key2. A third key
    // from an add-on replaces the second: the table holds two per action.
    bindKey(action, primary ? 1 : 0, chord);
  }

  /** `SetBinding(key, command)`: nil unbinds the key. False for a key or command this client cannot hold. */
  setBinding(key: unknown, command: unknown): boolean {
    const chord = frameXmlKeyToChord(key);
    if (!chord) return false;
    if (command === undefined || command === null || command === "") {
      this.#snapshotBeforeChange();
      if (this.#unbind(chord)) this.#changed();
      return true;
    }
    const action = this.#action(command);
    if (!action) return false;
    this.#snapshotBeforeChange();
    this.#bind(action, chord);
    this.#changed();
    return true;
  }

  /**
   * `SetBindingClick(key, button[, mouseButton])`: the key clicks a named stock button. The CLICK
   * command becomes a module action of its own (never listed), so `Controls` dispatches it like any
   * module key and the key is saved in the module blob beside the others.
   */
  setBindingClick(key: unknown, button: unknown, mouseButton: unknown): boolean {
    if (typeof button !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(button)) return false;
    const mouse = typeof mouseButton === "string" && mouseButton ? mouseButton : "LeftButton";
    const command = clickCommand(button, mouse);
    if (!moduleActions().some((entry) => entry.action === command)) {
      addModuleAction({
        action: command,
        module: FRAMEXML_CLICK_BINDING_MODULE,
        group: "FrameXML",
        label: `${button} (${mouse})`,
        run: () => this.#click?.(button, mouse),
      });
    }
    return this.setBinding(key, command);
  }

  /**
   * `SetBindingSpell(key, spell)`, `SetBindingItem(key, item)`, `SetBindingMacro(key, macro)`: the
   * key casts, uses or runs it. Like a CLICK binding the command (`SPELL Огненный шар`) becomes an
   * unlisted module action, saved in the module blob; it presses through the mount's runner.
   */
  setBindingCommand(kind: FrameXmlBindingCommandKind, key: unknown, value: unknown): boolean {
    const name = commandValue(kind, value);
    if (!name) return false;
    const command = `${kind} ${name}`;
    if (!moduleActions().some((entry) => entry.action === command)) {
      addModuleAction({
        action: command,
        module: FRAMEXML_COMMAND_BINDING_MODULE,
        group: "FrameXML",
        label: name,
        run: () => this.#runCommand?.(kind, name),
      });
    }
    return this.setBinding(key, command);
  }

  /**
   * `SetOverrideBinding(owner, isPriority, key, command)`: the key runs a command (stock, `SPELL x`,
   * `ITEM x`, `MACRO x`, `CLICK b:m`) for as long as `owner` keeps it; nil gives it back. `owner`
   * is the frame's identity as the prelude hands it over (`tostring(frame)`).
   */
  setOverride(owner: unknown, priority: unknown, key: unknown, command: unknown): boolean {
    const chord = frameXmlKeyToChord(key);
    if (typeof owner !== "string" || !chord) return false;
    if (command === undefined || command === null || command === "") {
      setOverrideBinding(owner, chord, undefined);
      this.#changed();
      return true;
    }
    if (typeof command !== "string") return false;
    const special = /^(SPELL|ITEM|MACRO) (.+)$/.exec(command);
    if (special) return this.setOverrideCommand(owner, priority, key, special[1] as FrameXmlBindingCommandKind, special[2]);
    const click = /^CLICK ([A-Za-z_][A-Za-z0-9_]*)(?::(.+))?$/.exec(command);
    if (click) return this.setOverrideClick(owner, priority, key, click[1], click[2]);
    if (!this.#action(command)) return false;
    // L2 3.11: `action` — a movement command is held by Controls while the key is down (runOnUp).
    setOverrideBinding(owner, chord, {
      owner, priority: luaTrue(priority), command, action: ACTION_OF_COMMAND.get(command), run: () => this.run(command, "down"),
    });
    this.#changed();
    return true;
  }

  /** `SetOverrideBindingSpell/Item/Macro(owner, isPriority, key, value)`. */
  setOverrideCommand(owner: unknown, priority: unknown, key: unknown, kind: FrameXmlBindingCommandKind, value: unknown): boolean {
    const chord = frameXmlKeyToChord(key);
    const name = commandValue(kind, value);
    if (typeof owner !== "string" || !chord || !name) return false;
    setOverrideBinding(owner, chord, {
      owner, priority: luaTrue(priority), command: `${kind} ${name}`, run: () => this.#runCommand?.(kind, name),
    });
    this.#changed();
    return true;
  }

  /** `SetOverrideBindingClick(owner, isPriority, key, button[, mouseButton])`. */
  setOverrideClick(owner: unknown, priority: unknown, key: unknown, button: unknown, mouseButton: unknown): boolean {
    const chord = frameXmlKeyToChord(key);
    if (typeof owner !== "string" || !chord || typeof button !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(button)) return false;
    const mouse = typeof mouseButton === "string" && mouseButton ? mouseButton : "LeftButton";
    setOverrideBinding(owner, chord, {
      owner, priority: luaTrue(priority), command: clickCommand(button, mouse), run: () => this.#click?.(button, mouse),
    });
    this.#changed();
    return true;
  }

  /** `ClearOverrideBindings(owner)`. */
  clearOverrides(owner: unknown): void {
    if (typeof owner !== "string") return;
    clearOverrideBindings(owner);
    this.#changed();
  }

  /** `SaveBindings(which)`: the table has already persisted; the stock Cancel point moves here. */
  save(): void {
    this.#snapshot = undefined;
  }

  /**
   * `LoadBindings(which)`: DEFAULT_BINDINGS resets the table (unsaved until SaveBindings, like the
   * client's Reset button); ACCOUNT_BINDINGS and CHARACTER_BINDINGS take back every change made
   * through this API since the last Save or Load.
   */
  load(which: unknown): void {
    if (Number(which) === FRAMEXML_DEFAULT_BINDINGS) {
      this.#snapshotBeforeChange();
      resetBindings();
      this.#changed();
      return;
    }
    const snapshot = this.#snapshot;
    this.#snapshot = undefined;
    if (!snapshot) return;
    // Clear every slot that differs first: a chord moving between two actions must not be stolen
    // back from the action it is being restored to.
    const differing: [string, 0 | 1, string][] = [];
    for (const [action, pair] of snapshot) {
      const current = keysOf(action);
      for (const slot of [0, 1] as const) if (current[slot] !== pair[slot]) differing.push([action, slot, pair[slot]]);
    }
    // A module row that got its first key after the snapshot (a CLICK binding, a module loaded since)
    // had none before it.
    for (const action of savedModuleBindingActions()) {
      if (snapshot.has(action)) continue;
      const current = keysOf(action);
      for (const slot of [0, 1] as const) if (current[slot]) differing.push([action, slot, ""]);
    }
    for (const [action, slot] of differing) bindKey(action, slot, "");
    for (const [action, slot, chord] of differing) if (chord) bindKey(action, slot, chord);
    this.#changed();
  }

  /** `GetCurrentBindingSet()`: this client keeps one set, the account's. */
  currentSet(): number {
    return FRAMEXML_ACCOUNT_BINDINGS;
  }

  /**
   * `RunBinding(command[, keystate])`: the command's verb, once, on the way down. A held movement
   * action has no verb here (Controls starts and stops it with the key), so it runs nothing.
   * L8 5.09: it has now — a held command (MOVEFORWARD, JUMP, PITCHUP, VEHICLEAIMUP…) is held on the way down
   * and let go on "up", as its runOnUp body does (MoveForwardStart / MoveForwardStop); StackSplitFrame and
   * CoinPickupFrame pass the keys they do not use through this pair.
   */
  run(command: unknown, keystate: unknown): void {
    // L8 5.09: a held command, both ways.
    const held = typeof command === "string" ? ACTION_OF_COMMAND.get(command) : undefined;
    if (held !== undefined && HELD_ACTIONS.has(held)) {
      this.hold(held, keystate !== "up");
      return;
    }
    if (keystate === "up") return;
    if (typeof command !== "string") return;
    const core = ACTION_OF_COMMAND.get(command);
    if (core) {
      this.#host.runAction?.(core);
      return;
    }
    this.#moduleAction(command)?.run();
  }

  /** L8 5.09: the held machinery — the host's, else the one Controls registered (none offline). */
  #movement(): MovementCommandInput | undefined {
    return this.#host.movement ?? movementCommandInput();
  }

  /** L8 5.09: a held command down or up, as its key (MoveForwardStart/Stop, RunBinding with keystate). */
  hold(action: InputAction, down: boolean): void {
    this.#movement()?.hold(action, down);
  }

  /** L8 5.09: TurnOrAction (1) or CameraOrSelectOrMove (2) down or up (input/MovementCommands.ts). */
  mouseButton(bit: number, down: boolean): void {
    this.#movement()?.button(bit, down);
  }

  /** L8 5.09: IsMouselooking. */
  mouselooking(): boolean {
    return this.#movement()?.mouselooking() === true;
  }
}

/**
 * The offline preview (framexml.html) keeps the key table in memory, from the defaults. The page
 * shares its origin (127.0.0.1:5173) with the live client, so the canned KeyBindingFrame, which
 * writes through the one real table, rebound the player's saved keys (`webclient.keybindings.v1`).
 */
export function isolateFrameXmlPreviewBindings(): void {
  const values = new Map<string, string>();
  useBindingStorage({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
}

const NOTHING: readonly unknown[] = Object.freeze([]);

/**
 * The binding C API. Without a model (a seam that has none) every name answers what F2's neutral
 * table answered, so the corpus reads an empty table rather than a missing function.
 */
export const FRAMEXML_BINDING_BINDINGS: Readonly<Record<string, FrameXmlSeamBinding>> = Object.freeze({
  GetNumBindings: (seam) => [seam.keyBindings?.count() ?? 0],
  GetBinding: (seam, args) => seam.keyBindings?.binding(args[0]) ?? NOTHING,
  GetBindingKey: (seam, args) => seam.keyBindings?.bindingKey(args[0]) ?? NOTHING,
  GetBindingAction: (seam, args) => [seam.keyBindings?.bindingAction(args[0], args[1]) ?? ""],
  // UIParent.lua's GetBindingFromClick adds the held modifiers and asks this.
  GetBindingByKey: (seam, args) => {
    const command = seam.keyBindings?.bindingAction(args[0]);
    return command === undefined ? NOTHING : [command];
  },
  SetBinding: (seam, args) => [seam.keyBindings?.setBinding(args[0], args[1]) ?? false],
  SetBindingClick: (seam, args) => [seam.keyBindings?.setBindingClick(args[0], args[1], args[2]) ?? false],
  // 3.11 D: the spell, item and macro bindings, and the override family. The owner of an override
  // arrives as `tostring(frame)` (FRAMEXML_BINDING_PRELUDE).
  SetBindingSpell: (seam, args) => [seam.keyBindings?.setBindingCommand("SPELL", args[0], args[1]) ?? false],
  SetBindingItem: (seam, args) => [seam.keyBindings?.setBindingCommand("ITEM", args[0], args[1]) ?? false],
  SetBindingMacro: (seam, args) => [seam.keyBindings?.setBindingCommand("MACRO", args[0], args[1]) ?? false],
  SetOverrideBinding: (seam, args) => { seam.keyBindings?.setOverride(args[0], args[1], args[2], args[3]); return NOTHING; },
  SetOverrideBindingSpell: (seam, args) => {
    seam.keyBindings?.setOverrideCommand(args[0], args[1], args[2], "SPELL", args[3]);
    return NOTHING;
  },
  SetOverrideBindingItem: (seam, args) => {
    seam.keyBindings?.setOverrideCommand(args[0], args[1], args[2], "ITEM", args[3]);
    return NOTHING;
  },
  SetOverrideBindingMacro: (seam, args) => {
    seam.keyBindings?.setOverrideCommand(args[0], args[1], args[2], "MACRO", args[3]);
    return NOTHING;
  },
  SetOverrideBindingClick: (seam, args) => {
    seam.keyBindings?.setOverrideClick(args[0], args[1], args[2], args[3], args[4]);
    return NOTHING;
  },
  ClearOverrideBindings: (seam, args) => { seam.keyBindings?.clearOverrides(args[0]); return NOTHING; },
  SaveBindings: (seam) => { seam.keyBindings?.save(); return NOTHING; },
  LoadBindings: (seam, args) => { seam.keyBindings?.load(args[0]); return NOTHING; },
  GetCurrentBindingSet: (seam) => [seam.keyBindings?.currentSet() ?? FRAMEXML_ACCOUNT_BINDINGS],
  RunBinding: (seam, args) => { seam.keyBindings?.run(args[0], args[1]); return NOTHING; },
  WebClientBindingLabel: (seam, args) => {
    const label = seam.keyBindings?.label(args[0]);
    return label === undefined ? NOTHING : [label];
  },
  // L8 5.09: the movement C API the MOVEMENT bodies call (FrameXmlMovementApi.ts), through the same model.
  ...FRAMEXML_MOVEMENT_BINDINGS,
});

/**
 * Appended to FRAMEXML_SEAM_PRELUDE: the BINDING_ strings of the WebClient rows.
 *
 * KeyBindingFrame_Update reads a header as `_G["BINDING_" .. command]` and a row's label through
 * UIParent.lua's GetBindingText(command, "BINDING_NAME_"), which is `_G["BINDING_NAME_" .. command]`
 * with the command itself as the fallback. The two headers are constants; a row's label is set the
 * first time GetBinding lists it (its WebClient label, or a module action's own), because module
 * actions come and go after boot. A string GlobalStrings.lua already defines is never replaced.
 */
export const FRAMEXML_BINDING_PRELUDE = `
do
  local impl = __fxNeutralImpl
  local label = rawget(_G, "__fxSeam_WebClientBindingLabel")
  local getBinding = impl ~= nil and impl.GetBinding or nil
  -- 3.11 D: an override's owner is a frame; the host keys it by the frame's identity string.
  if impl ~= nil then
    for _, name in ipairs({ "SetOverrideBinding", "SetOverrideBindingSpell", "SetOverrideBindingItem",
        "SetOverrideBindingMacro", "SetOverrideBindingClick", "ClearOverrideBindings" }) do
      local original = impl[name]
      if original ~= nil then
        impl[name] = function(owner, ...)
          if owner == nil then return end
          return original(tostring(owner), ...)
        end
      end
    end
  end
  BINDING_HEADER_WEBCLIENT = "WebClient"
  BINDING_HEADER_WEBCLIENT_MODULES = "WebClient: модули"
  if label ~= nil and getBinding ~= nil then
    local rawget, rawset, type, pack, unpack = rawget, rawset, type, table.pack, table.unpack
    impl.GetBinding = function(...)
      local results = pack(getBinding(...))
      local command = results[1]
      if type(command) == "string" and rawget(_G, "BINDING_NAME_" .. command) == nil then
        local own = label(command)
        if own ~= nil then rawset(_G, "BINDING_NAME_" .. command, own) end
      end
      return unpack(results, 1, results.n)
    end
  end
end
`;
