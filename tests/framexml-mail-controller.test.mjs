import assert from "node:assert/strict";
import test from "node:test";

// The stock mail and trade owners and the native windows that step aside for them: Mail.showMail
// (the native window's onMailChanged slot), Social.showTrade (onTradeChanged), and Escape's window
// registry. A small fake DOM, real modules.

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
globalThis.HTMLImageElement = class extends FakeNode {};
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
      const element = id === "chat-input" || /^mail-(to|subject|money|silver|copper)$/.test(id) ? new FakeInput() : new FakeNode();
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
const mailController = await import("../dist/code/browser/framexml/FrameXmlMailController.js");
const tradeController = await import("../dist/code/browser/framexml/FrameXmlTradeController.js");
const mail = await import("../dist/code/browser/ui/Mail.js");
const social = await import("../dist/code/browser/ui/Social.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const windows = await import("../dist/code/browser/ui/Windows.js");
usePanelHost({ viewport: document.body, attach() {} });

function owner() {
  return { open: false, hides: 0, isOpen() { return this.open; }, hide() { this.open = false; this.hides += 1; } };
}

function world(extra = {}) {
  const calls = [];
  return {
    calls,
    state: { selfGuid: 1n, objects: new Map() },
    names: new Map(),
    itemTemplate: () => undefined,
    displayName: () => "Эльмира",
    mailboxGuid: 0x77n,
    mail: { totalCount: 0, mails: [] },
    mailMessage: undefined,
    mailResult: undefined,
    tradeOpen: false, tradePending: false, tradeBeginRequested: false, tradePartnerGuid: 9n,
    tradePartnerAccepted: false, theirOffer: undefined, tradeMessage: undefined,
    ownTradeOffer: () => ({ money: 0, spellId: 0, items: [] }),
    closeMailbox() { calls.push("closeMailbox"); this.mailboxGuid = 0n; },
    cancelTrade() { calls.push("cancelTrade"); },
    closeAuctionHouse() {}, closeBank() {}, closeLoot() {}, closeGossip() {}, closeQuest() {}, closeVendor() {},
    closeTrainer() {},
    battlefieldQueues: new Map(), battlefieldInviteDeadlines: new Map(),
    ...extra,
  };
}

for (const [name, controller, publish, published, open, close] of [
  ["mail", mailController, "publishFrameXmlMail", "frameXmlMailPublished", "frameXmlMailOpen", "closeFrameXmlMail"],
  ["trade", tradeController, "publishFrameXmlTrade", "frameXmlTradePublished", "frameXmlTradeOpen", "closeFrameXmlTrade"],
]) {
  test(`the ${name} controller answers false until published and keeps exactly one owner`, () => {
    assert.equal(controller[published](), false);
    assert.equal(controller[open](), false);
    assert.equal(controller[close](), false, "unpublished: the caller uses its native close");
    const first = owner();
    const second = owner();
    const releaseFirst = controller[publish](first);
    first.open = true;
    const releaseSecond = controller[publish](second);
    assert.equal(first.open, false, "a newer owner hides the stale one");
    second.open = true;
    assert.equal(controller[open](), true);
    releaseFirst();
    assert.equal(controller[published](), true, "a stale cleanup cannot unpublish the current owner");
    assert.equal(controller[close](), true);
    assert.equal(second.open, false);
    releaseSecond();
    assert.equal(controller[published](), false);
    const throwing = { isOpen() { throw new Error("gone"); }, hide() { throw new Error("gone"); } };
    const release = controller[publish](throwing);
    assert.equal(controller[open](), false, "a torn-down VM reads as closed");
    assert.equal(controller[close](), true);
    release();
  });
}

test("the native mail window steps aside for the stock owner without closing the mailbox", () => {
  const current = world();
  game.world = current;
  try {
    mail.showMail();
    assert.equal(dom.mailWindow.hidden, false, "unpublished: the native window is the mailbox");
    const stock = owner();
    const release = mailController.publishFrameXmlMail(stock);
    try {
      mail.showMail();
      assert.equal(dom.mailWindow.hidden, true, "published: a mail packet repaints nothing native");
      assert.equal(mail.mailOpen(), false, "Escape's native entry no longer counts it");
      assert.deepEqual(current.calls, [], "stepping aside keeps the mailbox open for stock");
      stock.open = true;
      assert.equal(windows.anyGameWindowOpen(), true, "the stock mailbox is an Escape-closable window");
      windows.closeGameWindows();
      assert.equal(stock.open, false, "Escape closes MailFrame (its OnHide CloseMail closes the mailbox)");
    } finally {
      release();
    }
    mail.showMail();
    assert.equal(dom.mailWindow.hidden, false, "unpublished again: the native window takes the mailbox back");
  } finally {
    mail.closeMail();
    game.world = undefined;
  }
});

test("the native trade window steps aside for an open trade only, never for the pending request", () => {
  const current = world({ tradePending: true });
  game.world = current;
  const stock = owner();
  const release = tradeController.publishFrameXmlTrade(stock);
  try {
    social.showTrade();
    assert.equal(dom.tradeWindow.hidden, false, "a request not yet opened is not the stock TradeFrame's");
    current.tradePending = false;
    current.tradeOpen = true;
    social.showTrade();
    assert.equal(dom.tradeWindow.hidden, true, "an open trade is stock TradeFrame's");
    stock.open = true;
    windows.closeGameWindows();
    assert.equal(stock.open, false, "Escape closes TradeFrame (its OnHide cancels the trade)");
    assert.deepEqual(current.calls, [], "the native cancel path did not run beside it");
  } finally {
    release();
  }
  try {
    social.showTrade();
    assert.equal(dom.tradeWindow.hidden, false, "unpublished: the native window shows the open trade");
  } finally {
    dom.tradeWindow.hidden = true;
    game.world = undefined;
  }
});
