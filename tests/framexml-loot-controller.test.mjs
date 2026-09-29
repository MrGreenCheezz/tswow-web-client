import assert from "node:assert/strict";
import test from "node:test";

// The stock loot owner and the native paths it replaces: Npc.ts's #loot-window (EnterWorld's
// onLootChanged → showLoot), LootRolls.ts's roll/master cards and Windows.ts's Escape registry.
// A small fake DOM, real modules.

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
    this.isConnected = true;
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
  get childElementCount() { return this.children.length; }
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
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {},
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlLootController.js");
const { showLoot } = await import("../dist/code/browser/ui/Npc.js");
const { showLootRolls, lootRollsOpen } = await import("../dist/code/browser/ui/LootRolls.js");
const { lootWindow } = await import("../dist/code/browser/ui/Dom.js");
const { settingsStore } = await import("../dist/code/browser/ui/Settings.js");
const windows = await import("../dist/code/browser/ui/Windows.js");

function owner() {
  return {
    open: false, releases: 0,
    isOpen() { return this.open; },
    hide() { this.open = false; },
    release() { this.releases += 1; this.open = false; },
  };
}

function lootWorld(calls, extra = {}) {
  return {
    loot: { guid: 11n, lootType: 1, gold: 50, slots: [
      { index: 0, itemId: 2589, count: 1, displayId: 7383, randomSuffix: 0, randomPropertyId: 0, slotType: 0, taken: false },
    ] },
    lootRolls: new Map([[0x40n, {
      start: { itemGuid: 0x40n, mapId: 409, itemSlot: 1, itemId: 2589, randomSuffix: 0, randomPropertyId: 0, count: 1,
        countdown: 60000, voteMask: 0x07 },
      startedAt: Date.now(), votes: [],
    }]]),
    masterLootCandidates: [],
    state: { selfGuid: 1n, objects: new Map() },
    takeLootSlot() {}, takeLootMoney() {},
    takeAllLoot() { calls.push("take-all"); },
    closeLoot() { calls.push("release"); },
    itemTemplate: () => undefined,
    displayName: () => "",
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeGossip() {}, closeQuest() {}, closeVendor() {},
    ...extra,
  };
}

function withSound() {
  game.sound = { play() {} };
  game.soundKits = { named: () => undefined, namedAnswered: () => true, kit: (id) => ({ id, name: "x" }) };
  game.itemMetadata = { get: () => undefined, load: async () => false, displayIconUrl: (id) => `/item-icon/${id}` };
}

test("the controller answers false until published, keeps one owner, and a stale cleanup is inert", () => {
  assert.equal(controller.frameXmlLootPublished(), false);
  assert.equal(controller.frameXmlLootOpen(), false);
  assert.equal(controller.closeFrameXmlLoot(), false, "unpublished: the caller uses its native path");
  const first = owner();
  const second = owner();
  const releaseFirst = controller.publishFrameXmlLoot(first);
  assert.equal(controller.frameXmlLootPublished(), true);
  first.open = true;
  assert.equal(controller.frameXmlLootOpen(), true);
  const releaseSecond = controller.publishFrameXmlLoot(second);
  assert.equal(first.releases, 1, "a replaced owner is released, not hidden (hiding would release the corpse)");
  releaseFirst();
  assert.equal(controller.frameXmlLootPublished(), true, "a stale cleanup cannot unpublish the current owner");
  second.open = true;
  assert.equal(controller.closeFrameXmlLoot(), true);
  assert.equal(second.open, false, "close is the stock HideUIPanel");
  releaseSecond();
  releaseSecond();
  assert.equal(second.releases, 1, "cleanup releases once");
  assert.equal(controller.frameXmlLootPublished(), false);
});

test("the native loot window steps aside while stock owns loot, and takes the corpse back without a second auto-loot", () => {
  withSound();
  const calls = [];
  settingsStore.set({ ...settingsStore.value, autoLoot: true });
  try {
    game.world = lootWorld(calls);
    const release = controller.publishFrameXmlLoot(owner());
    try {
      showLoot();
      assert.equal(lootWindow.hidden, true, "no native window beside the stock LootFrame");
      assert.deepEqual(calls, [], "auto-loot belongs to the stock model while published");
    } finally {
      release();
    }
    showLoot();
    assert.equal(lootWindow.hidden, false, "unpublished: the native window shows the open corpse");
    assert.deepEqual(calls, [], "the handed-back opening is not auto-looted a second time");
    game.world = lootWorld(calls);
    showLoot();
    assert.deepEqual(calls, ["take-all"], "a new opening auto-loots natively as before");
  } finally {
    settingsStore.set({ ...settingsStore.value, autoLoot: false });
    game.world = undefined;
    showLoot();
  }
});

test("the native roll cards step aside for GroupLootFrames, so Escape no longer finds them", () => {
  withSound();
  document.getElementById("world-viewport");
  const calls = [];
  try {
    game.world = lootWorld(calls);
    showLootRolls();
    assert.equal(lootRollsOpen(), true, "unpublished: the native card is up");
    const release = controller.publishFrameXmlLoot(owner());
    try {
      showLootRolls();
      assert.equal(lootRollsOpen(), false, "published: GroupLootFrame1 shows the roll instead");
    } finally {
      release();
    }
    showLootRolls();
    assert.equal(lootRollsOpen(), true, "the native card comes back with the route");

    // A roll answered on a stock GroupLootFrame (its own vote echoed back) stays answered when the
    // route comes back; the unanswered one returns.
    const world = lootWorld(calls);
    world.lootRolls.set(0x41n, { ...world.lootRolls.get(0x40n), start: { ...world.lootRolls.get(0x40n).start, itemGuid: 0x41n },
      votes: [{ playerGuid: 1n, rollType: 2, rollNumber: 128, autoPass: false }] });
    game.world = world;
    const again = controller.publishFrameXmlLoot(owner());
    showLootRolls();
    again();
    showLootRolls();
    const cards = document.getElementById("world-viewport").children.find((child) => child.id === "loot-rolls");
    assert.equal(cards.childElementCount, 1, "only the roll the player has not answered comes back");
  } finally {
    game.world = undefined;
    showLootRolls();
  }
});

test("Escape's window registry sees and closes the stock loot window", () => {
  const stock = owner();
  const release = controller.publishFrameXmlLoot(stock);
  try {
    assert.equal(windows.anyGameWindowOpen(), false);
    stock.open = true;
    assert.equal(windows.anyGameWindowOpen(), true, "an open LootFrame is a window Escape closes");
    windows.closeGameWindows();
    assert.equal(stock.open, false);
    assert.equal(stock.releases, 0, "Escape hides (and so releases the corpse); it never unpublishes");
  } finally {
    release();
  }
});
