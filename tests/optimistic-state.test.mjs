import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

/**
 * WORK_PLAN 5.21: which local state waits for the server and which stays optimistic, checked
 * against what Wow.exe 3.3.5a (build 12340) does with the same request (notes in
 * .runtime/re-2026-10-01/a4-world/):
 * * attack — StartAttack 0x523090 → 0x72c2b0 → 0x6e4950 → 0x6e2610 sends CMSG_ATTACKSWING and
 *   stores the target and a "requested" word on the player (0x98e540: +0xa20 guid, +0xa28 = 1).
 *   IsCurrentSpell(6603) (0x806030) reads +0xa20, so the button lights at once; PLAYER_ENTER_COMBAT
 *   (event 0x9b) fires only from SMSG_ATTACKSTART (0x756800), which also clears +0xa28.
 * * equipment sets — SaveEquipmentSet 0x5af9c0 adds a new set locally at once and marks it as
 *   waiting for its id (+0x230); while it waits a re-save sends nothing (0x5ade50); the SAVED
 *   handler 0x5ae760 stores the guid and clears the mark, or drops the set when the guid is 0.
 *   Deleting (0x5ae260) removes the set locally at once; the core never answers it.
 * * LeaveLFG 0x553ab0 sends CMSG_LFG_LEAVE and leaves the queue state to SMSG_LFG_UPDATE_*.
 * * SetLFGBootVote 0x554960 keeps "my vote" (0x00bea860) locally but not "I voted" (0x00bea85c);
 *   that word comes from SMSG_LFG_BOOT_PROPOSAL_UPDATE (0x55bdc0 case 0x36d).
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
const VICTIM = 9n;

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  for (const guid of [VICTIM, 10n]) {
    client.state.move(guid, { flags: 0, position: { x: 2, y: 0, z: 0, orientation: 0 } });
    client.state.objects.get(guid).typeId = 3;
    client.state.setField(guid, UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  }
  return { client, connection };
}

/** SMSG_ATTACKSTART: two plain u64 guids (`Unit::SendMeleeAttackStart`). */
const attackStart = (attacker, victim) => new PacketWriter().u64(attacker).u64(victim).toUint8Array();

function withClock(start, body) {
  const real = performance.now;
  let clock = start;
  performance.now = () => clock;
  try {
    return body((ms) => { clock = ms; });
  } finally {
    performance.now = real;
  }
}

test("5.21 startAttack is a request: attacking waits for SMSG_ATTACK_START", async () => {
  const { client, connection } = await loggedIn();
  client.selectTarget(VICTIM);
  connection.sent.length = 0;
  client.startAttack();
  assert.ok(connection.sent.some(({ opcode }) => opcode === OPCODES.CMSG_ATTACK_SWING));
  assert.equal(client.attacking, false, "PLAYER_ENTER_COMBAT belongs to the server's answer");
  assert.equal(client.attackRequested, true, "the request itself is visible at once (+0xa28)");

  connection.sent.length = 0;
  client.startAttack();
  assert.equal(connection.sent.length, 0, "a pending request is not sent twice");

  connection.push(OPCODES.SMSG_ATTACK_START, attackStart(SELF, VICTIM));
  await settle();
  assert.equal(client.attacking, true);
  assert.equal(client.attackRequested, false, "SMSG_ATTACKSTART clears the request word");
  client.close();
});

test("5.21 a refused swing never shows as attacking", async () => {
  for (const refusal of ["stop", "cantAttack"]) {
    const { client, connection } = await loggedIn();
    client.selectTarget(VICTIM);
    client.startAttack();
    if (refusal === "stop") {
      // HandleAttackSwingOpcode → SendAttackStop(enemy): packed attacker, packed victim, u32 0.
      connection.push(OPCODES.SMSG_ATTACK_STOP,
        new PacketWriter().packedGuid(SELF).packedGuid(VICTIM).u32(0).toUint8Array());
    } else {
      connection.push(OPCODES.SMSG_ATTACK_SWING_CANT_ATTACK);
    }
    await settle();
    assert.equal(client.attacking, false, refusal);
    assert.equal(client.attackRequested, false, refusal);
    // Wow.exe 0x756800 fires PLAYER_LEAVE_COMBAT on every SMSG_ATTACKSTOP for the player; the seam
    // sees the packet through this count (framexml-unit-relations.test.mjs).
    assert.equal(client.attackStops, refusal === "stop" ? 1 : 0, refusal);
    client.close();
  }
});

test("5.21 an unanswered swing request lapses after 1.5 s", async () => {
  const { client } = await loggedIn();
  client.selectTarget(VICTIM);
  withClock(10_000, (set) => {
    client.startAttack();
    set(11_400);
    assert.equal(client.attackRequested, true);
    set(11_600);
    assert.equal(client.attackRequested, false, "Unit::Attack may refuse silently (mounted, evading)");
  });
  client.close();
});

test("5.21 a target change while the swing is only requested still stops it on the wire", async () => {
  const { client, connection } = await loggedIn();
  client.selectTarget(VICTIM);
  client.startAttack();
  connection.sent.length = 0;
  // 5.05: an unattackable new target ends the request (Wow.exe 0x5241b0 → 0x6e1660); an attackable
  // one gets a request of its own after the stop (auto-attack-target.test.mjs).
  client.state.setField(10n, UPDATE_FIELDS.UNIT_FIELD_FLAGS.offset, 0x2);
  client.selectTarget(10n);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode).slice(0, 2),
    [OPCODES.CMSG_ATTACK_STOP, OPCODES.CMSG_SET_SHEATHED]);
  assert.equal(client.attackRequested, false);
  client.close();
});

const pieces = () => Array.from({ length: 19 }, () => 0n);

test("5.21 a new equipment set appears at once and waits for its id", async () => {
  const { client, connection } = await loggedIn();
  connection.sent.length = 0;
  client.saveEquipmentSet(0n, 2, "Танк", "INV_Shield_06", pieces());
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_EQUIPMENT_SET_SAVE).length, 1);
  assert.equal(client.equipmentSets.find((set) => set.setId === 2)?.name, "Танк", "0x5af7e0 adds it locally");
  assert.equal(client.equipmentSetPending(2), true);

  connection.sent.length = 0;
  client.saveEquipmentSet(0n, 2, "Танк 2", "INV_Shield_06", pieces());
  assert.equal(connection.sent.length, 0, "0x5ade50: a set waiting for its id is not re-saved");
  assert.equal(client.equipmentSets.find((set) => set.setId === 2)?.name, "Танк");

  connection.push(OPCODES.SMSG_EQUIPMENT_SET_SAVED, new PacketWriter().u32(2).packedGuid(0x77n).toUint8Array());
  await settle();
  assert.equal(client.equipmentSets.find((set) => set.setId === 2)?.guid, 0x77n);
  assert.equal(client.equipmentSetPending(2), false);

  // Re-saving and deleting a named set stay immediate: the core answers neither.
  client.saveEquipmentSet(0x77n, 2, "Танк 3", "INV_Shield_06", pieces());
  assert.equal(client.equipmentSets.find((set) => set.setId === 2)?.name, "Танк 3");
  assert.equal(client.equipmentSetPending(2), false);
  client.deleteEquipmentSet(0x77n);
  assert.equal(client.equipmentSets.length, 0);
  client.close();
});

test("5.21 SMSG_EQUIPMENT_SET_SAVED with a zero guid drops the waiting set (0x5ae760)", async () => {
  const { client, connection } = await loggedIn();
  client.saveEquipmentSet(0n, 4, "ПвП", "INV_Misc_QuestionMark", pieces());
  connection.push(OPCODES.SMSG_EQUIPMENT_SET_SAVED, new PacketWriter().u32(4).packedGuid(0n).toUint8Array());
  await settle();
  assert.equal(client.equipmentSets.some((set) => set.setId === 4), false);
  assert.equal(client.equipmentSetPending(4), false);
  client.close();
});

test("5.21 leaveLfg leaves the search flag to SMSG_LFG_UPDATE_SEARCH", async () => {
  const { client, connection } = await loggedIn();
  connection.push(OPCODES.SMSG_LFG_UPDATE_SEARCH, new PacketWriter().u8(1).toUint8Array());
  await settle();
  assert.equal(client.lfgSearching, true);
  connection.sent.length = 0;
  client.leaveLfg();
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_LFG_LEAVE]);
  assert.equal(client.lfgSearching, true, "only the server's answer changes it");
  connection.push(OPCODES.SMSG_LFG_UPDATE_SEARCH, new PacketWriter().u8(0).toUint8Array());
  await settle();
  assert.equal(client.lfgSearching, false);
  client.close();
});

/** SMSG_LFG_BOOT_PROPOSAL_UPDATE as `WorldSession::SendLfgBootProposalUpdate` writes it. */
const bootUpdate = ({ voted = false, votedYes = false } = {}) => new PacketWriter()
  .u8(1).u8(voted ? 1 : 0).u8(votedYes ? 1 : 0).u64(0x55n).u32(1).u32(1).u32(0).u32(3).cString("afk")
  .toUint8Array();

test("5.21 a boot vote waits for the server to say it was counted", async () => {
  const { client, connection } = await loggedIn();
  connection.push(OPCODES.SMSG_LFG_BOOT_PROPOSAL_UPDATE, bootUpdate());
  await settle();
  connection.sent.length = 0;
  client.voteToRemove(true);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_LFG_SET_BOOT_VOTE]);
  assert.equal(client.lfgBoot?.voted, false, "\"I voted\" is the server's word (0x00bea85c)");
  assert.equal(client.lfgBoot?.votedYes, true, "\"my vote\" is kept locally (0x554960)");
  assert.equal(client.lfgBootVotePending, true);

  connection.sent.length = 0;
  client.voteToRemove(true);
  assert.equal(connection.sent.length, 0, "no second packet while the first is unanswered");

  connection.push(OPCODES.SMSG_LFG_BOOT_PROPOSAL_UPDATE, bootUpdate({ voted: true, votedYes: true }));
  await settle();
  assert.equal(client.lfgBoot?.voted, true);
  assert.equal(client.lfgBootVotePending, false);
  client.close();
});

test("5.21 a boot vote the core leaves unanswered stays sent for the rest of the vote", async () => {
  // LFGMgr::UpdateBoot (LFGMgr.cpp:1507-1509) answers only a vote that decides the boot, and
  // drops a second vote from the same player without a word (:1485). In a five-player group the
  // usual vote decides nothing, so no update follows it: the vote is out until the boot ends.
  const { client, connection } = await loggedIn();
  connection.push(OPCODES.SMSG_LFG_BOOT_PROPOSAL_UPDATE, bootUpdate());
  await settle();
  const endsAt = client.lfgBootExpiresAt;
  withClock(endsAt - 100_000, (set) => {
    client.voteToRemove(false);
    set(endsAt - 97_000);
    connection.sent.length = 0;
    client.voteToRemove(true);
    assert.equal(connection.sent.length, 0, "the core would drop it: one vote per player");
    assert.equal(client.lfgBootVotePending, true, "past 1.5 s the vote is still out");
    assert.equal(client.lfgBoot?.votedYes, false, "the vote that was sent, not the second press");
    set(endsAt + 1);
    assert.equal(client.lfgBootVotePending, false, "the boot's own deadline ends it");
  });
  client.close();
});

test("5.21 leaving the Wintergrasp queue stays optimistic by design", async () => {
  // Battlefield::AskToLeaveQueue only erases the membership; no packet ever confirms it.
  const { client, connection } = await loggedIn();
  client.battlefieldQueuedId = 1;
  connection.sent.length = 0;
  client.leaveBattlefieldQueue(1);
  assert.deepEqual(connection.sent.map(({ opcode }) => opcode), [OPCODES.CMSG_BATTLEFIELD_MGR_EXIT_REQUEST]);
  assert.equal(client.battlefieldQueuedId, 0);
  client.close();
});
