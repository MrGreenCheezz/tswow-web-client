import assert from "node:assert/strict";
import test from "node:test";

const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { parseQuestDetails, parseQuestRequestItems, parseQuestOfferReward } =
  await import("../dist/code/world/NpcProtocol.js");
const { FRAMEXML_QUEST_REWARD_DATA_BINDINGS, selectedCoreQuestHonorPoints, cachedQuestRewardSpellInfo } =
  await import("../dist/code/browser/framexml/FrameXmlQuestRewardData.js");

function writeRewards(writer, offer, money) {
  writer.u32(2)
    .u32(25).u32(2).u32(125)
    .u32(26).u32(1).u32(126)
    .u32(1).u32(30).u32(3).u32(130)
    .i32(money).u32(245).u32(50).f32(0);
  if (offer) writer.u32(0);
  writer.u32(1234).i32(5678).u32(33).u32(2).u32(4).u32(0);
  for (let index = 0; index < 15; index++) writer.u32(0);
  return writer;
}

function rewardPacket(money = 125) {
  const writer = new PacketWriter().u64(0xf130000000001234n).u32(42)
    .cString("Награда").cString("Выбери предмет.")
    .u8(0).u32(0).u32(2).u32(0);
  writeRewards(writer, true, money);
  return parseQuestOfferReward(writer.toUint8Array());
}

function detailsPacket() {
  const writer = new PacketWriter().u64(0xf130000000001234n).u64(0n).u32(42)
    .cString("Награда").cString("Описание").cString("Цель")
    .u8(0).u32(0).u32(2).u8(0);
  writeRewards(writer, false, -125).i32(0);
  return parseQuestDetails(writer.toUint8Array());
}

function requestPacket() {
  const writer = new PacketWriter().u64(0xf130000000001234n).u32(42)
    .cString("Награда").cString("Сдача")
    .u32(0).u32(0).u32(0).u32(0).u32(2).u32(125)
    .u32(1).u32(40).u32(4).u32(140)
    .u32(1).u32(0).u32(0).u32(0);
  return parseQuestRequestItems(writer.toUint8Array());
}

const cached = {
  item: (id, displayId) => {
    if (id === 25 && displayId === 125) return { name: "Кольцо", texture: "Interface\\Icons\\Ring", quality: 2, isUsable: true };
    if (id === 30 && displayId === 130) return { name: "Плащ", texture: "Interface\\Icons\\Cape", quality: 3, isUsable: false };
    if (id === 40 && displayId === 140) return { name: "Печать", texture: "Interface\\Icons\\Seal", quality: 1 };
    return undefined;
  },
  spell: (id) => id === 1234
    ? cachedQuestRewardSpellInfo({ iconPath: "Interface\\Icons\\Spell", name: "Обучение" }, false)
    : undefined,
  title: (id) => id === 33 ? "Хранитель" : undefined,
};
const call = (name, dialog, args = [], metadata = cached) =>
  FRAMEXML_QUEST_REWARD_DATA_BINDINGS[name](dialog, args, metadata);

test("stock QuestInfo reward counts and scalar fields use the parsed giver packet", () => {
  const dialog = rewardPacket();
  assert.deepEqual(call("GetNumQuestChoices", dialog), [2]);
  assert.deepEqual(call("GetNumQuestRewards", dialog), [1]);
  assert.deepEqual(call("GetRewardMoney", dialog), [125]);
  assert.deepEqual(call("GetRewardXP", dialog), [245]);
  assert.deepEqual(call("GetRewardArenaPoints", dialog), [4]);
  assert.deepEqual(call("GetRewardTalents", dialog), [2]);
  assert.deepEqual(call("GetRewardHonor", dialog), [5], "the selected core sends ten wire units per point");
  assert.deepEqual(call("GetRewardTitle", dialog), ["Хранитель"]);
  assert.deepEqual(call("GetRewardSpell", dialog), ["Interface\\Icons\\Spell", "Обучение", undefined, false]);
  assert.deepEqual(call("GetRewardMoney", rewardPacket(-125)), [0], "a paid quest is not a 2^32 reward");
  assert.deepEqual(call("GetRewardMoney", detailsPacket()), [0]);
});

test("GetQuestItemInfo selects required, choice and fixed reward lists by 1-based index", () => {
  const reward = rewardPacket();
  assert.deepEqual(call("GetQuestItemInfo", reward, ["choice", 1]),
    ["Кольцо", "Interface\\Icons\\Ring", 2, 2, true]);
  assert.deepEqual(call("GetQuestItemInfo", reward, ["reward", 1]),
    ["Плащ", "Interface\\Icons\\Cape", 3, 3, false]);
  assert.deepEqual(call("GetQuestItemInfo", requestPacket(), ["required", 1]),
    ["Печать", "Interface\\Icons\\Seal", 4, 1, undefined]);
  assert.deepEqual(call("GetQuestItemInfo", detailsPacket(), ["choice", 1]),
    ["Кольцо", "Interface\\Icons\\Ring", 2, 2, true]);
  for (const args of [["choice", 0], ["choice", -1], ["choice", 1.5], ["choice", 3],
    ["reward", 2], ["required", 1], ["unknown", 1]]) {
    assert.deepEqual(call("GetQuestItemInfo", reward, args), [], JSON.stringify(args));
  }
});

test("unresolved cached metadata is Lua nil; IDs never masquerade as names or titles", () => {
  const dialog = rewardPacket();
  assert.deepEqual(call("GetQuestItemInfo", dialog, ["choice", 2]), [], "unknown item metadata is nil");
  assert.deepEqual(call("GetQuestItemInfo", dialog, ["choice", 1], {
    item: () => ({ name: "Кольцо" }),
  }), [], "an unresolved icon keeps the entire stock item tuple nil");
  assert.deepEqual(call("GetRewardTitle", dialog, [], { item: cached.item }), [], "titleId is not display text");
  assert.deepEqual(call("GetRewardSpell", dialog, [], { item: cached.item }), [], "spell id is not display text");
  assert.deepEqual(call("GetRewardHonor", dialog, [], { item: cached.item }), [5]);
  for (const name of Object.keys(FRAMEXML_QUEST_REWARD_DATA_BINDINGS)) {
    assert.deepEqual(call(name, undefined, ["choice", 1]), [], name);
  }
});

test("selected-core honor conversion and cached spell tuple reject unresolved data", () => {
  assert.equal(selectedCoreQuestHonorPoints(250), 25);
  assert.equal(selectedCoreQuestHonorPoints(0), 0);
  for (const invalid of [-10, 11, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(selectedCoreQuestHonorPoints(invalid), undefined);
  }
  assert.deepEqual(cachedQuestRewardSpellInfo({ iconPath: "Interface\\Icons\\Spell", name: "Обучение" }, true),
    ["Interface\\Icons\\Spell", "Обучение", undefined, true]);
  assert.equal(cachedQuestRewardSpellInfo({ iconPath: "", name: "Обучение" }), undefined);
  assert.equal(cachedQuestRewardSpellInfo({ iconPath: "Interface\\Icons\\Spell", name: "" }), undefined);
  assert.equal(cachedQuestRewardSpellInfo(undefined), undefined);
});
