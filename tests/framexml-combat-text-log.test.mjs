// 06.11 (3.01): the COMBAT_TEXT_UPDATE messages the combat log's entries raise, as Wow.exe 3.3.5a raises them in the
// functions that write the entries (0x00750660, 0x007512b0, 0x00751150, 0x00751c40, 0x00750500, 0x00750860,
// 0x00750a90, 0x00750b60, 0x00752710, 0x00752c90; .runtime/re-2026-11-06/301/notes.md). The entries are made by the
// real builders of world/CombatEventModel.ts, so the rules are checked against the entries the live log writes.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CL, auraEntry, createCombatLogEntry, damageShieldEntries, drainEntries, energizeEntries, environmentalEntries,
  healEntries, meleeEntries, spellDamageEntries, spellMissEntries,
} from "../dist/code/world/CombatEventModel.js";
import { frameXmlCombatTextForEntry, frameXmlCombatTextPowerToken } from "../dist/code/browser/framexml/FrameXmlCombatTextLog.js";
import { FrameXmlCombatLogLive } from "../dist/code/browser/framexml/FrameXmlCombatLogLive.js";

const ME = 0x10n;
const MOB = 0xf130000000001000n;
const PRIEST = 0x20n;

const SPELLS = new Map([
  [133, { name: "Огненный шар", attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
  [75, { name: "Автоматическая стрельба", attributes: [0, 0, 0, 0x8000, 0, 0, 0, 0] }],
  [139, { name: "Обновление", attributes: [0, 0, 0, 0, 0, 0, 0, 0], duration: 15000, maxDuration: 15000 }],
  [17, { name: "Слово силы: Щит", attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
  [34, { name: "Долгое исцеление", attributes: [0, 0, 0, 0, 0, 0, 0, 0], duration: 45000, maxDuration: 45000 }],
  [500, { name: "Пассивка", attributes: [0x40, 0, 0, 0, 0, 0, 0, 0] }],
  [501, { name: "Скрытая", attributes: [0x80, 0, 0, 0, 0, 0, 0, 0] }],
  [502, { name: "Без текста", attributes: [0, 0, 0, 0, 0, 0, 0x400, 0] }],
  [503, { name: "Сказано кастом", attributes: [0, 0, 0, 0, 0, 0, 0x40, 0] }],
]);
const spells = { attributes: (id) => SPELLS.get(id)?.attributes };

/** The messages each committed entry raises for the unit ME (dead: the GUIDs whose health is 0). */
function run(make, { dead = new Set(), unknown = "Неизвестно", names = new Map([[PRIEST, "Жрица"]]) } = {}) {
  const messages = [];
  const facts = {
    unit: ME,
    name: (guid) => names.get(guid),
    unknownName: () => unknown,
    spell: (id) => SPELLS.get(id),
    alive: (guid) => !dead.has(guid),
  };
  const sink = {
    begin(event, source, dest, spellId) {
      const entry = createCombatLogEntry();
      Object.assign(entry, { event, source, dest, spellId });
      return entry;
    },
    commit(entry) { messages.push(...frameXmlCombatTextForEntry(entry, entry.source, entry.dest, facts)); },
  };
  make(sink);
  return messages.map((message) => [...message]);
}

const melee = (patch) => ({ hitInfo: 0x2, attacker: MOB, victim: ME, damage: 120, overkill: 0, victimState: 1, blocked: 0,
  damages: [{ schoolMask: 1, absorbed: 0, resisted: 0 }], ...patch });

test("melee taken: resisted, blocked, absorbed, critical, plain — in that order, with the amounts", () => {
  assert.deepEqual(run((sink) => meleeEntries(melee({}), sink)), [["DAMAGE", 120]]);
  assert.deepEqual(run((sink) => meleeEntries(melee({ hitInfo: 0x202 }), sink)), [["DAMAGE_CRIT", 120]]);
  assert.deepEqual(run((sink) => meleeEntries(melee({ hitInfo: 0x202, victimState: 5, blocked: 30,
    damages: [{ schoolMask: 1, absorbed: 10, resisted: 5 }] }), sink)), [["RESIST", 120, 5]], "resist outranks the rest");
  assert.deepEqual(run((sink) => meleeEntries(melee({ victimState: 5, blocked: 30,
    damages: [{ schoolMask: 1, absorbed: 10, resisted: 0 }] }), sink)), [["BLOCK", 120, 30]]);
  assert.deepEqual(run((sink) => meleeEntries(melee({ damages: [{ schoolMask: 1, absorbed: 10, resisted: 0 }] }), sink)),
    [["ABSORB", 120, 10]]);
  assert.deepEqual(run((sink) => meleeEntries(melee({ attacker: ME, victim: MOB }), sink)), [], "only what the unit takes");
});

test("melee misses: the miss type alone", () => {
  assert.deepEqual(run((sink) => meleeEntries(melee({ damage: 0, victimState: 2 }), sink)), [["DODGE"]]);
  assert.deepEqual(run((sink) => meleeEntries(melee({ damage: 0, victimState: 3 }), sink)), [["PARRY"]]);
  assert.deepEqual(run((sink) => meleeEntries(melee({ hitInfo: 0x12, damage: 0 }), sink)), [["MISS"]]);
  assert.deepEqual(run((sink) => meleeEntries(melee({ hitInfo: 0x22, damage: 0,
    damages: [{ schoolMask: 1, absorbed: 120, resisted: 0 }] }), sink)), [["ABSORB"]], "a full absorb carries no number");
  assert.deepEqual(run((sink) => meleeEntries(melee({ damage: 0, victimState: 8 }), sink)), [["DEFLECT"]]);
});

const spellHit = (patch) => ({ casterGuid: MOB, targetGuid: ME, spellId: 133, damage: 300, overkill: 0, schoolMask: 4,
  absorbed: 0, resisted: 0, blocked: 0, critical: false, periodic: false, ...patch });

test("spell damage takes the SPELL_ names; periodic and ranged hits the plain ones (0x00751c40's kinds 9, 0x22, 3)", () => {
  assert.deepEqual(run((sink) => spellDamageEntries(spellHit({}), spells, sink)), [["SPELL_DAMAGE", 300]]);
  assert.deepEqual(run((sink) => spellDamageEntries(spellHit({ critical: true }), spells, sink)), [["SPELL_DAMAGE_CRIT", 300]]);
  assert.deepEqual(run((sink) => spellDamageEntries(spellHit({ resisted: 40 }), spells, sink)), [["SPELL_RESIST", 300, 40]]);
  assert.deepEqual(run((sink) => spellDamageEntries(spellHit({ absorbed: 50 }), spells, sink)), [["SPELL_ABSORB", 300, 50]]);
  assert.deepEqual(run((sink) => spellDamageEntries(spellHit({ periodic: true }), spells, sink)), [["DAMAGE", 300]]);
  assert.deepEqual(run((sink) => spellDamageEntries(spellHit({ spellId: 75 }), spells, sink)), [["DAMAGE", 300]]);
  assert.deepEqual(run((sink) => spellDamageEntries(spellHit({ damage: 0, absorbed: 300 }), spells, sink)), [["SPELL_ABSORB"]]);
  assert.deepEqual(run((sink) => spellDamageEntries(spellHit({ damage: 0, absorbed: 300, periodic: true }), spells, sink)),
    [["ABSORB"]]);
  assert.deepEqual(run((sink) => spellMissEntries(MOB, ME, 133, 7, spells, sink)), [["SPELL_IMMUNE"]]);
  assert.deepEqual(run((sink) => spellMissEntries(MOB, ME, 133, 11, spells, sink)), [["SPELL_REFLECT"]]);
  assert.deepEqual(run((sink) => spellMissEntries(MOB, ME, 75, 3, spells, sink)), [["DODGE"]], "a ranged miss");
});

test("environment, damage shield", () => {
  assert.deepEqual(run((sink) => environmentalEntries(ME, 2, 90, 0, 0, sink)), [["DAMAGE", 90]]);
  assert.deepEqual(run((sink) => environmentalEntries(ME, 2, 90, 0, 20, sink)), [["ABSORB", 90, 20]]);
  assert.deepEqual(run((sink) => environmentalEntries(ME, 2, 90, 15, 20, sink)), [["RESIST", 90, 15]]);
  assert.deepEqual(run((sink) => damageShieldEntries(MOB, ME, 133, 12, 0, 4, spells, sink)), [["DAMAGE_SHIELD", 12]],
    "the shield's owner (MOB) hurt the unit");
  assert.deepEqual(run((sink) => damageShieldEntries(ME, MOB, 133, 12, 0, 4, spells, sink)), []);
});

test("heals: the healer's name and the amount; absorbed forms; a long heal-over-time says nothing", () => {
  assert.deepEqual(run((sink) => healEntries(PRIEST, ME, 2061, 800, 0, 0, false, false, sink)), [["HEAL", "Жрица", 800]]);
  assert.deepEqual(run((sink) => healEntries(PRIEST, ME, 2061, 800, 0, 0, true, false, sink)), [["HEAL_CRIT", "Жрица", 800]]);
  assert.deepEqual(run((sink) => healEntries(PRIEST, ME, 2061, 800, 0, 100, true, false, sink)),
    [["HEAL_CRIT_ABSORB", "Жрица", 800, 100]]);
  assert.deepEqual(run((sink) => healEntries(PRIEST, ME, 2061, 800, 0, 100, false, false, sink)),
    [["HEAL_ABSORB", "Жрица", 800, 100]]);
  assert.deepEqual(run((sink) => healEntries(PRIEST, ME, 139, 200, 0, 0, false, true, sink)), [["PERIODIC_HEAL", "Жрица", 200]]);
  assert.deepEqual(run((sink) => healEntries(PRIEST, ME, 139, 200, 0, 30, false, true, sink)),
    [["PERIODIC_HEAL_ABSORB", "Жрица", 200, 30]]);
  assert.deepEqual(run((sink) => healEntries(PRIEST, ME, 34, 200, 0, 0, false, true, sink)), [], "an aura of 45 s");
  assert.deepEqual(run((sink) => healEntries(0x99n, ME, 2061, 5, 0, 0, false, false, sink)), [["HEAL", "Неизвестно", 5]]);
  assert.deepEqual(run((sink) => healEntries(0x99n, ME, 2061, 5, 0, 0, false, false, sink), { unknown: "" }),
    [["HEAL", "UKNOWNOBJECT", 5]], "an empty UNKNOWNOBJECT: 0x0074d750's last resort, its spelling");
});

test("power: energize with the token; a drain the unit suffers is negative; a leech's gift to the unit", () => {
  assert.deepEqual(run((sink) => energizeEntries(PRIEST, ME, 1, 250, 0, false, sink)), [["ENERGIZE", 250, "MANA"]]);
  assert.deepEqual(run((sink) => energizeEntries(PRIEST, ME, 1, 150, 1, true, sink)), [["PERIODIC_ENERGIZE", 15, "RAGE"]],
    "rage in tenths");
  assert.deepEqual(run((sink) => drainEntries(MOB, ME, 1, 100, 0, 0, false, sink)), [["ENERGIZE", -100, "MANA"]]);
  assert.deepEqual(run((sink) => drainEntries(ME, MOB, 1, 100, 0, 0.5, false, sink)), [["ENERGIZE", 50, "MANA"]]);
  assert.deepEqual(run((sink) => drainEntries(ME, MOB, 1, 100, 0, 0.5, true, sink)), [["PERIODIC_ENERGIZE", 50, "MANA"]]);
  assert.equal(frameXmlCombatTextPowerToken(6), "RUNIC_POWER");
  assert.equal(frameXmlCombatTextPowerToken(7), "");
});

test("auras: start and end with the spell's name, and the spells and units that raise nothing", () => {
  const applied = (spellId, debuff) => (sink) => auraEntry(CL.SPELL_AURA_APPLIED, MOB, ME, spellId, debuff, undefined, sink);
  const removed = (spellId, debuff) => (sink) => auraEntry(CL.SPELL_AURA_REMOVED, MOB, ME, spellId, debuff, undefined, sink);
  assert.deepEqual(run(applied(17, false)), [["SPELL_AURA_START", "Слово силы: Щит"]]);
  assert.deepEqual(run(applied(133, true)), [["SPELL_AURA_START_HARMFUL", "Огненный шар"]]);
  assert.deepEqual(run(removed(17, false)), [["SPELL_AURA_END", "Слово силы: Щит"]]);
  assert.deepEqual(run(removed(133, true)), [["SPELL_AURA_END_HARMFUL", "Огненный шар"]]);
  assert.deepEqual(run(removed(17, false), { dead: new Set([ME]) }), [], "no end on a dead unit");
  assert.deepEqual(run(applied(17, false), { dead: new Set([ME]) }), [["SPELL_AURA_START", "Слово силы: Щит"]]);
  for (const id of [500, 501, 502, 9999]) assert.deepEqual(run(applied(id, false)), [], `spell ${id}`);
  assert.deepEqual(run(applied(503, false)), [], "a helpful start its cast already announced");
  assert.deepEqual(run(removed(503, false)), [["SPELL_AURA_END", "Сказано кастом"]]);
});

test("live: after COMBAT_LOG_EVENT_UNFILTERED, only for the combat-text unit", () => {
  const fired = [];
  const log = new FrameXmlCombatLogLive({
    world: () => undefined, spell: (id) => SPELLS.get(id), name: () => undefined, reaction: () => -1,
    targetGuid: () => undefined, focusGuid: () => undefined, monotonic: () => 0, now: () => 1700000000123,
  });
  log.attach({ fire: (name, ...args) => { fired.push([name, ...(name === "COMBAT_TEXT_UPDATE" ? args : [args[1]])]); return 1; } });
  meleeEntries(melee({}), log);
  assert.ok(!fired.some(([name]) => name === "COMBAT_TEXT_UPDATE"), "no combat-text unit yet");
  log.setCombatTextUnit(ME);
  fired.length = 0;
  meleeEntries(melee({}), log);
  meleeEntries(melee({ attacker: ME, victim: MOB }), log);
  assert.deepEqual(fired.filter(([name]) => name !== "COMBAT_LOG_EVENT"), [
    ["COMBAT_LOG_EVENT_UNFILTERED", "SWING_DAMAGE"],
    ["COMBAT_TEXT_UPDATE", "DAMAGE", 120],
    ["COMBAT_LOG_EVENT_UNFILTERED", "SWING_DAMAGE"],
  ]);
  log.detach();
});
