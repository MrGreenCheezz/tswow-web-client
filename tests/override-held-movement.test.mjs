import assert from "node:assert/strict";
import test from "node:test";

// WORK_PLAN 3.11 (lane L2): an override binding (SetOverrideBinding, slice D) that names a movement
// command holds it like the table's own key — down starts, up stops — as the client runs a runOnUp
// binding with keystate "down" and "up" (Bindings.xml MOVEFORWARD: MoveForwardStart/Stop). Before,
// the override ran the command once on the press and the character never moved. The fake DOM of
// stock-keys-browser-default.test.mjs; Controls, Bindings and Movement are real.
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

const bindings = await import("../dist/code/browser/input/Bindings.js");
const movement = await import("../dist/code/browser/input/Movement.js");
const { FrameXmlBindingModel } = await import("../dist/code/browser/framexml/FrameXmlBinding.js");

function keyEvent(type, code) {
  const event = { code, key: code, target: document.body, defaultPrevented: false, repeat: false,
    ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    prevented: false, preventDefault() { this.prevented = true; this.defaultPrevented = true; } };
  window.fire(type, event);
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

test("SetOverrideBinding(owner, false, \"H\", \"MOVEFORWARD\") holds the move while H is down", () => {
  const storage = new Map();
  bindings.useBindingStorage({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) });
  const runs = [];
  const model = new FrameXmlBindingModel({ runAction: (action) => { runs.push(action); return true; } });
  game.world = worldStub();
  try {
    assert.equal(model.setOverride("table: 0x1", false, "H", "MOVEFORWARD"), true);
    assert.equal(bindings.overrideFor("KeyH")?.action, "moveForward", "the override knows the table action it stands for");
    const down = keyEvent("keydown", "KeyH");
    assert.equal(down.prevented, true);
    assert.equal(movement.forwardAxis(), 1, "the character runs while the key is held");
    keyEvent("keydown", "KeyH");
    assert.equal(movement.forwardAxis(), 1);
    keyEvent("keyup", "KeyH");
    assert.equal(movement.forwardAxis(), 0, "and stops when it is let go");
    assert.deepEqual(runs, [], "a held command is not run as a press");
    // A command that is pressed, not held, still runs once on the press.
    assert.equal(model.setOverride("table: 0x1", false, "J", "TARGETNEARESTENEMY"), true);
    keyEvent("keydown", "KeyJ");
    keyEvent("keyup", "KeyJ");
    assert.deepEqual(runs, ["targetNearestEnemy"]);
  } finally {
    bindings.clearAllOverrideBindings();
    movement.releaseAllInput?.();
    game.world = undefined;
  }
});
