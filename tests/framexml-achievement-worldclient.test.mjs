import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketReader } from "../dist/code/protocol/PacketReader.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { buildQueryInspectAchievements, parseCriteriaUpdate } from "../dist/code/world/CharacterProgressProtocol.js";

// The achievement packets the stock achievement model hears (ACHIEVEMENT_STATE_CHANGED beside
// ACHIEVEMENT_EARNED), in TrinityCore's own layouts (AchievementMgr::SendCriteriaUpdate,
// ::BuildAllDataPacket, ::SendRespondInspectAchievements), and CMSG_QUERY_INSPECT_ACHIEVEMENTS
// (WorldSession::HandleQueryInspectAchievements reads one packed guid).

const SELF = 0x1234n;
const OTHER = 0x5678n;
/** WowTime::GetPackedTime for 2026-09-20 18:30, a Sunday. */
const PACKED = (26 << 24) | (8 << 20) | (19 << 14) | (0 << 11) | (18 << 6) | 30;

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
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

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  return { client, connection };
}

/** AchievementMgr::SendCriteriaUpdate: id, packed counter, packed player, flags, date, elapsed, 0. */
function criteriaUpdate(id, counter, elapsed = 0, flags = 0) {
  return new PacketWriter().u32(id).packedGuid(counter).packedGuid(SELF).u32(flags).u32(PACKED).u32(elapsed).u32(0).toUint8Array();
}

/** BuildAllDataPacket: completed ids with dates, -1, then criteria rows, -1. */
function allData(writer, completed, criteria) {
  for (const [id, date] of completed) writer.u32(id).u32(date);
  writer.i32(-1);
  for (const [id, counter] of criteria) writer.u32(id).packedGuid(counter).packedGuid(SELF).u32(0).u32(PACKED).u32(0).u32(0);
  writer.i32(-1);
  return writer.toUint8Array();
}

test("SMSG_CRITERIA_UPDATE reads TrinityCore's four trailing words: flags, date, elapsed, zero", () => {
  const update = parseCriteriaUpdate(criteriaUpdate(159, 1n, 42, 1));
  assert.deepEqual(update, { criteriaId: 159, counter: 1n, playerGuid: SELF, flags: 1, date: PACKED, timeElapsed: 42 });
});

test("CMSG_QUERY_INSPECT_ACHIEVEMENTS is one packed guid", () => {
  const reader = new PacketReader(buildQueryInspectAchievements(OTHER));
  assert.equal(reader.packedGuid(), OTHER);
  reader.assertFinished();
});

test("every achievement packet raises its world event, and the inspect answer is kept apart", async () => {
  const { client, connection } = await loggedIn();
  const changes = [];
  const earned = [];
  client.events.on("ACHIEVEMENT_STATE_CHANGED", (change) => changes.push(change));
  client.events.on("ACHIEVEMENT_EARNED", (event) => earned.push(event));
  // The player's own create block (UPDATEFLAG_SELF) names it; the fake login stops short of it.
  client.state.selfGuid = SELF;
  try {
    connection.push(OPCODES.SMSG_ALL_ACHIEVEMENT_DATA, allData(new PacketWriter(), [[6, PACKED], [7, PACKED]], [[34, 10n], [35, 20n]]));
    connection.push(OPCODES.SMSG_CRITERIA_UPDATE, criteriaUpdate(36, 25n, 7));
    connection.push(OPCODES.SMSG_ACHIEVEMENT_EARNED, new PacketWriter().packedGuid(SELF).u32(8).u32(PACKED).u32(0).toUint8Array());
    connection.push(OPCODES.SMSG_ACHIEVEMENT_EARNED, new PacketWriter().packedGuid(OTHER).u32(9).u32(PACKED).u32(0).toUint8Array());
    connection.push(OPCODES.SMSG_CRITERIA_DELETED, new PacketWriter().u32(34).toUint8Array());
    connection.push(OPCODES.SMSG_ACHIEVEMENT_DELETED, new PacketWriter().u32(6).toUint8Array());
    connection.push(OPCODES.SMSG_RESPOND_INSPECT_ACHIEVEMENTS,
      allData(new PacketWriter().packedGuid(OTHER), [[6, PACKED], [1176, PACKED]], [[111, 7n]]));
    await settle();
    assert.deepEqual(changes, [
      { kind: "list" },
      { kind: "criteria", criteriaId: 36, timeElapsed: 7 },
      { kind: "deleted" },
      { kind: "deleted" },
      { kind: "inspect", guid: OTHER },
    ]);
    assert.deepEqual(earned, [{ achievementId: 8, mine: true }, { achievementId: 9, mine: false }]);
    assert.deepEqual([...client.achievements], [[7, PACKED], [8, PACKED]], "the list, the earned one, less the deleted one");
    assert.deepEqual([...client.criteria], [[35, 20n], [36, 25n]]);
    assert.equal(client.inspectAchievements.guid, OTHER);
    assert.deepEqual([...client.inspectAchievements.completed], [[6, PACKED], [1176, PACKED]]);
    assert.deepEqual([...client.inspectAchievements.criteria], [[111, 7n]]);
    assert.equal(client.achievements.has(1176), false, "another player's list is not this character's");
    client.queryInspectAchievements(OTHER);
    client.queryInspectAchievements(0n);
    const queries = connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_QUERY_INSPECT_ACHIEVEMENTS);
    assert.equal(queries.length, 1, "no query for guid 0");
    assert.deepEqual([...queries[0].payload], [...buildQueryInspectAchievements(OTHER)]);
  } finally {
    client.close?.();
  }
});
