/**
 * The browser's own behaviour, switched off where the original client has none — the owner's
 * request of 2026-09-28: the web client and its Electron window should act like the native
 * application, not like a page.
 *
 * A page is a document. Its pictures can be dragged out of it as ghost images; any label, frame or
 * button text on it can be selected as if it were prose; the mouse's back button leaves it;
 * Ctrl+wheel and Ctrl+± zoom it; a middle click starts the autoscroll arrows; a file dropped on it
 * replaces it; F5 reloads it, Ctrl+S saves it, Ctrl+P prints it and Ctrl+F searches it; F7 offers
 * caret browsing and F10/Alt reach for the browser's menu; Tab walks the focus through its buttons,
 * a clicked button keeps a focus that Space or Enter then presses again, and a text field
 * underlines words in red. The client is an application and does none of that.
 *
 * This module is the one place that says so, for `index.html` in a browser and in Electron alike
 * (`main.ts` installs it). What stays: the page's own drags (the action bar, the spellbook, the bags
 * and the pet bar mark their sources `draggable="true"`), every editable field — selecting, the
 * clipboard, its context menu (input/Controls.ts keeps that one), the caret — and the developer's
 * way out: F12, Ctrl+Shift+I and a hard reload (Ctrl+Shift+R, Ctrl+F5, Shift+F5). The right-click
 * menu itself is already the game's: Controls.ts swallows it outside editable fields.
 *
 * Electron's half — no spell checker, no pinch zoom — is in `electron/main.cjs`.
 */

import { armTip, setTip } from "../ui/Tooltip.js";

/** The stylesheet the module adds: no selection, no image drags, no text caret outside fields. */
export const NATIVE_APP_SHELL_CSS = `
html, body {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
body { cursor: default; }
input, textarea, select, [contenteditable]:not([contenteditable="false"]) {
  -webkit-user-select: text;
  user-select: text;
  cursor: auto;
}
img, a, svg, canvas, video { -webkit-user-drag: none; }
`;

/** The id of the added `<style>`, and the root attribute tests and the console can read. */
export const NATIVE_APP_SHELL_STYLE_ID = "native-app-shell";
export const NATIVE_APP_SHELL_ATTRIBUTE = "data-native-app-shell";

/** A text field, a select box or an editable region: the places where browser editing stays. */
export function nativeShellEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement) return true;
  return target.isContentEditable;
}

/** A drag the page started on purpose: its source (or an ancestor) is marked `draggable="true"`. */
export function nativeShellAllowsDrag(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest('[draggable="true"]') !== null;
}

/** The keyboard shape the shortcut rule reads; a `KeyboardEvent` is one. */
export interface NativeShellKey {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Ctrl (or ⌘) with these, and no Shift: save, print, open, source, downloads, history, bookmark, find, address bar. */
const COMMAND_KEYS: ReadonlySet<string> = new Set(["s", "p", "o", "u", "j", "h", "d", "f", "g", "e", "k", "l", "r"]);
/** Ctrl (or ⌘) with these, Shift or not: the zoom keys, main row and numpad. */
const ZOOM_KEYS: ReadonlySet<string> = new Set(["=", "+", "-", "_", "0"]);
const ZOOM_CODES: ReadonlySet<string> = new Set(["NumpadAdd", "NumpadSubtract", "Numpad0"]);
/** Plain F-keys the browser answers: help, find next, reload, address bar, caret browsing, menu. */
const BROWSER_FUNCTION_KEYS: ReadonlySet<string> = new Set(["F1", "F3", "F5", "F6", "F7", "F10"]);

/**
 * Whether a key press is one the browser would act on and the client does not know. Only the
 * browser's default is withheld — the game's own handlers still see the press, so a binding on F5
 * or Ctrl+S keeps working. Editing keys (Ctrl+A/C/V/X/Z/Y, arrows, Backspace) are never listed.
 * `editable` is whether the press goes to a text field, where Tab keeps moving between fields.
 */
export function nativeShellBlocksKey(event: NativeShellKey, editable: boolean): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const command = event.ctrlKey || event.metaKey;
  if (command && !event.altKey) {
    if (ZOOM_KEYS.has(key) || (event.code !== undefined && ZOOM_CODES.has(event.code))) return true;
    // Shifted chords stay the developer's: Ctrl+Shift+R is the hard reload, Ctrl+Shift+J/I the tools.
    return !event.shiftKey && COMMAND_KEYS.has(key);
  }
  // Alt alone opens the browser's menu bar (Firefox); in a text field it is left alone, where
  // AltGr layouts type characters with it.
  if (key === "Alt" || key === "AltGraph") return !editable;
  if (key === "Tab") return !editable && !event.altKey;
  // Plain only: Ctrl+F5 and Shift+F5 are the hard reload, F12 the tools.
  return BROWSER_FUNCTION_KEYS.has(key) && !event.shiftKey && !event.altKey;
}

/** The history entry the shell keeps on top, so a back gesture lands on it instead of off the page. */
const HISTORY_MARKER = Object.freeze({ nativeAppShell: true });

/**
 * Switches the browser's behaviour off for `doc`/`win`; returns the undo. Idempotent per document:
 * a second call answers the first one's undo.
 */
export function installNativeAppShell(doc: Document = document, win: Window = window): () => void {
  const root = doc.documentElement;
  const existing = installed.get(doc);
  if (existing) return existing;
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(
    target: Document, type: K, listener: (event: DocumentEventMap[K]) => void, options: AddEventListenerOptions,
  ): void => {
    target.addEventListener(type, listener, options);
    cleanups.push(() => target.removeEventListener(type, listener, options));
  };
  const onWindow = <K extends keyof WindowEventMap>(
    type: K, listener: (event: WindowEventMap[K]) => void, options: AddEventListenerOptions,
  ): void => {
    win.addEventListener(type, listener, options);
    cleanups.push(() => win.removeEventListener(type, listener, options));
  };

  const style = doc.createElement("style");
  style.id = NATIVE_APP_SHELL_STYLE_ID;
  style.textContent = NATIVE_APP_SHELL_CSS;
  doc.head.append(style);
  cleanups.push(() => style.remove());
  root.setAttribute(NATIVE_APP_SHELL_ATTRIBUTE, "on");
  cleanups.push(() => root.removeAttribute(NATIVE_APP_SHELL_ATTRIBUTE));

  // Selection and ghost drags. Capture phase, so a handler deeper down cannot let one through.
  on(doc, "selectstart", (event) => {
    if (!nativeShellEditableTarget(event.target)) event.preventDefault();
  }, { capture: true });
  on(doc, "dragstart", (event) => {
    if (!nativeShellAllowsDrag(event.target)) event.preventDefault();
  }, { capture: true });
  // A file dragged in from the desktop would replace the page on drop; the page's own drags carry no files.
  const refuseFiles = (event: DragEvent): void => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  };
  onWindow("dragover", refuseFiles, { capture: true });
  onWindow("drop", refuseFiles, { capture: true });

  // The mouse: the middle button's autoscroll (and paste), the back and forward buttons' navigation.
  on(doc, "mousedown", (event) => {
    if (event.button === 1 && !nativeShellEditableTarget(event.target)) event.preventDefault();
  }, { capture: true });
  const noNavigation = (event: MouseEvent): void => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  };
  on(doc, "mouseup", noNavigation, { capture: true });
  on(doc, "auxclick", (event) => {
    // A middle click on a link opens a tab; the back and forward buttons navigate.
    if (event.button === 1 || event.button === 3 || event.button === 4) event.preventDefault();
  }, { capture: true });
  // Ctrl+wheel is the browser's zoom; the game's own wheel listeners still run.
  onWindow("wheel", (event) => {
    if (event.ctrlKey) event.preventDefault();
  }, { capture: true, passive: false });

  // The keyboard: browser commands, the Alt menu, focus walking with Tab.
  on(doc, "keydown", (event) => {
    if (nativeShellBlocksKey(event, nativeShellEditableTarget(event.target))) event.preventDefault();
  }, { capture: true });
  on(doc, "keyup", (event) => {
    if ((event.key === "Alt" || event.key === "F10") && !nativeShellEditableTarget(event.target)) event.preventDefault();
  }, { capture: true });

  // A pointer click leaves no focus on a button, a frame or a link: the next Space is the game's
  // jump, not a second click. Fields keep theirs; a keyboard-made click (detail 0) keeps its focus.
  on(doc, "click", (event) => {
    if (event.detail === 0) return;
    const clicked = event.target;
    queueMicrotask(() => {
      const active = doc.activeElement;
      if (!(active instanceof HTMLElement) || active === doc.body || nativeShellEditableTarget(active)) return;
      // Only the focus the click itself gave: the clicked element or the focusable one around it.
      if (active !== clicked && !(clicked instanceof Element && active.contains(clicked))) return;
      active.blur();
    });
  }, { capture: true });

  // No red underlines and no browser suggestions in a text field the page has not configured itself
  // (the glue login fields say `username`/`current-password` and keep it).
  on(doc, "focusin", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
    if (!field.hasAttribute("spellcheck")) field.spellcheck = false;
    if (!field.hasAttribute("autocomplete")) field.setAttribute("autocomplete", "off");
  }, { capture: true });

  // Back without a page to go back to: the first user gesture puts one entry on top, and a back
  // gesture only takes that entry off (a gesture is needed — Chrome skips entries no user
  // interaction followed). In Electron there is nothing behind the page either way.
  const history = win.history;
  const keepEntry = (): void => {
    try {
      if ((history.state as { nativeAppShell?: boolean } | null)?.nativeAppShell !== true) {
        history.pushState(HISTORY_MARKER, "");
      }
    } catch {
      // A sandboxed or opaque-origin document has no history to write: nothing to trap.
    }
  };
  on(doc, "pointerdown", keepEntry, { capture: true });
  on(doc, "keydown", keepEntry, { capture: true });
  onWindow("popstate", keepEntry, {});

  // The browser's own hint: every `title` becomes the interface's tooltip before it can show (4.01).
  cleanups.push(installTitleTooltips(doc));

  const undo = (): void => {
    installed.delete(doc);
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };
  installed.set(doc, undo);
  return undo;
}

const installed = new WeakMap<Document, () => void>();

/** Elements whose `aria-label` the safety net wrote, so a later hint replaces its own label only. */
const labelledByShell = new WeakSet<Element>();

/** Whether an element already has an accessible name of its own (its label, or its own text). */
function hasOwnName(element: HTMLElement): boolean {
  if (labelledByShell.has(element)) return false;
  if (element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby")) return true;
  return (element.textContent ?? "").trim() !== "";
}

/**
 * Moves one element's `title` into the interface's tooltip ({@link setTip}) and returns whether it
 * did. The browser shows nothing for an element without the attribute, so removing it before the
 * browser's own delay runs out is what keeps the page-like hint off the screen. The name is not
 * lost to a screen reader: an unnamed element (an icon button) gets it as `aria-label`, a named
 * one as `aria-description`. Form fields keep theirs — a field's `title` is its validation hint.
 */
export function nativeShellAdoptTitle(element: Element): boolean {
  if (typeof HTMLElement === "undefined" || !(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement) return false;
  const text = element.getAttribute("title");
  if (text === null) return false;
  element.removeAttribute("title");
  if (text.trim() === "") {
    setTip(element, undefined);
    return true;
  }
  if (!hasOwnName(element)) {
    element.setAttribute("aria-label", text);
    labelledByShell.add(element);
  } else {
    element.setAttribute("aria-description", text);
  }
  setTip(element, text);
  return true;
}

/** Whether the pointer is over `element` now; a fake document without `:hover` answers no. */
function hovered(element: Element): boolean {
  try {
    return typeof element.matches === "function" && element.matches(":hover");
  } catch {
    return false;
  }
}

/**
 * The safety net for every `title` in the page — the native interface's, `index.html`'s and the
 * stock FrameXML DOM's: on the pointer's way into an element (capture `pointerover`, which comes
 * before the element's own `pointerenter`) and on any later write of the attribute (a
 * `MutationObserver` on `title` alone, delivered in a microtask), the attribute becomes a tooltip.
 * Returns the undo.
 */
export function installTitleTooltips(doc: Document): () => void {
  const onOver = (event: Event): void => {
    const target = event.target;
    if (typeof Element === "undefined" || !(target instanceof Element)) return;
    let nearest: Element | undefined;
    // The browser shows the nearest titled ancestor's hint, then the next one out once that one
    // is gone: every titled element on the way up is converted, the nearest is armed.
    for (let node = target.closest("[title]"); node; node = node.parentElement?.closest("[title]") ?? null) {
      if (nativeShellAdoptTitle(node) && !nearest) nearest = node;
    }
    if (nearest instanceof HTMLElement && nearest !== target) armTip(nearest);
  };
  doc.addEventListener("pointerover", onOver, { capture: true });
  let observer: MutationObserver | undefined;
  if (typeof MutationObserver === "function" && doc.documentElement) {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        if (!(node instanceof Element) || !node.hasAttribute("title")) continue;
        if (nativeShellAdoptTitle(node) && node instanceof HTMLElement && hovered(node)) armTip(node);
      }
    });
    observer.observe(doc.documentElement, { subtree: true, attributes: true, attributeFilter: ["title"] });
  }
  return () => {
    doc.removeEventListener("pointerover", onOver, { capture: true });
    observer?.disconnect();
  };
}
