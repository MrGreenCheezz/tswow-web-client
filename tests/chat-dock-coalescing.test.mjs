import assert from "node:assert/strict";
import test from "node:test";

// A crowd asks for forty names at a time, says things, and fights: the chat pane used to be rebuilt
// for every name answer, the tab bar rebuilt for every line, and every line read the pane's scroll
// metrics twice — each read a forced layout. These pin what replaced that: a redraw only when a
// line on screen reads differently, badges written in place, one scroll decision per frame, and no
// pane work at all while the stock chat owns the screen.

let layoutReads = 0;
function makeNode(tag = "div") {
  let scrollTop = 0;
  const node = {
    tagName: String(tag).toUpperCase(), children: [], hidden: false, disabled: false,
    value: "", textContent: "", type: "", checked: false,
    dataset: {}, id: "", className: "", title: "",
    style: { setProperty() {}, removeProperty() {} },
    parentNode: undefined, listeners: new Map(),
    clientHeightValue: 100, scrollHeightValue: 0,
    get scrollTop() { layoutReads += 1; return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeightValue - this.clientHeightValue)); },
    get clientHeight() { layoutReads += 1; return this.clientHeightValue; },
    get scrollHeight() { layoutReads += 1; return this.scrollHeightValue; },
    get childElementCount() { return node.children.length; },
    get firstElementChild() { return node.children[0]; },
    classList: {
      _set: new Set(),
      add(...names) { for (const name of names) node.classList._set.add(name); node.className = [...node.classList._set].join(" "); },
      remove(...names) { for (const name of names) node.classList._set.delete(name); node.className = [...node.classList._set].join(" "); },
      toggle() { return false; },
      contains: (name) => node.classList._set.has(name),
    },
    append(...kids) { for (const kid of kids) { kid.parentNode = node; node.children.push(kid); } },
    prepend(...kids) { for (const kid of [...kids].reverse()) { kid.parentNode = node; node.children.unshift(kid); } },
    replaceChildren(...kids) { node.children = [...kids]; for (const kid of kids) kid.parentNode = node; },
    remove() {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((kid) => kid !== node);
      node.parentNode = undefined;
    },
    insertBefore(kid, before) {
      kid.parentNode = node;
      const at = before ? node.children.indexOf(before) : -1;
      if (at < 0) node.children.push(kid);
      else node.children.splice(at, 0, kid);
    },
    addEventListener(type, run) {
      const list = node.listeners.get(type) ?? [];
      list.push(run);
      node.listeners.set(type, list);
    },
    removeEventListener() {},
    setAttribute(name, value) { node[name] = value; },
    getAttribute(name) { return node[name] ?? null; },
    removeAttribute() {},
    focus() {}, blur() {},
    querySelector() { return makeNode("button"); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return node;
}

const chatWindow = makeNode("section");
const chatTabs = makeNode("div");
const chatLog = makeNode("div");
const chatForm = makeNode("form");
const chatInput = makeNode("input");
chatWindow.append(chatTabs, chatLog, chatForm);
const body = makeNode("body");
const byId = new Map([
  ["chat-window", chatWindow], ["chat-tabs", chatTabs], ["chat-log", chatLog],
  ["chat-form", chatForm], ["chat-input", chatInput],
  ["login-form", makeNode("form")], ["gateway", makeNode("input")],
  ["username", makeNode("input")], ["password", makeNode("input")], ["token", makeNode("input")],
  ["status", makeNode("p")], ["realms", makeNode("div")],
]);
globalThis.document = {
  createElement: (tag) => makeNode(tag),
  createElementNS: (_ns, tag) => makeNode(tag),
  body,
  documentElement: makeNode("html"),
  createTextNode: (text) => ({ textContent: text }),
  getElementById: (id) => {
    if (!byId.has(id)) {
      const node = makeNode("div");
      node.id = id;
      byId.set(id, node);
    }
    return byId.get(id);
  },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.location = { origin: "http://localhost:5173", protocol: "http:", hostname: "localhost" };
const frames = [];
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
globalThis.HTMLElement = class {};
globalThis.HTMLInputElement = class {};
globalThis.HTMLButtonElement = class {};
globalThis.HTMLSelectElement = class {};
globalThis.HTMLTextAreaElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const dock = await import("../dist/code/browser/ui/ChatDock.js");

const CHAT_MSG_SAY = 0x01;
const CHAT_MSG_WHISPER = 0x07;
const runFrame = () => { for (const callback of frames.splice(0)) callback(); };

function crowdWorld() {
  const names = new Map();
  return {
    names,
    chatLog: [],
    channels: new Map(),
    state: { selfGuid: 1n, objects: new Map() },
    displayName(guid) { return names.get(guid) ?? `0x${guid.toString(16).padStart(16, "0")}`; },
  };
}

function say(world, guid, text) {
  const message = {
    type: CHAT_MSG_SAY, language: 0, senderGuid: guid, senderName: "", receiverGuid: 0n, receiverName: "",
    channel: "", text, tag: 0, achievementId: 0, at: 1,
  };
  world.chatLog.push(message);
  dock.appendChatMessage(message);
  return message;
}

const paneText = () => chatLog.children.map((line) => line.children.map((part) => part.textContent).join("")).join("\n");
const sameNodes = (left, right) => left.length === right.length && left.every((node, index) => node === right[index]);

test("a name answer redraws the pane only when a line on it now reads differently", () => {
  const world = crowdWorld();
  game.world = world;
  dock.resetChatDock();
  try {
    say(world, 100n, "привет");
    say(world, 101n, "торгую");
    runFrame();
    const drawn = [...chatLog.children];
    // Forty neighbours answer; none of them has said anything on screen.
    for (let guid = 200n; guid < 240n; guid += 1n) world.names.set(guid, `Сосед${guid}`);
    dock.refreshChatNames();
    assert.ok(sameNodes(chatLog.children, drawn), "answers about people not on screen leave the pane alone");

    // The speaker of a line on screen gets a name: that line reads differently now.
    world.names.set(101n, "Торговец");
    dock.refreshChatNames();
    assert.ok(!sameNodes(chatLog.children, drawn), "the pane is redrawn");
    assert.match(paneText(), /Торговец/);
    assert.equal(chatLog.children.length, 2);

    const redrawn = [...chatLog.children];
    dock.refreshChatNames();
    assert.ok(sameNodes(chatLog.children, redrawn), "and not again while nothing moved");

    // An emote sentence rewritten in place (`refreshEmoteLines`) is a changed line as well.
    world.chatLog[0].emote = { textEmoteId: 1 };
    world.chatLog[0].text = "машет рукой Торговцу";
    dock.refreshChatNames();
    assert.match(paneText(), /машет рукой Торговцу/);
  } finally {
    runFrame();
    dock.resetChatDock();
    game.world = undefined;
  }
});

test("a line for another tab moves its badge on the buttons already drawn", () => {
  const world = crowdWorld();
  game.world = world;
  dock.resetChatDock();
  try {
    const buttons = [...chatTabs.children];
    const whisper = {
      type: CHAT_MSG_WHISPER, language: 0, senderGuid: 300n, senderName: "Шептун", receiverGuid: 0n,
      receiverName: "", channel: "", text: "psst", tag: 0, achievementId: 0, at: 1,
    };
    world.chatLog.push(whisper);
    dock.appendChatMessage(whisper);
    dock.recordCombatEntry({ at: 1, text: "удар", kind: "muted", casterGuid: 5n, targetGuid: 6n, spellId: 0 });
    dock.recordCombatEntry({ at: 1, text: "удар", kind: "muted", casterGuid: 5n, targetGuid: 6n, spellId: 0 });
    assert.ok(sameNodes(chatTabs.children, buttons), "the bar is not rebuilt for a count");
    const byTab = Object.fromEntries(chatTabs.children.map((button) => [button.dataset.chatTab, button.dataset.unread]));
    assert.deepEqual(byTab, { general: undefined, whisper: "1", combat: "2" });
  } finally {
    runFrame();
    dock.resetChatDock();
    game.world = undefined;
  }
});

test("lines appended between two frames read the pane once and scroll it once, at the frame", () => {
  const world = crowdWorld();
  game.world = world;
  dock.resetChatDock();
  runFrame();
  try {
    chatLog.scrollHeightValue = 100;
    layoutReads = 0;
    for (let index = 0; index < 20; index += 1) {
      say(world, 400n + BigInt(index), `строка ${index}`);
      chatLog.scrollHeightValue += 20;
    }
    assert.ok(layoutReads <= 3, `twenty lines, one stick decision (read ${layoutReads} metrics)`);
    assert.equal(frames.length, 1, "one scroll is queued for the frame");
    runFrame();
    assert.equal(chatLog.scrollTop, chatLog.scrollHeightValue - chatLog.clientHeightValue,
      "a pane at the bottom follows the new lines");

    // Scrolled up: the next lines leave the view where the player put it.
    chatLog.scrollTop = 50;
    say(world, 500n, "ещё");
    chatLog.scrollHeightValue += 20;
    runFrame();
    assert.equal(chatLog.scrollTop, 50);
  } finally {
    dock.resetChatDock();
    game.world = undefined;
  }
});

test("while the stock chat owns the screen the pane is not drawn into, and nothing is laid out", () => {
  const world = crowdWorld();
  game.world = world;
  dock.resetChatDock();
  runFrame();
  body.classList.add("framexml-world-replaces-chat");
  try {
    layoutReads = 0;
    for (let index = 0; index < 10; index += 1) say(world, 600n + BigInt(index), `скрыто ${index}`);
    dock.recordCombatEntry({ at: 1, text: "удар", kind: "muted", casterGuid: 5n, targetGuid: 6n, spellId: 0 });
    world.names.set(600n, "Кто-то");
    dock.refreshChatNames();
    assert.equal(chatLog.children.length, 0, "no line is built for a hidden pane");
    assert.equal(layoutReads, 0, "no scroll metric is read");
    assert.equal(frames.length, 0);
    assert.equal(chatTabs.children.find((button) => button.dataset.chatTab === "combat")?.dataset.unread, "1",
      "the badges keep counting, for when the pane comes back");

    // The unmount hands the pane back and redraws it from the backlog (`cleanupPublishedMount`).
    body.classList.remove("framexml-world-replaces-chat");
    dock.redrawChatLog();
    assert.equal(chatLog.children.length, 10);
    assert.match(paneText(), /Кто-то/);
  } finally {
    body.classList.remove("framexml-world-replaces-chat");
    dock.resetChatDock();
    game.world = undefined;
  }
});
