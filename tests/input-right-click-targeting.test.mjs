import assert from "node:assert/strict";
import test from "node:test";

// A right click on the 3D world cancels pending spell targeting, as the 3.3.5 client does: the
// stock TradeSkillFrame's enchant cursor (DoTradeSkill waiting for its item) and the native
// ground-target reticle. The click that cancelled selects and opens nothing; with nothing armed a
// right click still selects and interacts, and a right drag is still the camera's. The fake DOM of
// input-controls-residuals.test.mjs: Controls is the real module.

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
  setPointerCapture() {}
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
};
globalThis.location = window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const tradeSkill = await import("../dist/code/browser/framexml/FrameXmlTradeSkillController.js");
const groundTarget = await import("../dist/code/browser/game/GroundTarget.js");
const dom = await import("../dist/code/browser/ui/Dom.js");
const controls = await import("../dist/code/browser/input/Controls.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
usePanelHost({ viewport: document.body, attach() {} });
controls.wireControls();

const CORPSE = 7n;

/** A world with one lootable corpse under the pointer, recording what a click asks of it. */
function worldStub() {
  const selections = [];
  const loots = [];
  const corpse = { guid: CORPSE, typeId: 3, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0]]) };
  return {
    selections, loots,
    state: { selfGuid: 1n, objects: new Map([[CORPSE, corpse]]) }, targetGuid: undefined, chatLog: [],
    // Recorded only: the target frame's repaint stays on its empty branch.
    selectTarget(guid) { selections.push(guid); },
    openLoot(guid) { loots.push(guid); },
    closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, aurasFor: () => [],
    displayName: () => "",
  };
}

function pointer(name, event) {
  for (const handler of dom.worldCanvas.listeners.get(name) ?? []) handler(event);
}

const base = { pointerId: 1, clientX: 40, clientY: 40, movementX: 0, movementY: 0, preventDefault() {} };

function rightClick() {
  pointer("pointerdown", { ...base, button: 2, buttons: 2 });
  pointer("pointerup", { ...base, button: 2, buttons: 0 });
}

function rightDrag() {
  pointer("pointerdown", { ...base, button: 2, buttons: 2 });
  pointer("pointermove", { ...base, movementX: 12, buttons: 2 });
  pointer("pointerup", { ...base, button: 2, buttons: 0 });
}

/** A published stock trade skill owner whose enchant waits while `armed` holds. */
function publishEnchant() {
  const owner = {
    armed: true, cancels: 0, closes: 0,
    isOpen: () => true,
    open: () => true,
    close() { this.closes += 1; return true; },
    targeting() { return this.armed; },
    cancelTargeting() {
      if (!this.armed) return false;
      this.armed = false;
      this.cancels += 1;
      return true;
    },
  };
  return { owner, release: tradeSkill.publishFrameXmlTradeSkill(owner) };
}

test("a right click on the world drops the waiting enchant, keeps the window and selects nothing", () => {
  const world = worldStub();
  game.world = world;
  game.scene = { pick: () => CORPSE };
  const { owner, release } = publishEnchant();
  try {
    rightClick();
    assert.equal(owner.cancels, 1, "SpellStopTargeting dropped the enchant");
    assert.equal(owner.armed, false);
    assert.equal(owner.closes, 0, "the TradeSkillFrame stays open");
    assert.deepEqual(world.selections, [], "the cancelling click selects nothing");
    assert.deepEqual(world.loots, [], "and opens nothing");
    // Nothing is armed any more: the next right click is the ordinary select-and-interact.
    rightClick();
    assert.equal(owner.cancels, 1);
    assert.deepEqual(world.selections, [CORPSE]);
    assert.deepEqual(world.loots, [CORPSE]);
  } finally {
    release();
    game.world = undefined;
    game.scene = undefined;
  }
});

test("a right drag with the enchant waiting turns the camera and leaves the enchant armed", () => {
  const world = worldStub();
  game.world = world;
  game.scene = { pick: () => CORPSE };
  const { owner, release } = publishEnchant();
  try {
    rightDrag();
    assert.equal(owner.cancels, 0, "a drag is the camera's, not a click");
    assert.equal(owner.armed, true);
    assert.deepEqual(world.selections, []);
    assert.deepEqual(world.loots, []);
  } finally {
    release();
    game.world = undefined;
    game.scene = undefined;
  }
});

test("the ground reticle is cancelled by a right click too, and with nothing published the click is native", () => {
  const world = worldStub();
  game.world = world;
  game.scene = { pick: () => CORPSE };
  try {
    groundTarget.beginGroundTarget(116);
    assert.equal(groundTarget.pendingGroundTarget(), 116);
    rightClick();
    assert.equal(groundTarget.pendingGroundTarget(), undefined, "the reticle is dropped");
    assert.deepEqual(world.selections, [], "and that click selected nothing");
    // Unpublished, the stock owner answers false and the right click interacts.
    rightClick();
    assert.deepEqual(world.selections, [CORPSE]);
    assert.deepEqual(world.loots, [CORPSE]);
  } finally {
    groundTarget.cancelGroundTarget();
    game.world = undefined;
    game.scene = undefined;
  }
});

test("a throwing owner is demoted and the click stays native", () => {
  const world = worldStub();
  game.world = world;
  game.scene = { pick: () => CORPSE };
  let demoted = 0;
  const release = tradeSkill.publishFrameXmlTradeSkill({
    isOpen: () => false, open: () => false, close: () => false,
    cancelTargeting() { throw new Error("broken VM"); },
    demote() { demoted += 1; },
  });
  try {
    rightClick();
    assert.equal(demoted, 1);
    assert.deepEqual(world.selections, [CORPSE]);
  } finally {
    release();
    game.world = undefined;
    game.scene = undefined;
  }
});

/**
 * 5.05: a right click on a unit the player may fight starts the swing (Npc.ts `interactWithGuid`,
 * after the corpse branch): always on a hostile one, on a neutral one only when it offers no
 * service. Reactions come from a stub faction table; template 1 is the player's.
 */
function fightWorld(units) {
  const selections = [];
  const attacks = [];
  const gossips = [];
  const objects = new Map([[1n, {
    guid: 1n, typeId: 4,
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100], [UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, 1],
      [UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8]]),
  }]]);
  for (const { guid, template, npcFlags = 0 } of units) {
    objects.set(guid, {
      guid, typeId: 3,
      fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100], [UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset, template],
        [UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, npcFlags]]),
    });
  }
  const world = {
    selections, attacks, gossips,
    state: { selfGuid: 1n, objects }, targetGuid: undefined, chatLog: [], forcedReactions: new Map(),
    // The selection is recorded rather than kept, so the target frame stays on its empty branch.
    selectTarget(guid) { selections.push(guid); this.lastSelected = guid; },
    startAttack() { attacks.push(this.lastSelected); },
    openGossip(guid) { gossips.push(guid); },
    openLoot() {}, closeAuctionHouse() {}, cancelTrade() {}, closeBank() {}, closeLoot() {}, aurasFor: () => [],
    displayName: () => "", closeGossip() {}, closeVendor() {}, closeTrainer() {}, closeNpcServices() {},
  };
  return world;
}

/** Template 2 hostile, 3 neutral, 4 friendly to template 1. */
const factionStub = {
  ready: true,
  reaction: (_mine, theirs) => (theirs === 2 ? -1 : theirs === 4 ? 1 : 0),
  factionOf: (template) => template * 10,
  // 11.02-tails-review: the /dbc/reputation catalog is in and none of these factions keeps a
  // reputation, so 0x00729530's reaction test is judged on the masks (UnitInteractGate.ts).
  reputationCatalog: { version: 1, factions: {} },
};

test("5.05 a right click on a hostile unit starts the swing, and on a friend or a neutral innkeeper it does not", () => {
  const HOSTILE = 20n;
  const NEUTRAL_KEEPER = 21n;
  const FRIEND = 22n;
  const NEUTRAL_BOAR = 23n;
  const world = fightWorld([
    { guid: HOSTILE, template: 2 },
    { guid: NEUTRAL_KEEPER, template: 3, npcFlags: 0x1 },
    { guid: FRIEND, template: 4 },
    { guid: NEUTRAL_BOAR, template: 3 },
  ]);
  game.world = world;
  const previousFactions = game.factions;
  game.factions = factionStub;
  let under = HOSTILE;
  game.scene = { pick: () => under };
  try {
    rightClick();
    assert.deepEqual(world.attacks, [HOSTILE], "a hostile unit is attacked once");
    under = FRIEND;
    rightClick();
    assert.deepEqual(world.attacks, [HOSTILE], "a friend is never attacked by a click");
    under = NEUTRAL_KEEPER;
    rightClick();
    assert.deepEqual(world.attacks, [HOSTILE], "a neutral with a service is talked to");
    assert.deepEqual(world.gossips, [NEUTRAL_KEEPER]);
    under = NEUTRAL_BOAR;
    rightClick();
    assert.deepEqual(world.attacks, [HOSTILE, NEUTRAL_BOAR], "a neutral with nothing to offer is fought");
  } finally {
    game.world = undefined;
    game.scene = undefined;
    game.factions = previousFactions;
  }
});

test("5.05 review: before the faction table lands a right click never swings, at a guard or a bot", () => {
  // Every unit reads neutral without the table, and a neutral unit with no service is fought — so a
  // flagless friendly guard, party member or NPCBot would have been attacked (with a dismount in
  // front of the swing). Until the table is in, the click stays what it was before 5.05.
  const GUARD = 30n;
  const world = fightWorld([{ guid: GUARD, template: 4 }]);
  game.world = world;
  const previousFactions = game.factions;
  game.scene = { pick: () => GUARD };
  try {
    for (const factions of [undefined, { ...factionStub, ready: false }]) {
      game.factions = factions;
      rightClick();
      assert.deepEqual(world.attacks, [], factions === undefined ? "no faction client" : "table not ready");
    }
  } finally {
    game.world = undefined;
    game.scene = undefined;
    game.factions = previousFactions;
  }
});

/**
 * 11.02-tails: Wow.exe 0x00731260 hands a live unit to the interaction chain only through 0x00729530
 * (world/UnitInteractGate.ts) and attacks it otherwise: NPC flags and both reactions neutral or
 * better, or UNIT_FLAG2_ALLOW_ENEMY_INTERACT 0x4000 whatever the reactions; a ghost only to a
 * creature that shows itself to ghosts. Ghidra notes: .runtime/re-2026-10-03/l1102bcd-review/r1.c, r2.c.
 */
test("11.02-tails a hostile NPCBot for hire (ALLOW_ENEMY_INTERACT) is talked to, a hostile service it cannot fight is left alone", () => {
  const FOR_HIRE = 40n;
  const SHIELDED = 41n;
  const RAIDER = 42n;
  const world = fightWorld([
    { guid: FOR_HIRE, template: 2, npcFlags: 0x1 },
    { guid: SHIELDED, template: 2, npcFlags: 0x1 },
    { guid: RAIDER, template: 2, npcFlags: 0x1 },
  ]);
  world.state.objects.get(FOR_HIRE).fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS_2.offset, 0x4000);
  // UNIT_FLAG_NON_ATTACKABLE: CanAttack (0x00729740) refuses it, and 0x00729530 refuses a hostile talk.
  world.state.objects.get(SHIELDED).fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x2);
  game.world = world;
  const previousFactions = game.factions;
  game.factions = factionStub;
  let under = FOR_HIRE;
  game.scene = { pick: () => under };
  try {
    rightClick();
    assert.deepEqual(world.attacks, [], "the bot for hire is not fought");
    assert.deepEqual(world.gossips, [FOR_HIRE], "it is talked to — its hire menu");
    under = SHIELDED;
    rightClick();
    assert.deepEqual(world.attacks, [], "nothing to swing at");
    assert.deepEqual(world.gossips, [FOR_HIRE], "and no talk with a hostile unit either (the old click asked for gossip)");
    under = RAIDER;
    rightClick();
    assert.deepEqual(world.attacks, [RAIDER], "an ordinary hostile with a gossip flag is still fought");
    assert.deepEqual(world.gossips, [FOR_HIRE]);
  } finally {
    game.world = undefined;
    game.scene = undefined;
    game.factions = previousFactions;
  }
});

test("11.02-tails a ghost's right click reaches only the creatures that show themselves to ghosts", () => {
  const HEALER = 50n;
  const VENDOR = 51n;
  const UNKNOWN = 52n;
  const world = fightWorld([
    { guid: HEALER, template: 4, npcFlags: 0x1 | 0x4000 },
    { guid: VENDOR, template: 4, npcFlags: 0x1 },
    { guid: UNKNOWN, template: 4, npcFlags: 0x1 },
  ]);
  const entries = [[HEALER, 6491], [VENDOR, 1000], [UNKNOWN, 1001]];
  for (const [guid, entry] of entries) world.state.objects.get(guid).fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry);
  world.creatureTemplates = new Map([
    [6491, { entry: 6491, found: true, flags: 0x2 }],
    [1000, { entry: 1000, found: true, flags: 0 }],
  ]);
  world.state.objects.get(1n).fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, 0x10);
  game.world = world;
  const previousFactions = game.factions;
  game.factions = factionStub;
  let under = HEALER;
  game.scene = { pick: () => under };
  try {
    rightClick();
    assert.deepEqual(world.gossips, [HEALER], "the spirit healer (CREATURE_TYPE_FLAG_VISIBLE_TO_GHOSTS)");
    under = VENDOR;
    rightClick();
    assert.deepEqual(world.gossips, [HEALER], "a living vendor does not answer the dead");
    under = UNKNOWN;
    rightClick();
    assert.deepEqual(world.gossips, [HEALER, UNKNOWN], "a template not cached yet keeps the old click");
    // Alive again: the same vendor is talked to.
    world.state.objects.get(1n).fields.set(UPDATE_FIELDS.PLAYER_FLAGS.offset, 0);
    under = VENDOR;
    rightClick();
    assert.deepEqual(world.gossips, [HEALER, UNKNOWN, VENDOR]);
    assert.deepEqual(world.attacks, [], "a friend is never fought");
  } finally {
    game.world = undefined;
    game.scene = undefined;
    game.factions = previousFactions;
  }
});
