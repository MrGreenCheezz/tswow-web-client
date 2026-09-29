import assert from "node:assert/strict";
import test from "node:test";

// The native HUD under the stock FrameXML one: its lanes are hidden by the classes the world mount
// publishes on <body> (NativeHudReplacement.ts), and the per-frame work that only kept them painted
// — cooldown sweeps, cast bars, countdowns, the player frame's text — is skipped while they stand.
// With the classes off (`originalFrameXml: false`) every lane is drawn exactly as before. The strips
// that stay native are change-driven: the totem strip and the notices.

/** Every DOM write, and the reads and constructions the lanes used to pay for each frame. */
const stats = { writes: 0, created: 0, queries: 0, rects: 0, attributeReads: 0 };
function resetStats() { for (const key of Object.keys(stats)) stats[key] = 0; }
/** Every counted write goes through here; `WRITE_TRACE=1` prints where each one comes from. */
let tracing = false;
function wrote() {
  stats.writes += 1;
  if (tracing) console.log(new Error("write").stack.split("\n").slice(2, 6).join(" <- "));
}
/** Traces the writes of one step when `WRITE_TRACE=1`. */
function traced(step) {
  tracing = process.env.WRITE_TRACE === "1";
  try { return step(); } finally { tracing = false; }
}

function counted(target) {
  return new Proxy(target, {
    set(object, key, value) { wrote(); object[key] = value; return true; },
    deleteProperty(object, key) { wrote(); delete object[key]; return true; },
  });
}

function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    stats.created += 1;
    const attributes = new Map();
    const classes = new Set();
    const state = { textContent: "", hidden: false, title: "", disabled: false, className: "" };
    const style = counted({
      setProperty(name, value) { wrote(); style[name] = String(value); },
      removeProperty(name) { wrote(); delete style[name]; },
    });
    const node = {
      tagName: String(tag).toUpperCase(), children: [], id: "", value: "", type: "", draggable: false,
      checked: false, src: "", alt: "", onerror: null, onload: null, tabIndex: -1, isConnected: true,
      naturalWidth: 0, naturalHeight: 0, clientWidth: 0, clientHeight: 0,
      dataset: counted({}), style,
      get textContent() { return state.textContent; },
      set textContent(value) { wrote(); state.textContent = String(value); node.children = []; },
      get hidden() { return state.hidden; },
      set hidden(value) { wrote(); state.hidden = !!value; },
      get title() { return state.title; },
      set title(value) { wrote(); state.title = String(value); },
      get disabled() { return state.disabled; },
      set disabled(value) { wrote(); state.disabled = !!value; },
      get className() { return state.className; },
      set className(value) { wrote(); state.className = String(value); },
      get childElementCount() { return node.children.length; },
      classList: {
        add(...names) { wrote(); for (const name of names) classes.add(name); },
        remove(...names) { wrote(); for (const name of names) classes.delete(name); },
        toggle(name, force) {
          wrote();
          const on = force === undefined ? !classes.has(name) : !!force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
        contains(name) { return classes.has(name); },
      },
      append(...nodes) { wrote(); node.children.push(...nodes); },
      prepend(...nodes) { wrote(); node.children.unshift(...nodes); },
      appendChild(child) { wrote(); node.children.push(child); return child; },
      insertBefore(child) { wrote(); node.children.push(child); return child; },
      replaceChildren(...nodes) { wrote(); node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { wrote(); attributes.set(name, String(value)); },
      getAttribute(name) { stats.attributeReads += 1; return attributes.get(name) ?? null; },
      removeAttribute(name) { wrote(); attributes.delete(name); },
      querySelector() { stats.queries += 1; return make("div"); },
      querySelectorAll() { stats.queries += 1; return []; },
      closest() { return null; },
      getBoundingClientRect() {
        stats.rects += 1;
        return { x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 };
      },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { ACTION_BUTTON_SPELL } = await import("../dist/code/world/ActionBarProtocol.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { showActionBar, updateActionBar } = await import("../dist/code/browser/ui/ActionBar.js");
const { updateCastBars } = await import("../dist/code/browser/ui/CastBar.js");
const { auraTimers, updateAuraDurations } = await import("../dist/code/browser/ui/Auras.js");
const { updateMirrorTimers } = await import("../dist/code/browser/ui/MirrorTimers.js");
const { showSpells, updateSpellCooldowns } = await import("../dist/code/browser/ui/Spellbook.js");
const { bindPlayerHud, repaintPlayerHud } = await import("../dist/code/browser/ui/Frames.js");
const { updateTotems } = await import("../dist/code/browser/ui/Totems.js");
const { notice, updateNotices } = await import("../dist/code/browser/ui/Notices.js");
const { drainWorldState, showWorldState } = await import("../dist/code/browser/ui/WorldView.js");
const { resetHeadOverlay, showChatBubble, updateHeadOverlay } = await import("../dist/code/browser/ui/HeadOverlay.js");
const {
  NATIVE_FOCUS_REPLACED, NATIVE_LANES_REPLACED, NATIVE_MIRROR_TIMERS_REPLACED, NATIVE_TARGET_CONTEXT_REPLACED,
} = await import("../dist/code/browser/ui/NativeHudReplacement.js");
const {
  playerCast, playerHudDetails, playerHealthText, spellbookList, spellbookWindow, targetCast, diagnosticsWindow,
  worldStatus, playerPosition,
} = await import("../dist/code/browser/ui/Dom.js");

const body = document.body;
function replaced(...classes) {
  for (const name of [NATIVE_LANES_REPLACED, NATIVE_TARGET_CONTEXT_REPLACED, NATIVE_FOCUS_REPLACED,
    NATIVE_MIRROR_TIMERS_REPLACED]) body.classList.toggle(name, classes.includes(name));
}

/** A `Spell.dbc` row as the gateway serves it, with only the fields a button reads filled in. */
function spell(id, name, extra = {}) {
  return {
    id, name, rank: "", description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [],
    spellLevel: 0, spellClassSet: 3, spellClassMask: [1, 0, 0], schoolMask: 0,
    rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: 0,
    ...extra,
  };
}

/** Only what the lanes under test ask of a `WorldClient`. */
function world(extra = {}) {
  return {
    actionButtons: [], knownSpells: [], initialSpellsReceived: true, equipmentSets: [],
    casts: new Map(), mirrorTimers: new Map(), totems: new Map(), spellModifiers: new Map(),
    cooldownRemaining: () => 0, cooldownState: () => undefined, isActiveMountSpell: () => false,
    itemCooldownRemaining: () => 0, itemTemplate: () => undefined,
    castProgress: () => 0.5, targetGuid: undefined,
    state: { selfGuid: undefined, objects: new Map(), revision: 0 },
    ...extra,
  };
}

test.afterEach(() => {
  replaced();
  game.world = undefined;
  game.spells = new Map();
  game.globalCooldownUntil = 0;
  game.focusGuid = undefined;
});

test("the action bar's sweeps stop moving under the stock bars and move again after them", () => {
  const now = 10_000;
  game.spells = new Map([[133, spell(133, "Огненный шар", { startRecoveryTime: 1500 })]]);
  game.world = world({ actionButtons: [{ slot: 0, action: 133, type: ACTION_BUTTON_SPELL }] });
  showActionBar();
  game.globalCooldownUntil = now + 1500;
  resetStats();
  updateActionBar(now);
  assert.ok(stats.writes > 0, "the native bar draws the global cooldown");
  replaced(NATIVE_LANES_REPLACED);
  resetStats();
  updateActionBar(now + 300);
  assert.equal(stats.writes, 0, "hidden behind MainMenuBar, its sweep is not written");
  replaced();
  resetStats();
  updateActionBar(now + 600);
  assert.ok(stats.writes > 0, "handed back, it is drawn from the world's clock again");
});

test("each cast bar is left alone only while its own lane is replaced", () => {
  const self = 0x10n;
  const target = 0x20n;
  const focus = 0x30n;
  const cast = (spellId) => ({ spellId, startedAt: 0, duration: 3000, channel: false, castCount: 1 });
  game.world = world({
    targetGuid: target,
    state: { selfGuid: self, objects: new Map(), revision: 0 },
    casts: new Map([[self, cast(133)], [target, cast(116)], [focus, cast(403)]]),
  });
  game.focusGuid = focus;
  const focusMount = document.getElementById("focus-cast");
  updateCastBars(1000);
  const bar = (mount) => mount.children[0];
  assert.equal(bar(playerCast).hidden, false);
  assert.equal(bar(targetCast).hidden, false);
  assert.equal(bar(focusMount).hidden, false);

  // Only the player's lane: its bar keeps its old picture; the target's and focus's move on.
  replaced(NATIVE_LANES_REPLACED);
  game.world.casts.clear();
  updateCastBars(1100);
  assert.equal(bar(playerCast).hidden, false, "the hidden player bar is not written");
  assert.equal(bar(targetCast).hidden, true, "the target's native bar is still native");
  assert.equal(bar(focusMount).hidden, true, "and so is the focus frame's");

  game.world.casts.set(target, cast(116));
  game.world.casts.set(focus, cast(403));
  replaced(NATIVE_LANES_REPLACED, NATIVE_TARGET_CONTEXT_REPLACED, NATIVE_FOCUS_REPLACED);
  resetStats();
  updateCastBars(1200);
  assert.equal(stats.writes, 0, "under all three stock owners nothing is drawn");
  assert.equal(bar(targetCast).hidden, true);
  assert.equal(bar(focusMount).hidden, true);

  replaced();
  updateCastBars(1300);
  assert.equal(bar(playerCast).hidden, true, "handed back, each bar shows the world as it is");
  assert.equal(bar(targetCast).hidden, false);
  assert.equal(bar(focusMount).hidden, false);
});

test("aura countdowns wait while both native strips are behind stock owners", () => {
  const label = document.createElement("span");
  const aura = document.createElement("div");
  auraTimers.length = 0;
  auraTimers.push({ aura, label, expiresAt: 5_000 });
  try {
    updateAuraDurations(0);
    assert.equal(label.textContent, "5.0");
    replaced(NATIVE_LANES_REPLACED);
    updateAuraDurations(1_000);
    assert.equal(label.textContent, "4.0", "the target strip is still native: it counts down");
    replaced(NATIVE_LANES_REPLACED, NATIVE_TARGET_CONTEXT_REPLACED);
    resetStats();
    updateAuraDurations(2_000);
    assert.equal(stats.writes, 0);
    assert.equal(label.textContent, "4.0");
    replaced();
    updateAuraDurations(3_000);
    assert.equal(label.textContent, "2.0");
  } finally { auraTimers.length = 0; }
});

test("the native mirror timers stand still while stock MirrorTimer1-3 run them", () => {
  const timer = { maxValue: 60_000, value: 60_000, scale: -1, paused: false, spellId: 0 };
  game.world = world({ mirrorTimers: new Map([[1, { timer, receivedAt: 0 }]]) });
  updateMirrorTimers(0);
  const strip = document.getElementById("world-viewport").children.find((child) => child.id === "mirror-timers");
  assert.ok(strip, "the native strip is built");
  const text = () => strip.children[0].children[1].children[1].textContent;
  assert.equal(text(), "60 с");
  replaced(NATIVE_MIRROR_TIMERS_REPLACED);
  resetStats();
  updateMirrorTimers(10_000);
  assert.equal(stats.writes, 0);
  assert.equal(text(), "60 с");
  replaced();
  updateMirrorTimers(10_000);
  assert.equal(text(), "50 с");
});

test("a closed spellbook's buttons are neither read nor written", () => {
  game.spells = new Map([[133, spell(133, "Огненный шар", { recoveryTime: 8000 })]]);
  let remaining = 0;
  game.world = world({ knownSpells: [{ id: 133, slot: 0 }], cooldownRemaining: () => remaining });
  spellbookWindow.hidden = false;
  showSpells();
  const button = spellbookList.children[0];
  assert.ok(button, "the book drew its spell");
  remaining = 4000;
  updateSpellCooldowns(1_000);
  assert.equal(button.disabled, true, "an open book shows the cooldown");
  spellbookWindow.hidden = true;
  remaining = 0;
  resetStats();
  updateSpellCooldowns(2_000);
  assert.equal(stats.writes, 0, "closed — the stock SpellBookFrame's whole session — nothing is written");
  assert.equal(stats.attributeReads, 0, "nor read");
  spellbookWindow.hidden = false;
  updateSpellCooldowns(3_000);
  assert.equal(button.disabled, false, "opened again, it is current on the first frame");
});

test("the native player frame is not written behind the stock PlayerFrame and repaints when let go", () => {
  const state = new WorldState();
  const store = new WorldStore(state);
  const self = 0x10n;
  state.objects.set(self, {
    guid: self, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0,
    targetGuid: undefined, runSpeed: undefined, turnRate: undefined, transport: undefined, speeds: undefined,
    motion: undefined, glide: undefined, transportTime: undefined, fields: new Map(),
  });
  state.selfGuid = self;
  bindPlayerHud(store);
  store.selfChanged();
  state.setField(self, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 800);
  state.setField(self, UPDATE_FIELDS.UNIT_FIELD_MAXHEALTH.offset, 1000);
  store.flush();
  assert.equal(playerHealthText.textContent, "800 / 1000");

  replaced(NATIVE_LANES_REPLACED);
  state.setField(self, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 600);
  resetStats();
  traced(() => store.flush());
  assert.equal(playerHealthText.textContent, "800 / 1000", "hidden: the health change is not written");
  assert.equal(stats.writes, 0);

  // The mount's teardown takes the class off and asks for one repaint; standing still, nothing else would.
  replaced();
  repaintPlayerHud();
  assert.equal(playerHealthText.textContent, "600 / 1000");
  assert.match(playerHudDetails.textContent, /^ур\./);
  // And the same values again are not written again.
  resetStats();
  repaintPlayerHud();
  assert.equal(stats.writes, 0, "an unchanged frame writes nothing");
});

test("the totem strip builds its rows when the slots change and only moves the clocks otherwise", () => {
  game.spells = new Map([[3599, spell(3599, "Тотем опаляющего огня")]]);
  const totems = new Map([[0, { spellId: 3599, startedAt: 0, duration: 60_000 }]]);
  game.world = world({ totems });
  updateTotems(0);
  const strip = document.getElementById("world-viewport").children.find((child) => child.id === "totem-bar");
  assert.ok(strip);
  assert.equal(strip.children.length, 1);
  const clock = () => strip.children[0].children[1].textContent;
  assert.equal(clock(), "60 с");
  resetStats();
  for (let frame = 1; frame <= 30; frame++) updateTotems(frame * 16);
  assert.equal(stats.created, 0, "thirty frames of one standing totem build nothing");
  assert.equal(stats.queries, 0, "and query nothing");
  assert.equal(stats.writes, 0, "the second has not moved, so nothing is written");
  updateTotems(1_000);
  assert.equal(clock(), "59 с");
  assert.equal(stats.writes, 1, "a second later, one clock");
  // A second totem, and the first expiring, rebuild the rows.
  totems.set(2, { spellId: 3599, startedAt: 0, duration: 120_000 });
  updateTotems(2_000);
  assert.equal(strip.children.length, 2);
  updateTotems(61_000);
  assert.equal(strip.children.length, 1);
  assert.equal(clock(), "59 с");
  totems.clear();
  updateTotems(62_000);
  assert.equal(strip.hidden, true);
  assert.equal(strip.children.length, 0);
});

test("a notice is drawn once, and the strip again only when one expires", () => {
  const strip = () => document.getElementById("world-viewport").children.find((child) => child.id === "notices");
  notice("Вне зоны действия", "info");
  const drawn = strip();
  assert.ok(drawn);
  assert.equal(drawn.children.length, 1);
  const first = drawn.children[0];
  updateNotices(performance.now());
  assert.equal(drawn.children[0], first, "the frame after it does not draw it again");
  updateNotices(performance.now() + 60_000);
  assert.equal(drawn.children.length, 0, "an expired one is taken down");
});

test("the head overlay reads its size from a ResizeObserver, not from the layout every 250 ms", () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
  };
  const client = new WorldClient({ send() {}, close() {} });
  const self = 0x10n;
  client.state.selfGuid = self;
  client.state.objects.set(self, {
    guid: self, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map(),
  });
  game.world = client;
  try {
    resetHeadOverlay();
    showChatBubble(self, "Кто здесь?");
    resetStats();
    updateHeadOverlay(0);
    assert.equal(stats.rects, 1, "measured once, before the observer has reported");
    const observer = observers.at(-1);
    assert.ok(observer && observer.targets.length === 1, "the layer is observed");
    observer.callback([{ target: observer.targets[0], contentRect: { width: 1280, height: 720 } }]);
    for (let frame = 1; frame <= 60; frame++) updateHeadOverlay(frame * 16);
    assert.equal(stats.rects, 1, "a second of frames reads no rectangle: the observer's size is used");
    // A resize is the observer's to report, and the next frame uses it.
    observer.callback([{ target: observer.targets[0], contentRect: { width: 800, height: 600 } }]);
    updateHeadOverlay(2_000);
    assert.equal(stats.rects, 1);
  } finally {
    resetHeadOverlay();
    delete globalThis.ResizeObserver;
  }
});

test("without a ResizeObserver the head overlay still measures, at most once per 250 ms", () => {
  const client = new WorldClient({ send() {}, close() {} });
  const self = 0x10n;
  client.state.selfGuid = self;
  client.state.objects.set(self, {
    guid: self, typeId: 4, position: { x: 0, y: 0, z: 0, orientation: 0 }, fields: new Map(),
  });
  game.world = client;
  // A new layer (the last test's is taken off the page), so nothing observed carries over.
  const old = document.getElementById("world-viewport").children.find((child) => child.id === "head-overlay");
  if (old) old.isConnected = false;
  try {
    resetHeadOverlay();
    showChatBubble(self, "Кто здесь?");
    resetStats();
    for (let frame = 0; frame < 60; frame++) updateHeadOverlay(frame * 16);
    assert.equal(stats.rects, 4, "0, 256, 512 and 768 ms");
  } finally { resetHeadOverlay(); }
});

test("the diagnostics window's world lines are written only while it is open", () => {
  const client = new WorldClient({ send() {}, close() {} });
  const state = client.state;
  game.world = client;
  diagnosticsWindow.hidden = true;
  worldStatus.textContent = "";
  playerPosition.textContent = "";
  showWorldState(state);
  assert.equal(worldStatus.textContent, "", "closed: not written");
  assert.equal(playerPosition.textContent, "");
  drainWorldState();
  // Opened without a redraw (the game menu's «Диагностика»): the next frame writes them.
  diagnosticsWindow.hidden = false;
  drainWorldState();
  assert.match(worldStatus.textContent, /^Объектов в памяти: 0\./);
  assert.equal(playerPosition.textContent, "Позиция персонажа ещё не получена.");
  diagnosticsWindow.hidden = true;
});
