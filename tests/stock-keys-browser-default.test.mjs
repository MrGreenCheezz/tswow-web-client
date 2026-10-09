import assert from "node:assert/strict";
import test from "node:test";

// Review of 3.11 (02.10): a key the stock table binds is the game's even when its verb finds nothing
// to do. Ctrl+F5 is SHAPESHIFTBUTTON5 by DefaultBindings.wtf; a character with fewer than five forms
// pressed it and the browser ran its hard reload, because Controls only withheld the browser's default
// when the verb reported success. The fake DOM of input-controls-residuals.test.mjs; Controls is real.
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
class FakeButton extends FakeNode { constructor() { super("button"); } }
globalThis.HTMLInputElement = FakeInput;
globalThis.HTMLSelectElement = class extends FakeNode {};
globalThis.HTMLTextAreaElement = class extends FakeNode {};
globalThis.HTMLButtonElement = FakeButton;
globalThis.HTMLElement = FakeNode;
const elements = new Map();
globalThis.document = {
  activeElement: null,
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  createElement(tag) { return tag === "input" ? new FakeInput() : tag === "button" ? new FakeButton() : new FakeNode(tag); },
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

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const gameMenu = await import("../dist/code/browser/framexml/FrameXmlGameMenuController.js");
const popups = await import("../dist/code/browser/framexml/FrameXmlPopupsController.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const controls = await import("../dist/code/browser/input/Controls.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();
void gameMenu; void popups; void dom;

const { DEFAULT_BINDINGS } = await import("../dist/code/browser/input/Bindings.js");

function key(code, mods = {}) {
  const event = { code, key: code, target: document.body, defaultPrevented: false, repeat: false,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
    prevented: false, preventDefault() { this.prevented = true; this.defaultPrevented = true; } };
  window.fire("keydown", event);
  return event;
}

function worldStub() {
  return {
    state: { selfGuid: 1n, objects: new Map() }, targetGuid: undefined, chatLog: [], knownSpells: [],
    selectTarget(guid) { this.targetGuid = guid; },
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, aurasFor: () => [],
    displayName: () => "",
  };
}

test("Ctrl+F5 (SHAPESHIFTBUTTON5) with no fifth form is still the game's key, not the browser's reload", () => {
  assert.deepEqual([...DEFAULT_BINDINGS.shapeshift5], ["Ctrl+F5", ""], "the stock default this test presses");
  game.world = worldStub();
  try {
    const press = key("F5", { ctrlKey: true });
    assert.equal(press.prevented, true, "the browser's Ctrl+F5 is withheld in the world");
  } finally {
    game.world = undefined;
  }
});

test("out of the world a bound key the verb ignores keeps the browser's default (Tab in the login form)", () => {
  game.world = undefined;
  const press = key("F5", { ctrlKey: true });
  assert.equal(press.prevented, false);
});
