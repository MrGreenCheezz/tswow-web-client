import assert from "node:assert/strict";
import test from "node:test";

function node(tag = "div") {
  const classes = new Set();
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(),
    id: "",
    hidden: true,
    value: "",
    style: {},
    dataset: {},
    children: [],
    listeners,
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      toggle(name, force) {
        const active = force === undefined ? !classes.has(name) : force;
        if (active) classes.add(name); else classes.delete(name);
        return active;
      },
      contains(name) { return classes.has(name); },
    },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    remove() {},
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener() {},
    querySelector(selector) {
      return selector === 'button[type="submit"]' ? node("button") : null;
    },
    querySelectorAll() { return []; },
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
  };
}

const elements = new Map();
const document = {
  head: node("head"),
  body: node("body"),
  createElement(tag) { return node(tag); },
  getElementById(id) {
    if (!elements.has(id)) { const element = node(); element.id = id; elements.set(id, element); }
    return elements.get(id);
  },
  querySelectorAll() { return []; },
};
globalThis.document = document;
globalThis.window = {
  innerWidth: 1024,
  innerHeight: 768,
  devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

const controller = await import("../dist/code/browser/framexml/FrameXmlPvpController.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const windows = await import("../dist/code/browser/ui/Windows.js");

test("the stable Escape registry entry closes the stock PvP owner", () => {
  const current = {
    open: false,
    isOpen() { return this.open; },
    show() { this.open = true; },
    hide() { this.open = false; },
  };
  const release = controller.publishFrameXmlPvp(current);
  try {
    current.show();
    assert.equal(windows.anyGameWindowOpen(), true);
    windows.closeGameWindows();
    assert.equal(current.open, false, "Escape registry closes PVP before menu fallback");
    assert.equal(windows.anyGameWindowOpen(), false);
  } finally {
    release();
    game.world = undefined;
  }
});

test("Escape recognises the native mailbox and closes its reader and server interaction together", async () => {
  const { WorldClient } = await import("../dist/code/world/WorldClient.js");
  const mail = await import("../dist/code/browser/ui/Mail.js");
  const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
  const dom = await import("../dist/code/browser/ui/Dom.js");
  usePanelHost({ viewport: document.body, attach() {} });
  const world = new WorldClient({ send() {}, close() {} });
  world.onMailChanged = mail.showMail;
  game.world = world;
  try {
    assert.equal(windows.anyGameWindowOpen(), false, "no other window may mask a missing mailbox entry");
    world.openMailbox(55n);
    world.mail = { totalCount: 1, mails: [{
      mailId: 7, senderType: 0, senderGuid: 0n, altSenderId: 0, cod: 0,
      packageId: 0, stationeryId: 41, money: 0, flags: 1, daysLeft: 30,
      mailTemplateId: 0, subject: "Проверка Escape", body: "Письмо", attachments: [],
    }] };
    mail.showMail();
    assert.equal(dom.mailWindow.hidden, false);
    assert.equal(mail.mailReadOpen(), false);
    assert.equal(windows.anyGameWindowOpen(), true, "the inbox alone must prevent Escape from opening the game menu");

    dom.mailList.children[0].listeners.get("click")();
    assert.equal(mail.mailReadOpen(), true, "the actual inbox action opens a separate reader");
    windows.closeGameWindows();
    assert.equal(world.mailboxGuid, 0n, "closing the windows releases the actual WorldClient mailbox interaction");
    assert.equal(world.mail, undefined);
    assert.equal(dom.mailWindow.hidden, true);
    assert.equal(mail.mailReadOpen(), false, "the letter cannot outlive its closed mailbox");
    assert.equal(windows.anyGameWindowOpen(), false);

    mail.showMail();
    assert.equal(dom.mailWindow.hidden, true, "a later repaint cannot reopen the closed mailbox");
    assert.equal(mail.mailReadOpen(), false);
  } finally {
    world.closeMailbox();
    mail.closeMailRead();
    dom.mailWindow.hidden = true;
    game.world = undefined;
  }
});
