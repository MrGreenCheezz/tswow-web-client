import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { GLOBAL_STRING_DATA_AVAILABLE, globalString } from "../dist/code/generated/globalStrings.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { spellFailureText } from "../dist/code/world/SpellProtocol.js";
import { setPetSpellAttributesSource } from "../dist/code/world/PetCastSpell.js";
import { setMissileShotSource } from "../dist/code/world/MissileCast.js";
import {
  castFailureErrorRowName, castFailureErrorRowIsInfo, castFailureErrorText, petCastFailureErrorText, powerTokenName,
} from "../dist/code/world/CastFailureErrorRow.js";
import { mountedCastRule, SPELL_ATTR0_CASTABLE_WHILE_MOUNTED, SPELL_FAILED_NOT_MOUNTED } from "../dist/code/world/MountedCastRule.js";
import { castFailedPacket, fakeWorldConnection, loginVerifyWorldPacket, settle } from "./fixtures/world-packets.mjs";

/*
 * 3.47 (11.11): the error frame's words for every result of Wow.exe 0x00807f10 (CastFailureErrorRow.ts), the pet's
 * refusal 0x00805610 (SMSG_PET_CAST_FAILED → 0x00806c30), the refused missile's UNIT_SPELLCAST_FAILED, and 5.05
 * (11.11): the mounted cast of 0x0080ac90 (MountedCastRule.ts). Notes: .runtime/re-2026-10-04/l12-small/g2.c, g3.c;
 * .runtime/re-2026-10-02/a2-m8/d2.c; .runtime/re-2026-11-11/combat/d1.c, d2.c, l3.lst.
 */

const SELF = 0x1234n;
const PET = 0xf140_0000_0000_0077n;
const strings = { skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no generated GlobalStrings in this checkout" };
const words = (name) => globalString(name);

async function client() {
  const connection = fakeWorldConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() }]);
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  await world.loginCharacter(SELF);
  await settle();
  const status = [];
  world.onSpellStatus = (text, error) => status.push({ text, error });
  return { world, connection, status };
}

test("3.47 (11.11): 0x00807f10's rows by result and by the row's Targets", () => {
  assert.equal(castFailureErrorRowName(2, undefined), "ERR_SPELL_FAILED_ALREADY_AT_FULL_HEALTH");
  assert.equal(castFailureErrorRowName(3, undefined), "ERR_SPELL_FAILED_ALREADY_AT_FULL_MANA");
  assert.equal(castFailureErrorRowName(11, undefined), "ERR_GENERIC_NO_TARGET");
  assert.equal(castFailureErrorRowName(12, { targets: 0x10 }), "ERR_INVALID_ITEM_TARGET");
  assert.equal(castFailureErrorRowName(12, { targets: 0x20000 }), "ERR_INVALID_GLYPH_SLOT");
  assert.equal(castFailureErrorRowName(12, { targets: 0 }), "ERR_SPELL_FAILED_S");
  assert.equal(castFailureErrorRowName(97, undefined), "ERR_SPELL_OUT_OF_RANGE");
  assert.equal(castFailureErrorRowName(178, undefined), "ERR_GENERIC_NO_VALID_TARGETS");
  assert.equal(castFailureErrorRowName(67, { attributes: [0x10] }), "ERR_ABILITY_COOLDOWN", "the cooldown rows stay");
  assert.equal(castFailureErrorRowName(47, undefined), "ERR_SPELL_FAILED_S", "LINE_OF_SIGHT: the general row");
  // 0x00808200 case 0x55: the PowerType's row of 0x00a439c8, -2 health.
  assert.equal(castFailureErrorRowName(85, { powerType: 1 }), "ERR_OUT_OF_RAGE");
  assert.equal(castFailureErrorRowName(85, { powerType: -2 }), "ERR_OUT_OF_HEALTH");
  assert.equal(castFailureErrorRowName(85, undefined), "ERR_SPELL_FAILED_S", "no row: the sentence");
  assert.equal(castFailureErrorRowIsInfo(72), true, "NOT_UNSHEATHED is a type 1 row");
  assert.equal(castFailureErrorRowIsInfo(2), false);
});

test("3.47 (11.11): the words — a %s row says the sentence, another row its own words, FULL_POWER the power's name", strings, () => {
  assert.equal(castFailureErrorText(2, undefined, "x"), words("ERR_SPELL_FAILED_ALREADY_AT_FULL_HEALTH"));
  assert.equal(castFailureErrorText(47, undefined, "Цель вне поля зрения."), "Цель вне поля зрения.");
  assert.equal(castFailureErrorText(47, undefined, undefined), undefined, "a %s row with nothing to say");
  assert.equal(castFailureErrorText(4, undefined, "s", "Ярость"), "Ярость дальнейшему усилению не подлежит.");
  assert.equal(castFailureErrorText(4, undefined, "s"), "s", "no power name in this page's strings: the sentence");
  assert.equal(petCastFailureErrorText(97, undefined, "s"), words("ERR_PET_SPELL_OUT_OF_RANGE"));
  assert.equal(petCastFailureErrorText(67, { category: 4, attributes: [0] }, "s"), words("ERR_SPELL_COOLDOWN"),
    "the pet's cooldown has no potion row");
  assert.equal(petCastFailureErrorText(85, { powerType: 2 }, "s"), words("ERR_OUT_OF_FOCUS"));
  assert.equal(petCastFailureErrorText(172, undefined, "s"), undefined, "a custom error says nothing");
  assert.equal(petCastFailureErrorText(47, undefined, "Цель вне поля зрения."), "Цель вне поля зрения.");
});

test("3.47 (11.11): SMSG_CAST_FAILED says 0x00807f10's row — FULL_HEALTH, an item target, the rage it lacks", strings, async () => {
  const { world, connection, status } = await client();
  const rows = new Map([[100, { targets: 0x10 }], [101, { powerType: 1 }]]);
  world.spellCooldownRow = (spellId) => rows.get(spellId);
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: 99, result: 2 }));
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 2, spellId: 100, result: 12 }));
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 3, spellId: 101, result: 85 }));
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 4, spellId: 102, result: 12 }));
  await settle();
  assert.deepEqual(status.map(({ text }) => text), [
    words("ERR_SPELL_FAILED_ALREADY_AT_FULL_HEALTH"), words("ERR_INVALID_ITEM_TARGET"), words("ERR_OUT_OF_RAGE"),
    spellFailureText(12),
  ]);
  world.close();
});

test("3.47 (11.11): NOT_UNSHEATHED's type-1 row reaches the screen as an info message, the others as errors", strings, async () => {
  const { world, connection } = await client();
  const status = [];
  world.onSpellStatus = (text, error, info) => status.push({ text, error, info: info === true });
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: 99, result: 72 }));
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 2, spellId: 98, result: 2 }));
  await settle();
  assert.deepEqual(status, [
    { text: words("ERR_SPELL_FAILED_NOTUNSHEATHED"), error: false, info: true },
    { text: words("ERR_SPELL_FAILED_ALREADY_AT_FULL_HEALTH"), error: true, info: false },
  ]);
  world.close();
});

test("3.47 (11.11): ALREADY_AT_FULL_POWER names the player's power from the client's strings (0x007fe4b0)", strings, async () => {
  assert.equal(powerTokenName(1), globalString("RAGE"));
  assert.ok(powerTokenName(0), "MANA is in the generated subset");
  assert.equal(powerTokenName(7), undefined, "a type past 6 has no name");
  const { world, connection, status } = await client();
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 << 24);
  connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 1, spellId: 99, result: 4 }));
  await settle();
  assert.deepEqual(status.map(({ text }) => text), [castFailureErrorText(4, undefined, "s", globalString("RAGE"))]);
  world.close();
});

test("3.47 (11.11): SMSG_PET_CAST_FAILED — the pet's row without a prefix, and UNIT_SPELLCAST_FAILED for the pet", strings, async () => {
  const { world, connection } = await client();
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset, Number(PET & 0xffff_ffffn));
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset + 1, Number(PET >> 32n));
  const messages = [];
  const results = [];
  world.events.on("PET_MESSAGE", (message) => messages.push(message.text));
  world.events.on("SPELL_CAST_RESULT", (result) => results.push(result));
  connection.push(OPCODES.SMSG_PET_CAST_FAILED, castFailedPacket({ castCount: 7, spellId: 17253, result: 97 }));
  await settle();
  assert.deepEqual(messages, [words("ERR_PET_SPELL_OUT_OF_RANGE")]);
  assert.equal(results.length, 1);
  assert.equal(results[0].casterGuid, PET);
  assert.equal(results[0].castCount, 7);
  assert.equal(results[0].result, 97);
  assert.equal(results[0].refusal, undefined, "0x00805610 writes no combat log line");
  world.close();
});

test("3.47 (11.11): a refused missile is UNIT_SPELLCAST_FAILED with a cast count of its own (0x00809f80 → 0x00808200)", async () => {
  const { world } = await client();
  world.knownSpells = [{ id: 555, slot: 0 }];
  setMissileShotSource({ prime() {}, trajectoryMissile: (spellId) => (spellId === 555 ? {} : undefined), shot: () => undefined });
  const refusals = [];
  world.events.on("SPELL_CAST_REFUSED_LOCAL", (refusal) => refusals.push(refusal));
  try {
    world.castSpell(555);
    world.castSpell(555);
  } finally {
    setMissileShotSource(undefined);
  }
  assert.equal(refusals.length, 2);
  assert.equal(refusals[0].result, 32, "SPELL_FAILED_ERROR: no trajectory");
  assert.equal(refusals[0].casterGuid, SELF);
  assert.equal(typeof refusals[0].castCount, "number");
  assert.notEqual(refusals[0].castCount, 0);
  assert.equal(refusals[1].castCount, (refusals[0].castCount + 1) & 0xff, "each refused request draws its count");
  world.close();
});

test("5.05 (11.11): 0x0080ac90's mounted cast — keep, dismount, or refuse NOT_MOUNTED", () => {
  assert.equal(mountedCastRule(SPELL_ATTR0_CASTABLE_WHILE_MOUNTED, 0, 0, true, false), "keep");
  assert.equal(mountedCastRule(0x50012, 0, 0, true, false), "dismount", "Auto Shot's Attributes: no CASTABLE_WHILE_MOUNTED");
  assert.equal(mountedCastRule(0, 0, 0x2000000, true, false), "refuse", "flying without autoDismountFlying");
  assert.equal(mountedCastRule(0, 0, 0x2000000, true, true), "dismount");
  assert.equal(mountedCastRule(0, 0x100000, 0, true, true), "refuse", "a taxi");
  assert.equal(mountedCastRule(0, 0, 0, false, false), "refuse", "autoDismount off");
});

test("5.05 (11.11): a mounted Auto Shot dismounts; in flight it is refused with nothing sent; CASTABLE_WHILE_MOUNTED keeps the horse", async () => {
  const { world, connection } = await client();
  world.knownSpells = [{ id: 75, slot: 0 }, { id: 9999, slot: 1 }];
  world.setAutoRepeatSpellIds([75]);
  const attributes = new Map([[75, [0x50012, 0, 0x20, 0, 0x1000001, 0, 0, 0]], [9999, [SPELL_ATTR0_CASTABLE_WHILE_MOUNTED, 0, 0, 0, 0, 0, 0, 0]]]);
  setPetSpellAttributesSource((spellId) => attributes.get(spellId));
  const victim = 0x5678n;
  world.state.move(victim, { flags: 0, position: { x: 30, y: 20, z: 30, orientation: 0 } });
  world.state.objects.get(victim).typeId = 3;
  world.state.setField(victim, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  world.selectTarget(victim);
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 2410);
  // 5.05 (11.11): a bow in the ranged slot — 0x0080cce0 refuses a RANGED spell without one (CastPreflightRule.ts).
  const BOW = 0x4000_0000_0000_0042n;
  world.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 34, Number(BOW & 0xffff_ffffn));
  world.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 35, Number(BOW >> 32n));
  world.state.setField(BOW, UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset, 0);
  const refusals = [];
  world.events.on("SPELL_CAST_REFUSED_LOCAL", (refusal) => refusals.push(refusal));
  const names = () => connection.sent.map(({ opcode }) => Object.keys(OPCODES).find((name) => OPCODES[name] === opcode));
  try {
    connection.sent.length = 0;
    world.castSpell(9999);
    assert.equal(names().includes("CMSG_CANCEL_MOUNT_AURA"), false, "CASTABLE_WHILE_MOUNTED: no dismount");

    world.state.move(SELF, { flags: 0x2000000, position: { x: 10, y: 20, z: 30, orientation: 0 } });
    connection.sent.length = 0;
    world.castSpell(75);
    assert.deepEqual(names(), [], "in flight: nothing on the wire");
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].result, SPELL_FAILED_NOT_MOUNTED);
    assert.equal(world.autoRepeatSpellId, undefined);

    world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
    connection.sent.length = 0;
    world.castSpell(75);
    assert.deepEqual(names(), ["CMSG_CANCEL_MOUNT_AURA", "CMSG_CAST_SPELL", "CMSG_SET_SHEATHED"], "on the ground: dismount, then the shot");
  } finally {
    setPetSpellAttributesSource(undefined);
  }
  world.close();
});
