import assert from "node:assert/strict";
import test from "node:test";

const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { parseQuestDetails, parseQuestOfferReward, parseQuestRequestItems } =
  await import("../dist/code/world/NpcProtocol.js");
const { FRAMEXML_QUEST_FLAGS_DATA_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlQuestFlagsData.js");

const QUEST_FLAGS_PVP = 0x00002000;
const QUEST_FLAGS_AUTO_ACCEPT = 0x00080000;

function writeRewards(writer, offer = false) {
  writer.u32(0).u32(0).i32(0).u32(0).u32(0).f32(0);
  if (offer) writer.u32(0);
  writer.u32(0).i32(0).u32(0).u32(0).u32(0).u32(0);
  for (let index = 0; index < 15; index++) writer.u32(0);
  return writer;
}

function detailPacket(flags, autoLaunched = false) {
  const writer = new PacketWriter().u64(0xf130000000001234n).u64(0n).u32(42)
    .cString("Задание").cString("Описание").cString("Цель")
    .u8(autoLaunched ? 1 : 0).u32(flags).u32(1).u8(0);
  writeRewards(writer).i32(0);
  return parseQuestDetails(writer.toUint8Array());
}

function rewardPacket(flags) {
  const writer = new PacketWriter().u64(0xf130000000001234n).u32(42)
    .cString("Задание").cString("Награда").u8(0).u32(flags).u32(1).u32(0);
  writeRewards(writer, true);
  return parseQuestOfferReward(writer.toUint8Array());
}

function requestPacket(flags) {
  const writer = new PacketWriter().u64(0xf130000000001234n).u32(42)
    .cString("Задание").cString("Прогресс")
    .u32(0).u32(0).u32(0).u32(flags).u32(1).u32(0)
    .u32(0).u32(0).u32(0).u32(0).u32(0);
  return parseQuestRequestItems(writer.toUint8Array());
}

const call = (name, dialog) => FRAMEXML_QUEST_FLAGS_DATA_BINDINGS[name](dialog);

test("stock detail flags are decoded independently from the parsed Flags word", () => {
  assert.deepEqual(call("QuestGetAutoAccept", detailPacket(0)), [false]);
  assert.deepEqual(call("QuestFlagsPVP", detailPacket(0)), [false]);
  assert.deepEqual(call("QuestGetAutoAccept", detailPacket(QUEST_FLAGS_AUTO_ACCEPT)), [true]);
  assert.deepEqual(call("QuestFlagsPVP", detailPacket(QUEST_FLAGS_AUTO_ACCEPT)), [false]);
  assert.deepEqual(call("QuestGetAutoAccept", detailPacket(QUEST_FLAGS_PVP)), [false]);
  assert.deepEqual(call("QuestFlagsPVP", detailPacket(QUEST_FLAGS_PVP)), [true]);
  assert.deepEqual(call("QuestGetAutoAccept", detailPacket(QUEST_FLAGS_PVP | QUEST_FLAGS_AUTO_ACCEPT)), [true]);
  assert.deepEqual(call("QuestFlagsPVP", detailPacket(QUEST_FLAGS_PVP | QUEST_FLAGS_AUTO_ACCEPT)), [true]);
});

test("autoLaunched and unrelated quest bits do not imply auto accept or PvP", () => {
  const dialog = detailPacket(0x00001000, true);
  assert.equal(dialog.autoLaunched, true);
  assert.deepEqual(call("QuestGetAutoAccept", dialog), [false]);
  assert.deepEqual(call("QuestFlagsPVP", dialog), [false]);
});

test("without an active detail page the detail-only stock flags remain Lua nil", () => {
  const wrongKindFlags = QUEST_FLAGS_PVP | QUEST_FLAGS_AUTO_ACCEPT;
  for (const dialog of [undefined, rewardPacket(wrongKindFlags), requestPacket(wrongKindFlags)]) {
    assert.deepEqual(call("QuestGetAutoAccept", dialog), []);
    assert.deepEqual(call("QuestFlagsPVP", dialog), []);
  }
});
