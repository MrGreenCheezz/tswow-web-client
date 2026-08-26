import assert from "node:assert/strict";
import test from "node:test";
import { PacketWriter } from "../dist/code/protocol/index.js";
import {
  QUEST_STATE_COMPLETE, QUEST_STATE_FAIL, QUEST_STATUS_AVAILABLE, QUEST_STATUS_REWARD,
  buildAbandonQuest, buildQuestLogView, buildQuestPoiQuery, parseCompletedQuests, parseGossipPoi,
  parseQuestConfirmAccept, parseQuestGiverStatus, parseQuestGiverStatusMultiple, parseQuestIdUpdate,
  parseQuestKillUpdate, parseQuestPoi, parseQuestQueryResponse,
} from "../dist/code/world/QuestProtocol.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const GIVER = 0xf130000000000303n;

/**
 * Writes a quest the way `QueryQuestInfoResponse::Write` does. Everything this client does not read
 * still has to be written, or every field after it lands one place to the left.
 */
function writeQuest({ questId = 62, title = "Волки у ворот", objectives = [], items = [] } = {}) {
  const writer = new PacketWriter();
  writer.u32(questId).u32(2).u32(10).u32(6).u32(12);       // id, method, level, min level, sort
  writer.u32(0).u32(0);                                     // type, suggested players
  for (let team = 0; team < 2; team++) writer.u32(0).u32(0); // required faction id and value
  writer.u32(0).u32(0);                                     // next quest, xp difficulty
  writer.u32(1200).u32(0).u32(0).u32(0);                    // money, bonus money, display spell, spell
  writer.u32(0).f32(0).u32(0);                              // honor, kill honor, start item
  writer.u32(0x08).u32(0).u32(0).u32(0).u32(0).u32(0);      // flags, title id, kills, talents, arena, faction flags
  for (let index = 0; index < 4; index++) writer.u32(index === 0 ? 117 : 0).u32(index === 0 ? 5 : 0);
  for (let index = 0; index < 6; index++) writer.u32(index === 0 ? 2504 : 0).u32(index === 0 ? 1 : 0);
  for (let index = 0; index < 15; index++) writer.u32(0);   // five factions: ids, values, overrides
  writer.u32(0).f32(-9450.5).f32(60.25).u32(1);             // point of interest
  writer.cString(title).cString("Убей волков").cString("Подробности").cString("Область").cString("Готово");
  for (let index = 0; index < 4; index++) {
    const objective = objectives[index];
    writer.u32(objective?.entry ?? 0).u32(objective?.count ?? 0).u32(0).u32(0);
  }
  for (let index = 0; index < 6; index++) {
    const item = items[index];
    writer.u32(item?.itemId ?? 0).u32(item?.count ?? 0);
  }
  for (let index = 0; index < 4; index++) writer.cString(objectives[index]?.text ?? "");
  return writer.toUint8Array();
}

test("a quest description decodes, including the bit that means gameobject", () => {
  const payload = writeQuest({
    objectives: [
      { entry: 299, count: 10, text: "Лесной волк убит" },
      // The core sets the top bit to say "this entry is a gameobject, not a creature".
      { entry: (0x8000_0000 | 1617) >>> 0, count: 5, text: "Куст собран" },
    ],
    items: [{ itemId: 769, count: 8 }],
  });

  const quest = parseQuestQueryResponse(payload);
  assert.equal(quest.questId, 62);
  assert.equal(quest.title, "Волки у ворот");
  assert.equal(quest.level, 10);
  assert.equal(quest.rewardMoney, 1200);
  assert.deepEqual(quest.rewardItems, [{ itemId: 117, count: 5 }]);
  assert.deepEqual(quest.rewardChoiceItems, [{ itemId: 2504, count: 1 }]);
  assert.deepEqual(quest.itemObjectives, [{ itemId: 769, count: 8 }]);
  assert.equal(quest.objectives.length, 2);
  assert.deepEqual(quest.objectives[0], { entry: 299, count: 10, gameObject: false, itemDrop: 0, text: "Лесной волк убит" });
  assert.equal(quest.objectives[1].entry, 1617, "the id is what is left after the flag comes off");
  assert.equal(quest.objectives[1].gameObject, true);
  assert.ok(Math.abs(quest.poi.x - -9450.5) < 0.01);
});

test("the log joins what the fields count to what the quest is", () => {
  const template = parseQuestQueryResponse(writeQuest({
    objectives: [{ entry: 299, count: 10, text: "Лесной волк убит" }],
    items: [{ itemId: 769, count: 8 }],
  }));
  const templates = new Map([[62, template]]);

  const view = buildQuestLogView([
    { slot: 0, questId: 62, state: 0, counters: [7, 0, 0, 0], timer: 0 },
    { slot: 1, questId: 999, state: QUEST_STATE_COMPLETE, counters: [0, 0, 0, 0], timer: 0 },
    { slot: 2, questId: 62, state: QUEST_STATE_FAIL, counters: [10, 0, 0, 0], timer: 1_700_000_000 },
  ], templates);

  assert.equal(view[0].objectives[0].text, "Лесной волк убит");
  assert.deepEqual([view[0].objectives[0].have, view[0].objectives[0].need], [7, 10]);
  assert.equal(view[0].objectives[0].done, false);
  // The item objective is listed even though its tally lives in the bags rather than in a counter.
  assert.equal(view[0].objectives[1].need, 8);

  // A quest whose description has not arrived is still in the log; the log knows it is there
  // before it knows its name.
  assert.equal(view[1].template, undefined);
  assert.equal(view[1].complete, true);

  assert.equal(view[2].failed, true);
  assert.equal(view[2].objectives[0].done, true);
  assert.equal(view[2].timer, 1_700_000_000);
});

test("quest giver marks, progress and finishing decode", () => {
  assert.deepEqual(parseQuestGiverStatus(new PacketWriter().u64(GIVER).u8(QUEST_STATUS_AVAILABLE).toUint8Array()),
    { guid: GIVER, status: QUEST_STATUS_AVAILABLE });

  const many = parseQuestGiverStatusMultiple(new PacketWriter().u32(2)
    .u64(GIVER).u8(QUEST_STATUS_REWARD)
    .u64(0x44n).u8(QUEST_STATUS_AVAILABLE)
    .toUint8Array());
  assert.equal(many.length, 2);
  assert.equal(many[0].status, QUEST_STATUS_REWARD);

  const kill = parseQuestKillUpdate(new PacketWriter().u32(62).u32(299).u32(3).u32(10).u64(GIVER).toUint8Array());
  assert.deepEqual([kill.questId, kill.entry, kill.count, kill.required], [62, 299, 3, 10]);

  assert.equal(parseQuestIdUpdate(new PacketWriter().u32(62).toUint8Array()), 62);

  const shared = parseQuestConfirmAccept(new PacketWriter().u32(62).cString("Волки у ворот").u64(GIVER).toUint8Array());
  assert.deepEqual(shared, { questId: 62, title: "Волки у ворот", initiatorGuid: GIVER });

  assert.deepEqual(parseCompletedQuests(new PacketWriter().u32(3).u32(1).u32(7).u32(62).toUint8Array()), [1, 7, 62]);
});

test("points of interest decode, and the query names the quests it wants", () => {
  const payload = new PacketWriter().u32(1)
    .u32(62).u32(1)
    .u32(0).u32(-1).u32(0).u32(1519).u32(0).u32(0).u32(0).u32(2)
    .u32(0xffff_dc20).u32(100)
    .u32(50).u32(0xffff_ff9c)
    .toUint8Array();
  const poi = parseQuestPoi(payload);
  const blobs = poi.get(62);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].objectiveIndex, -1);
  assert.equal(blobs[0].worldMapAreaId, 1519);
  // The points are signed: half the world is at negative coordinates.
  assert.deepEqual(blobs[0].points, [{ x: -9184, y: 100 }, { x: 50, y: -100 }]);

  assert.deepEqual([...buildQuestPoiQuery([62, 63])], [2, 0, 0, 0, 62, 0, 0, 0, 63, 0, 0, 0]);
  assert.deepEqual([...buildAbandonQuest(3)], [3]);

  const gossip = parseGossipPoi(new PacketWriter().u32(1).f32(-9450).f32(60).u32(7).u32(0).cString("Кузница").toUint8Array());
  assert.equal(gossip.name, "Кузница");
  assert.equal(gossip.icon, 7);
});

test("quest markers are asked for in chunks the log's own size and kept when they come back empty", async () => {
  // A quest with nowhere to go comes back with an empty list, and that is an answer: kept, so the
  // map does not ask for it again on every log change for the rest of the session.
  const response = new PacketWriter().u32(2)
    .u32(100).u32(0)
    .u32(101).u32(1)
    .u32(0).i32(0).u32(0).u32(30).u32(0).u32(0).u32(0).u32(2)
    .i32(-9450).i32(-60)
    .i32(-9400).i32(-70)
    .toUint8Array();
  const login = new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array();
  const connection = {
    sent: [],
    packets: [
      { opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD, payload: login },
      { opcode: OPCODES.SMSG_QUEST_POI_QUERY_RESPONSE, payload: response },
    ],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  await client.loginCharacter(1n);
  await Promise.resolve();
  await Promise.resolve();

  // Twenty-six quests. `MAX_QUEST_LOG_SIZE` is 25, and a query naming more is dropped **whole**
  // rather than trimmed — so one oversized packet loses every marker, not just the extra one.
  const questIds = Array.from({ length: 26 }, (_, index) => 100 + index);
  client.requestQuestPoi(questIds);
  const queries = connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_QUEST_POI_QUERY);
  assert.equal(queries.length, 2, "26 ids is two packets, not one the server will throw away");
  assert.deepEqual(queries[0].payload, buildQuestPoiQuery(questIds.slice(0, 25)));
  assert.deepEqual(queries[1].payload, buildQuestPoiQuery(questIds.slice(25)));
  assert.equal(client.requestQuestPoi([]) ?? true, true, "an empty log sends nothing");
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_QUEST_POI_QUERY).length, 2);

  assert.deepEqual(client.questPoi.get(100), []);
  assert.equal(client.questPoi.has(100), true, "empty and never-asked have to be different");
  assert.equal(client.questPoi.get(101)?.[0]?.worldMapAreaId, 30);
  assert.deepEqual(client.questPoi.get(101)?.[0]?.points, [{ x: -9450, y: -60 }, { x: -9400, y: -70 }]);
});
