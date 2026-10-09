import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameXmlCombatLogBuffer, FRAMEXML_COMBAT_LOG_BINDINGS, frameXmlCombatLogFlagsMatch,
} from "../dist/code/browser/framexml/FrameXmlCombatLog.js";
import { FrameXmlCombatLogLive } from "../dist/code/browser/framexml/FrameXmlCombatLogLive.js";
import { CL } from "../dist/code/world/CombatEventModel.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

// 3.01 slices B and E: the buffer's cursor and filters (Wow.exe 0x0074fa70, 0x0074fae0, 0x0074fc20,
// 0x0074ff70, 0x0074e1a0, 0x0074d600), the flags (0x0074dcb0) and the firing order (0x0074f910).

const ME = 0x10n;
const PARTY = 0x21n;
const MOB = 0xf130000000000abcn;
const PET = 0xf140000000000defn;

function filled(buffer, event, source, dest, sourceFlags, destFlags, time) {
  const entry = buffer.next();
  Object.assign(entry, { event, source, dest, sourceFlags, destFlags, time, spellId: 0 });
  buffer.push(entry);
  return entry;
}

function three() {
  const buffer = new FrameXmlCombatLogBuffer({ spell: () => undefined });
  filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, 10);
  filled(buffer, CL.SPELL_DAMAGE, MOB, ME, 0xa48, 0x511, 11);
  filled(buffer, CL.SPELL_HEAL, ME, ME, 0x511, 0x511, 12);
  return buffer;
}

const event = (buffer) => buffer.args(buffer.current())[1];

test("the cursor: index 0 is the newest, -1 steps back to older, 1..n count from the oldest", () => {
  const buffer = three();
  assert.equal(buffer.numEntries(false), 3);
  assert.equal(buffer.setCurrent(0, false), true);
  assert.equal(event(buffer), "SPELL_HEAL");
  assert.equal(buffer.advance(-1, false), true);
  assert.equal(event(buffer), "SPELL_DAMAGE");
  assert.equal(buffer.advance(-1, false), true);
  assert.equal(event(buffer), "SWING_DAMAGE");
  assert.equal(buffer.advance(-1, false), false, "past the oldest: no current entry");
  assert.equal(buffer.current(), undefined);
  assert.equal(buffer.setCurrent(1, false), true);
  assert.equal(event(buffer), "SWING_DAMAGE");
  assert.equal(buffer.advance(2, false), true);
  assert.equal(event(buffer), "SPELL_HEAL");
  assert.equal(buffer.setCurrent(-2, false), true);
  assert.equal(event(buffer), "SWING_DAMAGE");
  assert.equal(buffer.setCurrent(4, false), false);
});

test("filters: events by name, masks per group, GUIDs, any filter passes; ignoreFilter counts all", () => {
  const buffer = three();
  buffer.addFilter("SPELL_DAMAGE,SPELL_HEAL", undefined, undefined);
  assert.equal(buffer.numEntries(false), 2);
  assert.equal(buffer.numEntries(true), 3);
  buffer.resetFilter();
  // COMBATLOG_FILTER_MINE as source.
  buffer.addFilter(undefined, 0x4511, undefined);
  assert.equal(buffer.numEntries(false), 2);
  buffer.addFilter(undefined, undefined, "0x0000000000000010");
  assert.equal(buffer.numEntries(false), 3, "the second filter (a GUID) takes the mob's spell at me");
  buffer.resetFilter();
  buffer.addFilter("", 0x4511, undefined);
  assert.equal(buffer.numEntries(false), 0, "an empty list names no event");
  assert.throws(() => buffer.addFilter(undefined, 0x11, undefined), /incomplete filter for srcMask/);
  assert.throws(() => buffer.addFilter(undefined, undefined, 0x500), /incomplete filter for dstMask/);
  buffer.resetFilter();
  buffer.addFilter(undefined, 0x10000, undefined);
  assert.equal(buffer.numEntries(false), 0, "a special bit alone is complete, and nothing here is the target");
  assert.equal(buffer.setCurrent(0, false), false);
  assert.equal(buffer.setCurrent(0, true), true, "ignoreFilter walks everything");
});

test("CombatLog_Object_IsA and the mask test: every group, or any special bit", () => {
  assert.equal(frameXmlCombatLogFlagsMatch(0x511, 0x4511), true);
  assert.equal(frameXmlCombatLogFlagsMatch(0xa48, 0x4511), false);
  assert.equal(frameXmlCombatLogFlagsMatch(0x10a48, 0x10000), true);
  const call = (name, ...args) => FRAMEXML_COMBAT_LOG_BINDINGS[name]({}, args);
  assert.deepEqual(call("CombatLog_Object_IsA", 0x511, 0x4511), [1]);
  assert.deepEqual(call("CombatLog_Object_IsA", 0xa48, 0x4511), []);
  assert.deepEqual(call("CombatLog_Object_IsA", -2147483648, -65536), [1], "NONE against the special mask, signed");
  assert.deepEqual(call("CombatLogGetNumEntries"), [0], "no log: empty");
  assert.deepEqual(call("CombatLogGetRetentionTime"), [300]);
});

test("retention by time, then the count cap; the cursor never points at a dropped entry", () => {
  const buffer = new FrameXmlCombatLogBuffer({ spell: () => undefined }, 4);
  buffer.retention = 30;
  filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, 0);
  buffer.setCurrent(1, true);
  filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, 10);
  filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, 40);
  assert.equal(buffer.size, 2, "the entry from t=0 is older than 30 s at t=40");
  assert.equal(buffer.current(), undefined);
  for (let time = 41; time < 50; time++) filled(buffer, CL.SWING_DAMAGE, ME, MOB, 0x511, 0xa48, time);
  assert.equal(buffer.size, 4);
  buffer.setCurrent(1, true);
  assert.equal(buffer.current().time, 46);
  buffer.clear();
  assert.equal(buffer.numEntries(true), 0);
});

function object(guid, typeId, fields = {}) {
  const map = new Map();
  for (const [name, value] of Object.entries(fields)) {
    const offset = UPDATE_FIELDS[name].offset;
    map.set(offset, Number(BigInt(value) & 0xffffffffn));
    if (UPDATE_FIELDS[name].type === "LONG") map.set(offset + 1, Number(BigInt(value) >> 32n));
  }
  return { guid, typeId, fields: map };
}

function liveWorld() {
  const listeners = new Map();
  const objects = new Map([
    [ME, object(ME, 4, { UNIT_FIELD_HEALTH: 100 })],
    [PARTY, object(PARTY, 4)],
    [MOB, object(MOB, 3, { UNIT_FIELD_HEALTH: 50 })],
    [PET, object(PET, 3, { UNIT_FIELD_SUMMONEDBY: ME, UNIT_FIELD_CREATEDBY: ME })],
  ]);
  const world = {
    state: { selfGuid: ME, objects },
    group: { groupType: 0, ownSubGroup: 0, ownFlags: 0, members: [{ guid: PARTY, subGroup: 0, flags: 2 }] },
    raidTargets: new Map([[7, MOB]]),
    names: new Map([[ME, "Тестовый"], [PARTY, "Друг"]]),
    auras: new Map(),
    requested: [],
    requestName(guid) { this.requested.push(guid); },
    events: {
      on(name, listener) {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      },
    },
  };
  return { world, emit: (name, value) => listeners.get(name)?.(value) };
}

function liveLog({ target, listeners = { filtered: 1, unfiltered: 1 } } = {}) {
  const { world, emit } = liveWorld();
  let clock = 0;
  const log = new FrameXmlCombatLogLive({
    world: () => world,
    spell: (id) => (id === 133 ? { name: "Огненный шар", schoolMask: 4, attributes: [0, 0, 0, 0, 0, 0, 0, 0] } : undefined),
    name: (guid) => (guid === MOB ? "Кобольд" : guid === PET ? "Волк" : world.names.get(guid)),
    reaction: (unit) => (unit.guid === MOB ? -1 : 1),
    targetGuid: () => target,
    focusGuid: () => undefined,
    monotonic: () => clock,
    now: () => 1700000000123,
  });
  const fired = [];
  log.attach({ fire: (name, ...args) => {
    fired.push([name, ...args]);
    return name === "COMBAT_LOG_EVENT" ? listeners.filtered : listeners.unfiltered;
  } });
  return { log, world, emit, fired, tick: (ms) => { clock += ms; } };
}

test("0x0074dcb0 flags: mine, my pet, a hostile grouped-icon target, a party member with MAINTANK, none", () => {
  const { log } = liveLog({ target: MOB });
  assert.equal(log.flags(ME), 0x511);
  assert.equal(log.flags(PET), 0x1111, "a summoned unit of mine: PET, control player, mine, friendly");
  assert.equal(log.flags(MOB), (0xa48 | 0x10000 | (0x100000 << 7)) >>> 0, "hostile NPC outsider, target, raid icon 8 while grouped");
  assert.equal(log.flags(PARTY), 0x40512, "party, friendly, player, main tank");
  assert.equal(log.flags(0n), 0x80000000);
});

test("firing: COMBAT_LOG_EVENT when the filter passes, then _UNFILTERED; the epoch timestamp; unknown names queried", () => {
  const { emit, fired, log, world } = liveLog();
  emit("UNIT_COMBAT", { source: "spellDamage", log: {
    casterGuid: ME, targetGuid: MOB, spellId: 133, damage: 10, overkill: 0, schoolMask: 4, absorbed: 0, resisted: 0,
    blocked: 0, periodic: false, critical: false, hitInfo: 0,
  } });
  assert.deepEqual(fired.map((entry) => entry[0]), ["COMBAT_LOG_EVENT", "COMBAT_LOG_EVENT_UNFILTERED"]);
  assert.deepEqual(fired[0].slice(1, 10), [1700000000.123, "SPELL_DAMAGE", "0x0000000000000010", "Тестовый", 0x511,
    "0xF130000000000ABC", "Кобольд", (0xa48 | (0x100000 << 7)) >>> 0, 133]);
  fired.length = 0;
  log.buffer.addFilter("SWING_DAMAGE", undefined, undefined);
  emit("PARTY_KILL", { killerGuid: PARTY, victimGuid: 0xf130000000000999n });
  assert.deepEqual(fired.map((entry) => entry[0]), ["COMBAT_LOG_EVENT_UNFILTERED"], "the filter stops only the filtered event");
  assert.deepEqual(fired[0].slice(2, 9), ["PARTY_KILL", "0x0000000000000021", "Друг", 0x40512, "0xF130000000000999", undefined, 0xa28]);
  assert.deepEqual(world.requested, [], "a player whose name is known is not queried");
  assert.equal(log.buffer.numEntries(true), 2);
});

test("lazy: an event nobody took is not built again for a second; the entries are still kept", () => {
  const { emit, fired, log, tick } = liveLog({ listeners: { filtered: 0, unfiltered: 0 } });
  const swing = { hitInfo: 2, attacker: ME, victim: MOB, damage: 5, overkill: 0, victimState: 1, blocked: 0,
    damages: [{ schoolMask: 1, damage: 5, absorbed: 0, resisted: 0 }] };
  emit("UNIT_COMBAT", { source: "melee", swing });
  emit("UNIT_COMBAT", { source: "melee", swing });
  assert.equal(fired.length, 2, "one probe per event name, then quiet");
  tick(1000);
  emit("UNIT_COMBAT", { source: "melee", swing });
  assert.equal(fired.length, 4, "probed again after a second");
  assert.equal(log.buffer.numEntries(true), 3);
});

test("a listener that registers mid-second hears the next entry when the pump can say who listens", () => {
  // 02.10 review: an add-on that registers COMBAT_LOG_EVENT_UNFILTERED on PLAYER_REGEN_DISABLED (or is
  // loaded by LoadAddOn) lost up to a second of the pull to the probe. Wow.exe fires to whoever is
  // registered at the moment of the entry (0x0074f910).
  const { world, emit } = liveWorld();
  const log = new FrameXmlCombatLogLive({
    world: () => world, spell: () => undefined, name: () => undefined, reaction: () => undefined,
    targetGuid: () => undefined, focusGuid: () => undefined, monotonic: () => 0, now: () => 1700000000123,
  });
  const registered = new Set();
  const fired = [];
  let built = 0;
  log.attach({
    listening: (name) => registered.has(name),
    fire: (name, ...args) => { built += 1; if (!registered.has(name)) return 0; fired.push([name, ...args]); return 1; },
  });
  const swing = { hitInfo: 2, attacker: ME, victim: MOB, damage: 5, overkill: 0, victimState: 1, blocked: 0,
    damages: [{ schoolMask: 1, damage: 5, absorbed: 0, resisted: 0 }] };
  emit("UNIT_COMBAT", { source: "melee", swing });
  assert.equal(built, 0, "nobody registered: no argument list is built");
  registered.add("COMBAT_LOG_EVENT_UNFILTERED");
  emit("UNIT_COMBAT", { source: "melee", swing });
  assert.deepEqual(fired.map((entry) => entry[0]), ["COMBAT_LOG_EVENT_UNFILTERED"], "the same millisecond");
  assert.equal(log.buffer.numEntries(true), 2);
});

test("0x0074d210: a creature whose template has CREATURE_TYPE_FLAG_MASK_UID is named without its counter", () => {
  // Before firing (0x0074f910) Wow.exe clears the low 24 bits of a creature or vehicle GUID whose
  // cached template type flags carry 0x4000 (SharedDefines.h CREATURE_TYPE_FLAG_MASK_UID).
  const { world, emit, fired } = liveLog();
  const MASKED = 0xf130001234000abcn; // entry 0x1234, counter 0xabc
  const PLAIN = 0xf130001235000abdn;
  world.creatureTemplates = new Map([[0x1234, { entry: 0x1234, flags: 0x4000 }], [0x1235, { entry: 0x1235, flags: 0 }]]);
  emit("PARTY_KILL", { killerGuid: ME, victimGuid: MASKED });
  emit("PARTY_KILL", { killerGuid: ME, victimGuid: PLAIN });
  // Only creature (0xF130) and vehicle (0xF150) GUIDs: a pet with the same bits keeps its counter.
  emit("PARTY_KILL", { killerGuid: ME, victimGuid: 0xf140001234000abcn });
  const kills = fired.filter((entry) => entry[0] === "COMBAT_LOG_EVENT_UNFILTERED").map((entry) => entry[6]);
  assert.deepEqual(kills, ["0xF130001234000000", "0xF130001235000ABD", "0xF140001234000ABC"]);
});

test("UNIT_DIED once per death; the first full aura list is quiet; a dispel names the removed aura's type", () => {
  const { log, world, fired } = liveLog();
  world.state.objects.get(MOB).fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  log.health(MOB);
  log.health(MOB);
  assert.deepEqual(fired.filter((entry) => entry[0] === "COMBAT_LOG_EVENT").map((entry) => entry[2]), ["UNIT_DIED"]);
  fired.length = 0;
  const aura = { slot: 0, spellId: 133, flags: 0x80, casterLevel: 1, applications: 0, casterGuid: ME };
  log.auraChanged({ guid: MOB, replaceAll: true, previous: new Map(), added: [aura], removed: [], updated: [] });
  assert.deepEqual(fired, []);
  log.auraChanged({ guid: MOB, replaceAll: false, previous: new Map([[0, aura]]), added: [], removed: [aura], updated: [] });
  log.combatFact({ source: "dispel", stolen: false, log: { casterGuid: PARTY, targetGuid: MOB, spellId: 527, dispelled: [{ spellId: 133, cleansed: false }] } });
  const events = fired.filter((entry) => entry[0] === "COMBAT_LOG_EVENT");
  assert.deepEqual(events.map((entry) => [entry[2], entry.at(-1)]), [["SPELL_AURA_REMOVED", "DEBUFF"], ["SPELL_DISPEL", "DEBUFF"]]);
});
