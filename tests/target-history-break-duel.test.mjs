import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { TargetHistory } from "../dist/code/world/TargetHistory.js";

/*
 * Review of lane L2 (WORK_PLAN 1.10, 04.10): SMSG_BREAK_TARGET (Wow.exe 0x526530 case 0x152) forgets
 * the caster in the target history through 0x524350 — but a unit of the player's own group (0x512a30)
 * is kept, unless the client knows it and it duels the player (0x71f5c0: both player-controlled,
 * their players under one PLAYER_DUEL_ARBITER on different PLAYER_DUEL_TEAMs; a pet answers for its
 * owner through 0x718b70). The unit is still in sight when this packet arrives, so the duel can be
 * read; a unit leaving the client (0x734fd0) is retired here only after its fields are gone, and is
 * kept. Notes: .runtime/re-2026-10-04/l2-targeting/g3.c (0x526530, 0x734fd0), g4.c (0x71f5c0).
 */

const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
const SUMMON = UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset;
const CREATED_BY = UPDATE_FIELDS.UNIT_FIELD_CREATEDBY.offset;
const ARBITER = UPDATE_FIELDS.PLAYER_DUEL_ARBITER.offset;
const TEAM = UPDATE_FIELDS.PLAYER_DUEL_TEAM.offset;
const PLAYER_CONTROLLED = 0x8;

function fakeConnection() {
  const sent = [];
  const queue = [];
  let wake;
  return {
    sent,
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); },
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
const MEMBER = 0x4444n;
const MEMBER_PET = 0x4445n;
const STRANGER = 0x5555n;
const ARBITER_GUID = 0x1f0000000000abcdn;

async function inWorld() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  const here = { x: 0, y: 0, z: 0, orientation: 0 };
  for (const [guid, x] of [[SELF, 0], [MEMBER, 3], [MEMBER_PET, 4], [STRANGER, 6]]) {
    client.state.move(guid, { flags: 0, position: { ...here, x } });
  }
  client.state.selfGuid = SELF;
  for (const guid of [SELF, MEMBER, MEMBER_PET, STRANGER]) {
    const object = client.state.objects.get(guid);
    object.typeId = guid === MEMBER_PET ? 3 : 4;
    object.fields.set(FLAGS, PLAYER_CONTROLLED);
  }
  const member = client.state.objects.get(MEMBER);
  member.fields.set(SUMMON, Number(MEMBER_PET & 0xffffffffn));
  member.fields.set(SUMMON + 1, Number(MEMBER_PET >> 32n));
  const pet = client.state.objects.get(MEMBER_PET);
  pet.fields.set(CREATED_BY, Number(MEMBER & 0xffffffffn));
  pet.fields.set(CREATED_BY + 1, Number(MEMBER >> 32n));
  client.group = { groupType: 0, ownSubGroup: 0, members: [{ guid: MEMBER, subGroup: 0 }] };
  return { client, connection };
}

function duel(client, guid, team) {
  const object = client.state.objects.get(guid);
  object.fields.set(ARBITER, Number(ARBITER_GUID & 0xffffffffn));
  object.fields.set(ARBITER + 1, Number(ARBITER_GUID >> 32n));
  object.fields.set(TEAM, team);
}

function remember(client, guid) {
  client.targetHistory.lastTarget = guid;
  client.targetHistory.lastEnemy = guid;
  client.targetHistory.lastFriend = guid;
}

const slots = (client) => [client.targetHistory.lastTarget, client.targetHistory.lastEnemy, client.targetHistory.lastFriend];
const breakTarget = (guid) => new PacketWriter().packedGuid(guid).toUint8Array();

test("SMSG_BREAK_TARGET keeps a group member — unless that member duels the player", async () => {
  const { client, connection } = await inWorld();
  remember(client, MEMBER);
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(MEMBER));
  await settle();
  assert.deepEqual(slots(client), [MEMBER, MEMBER, MEMBER], "no duel: the member stays remembered");

  duel(client, SELF, 1);
  duel(client, MEMBER, 2);
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(MEMBER));
  await settle();
  assert.deepEqual(slots(client), [undefined, undefined, undefined], "the member the player duels is forgotten (0x71f5c0)");

  // The member's pet answers for its owner (0x718b70).
  remember(client, MEMBER_PET);
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(MEMBER_PET));
  await settle();
  assert.deepEqual(slots(client), [undefined, undefined, undefined], "the dueling member's pet too");

  // One team for both is no duel between them.
  duel(client, MEMBER, 1);
  remember(client, MEMBER);
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(MEMBER));
  await settle();
  assert.deepEqual(slots(client), [MEMBER, MEMBER, MEMBER], "the same duel team is no duel");

  // A stranger is forgotten whatever the duel says.
  remember(client, STRANGER);
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(STRANGER));
  await settle();
  assert.deepEqual(slots(client), [undefined, undefined, undefined]);
  client.close();
});

test("a dueling group member out of sight, or leaving the client, is kept: there are no fields to read", async () => {
  const { client, connection } = await inWorld();
  duel(client, SELF, 1);
  duel(client, MEMBER, 2);
  remember(client, MEMBER);
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, new PacketWriter().u64(MEMBER).u8(0).toUint8Array());
  await settle();
  assert.deepEqual(slots(client), [MEMBER, MEMBER, MEMBER], "retired after its fields went: kept");
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(MEMBER));
  await settle();
  assert.deepEqual(slots(client), [MEMBER, MEMBER, MEMBER], "0x526530: a group unit the client does not know is kept");
  client.close();
});

test("the duel rule reads nothing for a guid in no slot", () => {
  const history = new TargetHistory();
  const untouchable = { get state() { throw new Error("read"); } };
  history.unitLeft(MEMBER, untouchable);
  assert.deepEqual([history.lastTarget, history.lastEnemy, history.lastFriend], [undefined, undefined, undefined]);
});
