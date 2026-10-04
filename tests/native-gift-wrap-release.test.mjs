// Review of lane L1 (03.10, item 2.05 slice E): native bags can arm wrapping paper (ui/NativeGiftWrap.ts),
// and with paper waiting the next click on a bag item sends CMSG_WRAP_ITEM. Wow.exe lets the paper go on
// Escape (0x0051fa50 → 0x00519280 → 0x006cef80) before any window, and on a right click in the world
// (0x0051fb00 → 0x00519280). With the stock UI mounted FrameXmlCursorDom.ts does both; the native HUD
// (input/Controls.ts) did neither, so paper armed by a double click stayed armed through Escape and
// wrapped whatever bag item was clicked next.
import assert from "node:assert/strict";
import test from "node:test";

function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = new Map();
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "", listeners,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
      removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      setPointerCapture() {}, releasePointerCapture() {},
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

const windowListeners = new Map();
globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener(name, handler) { windowListeners.set(name, [...(windowListeners.get(name) ?? []), handler]); },
  removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};
globalThis.HTMLInputElement = class {};
globalThis.HTMLSelectElement = class {};
globalThis.HTMLTextAreaElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const gift = await import("../dist/code/browser/game/GiftWrap.js");
const { wrapNativeSlot } = await import("../dist/code/browser/ui/NativeGiftWrap.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { wireControls } = await import("../dist/code/browser/input/Controls.js");

wireControls();
const canvas = document.getElementById("world-canvas");
const canvasHandler = (name) => (canvas.listeners.get(name) ?? [])[0];

function escape() {
  let prevented = false;
  const event = { code: "Escape", key: "Escape", repeat: false, target: undefined, defaultPrevented: false, preventDefault() { prevented = true; } };
  for (const listener of windowListeners.get("keydown") ?? []) listener(event);
  return prevented;
}

function rightClick() {
  const base = { pointerId: 1, clientX: 100, clientY: 100, movementX: 0, movementY: 0, preventDefault() {} };
  canvasHandler("pointerdown")({ ...base, button: 2, buttons: 2 });
  canvasHandler("pointerup")({ ...base, button: 2, buttons: 0 });
}

const PAPER = 0x4000_0000_0000_0901n;
const SHIRT = 0x4000_0000_0000_0902n;

function liveWorld() {
  const wraps = [];
  const selected = [];
  return {
    // No paper object in view: a wrap click would only be eaten (0x006dcf20), so the paper's state is the measure.
    wraps, selected, mapId: 0, state: { selfGuid: undefined, objects: new Map() },
    selectTarget(guid) { selected.push(guid); }, aurasFor: () => [],
    wrapItem(...args) { wraps.push(args); return true; },
  };
}

const shirtSlot = {
  index: 1, bag: 255, slot: 24, guid: SHIRT,
  item: { guid: SHIRT, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 45]]) },
};

test("native Escape lets waiting wrapping paper go: the next bag click is an ordinary one", () => {
  const world = liveWorld();
  game.world = world;
  try {
    gift.armGiftWrap(world, { bag: 255, slot: 23, guid: PAPER });
    assert.equal(gift.giftWrapPending(), true);
    assert.equal(escape(), true, "the press is spent");
    assert.equal(gift.giftWrapPending(), false, "Escape resets the cursor (0x0051fa50)");
    assert.equal(wrapNativeSlot(shirtSlot, world), false, "the click is the slot's own again");
    assert.deepEqual(world.wraps, [], "nothing is wrapped");
  } finally {
    gift.cancelGiftWrap();
    game.world = undefined;
  }
});

test("a native right click on the world lets waiting wrapping paper go and selects nothing", () => {
  const world = liveWorld();
  game.world = world;
  const previousScene = game.scene;
  try {
    game.scene = { pick: () => undefined };
    gift.armGiftWrap(world, { bag: 255, slot: 23, guid: PAPER });
    rightClick();
    assert.equal(gift.giftWrapPending(), false, "0x0051fb00 → 0x00519280");
    assert.deepEqual(world.selected, [], "the release is the paper's");
    assert.equal(wrapNativeSlot(shirtSlot, world), false);
    assert.deepEqual(world.wraps, []);
  } finally {
    game.scene = previousScene;
    gift.cancelGiftWrap();
    game.world = undefined;
  }
});
