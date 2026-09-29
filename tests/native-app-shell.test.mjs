import assert from "node:assert/strict";
import test, { after } from "node:test";

// The web and Electron client as an application, not a page (app/NativeAppShell.ts): which
// browser defaults are withheld, which stay, over a minimal document double. The real Chromium
// behaviour behind each default (a ghost image, the autoscroll arrows, a history step) is checked
// in a browser; this pins the decisions.

// The few DOM classes the module asks `instanceof` about, before it is imported.
class FakeElement {
  constructor(tag, attributes = {}, parent = undefined) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.parent = parent;
    this.isContentEditable = attributes.contenteditable === "true";
    this.blurred = 0;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest(selector) {
    const wanted = /^\[draggable="true"\]$/.test(selector);
    for (let node = this; node; node = node.parent) if (wanted && node.getAttribute("draggable") === "true") return node;
    return null;
  }
  contains(other) {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
  blur() { this.blurred += 1; }
}
class FakeHTMLElement extends FakeElement {}
class FakeInput extends FakeHTMLElement {
  set spellcheck(value) { this.setAttribute("spellcheck", String(value)); }
  get spellcheck() { return this.getAttribute("spellcheck") !== "false"; }
}
class FakeTextArea extends FakeInput {}
class FakeSelect extends FakeHTMLElement {}
const saved = {};
for (const [name, value] of Object.entries({
  Element: FakeElement, HTMLElement: FakeHTMLElement, HTMLInputElement: FakeInput,
  HTMLTextAreaElement: FakeTextArea, HTMLSelectElement: FakeSelect,
})) {
  saved[name] = globalThis[name];
  globalThis[name] = value;
}
after(() => { for (const [name, value] of Object.entries(saved)) globalThis[name] = value; });

const {
  NATIVE_APP_SHELL_ATTRIBUTE, NATIVE_APP_SHELL_CSS, installNativeAppShell, nativeShellAllowsDrag, nativeShellBlocksKey,
  nativeShellEditableTarget,
} = await import("../dist/code/browser/app/NativeAppShell.js");

function listenerHost() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, listener, options) { listeners.push({ type, listener, options }); },
    removeEventListener(type, listener) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(type, fields = {}) {
      const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
      for (const entry of listeners.filter((candidate) => candidate.type === type)) entry.listener(event);
      return event;
    },
  };
}

function fixture() {
  const docHost = listenerHost();
  const winHost = listenerHost();
  const body = new FakeHTMLElement("body");
  const styles = [];
  const pushed = [];
  const doc = Object.assign(docHost, {
    documentElement: new FakeElement("html"),
    head: { append: (element) => styles.push(element) },
    body,
    activeElement: body,
    createElement: (tag) => ({ tag, id: "", textContent: "", removed: false, remove() { this.removed = true; } }),
  });
  const history = { state: null, pushState(state) { this.state = state; pushed.push(state); } };
  const win = Object.assign(winHost, { history });
  return { doc, win, body, styles, pushed, history };
}

const flush = () => new Promise((resolve) => queueMicrotask(resolve));

test("the key rule withholds browser commands, zoom, the menu keys, Tab outside fields — never editing keys", () => {
  const key = (value, mods = {}) => ({ key: value, code: mods.code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  const blocked = (value, mods, editable = false) => nativeShellBlocksKey(key(value, mods), editable);
  for (const letter of ["s", "p", "o", "u", "j", "h", "d", "f", "g", "r"]) {
    assert.equal(blocked(letter, { ctrlKey: true }), true, `Ctrl+${letter.toUpperCase()}`);
  }
  assert.equal(blocked("S", { ctrlKey: true }), true, "a capital letter is the same command");
  assert.equal(blocked("f", { metaKey: true }), true, "⌘ as Ctrl");
  for (const letter of ["a", "c", "v", "x", "z", "y"]) {
    assert.equal(blocked(letter, { ctrlKey: true }, true), false, `Ctrl+${letter.toUpperCase()} edits text`);
  }
  assert.equal(blocked("r", { ctrlKey: true, shiftKey: true }), false, "Ctrl+Shift+R, the hard reload, stays");
  assert.equal(blocked("j", { ctrlKey: true, shiftKey: true }), false, "Ctrl+Shift+J, the console, stays");
  for (const zoom of ["=", "+", "-", "_", "0"]) assert.equal(blocked(zoom, { ctrlKey: true }), true, `Ctrl+${zoom}`);
  assert.equal(blocked("+", { ctrlKey: true, code: "NumpadAdd" }), true);
  assert.equal(blocked("-", { ctrlKey: true, shiftKey: true }), true, "zoom with Shift is still zoom");
  for (const fkey of ["F1", "F3", "F5", "F6", "F7", "F10"]) assert.equal(blocked(fkey), true, fkey);
  assert.equal(blocked("F5", { ctrlKey: true }), false, "Ctrl+F5, the hard reload, stays");
  assert.equal(blocked("F5", { shiftKey: true }), false, "Shift+F5 too");
  assert.equal(blocked("F12"), false, "the developer tools stay");
  assert.equal(blocked("F11"), false, "fullscreen stays");
  assert.equal(blocked("Alt"), true, "Alt alone reaches for the browser menu");
  assert.equal(blocked("AltGraph", {}, true), false, "AltGr types characters in a field");
  assert.equal(blocked("Tab"), true, "focus walking outside a field");
  assert.equal(blocked("Tab", {}, true), false, "field to field on the login screen");
  assert.equal(blocked("Escape"), false, "Escape is the game's back-out, untouched");
  assert.equal(blocked(" "), false);
  assert.equal(blocked("Enter"), false);
  assert.equal(blocked("w"), false, "movement keys are nobody's business here");
});

test("editable targets and allowed drags are told apart structurally", () => {
  assert.equal(nativeShellEditableTarget(new FakeInput("input")), true);
  assert.equal(nativeShellEditableTarget(new FakeTextArea("textarea")), true);
  assert.equal(nativeShellEditableTarget(new FakeSelect("select")), true);
  assert.equal(nativeShellEditableTarget(new FakeHTMLElement("div", { contenteditable: "true" })), true);
  assert.equal(nativeShellEditableTarget(new FakeHTMLElement("div")), false);
  assert.equal(nativeShellEditableTarget(null), false);
  const slot = new FakeHTMLElement("button", { draggable: "true" });
  const icon = new FakeHTMLElement("img", {}, slot);
  assert.equal(nativeShellAllowsDrag(icon), true, "an icon inside the action bar's draggable button");
  assert.equal(nativeShellAllowsDrag(new FakeHTMLElement("img")), false, "a bare picture");
  assert.equal(nativeShellAllowsDrag(new FakeHTMLElement("img", { draggable: "false" })), false);
});

test("the shell withholds selection, ghost drags, file drops, mouse navigation, zoom and browser keys", async () => {
  const { doc, win, body, styles, pushed, history } = fixture();
  const undo = installNativeAppShell(doc, win);
  assert.equal(installNativeAppShell(doc, win), undo, "once per document");
  assert.equal(doc.documentElement.getAttribute(NATIVE_APP_SHELL_ATTRIBUTE), "on");
  assert.equal(styles.length, 1);
  assert.equal(styles[0].textContent, NATIVE_APP_SHELL_CSS);
  assert.match(NATIVE_APP_SHELL_CSS, /user-select: none/);
  assert.match(NATIVE_APP_SHELL_CSS, /-webkit-user-drag: none/);
  assert.deepEqual(pushed, [], "no history entry before a user gesture (Chrome would skip it)");

  const label = new FakeHTMLElement("span");
  const field = new FakeInput("input");
  assert.equal(doc.dispatch("selectstart", { target: label }).defaultPrevented, true, "no selecting a label");
  assert.equal(doc.dispatch("selectstart", { target: field }).defaultPrevented, false, "a field selects");

  const slot = new FakeHTMLElement("button", { draggable: "true" });
  assert.equal(doc.dispatch("dragstart", { target: new FakeHTMLElement("img") }).defaultPrevented, true, "no ghost image");
  assert.equal(doc.dispatch("dragstart", { target: new FakeHTMLElement("img", {}, slot) }).defaultPrevented, false,
    "the action bar's own drag goes on");
  const files = { types: ["Files"], dropEffect: "copy" };
  assert.equal(win.dispatch("drop", { dataTransfer: files }).defaultPrevented, true, "a dropped file does not replace the page");
  assert.equal(files.dropEffect, "none");
  assert.equal(win.dispatch("dragover", { dataTransfer: { types: ["text/pet-slot"], dropEffect: "move" } }).defaultPrevented, false,
    "the page's own drags carry no files and are left to their targets");

  assert.equal(doc.dispatch("mousedown", { button: 1, target: label }).defaultPrevented, true, "no autoscroll");
  assert.equal(doc.dispatch("mousedown", { button: 0, target: label }).defaultPrevented, false, "the left button is the game's");
  assert.equal(doc.dispatch("mousedown", { button: 2, target: label }).defaultPrevented, false);
  assert.equal(doc.dispatch("mouseup", { button: 3, target: label }).defaultPrevented, true, "the back button does not navigate");
  assert.equal(doc.dispatch("mouseup", { button: 4, target: label }).defaultPrevented, true);
  assert.equal(doc.dispatch("auxclick", { button: 1, target: label }).defaultPrevented, true);
  assert.equal(win.dispatch("wheel", { ctrlKey: true }).defaultPrevented, true, "no Ctrl+wheel zoom");
  assert.equal(win.dispatch("wheel", { ctrlKey: false }).defaultPrevented, false, "the plain wheel is the camera's");
  const wheel = win.listeners.find((entry) => entry.type === "wheel");
  assert.equal(wheel.options.passive, false, "a passive listener could not withhold the zoom");

  const keydown = (key, target = label, mods = {}) => doc.dispatch("keydown", {
    key, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
  });
  assert.equal(keydown("s", label, { ctrlKey: true }).defaultPrevented, true, "no «save page»");
  assert.equal(keydown("F5").defaultPrevented, true, "no reload");
  assert.equal(keydown("c", field, { ctrlKey: true }).defaultPrevented, false, "copying in a field");

  // A click leaves no focus behind on what it clicked; a field keeps its caret.
  const button = new FakeHTMLElement("button");
  doc.activeElement = button;
  doc.dispatch("click", { detail: 1, target: button });
  await flush();
  assert.equal(button.blurred, 1, "the next Space is the game's jump, not a second click");
  doc.activeElement = field;
  doc.dispatch("click", { detail: 1, target: field });
  await flush();
  assert.equal(field.blurred, 0);
  doc.activeElement = button;
  doc.dispatch("click", { detail: 0, target: button });
  await flush();
  assert.equal(button.blurred, 1, "a keyboard-made click keeps its focus");
  doc.activeElement = body;

  const chat = new FakeInput("input");
  const login = new FakeInput("input", { autocomplete: "username", spellcheck: "false" });
  doc.dispatch("focusin", { target: chat });
  doc.dispatch("focusin", { target: login });
  assert.deepEqual([chat.getAttribute("spellcheck"), chat.getAttribute("autocomplete")], ["false", "off"]);
  assert.equal(login.getAttribute("autocomplete"), "username", "a field that says what it wants keeps it");

  // Back leaves nothing behind the page: the first gesture (the key presses above) put one entry on
  // top, later gestures add none, and a back gesture that took it off puts it back.
  assert.equal(pushed.length, 1);
  doc.dispatch("pointerdown", { target: label, button: 0 });
  assert.equal(pushed.length, 1, "one entry, not one per click");
  history.state = null;
  win.dispatch("popstate", {});
  assert.equal(pushed.length, 2, "a back gesture only took the entry off; it is back on top");

  undo();
  assert.equal(doc.listeners.length, 0, "every document listener removed");
  assert.equal(win.listeners.length, 0, "every window listener removed");
  assert.equal(styles[0].removed, true);
  assert.equal(doc.documentElement.getAttribute(NATIVE_APP_SHELL_ATTRIBUTE), null);
});
