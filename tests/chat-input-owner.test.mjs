import assert from "node:assert/strict";
import test from "node:test";

// The chat keys and their owner: Enter, `/`, reply and a shift-clicked link reach whichever input
// `ChatInputOwner` has, Escape inside a FrameXML edit box is that box's own, and the native command
// tables can be run and listed from outside `submitChat`. A small fake DOM, as in
// native-ui-regressions: `Controls` and `Actions` are the real modules.

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
    this.selectionStart = 0;
    this.selectionEnd = 0;
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
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === 'button[type="submit"]' ? new FakeNode("button") : null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  getContext() { return {}; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
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
globalThis.HTMLElement = FakeNode;

const elements = new Map();
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
  addEventListener(name, handler) {
    const handlers = windowListeners.get(name) ?? [];
    handlers.push(handler);
    windowListeners.set(name, handlers);
  },
  removeEventListener() {},
  fire(name, event) { for (const handler of windowListeners.get(name) ?? []) handler(event); },
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { CHAT_MSG_WHISPER, CHAT_MSG_SAY } = await import("../dist/code/world/ChatProtocol.js");
const owner = await import("../dist/code/browser/ui/ChatInputOwner.js");
const chat = await import("../dist/code/browser/ui/Chat.js");
const dock = await import("../dist/code/browser/ui/ChatDock.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const { runAction } = await import("../dist/code/browser/input/Actions.js");
const { actionFor } = await import("../dist/code/browser/input/Bindings.js");
const controls = await import("../dist/code/browser/input/Controls.js");
controls.wireControls();

function worldStub(extra = {}) {
  const calls = [];
  return {
    calls,
    state: { selfGuid: 1n, objects: new Map() },
    targetGuid: 0x42n,
    chatLog: [],
    emotes: { emotes: [{ id: 34, command: "dance", emoteId: 10, text: {} }] },
    displayName: (guid) => (guid === 0x42n ? "Цель" : "Кто-то"),
    selectTarget(guid) { calls.push(["selectTarget", guid]); this.targetGuid = guid; },
    requestWhois(name) { calls.push(["requestWhois", name]); },
    sendChat(...args) { calls.push(["sendChat", ...args]); },
    sendTextEmote(...args) { calls.push(["sendTextEmote", ...args]); },
    setStandState(...args) { calls.push(["setStandState", ...args]); },
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {},
    aurasFor: () => [],
    ...extra,
  };
}

function recorder() {
  const calls = [];
  return {
    calls,
    openChat(text) { calls.push(["openChat", text]); },
    insertLink(text) { calls.push(["insertLink", text]); },
    reply() { calls.push(["reply"]); },
  };
}

test("the chat keys: Enter, `/` and R are bound as the 3.3.5 client binds them", () => {
  assert.equal(actionFor("Enter"), "openChat");
  assert.equal(actionFor("Slash"), "openChatSlash", "OPENCHATSLASH");
  assert.equal(actionFor("KeyR"), "replyWhisper", "REPLY");
  assert.equal(actionFor("NumpadDivide"), "toggleWalkRun", "TOGGLERUN moved to the keypad /");
});

test("without a replacement the native input answers every chat key", () => {
  game.world = worldStub();
  try {
    dom.chatInput.value = "draft";
    document.activeElement = null;
    assert.equal(runAction("openChat"), true);
    assert.equal(document.activeElement, dom.chatInput);
    assert.equal(dom.chatInput.value, "draft", "Enter keeps an unsent draft");
    assert.equal(runAction("openChatSlash"), true);
    assert.equal(dom.chatInput.value, "/", "the slash key opens with the slash typed");
    assert.equal(dom.chatInput.selectionStart, 1);

    game.world.chatLog.push({ type: CHAT_MSG_SAY, senderGuid: 5n, senderName: "Болтун", text: "hi" });
    document.activeElement = null;
    assert.equal(runAction("replyWhisper"), true);
    assert.equal(document.activeElement, null, "nobody whispered, so reply opens nothing");
    game.world.chatLog.push({ type: CHAT_MSG_WHISPER, senderGuid: 7n, senderName: "Шептун", text: "psst" });
    runAction("replyWhisper");
    assert.equal(dom.chatInput.value, "/w Шептун ");
    assert.equal(document.activeElement, dom.chatInput);

    dom.chatInput.value = "ab";
    dom.chatInput.selectionStart = 1; dom.chatInput.selectionEnd = 1;
    dock.insertIntoChat("[link]");
    assert.equal(dom.chatInput.value, "a[link]b", "a link lands at the caret");
  } finally {
    game.world = undefined;
    dom.chatInput.value = "";
  }
});

test("an installed owner takes the chat keys and a stale cleanup cannot remove a newer one", () => {
  game.world = worldStub();
  const first = recorder();
  const second = recorder();
  const releaseFirst = owner.installChatInputOwner(first);
  const releaseSecond = owner.installChatInputOwner(second);
  try {
    releaseFirst();
    assert.equal(owner.chatInputReplaced(), true, "the first mount's cleanup leaves the second owner");
    document.activeElement = null;
    runAction("openChat");
    runAction("openChatSlash");
    runAction("replyWhisper");
    dock.insertIntoChat("|Hitem:1|h[x]|h");
    assert.deepEqual(second.calls, [
      ["openChat", undefined], ["openChat", "/"], ["reply"], ["insertLink", "|Hitem:1|h[x]|h"],
    ]);
    assert.deepEqual(first.calls, []);
    assert.equal(document.activeElement, null, "the native input is not touched");
  } finally {
    releaseSecond();
    game.world = undefined;
  }
  assert.equal(owner.chatInputReplaced(), false);
});

test("a failing owner is removed, reported, and the same key reaches the native input", () => {
  game.world = worldStub();
  let failures = 0;
  const release = owner.installChatInputOwner({
    openChat() { throw new Error("VM closed"); },
    insertLink() { throw new Error("VM closed"); },
    reply() {},
  }, () => { failures += 1; });
  const warn = console.warn;
  console.warn = () => {};
  try {
    document.activeElement = null;
    assert.equal(runAction("openChat"), true);
    assert.equal(failures, 1);
    assert.equal(owner.chatInputReplaced(), false);
    assert.equal(document.activeElement, dom.chatInput, "Enter is never left without a target");
  } finally {
    console.warn = warn;
    release();
    game.world = undefined;
  }
});

test("Escape inside a FrameXML edit box is that box's own; elsewhere the native chain still runs", () => {
  game.world = worldStub();
  try {
    const fieldOf = (framexml) => {
      const field = new FakeInput();
      if (framexml) field.setAttribute("data-framexml-input", "true");
      return field;
    };
    const escape = (target) => {
      let prevented = false;
      window.fire("keydown", { code: "Escape", target, defaultPrevented: false, repeat: false,
        preventDefault() { prevented = true; } });
      return prevented;
    };

    // The stock script kept focus (a box without ClearFocus in its OnEscapePressed): it loses the
    // focus, and the target and windows survive.
    const stock = fieldOf(true);
    stock.focus();
    dom.auctionWindow.hidden = false;
    assert.equal(escape(stock), true);
    assert.equal(document.activeElement, null, "the FrameXML input is blurred");
    assert.equal(game.world.targetGuid, 0x42n, "the target is not dropped");
    assert.equal(dom.auctionWindow.hidden, false, "no window is closed");

    // An ordinary native field still backs out, as before.
    const plain = fieldOf(false);
    plain.focus();
    escape(plain);
    assert.equal(dom.auctionWindow.hidden, true, "the native Escape chain closed the window");
    assert.equal(game.world.targetGuid, undefined);
  } finally {
    dom.auctionWindow.hidden = true;
    game.world = undefined;
  }
});

test("outside the world a FrameXML edit box keeps its caret on Escape (the GlueXML login boxes)", () => {
  game.world = undefined;
  const field = new FakeInput();
  field.setAttribute("data-framexml-input", "true");
  field.focus();
  window.fire("keydown", { code: "Escape", target: field, defaultPrevented: false, repeat: false, preventDefault() {} });
  assert.equal(document.activeElement, field, "AccountLoginAccountEdit is not blurred");
  field.blur();
});

test("the native command tables run and list outside submitChat, and say when modules change", () => {
  const world = worldStub();
  game.world = world;
  try {
    assert.equal(chat.runNativeCommand("WHOIS", "  Foo "), true);
    assert.equal(chat.runNativeCommand("dance", ""), true, "an EmotesText emote");
    assert.equal(chat.runNativeCommand("say", "hello"), true);
    assert.equal(chat.runNativeCommand("nosuchcommand", ""), false);
    assert.deepEqual(world.calls, [
      ["requestWhois", "Foo"], ["sendTextEmote", 34, 0x42n], ["sendChat", CHAT_MSG_SAY, "hello", ""],
    ]);

    const listed = chat.nativeSlashCommands();
    const whois = listed.find((command) => command.name === "whois");
    assert.deepEqual(whois?.aliases, ["whois"]);
    assert.equal(whois?.usage, "/whois Имя");
    const vehicle = listed.find((command) => command.name === "vehicle");
    assert.deepEqual(vehicle?.aliases, ["vehicle", "veh"]);
    const say = listed.find((command) => command.aliases.includes("say"));
    assert.deepEqual(say?.aliases, ["s", "say"], "chat-type shortcuts are grouped by the type they send");

    let changes = 0;
    const off = chat.onNativeSlashCommandsChanged(() => { changes += 1; });
    assert.equal(chat.addModuleCommand({ module: "m", name: "Probe", help: "проба", run() { world.calls.push(["probe"]); } }), undefined);
    assert.equal(changes, 1);
    assert.equal(chat.addModuleCommand({ module: "m", name: "whois", help: "x", run() {} }), "/whois — уже команда клиента");
    assert.equal(changes, 1, "a refused command changes nothing");
    const probe = chat.nativeSlashCommands().find((command) => command.name === "probe");
    assert.deepEqual(probe, { name: "probe", aliases: ["probe"], usage: "/probe", help: "проба (модуль «m»)" });
    assert.equal(chat.runNativeCommand("probe", ""), true);
    assert.equal(chat.removeModuleCommands("m"), 1);
    assert.equal(changes, 2);
    assert.equal(chat.removeModuleCommands("m"), 0);
    assert.equal(changes, 2, "removing nothing is not a change");
    off();
    chat.addModuleCommand({ module: "m", name: "later", help: "", run() {} });
    assert.equal(changes, 2, "an unsubscribed listener hears nothing");
    chat.removeModuleCommands("m");
  } finally {
    game.world = undefined;
  }
});
