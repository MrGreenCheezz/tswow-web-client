import {
  INPUT_ACTIONS, bindKey, describeChord, chordOf, keysOf, moduleActions, onBindingsChanged, resetBindings,
} from "../input/Bindings.js";
import { frameXmlBindingCommand } from "../framexml/FrameXmlBinding.js";
import { nativeString } from "./Strings.js";
import { showActionBar } from "./ActionBar.js";
import { Panel } from "./Widgets.js";
import {
  closeFrameXmlKeyBindings, frameXmlKeyBindingsOpen, toggleFrameXmlKeyBindings,
} from "../framexml/FrameXmlBindingController.js";

/**
 * The bindings window: one row per action, two keys each.
 *
 * Built out of the widget kit and the one table, which is the whole reason both exist. Nothing in
 * the page markup describes this window and nothing needs to — adding an action to
 * `INPUT_ACTIONS` puts a row here without a line being written.
 */
let panel: Panel | undefined;
/** Which slot is waiting for a key press. Null while the window is only being read. */
let capturing: { action: string; label: string; slot: 0 | 1; button: HTMLButtonElement } | undefined;

function bindingLabel(action: string, label: string, slot: 0 | 1): string {
  const slotName = slot === 0 ? "основная" : "дополнительная";
  const key = describeChord(keysOf(action)[slot]);
  return `${label}, ${slotName} клавиша: ${key === "—" ? "не назначена" : key}`;
}

function stopCapture(): void {
  if (!capturing) return;
  const { action, label, slot, button } = capturing;
  button.classList.remove("ui-binding-capturing");
  button.textContent = describeChord(keysOf(action)[slot]);
  button.setAttribute("aria-label", bindingLabel(action, label, slot));
  capturing = undefined;
}

/**
 * Swallows the next key press and puts it on the waiting slot.
 *
 * Registered on the capture phase so it runs before the ordinary controls: without that, pressing
 * `W` to bind it would also start the character running, and pressing `Escape` to cancel would
 * open the game menu behind the window.
 */
function captureKey(event: KeyboardEvent): void {
  if (!capturing) return;
  event.preventDefault();
  event.stopPropagation();
  const { action, slot } = capturing;
  if (event.code === "Escape") {
    stopCapture();
    draw();
    return;
  }
  // Backspace and Delete unbind, which is the only way to take a key off an action.
  if (event.code === "Backspace" || event.code === "Delete") {
    bindKey(action, slot, "");
    rebound();
    return;
  }
  const chord = chordOf(event);
  // A bare modifier spells nothing, so holding shift while reaching for the real key does not end
  // the capture early.
  if (!chord) return;
  bindKey(action, slot, chord);
  rebound();
}

/** After any change to the table: the window redraws, and so does the bar, which wears the keys. */
function rebound(): void {
  stopCapture();
  draw();
  showActionBar();
}

function slotButton(action: string, label: string, slot: 0 | 1): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-binding-key";
  button.textContent = describeChord(keysOf(action)[slot]);
  button.setAttribute("aria-label", bindingLabel(action, label, slot));
  button.addEventListener("click", () => {
    const already = capturing?.action === action && capturing.slot === slot;
    stopCapture();
    if (already) {
      draw();
      return;
    }
    capturing = { action, label, slot, button };
    button.classList.add("ui-binding-capturing");
    button.textContent = "…";
    const slotName = slot === 0 ? "основная" : "дополнительная";
    button.setAttribute("aria-label", `${label}, ${slotName} клавиша: нажмите новую клавишу`);
  });
  return button;
}

/** The stock name of a compiled-in action's command, or its own label when it has none. */
function stockLabel(action: (typeof INPUT_ACTIONS)[number]["action"], label: string): string {
  const command = frameXmlBindingCommand(action);
  return command.startsWith("WEBCLIENT_") ? label : nativeString(`BINDING_NAME_${command}`, label);
}

/**
 * The rows under one heading per group, groups in the order they first appear. The stock rows of
 * 3.11 (input/StockActions.ts) follow the original table in `INPUT_ACTIONS` but belong to the same
 * «Цель» or «Интерфейс» the player already knows, so a second heading of the same name would be
 * the window lying about its own layout.
 */
export function groupedRows<Row extends { readonly group: string }>(rows: readonly Row[]): Row[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const list = groups.get(row.group);
    if (list) list.push(row);
    else groups.set(row.group, [row]);
  }
  return [...groups.values()].flat();
}

function draw(): void {
  if (!panel) return;
  const rows: HTMLElement[] = [];
  let group = "";
  // The compiled-in actions and then whatever the loaded modules offer, in one list because the
  // player has one keyboard. The module rows are the ones that ship unbound — see `ModuleAction`.
  const listed = groupedRows([
    // A stock command is named as KeyBindingFrame names it (BINDING_NAME_*, 4.10); this client's own
    // rows and the modules' keep their words.
    ...INPUT_ACTIONS.map((entry) => ({ action: entry.action, group: entry.group, label: stockLabel(entry.action, entry.label) })),
    ...moduleActions().map((entry) => ({ action: entry.action, group: entry.group, label: entry.label })),
  ]);
  for (const entry of listed) {
    if (entry.group !== group) {
      group = entry.group;
      const heading = document.createElement("h4");
      heading.className = "ui-binding-group";
      heading.textContent = group;
      rows.push(heading);
    }
    const row = document.createElement("div");
    row.className = "ui-binding-row";
    const label = document.createElement("span");
    label.textContent = entry.label;
    row.append(label, slotButton(entry.action, entry.label, 0), slotButton(entry.action, entry.label, 1));
    rows.push(row);
  }

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Вернуть стандартные";
  reset.addEventListener("click", () => {
    stopCapture();
    resetBindings();
    rebound();
  });
  const hint = document.createElement("p");
  hint.className = "muted";
  hint.textContent = "Нажми на клавишу в строке, затем нажми новую. Backspace убирает привязку, Esc отменяет.";
  panel.body.replaceChildren(hint, ...rows, reset);
}

function build(): Panel {
  const created = new Panel({
    id: "keybindings-window",
    title: "Привязки клавиш",
    className: "keybindings-window",
    onClose: stopCapture,
  });
  // Capture phase, so a key being bound never reaches the controls underneath.
  window.addEventListener("keydown", captureKey, true);
  // A table taken from the account (4.12) while the window is open redraws it; a capture in
  // progress is left alone and redraws when it ends.
  onBindingsChanged(() => {
    if (created.visible && !capturing) draw();
  });
  return created;
}

/**
 * The window entry points ask the stock KeyBindingFrame's route first (FrameXmlBindingController.ts):
 * once the world mount has published it, `K` and the game menu's «Назначение клавиш» open the stock
 * window over the same table, and this Panel is the fallback before that or after a failed load.
 */
export function toggleKeyBindingsWindow(): void {
  if (toggleFrameXmlKeyBindings()) return;
  toggleNativeKeyBindingsWindow();
}

/** The native Panel alone, for a stock load that failed while the player was waiting for it. */
export function openNativeKeyBindingsWindow(): void {
  if (!(panel?.visible ?? false)) toggleNativeKeyBindingsWindow();
}

function toggleNativeKeyBindingsWindow(): void {
  panel ??= build();
  panel.toggle();
  if (panel.visible) draw();
  else stopCapture();
}

export function keyBindingsOpen(): boolean {
  return frameXmlKeyBindingsOpen() || (panel?.visible ?? false);
}

/** Leaving the world also ends a pending key capture from the previous character. */
export function closeKeyBindingsWindow(): void {
  closeFrameXmlKeyBindings();
  stopCapture();
  panel?.hide();
}
