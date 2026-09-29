import assert from "node:assert/strict";
import test from "node:test";

// The lazy stock guild bank owner and the native #guild-bank-window that steps aside for it
// (ui/GuildBank.ts: showGuildBank, guildBankOpen, closeGuildBank), Escape's window registry, and the
// world mount's one call (FrameXmlGuildBankMount.ts). A small fake DOM, real modules.

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
const controller = await import("../dist/code/browser/framexml/FrameXmlGuildBankController.js");
const native = await import("../dist/code/browser/ui/GuildBank.js");
const windows = await import("../dist/code/browser/ui/Windows.js");
const { mountFrameXmlGuildBank } = await import("../dist/code/browser/framexml/FrameXmlGuildBankMount.js");
const { createCannedFrameXmlGuildBank } = await import("../dist/code/browser/framexml/FrameXmlGuildBankCanned.js");
const panels = new Map();
usePanelHost({ viewport: document.body, attach(root) { panels.set(root.id, root); } });
const nativeShown = () => panels.get("guild-bank-window")?.hidden === false;

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
    guildBankerGuid: 0xf110n, guildBank: undefined, guildPermissions: undefined, guildBankLog: undefined,
    guildBankWithdrawRemaining: undefined, guildBankTabText: new Map(),
    itemTemplate: () => undefined, displayName: (guid) => `0x${guid.toString(16)}`,
    closeGuildBank() { calls.push("closeGuildBank"); this.guildBankerGuid = 0n; },
    closeMailbox() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, closeGossip() {}, closeQuest() {}, closeVendor() {},
    closeTrainer() {}, closeAuctionHouse() {},
    battlefieldQueues: new Map(), battlefieldInviteDeadlines: new Map(),
    ...extra,
  };
}

test("the guild bank controller answers false until published and keeps exactly one owner", () => {
  assert.equal(controller.frameXmlGuildBankOwnsWindow(), false);
  assert.equal(controller.frameXmlGuildBankOpen(), false);
  assert.equal(controller.closeFrameXmlGuildBank(), false, "unpublished: the caller uses its native close");
  const first = stock();
  const second = stock();
  const releaseFirst = controller.publishFrameXmlGuildBank(first);
  first.open = true;
  const releaseSecond = controller.publishFrameXmlGuildBank(second);
  assert.equal(first.open, false, "a newer owner hides the stale one");
  assert.equal(first.disposed, 1, "and disposes its pending load");
  second.open = true;
  second.owns = true;
  assert.equal(controller.frameXmlGuildBankOpen(), true);
  assert.equal(controller.frameXmlGuildBankOwnsWindow(), true);
  releaseFirst();
  assert.equal(controller.frameXmlGuildBankOwnsWindow(), true, "a stale cleanup cannot unpublish the current owner");
  assert.equal(controller.closeFrameXmlGuildBank(), true);
  assert.equal(second.closes, 1);
  releaseSecond();
  assert.equal(controller.frameXmlGuildBankOwnsWindow(), false);
  assert.equal(second.disposed, 1);
  const throwing = { isOpen() { throw new Error("gone"); }, ownsWindow() { throw new Error("gone"); }, close() { throw new Error("gone"); }, hide() {} };
  const release = controller.publishFrameXmlGuildBank(throwing);
  assert.equal(controller.frameXmlGuildBankOpen(), false, "a torn-down VM reads as closed");
  assert.equal(controller.frameXmlGuildBankOwnsWindow(), false);
  assert.equal(controller.closeFrameXmlGuildBank(), false);
  release();
});

test("the native window keeps the vault while the add-on loads and steps aside once stock owns it", () => {
  const current = world();
  game.world = current;
  const owner = stock();
  const release = controller.publishFrameXmlGuildBank(owner);
  try {
    owner.open = true; // loading: the owner reports the bank, but does not own the window yet
    native.showGuildBank();
    assert.equal(nativeShown(), true, "Blizzard_GuildBankUI still loading: the native window shows the vault");
    owner.owns = true;
    native.showGuildBank();
    assert.equal(nativeShown(), false, "gated: a bank packet repaints nothing native");
    assert.deepEqual(current.calls, [], "stepping aside keeps the bank open for stock");
    assert.equal(native.guildBankOpen(), true, "the stock GuildBankFrame answers for the window");
    assert.equal(windows.anyGameWindowOpen(), true, "and is Escape-closable through the native entry");
    windows.closeGameWindows();
    assert.equal(owner.closes, 1, "Escape closes GuildBankFrame (its OnHide calls CloseGuildBankFrame)");
    assert.deepEqual(current.calls, [], "the native close path did not run beside it");
  } finally {
    release();
  }
  native.showGuildBank();
  assert.equal(nativeShown(), true, "unpublished again: the native window takes the vault back");
  native.closeGuildBank();
  assert.deepEqual(current.calls, ["closeGuildBank"], "and closes it itself");
  assert.equal(nativeShown(), false);
  game.world = undefined;
});

test("the world mount's call publishes a lazy owner that loads nothing until a vault answers", async () => {
  const canned = createCannedFrameXmlGuildBank();
  const pumped = [];
  canned.model.attach({ fire: (event) => { pumped.push(event); return 1; }, now: () => 1 });
  const loads = [];
  const boot = {
    // A VM that runs the preload (the vault's tab info behind the stock names) and nothing else.
    vm: { compileFunction: () => ({}), call: () => [1], release() {}, errors: [], globalString: () => undefined },
    bridge: { getFrame: () => undefined, isVisible: () => false, diagnostics: [] },
    errorCount: 0,
    binder: { stubDiagnostics: [] },
    loadAddon: async (name) => { loads.push(name); return { ok: false, addon: name, status: "missing", message: "absent", dependencies: [], loaded: [], roots: [] }; },
  };
  const renderer = { elementFor: () => undefined, addRoots() {}, sync() {} };
  let iconLoads = 0;
  const macros = { loadIcons: async () => { iconLoads += 1; } };
  const current = world({ guildBankerGuid: 0n });
  game.world = current;
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    const cleanup = mountFrameXmlGuildBank({ guildBank: canned.model, macros }, boot, renderer);
    await Promise.resolve();
    canned.model.tick();
    assert.deepEqual(loads, [], "no vault: the add-on costs nothing");
    assert.equal(iconLoads, 0, "nor the icon picker's list");
    canned.world.open();
    canned.model.tick();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.deepEqual(loads, ["Blizzard_GuildBankUI"], "the activation starts the load");
    assert.equal(iconLoads, 1, "with the macro item icons beside it");
    assert.match(warnings.join("\n"), /\[FrameXML guild bank\] Blizzard_GuildBankUI: absent; the native window stays/);
    assert.equal(canned.model.owned, false);
    canned.world.answerOpen();
    assert.equal(pumped.includes("GUILDBANKFRAME_OPENED"), false, "nothing opens stock frames that never loaded");
    canned.model.close();
    canned.world.open();
    canned.model.tick();
    await Promise.resolve();
    assert.deepEqual(loads, ["Blizzard_GuildBankUI"], "a failed load is not retried for the session");
    current.guildBankerGuid = 0xf110n;
    cleanup();
    assert.equal(nativeShown(), true, "cleanup hands an open vault back to the native window");
    assert.equal(controller.frameXmlGuildBankOpen(), false);
  } finally {
    console.warn = warn;
    game.world = undefined;
  }
});

test("a vault already open when the mount publishes starts the load at once", async () => {
  const canned = createCannedFrameXmlGuildBank();
  canned.model.attach({ fire: () => 1, now: () => 1 });
  canned.world.open();
  canned.world.answerOpen();
  const loads = [];
  const boot = {
    vm: { compileFunction: () => ({}), call: () => [1], release() {}, errors: [] },
    bridge: { getFrame: () => undefined, isVisible: () => false, diagnostics: [] },
    errorCount: 0,
    binder: { stubDiagnostics: [] },
    loadAddon: async (name) => { loads.push(name); return { ok: false, addon: name, status: "missing", dependencies: [], loaded: [], roots: [] }; },
  };
  game.world = world();
  const warn = console.warn;
  console.warn = () => {};
  const cleanup = mountFrameXmlGuildBank({ guildBank: canned.model }, boot, { elementFor: () => undefined, addRoots() {}, sync() {} });
  try {
    await Promise.resolve();
    assert.deepEqual(loads, ["Blizzard_GuildBankUI"]);
  } finally {
    console.warn = warn;
    cleanup();
    game.world = undefined;
  }
});
