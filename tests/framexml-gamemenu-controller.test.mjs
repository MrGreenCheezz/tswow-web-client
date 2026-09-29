import assert from "node:assert/strict";
import test from "node:test";

// The stock-menu owner and the routes that reach it without being rewritten: GameMenu.ts's
// toggle/open/close (Escape, the gear button, the micro button, a world reset) and the host
// C APIs Quit/CancelLogout. A small fake DOM, as in chat-input-owner: Controls, Windows and
// GameMenu are the real modules.

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
const controller = await import("../dist/code/browser/framexml/FrameXmlGameMenuController.js");
const lfdController = await import("../dist/code/browser/framexml/FrameXmlLfdController.js");
const menu = await import("../dist/code/browser/ui/GameMenu.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const controls = await import("../dist/code/browser/input/Controls.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

function owner() {
  return {
    open: false, shows: 0, hides: 0,
    isOpen() { return this.open; },
    show() { this.open = true; this.shows += 1; },
    hide() { this.open = false; this.hides += 1; },
  };
}

const nativeMenu = () => document.body.children.find((element) => element.id === "game-menu");
const escape = () => window.fire("keydown", { code: "Escape", target: document.body, defaultPrevented: false,
  repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {} });

function worldStub() {
  return {
    state: { selfGuid: 1n, objects: new Map() }, targetGuid: undefined, chatLog: [],
    selectTarget(guid) { this.targetGuid = guid; },
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, aurasFor: () => [],
    displayName: () => "",
  };
}

test("the controller answers false until published and keeps one owner", () => {
  assert.equal(controller.toggleFrameXmlGameMenu(), false);
  assert.equal(controller.closeFrameXmlGameMenu(), false);
  assert.equal(controller.frameXmlGameMenuOpen(), false);
  const first = owner();
  const second = owner();
  const releaseFirst = controller.publishFrameXmlGameMenu(first);
  first.show();
  const releaseSecond = controller.publishFrameXmlGameMenu(second);
  assert.equal(first.open, false, "a new owner closes the stale one");
  assert.equal(controller.toggleFrameXmlGameMenu(), true);
  assert.equal(second.open, true);
  releaseFirst();
  assert.equal(controller.frameXmlGameMenuPublished(), true, "a stale cleanup cannot unpublish the current owner");
  releaseSecond();
  assert.equal(second.open, false, "cleanup hides the menu it unpublishes");
  assert.equal(controller.frameXmlGameMenuPublished(), false);
});

test("GameMenu.ts reaches the stock menu first and builds the native Panel only as the fallback", () => {
  const stock = owner();
  const release = controller.publishFrameXmlGameMenu(stock);
  try {
    menu.toggleGameMenu();
    assert.equal(stock.open, true, "the gear button / micro button / Escape open the stock menu");
    assert.equal(menu.gameMenuOpen(), true);
    assert.equal(nativeMenu(), undefined, "the native Panel is never built while stock owns the menu");
    assert.equal(dom.gameMenuToggle.getAttribute("aria-expanded"), "true");
    menu.toggleGameMenu();
    assert.equal(stock.open, false);
    menu.toggleGameMenu();
    menu.closeGameMenu();
    assert.equal(stock.open, false, "a world reset closes the stock menu");
  } finally {
    release();
  }
  menu.toggleGameMenu();
  assert.equal(nativeMenu()?.hidden, false, "unpublished: the native menu opens as before");
  assert.equal(menu.gameMenuOpen(), true);
  menu.closeGameMenu();
  assert.equal(nativeMenu().hidden, true);
});

test("Escape closes open windows first and opens the stock menu only when nothing else is open", () => {
  game.world = worldStub();
  const stock = owner();
  const release = controller.publishFrameXmlGameMenu(stock);
  const lfd = owner();
  const releaseLfd = lfdController.publishFrameXmlLfd(lfd);
  try {
    escape();
    assert.equal(stock.open, true, "nothing open: Escape opens the menu");
    escape();
    assert.equal(stock.open, false, "a second Escape closes it");
    lfd.show();
    escape();
    assert.equal(lfd.open, false, "the stock dungeon finder is an Escape-closable window");
    assert.equal(stock.open, false, "closing a window does not open the menu on the same press");
    game.world.targetGuid = 0x42n;
    escape();
    assert.equal(game.world.targetGuid, undefined, "the target goes before the menu");
    assert.equal(stock.open, false);
    escape();
    assert.equal(stock.open, true);
  } finally {
    releaseLfd();
    release();
    game.world = undefined;
  }
});

test("a published escape chain takes every Escape press; wireControls registered the native steps it asks", async () => {
  const world = worldStub();
  const sent = [];
  world.casts = new Map();
  world.cancelSpellCast = () => sent.push("cancelSpellCast");
  world.targetGuid = 0x42n;
  game.world = world;
  const stock = { ...owner(), escapes: 0, escape() { this.escapes += 1; } };
  const release = controller.publishFrameXmlGameMenu(stock);
  const lfd = owner();
  const releaseLfd = lfdController.publishFrameXmlLfd(lfd);
  try {
    lfd.show();
    escape();
    assert.equal(stock.escapes, 1, "the stock chain (FrameXmlGameMenuOwner) answers the press");
    assert.equal(lfd.open, true, "and the native chain does not run beside it");
    assert.equal(world.targetGuid, 0x42n);

    const run = controller.runFrameXmlNativeEscape;
    assert.equal(run("popups"), false, "no CAMP countdown up");
    assert.equal(run("windows"), true, "an open escapable window is closed and reported");
    assert.equal(lfd.open, false);
    assert.equal(run("windows"), false);
    assert.equal(run("clearTarget"), true);
    assert.equal(world.targetGuid, undefined);
    assert.equal(run("clearTarget"), false);
    // A native repaint that throws after the target is gone still spends the press: otherwise
    // stock's `ClearTarget() and …` branch fails and the same Escape opens the menu (seen on the
    // RICH route with a partial fake world).
    world.targetGuid = 0x43n;
    (await import("../dist/code/browser/ui/Frames.js")).showTarget();
    const aurasFor = world.aurasFor;
    const consoleError = console.error;
    const logged = [];
    world.aurasFor = () => { throw new Error("repaint failed"); };
    console.error = (...args) => logged.push(args.map(String).join(" "));
    try {
      assert.equal(run("clearTarget"), true);
    } finally {
      console.error = consoleError;
      world.aurasFor = aurasFor;
    }
    assert.equal(world.targetGuid, undefined);
    assert.equal(logged.length, 1, "the repaint failure is logged, not swallowed");
    game.groundTarget = 116;
    assert.equal(controller.frameXmlNativeTargeting(), true, "SpellIsTargeting: the armed reticle");
    assert.equal(game.groundTarget, 116, "asked, not dismissed");
    assert.equal(run("stopTargeting"), true);
    assert.equal(game.groundTarget, undefined);
    assert.equal(controller.frameXmlNativeTargeting(), false);
    assert.equal(run("stopTargeting"), false);
    world.casts.set(1n, { spellId: 133, startedAt: performance.now(), duration: 2500, channel: false, castCount: 3 });
    assert.equal(run("stopCasting"), true);
    assert.deepEqual(sent, ["cancelSpellCast"]);
    assert.equal(run("stopCasting"), false, "the same cast, before the server's SMSG_SPELL_FAILURE: already cancelled");
    assert.deepEqual(sent, ["cancelSpellCast"]);
    world.casts.set(1n, { spellId: 133, startedAt: performance.now(), duration: 2500, channel: false, castCount: 4 });
    assert.equal(run("stopCasting"), true, "the next cast is its own entry");
    assert.deepEqual(sent, ["cancelSpellCast", "cancelSpellCast"]);
    world.casts.set(1n, { spellId: 133, startedAt: performance.now() - 10_000, duration: 2500, channel: false });
    assert.equal(run("stopCasting"), false, "a cast whose end is long past was missed, not cancelled");
    assert.deepEqual(sent, ["cancelSpellCast", "cancelSpellCast"]);
    assert.equal(run("nope"), false);
  } finally {
    releaseLfd();
    release();
  }
  assert.equal(controller.escapeFrameXmlGameMenu(), false, "unpublished: the caller keeps its native chain");
  try {
    escape();
    assert.equal(nativeMenu()?.hidden, false, "and Escape opens the native menu again");
  } finally {
    menu.closeGameMenu();
    game.world = undefined;
  }
});

test("Quit logs out and, once the server completes it, leaves to the login screen; a cancel drops the intent", () => {
  const calls = [];
  const world = {
    logout: undefined, loggedOut: false,
    requestLogout() { calls.push("request"); },
    cancelLogout() { calls.push("cancel"); },
  };
  game.world = world;
  try {
    let left = 0;
    menu.requestQuitToLogin(() => { left += 1; });
    assert.deepEqual(calls, ["request"]);
    world.logout = { result: 0, instant: false };
    menu.updateLogoutPending(world, true);
    assert.equal(menu.logoutPending(), true);
    menu.requestQuitToLogin(() => { left += 10; });
    assert.deepEqual(calls, ["request"], "a pending logout is not requested twice");
    world.loggedOut = true;
    menu.updateLogoutPending(world, false); // SMSG_LOGOUT_COMPLETE, before EnterWorld's own leaveWorld("logout")
    assert.equal(left, 10, "the completion leaves once, through the latest Quit");
    menu.updateLogoutPending(world, false);
    assert.equal(left, 10, "and only once");

    world.loggedOut = false;
    world.logout = undefined;
    menu.requestQuitToLogin(() => { left += 100; });
    world.logout = { result: 0, instant: false };
    menu.updateLogoutPending(world, true);
    menu.cancelLogoutRequest();
    assert.deepEqual(calls, ["request", "request", "cancel"], "CancelLogout sends the countdown's cancel");
    world.logout = undefined;
    menu.updateLogoutPending(world, false); // SMSG_LOGOUT_CANCEL_ACK
    world.loggedOut = true;
    menu.updateLogoutPending(world, false);
    assert.equal(left, 10, "a cancelled Quit never leaves to the login screen");
  } finally {
    menu.resetLogoutPending();
    game.world = undefined;
  }
});

test("the mount binds Quit/CancelLogout once and keeps Logout on the chat API", async () => {
  const { readFile } = await import("node:fs/promises");
  const mount = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  const chat = await readFile(new URL("../src/browser/framexml/FrameXmlChatApi.ts", import.meta.url), "utf8");
  assert.match(chat, /\n\s*Logout: withWorld\(\(world\) => world\.requestLogout\(\)\),/, "Logout stays FrameXmlChatApi's binding");
  assert.doesNotMatch(mount, /registerGlobal\("Logout"/, "the mount never binds Logout a second time");
  assert.equal(mount.match(/registerGlobal\("CancelLogout"/g)?.length, 1);
  assert.equal(mount.match(/registerGlobal\("Quit"/g)?.length, 1);
  assert.match(mount, /requestQuitToLogin\(\(\) => \{ leaveWorldForQuit\?\.\("relogin"\); \}\)/);
  const adapters = mount.slice(mount.indexOf("installFrameXmlMicroButtonAdapters(loadedBoot, {"));
  const actionMap = adapters.slice(0, adapters.indexOf("}) !== undefined;"));
  assert.match(actionMap, /\n\s*gameMenu: toggleGameMenu,\n/, "MainMenuMicroButton goes through GameMenu.ts's stock-first toggle");
  assert.match(actionMap, /\n\s*lfd: toggleLfgWindow,\n/, "LFDMicroButton goes through Social.ts's stock-first toggle");
});
