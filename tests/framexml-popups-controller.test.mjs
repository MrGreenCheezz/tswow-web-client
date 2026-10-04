import assert from "node:assert/strict";
import test from "node:test";

// The stock popup owner and the native panels that asked the same questions: Social.ts (group
// invite, duel, trade request), Guild.ts, Npc.ts (death), ArenaWindow.ts, InteractionPrompts.ts
// (summon, battleground entry), ReadyCheck.ts and GameMenu.ts (logout countdown). A small fake DOM,
// real modules: while the owner is published each native panel steps aside at its own show
// function, publication and teardown repaint them, and Escape reaches stock.

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = true;
    this.disabled = false;
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
  click() { for (const handler of this.listeners.get("click") ?? []) handler({ target: this, stopPropagation() {} }); }
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
const confirmed = [];
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {},
  setTimeout() { return 0; },
  // The native «Разрушить» confirmation: recorded, and answered yes.
  confirm(message) { confirmed.push(message); return true; },
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlPopupsController.js");
const { refreshFrameXmlPopupsNative } = await import("../dist/code/browser/framexml/FrameXmlPopupsNative.js");
const { markFrameXmlPopupAnswered } = await import("../dist/code/browser/framexml/FrameXmlPopupsAnswered.js");
const social = await import("../dist/code/browser/ui/Social.js");
const guild = await import("../dist/code/browser/ui/Guild.js");
const npc = await import("../dist/code/browser/ui/Npc.js");
const prompts = await import("../dist/code/browser/ui/InteractionPrompts.js");
const readyCheck = await import("../dist/code/browser/ui/ReadyCheck.js");
const gameMenu = await import("../dist/code/browser/ui/GameMenu.js");
const windows = await import("../dist/code/browser/ui/Windows.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const arena = await import("../dist/code/browser/ui/ArenaWindow.js");
const itemSlots = await import("../dist/code/browser/ui/ItemSlots.js");
usePanelHost({ viewport: document.body, attach() {} });

const allText = (node) => [node.textContent ?? "", ...(node.children ?? []).map(allText)].join(" ");
const panel = (id) => document.body.children.find((element) => element.id === id);
const arenaInvite = () => panel("arena-window").children[1].children.find((node) => node.className === "arena-invite");

function owner(battlefieldEntry = true) {
  return {
    open: true, closes: 0, destroyed: [], battlefieldEntry: () => battlefieldEntry,
    isOpen() { return this.open; }, close() { this.closes += 1; this.open = false; },
    destroyItem(bag, slot) { this.destroyed.push([bag, slot]); return true; },
  };
}

/** A world with every confirmation pending at once, the player a fresh corpse. */
function pendingWorld() {
  const calls = [];
  const self = {
    guid: 1n, typeId: 4, position: { x: 0, y: 0, z: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0]]),
  };
  const queue = (queueSlot, status) => ({
    queueSlot, status, isArena: false, arenaType: 0, bgTypeId: 1, rated: false, cleared: false,
    timeInQueue: 0, averageWaitTime: 0, elapsedTime: 0,
  });
  return {
    calls,
    state: { selfGuid: 1n, objects: new Map([[1n, self]]) },
    mapId: 0,
    groupInvite: { inviterName: "Джайна", canAccept: true, proposedRoles: 0 },
    duelRequest: { challengerGuid: 5n, flagGuid: 6n },
    guildInvite: { inviterName: "Утер", guildName: "Длань" },
    resurrectRequest: { casterGuid: 7n, casterName: "Утер", sickness: false, useTimer: true },
    tradePending: true, tradeOpen: false, tradeBeginRequested: false, tradePartnerGuid: 5n,
    summonRequest: { summoner: 5n, zoneId: 1519, timeoutMilliseconds: 120_000 },
    summonExpiresAt: Number.POSITIVE_INFINITY,
    battlefieldQueues: new Map([[0, queue(0, 2)], [1, queue(1, 1)]]),
    battlefieldInviteDeadlines: new Map([[0, Number.POSITIVE_INFINITY]]),
    readyCheck: { initiatorGuid: 5n, startedAt: performance.now(), answers: new Map() },
    group: { leaderGuid: 5n, ownFlags: 0, ownSubGroup: 0, ownRoles: 0, members: [] },
    logout: { result: 0, instant: false }, loggedOut: false,
    arenaTeamInvite: { playerName: "Тралл", teamName: "Орда навсегда" },
    arenaTeams: new Map(), arenaTeamStats: new Map(), arenaTeamRosters: new Map(),
    requestArenaTeamRoster() {},
    answerArenaTeamInvite(accept) { calls.push(`arena:${accept}`); },
    vendor: undefined, auctioneerGuid: 0n, bankerGuid: undefined,
    itemTemplate() { return undefined; },
    destroyItem(bag, slot) { calls.push(`destroy:${bag}:${slot}`); },
    lfgRolesChosen: new Map(),
    raidTargets: new Map(),
    partyStats: new Map(),
    corpseReclaimDelay: 0,
    corpseReclaimRemaining() { return 0; },
    duelCountdown: 0,
    duelBoundsMessage: "Вы вышли за границы дуэли — вернитесь, иначе засчитают поражение.",
    takeDuelBoundsMessage() { const message = this.duelBoundsMessage; this.duelBoundsMessage = undefined; return message; },
    expireInteractionRequests() {},
    summonBlockReason() { return undefined; },
    displayName: (guid) => ({ 5n: "Тралл", 7n: "Утер" })[guid] ?? `0x${guid.toString(16)}`,
    printed: [],
    pushLocalMessage(message) { this.printed.push(typeof message === "string" ? message : String(message?.text ?? "")); },
    requestName() {}, ownTradeOffer: () => ({ money: 0, items: [] }),
    cancelLogout() { calls.push("cancelLogout"); }, answerReadyCheck(ready) { calls.push(`ready:${ready}`); },
    closeAuctionHouse() {}, cancelTrade() { calls.push("cancelTrade"); }, closeBank() {}, closeLoot() {}, closeGossip() {},
    closeQuest() {}, closeVendor() {}, closeTrainer() {},
  };
}

test("the controller answers false until published and keeps one owner", () => {
  assert.equal(controller.frameXmlPopupsPublished(), false);
  assert.equal(controller.frameXmlPopupsOpen(), false);
  assert.equal(controller.closeFrameXmlPopups(), false);
  const first = owner();
  const second = owner();
  const releaseFirst = controller.publishFrameXmlPopups(first);
  const releaseSecond = controller.publishFrameXmlPopups(second);
  releaseFirst();
  assert.equal(controller.frameXmlPopupsPublished(), true, "a stale cleanup cannot unpublish the current owner");
  assert.equal(controller.frameXmlPopupsOpen(), true);
  assert.equal(controller.closeFrameXmlPopups(), true);
  assert.equal(second.closes, 1);
  assert.equal(first.closes, 0, "publication never dismisses a dialog (its cancel would answer the server)");
  releaseSecond();
  assert.equal(second.closes, 1, "neither does teardown");
  assert.equal(controller.frameXmlPopupsPublished(), false);
});

test("every native prompt steps aside while the stock owner is published, and comes back after", () => {
  const world = pendingWorld();
  game.world = world;
  let release = () => {};
  try {
    // Unpublished: the natives ask, as before this lane.
    social.showGroup();
    social.showDuel();
    social.showTrade();
    guild.showGuild();
    npc.showDeath();
    prompts.showInteractionPrompts(0);
    readyCheck.showReadyCheck();
    gameMenu.updateLogoutPending(world, true);
    arena.toggleArenaWindow();
    assert.deepEqual([dom.groupInviteWindow.hidden, dom.duelWindow.hidden, dom.tradeWindow.hidden,
      dom.guildInviteWindow.hidden, dom.deathWindow.hidden], [false, false, false, false, false]);
    assert.equal(arenaInvite().hidden, false, "the arena panel's invitation section asks");
    assert.match(allText(arenaInvite()), /Тралл зовёт вас в команду «Орда навсегда»/);
    assert.match(allText(panel("interaction-prompts")), /призывает вас/);
    assert.match(allText(panel("interaction-prompts")), /Войти в бой/);
    assert.equal(readyCheck.readyCheckOpen(), true);
    assert.equal(panel("logout-countdown").hidden, false);
    assert.equal(world.printed.filter((line) => /границы дуэли/.test(line)).length, 1, "unpublished: the bounds line is said in chat");

    const stock = owner();
    release = controller.publishFrameXmlPopups(stock);
    refreshFrameXmlPopupsNative();
    assert.deepEqual([dom.groupInviteWindow.hidden, dom.duelWindow.hidden, dom.tradeWindow.hidden,
      dom.guildInviteWindow.hidden, dom.deathWindow.hidden], [true, true, true, true, true],
    "publication hides every native prompt at once");
    const published = allText(panel("interaction-prompts"));
    assert.doesNotMatch(published, /призывает вас/, "CONFIRM_SUMMON asks instead");
    assert.doesNotMatch(published, /Войти в бой/, "CONFIRM_BATTLEFIELD_ENTRY asks instead");
    assert.match(published, /Поле боя 1 · в очереди/, "a queue still waiting keeps its native row");
    assert.equal(readyCheck.readyCheckOpen(), false);
    assert.equal(panel("logout-countdown").hidden, true, "CAMP counts instead");
    assert.equal(arenaInvite().hidden, true, "ARENA_TEAM_INVITE asks instead");
    // Packets keep arriving through the native single slots; none reopens a native prompt.
    world.duelBoundsMessage = "Вы вышли за границы дуэли — вернитесь, иначе засчитают поражение.";
    social.showGroup();
    social.showDuel();
    social.showTrade();
    guild.showGuild();
    npc.showDeath();
    readyCheck.showReadyCheck();
    gameMenu.updateLogoutPending(world, true);
    assert.deepEqual([dom.groupInviteWindow.hidden, dom.duelWindow.hidden, dom.tradeWindow.hidden,
      dom.guildInviteWindow.hidden, dom.deathWindow.hidden], [true, true, true, true, true]);
    assert.equal(world.duelBoundsMessage, undefined, "the bounds line is consumed …");
    assert.equal(world.printed.filter((line) => /границы дуэли/.test(line)).length, 1, "… not printed: DUEL_OUTOFBOUNDS counts");
    assert.equal(panel("logout-countdown").hidden, true);
    assert.equal(readyCheck.readyCheckOpen(), false);
    // Escape: the window registry reaches stock StaticPopup_EscapePressed.
    windows.closeGameWindows();
    assert.equal(stock.closes, 1);
    assert.deepEqual(world.calls, [], "and no native cancel ran beside it");

    // Teardown: the questions still pending get their native prompts back — except the ready check
    // stock already answered.
    markFrameXmlPopupAnswered(world.readyCheck, true);
    release();
    refreshFrameXmlPopupsNative();
    assert.deepEqual([dom.groupInviteWindow.hidden, dom.duelWindow.hidden, dom.tradeWindow.hidden,
      dom.guildInviteWindow.hidden, dom.deathWindow.hidden], [false, false, false, false, false]);
    assert.match(allText(panel("interaction-prompts")), /призывает вас/);
    assert.equal(readyCheck.readyCheckOpen(), false, "answered on the stock surface: not asked again natively");
    assert.equal(panel("logout-countdown").hidden, false, "the countdown is native again");
    // Escape closed the arena panel with the other game windows; reopened, it asks again.
    if (!arena.arenaWindowOpen()) arena.toggleArenaWindow();
    assert.equal(arenaInvite().hidden, false, "the arena invitation is native again");
    assert.deepEqual(world.calls, [], "handing back answered nothing");
  } finally {
    release();
    prompts.resetInteractionPrompts();
    readyCheck.resetReadyCheck();
    gameMenu.resetLogoutPending();
    arena.closeArenaWindow();
    game.world = undefined;
  }
});

test("a shared quest steps aside only once stock QUEST_ACCEPT_CONFIRM asked it (3.22a)", async () => {
  const { FrameXmlServerPromptsModel } = await import("../dist/code/browser/framexml/FrameXmlServerPrompts.js");
  const { EventBus } = await import("../dist/code/world/EventBus.js");
  const world = pendingWorld();
  world.events = new EventBus();
  world.names = new Map([[5n, "Тралл"]]);
  world.answerSharedQuest = (accept) => { world.calls.push(`share:${accept}`); };
  const ask = () => world.events.emit("QUEST_SHARED", { quest: world.sharedQuest });
  const model = new FrameXmlServerPromptsModel({ world: () => world, monotonic: () => 0 });
  const fired = [];
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  game.world = world;
  let release = () => {};
  const text = () => { prompts.showInteractionPrompts(0); return allText(panel("interaction-prompts")); };
  try {
    // Shared before stock owned the popups: the native row asks, and keeps asking after publication —
    // stock never heard of this share, hiding the row would leave it unanswerable.
    world.sharedQuest = { questId: 11, title: "Поиски Тралла", initiatorGuid: 5n };
    ask();
    assert.match(text(), /предлагает задание «Поиски Тралла»/);
    release = controller.publishFrameXmlPopups(owner());
    assert.match(text(), /предлагает задание «Поиски Тралла»/, "published, but stock did not ask this one");
    // A share stock asks: one question, one surface.
    world.sharedQuest = { questId: 12, title: "Волчья охота", initiatorGuid: 5n };
    ask();
    assert.deepEqual(fired.at(-1), ["QUEST_ACCEPT_CONFIRM", "Тралл", "Волчья охота"]);
    assert.doesNotMatch(text(), /предлагает задание/, "QUEST_ACCEPT_CONFIRM asks instead");
    // A sharer whose name is not cached: Wow.exe raises nothing (0x58bc50), so the native row asks.
    world.sharedQuest = { questId: 13, title: "Тайна", initiatorGuid: 9n };
    ask();
    assert.match(text(), /предлагает задание «Тайна»/);
    assert.deepEqual(world.calls, [], "nothing answered on the way");
  } finally {
    model.detach();
    release();
    prompts.resetInteractionPrompts();
    game.world = undefined;
  }
});

test("the battleground entry stays native when the gate did not verify BattlefieldFrame", () => {
  const world = pendingWorld();
  game.world = world;
  const release = controller.publishFrameXmlPopups(owner(false));
  try {
    assert.equal(controller.frameXmlPopupsOwnBattlefieldEntry(), false);
    prompts.showInteractionPrompts(0);
    const text = allText(panel("interaction-prompts"));
    assert.doesNotMatch(text, /призывает вас/, "the summon is stock's all the same");
    assert.match(text, /Войти в бой/, "nothing stock would show CONFIRM_BATTLEFIELD_ENTRY: the native row asks");
  } finally {
    release();
    prompts.resetInteractionPrompts();
    game.world = undefined;
  }
  assert.equal(controller.frameXmlPopupsOwnBattlefieldEntry(), false, "unpublished: false");
});

test("the item menu's «Разрушить» asks stock DELETE_ITEM while published, the native confirmation otherwise", () => {
  const world = pendingWorld();
  game.world = world;
  const item = {
    guid: 0x99n, typeId: 1,
    fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 2589], [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 1]]),
  };
  const slot = { bag: 255, slot: 23, guid: 0x99n, item };
  const destroy = () => {
    const element = itemSlots.itemSlot(slot);
    element.click();
    const menu = document.body.children.filter((node) => node.id === "item-menu").at(-1);
    assert.ok(menu, "the item menu opened");
    menu.children.find((node) => node.textContent === "Разрушить").click();
  };
  const stock = owner();
  let release = () => {};
  try {
    destroy();
    assert.equal(confirmed.length, 1, "unpublished: the browser confirmation asks");
    assert.deepEqual(world.calls, ["destroy:255:23"]);
    release = controller.publishFrameXmlPopups(stock);
    destroy();
    assert.deepEqual(stock.destroyed, [[255, 23]], "published: the stock owner takes the item and asks");
    assert.equal(confirmed.length, 1, "no browser confirmation beside it");
    assert.deepEqual(world.calls, ["destroy:255:23"], "and nothing destroyed without stock's Yes");
    assert.equal(controller.frameXmlPopupsDropCursorItem(), false, "an owner without a model drops nothing");
  } finally {
    release();
    itemSlots.closeItemMenu();
    game.world = undefined;
  }
});

test("GameMenu's Quit intent reaches the popup model through the controller: QUIT, and ForceQuit leaves once", () => {
  const world = pendingWorld();
  world.requestLogout = () => { world.calls.push("logout"); };
  game.world = world;
  const intent = controller.frameXmlQuitIntent();
  assert.ok(intent, "GameMenu.ts registered its Quit intent on load");
  let left = 0;
  try {
    assert.equal(intent.quitting(), false, "a /camp logout is not a quit");
    intent.forceQuit();
    assert.equal(left, 0);
    gameMenu.requestQuitToLogin(() => { left += 1; });
    assert.deepEqual(world.calls, [], "the logout was already counting: only the intent is recorded");
    assert.equal(intent.quitting(), true, "PLAYER_QUITING then, not PLAYER_CAMPING");
    intent.forceQuit();
    intent.forceQuit();
    assert.equal(left, 1, "«Выйти сейчас» leaves for the login screen once");
    assert.equal(intent.quitting(), false, "the intent is spent");
    gameMenu.requestQuitToLogin(() => { left += 1; });
    gameMenu.cancelLogoutRequest();
    assert.equal(intent.quitting(), false, "CancelLogout (QUIT's OnHide) drops the intent");
    assert.deepEqual(world.calls, ["cancelLogout"]);
  } finally {
    gameMenu.resetLogoutPending();
    game.world = undefined;
  }
});

test("a ready check answered on the native prompt is not asked again by either surface", () => {
  const world = pendingWorld();
  game.world = world;
  try {
    readyCheck.showReadyCheck();
    const buttons = panel("ready-check-window").children[1].children.find((node) => node.className === "ready-check-actions").children;
    buttons.find((node) => node.textContent === "Не готов").click();
    assert.deepEqual(world.calls, ["ready:false"]);
    readyCheck.closeReadyCheck();
    readyCheck.showReadyCheck();
    assert.equal(readyCheck.readyCheckOpen(), false, "the shared ledger remembers the answer after a reset");
  } finally {
    readyCheck.resetReadyCheck();
    game.world = undefined;
  }
});
