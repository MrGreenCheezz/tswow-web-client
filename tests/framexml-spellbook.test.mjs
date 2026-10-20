import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 5 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-spellbook-controller.test.mjs
{
const controller = await import("../dist/code/browser/framexml/FrameXmlSpellBookController.js");

function owner() {
  return {
    open: false,
    shows: 0,
    hides: 0,
    isOpen() { return this.open; },
    show() { this.open = true; this.shows++; },
    hide() { this.open = false; this.hides++; },
  };
}

test("stock SpellBook controller is one owner for toggle, Escape close and teardown", () => {
  const first = owner();
  const releaseFirst = controller.publishFrameXmlSpellBook(first);
  assert.equal(controller.frameXmlSpellBookOpen(), false);
  assert.equal(controller.toggleFrameXmlSpellBook(), true);
  assert.equal(first.open, true);
  assert.equal(controller.frameXmlSpellBookOpen(), true);
  assert.equal(controller.closeFrameXmlSpellBook(), true);
  assert.equal(first.open, false);
  assert.equal(first.hides, 1);

  // A stale cleanup from an earlier mount cannot clear the current owner.
  const second = owner();
  const releaseSecond = controller.publishFrameXmlSpellBook(second);
  releaseFirst();
  assert.equal(controller.toggleFrameXmlSpellBook(), true);
  assert.equal(second.open, true);
  releaseSecond();
  releaseSecond();
  assert.equal(second.open, false);
  assert.equal(controller.frameXmlSpellBookOpen(), false);
});

test("without a published stock owner the caller can use the native fallback", () => {
  assert.equal(controller.toggleFrameXmlSpellBook(), false);
  assert.equal(controller.closeFrameXmlSpellBook(), false);
});
}

// ── framexml-spellbook-not-ready.test.mjs
{
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");

test("an authoritative empty tab provider does not fabricate a fallback spellbook tab", () => {
  const world = {
    knownSpells: [{ id: 133, slot: 0 }],
    cooldownSnapshots: new Map(),
    actionButtons: [],
    casts: new Map(),
    state: { selfGuid: 1n, objects: new Map() },
    events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => ({ id: 133, name: "Огненный шар", rank: "", iconPath: "", hidden: false }),
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    spellTabs: () => [],
    spellTabFor: () => undefined,
  });
  assert.equal(seam.spellTabCount(), 0);
  assert.equal(seam.spellTabInfo(1), undefined);
  assert.equal(seam.spellName(1, "spell"), undefined);
});
}

// ── framexml-spellbook-ranks.test.mjs
{
// ShowAllSpellRanks off (the browser's default, `spellbookHideLowerRanks`): the stock book reads
// GetSpellTabInfo's highest-rank offset/count and maps each shown row through
// GetKnownSlotFromHighestRankSlot (SpellBookFrame.lua:591-601, :656-663). Both used to repeat the
// unfolded numbers, so every lower rank stayed in the book and the checkbox changed nothing.
const { createFrameXmlSpellBookTabResolvers } = await import("../dist/code/browser/framexml/FrameXmlSpellBookTabs.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];

const row = (id, name, rank, spellLevel) => [id, {
  id, name, rank, spellLevel, spellClassSet: 3, spellClassMask: [1, 0, 0], passive: false, hidden: false,
  iconPath: `Interface\\Icons\\S${id}`,
}];

function book() {
  // Fireball ranks 1-3 and one Frost Armor, all on the mage's Fire/Frost line 8 → one class tab.
  const spells = new Map([
    row(133, "Огненный шар", "Уровень 1", 1), row(143, "Огненный шар", "Уровень 2", 6),
    row(145, "Огненный шар", "Уровень 3", 12), row(168, "Морозный доспех", "Уровень 1", 1),
  ]);
  const world = { knownSpells: [133, 143, 145, 168].map((id, slot) => ({ id, slot })) };
  const talent = {
    ready: true,
    skillOfSpell: () => 8,
    skillLine: (id) => id === 8 ? { id, name: "Огонь", categoryId: 7 } : undefined,
  };
  return { spells, world, talent, resolvers: createFrameXmlSpellBookTabResolvers(() => ({ world, talent, spells })) };
}

test("the tab tuple carries the rank-folded offset and count, from the native book's chains", () => {
  const { resolvers } = book();
  const [tab] = resolvers.spellTabs();
  assert.deepEqual(tab.slice(2), [0, 4, 0, 2], "four rows, two of them the top of their chain");
  assert.equal(resolvers.spellIsLowerRank(133), true);
  assert.equal(resolvers.spellIsLowerRank(143), true);
  assert.equal(resolvers.spellIsLowerRank(145), false);
  assert.equal(resolvers.spellIsLowerRank(168), false);
});

test("GetKnownSlotFromHighestRankSlot steps over lower ranks; the book's rows are the top ranks", () => {
  const { spells, world, resolvers } = book();
  const casts = [];
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => spells.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: (id) => casts.push(id),
    spellTabs: resolvers.spellTabs, spellTabFor: resolvers.spellTabFor, spellIsLowerRank: resolvers.spellIsLowerRank,
  });
  assert.deepEqual(call(seam, "GetKnownSlotFromHighestRankSlot", 1, "spell"), [3], "Fireball rank 3 is book slot 3");
  assert.deepEqual(call(seam, "GetKnownSlotFromHighestRankSlot", 2, "spell"), [4]);
  assert.deepEqual(call(seam, "GetKnownSlotFromHighestRankSlot", 3, "spell"), [], "past the folded book: nil");
  const [slot] = call(seam, "GetKnownSlotFromHighestRankSlot", 1, "spell");
  assert.deepEqual(call(seam, "GetSpellName", slot, "spell"), ["Огненный шар", "Уровень 3"]);
  call(seam, "CastSpell", slot, "spell");
  assert.deepEqual(casts, [145]);
  // A picked-up row names the slot the book really holds it at.
  call(seam, "PickupSpell", slot, "spell");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 3, "spell"]);
});
}

// ── framexml-spellbook-seam.test.mjs
{
const {
  CannedWorldSeam,
  CANNED_ACTION_BAR,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");

function pump(now = 100) {
  const events = [];
  return {
    events,
    now: () => now,
    fire(event, ...args) {
      events.push([event, ...args]);
      return 0;
    },
  };
}

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

test("Canned SpellBook answers stock tuples from its resolved player spell list", () => {
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR);
  assert.equal(api(seam, "GetNumSpellTabs")[0], 1);
  assert.deepEqual(api(seam, "GetSpellTabInfo", 1), ["Общие", "Interface\\Icons\\Ability_Rogue_Ambush", 0, 11, 0, 11]);
  assert.deepEqual(api(seam, "GetSpellName", 1, "spell"), ["Удар героя", ""]);
  assert.equal(api(seam, "GetSpellTexture", 1, "spell")[0], "Interface\\Icons\\Ability_Rogue_Ambush");
  assert.deepEqual(api(seam, "GetSpellName", 99, "spell"), []);
  assert.deepEqual(api(seam, "GetSpellTexture", 99, "spell"), []);
  assert.deepEqual(api(seam, "GetSpellCooldown", 99, "spell"), [0, 0, 0]);
  assert.deepEqual(api(seam, "GetSpellCooldown", 1, "spell"), [0, 0, 1], "a ready spell is enabled, not dimmed");
  assert.deepEqual(api(seam, "GetSpellAutocast", 1, "spell"), [false, false]);
  assert.deepEqual(api(seam, "IsPassiveSpell", 1, "spell"), [false]);
  assert.deepEqual(api(seam, "GetKnownSlotFromHighestRankSlot", 1, "spell"), [1]);
  assert.deepEqual(api(seam, "IsSelectedSpell", 1, "spell"), [false]);
  assert.deepEqual(api(seam, "HasPetSpells"), [false]);
});

test("Canned SpellBook stays safe before spell data and coalesces unchanged state", () => {
  const seam = new CannedWorldSeam([]);
  assert.deepEqual(api(seam, "GetNumSpellTabs"), [0]);
  assert.deepEqual(api(seam, "GetSpellTabInfo", 1), []);
  assert.deepEqual(api(seam, "GetSpellName", 1, "spell"), []);
  assert.deepEqual(api(seam, "GetSpellCooldown", 1, "spell"), [0, 0, 0]);

  const worldPump = pump();
  seam.attach(worldPump);
  const seeded = worldPump.events.filter(([event]) =>
    event === FRAMEXML_SEAM_EVENTS.spellsChanged || event === FRAMEXML_SEAM_EVENTS.spellUpdateCooldown);
  assert.deepEqual(seeded.map(([event]) => event), [
    FRAMEXML_SEAM_EVENTS.spellsChanged,
    FRAMEXML_SEAM_EVENTS.spellUpdateCooldown,
  ]);
  worldPump.events.length = 0;
  seam.tick(100);
  assert.deepEqual(worldPump.events.filter(([event]) =>
    event === FRAMEXML_SEAM_EVENTS.spellsChanged || event === FRAMEXML_SEAM_EVENTS.spellUpdateCooldown), []);
  seam.detach();
});

test("CastSpell delegates the book slot once and exposes cooldown through GetSpellCooldown", () => {
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR);
  const worldPump = pump();
  seam.attach(worldPump);
  worldPump.events.length = 0;
  api(seam, "CastSpell", 1, "spell");
  api(seam, "CastSpell", 1, "spell");
  assert.deepEqual(seam.castSpellIds, [78]);
  assert.deepEqual(api(seam, "GetSpellCooldown", 1, "spell"), [100, 10, 1]);
  assert.equal(worldPump.events.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.spellUpdateCooldown).length, 1);
  assert.deepEqual(api(seam, "GetCVarBool", "showAllSpellRanks"), [false]);
  api(seam, "SetCVar", "showAllSpellRanks", "1");
  assert.deepEqual(api(seam, "GetCVarBool", "showAllSpellRanks"), [true]);
  api(seam, "SetCVar", "showAllSpellRanks", "0");
  assert.deepEqual(api(seam, "GetCVarBool", "showAllSpellRanks"), [false]);
  seam.detach();
});

test("Live SpellBook reads WorldClient state, converts cooldown clocks, and emits one edge per change", () => {
  class Events {
    listeners = new Map();
    on(name, listener) {
      const list = this.listeners.get(name) ?? new Set();
      list.add(listener);
      this.listeners.set(name, list);
      return () => list.delete(listener);
    }
    emit(name, payload) {
      for (const listener of [...(this.listeners.get(name) ?? [])]) listener(payload);
    }
  }
  const selfGuid = 0x10n;
  const events = new Events();
  const metadata = new Map([[133, {
    id: 133, name: "Огненный шар", rank: "Уровень 1",
    iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", hidden: false, passive: false,
  }]]);
  const world = {
    knownSpells: [{ id: 133, slot: 0 }],
    cooldownSnapshots: new Map(),
    cooldowns: new Map(),
    // 3.39 (12.10): GetSpellCooldown reads WorldClient.cooldownState/cooldownRemaining (the own timer or the
    // category part), as GetActionCooldown does; this double has the own timers alone.
    cooldownState: (id) => {
      const snapshot = world.cooldownSnapshots.get(id);
      return snapshot && snapshot.endsAt > monotonic ? snapshot : undefined;
    },
    cooldownRemaining: (id, now) => Math.max(0, (world.cooldownSnapshots.get(id)?.endsAt ?? 0) - now),
    actionButtons: [], casts: new Map(),
    state: { selfGuid, objects: new Map() },
    events,
    onGroupChanged: undefined,
    worldStateContext: undefined,
    mapId: undefined,
  };
  const fired = [];
  let monotonic = 1000;
  const castIds = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => metadata.get(id),
    monotonic: () => monotonic,
    globalCooldownUntil: () => 0,
    castSpell: (id) => castIds.push(id),
  });
  const pump = {
    now: () => 200,
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
  };
  seam.attach(pump);
  fired.length = 0;
  seam.tick(0);
  assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.spellsChanged).length, 1);
  fired.length = 0;
  seam.tick(0.01);
  assert.equal(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.spellsChanged), false);
  // A ready spell is enabled: SpellButton_UpdateButton dims the icon to 0.4 whenever `enable ~= 1`.
  assert.deepEqual(api(seam, "GetSpellCooldown", 1, "spell"), [0, 0, 1]);
  assert.deepEqual(api(seam, "GetSpellCooldown", 2, "spell"), [0, 0, 0], "an empty book slot has nothing to enable");

  world.cooldownSnapshots.set(133, { startedAt: 900, duration: 1500, endsAt: 2400 });
  monotonic = 1000;
  fired.length = 0;
  seam.tick(0.1);
  assert.equal(fired.filter(([event]) => event === FRAMEXML_SEAM_EVENTS.spellUpdateCooldown).length, 1);
  assert.deepEqual(api(seam, "GetSpellCooldown", 1, "spell"), [199.9, 1.5, 1]);
  fired.length = 0;
  seam.tick(0.11);
  assert.equal(fired.some(([event]) => event === FRAMEXML_SEAM_EVENTS.spellUpdateCooldown), false);

  api(seam, "CastSpell", 1, "spell");
  assert.deepEqual(castIds, [133]);
  seam.detach();
});

test("Live SpellBook remains compatible with older world doubles without spell collections", () => {
  class Events {
    on() { return () => {}; }
  }
  const world = {
    state: { selfGuid: undefined, objects: new Map() },
    actionButtons: [],
    casts: new Map(),
    events: new Events(),
    onGroupChanged: undefined,
    mapId: undefined,
    worldStateContext: undefined,
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => undefined,
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  seam.attach({ now: () => 1, fire: () => 0 });
  assert.doesNotThrow(() => seam.tick(0));
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNumSpellTabs(seam, []), [0]);
  seam.detach();
});
}

// ── framexml-spellbook-tabs.test.mjs
{
const { createFrameXmlSpellBookTabResolvers } = await import(
  "../dist/code/browser/framexml/FrameXmlSpellBookTabs.js",
);

test("spellbook tabs reappear when metadata arrives after an authoritative empty snapshot", () => {
  const spells = new Map();
  const world = { knownSpells: [{ id: 133, slot: 0 }] };
  const talent = {
    ready: true,
    skillOfSpell: (id) => id === 133 ? 183 : undefined,
    skillLine: () => undefined,
  };
  const resolvers = createFrameXmlSpellBookTabResolvers(() => ({ world, talent, spells }));

  assert.deepEqual(resolvers.spellTabs(), [], "missing metadata must not fabricate a tab");
  assert.equal(resolvers.spellTabFor(133), undefined);

  spells.set(133, {
    id: 133,
    name: "Огненный шар",
    rank: "Уровень 1",
    iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt",
    hidden: false,
  });
  // The General tab is the client's own: `GENERAL_SPELLS` for its name and the book picture,
  // whatever the first spell in it looks like (SpellBookFrame draws `GetSpellTabInfo`'s texture).
  assert.deepEqual(resolvers.spellTabs(), [[
    "Общие", "Interface\\Icons\\INV_Misc_Book_09", 0, 1, 0, 1,
  ]]);
  assert.equal(resolvers.spellTabFor(133), 1);
});

test("a learned recipe (SPELL_ATTR0_TRADESPELL) stays out of the book, as in the client", () => {
  // The owner's realm: a custom cooking-style recipe row, «QA Test +2000 Spell Power Ring»
  // (98379, attributes 0x10030), was drawn in the General tab above the character's spells.
  // Conjure Water creates an item too and is not a trade spell: it keeps its place.
  const spells = new Map([
    [98379, { id: 98379, name: "QA Test +2000 Spell Power Ring", rank: "", iconPath: "Interface\\Icons\\INV_Jewelry_Ring_01", hidden: false, tradeSkill: true, effects: [24, 0, 0] }],
    [5504, { id: 5504, name: "Наколдовать воду", rank: "Уровень 1", iconPath: "Interface\\Icons\\INV_Drink_06", hidden: false, tradeSkill: false, effects: [24, 0, 0] }],
    [133, { id: 133, name: "Огненный шар", rank: "Уровень 1", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", hidden: false }],
  ]);
  const world = { knownSpells: [{ id: 98379, slot: 0 }, { id: 5504, slot: 1 }, { id: 133, slot: 2 }] };
  const talent = {
    ready: true,
    skillOfSpell: () => 183,
    skillLine: () => undefined,
  };
  const resolvers = createFrameXmlSpellBookTabResolvers(() => ({ world, talent, spells }));
  assert.deepEqual(resolvers.spellTabs(), [[
    "Общие", "Interface\\Icons\\INV_Misc_Book_09", 0, 2, 0, 2,
  ]], "the recipe is neither counted nor offset; the two real spells remain");
  assert.equal(resolvers.spellTabFor(98379), undefined, "no tab holds the recipe");
  assert.equal(resolvers.spellTabFor(5504), 1, "an item-creating class spell is still in its tab");
  assert.equal(resolvers.spellIsLowerRank(98379), false);
});
}
