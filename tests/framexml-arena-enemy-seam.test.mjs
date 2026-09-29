import assert from "node:assert/strict";
import test from "node:test";

// The enemy arena team behind `arenaN`/`arenapetN` (FrameXmlArena.ts) over the live seam: only a
// running arena match (SMSG_BATTLEFIELD_STATUS), only players whose PLAYER_BYTES_3 arena-faction byte
// differs from the player's own, slots in the order they come into sight, «seen»/«unseen»/«cleared»,
// UNIT_PET, the UnitFrame field edges, the cast bar, and the C API Blizzard_ArenaUI reads.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { frameXmlArenaToken } = await import("../dist/code/browser/framexml/FrameXmlArena.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
  count(name) { return this.#listeners.get(name)?.size ?? 0; }
}

const IN_PROGRESS = 3;
const HORDE_TEAM = 0;
const ALLIANCE_TEAM = 1;

function unit(guid, typeId, fields = {}) {
  const object = { guid, typeId, fields: new Map() };
  for (const [name, value] of Object.entries(fields)) object.fields.set(UPDATE_FIELDS[name].offset, value);
  return object;
}

function setGuid(object, name, guid) {
  object.fields.set(UPDATE_FIELDS[name].offset, Number(guid & 0xffffffffn));
  object.fields.set(UPDATE_FIELDS[name].offset + 1, Number(guid >> 32n));
}

/** class, power type in UNIT_FIELD_BYTES_0 (race 1, class byte 1, gender 2, power 3). */
const bytes0 = (classId, powerType) => (1 | (classId << 8) | (powerType << 24)) >>> 0;

function fixture() {
  const selfGuid = 0x10n;
  // The player is on the Alliance team (SetBGTeam: 1); a teammate the same; the Horde team's words
  // carry byte 3 = 0, which a create block leaves out altogether.
  const self = unit(selfGuid, 4, { PLAYER_BYTES_3: ALLIANCE_TEAM << 24, UNIT_FIELD_BYTES_0: bytes0(1, 1) });
  const mate = unit(0x11n, 4, { PLAYER_BYTES_3: ALLIANCE_TEAM << 24, UNIT_FIELD_BYTES_0: bytes0(5, 0) });
  const rogue = unit(0x32n, 4, {
    UNIT_FIELD_BYTES_0: bytes0(4, 3), UNIT_FIELD_HEALTH: 9000, UNIT_FIELD_MAXHEALTH: 10000,
  });
  rogue.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 80);
  rogue.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset + 3, 100);
  const hunter = unit(0x31n, 4, {
    PLAYER_BYTES_3: (HORDE_TEAM << 24) | 1, UNIT_FIELD_BYTES_0: bytes0(3, 0),
    UNIT_FIELD_HEALTH: 7000, UNIT_FIELD_MAXHEALTH: 8000,
  });
  hunter.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 5000);
  hunter.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset, 6000);
  const wolf = unit(0xf1300000000009a1n, 3, { UNIT_FIELD_HEALTH: 3000, UNIT_FIELD_MAXHEALTH: 3000, UNIT_FIELD_BYTES_0: bytes0(1, 2) });
  setGuid(wolf, "UNIT_FIELD_SUMMONEDBY", hunter.guid);
  setGuid(hunter, "UNIT_FIELD_SUMMON", wolf.guid);
  const objects = new Map([[selfGuid, self], [mate.guid, mate]]);
  const events = new FakeEvents();
  const world = {
    state: { selfGuid, objects },
    battlefieldQueues: new Map(),
    names: new Map([[rogue.guid, "Тень"], [hunter.guid, "Ловчий"], [mate.guid, "Друг"]]),
    casts: new Map(),
    events,
    group: undefined,
    partyStats: new Map(),
    creatureTemplates: new Map(),
  };
  const fired = [];
  const pump = { now: () => 100, fire: (event, ...args) => { fired.push([event, ...args]); return 1; } };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, monotonic: () => 5_000,
    spell: (id) => (id === 2139 ? { id, name: "Антимагия", rank: "", iconPath: "Interface\\Icons\\Spell_Frost_IceShock" } : undefined),
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.attach(pump);
  const arenaEvents = () => fired.filter(([event]) => event === "ARENA_OPPONENT_UPDATE" || event === "UNIT_PET"
    || /^UNIT_(HEALTH|MAXHEALTH|MANA|MAXMANA|ENERGY|MAXENERGY|FOCUS|NAME_UPDATE|DISPLAYPOWER|SPELLCAST_)/.test(event));
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  const enterArena = () => world.battlefieldQueues.set(0, {
    queueSlot: 0, status: IN_PROGRESS, isArena: true, cleared: false, clientInstanceId: 7, mapId: 559, arenaType: 2,
  });
  return { seam, world, objects, events, fired, pump, call, arenaEvents, enterArena, rogue, hunter, wolf, mate };
}

test("the token parser takes arena1-5 and arenapet1-5 and nothing else", () => {
  assert.deepEqual(frameXmlArenaToken("arena1"), [1, false]);
  assert.deepEqual(frameXmlArenaToken("ARENAPET5"), [5, true]);
  for (const other of ["arena0", "arena6", "arena1target", "arenapet", "party1", "raid1"]) {
    assert.equal(frameXmlArenaToken(other), undefined, other);
  }
});

test("outside a running arena nothing is an opponent, IsInInstance keeps the neutral answer", () => {
  const { seam, objects, world, call, arenaEvents, rogue } = fixture();
  objects.set(rogue.guid, rogue);
  seam.arena.tick();
  assert.deepEqual(call("GetNumArenaOpponents"), [0]);
  assert.deepEqual(call("IsInInstance"), [false, "none"]);
  assert.deepEqual(call("UnitExists", "arena1"), [false]);
  assert.deepEqual(call("UnitGUID", "arena1"), []);
  // A queued (not yet running) arena is not an arena either.
  world.battlefieldQueues.set(0, { queueSlot: 0, status: 1, isArena: true, cleared: false });
  seam.arena.tick();
  assert.deepEqual(call("IsInInstance"), [false, "none"]);
  assert.deepEqual(arenaEvents(), []);
});

test("opponents take slots as they come into sight; teammates never do; the unit API answers them", () => {
  const { seam, objects, call, fired, arenaEvents, enterArena, rogue, hunter, wolf } = fixture();
  let entered = 0;
  seam.arena.onEnter = () => { entered += 1; };
  enterArena();
  seam.arena.tick();
  assert.equal(entered, 1, "the match edge");
  assert.deepEqual(call("IsInInstance"), [true, "arena"]);
  assert.deepEqual(call("GetNumArenaOpponents"), [0], "no one in sight yet");

  // Both come into sight in one update: slots by GUID, so the hunter (0x31) is arena1.
  objects.set(rogue.guid, rogue);
  objects.set(hunter.guid, hunter);
  objects.set(wolf.guid, wolf);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [
    ["ARENA_OPPONENT_UPDATE", "arena1", "seen"],
    ["UNIT_PET", "arena1"],
    ["ARENA_OPPONENT_UPDATE", "arenapet1", "seen"],
    ["ARENA_OPPONENT_UPDATE", "arena2", "seen"],
  ]);
  assert.deepEqual(call("GetNumArenaOpponents"), [2]);
  assert.deepEqual(call("UnitExists", "arena1"), [true]);
  assert.deepEqual(call("UnitName", "arena1"), ["Ловчий"]);
  assert.deepEqual(call("UnitClass", "arena1").slice(1), ["HUNTER"]);
  assert.deepEqual(call("UnitClass", "arena2").slice(1), ["ROGUE"]);
  assert.deepEqual(call("UnitHealth", "arena2"), [9000]);
  assert.deepEqual(call("UnitHealthMax", "arena2"), [10000]);
  assert.deepEqual(call("UnitPowerType", "arena2"), [3, "ENERGY"]);
  assert.deepEqual(call("UnitPower", "arena2"), [80]);
  assert.deepEqual(call("UnitExists", "arenapet1"), [true]);
  assert.deepEqual(call("UnitHealth", "arenapet1"), [3000]);
  assert.deepEqual(call("UnitExists", "arenapet2"), [false], "the rogue has no pet");
  assert.deepEqual(call("UnitIsUnit", "arena2", "arena2"), [true]);
  assert.deepEqual(call("UnitIsUnit", "arena1", "arena2"), [false]);
  assert.equal(typeof call("UnitGUID", "arena2")[0], "string");
  assert.notEqual(call("UnitGUID", "arena1")[0], call("UnitGUID", "arena2")[0]);
  assert.deepEqual(call("UnitExists", "arena3"), [false]);
  assert.equal(seam.arena.unitFor(0x11n), undefined, "the teammate has no arena slot");

  // Field edges for the frames' bars: health, then power in the unit's own power event.
  fired.length = 0;
  rogue.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 4000);
  rogue.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset + 3, 20);
  hunter.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset, 6500);
  wolf.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [
    ["UNIT_MAXMANA", "arena1"],
    ["UNIT_HEALTH", "arenapet1"],
    ["UNIT_HEALTH", "arena2"],
    ["UNIT_ENERGY", "arena2"],
  ]);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [], "nothing moved, nothing fires");
});

test("out of sight is «unseen» with the GUID, class and name kept; back in sight is «seen»; leaving clears", () => {
  const { seam, objects, world, call, fired, arenaEvents, enterArena, rogue, hunter, wolf } = fixture();
  enterArena();
  objects.set(hunter.guid, hunter);
  objects.set(wolf.guid, wolf);
  seam.arena.tick();
  objects.set(rogue.guid, rogue);
  seam.arena.tick();
  const rogueGuid = call("UnitGUID", "arena2")[0];

  // The rogue stealths: SMSG_DESTROY_OBJECT / out-of-range. Its slot stays.
  objects.delete(rogue.guid);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [["ARENA_OPPONENT_UPDATE", "arena2", "unseen"]]);
  assert.deepEqual(call("UnitExists", "arena2"), [false]);
  assert.deepEqual(call("UnitGUID", "arena2"), [rogueGuid]);
  assert.deepEqual(call("UnitClass", "arena2").slice(1), ["ROGUE"]);
  assert.deepEqual(call("UnitName", "arena2"), ["Тень"]);
  assert.deepEqual(call("GetNumArenaOpponents"), [2]);

  // The hunter's pet dies and is removed; the owner's SUMMON goes to 0 → UNIT_PET, no pet GUID.
  objects.delete(wolf.guid);
  hunter.fields.delete(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset);
  hunter.fields.delete(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset + 1);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [["UNIT_PET", "arena1"]]);
  assert.deepEqual(call("UnitGUID", "arenapet1"), []);

  // The rogue opens from stealth: the same slot.
  objects.set(rogue.guid, rogue);
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [["ARENA_OPPONENT_UPDATE", "arena2", "seen"]]);
  assert.deepEqual(call("UnitGUID", "arena2"), [rogueGuid]);

  // The match ends and the player ports out: every slot «cleared», nothing answers any more.
  world.battlefieldQueues.clear();
  fired.length = 0;
  seam.arena.tick();
  assert.deepEqual(arenaEvents(), [
    ["ARENA_OPPONENT_UPDATE", "arena1", "cleared"],
    ["ARENA_OPPONENT_UPDATE", "arena2", "cleared"],
  ]);
  assert.deepEqual(call("GetNumArenaOpponents"), [0]);
  assert.deepEqual(call("UnitGUID", "arena2"), []);
  assert.deepEqual(call("IsInInstance"), [false, "none"]);
});

test("a pet in sight whose owner is not yet seen is found by UNIT_FIELD_SUMMONEDBY", () => {
  const { seam, objects, call, arenaEvents, enterArena, hunter, wolf } = fixture();
  // The owner's SUMMON is not in its words here: only the wolf's own field can name it.
  hunter.fields.delete(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset);
  hunter.fields.delete(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset + 1);
  enterArena();
  objects.set(hunter.guid, hunter);
  seam.arena.tick();
  objects.delete(hunter.guid);
  seam.arena.tick();
  assert.deepEqual(call("UnitGUID", "arenapet1"), []);
  objects.set(wolf.guid, wolf);
  seam.arena.tick();
  assert.deepEqual(call("UnitExists", "arenapet1"), [true]);
  assert.deepEqual(arenaEvents().slice(-2), [["UNIT_PET", "arena1"], ["ARENA_OPPONENT_UPDATE", "arenapet1", "seen"]]);
});

test("an opponent's cast reaches its cast bar: UNIT_SPELLCAST_* for arenaN and UnitCastingInfo", () => {
  const { seam, objects, world, events, fired, call, enterArena, rogue } = fixture();
  enterArena();
  objects.set(rogue.guid, rogue);
  seam.arena.tick();
  world.casts.set(rogue.guid, { spellId: 2139, startedAt: 4_000, duration: 1_500, channel: false, castCount: 9 });
  fired.length = 0;
  events.emit("SPELL_CAST_START", { casterGuid: rogue.guid, spellId: 2139, castTime: 1_500, channel: false });
  assert.deepEqual(fired, [["UNIT_SPELLCAST_START", "arena1", "Антимагия", "", 9]]);
  // pump.now() 100 s, monotonic 5000 ms, started at 4000 ms: GetTime()-based start 99 000 ms.
  assert.deepEqual(call("UnitCastingInfo", "arena1"),
    ["Антимагия", "", "Антимагия", "Interface\\Icons\\Spell_Frost_IceShock", 99_000, 100_500, false, 9, false]);
  assert.deepEqual(call("UnitChannelInfo", "arena1"), []);
  fired.length = 0;
  events.emit("SPELL_CAST_DELAYED", { casterGuid: rogue.guid, delay: 200 });
  world.casts.delete(rogue.guid);
  events.emit("SPELL_CAST_STOP", { casterGuid: rogue.guid, spellId: 2139, interrupted: true, reason: "interrupted" });
  assert.deepEqual(fired, [
    ["UNIT_SPELLCAST_DELAYED", "arena1", "Антимагия", "", 9],
    ["UNIT_SPELLCAST_INTERRUPTED", "arena1", "Антимагия", "", 9],
  ]);
  // A caster that is not an opponent in sight fires nothing for arena frames.
  fired.length = 0;
  events.emit("SPELL_CAST_START", { casterGuid: 0x11n, spellId: 2139, castTime: 1_500, channel: false });
  assert.deepEqual(fired.filter(([, unitToken]) => typeof unitToken === "string" && unitToken.startsWith("arena")), []);
  // Detach releases the subscriptions.
  const before = events.count("SPELL_CAST_START");
  seam.detach();
  assert.ok(events.count("SPELL_CAST_START") < before);
});

test("a sixth enemy in sight takes no slot: MAX_ARENA_ENEMIES is five", () => {
  const { seam, objects, call, enterArena } = fixture();
  enterArena();
  for (let index = 0; index < 6; index += 1) objects.set(0x40n + BigInt(index), unit(0x40n + BigInt(index), 4, {}));
  seam.arena.tick();
  assert.deepEqual(call("GetNumArenaOpponents"), [5]);
  assert.equal(seam.arena.unitFor(0x45n), undefined);
  assert.equal(seam.arena.unitFor(0x40n), "arena1");
});
