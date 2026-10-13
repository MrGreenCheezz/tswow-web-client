import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { game } from "../dist/code/browser/game/Context.js";
import { focusUnit, setFocusGuid } from "../dist/code/browser/game/Targeting.js";

/*
 * Plan item 1.10 (12.10): Wow.exe 0x524350 lets go of the focus (0x00bd07d0 → 0x51ff20 with guid 0, which raises
 * PLAYER_FOCUS_CHANGED) beside the three history slots. It runs when a unit leaves the client (0x734fd0 — out of
 * sight, a despawn, every neighbour on SMSG_NEW_WORLD) and on SMSG_BREAK_TARGET (0x526530 case 0x152), both times
 * keeping a unit of the player's own group (0x512a30) unless it duels the player (0x71f5c0)
 * (.runtime/re-2026-10-04/l2-targeting/g2.c, g3.c). Here the focus lived until SMSG_BREAK_TARGET only, and that
 * dropped it with no group rule: a focused stranger who walked out of sight came back as the focus when he walked
 * in again, and a party member boarding a vehicle (Unit::SendClearTarget) lost the player's focus.
 */

const FLAGS = UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset;
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
const STRANGER = 0x5555n;
const OTHER = 0x6666n;
const ARBITER_GUID = 0x1f0000000000abcdn;

function place(client, guid, x) {
  client.state.move(guid, { flags: 0, position: { x, y: 0, z: 0, orientation: 0 } });
  const object = client.state.objects.get(guid);
  object.typeId = 4;
  object.fields.set(FLAGS, PLAYER_CONTROLLED);
}

async function inWorld() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  for (const [guid, x] of [[SELF, 0], [MEMBER, 3], [STRANGER, 6], [OTHER, 9]]) place(client, guid, x);
  client.state.selfGuid = SELF;
  client.group = { groupType: 0, ownSubGroup: 0, members: [{ guid: MEMBER, subGroup: 0 }] };
  game.world = client;
  return { client, connection };
}

function duel(client, guid, team) {
  const object = client.state.objects.get(guid);
  object.fields.set(ARBITER, Number(ARBITER_GUID & 0xffffffffn));
  object.fields.set(ARBITER + 1, Number(ARBITER_GUID >> 32n));
  object.fields.set(TEAM, team);
}

const destroy = (guid) => new PacketWriter().u64(guid).u8(0).toUint8Array();
const breakTarget = (guid) => new PacketWriter().packedGuid(guid).toUint8Array();

async function scenario(body) {
  const { client, connection } = await inWorld();
  try {
    await body(client, connection);
  } finally {
    setFocusGuid(undefined);
    game.world = undefined;
    client.close();
  }
}

test("a focused stranger who leaves the client is no longer the focus, and does not come back as it", () => scenario(async (client, connection) => {
  setFocusGuid(STRANGER);
  assert.equal(focusUnit()?.guid, STRANGER);
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, destroy(STRANGER));
  await settle();
  assert.equal(game.focusGuid, undefined, "0x734fd0 → 0x524350 → 0x51ff20(0)");
  place(client, STRANGER, 6);
  assert.equal(focusUnit(), undefined, "walking back into sight brings no focus back");
}));

test("another unit leaving leaves the focus alone", () => scenario(async (_client, connection) => {
  setFocusGuid(STRANGER);
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, destroy(OTHER));
  await settle();
  assert.equal(game.focusGuid, STRANGER);
}));

test("a group member keeps the focus out of sight, and through SMSG_BREAK_TARGET unless dueling the player", () => scenario(async (client, connection) => {
  setFocusGuid(MEMBER);
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(MEMBER));
  await settle();
  assert.equal(game.focusGuid, MEMBER, "0x526530: a group member the client knows, no duel — kept");
  duel(client, SELF, 1);
  duel(client, MEMBER, 2);
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(MEMBER));
  await settle();
  assert.equal(game.focusGuid, undefined, "the member the player duels lets go of it (0x71f5c0)");
  setFocusGuid(MEMBER);
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, destroy(MEMBER));
  await settle();
  assert.equal(game.focusGuid, MEMBER, "leaving the client: a group member is kept (0x734fd0 → 0x512a30)");
}));

test("SMSG_BREAK_TARGET on a stranger, and a new map, let go of the focus", () => scenario(async (client, connection) => {
  setFocusGuid(STRANGER);
  connection.push(OPCODES.SMSG_BREAK_TARGET, breakTarget(STRANGER));
  await settle();
  assert.equal(game.focusGuid, undefined, "SPELL_EFFECT_FORCE_DESELECT's focus half, as before");
  setFocusGuid(OTHER);
  connection.push(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(1).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await settle();
  assert.equal(game.focusGuid, undefined, "every neighbour leaves on SMSG_NEW_WORLD (0x734fd0)");
  assert.equal(client.state.objects.has(OTHER), false);
}));
