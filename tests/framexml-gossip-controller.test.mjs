import assert from "node:assert/strict";
import test from "node:test";

// The native NPC windows' step-aside hooks (Npc.ts, Bank.ts) against the four stock controllers:
// while a stock owner is published the native window stays hidden and the owner is told; while
// nothing is published the native window is the route, as before. A small fake DOM, real modules
// (the same harness as framexml-lfd-controller.test.mjs).
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
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const gossip = await import("../dist/code/browser/framexml/FrameXmlGossipController.js");
const taxi = await import("../dist/code/browser/framexml/FrameXmlTaxiController.js");
const bankController = await import("../dist/code/browser/framexml/FrameXmlBankController.js");
const npc = await import("../dist/code/browser/ui/Npc.js");
const bank = await import("../dist/code/browser/ui/Bank.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
usePanelHost({ viewport: document.body, attach() {} });

const PAGE = {
  guid: 77n, menuId: 1, textId: 5,
  options: [{ id: 0, icon: 0, coded: false, money: 0, text: "Привет", boxText: "" }],
  quests: [],
};

function npcWorld(extra = {}) {
  const calls = [];
  const creature = { typeId: 3, guid: 77n, fields: new Map([
    [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 295], [UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, 0x01],
  ]) };
  return {
    calls,
    state: { selfGuid: 1n, objects: new Map([[77n, creature]]) },
    npcTexts: new Map([[5, { id: 5, options: [{ probability: 1, male: "Здравствуй", female: "", language: 0 }] }]]),
    names: { declined: () => undefined, get: () => undefined },
    gameObjectTemplates: new Map(),
    openGossip(guid) { calls.push(["openGossip", guid]); },
    closeNpcServices() { calls.push(["closeNpcServices"]); this.taxiMenu = undefined; },
    closeGossip() { calls.push(["closeGossip"]); },
    closeBank() {},
    ...extra,
  };
}

function owner(log, name) {
  return {
    open: false,
    isOpen() { return this.open; },
    sync() { log.push(`${name}:sync`); },
    close() { log.push(`${name}:close`); this.open = false; },
  };
}

test("showGossip: the stock owner is told and the native window stays hidden; unpublished, it draws", () => {
  const world = npcWorld({ gossip: PAGE });
  game.world = world;
  const log = [];
  const release = gossip.publishFrameXmlGossip(owner(log, "gossip"));
  try {
    dom.gossipWindow.hidden = true;
    npc.showGossip();
    assert.deepEqual(log, ["gossip:sync"]);
    assert.equal(dom.gossipWindow.hidden, true, "no native window beside the stock one");
  } finally {
    release();
  }
  try {
    npc.showGossip();
    assert.equal(dom.gossipWindow.hidden, false, "unpublished: the native window is the conversation");
    assert.equal(log.length, 1);
  } finally {
    dom.gossipWindow.hidden = true;
    game.world = undefined;
  }
});

test("talking to a gossip NPC shows no native placeholder while the stock frame owns gossip", () => {
  const world = npcWorld();
  game.world = world;
  const release = gossip.publishFrameXmlGossip(owner([], "gossip"));
  try {
    dom.gossipWindow.hidden = true;
    npc.interactWithGuid(77n);
    assert.deepEqual(world.calls.at(-1), ["openGossip", 77n]);
    assert.equal(dom.gossipWindow.hidden, true, "stock GossipFrame opens on GOSSIP_SHOW, as the client does");
  } finally {
    release();
  }
  try {
    npc.interactWithGuid(77n);
    assert.equal(dom.gossipWindow.hidden, false, "unpublished: «Ожидание ответа NPC…» as before");
  } finally {
    dom.gossipWindow.hidden = true;
    game.world = undefined;
  }
});

test("a native quest page takes the stock conversation's place", () => {
  const world = npcWorld({ gossip: PAGE, questDialog: {
    kind: "details", guid: 77n, questId: 60, title: "Задание", details: "", objectives: "",
    rewards: { choices: [], items: [], money: 0, requiredMoney: 0, honor: 0, talents: 0, displaySpell: 0 },
  }, loadQuestItemMetadata: undefined });
  game.world = world;
  const log = [];
  const stock = owner(log, "gossip");
  stock.open = true;
  const release = gossip.publishFrameXmlGossip(stock);
  try {
    npc.showQuestState();
    assert.deepEqual(log, ["gossip:close"], "QuestFrame's slot: the conversation closes");
  } finally {
    release();
    dom.questWindow.hidden = true;
    game.world = undefined;
  }
});

test("the flight map and the bank step aside while their stock owners are published", () => {
  const world = npcWorld({ taxiMenu: { guid: 90n, currentNode: 2, knownNodes: [2] }, bankerGuid: 91n,
    bankMessage: undefined });
  game.world = world;
  const log = [];
  const releaseTaxi = taxi.publishFrameXmlTaxi(owner(log, "taxi"));
  const releaseBank = bankController.publishFrameXmlBank(owner(log, "bank"));
  try {
    dom.gossipWindow.hidden = true;
    npc.showTaxiMenu();
    assert.equal(dom.gossipWindow.hidden, true, "no native flight list beside TaxiFrame");
    npc.closeNpcServiceWindow();
    assert.deepEqual(log, ["taxi:sync"], "closeNpcServices forgets the map without an event: stock is told");
    bank.showBank();
    const bankPanel = () => document.body.children.find((element) => element.id === "bank-window");
    assert.equal(bankPanel()?.hidden ?? true, true, "no native bank panel beside BankFrame");
  } finally {
    releaseTaxi();
    releaseBank();
  }
  try {
    world.taxiMenu = { guid: 90n, currentNode: 2, knownNodes: [2] };
    npc.showTaxiMenu();
    assert.equal(dom.gossipWindow.hidden, false, "unpublished: the native flight list");
    bank.showBank();
    assert.equal(document.body.children.find((element) => element.id === "bank-window")?.hidden, false,
      "unpublished: the native bank");
  } finally {
    dom.gossipWindow.hidden = true;
    game.world = undefined;
  }
});
