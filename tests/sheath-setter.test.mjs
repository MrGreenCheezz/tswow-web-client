import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { SheathSetter } from "../dist/code/world/SheathSetter.js";
import { buildCorpseMapPositionQuery } from "../dist/code/world/DeathProtocol.js";
import { fakeWorldConnection, loginVerifyWorldPacket, settle } from "./fixtures/world-packets.mjs";

/*
 * 5.05 (11.11): Wow.exe's sheath setter 0x00736d30 keeps the state it took (+0xb5c) and sends CMSG_SET_SHEATHED only
 * for another one; no stop calls it — StopAttack 0x006e1660, the swing stop 0x006d5f70, the repeat's stop 0x00807560
 * (.runtime/re-2026-10-11/glue-1110/a505-3.txt, re-2026-10-01/a4-world/d2.c, re-2026-10-04/l12-small/g2.c).
 */

const SELF = 0x1234n;
const VICTIM = 0x5678n;

async function client() {
  const connection = fakeWorldConnection([{ opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: loginVerifyWorldPacket() }]);
  const world = new WorldClient(connection);
  world.state.selfGuid = SELF;
  world.state.move(SELF, { flags: 0, position: { x: 10, y: 20, z: 30, orientation: 0 } });
  await world.loginCharacter(SELF);
  await settle();
  world.state.move(VICTIM, { flags: 0, position: { x: 12, y: 20, z: 30, orientation: 0 } });
  world.state.objects.get(VICTIM).typeId = 3;
  world.state.setField(VICTIM, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  world.selectTarget(VICTIM);
  connection.sent.length = 0;
  const sheaths = () => connection.sentOf(OPCODES.CMSG_SET_SHEATHED).map(({ payload }) => payload[0]);
  return { world, connection, sheaths };
}

test("5.05 (11.11): the setter holds its state — the server's byte until it sends, then its own", () => {
  const setter = new SheathSetter();
  assert.equal(setter.request(1, 1), false, "the blade already out (UNIT_FIELD_BYTES_2): nothing");
  assert.equal(setter.request(1, 0), true);
  assert.equal(setter.held, 1);
  assert.equal(setter.request(1, 0), false, "held 1 — the server's byte no longer speaks");
  assert.equal(setter.request(2, 1), true);
  assert.equal(setter.request(9, 2), true, "an unknown state is the unarmed one, as the packet clamps it");
  assert.equal(setter.held, 0);
});

test("5.05 (11.11): a stop sends no sheath, and the next swing finds the blade out — SHEATH 1 once", async () => {
  const { world, connection, sheaths } = await client();
  world.startAttack();
  world.stopAttack();
  world.startAttack();
  world.stopAttack();
  assert.deepEqual(sheaths(), [1], "one SHEATH 1, no SHEATH 0 on either stop");
  assert.equal(connection.sentOf(OPCODES.CMSG_ATTACK_SWING).length, 2);
  assert.equal(connection.sentOf(OPCODES.CMSG_ATTACK_STOP).length, 2);
  world.close();
});

test("5.05 (11.11): with the server's sheath byte already 1 the swing draws nothing; ToggleSheath goes through the same setter", async () => {
  const { world, sheaths } = await client();
  world.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 1);
  world.startAttack();
  assert.deepEqual(sheaths(), [], "0x00736d30(1, …) with 1 held");
  world.setSheathed(1);
  assert.deepEqual(sheaths(), []);
  world.setSheathed(0);
  world.setSheathed(0);
  assert.deepEqual(sheaths(), [0]);
  world.close();
});

test("5.05 (11.11): swing → shot → swing sends 2 then 1, and a second shot with the bow out sends none", async () => {
  const { world, sheaths } = await client();
  world.knownSpells = [{ id: 75, slot: 0 }];
  world.setAutoRepeatSpellIds([75]);
  world.state.move(VICTIM, { flags: 0, position: { x: 30, y: 20, z: 30, orientation: 0 } });
  world.castSpell(75);
  world.castSpell(75); // the cancel: CMSG_CANCEL_AUTO_REPEAT_SPELL alone
  world.castSpell(75);
  assert.deepEqual(sheaths(), [2], "the bow drawn once");
  world.startAttack();
  assert.deepEqual(sheaths(), [2, 1]);
  world.close();
});

test("5.05 (11.11): sitting puts the weapon away — 0x006dcb40 / SMSG_STANDSTATE_UPDATE → 0x0073f060; a chair (2) does not", async () => {
  const { world, connection, sheaths } = await client();
  world.startAttack();
  world.stopAttack();
  connection.sent.length = 0;
  world.setStandState(2);
  assert.deepEqual(sheaths(), [], "a chair keeps the blade");
  world.setStandState(1);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_STANDSTATECHANGE, OPCODES.CMSG_STANDSTATECHANGE,
    OPCODES.CMSG_SET_SHEATHED], "the request, then the sheath");
  assert.deepEqual(sheaths(), [0]);
  world.setStandState(3);
  assert.deepEqual(sheaths(), [0], "already away: nothing");
  world.setStandState(0);
  world.startAttack();
  assert.deepEqual(sheaths(), [0, 1], "the next swing draws it again");
  connection.push(OPCODES.SMSG_STANDSTATE_UPDATE, new Uint8Array([8])); // the realm kneels the player (KNEEL)
  await settle();
  assert.deepEqual(sheaths(), [0, 1, 0]);
  world.close();
});

test("5.05 (11.11): a SPELL_ATTR0_RANGED spell draws the bow after its packet (0x00805330 → 0x007fa2e0); another spell draws nothing", async () => {
  const { world, connection, sheaths } = await client();
  const { setPetSpellAttributesSource } = await import("../dist/code/world/PetCastSpell.js");
  const attributes = new Map([[3044, [0x10002, 0, 0x20000, 0, 0, 0, 0, 0]], [133, [0x10000, 0, 0, 0, 0, 0, 0, 0]]]);
  setPetSpellAttributesSource((spellId) => attributes.get(spellId));
  try {
    world.knownSpells = [{ id: 3044, slot: 0 }, { id: 133, slot: 1 }];
    world.castSpell(133);
    assert.deepEqual(sheaths(), [], "Fireball: no sheath");
    world.castSpell(3044);
    const opcodes = connection.sent.map(({ opcode }) => opcode);
    assert.deepEqual(opcodes.slice(-2), [OPCODES.CMSG_CAST_SPELL, OPCODES.CMSG_SET_SHEATHED], "Arcane Shot, then the bow");
    assert.deepEqual(sheaths(), [2]);
    world.castSpell(3044);
    assert.deepEqual(sheaths(), [2], "the bow already out");
  } finally {
    setPetSpellAttributesSource(undefined);
  }
  world.close();
});

test("5.25 (11.11): CMSG_CORPSE_MAP_POSITION_QUERY is one u32, the guid's low word (0x0051f430, QueryHandler.cpp:360)", () => {
  assert.deepEqual([...buildCorpseMapPositionQuery(0xf000_0000_0000_1234n)], [0x34, 0x12, 0, 0]);
  assert.deepEqual([...buildCorpseMapPositionQuery(0x8765_4321n)], [0x21, 0x43, 0x65, 0x87]);
});
