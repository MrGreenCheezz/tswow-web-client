import assert from "node:assert/strict";
import test from "node:test";

// The lazy stock auction owner and the native #auction-window that steps aside for it
// (Social.showAuctions, the native window's onAuctionChanged slot), Escape's window registry, and
// the world mount's one call (FrameXmlAuctionMount.ts). A small fake DOM, real modules.

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attributes = new Map();
    this.hidden = true;
    this.value = "";
    this.className = "";
    this.textContent = "";
    this.disabled = false;
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
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === 'button[type="submit"]' ? new FakeNode("button") : null; }
  querySelectorAll() { return []; }
  contains(target) { return this === target; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  getContext() { return {}; }
  focus() {}
  blur() {}
}
globalThis.HTMLInputElement = class extends FakeNode {};
globalThis.HTMLSelectElement = class extends FakeNode {};
globalThis.HTMLTextAreaElement = class extends FakeNode {};
globalThis.HTMLButtonElement = class extends FakeNode {};
globalThis.HTMLElement = FakeNode;
globalThis.HTMLImageElement = class extends FakeNode {};
const elements = new Map();
globalThis.document = {
  activeElement: null,
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  createElement(tag) { return new FakeNode(tag); },
  createElementNS(_namespace, tag) { return new FakeNode(tag); },
  createTextNode(text) { return { textContent: text }; },
  getElementById(id) {
    if (!elements.has(id)) {
      const element = new FakeNode();
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
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlAuctionController.js");
const social = await import("../dist/code/browser/ui/Social.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const windows = await import("../dist/code/browser/ui/Windows.js");
const { mountFrameXmlAuction } = await import("../dist/code/browser/framexml/FrameXmlAuctionMount.js");
const { createCannedFrameXmlAuction } = await import("../dist/code/browser/framexml/FrameXmlAuctionCanned.js");
usePanelHost({ viewport: document.body, attach() {} });

function stock() {
  return {
    open: false, owns: false, closes: 0, hides: 0, disposed: 0,
    isOpen() { return this.open; }, ownsWindow() { return this.owns; },
    close() { this.closes += 1; this.open = false; return true; }, hide() { this.hides += 1; this.open = false; },
    dispose() { this.disposed += 1; },
  };
}

function world(extra = {}) {
  const calls = [];
  return {
    calls,
    state: { selfGuid: 1n, objects: new Map() },
    names: new Map(),
    auctioneerGuid: 0x77n, auctions: undefined, ownAuctions: undefined, bidAuctions: undefined, auctionMessage: undefined,
    closeAuctionHouse() { calls.push("closeAuctionHouse"); this.auctioneerGuid = 0n; },
    closeMailbox() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, closeGossip() {}, closeQuest() {}, closeVendor() {},
    closeTrainer() {},
    battlefieldQueues: new Map(), battlefieldInviteDeadlines: new Map(),
    ...extra,
  };
}

test("the auction controller answers false until published and keeps exactly one owner", () => {
  assert.equal(controller.frameXmlAuctionOwnsWindow(), false);
  assert.equal(controller.frameXmlAuctionOpen(), false);
  assert.equal(controller.closeFrameXmlAuction(), false, "unpublished: the caller uses its native close");
  const first = stock();
  const second = stock();
  const releaseFirst = controller.publishFrameXmlAuction(first);
  first.open = true;
  const releaseSecond = controller.publishFrameXmlAuction(second);
  assert.equal(first.open, false, "a newer owner hides the stale one");
  assert.equal(first.disposed, 1, "and disposes its pending load");
  second.open = true;
  second.owns = true;
  assert.equal(controller.frameXmlAuctionOpen(), true);
  assert.equal(controller.frameXmlAuctionOwnsWindow(), true);
  releaseFirst();
  assert.equal(controller.frameXmlAuctionOwnsWindow(), true, "a stale cleanup cannot unpublish the current owner");
  assert.equal(controller.closeFrameXmlAuction(), true);
  assert.equal(second.closes, 1);
  releaseSecond();
  assert.equal(controller.frameXmlAuctionOwnsWindow(), false);
  assert.equal(second.disposed, 1);
  const throwing = { isOpen() { throw new Error("gone"); }, ownsWindow() { throw new Error("gone"); }, close() { throw new Error("gone"); }, hide() {} };
  const release = controller.publishFrameXmlAuction(throwing);
  assert.equal(controller.frameXmlAuctionOpen(), false, "a torn-down VM reads as closed");
  assert.equal(controller.frameXmlAuctionOwnsWindow(), false);
  assert.equal(controller.closeFrameXmlAuction(), false);
  release();
});

test("the native window keeps the house while the add-on loads and steps aside once stock owns it", () => {
  const current = world();
  game.world = current;
  const owner = stock();
  const release = controller.publishFrameXmlAuction(owner);
  try {
    owner.open = true; // loading: the owner reports the house, but does not own the window yet
    social.showAuctions();
    assert.equal(dom.auctionWindow.hidden, false, "Blizzard_AuctionUI still loading: the native window shows the house");
    owner.owns = true;
    social.showAuctions();
    assert.equal(dom.auctionWindow.hidden, true, "gated: an auction packet repaints nothing native");
    assert.deepEqual(current.calls, [], "stepping aside keeps the house open for stock");
    assert.equal(windows.anyGameWindowOpen(), true, "the stock AuctionFrame is an Escape-closable window");
    windows.closeGameWindows();
    assert.equal(owner.closes, 1, "Escape closes AuctionFrame (its OnHide calls CloseAuctionHouse)");
    assert.deepEqual(current.calls, [], "the native close path did not run beside it");
  } finally {
    release();
  }
  social.showAuctions();
  assert.equal(dom.auctionWindow.hidden, false, "unpublished again: the native window takes the house back");
  game.world = undefined;
  social.showAuctions();
});

test("the world mount's call publishes a lazy owner that loads nothing until an auctioneer answers", async () => {
  const canned = createCannedFrameXmlAuction();
  const pumped = [];
  canned.model.attach({ fire: (event) => { pumped.push(event); return 1; }, now: () => 1 });
  const loads = [];
  const boot = {
    vm: { compileFunction: () => undefined, call: () => [], release() {}, errors: [], globalString: () => undefined },
    bridge: { getFrame: () => undefined, isVisible: () => false, diagnostics: [] },
    errorCount: 0,
    binder: { stubDiagnostics: [] },
    loadAddon: async (name) => { loads.push(name); return { ok: false, addon: name, status: "missing", message: "absent", dependencies: [], loaded: [], roots: [] }; },
  };
  const renderer = { elementFor: () => undefined, addRoots() {}, sync() {} };
  const current = world({ auctioneerGuid: 0n });
  game.world = current;
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    const cleanup = mountFrameXmlAuction({ auction: canned.model }, boot, renderer);
    await Promise.resolve();
    assert.deepEqual(loads, [], "no auctioneer: the add-on costs nothing");
    canned.world.open();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.deepEqual(loads, ["Blizzard_AuctionUI"], "the first hello starts the load");
    assert.match(warnings.join("\n"), /\[FrameXML auction\] Blizzard_AuctionUI: absent; the native window stays/);
    assert.equal(canned.model.owned, false);
    assert.deepEqual(pumped, [], "nothing reaches stock frames that never loaded");
    canned.world.open();
    await Promise.resolve();
    assert.deepEqual(loads, ["Blizzard_AuctionUI"], "a failed load is not retried for the session");
    current.auctioneerGuid = 0x77n;
    cleanup();
    assert.equal(dom.auctionWindow.hidden, false, "cleanup hands an open house back to the native window");
    assert.equal(controller.frameXmlAuctionOpen(), false);
  } finally {
    console.warn = warn;
    game.world = undefined;
  }
});

test("the mounted owner speaks the sold and outbid lines from login on, before any auctioneer", async () => {
  const canned = createCannedFrameXmlAuction();
  const pumped = [];
  canned.model.attach({ fire: (event, ...args) => { pumped.push([event, ...args]); return 1; }, now: () => 1 });
  const strings = { ERR_AUCTION_SOLD_S: "Ваш лот (%s) продан.", ERR_AUCTION_OUTBID_S: "Ваша ставка на «%s» перебита." };
  const loads = [];
  const boot = {
    vm: { compileFunction: () => undefined, call: () => [], release() {}, errors: [], globalString: (name) => strings[name] },
    bridge: { getFrame: () => undefined, isVisible: () => false, diagnostics: [] },
    errorCount: 0,
    binder: { stubDiagnostics: [] },
    loadAddon: async (name) => { loads.push(name); return { ok: false, addon: name, status: "missing", dependencies: [], loaded: [], roots: [] }; },
  };
  game.world = world({ auctioneerGuid: 0n });
  const cleanup = mountFrameXmlAuction({ auction: canned.model }, boot, { elementFor: () => undefined, addRoots() {}, sync() {} });
  try {
    canned.world.emit({ kind: "ownerNotification", auctionId: 3011, itemId: 2589, bid: 600 });
    canned.world.emit({ kind: "bidderNotification", auctionId: 3002, itemId: 4306, won: false, bid: 1650 });
    assert.deepEqual(pumped.map(([event, text]) => [event, text]), [
      ["CHAT_MSG_SYSTEM", "Ваш лот (Льняной материал) продан."], ["CHAT_MSG_SYSTEM", "Ваша ставка на «Шелковый материал» перебита."],
    ], "the VM's GlobalStrings are bound when the owner is created, not when the add-on passes its gate");
    assert.deepEqual(loads, [], "and Blizzard_AuctionUI still costs nothing");
  } finally {
    cleanup();
    game.world = undefined;
  }
  canned.world.emit({ kind: "ownerNotification", auctionId: 3003, itemId: 14047, bid: 0 });
  assert.equal(pumped.length, 2, "a torn-down owner's VM strings are unbound");
});

test("a newer owner published over a stale one keeps its own strings and open request", async () => {
  const canned = createCannedFrameXmlAuction();
  const pumped = [];
  canned.model.attach({ fire: (event, ...args) => { pumped.push([event, ...args]); return 1; }, now: () => 1 });
  const loads = [];
  const boot = (strings) => ({
    vm: { compileFunction: () => undefined, call: () => [], release() {}, errors: [], globalString: (name) => strings[name] },
    bridge: { getFrame: () => undefined, isVisible: () => false, diagnostics: [] },
    errorCount: 0,
    binder: { stubDiagnostics: [] },
    loadAddon: async (name) => { loads.push(name); return { ok: false, addon: name, status: "missing", dependencies: [], loaded: [], roots: [] }; },
  });
  const renderer = { elementFor: () => undefined, addRoots() {}, sync() {} };
  game.world = world({ auctioneerGuid: 0n });
  const warn = console.warn;
  console.warn = () => {};
  // The first VM's mount is never cleaned up; the second mount's publish disposes it.
  mountFrameXmlAuction({ auction: canned.model }, boot({ ERR_AUCTION_SOLD_S: "old %s" }), renderer);
  const cleanup = mountFrameXmlAuction({ auction: canned.model }, boot({ ERR_AUCTION_SOLD_S: "new %s" }), renderer);
  try {
    canned.world.emit({ kind: "ownerNotification", auctionId: 3011, itemId: 2589, bid: 600 });
    assert.deepEqual(pumped.map(([, text]) => text), ["new Льняной материал"], "the stale owner's dispose left the new strings bound");
    canned.world.open();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.deepEqual(loads, ["Blizzard_AuctionUI"], "and the new owner still hears the first auctioneer");
  } finally {
    console.warn = warn;
    cleanup();
    game.world = undefined;
  }
});

// L5c-review 3.24 (owner pending): as before L5c, an add-on already in does not start the owner at
// publish; Blizzard_AuctionUI loads at the first auctioneer (FrameXmlLodPreload.ts keeps it out).
test("an auction add-on already loaded still waits for the first auctioneer", async () => {
  const canned = createCannedFrameXmlAuction();
  canned.model.attach({ fire: () => 1, now: () => 1 });
  const loads = [];
  const boot = {
    vm: { compileFunction: () => undefined, call: () => [], release() {}, errors: [], globalString: () => undefined },
    bridge: { getFrame: () => undefined, isVisible: () => false, diagnostics: [] },
    errorCount: 0,
    binder: { stubDiagnostics: [] },
    isAddonLoaded: () => true,
    loadAddon: async (name) => { loads.push(name); return { ok: false, addon: name, status: "missing", dependencies: [], loaded: [], roots: [] }; },
  };
  game.world = world({ auctioneerGuid: 0n });
  const warn = console.warn;
  console.warn = () => {};
  const cleanup = mountFrameXmlAuction({ auction: canned.model }, boot, { elementFor: () => undefined, addRoots() {}, sync() {} });
  try {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.deepEqual(loads, [], "no auctioneer: no begin at publish");
    canned.world.open();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.deepEqual(loads, ["Blizzard_AuctionUI"], "the first hello starts it, as before");
  } finally {
    console.warn = warn;
    cleanup();
    game.world = undefined;
  }
});
