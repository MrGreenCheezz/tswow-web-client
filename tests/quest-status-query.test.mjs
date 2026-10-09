import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { QuestGiverStatusQueue } from "../dist/code/world/QuestGiverStatusQueue.js";

/**
 * WORK_PLAN 5.23: the marks over heads are asked for when a quest giver appears and when the quest
 * log changes, not by a five-second poll. Wow.exe 3.3.5a (`.runtime/re-2026-10-02/a3-mech/`):
 * CMSG_QUESTGIVER_STATUS_QUERY per object from its refresh (0x729f40 unit, 0x7111a0 game object,
 * both through 0x6d5080 → 0x6d5000), CMSG_TAXINODE_STATUS_QUERY for a flight master (0x6d5130),
 * CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY (0x6d50c0) on quest-log changes. Batched here.
 */

function recorder() {
  const sent = [];
  return {
    sent,
    sink: {
      queryOne: (guid) => sent.push(["one", guid]),
      queryTaxi: (guid) => sent.push(["taxi", guid]),
      queryAll: () => sent.push(["all"]),
    },
  };
}

const QUEST = { questGiver: true, flightMaster: false };
const TAXI = { questGiver: false, flightMaster: true };

test("one query per quest giver, at most eight a frame, none twice within 30 s", () => {
  const { sent, sink } = recorder();
  const queue = new QuestGiverStatusQueue(sink);
  queue.pump(1_000);
  assert.deepEqual(sent, [], "the first pump starts the clock and asks nothing");
  for (let guid = 1n; guid <= 10n; guid++) queue.noticed(guid, QUEST, 1_000);
  queue.noticed(3n, QUEST, 1_000);
  queue.pump(1_016);
  assert.deepEqual(sent.map(([, guid]) => guid), [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n], "eight, in arrival order, 3 once");
  queue.pump(1_033);
  assert.deepEqual(sent.slice(8).map(([, guid]) => guid), [9n, 10n], "the rest on the next frame");
  queue.noticed(1n, QUEST, 20_000);
  queue.pump(20_016);
  assert.equal(sent.length, 10, "1 was asked 19 s ago");
  queue.noticed(1n, QUEST, 31_100);
  queue.pump(31_116);
  assert.deepEqual(sent[10], ["one", 1n], "and may be asked again after 30 s");
});

test("a quest-log change folds into one sweep 300 ms later, which covers the singles waiting", () => {
  const { sent, sink } = recorder();
  const queue = new QuestGiverStatusQueue(sink);
  queue.pump(0);
  queue.noticed(5n, QUEST, 100);
  queue.sweepSoon(100);
  queue.sweepSoon(150);
  queue.sweepSoon(250);
  queue.noticed(6n, QUEST, 260);
  queue.pump(300);
  assert.deepEqual(sent, [], "not yet: 300 ms from the first change");
  queue.pump(400);
  assert.deepEqual(sent, [["all"]], "one sweep for three changes; 5 and 6 are answered by it");
  queue.pump(5_000);
  assert.deepEqual(sent, [["all"]]);
});

test("the safety sweep is once a minute, not every five seconds", () => {
  const { sent, sink } = recorder();
  const queue = new QuestGiverStatusQueue(sink);
  for (let now = 0; now < 59_999; now += 5_000) queue.pump(now);
  assert.deepEqual(sent, []);
  queue.pump(60_000);
  assert.deepEqual(sent, [["all"]]);
  queue.swept(70_000);
  queue.pump(120_000);
  assert.equal(sent.length, 1, "a sweep from elsewhere restarts the minute");
  queue.pump(130_000);
  assert.equal(sent.length, 2);
});

test("flight masters are asked about their discovery; a new map forgets everything asked", () => {
  const { sent, sink } = recorder();
  const queue = new QuestGiverStatusQueue(sink);
  queue.pump(0);
  queue.noticed(7n, TAXI, 0);
  queue.noticed(8n, { questGiver: true, flightMaster: true }, 0);
  queue.pump(16);
  assert.deepEqual(sent, [["one", 8n], ["taxi", 7n], ["taxi", 8n]]);
  queue.reset(20);
  queue.noticed(8n, QUEST, 30);
  queue.noticed(9n, QUEST, 30);
  queue.forget(9n);
  queue.pump(40);
  assert.deepEqual(sent.slice(3), [["one", 8n]], "8 is new on the new map; 9 left before it was asked");
});

test("review 02.10: a quest giver that left view and came back is asked again at once", () => {
  // Wow.exe asks from the new object's refresh (0x729f40/0x7111a0); the 30 s memory is for flag
  // changes of an object still in view, not for one that was destroyed and created again.
  const { sent, sink } = recorder();
  const queue = new QuestGiverStatusQueue(sink);
  queue.pump(0);
  queue.noticed(11n, { questGiver: true, flightMaster: true }, 0);
  queue.pump(16);
  assert.equal(sent.length, 2);
  queue.forget(11n);
  queue.noticed(11n, { questGiver: true, flightMaster: true }, 5_000);
  queue.pump(5_016);
  assert.deepEqual(sent.slice(2), [["one", 11n], ["taxi", 11n]], "back in view after 5 s: asked again");
});

// ---- WorldClient -------------------------------------------------------------------------------

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
const WATCHED = new Set([OPCODES.CMSG_QUESTGIVER_STATUS_QUERY, OPCODES.CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY, OPCODES.CMSG_TAXINODE_STATUS_QUERY]);

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(SELF);
  await settle();
  client.state.selfGuid = SELF;
  client.state.move(SELF, { flags: 0, position: { x: 0, y: 0, z: 0, orientation: 0 } });
  connection.sent.length = 0;
  return { client, connection, asked: () => connection.sent.filter((packet) => WATCHED.has(packet.opcode)) };
}

function creature(client, guid, npcFlags) {
  client.state.move(guid, { flags: 0, position: { x: 5, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(guid).typeId = 3;
  client.state.setField(guid, UPDATE_FIELDS.UNIT_NPC_FLAGS.offset, npcFlags);
}

test("WorldClient: a quest giver in view costs one 8-byte query, a plain creature none", async () => {
  const { client, asked } = await loggedIn();
  const now = performance.now();
  client.pumpQuestGiverStatus(now);
  creature(client, 0xf130000000000101n, 0x2);
  creature(client, 0xf130000000000102n, 0x1); // gossip only
  client.noticeObject(0xf130000000000101n);
  client.noticeObject(0xf130000000000102n);
  client.noticeObject(0xf130000000000101n); // OBJECT_CREATED and UNIT_NPC_FLAGS both arrive
  client.pumpQuestGiverStatus(now + 16);
  assert.deepEqual(asked().map((packet) => [packet.opcode, [...packet.payload]]),
    [[OPCODES.CMSG_QUESTGIVER_STATUS_QUERY, [...new PacketWriter().u64(0xf130000000000101n).toUint8Array()]]]);
  client.close();
});

test("WorldClient: a quest-giving game object and a flight master are asked about as well", async () => {
  const { client, asked } = await loggedIn();
  const now = performance.now();
  client.pumpQuestGiverStatus(now);
  const board = 0xf110000000000201n;
  client.state.move(board, { flags: 0, position: { x: 5, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(board).typeId = 5;
  client.state.setField(board, UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 0x00000201); // type 2, state 1
  const door = 0xf110000000000202n;
  client.state.move(door, { flags: 0, position: { x: 5, y: 0, z: 0, orientation: 0 } });
  client.state.objects.get(door).typeId = 5;
  client.state.setField(door, UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, 0x00000001); // type 0
  creature(client, 0xf130000000000301n, 0x2000);
  for (const guid of [board, door, 0xf130000000000301n]) client.noticeObject(guid);
  client.pumpQuestGiverStatus(now + 16);
  assert.deepEqual(asked().map((packet) => packet.opcode),
    [OPCODES.CMSG_QUESTGIVER_STATUS_QUERY, OPCODES.CMSG_TAXINODE_STATUS_QUERY]);
  client.close();
});

test("WorldClient: quest-log changes become one sweep; the old five-second poll is gone", async () => {
  const { client, asked } = await loggedIn();
  const now = performance.now();
  client.pumpQuestGiverStatus(now);
  for (let frame = 1; frame <= 6; frame++) client.pumpQuestGiverStatus(now + frame * 5_000 - 1);
  assert.deepEqual(asked(), [], "thirty seconds of frames ask nothing");
  client.questLogChanged();
  client.questLogChanged();
  client.pumpQuestGiverStatus(performance.now() + 301);
  assert.deepEqual(asked().map((packet) => packet.opcode), [OPCODES.CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY]);
  client.close();
});

test("WorldClient: a map change lets the same guid be asked again", async () => {
  const { client, connection, asked } = await loggedIn();
  const now = performance.now();
  client.pumpQuestGiverStatus(now);
  const npc = 0xf130000000000401n;
  creature(client, npc, 0x2);
  client.noticeObject(npc);
  client.pumpQuestGiverStatus(now + 16);
  connection.push(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(1).f32(0).f32(0).f32(0).f32(0).toUint8Array());
  await settle();
  creature(client, npc, 0x2);
  client.noticeObject(npc);
  client.pumpQuestGiverStatus(performance.now() + 16);
  assert.equal(asked().filter((packet) => packet.opcode === OPCODES.CMSG_QUESTGIVER_STATUS_QUERY).length, 2);
  client.close();
});

test("WorldClient review 02.10: SMSG_DESTROY_OBJECT and a new CREATE within 30 s ask again", async () => {
  const { client, connection, asked } = await loggedIn();
  const now = performance.now();
  client.pumpQuestGiverStatus(now);
  const npc = 0xf130000000000501n;
  creature(client, npc, 0x2);
  client.noticeObject(npc);
  client.pumpQuestGiverStatus(now + 16);
  connection.push(OPCODES.SMSG_DESTROY_OBJECT, new PacketWriter().u64(npc).u8(0).toUint8Array());
  await settle();
  assert.equal(client.questGiverStatus.has(npc), false, "the mark went with the object");
  creature(client, npc, 0x2);
  client.noticeObject(npc);
  client.pumpQuestGiverStatus(now + 2_000);
  assert.equal(asked().filter((packet) => packet.opcode === OPCODES.CMSG_QUESTGIVER_STATUS_QUERY).length, 2);
  client.close();
});

test("the game loop pumps the queue and no longer polls every five seconds", async () => {
  const { readFile } = await import("node:fs/promises");
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.doesNotMatch(loop, /requestQuestGiverStatus\(/);
  assert.match(loop, /pumpQuestGiverStatus(?:\?\.)?\(now\)/);
});
