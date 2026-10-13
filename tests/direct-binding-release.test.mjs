import assert from "node:assert/strict";
import test from "node:test";

// 13.10: a key bound directly to SPELL x, ITEM x, MACRO x or CLICK b:m runs on its release, as Wow.exe 3.3.5a 12340
// runs it (0x00563150 acts for those only with keystate up; CLICK hands the button its mouse-down on the press and its
// mouse-up on the release), with the binding the press found (0x004f6ae0 keeps it in the key's slot, 0x004f6b70 runs
// the slot). Ordinary commands keep their press. The fake DOM of input-mouse-gesture.test.mjs; Controls and Bindings
// are real (the binding edges themselves: framexml-binding-api.test.mjs).

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = true;
    this.value = "";
    this.className = "";
    this.textContent = "";
    const classes = new Set();
    this.classList = {
      add: (...names) => { names.forEach((name) => classes.add(name)); },
      remove: (...names) => { names.forEach((name) => classes.delete(name)); },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const add = force === undefined ? !classes.has(name) : force;
        if (add) classes.add(name); else classes.delete(name);
        return add;
      },
    };
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  prepend(...children) { this.append(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() {}
  addEventListener(name, handler) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]); }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === 'button[type="submit"]' ? new FakeNode("button") : null; }
  querySelectorAll() { return []; }
  contains(target) { return this === target || this.children.some((child) => child.contains?.(target)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  getContext() { return {}; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = null; }
  setPointerCapture() {}
}
class FakeInput extends FakeNode { constructor() { super("input"); } }
globalThis.HTMLInputElement = FakeInput;
globalThis.HTMLSelectElement = class extends FakeNode {};
globalThis.HTMLTextAreaElement = class extends FakeNode {};
globalThis.HTMLButtonElement = class extends FakeNode {};
globalThis.HTMLElement = FakeNode;
const elements = new Map();
globalThis.document = {
  activeElement: null,
  pointerLockElement: null,
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  documentElement: new FakeNode("html"),
  createElement(tag) { return tag === "input" ? new FakeInput() : new FakeNode(tag); },
  createElementNS(_namespace, tag) { return this.createElement(tag); },
  createTextNode(text) { return { textContent: text }; },
  getElementById(id) {
    if (!elements.has(id)) {
      const element = id === "chat-input" ? new FakeInput() : new FakeNode();
      element.id = id;
      elements.set(id, element);
    }
    return elements.get(id);
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  exitPointerLock() {},
};
const windowListeners = new Map();
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener(name, handler) { windowListeners.set(name, [...(windowListeners.get(name) ?? []), handler]); },
  removeEventListener() {},
  fire(name, event) { for (const handler of windowListeners.get(name) ?? []) handler(event); },
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");
const controls = await import("../dist/code/browser/input/Controls.js");
usePanelHost({ viewport: document.body, attach() {} });
const store = new Map();
bindings.useBindingStorage({ getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value); } });
controls.wireControls();

function key(type, code, { shift = false, repeat = false, target = document.body } = {}) {
  const event = {
    type, code, target, defaultPrevented: false, repeat,
    ctrlKey: false, altKey: false, shiftKey: shift, metaKey: false, prevented: false,
    preventDefault() { this.prevented = true; },
  };
  window.fire(type, event);
  return event;
}

/** A direct binding as FrameXmlBinding.ts registers one: `edge` for the keyboard, `run` for RunBinding. */
function direct(action, chord, log) {
  bindings.addModuleAction({
    action, module: "test-direct", group: "FrameXML", label: action,
    run: () => log.push([action, "run"]),
    edge: (down) => log.push([action, down ? "down" : "up"]),
  });
  bindings.bindKey(action, 0, chord);
}

function cleanup() {
  controls.clearHeldKeys();
  bindings.removeModuleActions("test-direct");
  bindings.clearAllOverrideBindings();
  bindings.resetBindings();
}

test("a direct binding runs its release, not its press; an ordinary module verb keeps its press", () => {
  const log = [];
  try {
    direct("SPELL Огненный шар", "F7", log);
    bindings.addModuleAction({ action: "module:test:verb", module: "test-direct", group: "Модули", label: "verb", run: () => log.push(["verb", "run"]) });
    bindings.bindKey("module:test:verb", 0, "F8");
    const press = key("keydown", "F7");
    assert.deepEqual(log, [["SPELL Огненный шар", "down"]], "the press is the down edge, which casts nothing");
    assert.equal(press.prevented, true, "the key is the game's");
    key("keydown", "F7", { repeat: true });
    key("keydown", "F7", { repeat: true });
    assert.equal(log.length, 1, "the autorepeat is no press");
    const release = key("keyup", "F7");
    assert.deepEqual(log.at(-1), ["SPELL Огненный шар", "up"], "the release casts");
    assert.equal(release.prevented, true);
    key("keyup", "F7");
    assert.equal(log.length, 2, "one release per press");
    key("keydown", "F8");
    key("keyup", "F8");
    assert.deepEqual(log.slice(2), [["verb", "run"]], "an ordinary verb runs on the press, as before");
  } finally {
    cleanup();
  }
});

test("the release runs the binding its press found, whatever the modifiers and the table say by then", () => {
  const log = [];
  try {
    direct("SPELL Рывок", "Shift+F7", log);
    direct("SPELL Огненный шар", "F7", log);
    key("keydown", "ShiftLeft", { shift: true });
    key("keydown", "F7", { shift: true });
    key("keyup", "ShiftLeft");
    key("keyup", "F7");
    assert.deepEqual(log, [["SPELL Рывок", "down"], ["SPELL Рывок", "up"]], "Shift let go first: still Shift+F7's spell");
    log.length = 0;
    key("keydown", "F7");
    bindings.bindKey("SPELL Рывок", 0, "F7");
    key("keyup", "F7");
    assert.deepEqual(log, [["SPELL Огненный шар", "down"], ["SPELL Огненный шар", "up"]], "rebound under the held key");
  } finally {
    cleanup();
  }
});

test("an override's direct binding goes the same way; focus lost or an edit box takes the release", () => {
  const log = [];
  try {
    bindings.setOverrideBinding("table: 0x1", "F9", {
      owner: "table: 0x1", priority: false, command: "CLICK ActionButton3:LeftButton",
      run: () => log.push("run"), edge: (down) => log.push(down ? "down" : "up"),
    });
    key("keydown", "F9");
    key("keyup", "F9");
    assert.deepEqual(log, ["down", "up"], "CLICK: the mouse-down on the press, the mouse-up on the release");
    log.length = 0;
    key("keydown", "F9");
    window.fire("blur", {});
    key("keyup", "F9");
    assert.deepEqual(log, ["down"], "a release that never came clicks nothing");
    log.length = 0;
    key("keydown", "F9");
    key("keyup", "F9", { target: new FakeInput() });
    key("keyup", "F9");
    assert.deepEqual(log, ["down"], "the chat box took the release (0x0048fbf0), and the slot is spent");
  } finally {
    cleanup();
  }
});
