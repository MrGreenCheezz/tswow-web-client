import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { parseAttackerStateUpdate, parseEnvironmentalDamage } from "../dist/code/world/CombatProtocol.js";
import {
  parsePeriodicAuraLog, parseSpellDamageLog, parseSpellEnergizeLog, parseSpellHealLog,
} from "../dist/code/world/SpellLogProtocol.js";
import { parseExecuteLogDetail, parseDispelFailed } from "../dist/code/world/CombatFacts.js";
import {
  CL, auraEntry, energizeEntries, environmentalEntries, executeEntries, healEntries, meleeEntries, periodicEntries,
  spellDamageEntries, spellMissEntries,
} from "../dist/code/world/CombatEventModel.js";
import { FrameXmlCombatLogBuffer } from "../dist/code/browser/framexml/FrameXmlCombatLog.js";

// 3.01 slice C: packet bytes (written here by hand in the core's order) → the real parsers → the
// normaliser → 0x0074e290's argument list. Each case names the Wow.exe 3.3.5a handler it follows
// (.runtime/re-2026-10-02/a2-m8/d2.c, d3.c): 0x007512b0 melee, 0x00751c40 spell damage, 0x00750860
// heal, 0x00750a90 energize, 0x00750b60 drain/leech, 0x00751150 environment, 0x0074d980 a miss's amount.

const ME = 0x10n;
const MOB = 0xf130000000000abcn;
const ME_TEXT = "0x0000000000000010";
const MOB_TEXT = "0xF130000000000ABC";
const SPELLS = new Map([
  [133, { name: "Огненный шар", schoolMask: 4, attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
  [75, { name: "Автоматическая стрельба", schoolMask: 1, attributes: [0, 0, 0, 0x8000, 0, 0, 0, 0] }],
  [2139, { name: "Антимагия", schoolMask: 64, attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
  [172, { name: "Порча", schoolMask: 32, attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
  [5138, { name: "Похищение маны", schoolMask: 32, attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
  [7001, { name: "Скрытое", schoolMask: 1, attributes: [0x100, 0, 0, 0, 0, 0, 0, 0] }],
]);
const facts = { attributes: (id) => SPELLS.get(id)?.attributes };

function harness() {
  const buffer = new FrameXmlCombatLogBuffer({ spell: (id) => SPELLS.get(id) });
  const lists = [];
  const sink = {
    begin(event, source, dest, spellId) {
      const entry = buffer.next();
      Object.assign(entry, { event, source, dest, spellId, time: 1700000000.25 });
      return entry;
    },
    commit(entry) {
      entry.sourceName = entry.source === ME ? "Тестовый" : entry.source === 0n ? undefined : "Кобольд";
      entry.sourceFlags = entry.source === 0n ? 0x80000000 : entry.source === ME ? 0x511 : 0xa48;
      entry.destName = entry.dest === ME ? "Тестовый" : entry.dest === 0n ? undefined : "Кобольд";
      entry.destFlags = entry.dest === 0n ? 0x80000000 : entry.dest === ME ? 0x511 : 0xa48;
      buffer.push(entry);
      lists.push([...buffer.args(entry)]);
    },
  };
  return { buffer, sink, lists };
}

const HEAD_ME_MOB = [1700000000.25, undefined, ME_TEXT, "Тестовый", 0x511, MOB_TEXT, "Кобольд", 0xa48];
const head = (event, from = ME, to = MOB) => {
  const value = [...HEAD_ME_MOB];
  value[1] = event;
  if (from === MOB) { value[2] = MOB_TEXT; value[3] = "Кобольд"; value[4] = 0xa48; }
  if (from === 0n) { value[2] = "0x0000000000000000"; value[3] = undefined; value[4] = -2147483648; }
  if (to === ME) { value[5] = ME_TEXT; value[6] = "Тестовый"; value[7] = 0x511; }
  return value;
};

/** SMSG_ATTACKERSTATEUPDATE — Unit::SendAttackStateUpdate (Unit.cpp): sub-damages, then absorbs and resists as blocks. */
function swing({ hitInfo, damage, overkill = 0, schools = [[1, damage]], absorbs, resists, state, blocked }) {
  const writer = new PacketWriter().u32(hitInfo).packedGuid(ME).packedGuid(MOB).u32(damage).u32(overkill).u8(schools.length);
  for (const [school, amount] of schools) writer.u32(school).f32(amount).u32(amount);
  if (hitInfo & 0x60) for (const value of absorbs) writer.u32(value);
  if (hitInfo & 0x180) for (const value of resists) writer.u32(value);
  writer.u8(state).u32(0).u32(0);
  if (hitInfo & 0x2000) writer.u32(blocked);
  return parseAttackerStateUpdate(writer.toUint8Array());
}

test("SWING_DAMAGE: the damage block, absorbs summed over the schools, crit/glancing/crushing as 1 or nil", () => {
  const { sink, lists } = harness();
  meleeEntries(swing({ hitInfo: 0x2 | 0x200 | 0x40, damage: 120, overkill: 7, schools: [[1, 100], [4, 20]], absorbs: [5, 3], state: 1 }), sink);
  meleeEntries(swing({ hitInfo: 0x2 | 0x10000, damage: 50, state: 1 }), sink);
  assert.deepEqual(lists, [
    [...head("SWING_DAMAGE"), 120, 7, 1, undefined, undefined, 8, 1, undefined, undefined],
    [...head("SWING_DAMAGE"), 50, 0, 1, undefined, undefined, undefined, undefined, 1, undefined],
  ]);
});

test("SWING_MISSED: MISS, a full absorb with its amount, DODGE, a full block with the blocked amount", () => {
  const { sink, lists } = harness();
  meleeEntries(swing({ hitInfo: 0x2 | 0x10, damage: 0, state: 1 }), sink);
  meleeEntries(swing({ hitInfo: 0x2 | 0x20, damage: 0, absorbs: [40], state: 1 }), sink);
  meleeEntries(swing({ hitInfo: 0x2, damage: 0, state: 2 }), sink);
  meleeEntries(swing({ hitInfo: 0x2 | 0x2000, damage: 0, state: 5, blocked: 33 }), sink);
  meleeEntries(swing({ hitInfo: 0x2, damage: 0, state: 4 }), sink);
  assert.deepEqual(lists, [
    [...head("SWING_MISSED"), "MISS"],
    [...head("SWING_MISSED"), "ABSORB", 40],
    [...head("SWING_MISSED"), "DODGE"],
    [...head("SWING_MISSED"), "BLOCK", 33],
  ], "an INTERRUPT victim state writes nothing");
});

/** SMSG_SPELLNONMELEEDAMAGELOG — Unit::SendSpellNonMeleeDamageLog. */
function spellDamage({ spellId, damage, overkill = 0, school = 4, absorbed = 0, resisted = 0, periodic = 0, blocked = 0, hitInfo = 0 }) {
  return parseSpellDamageLog(new PacketWriter().packedGuid(MOB).packedGuid(ME).u32(spellId).u32(damage).u32(overkill)
    .u8(school).u32(absorbed).u32(resisted).u8(periodic).u8(0).u32(blocked).u32(hitInfo).toUint8Array());
}

test("SPELL_DAMAGE / RANGE_DAMAGE / SPELL_MISSED ABSORB; a spell hidden in the log writes nothing", () => {
  const { sink, lists } = harness();
  spellDamageEntries(spellDamage({ spellId: 133, damage: 300, resisted: 40, hitInfo: 0x2 }), facts, sink);
  spellDamageEntries(spellDamage({ spellId: 75, damage: 80, school: 1 }), facts, sink);
  spellDamageEntries(spellDamage({ spellId: 133, damage: 0, absorbed: 250 }), facts, sink);
  spellDamageEntries(spellDamage({ spellId: 75, damage: 0, resisted: 10, school: 1 }), facts, sink);
  spellDamageEntries(spellDamage({ spellId: 7001, damage: 5 }), facts, sink);
  assert.deepEqual(lists, [
    [...head("SPELL_DAMAGE"), 133, "Огненный шар", 4, 300, 0, 4, 40, undefined, undefined, 1, undefined, undefined],
    [...head("RANGE_DAMAGE"), 75, "Автоматическая стрельба", 1, 80, 0, 1, undefined, undefined, undefined, undefined, undefined, undefined],
    [...head("SPELL_MISSED"), 133, "Огненный шар", 4, "ABSORB", 250],
    [...head("RANGE_MISSED"), 75, "Автоматическая стрельба", 1, "RESIST", 10],
  ]);
});

/** SMSG_PERIODICAURALOG — Unit::SendPeriodicAuraLog (Unit.cpp:5626-5670). */
function periodic(auraType, tail) {
  const writer = new PacketWriter().packedGuid(MOB).packedGuid(ME).u32(auraType === 64 ? 5138 : 172).u32(1).u32(auraType);
  tail(writer);
  return parsePeriodicAuraLog(writer.toUint8Array());
}

test("periodic: DAMAGE with its block, HEAL, ENERGIZE in tenths for rage, and a mana LEECH with its extra amount", () => {
  const { sink, lists } = harness();
  periodicEntries(periodic(3, (w) => w.u32(60).u32(0).u32(32).u32(0).u32(0).u8(1)), facts, sink);
  periodicEntries(periodic(8, (w) => w.u32(90).u32(15).u32(0).u8(0)), facts, sink);
  periodicEntries(periodic(24, (w) => w.u32(1).u32(100)), facts, sink);
  periodicEntries(periodic(64, (w) => w.u32(0).u32(200).f32(1.5)), facts, sink);
  assert.deepEqual(lists, [
    [...head("SPELL_PERIODIC_DAMAGE"), 172, "Порча", 32, 60, 0, 32, undefined, undefined, undefined, 1, undefined, undefined],
    [...head("SPELL_PERIODIC_HEAL"), 172, "Порча", 32, 90, 15, 0, undefined],
    [...head("SPELL_PERIODIC_ENERGIZE"), 172, "Порча", 32, 10, 1],
    [...head("SPELL_PERIODIC_LEECH"), 5138, "Похищение маны", 32, 200, 0, 300],
  ]);
});

test("SPELL_HEAL and SPELL_ENERGIZE from their logs; runic power in tenths", () => {
  const { sink, lists } = harness();
  const heal = parseSpellHealLog(new PacketWriter().packedGuid(MOB).packedGuid(ME).u32(133).u32(500).u32(120).u32(0).u8(1).u8(0).toUint8Array());
  healEntries(heal.casterGuid, heal.targetGuid, heal.spellId, heal.amount, heal.overheal, heal.absorbed, heal.critical, false, sink);
  const power = parseSpellEnergizeLog(new PacketWriter().packedGuid(MOB).packedGuid(ME).u32(133).u32(6).u32(150).toUint8Array());
  energizeEntries(power.casterGuid, power.targetGuid, power.spellId, power.amount, power.powerType, false, sink);
  assert.deepEqual(lists, [
    [...head("SPELL_HEAL"), 133, "Огненный шар", 4, 500, 120, 0, 1],
    [...head("SPELL_ENERGIZE"), 133, "Огненный шар", 4, 15, 6],
  ]);
});

test("ENVIRONMENTAL_DAMAGE: no source, the type by name, the school from its table, no overkill", () => {
  const { sink, lists } = harness();
  const fall = parseEnvironmentalDamage(new PacketWriter().u64(ME).u8(2).u32(420).u32(0).u32(0).toUint8Array());
  environmentalEntries(fall.victim, fall.type, fall.damage, fall.resisted, fall.absorbed, sink);
  const lava = parseEnvironmentalDamage(new PacketWriter().u64(ME).u8(3).u32(100).u32(10).u32(5).toUint8Array());
  environmentalEntries(lava.victim, lava.type, lava.damage, lava.resisted, lava.absorbed, sink);
  assert.deepEqual(lists, [
    [...head("ENVIRONMENTAL_DAMAGE", 0n, ME), "FALLING", 420, 0, 1, undefined, undefined, undefined, undefined, undefined, undefined],
    [...head("ENVIRONMENTAL_DAMAGE", 0n, ME), "LAVA", 100, 0, 4, 10, undefined, 5, undefined, undefined, undefined],
  ]);
});

test("SMSG_SPELLLOGEXECUTE: interrupt and drain records (Spell.cpp:4721-4776); an unknown effect ends the read", () => {
  const { sink, lists } = harness();
  const payload = new PacketWriter().packedGuid(ME).u32(2139).u32(2)
    .u32(68).u32(1).packedGuid(MOB).u32(133)
    .u32(8).u32(1).packedGuid(MOB).u32(50).u32(0).f32(0)
    .toUint8Array();
  const log = parseExecuteLogDetail(payload);
  assert.deepEqual(log.effects.map((effect) => [effect.effect, effect.records.length]), [[68, 1], [8, 1]]);
  executeEntries(log.casterGuid, log.spellId, log.effects, facts, sink);
  assert.deepEqual(lists, [
    [...head("SPELL_INTERRUPT"), 2139, "Антимагия", 64, 133, "Огненный шар", 4],
    [...head("SPELL_DRAIN"), 2139, "Антимагия", 64, 50, 0, undefined],
  ]);
  const stopped = parseExecuteLogDetail(new PacketWriter().packedGuid(ME).u32(2139).u32(2).u32(999).u32(1).u32(7).u32(68).u32(0).toUint8Array());
  assert.deepEqual(stopped.effects, []);
  const failed = parseDispelFailed(new PacketWriter().u64(ME).u64(MOB).u32(527).u32(172).u32(133).toUint8Array());
  assert.deepEqual([failed.casterGuid, failed.targetGuid, failed.spellId, failed.failed], [ME, MOB, 527, [172, 133]]);
});

test("misses decided at cast, immunity, procresist's RESIST 0; aura edges with their type and stack count", () => {
  const { sink, lists } = harness();
  spellMissEntries(ME, MOB, 133, 7, facts, sink);
  spellMissEntries(ME, MOB, 133, 2, facts, sink, true);
  auraEntry(CL.SPELL_AURA_APPLIED_DOSE, MOB, ME, 172, true, 3, sink);
  auraEntry(CL.SPELL_AURA_REMOVED, MOB, ME, 172, false, undefined, sink);
  assert.deepEqual(lists, [
    [...head("SPELL_MISSED"), 133, "Огненный шар", 4, "IMMUNE"],
    [...head("SPELL_MISSED"), 133, "Огненный шар", 4, "RESIST", 0],
    [...head("SPELL_AURA_APPLIED_DOSE", MOB, ME), 172, "Порча", 32, "DEBUFF", 3],
    [...head("SPELL_AURA_REMOVED", MOB, ME), 172, "Порча", 32, "BUFF"],
  ]);
});

test("a spell row not yet known: nil name, school 0 (0x0074e290)", () => {
  const { sink, lists } = harness();
  spellMissEntries(ME, MOB, 4242, 1, facts, sink);
  assert.deepEqual(lists, [[...head("SPELL_MISSED"), 4242, undefined, 0, "MISS"]]);
});
