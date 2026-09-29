import assert from "node:assert/strict";
import test from "node:test";

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
