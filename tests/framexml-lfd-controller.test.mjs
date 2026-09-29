import assert from "node:assert/strict";
import test from "node:test";

// The stock dungeon finder's owner and the native routes that reach it: Social.ts's toggle (the
// micro button, I, the HUD button, /lfg, the native menu entry, stock ToggleLFDParentFrame), the
// native window's packet repaint and InteractionPrompts. A small fake DOM, real modules.

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
const controller = await import("../dist/code/browser/framexml/FrameXmlLfdController.js");
const social = await import("../dist/code/browser/ui/Social.js");
const prompts = await import("../dist/code/browser/ui/InteractionPrompts.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const { runAction } = await import("../dist/code/browser/input/Actions.js");
const { actionFor, DEFAULT_BINDINGS } = await import("../dist/code/browser/input/Bindings.js");
const windows = await import("../dist/code/browser/ui/Windows.js");
usePanelHost({ viewport: document.body, attach() {} });

function owner() {
  return {
    open: false, shows: 0,
    isOpen() { return this.open; },
    show() { this.open = true; this.shows += 1; },
    hide() { this.open = false; },
  };
}

function lfgWorld(extra = {}) {
  const calls = [];
  return {
    calls,
    state: { selfGuid: 1n, objects: new Map() },
    lfgRolesChosen: new Map(),
    battlefieldQueues: new Map(),
    battlefieldInviteDeadlines: new Map(),
    expireInteractionRequests() {},
    summonBlockReason() { return undefined; },
    displayName: () => "Бета",
    requestDungeonLocks() { calls.push("locks"); },
    requestName() {},
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, closeGossip() {},
    ...extra,
  };
}

const allText = (node) => [node.textContent ?? "", ...(node.children ?? []).map(allText)].join(" ");

test("the controller answers false until published, keeps one owner and tells the prompts who owns them", () => {
  assert.equal(controller.toggleFrameXmlLfd(), false);
  assert.equal(controller.frameXmlLfdPublished(), false);
  const first = owner();
  const second = owner();
  const releaseFirst = controller.publishFrameXmlLfd(first);
  first.show();
  const releaseSecond = controller.publishFrameXmlLfd(second);
  assert.equal(first.open, false);
  assert.equal(controller.toggleFrameXmlLfd(), true);
  assert.equal(controller.frameXmlLfdOpen(), true);
  releaseFirst();
  assert.equal(controller.frameXmlLfdPublished(), true, "a stale cleanup cannot unpublish the current owner");
  releaseSecond();
  assert.equal(second.open, false);
  assert.equal(controller.frameXmlLfdPublished(), false);
});

test("every native entry point reaches the stock finder first: I, the HUD button, /lfg, the menu entry", () => {
  assert.equal(actionFor("KeyI"), "toggleLfd", "TOGGLELFGPARENT is I, as in the 3.3.5 client");
  assert.deepEqual(DEFAULT_BINDINGS.toggleLfd, ["KeyI", ""]);
  const world = lfgWorld();
  game.world = world;
  const stock = owner();
  const release = controller.publishFrameXmlLfd(stock);
  try {
    assert.equal(runAction("toggleLfd"), true);
    assert.equal(stock.open, true, "I opens the stock LFDParentFrame");
    assert.equal(dom.lfgWindow.hidden, true, "the native window stays closed");
    assert.deepEqual(world.calls, [], "the stock OnShow asks for locks itself; the native path does not run");
    social.toggleLfgWindow();
    assert.equal(stock.open, false);
    // An LFG packet reaches the native window's single slot (onLfgChanged = showLfg) while stock owns it.
    world.lfgStatus = { updateType: 6, joined: true, queued: true, dungeons: [40], comment: "" };
    social.showLfg();
    assert.equal(dom.lfgWindow.hidden, true, "no native window opens beside the stock one on a queue update");
    stock.show();
    windows.closeGameWindows();
    assert.equal(stock.open, false, "Escape's window registry closes the stock finder");
  } finally {
    release();
  }
  try {
    world.lfgStatus = undefined;
    social.toggleLfgWindow();
    assert.equal(dom.lfgWindow.hidden, false, "unpublished: the native window is the finder");
    assert.deepEqual(world.calls, ["locks"]);
    social.closeLfgWindow();
  } finally {
    game.world = undefined;
  }
});

test("the native prompts step aside for the stock popups but keep the completion reward", () => {
  const proposal = { dungeonEntry: 40 | (1 << 24), state: 0, proposalId: 7, encounters: 0, showWindow: true,
    players: [{ roles: 2, self: true, inDungeon: false, sameGroup: false, answered: false, accepted: false }] };
  const world = lfgWorld({
    lfgProposal: proposal,
    lfgRoleCheck: { state: 2, starting: true, dungeons: [40], members: [{ guid: 1n, ready: false, roles: 0, level: 60 }] },
    lfgBoot: { inProgress: true, voted: false, votedYes: false, victimGuid: 5n, votes: 1, agree: 1, secondsLeft: 0, votesNeeded: 3, reason: "afk" },
    lfgBootExpiresAt: 0,
    lfgOfferContinue: 40,
    lfgReward: { randomEntry: 0, dungeonEntry: 40, reward: { done: false, money: 0, experience: 0, items: [] } },
  });
  game.world = world;
  const panel = () => document.body.children.find((element) => element.id === "interaction-prompts");
  try {
    prompts.showInteractionPrompts(0);
    const native = allText(panel());
    for (const text of ["Войти?", "Подтвердите роль", "Исключить", "Продолжить с этой группой", "Награда за подземелье"]) {
      assert.match(native, new RegExp(text), `unpublished: «${text}» is the native prompt's`);
    }
    const release = controller.publishFrameXmlLfd(owner());
    try {
      prompts.showInteractionPrompts(0);
      const withStock = allText(panel());
      for (const text of ["Войти?", "Подтвердите роль", "Исключить", "Продолжить с этой группой"]) {
        assert.doesNotMatch(withStock, new RegExp(text), `published: «${text}» belongs to the stock popup`);
      }
      assert.match(withStock, /Награда за подземелье/, "the reward has no stock owner in this vertical");
    } finally {
      release();
    }
  } finally {
    prompts.resetInteractionPrompts();
    game.world = undefined;
  }
});
