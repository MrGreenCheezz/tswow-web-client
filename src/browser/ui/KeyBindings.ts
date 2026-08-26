import {
  INPUT_ACTIONS, bindKey, describeChord, chordOf, keysOf, moduleActions, resetBindings,
} from "../input/Bindings.js";
import { showActionBar } from "./ActionBar.js";
import { Panel } from "./Widgets.js";

/**
 * The bindings window: one row per action, two keys each.
 *
 * Built out of the widget kit and the one table, which is the whole reason both exist. Nothing in
 * the page markup describes this window and nothing needs to — adding an action to
 * `INPUT_ACTIONS` puts a row here without a line being written.
 */
let panel: Panel | undefined;
/** Which slot is waiting for a key press. Null while the window is only being read. */
let capturing: { action: string; slot: 0 | 1; button: HTMLButtonElement } | undefined;

function stopCapture(): void {
  if (!capturing) return;
  capturing.button.classList.remove("ui-binding-capturing");
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

function slotButton(action: string, slot: 0 | 1): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-binding-key";
  button.textContent = describeChord(keysOf(action)[slot]);
  button.addEventListener("click", () => {
    const already = capturing?.action === action && capturing.slot === slot;
    stopCapture();
    if (already) {
      draw();
      return;
    }
    capturing = { action, slot, button };
    button.classList.add("ui-binding-capturing");
    button.textContent = "…";
  });
  return button;
}

function draw(): void {
  if (!panel) return;
  const rows: HTMLElement[] = [];
  let group = "";
  // The compiled-in actions and then whatever the loaded modules offer, in one list because the
  // player has one keyboard. The module rows are the ones that ship unbound — see `ModuleAction`.
  const listed: { action: string; group: string; label: string }[] = [
    ...INPUT_ACTIONS,
    ...moduleActions().map((entry) => ({ action: entry.action, group: entry.group, label: entry.label })),
  ];
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
    row.append(label, slotButton(entry.action, 0), slotButton(entry.action, 1));
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
  return created;
}

export function toggleKeyBindingsWindow(): void {
  panel ??= build();
  panel.toggle();
  if (panel.visible) draw();
  else stopCapture();
}

export function keyBindingsOpen(): boolean {
  return panel?.visible ?? false;
}
