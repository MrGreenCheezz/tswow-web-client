import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: Escape, through the real Controls keydown path, is stock ToggleGameMenu's chain once
// the stock GameMenuFrame owns the menu (UIParent.lua:2868-2903): one thing per press — a
// StaticPopup, the native CAMP countdown, the open menu, ChatMenu (CloseMenus), a cast, the
// reticle, every stock and native window, the target — and the menu only when nothing is left.
// Before, the native chain closed windows and target on one press and never reached CloseMenus.

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

// The fake DOM of framexml-gamemenu-controller.test.mjs: Controls, Windows and GameMenu are real.
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
  requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
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
const controls = await import("../dist/code/browser/input/Controls.js");
const { pendingGroundTarget } = await import("../dist/code/browser/game/GroundTarget.js");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const {
  createFrameXmlGameMenuOwner, frameXmlGameMenuGate, installFrameXmlGameMenuButtons,
} = await import("../dist/code/browser/framexml/FrameXmlGameMenuOwner.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

const decoder = new TextDecoder("utf-8");
async function load() {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "gamemenu-escape-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function treeRenderer() {
  const elements = new Map();
  const elementFor = (frame) => {
    if (!frame) return null;
    if (!elements.has(frame)) {
      const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
      elements.set(frame, { dataset: {}, get parentElement() { return elementFor(frame.parent); },
        getAttribute: (name) => attributes.get(name) ?? null });
    }
    return elements.get(frame);
  };
  return { elementFor };
}

const escape = () => window.fire("keydown", { code: "Escape", target: document.body, defaultPrevented: false,
  repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, preventDefault() {} });

function worldStub() {
  const calls = [];
  return {
    calls,
    state: { selfGuid: 1n, objects: new Map() }, targetGuid: undefined, chatLog: [], casts: new Map(),
    logout: undefined, loggedOut: false,
    selectTarget(guid) { this.targetGuid = guid; calls.push(["selectTarget", guid]); },
    cancelSpellCast() { calls.push(["cancelSpellCast"]); },
    cancelLogout() { calls.push(["cancelLogout"]); },
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, aurasFor: () => [],
    displayName: () => "",
  };
}

function fakeWindow() {
  return {
    open: false,
    isOpen() { return this.open; },
    show() { this.open = true; },
    hide() { this.open = false; },
  };
}

test("Escape follows stock ToggleGameMenu one press at a time, native windows in their stock place", withClient, async () => {
  const { boot, seam } = await load();
  const world = worldStub();
  game.world = world;
  let release;
  let releaseLfd;
  try {
    const actions = Object.fromEntries(["video", "sound", "interface", "keybindings", "macros", "diagnostics", "resetLayout"]
      .map((name) => [name, () => {}]));
    assert.equal(installFrameXmlGameMenuButtons(boot, { ...actions, toggle: menu.toggleGameMenu }), true);
    const gate = frameXmlGameMenuGate(boot, treeRenderer());
    assert.ok(gate, "the stock menu passes its gate");
    const owner = createFrameXmlGameMenuOwner(boot, gate.frame, () => false);
    release = controller.publishFrameXmlGameMenu(owner);
    const nativeWindow = fakeWindow();
    releaseLfd = lfdController.publishFrameXmlLfd(nativeWindow);
    const errors = boot.errorCount;
    const shown = (name) => lua(boot, `return ${name}:IsShown() and 1 or 0`)[0];

    escape();
    assert.equal(owner.isOpen(), true, "nothing to dismiss: the menu opens");
    assert.equal(seam.playedSoundNames.at(-1), "igMainMenuOpen");

    // A StaticPopup with hideOnEscape and ChatMenu, over the open menu.
    lua(boot, `StaticPopupDialogs.WEBCLIENT_ESCAPE_TEST = { text = "x", button1 = OKAY, timeout = 0, hideOnEscape = 1,
      OnCancel = function() __escapeCancelled = (__escapeCancelled or 0) + 1 end }
      StaticPopup_Show("WEBCLIENT_ESCAPE_TEST") ChatMenu:Show()`, 0);
    assert.equal(lua(boot, `return StaticPopup_Visible("WEBCLIENT_ESCAPE_TEST") and 1 or 0`)[0], 1);
    escape();
    assert.deepEqual(lua(boot, `return StaticPopup_Visible("WEBCLIENT_ESCAPE_TEST") and 1 or 0, __escapeCancelled`, 2), [0, 1],
      "StaticPopup_EscapePressed goes first and runs the dialog's OnCancel");
    assert.equal(owner.isOpen(), true, "the popup's press leaves the menu");
    assert.equal(shown("ChatMenu"), 1);

    escape();
    assert.equal(owner.isOpen(), false, "then the open menu");
    assert.equal(seam.playedSoundNames.at(-1), "igMainMenuQuit");
    assert.equal(shown("ChatMenu"), 1, "ChatMenu waits for its own press");

    escape();
    assert.equal(shown("ChatMenu"), 0, "CloseMenus: ChatMenu closes on Escape");
    assert.equal(owner.isOpen(), false);

    // A cast, the reticle, windows and a target all at once: one per press, in stock order.
    world.targetGuid = 0x42n;
    world.casts.set(1n, { spellId: 133, startedAt: performance.now(), duration: 3000, channel: false, castCount: 1 });
    game.groundTarget = 116;
    lua(boot, "ShowUIPanel(SpellBookFrame) ItemRefTooltip:Show()", 0);
    nativeWindow.show();
    world.calls.length = 0;

    escape();
    assert.deepEqual(world.calls, [["cancelSpellCast"]], "SpellStopCasting: the cast goes first");

    // The entry stays in `casts` until the server's SMSG_SPELL_FAILURE, a round trip away: the next
    // press must neither send the cancel again nor be spent on it.
    escape();
    assert.deepEqual(world.calls, [["cancelSpellCast"]], "one CMSG_CANCEL_CAST per cast");
    assert.equal(pendingGroundTarget(), undefined, "SpellStopTargeting: then the reticle");
    assert.equal(shown("SpellBookFrame"), 1);
    world.casts.delete(1n); // the server's SMSG_SPELL_FAILURE

    escape();
    assert.deepEqual([shown("SpellBookFrame"), shown("ItemRefTooltip"), nativeWindow.open], [0, 0, false],
      "CloseAllWindows (a panel, a UISpecialFrame) and the native windows on the same press");
    assert.equal(world.targetGuid, 0x42n, "the target waits for its own press");
    assert.equal(owner.isOpen(), false);

    escape();
    assert.equal(world.targetGuid, undefined, "ClearTarget");
    assert.equal(owner.isOpen(), false);

    escape();
    assert.equal(owner.isOpen(), true, "only now the menu");

    // The native CAMP countdown sits right after the stock popups, before the open menu.
    world.logout = { result: 0, instant: false };
    menu.updateLogoutPending(world, true);
    assert.equal(menu.logoutCountdownOpen(), true);
    world.calls.length = 0;
    escape();
    assert.deepEqual(world.calls, [["cancelLogout"]], "Escape cancels the countdown as CAMP's hideOnEscape does");
    assert.equal(owner.isOpen(), true, "and leaves the menu for the next press");
    world.logout = undefined;
    menu.updateLogoutPending(world, false);
    escape();
    assert.equal(owner.isOpen(), false);

    // The same chain answers an add-on's ToggleGameMenu and the C functions it asks.
    lua(boot, "ToggleGameMenu()", 0);
    assert.equal(owner.isOpen(), true, "Lua ToggleGameMenu is the Escape chain");
    lua(boot, "ToggleGameMenu()", 0);
    assert.equal(owner.isOpen(), false);
    world.casts.set(1n, { spellId: 133, startedAt: performance.now(), duration: 3000, channel: true });
    world.calls.length = 0;
    assert.deepEqual(lua(boot, "return SpellStopCasting(), ClearTarget()", 2), [1, undefined],
      "SpellStopCasting answers 1 for a live cast; ClearTarget nil with no target");
    assert.deepEqual(lua(boot, "return SpellStopCasting()"), [undefined], "/stopcasting again: already cancelled");
    assert.deepEqual(world.calls, [["cancelSpellCast"]]);
    world.casts.set(1n, { spellId: 133, startedAt: performance.now() - 60_000, duration: 3000, channel: false });
    assert.deepEqual(lua(boot, "return SpellStopCasting()"), [undefined], "a cast long past its end is not being cast");
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors).map((e) => e.message)));
  } finally {
    releaseLfd?.();
    release?.();
    game.world = undefined;
    game.groundTarget = undefined;
    menu.resetLogoutPending();
    boot.close();
  }
});

test("SpellIsTargeting is the reticle: the secure stop action and a unit frame's right click cancel it", withClient, async () => {
  const { boot } = await load();
  game.world = worldStub();
  try {
    const actions = Object.fromEntries(["video", "sound", "interface", "keybindings", "macros", "diagnostics", "resetLayout"]
      .map((name) => [name, () => {}]));
    assert.equal(installFrameXmlGameMenuButtons(boot, { ...actions, toggle: () => {} }), true);
    const errors = boot.errorCount;
    // What the click reached: TargetUnit's unit, and whether PlayerFrame's menu function (the
    // SecureUnitButton_OnLoad `menufunc` SECURE_ACTIONS.menu calls) ran.
    const clickPlayerFrame = (button) => lua(boot, `local target, menu, unit, opened = TargetUnit, PlayerFrame.menu, nil, 0
      TargetUnit = function(u) unit = u end
      PlayerFrame.menu = function() opened = 1 end
      SecureUnitButton_OnClick(PlayerFrame, ${JSON.stringify(button)})
      TargetUnit, PlayerFrame.menu = target, menu
      return unit, opened`, 2);
    assert.deepEqual(lua(boot, "return SpellIsTargeting()"), [undefined], "no reticle, not targeting");

    game.groundTarget = 116;
    assert.deepEqual(lua(boot, "return SpellIsTargeting()"), [1], "the armed reticle is targeting");
    lua(boot, `local button = CreateFrame("Button", "WebClientEscapeStopTest", UIParent, "SecureActionButtonTemplate")
      button:SetAttribute("type", "stop") SecureActionButton_OnClick(button, "LeftButton")`, 0);
    assert.equal(pendingGroundTarget(), undefined, "SECURE_ACTIONS.stop reaches SpellStopTargeting");

    game.groundTarget = 116;
    assert.deepEqual(clickPlayerFrame("RightButton"), [undefined, 0],
      "a unit frame's right click cancels the reticle instead of opening its menu");
    assert.equal(pendingGroundTarget(), undefined);

    // The target action's `SpellIsTargeting()` branch calls SpellTargetUnit, which nothing binds.
    game.groundTarget = 116;
    assert.deepEqual(clickPlayerFrame("LeftButton"), [undefined, 0], "armed, a left click targets nobody");
    assert.equal(pendingGroundTarget(), 116, "and keeps the reticle");
    game.groundTarget = undefined;
    assert.deepEqual(clickPlayerFrame("LeftButton"), ["player", 0], "disarmed, the same click targets the unit");
    assert.deepEqual(clickPlayerFrame("RightButton"), [undefined, 1], "and the right click opens its menu");
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(errors).map((e) => e.message)));
  } finally {
    game.world = undefined;
    game.groundTarget = undefined;
    boot.close();
  }
});

test("unpublished, Escape stays the native chain and an add-on's ToggleGameMenu reaches the native menu", withClient, async () => {
  const { boot } = await load();
  game.world = worldStub();
  try {
    const toggles = [];
    const actions = Object.fromEntries(["video", "sound", "interface", "keybindings", "macros", "diagnostics", "resetLayout"]
      .map((name) => [name, () => {}]));
    installFrameXmlGameMenuButtons(boot, { ...actions, toggle: () => toggles.push("toggle") });
    assert.equal(controller.escapeFrameXmlGameMenu(), false, "no owner, no stock chain");
    lua(boot, "ChatMenu:Show() ToggleGameMenu()", 0);
    assert.deepEqual(toggles, [], "an open ChatMenu takes the add-on's press first");
    lua(boot, "ToggleGameMenu()", 0);
    assert.deepEqual(toggles, ["toggle"], "then the host toggle, which is the native Panel while unpublished");
    assert.equal(boot.bridge.getFrame("GameMenuFrame").visible, false);
  } finally {
    game.world = undefined;
    boot.close();
  }
});
