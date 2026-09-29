import assert from "node:assert/strict";
import test from "node:test";

const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { parseQuestList } = await import("../dist/code/world/NpcProtocol.js");
const { buildQuestLogView, QUEST_STATE_COMPLETE } = await import("../dist/code/world/QuestProtocol.js");
const { FRAMEXML_QUEST_MENU_DATA_BINDINGS, frameXmlQuestMenuSelection,
  frameXmlQuestMenuFactsFromQuestLog } =
  await import("../dist/code/browser/framexml/FrameXmlQuestMenuData.js");

function questList(entries, greeting = "Добро пожаловать") {
  const writer = new PacketWriter().u64(0xf130000000001234n).cString(greeting)
    .u32(0).u32(0).u8(entries.length);
  for (const { id, icon, level = 20, flags = 0, repeatable = false, title } of entries) {
    writer.u32(id).u32(icon).i32(level).u32(flags).u8(repeatable ? 1 : 0).cString(title);
  }
  return parseQuestList(writer.toUint8Array());
}

const call = (name, list, index, facts) => FRAMEXML_QUEST_MENU_DATA_BINDINGS[name](list, index, facts);

test("stock greeting groups parsed quest rows in wire order with separate 1-based indices", () => {
  const list = questList([
    { id: 40, icon: 4, title: "Текущая первая" },
    { id: 41, icon: 2, title: "Доступная первая" },
    { id: 42, icon: 4, title: "Текущая вторая" },
    { id: 43, icon: 0, title: "Доступная вторая", flags: 0x1000, repeatable: true },
  ]);
  assert.deepEqual(call("GetGreetingText", list), ["Добро пожаловать"]);
  assert.deepEqual(call("GetNumActiveQuests", list), [2]);
  assert.deepEqual(call("GetNumAvailableQuests", list), [2]);
  assert.deepEqual(call("GetActiveTitle", list, 1), ["Текущая первая", undefined]);
  assert.deepEqual(call("GetActiveTitle", list, 2), ["Текущая вторая", undefined]);
  assert.deepEqual(call("GetAvailableTitle", list, 1), ["Доступная первая"]);
  assert.deepEqual(call("GetAvailableTitle", list, 2), ["Доступная вторая"]);
  assert.deepEqual(call("GetAvailableQuestInfo", list, 1), [undefined, false, false]);
  assert.deepEqual(call("GetAvailableQuestInfo", list, 2), [undefined, true, true]);
  assert.deepEqual(call("IsActiveQuestTrivial", list, 1), []);
  assert.deepEqual(frameXmlQuestMenuSelection(list, "active", 2),
    { guid: list.guid, questId: 42, completion: true });
  assert.deepEqual(frameXmlQuestMenuSelection(list, "available", 2),
    { guid: list.guid, questId: 43, completion: false });
});

test("independently supplied complete and trivial facts preserve false and true", () => {
  const list = questList([
    { id: 40, icon: 4, title: "Текущая" },
    { id: 41, icon: 2, title: "Доступная", flags: 0x1000 },
  ]);
  const facts = {
    activeCompleteByQuestId: new Map([[40, false]]),
    trivialByQuestId: new Map([[40, true], [41, false]]),
  };
  assert.deepEqual(call("GetActiveTitle", list, 1, facts), ["Текущая", false]);
  assert.deepEqual(call("IsActiveQuestTrivial", list, 1, facts), [true]);
  assert.deepEqual(call("GetAvailableQuestInfo", list, 1, facts), [false, true, false]);
});

test("GetActiveTitle completion comes from the player's quest-log state bit only", () => {
  const list = questList([
    { id: 40, icon: 4, title: "Завершена" },
    { id: 41, icon: 4, title: "В процессе" },
    { id: 42, icon: 4, title: "Без строки журнала", repeatable: true },
  ]);
  const questLog = buildQuestLogView([
    { slot: 0, questId: 40, state: QUEST_STATE_COMPLETE, counters: [0, 0, 0, 0], timer: 0 },
    { slot: 1, questId: 41, state: 0, counters: [0, 0, 0, 0], timer: 0 },
  ], new Map());
  const facts = frameXmlQuestMenuFactsFromQuestLog(questLog);
  assert.deepEqual(call("GetActiveTitle", list, 1, facts), ["Завершена", true]);
  assert.deepEqual(call("GetActiveTitle", list, 2, facts), ["В процессе", false]);
  assert.deepEqual(call("GetActiveTitle", list, 3, facts), ["Без строки журнала", undefined]);
  assert.deepEqual(call("IsActiveQuestTrivial", list, 1, facts), [],
    "the journal completion bit does not establish the client's trivial threshold");
});

test("no page, invalid indices and unrecognized icon fail closed without inventing rows", () => {
  for (const name of Object.keys(FRAMEXML_QUEST_MENU_DATA_BINDINGS))
    assert.deepEqual(call(name, undefined, 1), [], name);

  const list = questList([{ id: 40, icon: 4, title: "Текущая" }], "");
  assert.deepEqual(call("GetGreetingText", list), [""], "present empty greeting is not nil");
  assert.deepEqual(call("GetNumAvailableQuests", list), [0]);
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2]) {
    assert.deepEqual(call("GetActiveTitle", list, invalid), []);
    assert.deepEqual(call("GetAvailableTitle", list, invalid), []);
    assert.equal(frameXmlQuestMenuSelection(list, "active", invalid), undefined);
  }

  const unknown = questList([{ id: 40, icon: 99, title: "Неизвестный тип" }]);
  assert.deepEqual(call("GetGreetingText", unknown), ["Добро пожаловать"]);
  assert.deepEqual(call("GetNumActiveQuests", unknown), []);
  assert.deepEqual(call("GetNumAvailableQuests", unknown), []);
  assert.deepEqual(call("GetActiveTitle", unknown, 1), []);
  assert.equal(frameXmlQuestMenuSelection(unknown, "available", 1), undefined);
});
