import assert from "node:assert/strict";
import test from "node:test";

// The stock FriendsFrame's owner and the native routes that reach it: SocialPanel.ts (the Socials
// micro button, the HUD's social button, /friends, /ignore, /who, the stock entry points' routes),
// Guild.ts (/gw, the native menu entry, the guild packets' repaint) and Escape. A small fake DOM,
// real modules.

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
  insertBefore(child) { this.append(child); }
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
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {},
  removeEventListener() {},
  prompt() { return null; },
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlFriendsController.js");
const social = await import("../dist/code/browser/ui/SocialPanel.js");
const guild = await import("../dist/code/browser/ui/Guild.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const windows = await import("../dist/code/browser/ui/Windows.js");
const roster = await import("../dist/code/browser/ui/ChannelRoster.js");
usePanelHost({ viewport: document.body, attach() {} });

/** A recording stock owner with ToggleFriendsFrame's semantics over a tab name. */
function owner() {
  return {
    open: false, tab: "friends", calls: [],
    isOpen() { return this.open; },
    isTabOpen(tab) { return this.open && this.tab === tab; },
    show(tab) { this.calls.push(["show", tab]); this.open = true; if (tab) this.tab = tab; },
    toggle(tab) {
      this.calls.push(["toggle", tab]);
      if (tab === undefined) { this.open = !this.open; return; }
      if (this.open && this.tab === tab) { this.open = false; return; }
      this.open = true;
      this.tab = tab;
    },
    hide() { this.open = false; },
  };
}

function socialWorld() {
  const calls = [];
  return {
    calls,
    state: { selfGuid: 1n, objects: new Map() },
    contacts: undefined,
    whoResult: undefined,
    guildRoster: { welcomeText: "", infoText: "", ranks: [], members: [] },
    guildQuery: undefined,
    guildInvite: undefined,
    guildMessage: undefined,
    displayName: () => "Бета",
    requestName() {},
    requestContacts() { calls.push("contacts"); },
    requestGuildRoster() { calls.push("roster"); },
    requestGuildInfo() { calls.push("guildInfo"); },
    requestWho(request) { calls.push(["who", request]); },
    requestChannelList(name) { calls.push(["channelList", name]); },
    pushLocalMessage(message) { calls.push(["line", message.text]); },
    closeGossip() {}, closeQuest() {}, closeLoot() {}, closeVendor() {}, closeAuctionHouse() {}, cancelTrade() {},
    closeTrainer() {}, closeBank() {},
  };
}

test("the controller answers false until published, keeps one owner and hands the tab through", () => {
  assert.equal(controller.toggleFrameXmlFriends(), false);
  assert.equal(controller.openFrameXmlFriends("who"), false);
  assert.equal(controller.closeFrameXmlFriends(), false);
  assert.equal(controller.frameXmlFriendsPublished(), false);
  assert.equal(controller.frameXmlFriendsTabOpen("who"), false);
  const first = owner();
  const second = owner();
  const releaseFirst = controller.publishFrameXmlFriends(first);
  first.show("guild");
  const releaseSecond = controller.publishFrameXmlFriends(second);
  assert.equal(first.open, false, "publishing a new owner hides the stale one");
  assert.equal(controller.openFrameXmlFriends("who"), true);
  assert.equal(controller.frameXmlFriendsTabOpen("who"), true);
  assert.equal(controller.toggleFrameXmlFriends("who"), true);
  assert.equal(controller.frameXmlFriendsOpen(), false, "the open tab toggles closed");
  releaseFirst();
  assert.equal(controller.frameXmlFriendsPublished(), true, "a stale cleanup cannot unpublish the current owner");
  second.show();
  releaseSecond();
  assert.equal(second.open, false);
  assert.equal(controller.frameXmlFriendsPublished(), false);
  // A throwing owner stays authoritative: the caller must not open a native window beside it.
  const release = controller.publishFrameXmlFriends({ ...owner(), toggle() { throw new Error("vm gone"); } });
  assert.equal(controller.toggleFrameXmlFriends(), true);
  release();
});

test("every native social entry point reaches the stock FriendsFrame first, and the native panel is the fallback", () => {
  const world = socialWorld();
  game.world = world;
  const stock = owner();
  const release = controller.publishFrameXmlFriends(stock);
  try {
    // The Socials micro button, the HUD's #social-toggle and the native menu entry.
    social.toggleSocialPanel();
    assert.deepEqual(stock.calls.at(-1), ["toggle", undefined]);
    assert.equal(stock.open, true);
    assert.equal(social.socialPanelOpen(), false, "the native panel stays closed");
    assert.deepEqual(world.calls, [], "the stock frame asks for contacts itself (ShowFriends)");
    // /friends, /ignore and /who (Chat.ts) open a tab.
    social.openSocialPanel("ignore");
    social.openSocialPanel("who");
    assert.deepEqual(stock.calls.slice(-2), [["show", "ignore"], ["show", "who"]]);
    // /gw and the native menu's «Гильдия».
    guild.openGuildWindow();
    assert.deepEqual(stock.calls.at(-1), ["show", "guild"]);
    assert.deepEqual(world.calls, [], "the stock Guild tab asks for its roster itself");
    // The stock entry points' routes (ToggleFriendsFrame, ToggleFriendsPanel, ShowWhoPanel, /groster).
    social.toggleSocialTab("raid");
    social.openSocialTab("guild");
    assert.deepEqual(stock.calls.slice(-2), [["toggle", "raid"], ["show", "guild"]]);
    // A guild packet reaches Guild.ts's single slot (onGuildChanged = showGuild) while stock owns it.
    world.guildMessage = { text: "Игрок Боб не найден.", error: true };
    guild.showGuild();
    assert.equal(dom.guildWindow.hidden, true, "no native guild window opens beside the stock one");
    assert.equal(world.guildMessage, undefined);
    assert.deepEqual(world.calls, [["line", "Игрок Боб не найден."]], "a refused command is said in chat");
    // Escape's window registry closes the stock frame.
    windows.closeGameWindows();
    assert.equal(stock.open, false);
  } finally {
    release();
  }
  try {
    world.calls.length = 0;
    social.toggleSocialPanel();
    assert.equal(social.socialPanelOpen(), true, "unpublished: the native panel is the social window");
    assert.deepEqual(world.calls, ["contacts"]);
    social.closeSocialPanel();
    world.calls.length = 0;
    social.openSocialTab("guild");
    assert.deepEqual(world.calls, ["roster", "guildInfo"], "unpublished: the Guild route is the native guild window");
    assert.equal(dom.guildWindow.hidden, false);
    guild.closeGuildWindow();
    world.calls.length = 0;
    social.toggleSocialTab("raid");
    assert.deepEqual(world.calls, [], "the Raid tab has no native window");
    social.toggleSocialTab("who");
    assert.equal(social.socialPanelOpen(), true);
    social.toggleSocialTab("who");
    assert.equal(social.socialPanelOpen(), false, "the native Who tab toggles like the stock one");
  } finally {
    social.resetSocialPanel();
    game.world = undefined;
  }
});

test("/roster and the native channel roster reach the stock Chat tab first, on the typed channel's row", () => {
  const world = { ...socialWorld(), channels: new Map([["стражи", { flags: 1, count: 0, members: [] }]]) };
  game.world = world;
  const stock = owner();
  stock.selectChannel = function (name) { this.calls.push(["select", name]); return true; };
  const release = controller.publishFrameXmlFriends(stock);
  try {
    // Chat.ts's `/roster стражи` and the native channel menu's roster entry.
    roster.toggleChannelRoster("стражи");
    assert.deepEqual(stock.calls, [["show", "channel"], ["select", "стражи"]]);
    assert.equal(roster.channelRosterOpen(), false, "the native #channel-roster window stays closed");
    assert.deepEqual(world.calls, [], "the stock row selection asks for the roster itself (SetSelectedDisplayChannel)");
    // A bare `/roster` on the open Chat tab closes it, as the native window's toggle did.
    roster.toggleChannelRoster();
    assert.deepEqual(stock.calls.at(-1), ["toggle", "channel"]);
    assert.equal(stock.open, false);
    // Closed, a bare `/roster` opens the tab; with no active channel tab there is no row to pick.
    roster.toggleChannelRoster("  ");
    assert.deepEqual(stock.calls.at(-1), ["show", "channel"]);
    roster.openChannelRoster("стражи");
    assert.deepEqual(stock.calls.slice(-2), [["show", "channel"], ["select", "стражи"]]);
    assert.equal(roster.channelRosterOpen(), false);
  } finally {
    release();
  }
  try {
    world.calls.length = 0;
    roster.toggleChannelRoster("стражи");
    assert.equal(roster.channelRosterOpen(), true, "unpublished: the native roster window is the roster");
    assert.deepEqual(world.calls, [["channelList", "стражи"]]);
  } finally {
    roster.resetChannelRoster();
    game.world = undefined;
  }
});
