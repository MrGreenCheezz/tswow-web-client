import assert from "node:assert/strict";
import test from "node:test";

// Two Controls.ts rules the client has and this page did not: a held Escape is one press (the OS
// autorepeat toggled the menu on every repeat), and a left click on the world while the stock bag
// cursor holds an item is the item dropped outside every frame (DELETE_ITEM_CONFIRM), not a click
// that selects. The fake DOM of framexml-gamemenu-controller.test.mjs: Controls is the real module.

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
const gameMenuModule = await import("../dist/code/browser/ui/GameMenu.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

const escape = (repeat) => window.fire("keydown", { code: "Escape", target: document.body, defaultPrevented: false,
  repeat, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {} });

function worldStub() {
  const selections = [];
  return {
    selections,
    state: { selfGuid: 1n, objects: new Map() }, targetGuid: undefined, chatLog: [],
    selectTarget(guid) { this.targetGuid = guid; selections.push(guid); },
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, aurasFor: () => [],
    displayName: () => "",
  };
}

test("a held Escape is one press: the autorepeat does not toggle the menu again", () => {
  game.world = worldStub();
  const menu = {
    open: false, toggles: 0,
    isOpen() { return this.open; },
    show() { this.open = true; this.toggles += 1; },
    hide() { this.open = false; this.toggles += 1; },
  };
  const release = gameMenu.publishFrameXmlGameMenu(menu);
  try {
    escape(false);
    assert.equal(menu.open, true, "the press opens the menu");
    for (let repeat = 0; repeat < 5; repeat += 1) escape(true);
    assert.equal(menu.toggles, 1, "five OS repeats of the same press toggle nothing");
    assert.equal(menu.open, true);
    escape(false);
    assert.equal(menu.open, false, "the next press closes it");
  } finally {
    release();
    game.world = undefined;
  }
});

function clickWorld() {
  const canvas = dom.worldCanvas;
  const fire = (name, event) => { for (const handler of canvas.listeners.get(name) ?? []) handler(event); };
  const base = { pointerId: 1, clientX: 40, clientY: 40, movementX: 0, movementY: 0, preventDefault() {} };
  fire("pointerdown", { ...base, button: 0, buttons: 1 });
  fire("pointerup", { ...base, button: 0, buttons: 0 });
}

test("a left click on the world with an item on the stock cursor asks DELETE_ITEM_CONFIRM and selects nothing", () => {
  const world = worldStub();
  game.world = world;
  let held = true;
  const asked = [];
  const release = popups.publishFrameXmlPopups({
    isOpen: () => false, close() {},
    dropCursorItem() { asked.push(held); return held; },
  });
  try {
    clickWorld();
    assert.deepEqual(asked, [true], "the stock popup owner is asked first");
    assert.deepEqual(world.selections, [], "the click that dropped the item selects nothing");
    held = false;
    clickWorld();
    assert.deepEqual(asked, [true, false]);
    assert.deepEqual(world.selections, [undefined], "with an empty cursor the click selects (here: nothing under it)");
  } finally {
    release();
    game.world = undefined;
  }
  // Unpublished, the controller answers false and the click is the native one.
  const again = worldStub();
  game.world = again;
  try {
    clickWorld();
    assert.deepEqual(again.selections, [undefined]);
  } finally {
    game.world = undefined;
  }
});

// 4.04: before the stock menu is published, Escape is stock ToggleGameMenu's order one step per
// press (UIParent.lua:2868-2903) — SpellStopCasting, then CloseAllWindows, then ClearTarget, then
// the menu. It used to close every window, drop the target and never touch the cast on one press.
test("native Escape: the cast, then the windows, then the target, then the menu — one per press", () => {
  const world = worldStub();
  let cancels = 0;
  world.casts = new Map([[1n, { duration: 3000, startedAt: performance.now() }]]);
  world.cancelSpellCast = () => { cancels += 1; };
  world.targetGuid = 5n;
  game.world = world;
  dom.auctionWindow.hidden = false;
  try {
    escape(false);
    assert.equal(cancels, 1, "the first press stops the cast");
    assert.equal(dom.auctionWindow.hidden, false, "and leaves the windows open");
    assert.equal(world.targetGuid, 5n, "and the target selected");
    assert.equal(gameMenuModule.gameMenuOpen(), false, "and opens no menu");
    escape(false);
    assert.equal(cancels, 1, "a cast already asked to stop is not cancelled again");
    assert.equal(dom.auctionWindow.hidden, true, "the second press closes the windows");
    assert.equal(world.targetGuid, 5n, "and only the windows");
    escape(false);
    assert.equal(world.targetGuid, undefined, "the third drops the target");
    assert.equal(gameMenuModule.gameMenuOpen(), false);
    escape(false);
    assert.equal(gameMenuModule.gameMenuOpen(), true, "the fourth opens the menu");
    world.targetGuid = 6n;
    escape(false);
    assert.equal(gameMenuModule.gameMenuOpen(), false, "an open menu closes before anything else");
    assert.equal(world.targetGuid, 6n);
  } finally {
    dom.auctionWindow.hidden = true;
    gameMenuModule.closeGameMenu();
    game.world = undefined;
  }
});

// 4.13: the native logout countdown is the CAMP popup's stand-in, and Escape on it is CAMP's
// hideOnEscape — CancelLogout — before the menu, the cast or any window.
test("native Escape with the logout countdown up cancels the logout and does nothing else", () => {
  const world = worldStub();
  let cancels = 0;
  world.logout = { result: 0, instant: false };
  world.loggedOut = false;
  world.cancelLogout = () => { cancels += 1; };
  world.targetGuid = 5n;
  game.world = world;
  dom.auctionWindow.hidden = false;
  try {
    gameMenuModule.updateLogoutPending(world, true);
    assert.equal(gameMenuModule.logoutCountdownOpen(), true);
    escape(false);
    assert.equal(cancels, 1, "CancelLogout");
    assert.equal(dom.auctionWindow.hidden, false, "the window stays");
    assert.equal(world.targetGuid, 5n, "the target stays");
    assert.equal(gameMenuModule.gameMenuOpen(), false, "no menu");
  } finally {
    gameMenuModule.resetLogoutPending();
    dom.auctionWindow.hidden = true;
    game.world = undefined;
  }
});
