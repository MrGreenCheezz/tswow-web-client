import assert from "node:assert/strict";
import test from "node:test";

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
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
  }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  fire(name, event = {}) {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) {
    return selector === 'button[type="submit"]' ? new FakeNode("button") : null;
  }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  getContext() { return {}; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = null; }
}
class FakeInput extends FakeNode { constructor() { super("input"); } }
class FakeSelect extends FakeNode { constructor() { super("select"); } }
class FakeTextarea extends FakeNode { constructor() { super("textarea"); } }
class FakeButton extends FakeNode { constructor() { super("button"); } }
globalThis.HTMLInputElement = FakeInput;
globalThis.HTMLSelectElement = FakeSelect;
globalThis.HTMLTextAreaElement = FakeTextarea;
globalThis.HTMLButtonElement = FakeButton;

const elements = new Map();
const guildClose = new FakeButton();
guildClose.dataset.close = "guild-window";
globalThis.document = {
  activeElement: null,
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  createElement(tag) {
    if (tag === "input") return new FakeInput();
    if (tag === "select") return new FakeSelect();
    if (tag === "textarea") return new FakeTextarea();
    if (tag === "button") return new FakeButton();
    return new FakeNode(tag);
  },
  createElementNS(_namespace, tag) { return this.createElement(tag); },
  getElementById(id) {
    if (!elements.has(id)) {
      const element = id === "chat-input" ? new FakeInput() : new FakeNode();
      element.id = id;
      elements.set(id, element);
    }
    return elements.get(id);
  },
  querySelectorAll(selector) { return selector === "[data-close]" ? [guildClose] : []; },
  addEventListener() {},
};
const windowListeners = new Map();
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener(name, handler, capture = false) {
    const handlers = windowListeners.get(name) ?? [];
    handlers.push({ handler, capture });
    windowListeners.set(name, handlers);
  },
  removeEventListener() {},
  fire(name, event) {
    const handlers = windowListeners.get(name) ?? [];
    for (const { handler } of [...handlers.filter((entry) => entry.capture), ...handlers.filter((entry) => !entry.capture)]) {
      handler(event);
    }
  },
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const windows = await import("../dist/code/browser/ui/Windows.js");
const quest = await import("../dist/code/browser/ui/QuestLog.js");
const barber = await import("../dist/code/browser/ui/BarberShop.js");
const channel = await import("../dist/code/browser/ui/ChannelRoster.js");
const guild = await import("../dist/code/browser/ui/Guild.js");
const questOwner = await import("../dist/code/browser/framexml/FrameXmlQuestController.js");
const controls = await import("../dist/code/browser/input/Controls.js");
const bindings = await import("../dist/code/browser/ui/KeyBindings.js");
const worldMap = await import("../dist/code/browser/ui/WorldMap.js");
usePanelHost({ viewport: document.body, attach() {} });
windows.wirePanelButtons();
controls.wireControls();

function worldStub(extra = {}) {
  return {
    state: { selfGuid: undefined, objects: new Map() },
    targetGuid: undefined,
    closeBank() {},
    closeAuctionHouse() {},
    cancelTrade() {},
    selectTarget() {},
    ...extra,
  };
}

test("Escape sees auction and trade windows and releases their server interactions", () => {
  let auctionCloses = 0;
  let tradeCancels = 0;
  game.world = worldStub({
    closeAuctionHouse() { auctionCloses++; },
    cancelTrade() { tradeCancels++; },
  });
  try {
    dom.auctionWindow.hidden = false;
    assert.equal(windows.anyGameWindowOpen(), true);
    windows.closeGameWindows();
    assert.equal(dom.auctionWindow.hidden, true);
    assert.equal(auctionCloses, 1);
    assert.equal(tradeCancels, 0);

    dom.tradeWindow.hidden = false;
    assert.equal(windows.anyGameWindowOpen(), true);
    windows.closeGameWindows();
    assert.equal(dom.tradeWindow.hidden, true);
    assert.equal(tradeCancels, 1);
  } finally {
    dom.auctionWindow.hidden = true;
    dom.tradeWindow.hidden = true;
    game.world = undefined;
  }
});

test("Escape registry closes the dynamic quest, barber and channel panels", () => {
  quest.toggleQuestLog();
  assert.equal(quest.questLogOpen(), true);
  assert.equal(windows.anyGameWindowOpen(), true);
  windows.closeGameWindows();
  assert.equal(quest.questLogOpen(), false);

  game.world = worldStub({ barberShopOpen: true });
  barber.showBarberShop();
  assert.equal(barber.barberOpen(), true);
  windows.closeGameWindows();
  assert.equal(barber.barberOpen(), false);

  game.world = worldStub({ channels: new Map(), requestChannelList() {} });
  channel.openChannelRoster("Общий");
  assert.equal(channel.channelRosterOpen(), true);
  windows.closeGameWindows();
  assert.equal(channel.channelRosterOpen(), false);
  game.world = undefined;
});

test("guild X remembers that the player closed the roster", () => {
  guild.resetGuildWindow();
  game.world = worldStub({ guildRoster: {} });
  try {
    dom.guildWindow.hidden = false;
    guildClose.fire("click");
    assert.equal(dom.guildWindow.hidden, true);
    guild.showGuild();
    assert.equal(dom.guildWindow.hidden, true, "a roster refresh must not reopen the dismissed window");
  } finally {
    guild.resetGuildWindow();
    game.world = undefined;
  }
});

test("visible native quest button reaches a published stock owner after a partial microbutton gate", () => {
  const owner = {
    open: false,
    isOpen() { return this.open; },
    show() { this.open = true; },
    hide() { this.open = false; },
  };
  const nativeState = quest.beginQuestLogNativeReplacement();
  const release = questOwner.publishFrameXmlQuest(owner);
  try {
    document.getElementById("quest-toggle").fire("click");
    assert.equal(owner.open, true);
    assert.equal(quest.questLogOpen(), false);
    document.getElementById("quest-toggle").fire("click");
    assert.equal(owner.open, false);
  } finally {
    release();
    quest.restoreQuestLogNativeReplacement(nativeState);
  }
});

test("Escape from an ordinary focused field dismisses its window; locally handled Escape stays local", () => {
  const input = new FakeInput();
  game.world = new WorldClient({ send() {}, close() {} });
  dom.auctionWindow.hidden = false;
  try {
    input.focus();
    let prevented = false;
    window.fire("keydown", { code: "Escape", target: input, defaultPrevented: false,
      preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, null);
    assert.equal(dom.auctionWindow.hidden, true);

    dom.auctionWindow.hidden = false;
    input.focus();
    input.blur(); // A search field cleared itself and released focus before bubbling.
    window.fire("keydown", { code: "Escape", target: input, defaultPrevented: false,
      preventDefault() {} });
    assert.equal(dom.auctionWindow.hidden, false);
  } finally {
    dom.auctionWindow.hidden = true;
    game.world = undefined;
  }
});

test("map picker and binding buttons expose their action names", () => {
  worldMap.toggleWorldMap();
  const mapRoot = document.body.children.find((child) => child.id === "world-map");
  const mapPicker = mapRoot.children[1].children[0].children[0];
  assert.equal(mapPicker.getAttribute("aria-label"), "Область карты");
  worldMap.closeWorldMap();

  bindings.toggleKeyBindingsWindow();
  const root = document.body.children.find((child) => child.id === "keybindings-window");
  const row = root.children[1].children.find((child) => child.className === "ui-binding-row");
  const [label, primary, secondary] = row.children;
  assert.match(primary.getAttribute("aria-label"), new RegExp(label.textContent));
  assert.match(secondary.getAttribute("aria-label"), new RegExp(label.textContent));
  assert.match(primary.getAttribute("aria-label"), /основная клавиша/);
  assert.match(secondary.getAttribute("aria-label"), /дополнительная клавиша/);
  primary.fire("click");
  assert.match(primary.getAttribute("aria-label"), /нажмите новую клавишу/);
  secondary.fire("click");
  assert.match(primary.getAttribute("aria-label"), /основная клавиша/);
  assert.notEqual(primary.textContent, "…", "switching slots restores the first button's key");
  bindings.closeKeyBindingsWindow();
});
