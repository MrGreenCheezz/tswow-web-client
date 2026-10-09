import assert from "node:assert/strict";
import test from "node:test";

const { EventBus } = await import("../dist/code/world/EventBus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { AURA_FLAGS } = await import("../dist/code/world/AuraProtocol.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam, CANNED_PET, CANNED_PET_AURA_FIXTURES } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_POWER_EVENTS,
  FRAMEXML_POWER_MAX_EVENTS,
  FRAMEXML_SEAM_BINDINGS,
  FRAMEXML_SEAM_EVENTS,
} = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function object(guid, typeId) {
  return {
    guid,
    typeId,
    position: undefined,
    movementFlags: 0,
    updateFlags: 0,
    targetGuid: undefined,
    runSpeed: undefined,
    turnRate: undefined,
    motion: undefined,
    glide: undefined,
    transport: undefined,
    speeds: undefined,
    transportTime: undefined,
    fields: new Map(),
  };
}

function set(objectState, name, value) {
  objectState.fields.set(UPDATE_FIELDS[name].offset, value);
}

function fixture() {
  const selfGuid = 0x10n;
  const petGuid = 0x20n;
  const state = new WorldState();
  const store = new WorldStore(state);
  const self = object(selfGuid, 4);
  const pet = object(petGuid, 3);
  set(self, "UNIT_FIELD_HEALTH", 4000);
  set(self, "UNIT_FIELD_MAXHEALTH", 5000);
  set(self, "UNIT_FIELD_BYTES_0", 1 | (8 << 8) | (0 << 16) | (1 << 24));
  set(pet, "OBJECT_FIELD_ENTRY", 9002);
  set(pet, "UNIT_FIELD_LEVEL", 60);
  set(pet, "UNIT_FIELD_HEALTH", 700);
  set(pet, "UNIT_FIELD_MAXHEALTH", 1000);
  set(pet, "UNIT_FIELD_BYTES_0", 1 | (3 << 24));
  pet.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 80);
  pet.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + 3, 100);
  state.objects.set(selfGuid, self);
  state.objects.set(petGuid, pet);
  state.selfGuid = selfGuid;
  store.flush();

  const events = new EventBus();
  const petAura = {
    slot: 1,
    spellId: 6673,
    flags: AURA_FLAGS.positive,
    casterLevel: 60,
    applications: 1,
    casterGuid: selfGuid,
    maxDuration: 30_000,
    duration: 20_000,
    expiresAt: 21_500,
  };
  const auras = new Map([[petGuid, [petAura]]]);
  const world = {
    state,
    targetGuid: undefined,
    petSpells: { guid: petGuid },
    names: new Map(),
    creatureTemplates: new Map([[9002, {
      entry: 9002, found: true, name: "Боевой питомец", subName: "", cursorName: "",
      flags: 0, creatureType: 1, creatureFamily: 1, classification: 0, proxyCreatureIds: [],
      displayIds: [], healthModifier: 1, powerModifier: 1, leader: false, questItems: [], movementId: 0,
    }]]),
    casts: new Map([[petGuid, {
      spellId: 42, startedAt: 900, duration: 2_500, channel: false, castCount: 7,
    }]]),
    aurasFor: (guid) => auras.get(guid) ?? [],
    events,
    actionButtons: [],
    cooldownState: () => undefined,
    cooldownRemaining: () => 0,
    isActiveMountSpell: () => false,
    selected: [],
    selectTarget(guid) {
      this.selected.push(guid);
    },
  };
  const fired = [];
  const pump = {
    now: () => 123.456,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: (id) => ({
      id,
      name: id === 6673 ? "Боевой крик" : "Test Spell",
      rank: id === 6673 ? "Уровень 1" : "Rank 2",
      iconPath: id === 6673
        ? "Interface\\Icons\\Ability_Warrior_BattleShout"
        : "Interface\\Icons\\Spell_Test",
    }),
    monotonic: () => 1_000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  return { seam, world, state, store, events, fired, pump, petGuid, selfGuid };
}

test("live PetFrame queries use petSpells.guid without aliasing player", () => {
  const { seam, world, fired, pump, petGuid, selfGuid } = fixture();
  seam.attach(pump);
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("UnitExists", "pet"), [true]);
  assert.deepEqual(call("UnitName", "pet"), ["Боевой питомец"]);
  assert.deepEqual(call("UnitLevel", "pet"), [60]);
  assert.deepEqual(call("UnitHealth", "pet"), [700]);
  assert.deepEqual(call("UnitHealthMax", "pet"), [1000]);
  assert.deepEqual(call("UnitPowerType", "pet"), [3, "ENERGY"]);
  assert.deepEqual(call("UnitPower", "pet"), [80]);
  assert.deepEqual(call("UnitPowerMax", "pet"), [100]);
  assert.deepEqual(call("UnitIsVisible", "pet"), [true]);
  assert.deepEqual(call("UnitAura", "pet", 1, "HELPFUL"), [
    "Боевой крик", "Уровень 1", "Interface\\Icons\\Ability_Warrior_BattleShout", 1, undefined,
    30, 123.456 + (21_500 - 1_000) / 1_000, "player", false, false, 6673,
  ]);
  assert.deepEqual(call("UnitBuff", "pet", 1), call("UnitAura", "pet", 1, "HELPFUL"));
  assert.deepEqual(call("UnitDebuff", "pet", 1), []);
  assert.deepEqual(call("UnitCastingInfo", "pet"), [
    "Test Spell", "Rank 2", "Test Spell", "Interface\\Icons\\Spell_Test",
    123_356, 125_856, false, 7, false,
  ]);
  assert.deepEqual(call("UnitChannelInfo", "pet"), []);
  assert.deepEqual(call("UnitIsPossessed", "pet"), [false]);
  // 3.36 (L14): a mage's pet without a pet number is no hunter's pet — nil, 100 as Wow.exe 0x005d3b00.
  assert.deepEqual(call("GetPetHappiness"), [undefined, 100]);
  // L15 5.05: Wow.exe 0x005d3960 — no pet number, no pet page: both values nil (false here).
  assert.deepEqual(call("HasPetUI"), [false, false]);
  assert.deepEqual(call("UnitHealth", "player"), [4000], "player remains independent");

  call("TargetUnit", "pet");
  assert.deepEqual(world.selected, [petGuid]);
  world.selected.length = 0;
  call("TargetUnit", "player");
  assert.deepEqual(world.selected, [selfGuid]);
  world.selected.length = 0;
  call("TargetUnit", "unknown");
  assert.deepEqual(world.selected, [], "unsupported unit tokens do not select arbitrary objects");
  seam.detach();
});

test("live PetFrame publishes pet identity, fields, aura and cast edges only while pet is current", () => {
  const { seam, world, state, store, events, fired, pump, petGuid, selfGuid } = fixture();
  seam.attach(pump);
  fired.length = 0;

  events.emit("PET_BAR_CHANGED", { guid: petGuid });
  // PET_BAR_UPDATE is the bar packet's own edge (FrameXmlPetActionBarLive.ts), for PetActionBarFrame,
  // PetPaperDollFrame and the pet spellbook; UNIT_PET is the pet unit's.
  assert.deepEqual(fired, [["PET_BAR_UPDATE"], ["UNIT_PET", "player"]]);

  fired.length = 0;
  state.setField(petGuid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 600);
  store.flush();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.health, "pet"]]);

  fired.length = 0;
  events.emit("AURA_CHANGED", { guid: petGuid });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.aura, "pet"]]);

  fired.length = 0;
  events.emit("SPELL_CAST_START", { casterGuid: petGuid, spellId: 42, castTime: 2_500, channel: false });
  // 11.02-IF-review (03.10): the combat log (3.01) logs this start as well, as Wow.exe does — its
  // SMSG_SPELL_START handler 0x00806700 (0x0080fee0 dispatches opcode 0x131 to it) posts SPELL_CAST_START
  // (0x00751920: entry 5, then 0x0074ff20 -> 0x0074f910: COMBAT_LOG_EVENT and _UNFILTERED) for a cast
  // without CAST_FLAG_PENDING, whoever the caster. This test is about PetFrame's own edge beside it.
  // 3.01-castlog (03.10): the log hears the packet — WorldClient's SPELL_START, emitted after the cast
  // bar's SPELL_CAST_START as 0x00806700 calls 0x00805330 (UNIT_SPELLCAST_START) before 0x00751920 — and
  // writes the START because the cast is timed (virtual +0x148, FrameXmlCombatLogCasts.ts).
  events.emit("SPELL_START", {
    casterGuid: petGuid, casterUnit: petGuid, castId: 7, spellId: 42, castFlags: 0x2, castTime: 2_500,
    schoolImmunityMask: 0, mechanicImmunityMask: 0,
  });
  const combatLog = ([event]) => event === "COMBAT_LOG_EVENT" || event === "COMBAT_LOG_EVENT_UNFILTERED";
  assert.deepEqual(fired.map((entry) => (combatLog(entry) ? [entry[0], entry[2], entry[3]] : entry)), [
    [FRAMEXML_SEAM_EVENTS.castStart, "pet", "Test Spell", "Rank 2", 7],
    ["COMBAT_LOG_EVENT", "SPELL_CAST_START", "0x0000000000000020"],
    ["COMBAT_LOG_EVENT_UNFILTERED", "SPELL_CAST_START", "0x0000000000000020"],
  ]);

  fired.length = 0;
  world.casts.delete(petGuid);
  events.emit("SPELL_CAST_STOP", {
    casterGuid: petGuid, spellId: 42, interrupted: false, reason: "success",
  });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.castStop, "pet", "Test Spell", "Rank 2", 7]]);

  // Once the pet bar names a new GUID, delayed/stop/aura edges from the old pet are stale.
  const nextPetGuid = 0x30n;
  world.petSpells = { guid: nextPetGuid };
  world.casts.set(petGuid, { spellId: 42, startedAt: 900, duration: 2_500, channel: false, castCount: 8 });
  events.emit("PET_BAR_CHANGED", { guid: nextPetGuid });
  fired.length = 0;
  events.emit("SPELL_CAST_DELAYED", { casterGuid: petGuid, delay: 125 });
  events.emit("SPELL_CAST_STOP", { casterGuid: petGuid, spellId: 42, interrupted: true, reason: "interrupted" });
  events.emit("AURA_CHANGED", { guid: petGuid });
  assert.deepEqual(fired, []);

  world.petSpells = undefined;
  events.emit("PET_BAR_CHANGED", { guid: 0n });
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitExists(seam, ["pet"]), [false]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.UnitHealth(seam, ["pet"]), [0]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.TargetUnit(seam, ["player"]), [], "player target token is safe");
  seam.detach();
});

// L15 5.05: HasPetUI as Wow.exe 0x005d3960 → 0x0071b630 answers it (.runtime/re-2026-10-04/l14-small/g1.c,
// g2.c): a pet number gives the pet page; the hunter's flag is the creator's class, not the abandon byte.
test("L15 5.05: HasPetUI reads the pet number and the creator's class", async () => {
  const { seam, state, petGuid, selfGuid } = fixture();
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  const pet = state.objects.get(petGuid);
  const self = state.objects.get(selfGuid);
  set(pet, "UNIT_FIELD_PETNUMBER", 7);
  assert.deepEqual(call("HasPetUI"), [true, false], "a pet number and no creator: a pet page, no hunter's");
  set(pet, "UNIT_FIELD_CREATEDBY", Number(selfGuid));
  assert.deepEqual(call("HasPetUI"), [true, false], "created by a mage (a water elemental, a demon)");
  set(self, "UNIT_FIELD_BYTES_0", 1 | (3 << 8) | (1 << 24));
  assert.deepEqual(call("HasPetUI"), [true, true], "created by a hunter");
  // The abandon byte is not what decides it (0x0071b630 never reads UNIT_FIELD_BYTES_2).
  set(pet, "UNIT_FIELD_BYTES_2", 0);
  assert.deepEqual(call("HasPetUI"), [true, true], "no UNIT_CAN_BE_ABANDONED, still the hunter's pet");
  set(pet, "UNIT_FIELD_PETNUMBER", 0);
  assert.deepEqual(call("HasPetUI"), [false, false], "a charmed creature has no pet number");
  const { frameXmlIsHunterPet } = await import("../dist/code/browser/framexml/FrameXmlHasPetUI.js");
  assert.equal(frameXmlIsHunterPet(pet, (guid) => state.objects.get(guid)), false, "0x0071b630 wants the pet number too");
  set(pet, "UNIT_FIELD_PETNUMBER", 7);
  pet.typeId = 4;
  assert.deepEqual(call("HasPetUI"), [false, false], "a player under the pet bar (a possessed one) is not a pet (0x005d3960)");
  pet.typeId = 3;
  state.objects.delete(selfGuid);
  assert.deepEqual(call("HasPetUI"), [true, false], "the creator out of view is no hunter (0x004d4db0 finds nothing)");
});

test("L15 3.36: the canned happy hunter's pet deals 125 % (PetPersonality row 1, Wow.exe 0x005d3b00)", () => {
  const seam = new CannedWorldSeam();
  assert.equal(CANNED_PET.happiness, 3);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetPetHappiness(seam, []), [3, 125]);
});

test("canned PetFrame exposes a bounded pet fixture and stock API shapes", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({
    now: () => 100,
    fire: (event, ...args) => {
      fired.push([event, ...args]);
      return 1;
    },
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

  assert.deepEqual(call("UnitExists", "pet"), [true]);
  assert.deepEqual(call("UnitName", "pet"), [CANNED_PET.name]);
  assert.deepEqual(call("UnitHealth", "pet"), [CANNED_PET.health]);
  assert.deepEqual(call("UnitHealthMax", "pet"), [CANNED_PET.healthMax]);
  assert.deepEqual(call("UnitPowerType", "pet"), [CANNED_PET.powerType, "ENERGY"]);
  assert.deepEqual(call("UnitPower", "pet"), [CANNED_PET.power]);
  assert.deepEqual(call("UnitPowerMax", "pet"), [CANNED_PET.powerMax]);
  assert.deepEqual(call("UnitIsVisible", "pet"), [true]);
  assert.deepEqual(call("UnitIsPossessed", "pet"), [false]);
  assert.deepEqual(call("GetPetHappiness"), [CANNED_PET.happiness, CANNED_PET.happinessDamage]);
  assert.deepEqual(call("HasPetUI"), [true, CANNED_PET.isHunterPet]);
  assert.deepEqual(call("UnitBuff", "pet", 1), [
    CANNED_PET_AURA_FIXTURES.helpful.name, CANNED_PET_AURA_FIXTURES.helpful.rank,
    CANNED_PET_AURA_FIXTURES.helpful.texture, CANNED_PET_AURA_FIXTURES.helpful.count,
    undefined, CANNED_PET_AURA_FIXTURES.helpful.duration, 120,
    "player", false, false, CANNED_PET_AURA_FIXTURES.helpful.spellId,
  ]);
  assert.deepEqual(call("UnitDebuff", "pet", 1), [
    CANNED_PET_AURA_FIXTURES.harmful.name, CANNED_PET_AURA_FIXTURES.harmful.rank,
    CANNED_PET_AURA_FIXTURES.harmful.texture, CANNED_PET_AURA_FIXTURES.harmful.count,
    undefined, CANNED_PET_AURA_FIXTURES.harmful.duration, 108,
    "player", false, false, CANNED_PET_AURA_FIXTURES.harmful.spellId,
  ]);
  assert.deepEqual(call("UnitCastingInfo", "pet"), []);
  assert.deepEqual(call("UnitChannelInfo", "pet"), []);
  assert.ok(fired.some(([event, unit]) => event === FRAMEXML_SEAM_EVENTS.petChanged && unit === "player"));
  seam.detach();
});
