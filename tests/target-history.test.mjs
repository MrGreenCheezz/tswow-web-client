import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import {
  TargetHistory, isOwnGroupGuid, setTargetHistoryJudge, targetHistoryKind,
} from "../dist/code/world/TargetHistory.js";
import { targetLast } from "../dist/code/browser/game/TargetLast.js";
import {
  NEAREST_ANY, NEAREST_ENEMY, NEAREST_ENEMY_PLAYER, NEAREST_FRIEND, NEAREST_FRIEND_PLAYER, NEAREST_PARTY_MEMBER,
  NEAREST_RAID_MEMBER, luaFlagArgument, nearestModeAccepts,
} from "../dist/code/browser/game/TargetNearestModes.js";

/*
 * WORK_PLAN 1.10/3.11 (lane L2): the target history Wow.exe 3.3.5a keeps for TargetLastTarget,
 * TargetLastEnemy and TargetLastFriend — SetTarget 0x524bf0, ClearTarget 0x525fc0, SMSG_CLEAR_TARGET
 * 0x756800/0x3bf, the unit's removal 0x734fd0 → 0x524350, SMSG_BREAK_TARGET 0x526530/0x152, leaving
 * the world 0x528c30 — and the TargetNearest* filters 0x518e40. Notes: .runtime/re-2026-10-04/l2-targeting/.
 */

const A = 0xa1n;
const B = 0xb2n;
const C = 0xc3n;

test("SetTarget with a unit: the selection it replaces — nothing included — becomes the last target", () => {
  const history = new TargetHistory();
  history.selected(undefined, A, "enemy");
  assert.equal(history.lastTarget, undefined);
  assert.equal(history.lastEnemy, A);
  history.selected(A, B, "friend");
  assert.equal(history.lastTarget, A);
  assert.equal(history.lastEnemy, A, "the enemy stays while a friend is selected");
  assert.equal(history.lastFriend, B);
  history.selected(B, C, undefined);
  assert.equal(history.lastTarget, B);
  assert.equal(history.lastEnemy, A, "a unit neither attackable nor assistable is no enemy");
  assert.equal(history.lastFriend, B, "and no friend either");
  // A clear remembers what it drops (ClearTarget 0x525fc0, SetTarget(0)); a select after a clear
  // remembers the empty selection, as 0x524bf0 copies 0x00bd07b0 whatever it holds.
  history.selected(C, undefined, undefined);
  assert.equal(history.lastTarget, C);
  history.selected(undefined, A, "enemy");
  assert.equal(history.lastTarget, undefined);
  history.selected(undefined, undefined, undefined);
  assert.equal(history.lastTarget, undefined, "a clear of nothing remembers nothing");
});

test("a unit that leaves is forgotten in all three slots unless it is of the player's own group", () => {
  const SELF = 0x10n;
  const MEMBER = 0x20n;
  const MEMBER_PET = 0x21n;
  const OWN_PET = 0x11n;
  const OUT_OF_SIGHT = 0x30n;
  const OUT_PET = 0x31n;
  const self = { guid: SELF, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset, Number(OWN_PET)]]) };
  const member = { guid: MEMBER, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset, Number(MEMBER_PET)]]) };
  const world = {
    state: { selfGuid: SELF, objects: new Map([[SELF, self], [MEMBER, member]]) },
    group: { members: [{ guid: MEMBER }, { guid: OUT_OF_SIGHT }] },
    partyStats: new Map([[OUT_OF_SIGHT, { petGuid: OUT_PET }]]),
  };
  for (const guid of [SELF, OWN_PET, MEMBER, MEMBER_PET, OUT_OF_SIGHT, OUT_PET]) {
    assert.equal(isOwnGroupGuid(world, guid), true, `0x${guid.toString(16)}`);
  }
  assert.equal(isOwnGroupGuid(world, A), false);
  assert.equal(isOwnGroupGuid({ ...world, group: undefined }, MEMBER), false, "no group, no member");

  const history = new TargetHistory();
  history.lastTarget = A;
  history.lastEnemy = A;
  history.lastFriend = MEMBER;
  history.unitLeft(MEMBER, world);
  assert.equal(history.lastFriend, MEMBER, "a party member out of range stays remembered");
  history.unitLeft(B, world);
  assert.deepEqual([history.lastTarget, history.lastEnemy], [A, A], "a guid in no slot changes nothing");
  history.unitLeft(A, world);
  assert.deepEqual([history.lastTarget, history.lastEnemy, history.lastFriend], [undefined, undefined, MEMBER]);
  history.forget(MEMBER);
  assert.equal(history.lastFriend, undefined);
  history.lastTarget = B;
  history.lastEnemy = C;
  history.reset();
  assert.deepEqual([history.lastTarget, history.lastEnemy, history.lastFriend], [undefined, undefined, undefined]);
});

test("the judge: the browser's when registered, else the world client's CanAttack", () => {
  const unit = { guid: A, typeId: 3, fields: new Map() };
  setTargetHistoryJudge(undefined);
  assert.equal(targetHistoryKind(unit, () => true), "enemy");
  assert.equal(targetHistoryKind(unit, () => false), undefined, "nothing is a friend without the faction table");
  setTargetHistoryJudge(() => "friend");
  assert.equal(targetHistoryKind(unit, () => true), "friend");
  setTargetHistoryJudge(undefined);
});

/** A world the TargetLast* verbs can run on: the history and a recorder of selections. */
function lastWorld(inSight) {
  const selected = [];
  return {
    selected,
    targetGuid: undefined,
    targetHistory: new TargetHistory(),
    state: { objects: new Map(inSight.map((guid) => [guid, { guid }])) },
    selectTarget(guid) {
      selected.push(guid);
      this.targetHistory.selected(this.targetGuid, guid, undefined);
      this.targetGuid = guid;
    },
  };
}

test("TargetLastTarget swaps with the last target, and with none clears what is selected (0x525d70)", () => {
  const world = lastWorld([A, B]);
  assert.equal(targetLast(world, "target"), false, "nothing selected, nothing remembered: nothing");
  world.selectTarget(A);
  world.selectTarget(B);
  world.selected.length = 0;
  assert.equal(targetLast(world, "target"), true);
  assert.equal(targetLast(world, "target"), true);
  assert.deepEqual(world.selected, [A, B], "two presses go there and back");
  world.targetHistory.lastTarget = undefined;
  world.selected.length = 0;
  assert.equal(targetLast(world, "target"), true);
  assert.deepEqual(world.selected, [undefined], "with nothing remembered the press is a clear");
  assert.equal(world.targetHistory.lastTarget, B, "which remembers what it dropped");
  assert.equal(targetLast(world, "target"), true);
  assert.deepEqual(world.selected, [undefined, B], "so the next press brings it back");
  world.targetHistory.lastTarget = C;
  world.selected.length = 0;
  assert.equal(targetLast(world, "target"), false, "a last target out of sight is not selected");
  assert.deepEqual(world.selected, []);
  assert.equal(world.targetHistory.lastTarget, C, "and stays remembered");
});

test("TargetLastEnemy and TargetLastFriend select the remembered unit when it is in sight", () => {
  const world = lastWorld([A, B]);
  world.targetHistory.lastEnemy = A;
  world.targetHistory.lastFriend = C;
  assert.equal(targetLast(world, "enemy"), true);
  assert.deepEqual(world.selected, [A]);
  assert.equal(targetLast(world, "friend"), false, "a friend out of sight is not selected");
  world.targetHistory.lastFriend = B;
  assert.equal(targetLast(world, "friend"), true);
  assert.deepEqual(world.selected, [A, B]);
  assert.equal(world.targetHistory.lastTarget, A, "SetTarget remembers the enemy it replaced");
  world.targetHistory.lastEnemy = undefined;
  assert.equal(targetLast(world, "enemy"), false, "no enemy remembered: nothing");
});

test("a TargetNearest* argument is read as Wow.exe reads a Lua boolean (0x815500, 0x815400)", () => {
  for (const value of [undefined, null, false, 0, 0.5, -0.9, "", "0", "false", "no", "N", "off", "OFF", "disabled", "x", "maybe", {}, () => 1]) {
    assert.equal(luaFlagArgument(value), false, JSON.stringify(String(value)));
  }
  for (const value of [true, 1, -1, 2.5, "1", "9", "true", "yes", "T", "y", "on", "On", "ENABLED"]) {
    assert.equal(luaFlagArgument(value), true, JSON.stringify(String(value)));
  }
});

test("the seven TargetNearest* filters (0x518e40)", () => {
  const SELF = 1n;
  const unitOf = (guid, typeId, health = 100) => ({
    guid, typeId, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, health]]),
  });
  const enemies = new Set([10n, 11n]);
  const friends = new Set([20n, 21n, 22n, 30n]);
  const host = {
    tabEnemy: (object) => enemies.has(object.guid),
    canAssist: (object) => friends.has(object.guid),
    selfGuid: SELF,
    inParty: (guid) => guid === 30n,
    inGroup: (guid) => guid === 30n || guid === 40n,
  };
  const creature = unitOf(10n, 3);
  const enemyPlayer = unitOf(11n, 4);
  const friendNpc = unitOf(20n, 3);
  const friendPlayer = unitOf(21n, 4);
  const deadFriend = unitOf(22n, 4, 0);
  const partyMember = unitOf(30n, 4, 0);
  const raidMember = unitOf(40n, 4);
  const self = unitOf(SELF, 4);
  const accepted = (mode) => [creature, enemyPlayer, friendNpc, friendPlayer, deadFriend, partyMember, raidMember, self]
    .filter((object) => nearestModeAccepts(mode, object, host)).map((object) => object.guid);
  assert.deepEqual(accepted(NEAREST_ANY), [10n, 11n, 20n, 21n, 22n, 30n, 40n, 1n]);
  assert.deepEqual(accepted(NEAREST_ENEMY), [10n, 11n]);
  assert.deepEqual(accepted(NEAREST_ENEMY_PLAYER), [11n]);
  assert.deepEqual(accepted(NEAREST_FRIEND), [20n, 21n], "an assistable unit with no health is left out");
  assert.deepEqual(accepted(NEAREST_FRIEND_PLAYER), [21n]);
  assert.deepEqual(accepted(NEAREST_PARTY_MEMBER), [30n, 1n], "a dead party member is still one (0x52c680)");
  assert.deepEqual(accepted(NEAREST_RAID_MEMBER), [30n, 40n, 1n]);
});

// ---- the world client's hook points ----

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
const WOLF = 0x5678n;
const BOAR = 0x9abcn;
const MEMBER = 0x4444n;

async function inWorld() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  const here = { x: 0, y: 0, z: 0, orientation: 0 };
  client.state.move(SELF, { flags: 0, position: here });
  for (const [guid, x] of [[WOLF, 5], [BOAR, 9], [MEMBER, 3]]) client.state.move(guid, { flags: 0, position: { ...here, x } });
  client.state.selfGuid = SELF;
  for (const guid of [SELF, WOLF, BOAR, MEMBER]) {
    const object = client.state.objects.get(guid);
    object.typeId = guid === SELF || guid === MEMBER ? 4 : 3;
    object.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
    if (object.typeId === 4) object.fields.set(UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x8);
  }
  return { client, connection };
}

const history = (client) => [client.targetHistory.lastTarget, client.targetHistory.lastEnemy, client.targetHistory.lastFriend];

test("the world client keeps the history on every selection, clear and departure", async () => {
  setTargetHistoryJudge(undefined);
  const { client, connection } = await inWorld();
  client.selectTarget(WOLF);
  assert.deepEqual(history(client), [undefined, WOLF, undefined],
    "without the browser's judge, what the world client's CanAttack takes is an enemy");
  client.selectTarget(BOAR);
  assert.deepEqual(history(client), [WOLF, BOAR, undefined]);
  client.selectTarget(BOAR);
  assert.deepEqual(history(client), [WOLF, BOAR, undefined], "the unit already selected changes nothing");
  client.selectTarget(undefined);
  assert.deepEqual(history(client), [BOAR, BOAR, undefined], "a clear (Esc, ClearTarget) remembers what it drops");

  // SMSG_CLEAR_TARGET lets go through 0x5241b0, which remembers nothing.
  client.selectTarget(WOLF);
  assert.equal(client.targetHistory.lastTarget, undefined);
  connection.push(OPCODES.SMSG_CLEAR_TARGET, new PacketWriter().u64(WOLF).toUint8Array());
  await settle();
  assert.equal(client.targetGuid, undefined);
  assert.equal(client.targetHistory.lastTarget, undefined, "the realm's clear is not a last target");

  // A unit leaving the client (0x734fd0 → 0x524350) is forgotten everywhere — a group member is not.
  client.group = { groupType: 0, ownSubGroup: 0, members: [{ guid: MEMBER, subGroup: 0 }] };
  client.selectTarget(MEMBER);
  client.selectTarget(BOAR);
  assert.deepEqual(history(client), [MEMBER, BOAR, undefined]);
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, new PacketWriter().u64(MEMBER).u8(0).toUint8Array());
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, new PacketWriter().u64(WOLF).u8(0).toUint8Array());
  await settle();
  assert.deepEqual(history(client), [MEMBER, BOAR, undefined], "the member stays, the wolf was in no slot");
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, new PacketWriter().u64(BOAR).u8(0).toUint8Array());
  await settle();
  assert.equal(client.targetGuid, undefined, "the selected boar went out of sight");
  assert.deepEqual(history(client), [MEMBER, undefined, undefined], "and out of the history, uncounted as a last target");

  // SMSG_BREAK_TARGET forgets the caster too (0x526530 case 0x152 → 0x524350).
  client.targetHistory.lastEnemy = 0x7777n;
  connection.push(OPCODES.SMSG_BREAK_TARGET, new PacketWriter().packedGuid(0x7777n).toUint8Array());
  await settle();
  assert.equal(client.targetHistory.lastEnemy, undefined);

  // Leaving the world (SMSG_NEW_WORLD → 0x528c30) clears all three.
  client.targetHistory.lastTarget = MEMBER;
  client.targetHistory.lastFriend = MEMBER;
  connection.push(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(1).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await settle();
  assert.deepEqual(history(client), [undefined, undefined, undefined]);
  client.close();
});
