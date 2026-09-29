import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import {
  parseDamageShieldLog, parseDispelLog, parsePeriodicAuraLog, parseSpellDamageLog,
  parseSpellEnergizeLog, parseSpellHealLog, parseSpellMissLog, parseSpellVisualKit,
  AURA_PERIODIC_DAMAGE, AURA_PERIODIC_ENERGIZE, AURA_PERIODIC_HEAL,
} from "../dist/code/world/SpellLogProtocol.js";
import {
  parseChannelStart, parseChannelUpdate, parseModifyCooldown, parseResyncRunes, parseSpellDelayed,
  parseSpellFailure, parseSpellModifier, parseTotemCreated,
} from "../dist/code/world/SpellProtocol.js";
import {
  ACTION_BUTTON_ITEM, ACTION_BUTTON_SPELL, ACTION_BUTTONS, actionPage, actionSlot,
  buildSetActionButton, parseActionButtons,
} from "../dist/code/world/ActionBarProtocol.js";
import { ThreatTables, parseThreatRemove, parseThreatUpdate } from "../dist/code/world/ThreatProtocol.js";
import {
  parseCancelAutoRepeat, parseComboPoints, parsePowerUpdate,
} from "../dist/code/world/UnitEventProtocol.js";

const CASTER = 0xf130000000000101n;
const TARGET = 0xf130000000000202n;

test("a spell damage log decodes in the order the core writes it", () => {
  // Unit::SendSpellNonMeleeDamageLog: target and caster packed, then the numbers.
  const payload = new PacketWriter()
    .packedGuid(TARGET).packedGuid(CASTER)
    .u32(133).u32(482).u32(0).u8(0x04).u32(30).u32(12).u8(0).u8(0).u32(0).u32(0x0002)
    .toUint8Array();

  const log = parseSpellDamageLog(payload);
  assert.equal(log.targetGuid, TARGET);
  assert.equal(log.casterGuid, CASTER);
  assert.equal(log.spellId, 133);
  assert.equal(log.damage, 482);
  assert.equal(log.schoolMask, 0x04);
  assert.equal(log.absorbed, 30);
  assert.equal(log.resisted, 12);
  assert.equal(log.periodic, false);
  // SPELL_HIT_TYPE_CRIT is bit 1 of the hit info, and nothing else in the packet says "crit".
  assert.equal(log.critical, true);
});

test("a periodic log carries different fields for damage, healing and energy", () => {
  const header = () => new PacketWriter().packedGuid(TARGET).packedGuid(CASTER).u32(172).u32(1);

  const damage = parsePeriodicAuraLog(header().u32(AURA_PERIODIC_DAMAGE)
    .u32(45).u32(0).u32(0x20).u32(5).u32(0).u8(1).toUint8Array());
  assert.equal(damage.amount, 45);
  assert.equal(damage.absorbed, 5);
  assert.equal(damage.critical, true);
  assert.equal(damage.powerType, undefined);

  const heal = parsePeriodicAuraLog(header().u32(AURA_PERIODIC_HEAL)
    .u32(300).u32(40).u32(0).u8(0).toUint8Array());
  assert.equal(heal.amount, 300);
  assert.equal(heal.overAmount, 40, "the part that went into a full health bar");

  const energize = parsePeriodicAuraLog(header().u32(AURA_PERIODIC_ENERGIZE).u32(3).u32(20).toUint8Array());
  assert.equal(energize.powerType, 3);
  assert.equal(energize.amount, 20);

  // An aura type the core does not branch on ends the packet after the type, and that is a whole
  // packet rather than a truncated one.
  const unknown = parsePeriodicAuraLog(header().u32(9999).toUint8Array());
  assert.equal(unknown.auraType, 9999);
  assert.equal(unknown.amount, 0);
});

test("heal, energize and miss logs decode their own shapes", () => {
  const heal = parseSpellHealLog(new PacketWriter()
    .packedGuid(TARGET).packedGuid(CASTER).u32(2050).u32(600).u32(150).u32(0).u8(1).u8(0).toUint8Array());
  assert.equal(heal.amount, 600);
  assert.equal(heal.overheal, 150);
  assert.equal(heal.critical, true);

  const energize = parseSpellEnergizeLog(new PacketWriter()
    .packedGuid(TARGET).packedGuid(CASTER).u32(29842).u32(0).u32(400).toUint8Array());
  assert.equal(energize.powerType, 0);
  assert.equal(energize.amount, 400);

  // WorldObject::SendSpellMiss writes full guids, not packed ones: read as packed, the first byte
  // would be taken for a mask and everything after it would shift.
  const miss = parseSpellMissLog(new PacketWriter()
    .u32(133).u64(CASTER).u8(0).u32(2).u64(TARGET).u8(1).u64(0x99n).u8(3).toUint8Array());
  assert.equal(miss.spellId, 133);
  assert.equal(miss.casterGuid, CASTER);
  assert.deepEqual(miss.targets, [{ guid: TARGET, missInfo: 1 }, { guid: 0x99n, missInfo: 3 }]);
});

test("dispel, damage shield and visual kit logs decode", () => {
  const dispel = parseDispelLog(new PacketWriter()
    .packedGuid(TARGET).packedGuid(CASTER).u32(527).u8(0).u32(2).u32(172).u8(0).u32(980).u8(1).toUint8Array());
  assert.deepEqual(dispel.dispelled, [{ spellId: 172, cleansed: false }, { spellId: 980, cleansed: true }]);

  const shield = parseDamageShieldLog(new PacketWriter()
    .u64(TARGET).u64(CASTER).u32(1160).u32(75).u32(0).u32(0x01).toUint8Array());
  assert.equal(shield.damage, 75);
  assert.equal(shield.schoolMask, 0x01);

  const visual = parseSpellVisualKit(new PacketWriter().u64(CASTER).u32(1234).toUint8Array());
  assert.deepEqual(visual, { guid: CASTER, kitId: 1234 });
});

test("a cast bar's packets: channel, pushback and failure", () => {
  const start = parseChannelStart(new PacketWriter().packedGuid(CASTER).u32(5143).u32(5000).toUint8Array());
  assert.deepEqual(start, { casterGuid: CASTER, spellId: 5143, duration: 5000 });

  const update = parseChannelUpdate(new PacketWriter().packedGuid(CASTER).u32(3200).toUint8Array());
  assert.equal(update.remaining, 3200);

  const delayed = parseSpellDelayed(new PacketWriter().packedGuid(CASTER).u32(500).toUint8Array());
  assert.equal(delayed.delay, 500, "pushback lengthens the cast rather than restarting it");

  const failure = parseSpellFailure(new PacketWriter().packedGuid(CASTER).u8(7).u32(133).u8(24).toUint8Array());
  assert.deepEqual(failure, { casterGuid: CASTER, castCount: 7, spellId: 133, result: 24 });

  // A negative delta is the common one: talents and procs cut cooldowns short.
  const modified = parseModifyCooldown(new PacketWriter().u32(133).u64(CASTER).u32(0xffff_ec78).toUint8Array());
  assert.equal(modified.delta, -5000);
});

test("action bars arrive as 144 packed slots, and empty ones are absent", () => {
  const writer = new PacketWriter().u8(1);
  for (let slot = 0; slot < ACTION_BUTTONS; slot++) {
    if (slot === 0) writer.u32(133);                                    // a spell, type 0
    else if (slot === 11) writer.u32((ACTION_BUTTON_ITEM << 24) | 6948); // a hearthstone
    else writer.u32(0);
  }

  const buttons = parseActionButtons(writer.toUint8Array());
  assert.deepEqual(buttons.buttons, [
    { slot: 0, action: 133, type: ACTION_BUTTON_SPELL },
    { slot: 11, action: 6948, type: ACTION_BUTTON_ITEM },
  ]);

  // State 2 clears the bars and carries no slots at all.
  assert.deepEqual(parseActionButtons(new PacketWriter().u8(2).toUint8Array()), { state: 2, buttons: [] });

  // The type rides in the top byte of the same word going back the other way.
  assert.deepEqual([...buildSetActionButton(11, 6948, ACTION_BUTTON_ITEM)], [11, 0x24, 0x1b, 0x00, 0x80]);
  // An empty slot is a zero word, whatever type is passed with it.
  assert.deepEqual([...buildSetActionButton(3, 0, ACTION_BUTTON_ITEM)], [3, 0, 0, 0, 0]);
  assert.throws(() => buildSetActionButton(ACTION_BUTTONS, 1, 0), /out of range/);

  assert.equal(actionPage(0), 0);
  assert.equal(actionPage(23), 1);
  assert.equal(actionSlot(1, 11), 23);
});

test("a threat list is hundredths, and the share is measured against its top", () => {
  const payload = new PacketWriter().packedGuid(CASTER).u32(2)
    .packedGuid(TARGET).u32(12_000)
    .packedGuid(0x55n).u32(4_000)
    .toUint8Array();
  const update = parseThreatUpdate(payload, false);
  assert.equal(update.entries.length, 2);
  assert.equal(update.entries[0].threat, 12_000, "the core multiplies by 100 before sending");

  const tables = new ThreatTables();
  tables.apply(update);
  assert.equal(tables.share(CASTER, TARGET), 1);
  assert.equal(tables.share(CASTER, 0x55n), 1 / 3);
  assert.equal(tables.share(CASTER, 0x66n), undefined, "a unit not on the list has no share");

  // The highest-threat form names who just took the top before the list.
  const highest = parseThreatUpdate(new PacketWriter().packedGuid(CASTER).packedGuid(0x55n).u32(1)
    .packedGuid(0x55n).u32(9_000).toUint8Array(), true);
  assert.equal(highest.highestGuid, 0x55n);

  tables.remove(parseThreatRemove(new PacketWriter().packedGuid(CASTER).packedGuid(TARGET).toUint8Array()));
  assert.equal(tables.share(CASTER, TARGET), undefined);
  tables.clear(CASTER);
  assert.equal(tables.get(CASTER), undefined);
});

test("ordinary threat updates retain the server's current victim across list-size changes", () => {
  // ThreatManager::UpdateVictim emits SMSG_HIGHEST_THREAT_UPDATE only when the victim changes;
  // SendThreatListToClients can then send SMSG_THREAT_UPDATE as references join or leave.
  const tables = new ThreatTables();
  tables.apply(parseThreatUpdate(new PacketWriter()
    .packedGuid(CASTER).packedGuid(TARGET).u32(2)
    .packedGuid(TARGET).u32(10_000)
    .packedGuid(0x55n).u32(8_000)
    .toUint8Array(), true));
  assert.equal(tables.get(CASTER)?.highestGuid, TARGET);

  tables.apply(parseThreatUpdate(new PacketWriter()
    .packedGuid(CASTER).u32(3)
    .packedGuid(TARGET).u32(10_000)
    .packedGuid(0x55n).u32(8_000)
    .packedGuid(0x66n).u32(4_000)
    .toUint8Array(), false));
  assert.equal(tables.get(CASTER)?.highestGuid, TARGET,
    "a third attacker does not change the creature's current victim");

  tables.apply(parseThreatUpdate(new PacketWriter()
    .packedGuid(CASTER).u32(2)
    .packedGuid(0x55n).u32(9_000)
    .packedGuid(0x66n).u32(4_000)
    .toUint8Array(), false));
  assert.equal(tables.get(CASTER)?.highestGuid, undefined,
    "do not retain a victim omitted from a replacement list");
});

test("runes, modifiers, totems, combo points and power updates", () => {
  const runes = parseResyncRunes(new PacketWriter().u32(2).u8(0).u8(255).u8(3).u8(120).toUint8Array());
  // Readiness counts the wrong way round: 255 is ready, and the core sends 255 minus the cooldown.
  assert.deepEqual(runes, [{ type: 0, readiness: 255 }, { type: 3, readiness: 120 }]);

  assert.deepEqual(parseSpellModifier(new PacketWriter().u8(5).u8(14).u32(0xffff_ffec).toUint8Array()),
    { effectIndex: 5, op: 14, value: -20 });

  assert.deepEqual(parseTotemCreated(new PacketWriter().u8(1).u64(CASTER).u32(30_000).u32(8071).toUint8Array()),
    { slot: 1, guid: CASTER, duration: 30_000, spellId: 8071 });

  assert.deepEqual(parseComboPoints(new PacketWriter().packedGuid(TARGET).u8(4).toUint8Array()),
    { guid: TARGET, points: 4 });

  assert.deepEqual(parsePowerUpdate(new PacketWriter().packedGuid(TARGET).u8(1).u32(430).toUint8Array()),
    { guid: TARGET, powerType: 1, value: 430 });
});

test("SMSG_CANCEL_AUTO_REPEAT carries the core's packed guid", () => {
  // The captured packet is exactly two bytes: mask 0x01, then guid byte 0x03.
  assert.equal(parseCancelAutoRepeat(Uint8Array.of(0x01, 0x03)), 3n);
  assert.equal(parseCancelAutoRepeat(new PacketWriter().packedGuid(CASTER).toUint8Array()), CASTER);
  assert.throws(() => parseCancelAutoRepeat(Uint8Array.of(0x01, 0x03, 0x00)), /unread packet bytes/);
});
