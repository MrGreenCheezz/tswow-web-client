import assert from "node:assert/strict";
import test from "node:test";

const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { parseQuestDetails, parseQuestRequestItems, parseQuestOfferReward } =
  await import("../dist/code/world/NpcProtocol.js");
const { FRAMEXML_QUEST_GIVER_DATA_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlQuestGiverData.js");

function writeRewards(writer, offer, money = 0) {
  writer.u32(0).u32(0).i32(money).u32(27).u32(3).f32(0);
  if (offer) writer.u32(0);
  writer.u32(0).i32(0).u32(0).u32(0).u32(0).u32(0);
  for (let index = 0; index < 15; index++) writer.u32(0);
  return writer;
}

function detailsPacket({ title = "Отыскать следы", text = "Выслушай рассказ старосты.",
  objectives = "Найти три следа.", group = 2, money = -125 } = {}) {
  const writer = new PacketWriter().u64(0xf130000000001234n).u64(0n).u32(42)
    .cString(title).cString(text)
    .cString(objectives).u8(0).u32(0).u32(group).u8(0);
  writeRewards(writer, false, money).i32(0);
  return parseQuestDetails(writer.toUint8Array());
}

function requestPacket(canComplete) {
  const writer = new PacketWriter().u64(0xf130000000001234n).u32(42)
    .cString("Отыскать следы").cString("Ты нашёл следы?")
    .u32(0).u32(0).u32(0).u32(0).u32(2).u32(125)
    .u32(1).u32(25).u32(3).u32(1542)
    .u32(canComplete ? 1 : 0).u32(0).u32(0).u32(0);
  return parseQuestRequestItems(writer.toUint8Array());
}

function rewardPacket() {
  const writer = new PacketWriter().u64(0xf130000000001234n).u32(42)
    .cString("Отыскать следы").cString("Вот твоя награда.")
    .u8(0).u32(0).u32(2).u32(0);
  writeRewards(writer, true, -125);
  return parseQuestOfferReward(writer.toUint8Array());
}

const call = (name, dialog) => FRAMEXML_QUEST_GIVER_DATA_BINDINGS[name](dialog);

test("QuestFrame detail text comes from the parsed detail packet only", () => {
  const dialog = detailsPacket();
  assert.deepEqual(call("GetTitleText", dialog), ["Отыскать следы"]);
  assert.deepEqual(call("GetQuestText", dialog), ["Выслушай рассказ старосты."]);
  assert.deepEqual(call("GetObjectiveText", dialog), ["Найти три следа."]);
  assert.deepEqual(call("GetSuggestedGroupNum", dialog), [2]);
  assert.deepEqual(call("GetQuestMoneyToGet", dialog), [125]);
  assert.deepEqual(call("GetProgressText", dialog), []);
  assert.deepEqual(call("GetRewardText", dialog), []);
  assert.deepEqual(call("IsQuestCompletable", dialog), []);
  assert.deepEqual(call("GetNumQuestItems", dialog), []);
});

test("QuestFrame progress uses server-completability, required items and money", () => {
  const incomplete = requestPacket(false);
  assert.deepEqual(call("GetTitleText", incomplete), ["Отыскать следы"]);
  assert.deepEqual(call("GetProgressText", incomplete), ["Ты нашёл следы?"]);
  assert.deepEqual(call("GetSuggestedGroupNum", incomplete), [2]);
  assert.deepEqual(call("GetQuestMoneyToGet", incomplete), [125]);
  assert.deepEqual(call("GetNumQuestItems", incomplete), [1]);
  assert.deepEqual(call("IsQuestCompletable", incomplete), [false], "false is a real packet value, not nil");
  assert.deepEqual(call("GetQuestText", incomplete), []);
  assert.deepEqual(call("GetObjectiveText", incomplete), []);
  const complete = requestPacket(true);
  assert.deepEqual(call("IsQuestCompletable", complete), [true]);
});

test("QuestFrame reward text and payment come from the signed offer packet", () => {
  const dialog = rewardPacket();
  assert.deepEqual(call("GetTitleText", dialog), ["Отыскать следы"]);
  assert.deepEqual(call("GetRewardText", dialog), ["Вот твоя награда."]);
  assert.deepEqual(call("GetSuggestedGroupNum", dialog), [2]);
  assert.deepEqual(call("GetQuestMoneyToGet", dialog), [125]);
  assert.deepEqual(call("GetQuestText", dialog), []);
  assert.deepEqual(call("GetProgressText", dialog), []);
});

test("no active dialog leaves every giver data API nil", () => {
  for (const name of Object.keys(FRAMEXML_QUEST_GIVER_DATA_BINDINGS)) {
    assert.deepEqual(call(name, undefined), [], name);
  }
});

test("present empty strings and zero values stay distinct from nil", () => {
  const dialog = detailsPacket({ title: "", text: "", objectives: "", group: 0, money: 0 });
  assert.deepEqual(call("GetTitleText", dialog), [""]);
  assert.deepEqual(call("GetQuestText", dialog), [""]);
  assert.deepEqual(call("GetObjectiveText", dialog), [""]);
  assert.deepEqual(call("GetSuggestedGroupNum", dialog), [0]);
  assert.deepEqual(call("GetQuestMoneyToGet", dialog), [0]);
});
