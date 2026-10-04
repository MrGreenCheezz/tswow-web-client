import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

/**
 * WORK_PLAN 5.05: the swing and the selection are two things, and a target change carries the
 * swing — as Wow.exe 3.3.5a (12340) does (.runtime/re-2026-10-01/a9-combat/):
 * * SetTarget 0x524bf0: the same guid again returns at once; otherwise 0x5241b0 ends the old swing
 *   (0x6e1660 → CMSG_ATTACKSTOP 0x7559e0), the selection moves, and with the CVar
 *   stopAutoAttackOnTargetChange at its default "0" (registered at 0x51dc1c, pointer 0x00bd0924) a
 *   player who was fighting attacks the new target (0x6e4950 → 0x6e2610: CMSG_ATTACKSWING) when
 *   CanAttack allows it. With the CVar on, the repeating spell is cancelled (0x807560, 0x26d).
 * * SMSG_ATTACKSTART (0x756800 case 0x143) stores the victim on the unit (+0xa20) and leaves the
 *   selection (0x00bd07b0) alone.
 * * 0x6e4950: mounted (+0x9c0) — out of melee reach is ERR_OUT_OF_RANGE, else CMSG_CANCEL_MOUNT_AURA
 *   (0x7412e0) before the swing; CanAttack refuses a mount in flight unless autoDismountFlying
 *   (default "0"): ERR_ATTACK_MOUNTED (0x72bdb0/0x71b0c0). 0x6e2610 stands a seated player up
 *   (0x6dcb40(0), CMSG_STANDSTATECHANGE) before CMSG_ATTACKSWING.
 */

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

const SELF = 0x1234n;
const A = 9n;
const B = 10n;
const FRIEND = 11n;
/** TARGET_FLAG_UNIT (SpellProtocol.ts), written after count, spell id and cast flags. */
const TARGET_FLAG_UNIT = 0x2;

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(SELF).typeId = 4;
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8);
  for (const guid of [A, B, FRIEND]) {
    client.state.move(guid, { flags: 0, position: { x: 2, y: 0, z: 0, orientation: 0 } });
    client.state.objects.get(guid).typeId = 3;
    client.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  }
  // The browser decides reactions; this stands in for it: FRIEND is friendly, the rest are not.
  client.canAttackUnit = (object) => object.guid !== FRIEND && object.guid !== SELF;
  return { client, connection };
}

const attackStart = (attacker, victim) => new PacketWriter().u64(attacker).u64(victim).toUint8Array();
const opcodes = (connection) => connection.sent.map(({ opcode }) => opcode);
const swingTargets = (connection) => connection.sent
  .filter(({ opcode }) => opcode === OPCODES.CMSG_ATTACK_SWING)
  .map(({ payload }) => new DataView(payload.buffer, payload.byteOffset).getBigUint64(0, true));

test("5.05 SMSG_ATTACK_START names the victim and leaves the player's selection alone", async () => {
  const { client, connection } = await loggedIn();
  client.selectTarget(A);
  client.startAttack();
  assert.equal(client.attackVictim, A, "0x98e540 stores the victim with the request");
  // The server answers for A, but the player has meanwhile clicked a friend (CVar 0: the swing stops).
  client.selectTarget(FRIEND);
  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
  await settle();
  assert.equal(client.targetGuid, FRIEND, "0x756800 case 0x143 never writes the selection");
  assert.equal(client.attackVictim, A);
  assert.equal(client.attacking, true);
  client.close();
});

test("5.05 a target change carries the swing to an attackable unit", async () => {
  const { client, connection } = await loggedIn();
  client.selectTarget(A);
  client.startAttack();
  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
  await settle();
  connection.sent.length = 0;

  client.selectTarget(B);
  const sent = opcodes(connection);
  assert.equal(sent[0], OPCODES.CMSG_ATTACK_STOP, "0x5241b0 → 0x6e1660 ends the old swing first");
  assert.ok(sent.indexOf(OPCODES.CMSG_SET_SELECTION) < sent.indexOf(OPCODES.CMSG_ATTACK_SWING));
  assert.deepEqual(swingTargets(connection), [B], "0x6e4950 → 0x6e2610 swings at the new target");
  assert.equal(sent.includes(OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), false);
  assert.equal(client.targetGuid, B);
  assert.equal(client.attackVictim, B);
  assert.equal(client.attackRequested, true);
  client.close();
});

test("5.05 choosing the same target again changes nothing on the wire", async () => {
  const { client, connection } = await loggedIn();
  client.selectTarget(A);
  client.startAttack();
  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
  await settle();
  connection.sent.length = 0;
  client.selectTarget(A);
  assert.deepEqual(connection.sent, [], "0x524bf0 returns for the guid already selected");
  assert.equal(client.attacking, true);
  client.close();
});

test("5.05 a friendly target, or the CVar, stops the swing instead", async () => {
  for (const variant of ["friendly", "cvar"]) {
    const { client, connection } = await loggedIn();
    if (variant === "cvar") client.stopAutoAttackOnTargetChange = () => true;
    client.selectTarget(A);
    client.startAttack();
    connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
    await settle();
    connection.sent.length = 0;
    client.selectTarget(variant === "friendly" ? FRIEND : B);
    assert.equal(opcodes(connection)[0], OPCODES.CMSG_ATTACK_STOP, variant);
    assert.deepEqual(swingTargets(connection), [], variant);
    assert.equal(client.attacking, false, variant);
    assert.equal(client.attackRequested, false, variant);
    assert.equal(client.attackVictim, undefined, variant);
    client.close();
  }
});

test("5.05 a target change with no swing running starts none", async () => {
  const { client, connection } = await loggedIn();
  client.selectTarget(A);
  connection.sent.length = 0;
  client.selectTarget(B);
  assert.deepEqual(opcodes(connection), [OPCODES.CMSG_SET_SELECTION]);
  client.close();
});

test("5.05 the repeating shot follows an attackable new target and stops for anything else", async () => {
  for (const variant of ["follow", "friendly", "cvar"]) {
    const { client, connection } = await loggedIn();
    if (variant === "cvar") client.stopAutoAttackOnTargetChange = () => true;
    client.setAutoRepeatSpellIds([75]);
    client.knownSpells = [{ id: 75, slot: 0 }];
    client.selectTarget(A);
    client.castSpell(75);
    assert.equal(client.autoRepeatSpellId, 75, variant);
    connection.sent.length = 0;
    client.selectTarget(variant === "friendly" ? FRIEND : B);
    const sent = opcodes(connection);
    if (variant === "follow") {
      // HandleCastSpellOpcode re-aims a running Auto Shot when the unit target differs
      // (SpellHandler.cpp:384-396); no cancel goes first.
      assert.equal(sent.includes(OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), false);
      const cast = connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_CAST_SPELL);
      assert.ok(cast, "the repeat is aimed at the new target");
      const expected = new PacketWriter().u32(TARGET_FLAG_UNIT).packedGuid(B).toUint8Array();
      assert.deepEqual(cast.payload.slice(6), expected);
      assert.equal(client.autoRepeatSpellId, 75);
    } else {
      assert.equal(sent.includes(OPCODES.CMSG_CANCEL_AUTO_REPEAT_SPELL), true, variant);
      assert.equal(sent.includes(OPCODES.CMSG_CAST_SPELL), false, variant);
      assert.equal(client.autoRepeatSpellId, undefined, variant);
    }
    client.close();
  }
});

test("5.05 a mounted player dismounts to swing, but only in reach and not in flight", async () => {
  for (const variant of ["reach", "far", "flying"]) {
    const { client, connection } = await loggedIn();
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 14_000);
    // Placed, not moved: `move` glides a short hop instead of jumping there.
    if (variant === "far") client.state.objects.get(A).position = { x: 12, y: 0, z: 0, orientation: 0 };
    if (variant === "flying") client.state.objects.get(SELF).movementFlags = 0x02000000;
    const said = [];
    client.onCombatStatus = (message, _attacking, error) => { if (error) said.push(message); };
    client.selectTarget(A);
    connection.sent.length = 0;
    client.startAttack();
    const sent = opcodes(connection);
    if (variant === "reach") {
      assert.ok(sent.includes(OPCODES.CMSG_CANCEL_MOUNT_AURA));
      assert.ok(sent.indexOf(OPCODES.CMSG_CANCEL_MOUNT_AURA) < sent.indexOf(OPCODES.CMSG_ATTACK_SWING));
    } else {
      assert.deepEqual(sent, [], variant);
      assert.equal(client.attackRequested, false, variant);
      assert.equal(said.length, 1, variant);
    }
    client.close();
  }
});

test("5.05 a seated player stands up before the swing", async () => {
  const { client, connection } = await loggedIn();
  client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset, 1);
  client.selectTarget(A);
  connection.sent.length = 0;
  client.startAttack();
  const sent = opcodes(connection);
  const stand = connection.sent.find(({ opcode }) => opcode === OPCODES.CMSG_STANDSTATECHANGE);
  assert.ok(stand, "0x6e2610 → 0x6dcb40(0)");
  assert.equal(stand.payload[0], 0);
  assert.ok(sent.indexOf(OPCODES.CMSG_STANDSTATECHANGE) < sent.indexOf(OPCODES.CMSG_ATTACK_SWING));
  client.close();
});

test("5.05 the swing stops when its victim dies, whatever is selected", async () => {
  const { client, connection } = await loggedIn();
  client.selectTarget(A);
  client.startAttack();
  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
  await settle();
  // The server moved the swing elsewhere than the selection (a charge, a script): victim A, selected B.
  client.targetGuid = B;
  client.state.setField(A, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 0);
  connection.sent.length = 0;
  connection.push(OPCODES.SMSG_AI_REACTION, new PacketWriter().u64(0x9abcn).u32(0).toUint8Array());
  await settle();
  assert.equal(client.attacking, false);
  assert.ok(opcodes(connection).includes(OPCODES.CMSG_ATTACK_STOP));
  assert.equal(client.targetGuid, B);
  client.close();
});

/*
 * Review of 5.05 (02.10) — findings in the shared WorldClient.ts, recorded as todo until its owner
 * changes it. Both are run on every test pass; a todo failure does not fail the file.
 */

test("5.05 review: the action-bar Attack (6603) obeys the mounted rules of startAttack", {
}, async () => {
  for (const variant of ["reach", "far", "flying"]) {
    const { client, connection } = await loggedIn();
    client.state.setField(SELF, UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, 14_000);
    if (variant === "far") client.state.objects.get(A).position = { x: 12, y: 0, z: 0, orientation: 0 };
    if (variant === "flying") client.state.objects.get(SELF).movementFlags = 0x02000000;
    client.selectTarget(A);
    connection.sent.length = 0;
    client.castSpell(6603);
    const dismounts = opcodes(connection).filter((opcode) => opcode === OPCODES.CMSG_CANCEL_MOUNT_AURA).length;
    // 0x6e4950/0x729a70: one dismount in melee reach; none out of reach (ERR_OUT_OF_RANGE) or in
    // flight with autoDismountFlying "0" — a dismount there drops the player out of the sky.
    assert.equal(dismounts, variant === "reach" ? 1 : 0, variant);
    client.close();
  }
});

test("5.05 review: a swing carried to a new target does not turn the character", {
  todo: "WorldClient.selectTarget → startAttack → faceTarget sends MSG_MOVE_SET_FACING on every carried target change; 0x6e2610 builds no facing packet of its own (0x736d30/0x72ed80 not decompiled)",
}, async () => {
  const { client, connection } = await loggedIn();
  client.state.objects.get(B).position = { x: -2, y: 0, z: 0, orientation: 0 };
  client.selectTarget(A);
  client.startAttack();
  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, A));
  await settle();
  connection.sent.length = 0;
  // Tab takes units behind within 10 yards (0x524440); the swing follows, the body does not spin.
  client.selectTarget(B);
  assert.deepEqual(swingTargets(connection), [B]);
  assert.equal(opcodes(connection).includes(OPCODES.MSG_MOVE_SET_FACING), false);
  client.close();
});
