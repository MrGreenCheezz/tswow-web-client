// 5.05 (11.11): the client's own refusals of the player's cast before it is sent, Wow.exe 0x0080cce0 / 0x0080ac90
// (CastPreflightRule.ts; .runtime/re-2026-11-11/worldtails/w1.c, w2.c): PLAYER_FLAGS → CANT_DO_THAT_RIGHT_NOW (0xad),
// a dead caster → CASTER_DEAD (0x17) unless CASTABLE_WHILE_DEAD, a ranged spell without a usable ranged item →
// EQUIPPED_ITEM (0x1c), a seated caster → stand up with autoStand, else NOT_STANDING (0x45).
import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { setPetSpellAttributesSource } from "../dist/code/world/PetCastSpell.js";
import {
  castPreflightRefusal, rangedItemUsable, sittingCastRule, vehicleSeatRefused,
  SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW, SPELL_FAILED_CASTER_DEAD, SPELL_FAILED_EQUIPPED_ITEM, SPELL_FAILED_NOT_STANDING,
} from "../dist/code/world/CastPreflightRule.js";
import { fakeWorldConnection, loginVerifyWorldPacket, settle } from "./fixtures/world-packets.mjs";

const SELF = 0x1234n;
const BOW = 0x4000_0000_0000_0042n;
const alive = { health: 100, playerFlags: 0, rangedItem: undefined };
const spell = (attributes0 = 0, extra = {}) => ({ attributes: [attributes0, extra.ex ?? 0, extra.ex2 ?? 0], effect0: extra.effect0 });

test("0x0080cce0: PLAYER_FLAGS 0x1000000 refuses an attack spell, ALLOW_ONLY_ABILITY anything else", () => {
  const noMelee = { ...alive, playerFlags: 0x1000000 };
  assert.equal(castPreflightRefusal(spell(0, { effect0: 78 }), noMelee), SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW, "Effect ATTACK");
  assert.equal(castPreflightRefusal(spell(0x400), noMelee), SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW, "on next swing (0x007fcc70)");
  assert.equal(castPreflightRefusal(spell(0, { ex2: 0x20 }), noMelee), SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW, "auto repeat");
  assert.equal(castPreflightRefusal(spell(0), noMelee), undefined, "a plain spell goes on");
  const onlyAbility = { ...alive, playerFlags: 0x800000 };
  assert.equal(castPreflightRefusal(spell(0), onlyAbility), SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW, "Bladestorm: no spells");
  assert.equal(castPreflightRefusal(spell(0, { effect0: 78 }), onlyAbility), undefined, "but the attacks");
});

test("0x0080cce0: dead or a ghost is CASTER_DEAD unless CASTABLE_WHILE_DEAD; the order puts 0xad first", () => {
  assert.equal(castPreflightRefusal(spell(0), { ...alive, health: 0 }), SPELL_FAILED_CASTER_DEAD);
  assert.equal(castPreflightRefusal(spell(0), { ...alive, health: 1, playerFlags: 0x10 }), SPELL_FAILED_CASTER_DEAD, "a ghost (0x006dac10)");
  assert.equal(castPreflightRefusal(spell(0x800000), { ...alive, health: 0 }), undefined);
  assert.equal(castPreflightRefusal(spell(0), { ...alive, health: 0, playerFlags: 0x800000 }), SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW);
});

test("0x0080cce0 / 0x006d71a0: a RANGED spell needs a ranged item that is not broken", () => {
  assert.equal(castPreflightRefusal(spell(0x2), alive), SPELL_FAILED_EQUIPPED_ITEM, "no item in slot 17");
  const bow = { flags: 0, durability: 40, maxDurability: 75 };
  assert.equal(castPreflightRefusal(spell(0x2), { ...alive, rangedItem: bow }), undefined);
  assert.equal(rangedItemUsable({ flags: 0, durability: 0, maxDurability: 75 }), false, "broken");
  assert.equal(rangedItemUsable({ flags: 0, durability: 0, maxDurability: 0 }), true, "no durability: a thrown stack");
  assert.equal(rangedItemUsable({ flags: 0x8, durability: 0, maxDurability: 75 }), true, "wrapped");
  assert.equal(rangedItemUsable({ flags: 0x10, durability: 40, maxDurability: 75 }), false, "flag 0x10");
  assert.equal(castPreflightRefusal(spell(0x2), { ...alive, health: 0 }), SPELL_FAILED_CASTER_DEAD, "dead before the item");
});

// 11.02 (15.11, vehicle8): refusal 0b — the passenger's seat Flags against what the spell asks (0x0080cce0 → 0x00800950,
// 0x007fde50). Seat Flags from the dataset's VehicleSeat.dbc: 3588 (Vehicle 370) 0x200c40d has CAN_ATTACK 0x4000; 2963
// (Vehicle 332) 0x200a00f has UNCONTROLLED 0x2000 and not CAN_ATTACK. The spell rows are made up for the bits they carry.
const SEAT_3588 = { flags: 0x200c40d };
const SEAT_2963 = { flags: 0x200a00f };
const seatSpell = (over = {}) => ({ attributes: [over.attr0 ?? 0, 0, 0, 0, 0, 0, over.attr6 ?? 0, 0], effect0: 0,
  effectAura: over.auras ?? [0, 0, 0], shapeshiftFormFlags: over.formFlags });

test("0x0080cce0 0b: a passenger's spell needs CAN_ATTACK of its seat, a form UNCONTROLLED, a mount CAN_CAST_MOUNT_SPELL", () => {
  assert.equal(vehicleSeatRefused(seatSpell(), SEAT_3588), false, "a plain spell on an attack seat");
  assert.equal(vehicleSeatRefused(seatSpell(), SEAT_2963), true, "a plain spell on a seat without CAN_ATTACK");
  assert.equal(vehicleSeatRefused(seatSpell(), undefined), false, "no seat row: no test");
  assert.equal(vehicleSeatRefused(seatSpell({ attr6: 0x1000 }), SEAT_2963), false, "CASTABLE_WHILE_ON_VEHICLE");
  assert.equal(vehicleSeatRefused(seatSpell({ attr0: 0x1000000 }), SEAT_2963), false, "CASTABLE_WHILE_MOUNTED");
  // MOD_SHAPESHIFT (36) to a form without Flags 0x1, or one the table lacks: UNCONTROLLED; with 0x1: not asked, so CAN_ATTACK.
  assert.equal(vehicleSeatRefused(seatSpell({ auras: [36, 0, 0], formFlags: 0 }), SEAT_2963), false);
  assert.equal(vehicleSeatRefused(seatSpell({ auras: [36, 0, 0], formFlags: 0 }), SEAT_3588), true, "no UNCONTROLLED on 3588");
  assert.equal(vehicleSeatRefused(seatSpell({ auras: [0, 36, 0] }), SEAT_2963), false, "a form with no row asks UNCONTROLLED");
  assert.equal(vehicleSeatRefused(seatSpell({ auras: [36, 0, 0], formFlags: 0x1 }), SEAT_2963), true, "a flag-0x1 form asks CAN_ATTACK");
  // MOUNTED (78): CAN_CAST_MOUNT_SPELL, which no seat of the dataset has.
  assert.equal(vehicleSeatRefused(seatSpell({ auras: [78, 0, 0] }), SEAT_3588), true);
  assert.equal(vehicleSeatRefused(seatSpell({ auras: [78, 0, 0] }), { flags: 0x1000 }), false);
  assert.equal(vehicleSeatRefused(seatSpell({ auras: [78, 36, 0], formFlags: 0 }), { flags: 0x1000 }), true, "both asked");
  // In the rule's order: after the override row, before PLAYER_FLAGS.
  assert.equal(castPreflightRefusal(seatSpell(), { ...alive, seat: SEAT_2963 }), SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW);
  assert.equal(castPreflightRefusal(seatSpell(), { ...alive, seat: SEAT_3588 }), undefined);
});

test("0x0080ac90: seated — go with CASTABLE_WHILE_SITTING, stand up with autoStand, else NOT_STANDING", () => {
  assert.equal(sittingCastRule(0, 0, false), "go");
  assert.equal(sittingCastRule(0x8000000, 1, false), "go");
  assert.equal(sittingCastRule(0, 1, true), "stand");
  assert.equal(sittingCastRule(0, 1, false), "refuse");
});

async function client() {
  const connection = fakeWorldConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() }]);
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  await world.loginCharacter(SELF);
  await settle();
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  const names = () => connection.sent.map(({ opcode }) => Object.keys(OPCODES).find((name) => OPCODES[name] === opcode));
  const refusals = [];
  world.events.on("SPELL_CAST_REFUSED_LOCAL", (refusal) => refusals.push(refusal.result));
  return { world, connection, names, refusals };
}

test("WorldClient: a seated cast stands up first; without autoStand, or dead, or bowless, nothing is sent", async () => {
  const { world, connection, names, refusals } = await client();
  const attributes = new Map([[133, [0x10000, 0, 0, 0, 0, 0, 0, 0]], [3044, [0x10002, 0, 0x20000, 0, 0, 0, 0, 0]]]);
  setPetSpellAttributesSource((spellId) => attributes.get(spellId));
  world.knownSpells = [{ id: 133, slot: 0 }, { id: 3044, slot: 1 }];
  try {
    world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset, 1); // sitting
    connection.sent.length = 0;
    world.castSpell(133);
    assert.deepEqual(names(), ["CMSG_STANDSTATECHANGE", "CMSG_CAST_SPELL"], "autoStand: up, then the cast");
    world.autoStand = () => false;
    connection.sent.length = 0;
    world.castSpell(133);
    assert.deepEqual(names(), [], "autoStand off: refused");
    assert.deepEqual(refusals, [SPELL_FAILED_NOT_STANDING]);
    world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset, 0);
    world.castSpell(3044);
    assert.deepEqual(names(), [], "Arcane Shot without a bow");
    assert.deepEqual(refusals, [SPELL_FAILED_NOT_STANDING, SPELL_FAILED_EQUIPPED_ITEM]);
    world.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 34, Number(BOW & 0xffff_ffffn));
    world.state.setField(SELF, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 35, Number(BOW >> 32n));
    world.state.setField(BOW, UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset, 0);
    world.castSpell(3044);
    assert.equal(names()[0], "CMSG_CAST_SPELL", "with the bow it goes out");
    world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
    connection.sent.length = 0;
    world.castSpell(133);
    assert.deepEqual(names(), [], "dead");
    assert.equal(refusals.at(-1), SPELL_FAILED_CASTER_DEAD);
  } finally {
    setPetSpellAttributesSource(undefined);
  }
  world.close();
});
