import assert from "node:assert/strict";
import test from "node:test";

// Merged 2026-10-20 from 10 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-live-quest-npc-seam.test.mjs
{
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function creature(guid, entry, displayId) {
  return {
    guid,
    typeId: 3,
    fields: new Map([
      [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
      [UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId],
    ]),
  };
}

test("stock questnpc unit follows the active quest giver, not the selected target", () => {
  const questGiverGuid = 0x701n;
  const targetGuid = 0x702n;
  const world = {
    targetGuid,
    state: {
      selfGuid: 0x100n,
      objects: new Map([
        [questGiverGuid, creature(questGiverGuid, 9001, 2101)],
        [targetGuid, creature(targetGuid, 9002, 2102)],
      ]),
    },
    names: new Map([[targetGuid, "Другой выбранный NPC"]]),
    creatureTemplates: new Map([
      [9001, { found: true, name: "Квестодатель" }],
      [9002, { found: true, name: "Другой выбранный NPC" }],
    ]),
    questList: undefined,
    questDialog: undefined,
  };
  const seam = new LiveWorldSeam({ world: () => world, store: () => undefined });
  const unitExists = (unit) => FRAMEXML_SEAM_BINDINGS.UnitExists(seam, [unit]);
  const unitName = (unit) => FRAMEXML_SEAM_BINDINGS.UnitName(seam, [unit]);

  assert.deepEqual(unitExists("questnpc"), [false]);
  assert.deepEqual(unitName("questnpc"), []);
  assert.equal(seam.questNpcPortraitGuid(), undefined);

  world.questList = { guid: questGiverGuid, quests: [] };
  assert.deepEqual(unitExists("questnpc"), [true]);
  assert.deepEqual(unitName("questnpc"), ["Квестодатель"]);
  assert.deepEqual(unitName("target"), ["Другой выбранный NPC"]);
  assert.equal(seam.questNpcPortraitGuid(), questGiverGuid,
    "portrait follows the active quest page, not the selected target's display");

  // The list is replaced by a detail packet for the same giver.
  world.questList = undefined;
  world.questDialog = { kind: "details", guid: questGiverGuid, questId: 123 };
  assert.deepEqual(unitExists("questnpc"), [true]);
  assert.deepEqual(unitName("questnpc"), ["Квестодатель"]);

  // A cached name cannot prove whether a streamed-out GUID was a creature or a gameobject.
  world.state.objects.delete(questGiverGuid);
  world.names.set(questGiverGuid, "Квестодатель из кэша имён");
  assert.deepEqual(unitExists("questnpc"), [false]);
  assert.deepEqual(unitName("questnpc"), []);
  assert.equal(seam.questNpcPortraitGuid(), undefined);

  world.state.objects.set(questGiverGuid, creature(questGiverGuid, 9001, 2101));
  assert.deepEqual(unitExists("questnpc"), [true]);
  assert.deepEqual(unitName("questnpc"), ["Квестодатель из кэша имён"]);
  assert.equal(seam.questNpcPortraitGuid(), questGiverGuid);

  world.state.objects.get(questGiverGuid).fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, 0);
  assert.equal(seam.questNpcPortraitGuid(), undefined, "zero display has no model portrait");

  world.state.objects.set(questGiverGuid, { guid: questGiverGuid, typeId: 5, fields: new Map() });
  assert.deepEqual(unitExists("questnpc"), [false], "a gameobject giver is not a Unit");
  assert.deepEqual(unitName("questnpc"), []);
  assert.equal(seam.questNpcPortraitGuid(), undefined);

  world.questDialog = undefined;
  assert.deepEqual(unitExists("questnpc"), [false]);
  assert.deepEqual(unitName("questnpc"), []);
  assert.equal(seam.questNpcPortraitGuid(), undefined);
});
}

// ── framexml-quest-actions.test.mjs
{
const { resolveFrameXmlQuestAction } =
  await import("../dist/code/browser/framexml/FrameXmlQuestActions.js");

const guid = 0xf130000000001234n;
const list = { guid, greeting: "Привет", quests: [] };
const details = { kind: "details", guid, questId: 42, title: "Задание" };
const progress = { kind: "request-items", guid, questId: 42, canComplete: true };
const incomplete = { ...progress, canComplete: false };
const offer = (choices, requiredMoney = 0) => ({
  kind: "reward", guid, questId: 42, rewards: {
    choices: Array.from({ length: choices }, (_unused, index) => ({ id: 100 + index, count: 1, displayId: 1 })),
    requiredMoney,
  },
});
const action = (api, page = {}, options = {}) => resolveFrameXmlQuestAction(api, {
  questList: undefined, questDialog: undefined, ...page,
}, options);

test("stock accept and complete dispatch only against their live packet page", () => {
  assert.deepEqual(action("AcceptQuest", { questDialog: details }), {
    ok: true, command: { method: "acceptQuest", expectedDialog: details },
  });
  assert.deepEqual(action("CompleteQuest", { questDialog: progress }), {
    ok: true, command: { method: "requestQuestReward", expectedDialog: progress },
  });
  assert.deepEqual(action("CompleteQuest", { questDialog: incomplete }), {
    ok: false, reason: "quest-not-completable",
  });
  assert.deepEqual(action("AcceptQuest", { questDialog: progress }), {
    ok: false, reason: "wrong-dialog-kind",
  });
  assert.deepEqual(action("CompleteQuest", { questDialog: details }), {
    ok: false, reason: "wrong-dialog-kind",
  });
  assert.deepEqual(action("AcceptQuest"), { ok: false, reason: "missing-quest-page" });
});

test("stock 1-based reward choice becomes 0-based protocol choice, with exact bounds", () => {
  const reward = offer(2);
  assert.deepEqual(action("GetQuestReward", { questDialog: reward }, { luaChoice: 1 }), {
    ok: true, command: { method: "chooseQuestReward", expectedDialog: reward, choice: 0 },
  });
  assert.deepEqual(action("GetQuestReward", { questDialog: reward }, { luaChoice: 2 }), {
    ok: true, command: { method: "chooseQuestReward", expectedDialog: reward, choice: 1 },
  });
  for (const luaChoice of [0, -1, 3, 1.5, "1", undefined, Number.NaN]) {
    assert.deepEqual(action("GetQuestReward", { questDialog: reward }, { luaChoice }), {
      ok: false, reason: "invalid-choice",
    }, `choice ${String(luaChoice)}`);
  }
  const noChoice = offer(0);
  assert.deepEqual(action("GetQuestReward", { questDialog: noChoice }, { luaChoice: 0 }), {
    ok: true, command: { method: "chooseQuestReward", expectedDialog: noChoice, choice: 0 },
  });
  assert.deepEqual(action("GetQuestReward", { questDialog: noChoice }, { luaChoice: 1 }), {
    ok: false, reason: "invalid-choice",
  });
  assert.deepEqual(action("GetQuestReward", { questDialog: details }, { luaChoice: 1 }), {
    ok: false, reason: "wrong-dialog-kind",
  });
});

test("paid reward keeps the original direct C API contract", () => {
  const reward = offer(2, 125);
  // The stock QuestFrame button displays CONFIRM_COMPLETE_EXPENSIVE_QUEST before calling this
  // C API. Addons can call GetQuestReward directly in the original client; cost is server-owned.
  assert.deepEqual(action("GetQuestReward", { questDialog: reward }, { luaChoice: 2 }), {
    ok: true, command: { method: "chooseQuestReward", expectedDialog: reward, choice: 1 },
  });
});

test("decline and hide close an active page once, and conflicting state fails closed", () => {
  assert.deepEqual(action("DeclineQuest", { questDialog: details }), {
    ok: true, command: { method: "closeQuest", expectedPage: details },
  });
  assert.deepEqual(action("CloseQuest", { questList: list }), {
    ok: true, command: { method: "closeQuest", expectedPage: list },
  });
  assert.deepEqual(action("CloseQuest"), { ok: false, reason: "missing-quest-page" });
  assert.deepEqual(action("DeclineQuest"), { ok: false, reason: "missing-quest-page" });
  assert.deepEqual(action("CloseQuest", { questList: list, questDialog: details }), {
    ok: false, reason: "conflicting-quest-pages",
  });
});
}

// ── framexml-quest-controller.test.mjs
{
const controller = await import("../dist/code/browser/framexml/FrameXmlQuestController.js");

function owner(overrides = {}) {
  return {
    open: false,
    shows: 0,
    hides: 0,
    disposals: 0,
    failures: 0,
    isOpen() { return this.open; },
    show() { this.open = true; this.shows += 1; },
    hide() { this.open = false; this.hides += 1; },
    dispose() { this.disposals += 1; },
    onFailure() { this.failures += 1; },
    ...overrides,
  };
}

test("quest owner routes open/toggle/close and cleanup is identity-safe", () => {
  assert.equal(controller.frameXmlQuestOpen(), false);
  assert.equal(controller.toggleFrameXmlQuest(), false);
  assert.equal(controller.closeFrameXmlQuest(), false);

  const first = owner();
  const releaseFirst = controller.publishFrameXmlQuest(first);
  assert.equal(controller.toggleFrameXmlQuest(), true);
  assert.equal(first.open, true);
  assert.equal(first.shows, 1);
  assert.equal(controller.frameXmlQuestOpen(), true);
  assert.equal(controller.closeFrameXmlQuest(), true);
  assert.equal(first.open, false);
  assert.equal(first.hides, 1);

  const second = owner({ open: true });
  const releaseSecond = controller.publishFrameXmlQuest(second);
  assert.equal(first.hides, 2, "publishing a replacement closes the old owner");
  assert.equal(first.disposals, 1);
  releaseFirst();
  assert.equal(controller.frameXmlQuestOpen(), true, "stale cleanup cannot clear replacement");
  releaseSecond();
  releaseSecond();
  assert.equal(controller.frameXmlQuestOpen(), false);
  assert.equal(second.hides, 1);
  assert.equal(second.disposals, 1);
});

test("quest bridge failure demotes ownership and invokes fail-closed callback", () => {
  const failing = owner({
    show() { throw new Error("quest bridge diagnostic"); },
  });
  controller.publishFrameXmlQuest(failing);

  assert.equal(controller.toggleFrameXmlQuest(), false);
  assert.equal(controller.frameXmlQuestOpen(), false);
  assert.equal(failing.hides, 1, "demotion attempts visual cleanup");
  assert.equal(failing.disposals, 1);
  assert.equal(failing.failures, 1);
  assert.equal(controller.toggleFrameXmlQuest(), false, "native caller can take over after demotion");
});
}

// ── framexml-quest-flags-data.test.mjs
{
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
}

// ── framexml-quest-lifecycle.test.mjs
{
const { captureFrameXmlQuestSnapshot, frameXmlQuestLifecycleEvent } =
  await import("../dist/code/browser/framexml/FrameXmlQuestLifecycle.js");

test("QuestFrame lifecycle follows each authoritative list/dialog packet and close", () => {
  const world = { questList: undefined, questDialog: undefined, questMessage: undefined };
  let previous = captureFrameXmlQuestSnapshot(world);
  const transition = () => {
    const next = captureFrameXmlQuestSnapshot(world);
    const event = frameXmlQuestLifecycleEvent(previous, next);
    previous = next;
    return event;
  };

  assert.equal(transition(), undefined);
  world.questList = { guid: 0x700n, greeting: "Привет", quests: [] };
  assert.equal(transition(), "QUEST_GREETING");
  assert.equal(transition(), undefined, "a repaint does not reopen the greeting page");

  world.questList = undefined;
  world.questDialog = { kind: "details", guid: 0x700n, questId: 42 };
  assert.equal(transition(), "QUEST_DETAIL");

  world.questDialog = { kind: "request-items", guid: 0x700n, questId: 42 };
  assert.equal(transition(), "QUEST_PROGRESS");

  world.questDialog = { kind: "reward", guid: 0x700n, questId: 42 };
  assert.equal(transition(), "QUEST_COMPLETE");

  world.questDialog = undefined;
  world.questMessage = { error: false, text: "Задание выполнено" };
  assert.equal(transition(), "QUEST_FINISHED");
  assert.equal(transition(), undefined, "a repeated completion callback does not close again");
});

test("quest cancellation closes the page; errors and metadata repaint do not invent stock events", () => {
  const world = { questList: undefined, questDialog: undefined, questMessage: undefined };
  const empty = captureFrameXmlQuestSnapshot(world);
  world.questMessage = { error: true, text: "Журнал заданий заполнен" };
  assert.equal(frameXmlQuestLifecycleEvent(empty, captureFrameXmlQuestSnapshot(world)), undefined);

  world.questMessage = undefined;
  world.questDialog = { kind: "details", guid: 0x701n, questId: 43 };
  const detail = captureFrameXmlQuestSnapshot(world);
  assert.equal(frameXmlQuestLifecycleEvent(empty, detail), "QUEST_DETAIL");
  world.questMessage = { error: true, text: "Сервер отклонил задание" };
  assert.equal(frameXmlQuestLifecycleEvent(detail, captureFrameXmlQuestSnapshot(world)), undefined);
  world.questMessage = undefined;
  assert.equal(frameXmlQuestLifecycleEvent(detail, captureFrameXmlQuestSnapshot(world)), undefined);

  world.questDialog = undefined;
  assert.equal(frameXmlQuestLifecycleEvent(detail, captureFrameXmlQuestSnapshot(world)), "QUEST_FINISHED");
  world.questList = { guid: 0x701n, greeting: "Привет", quests: [] };
  const list = captureFrameXmlQuestSnapshot(world);
  assert.equal(frameXmlQuestLifecycleEvent(empty, list), "QUEST_GREETING");
  world.questList = undefined;
  assert.equal(frameXmlQuestLifecycleEvent(list, captureFrameXmlQuestSnapshot(world)), "QUEST_FINISHED");
});

test("fresh packets reopen the same quest; a contradictory list/dialog snapshot fails closed", () => {
  const world = { questList: undefined, questDialog: undefined, questMessage: undefined };
  world.questDialog = { kind: "reward", guid: 0x702n, questId: 44 };
  const reward = captureFrameXmlQuestSnapshot(world);
  assert.equal(frameXmlQuestLifecycleEvent(undefined, reward), "QUEST_COMPLETE");
  assert.equal(frameXmlQuestLifecycleEvent(reward, reward), undefined);
  world.questDialog = { kind: "reward", guid: 0x702n, questId: 44 };
  assert.equal(frameXmlQuestLifecycleEvent(reward, captureFrameXmlQuestSnapshot(world)), "QUEST_COMPLETE");
  world.questList = { guid: 0x702n, greeting: "Привет", quests: [] };
  assert.equal(frameXmlQuestLifecycleEvent(reward, captureFrameXmlQuestSnapshot(world)), undefined);
});
}

// ── framexml-quest-menu-data.test.mjs
{
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
}

// ── framexml-quest-reward-data.test.mjs
{
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
}

// ── framexml-quest-seam.test.mjs
{
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("quest green range follows the Wrath player-level bands rather than a fixed threshold", () => {
  const seam = new CannedWorldSeam();
  let playerLevel;
  seam.unitLevel = (unit) => unit === "player" ? playerLevel : undefined;
  for (const [level, range] of [
    [undefined, 0], [0, 0], [1, 4], [9, 4], [10, 5], [19, 5],
    [20, 6], [29, 6], [30, 7], [39, 7], [40, 8], [44, 8],
    [45, 9], [49, 9], [50, 10], [54, 10], [55, 11], [59, 11], [60, 12], [80, 12],
  ]) {
    playerLevel = level;
    assert.deepEqual(call("GetQuestGreenRange", seam), [range], `player level ${level}`);
  }
});

test("canned QuestLog returns stock tuples, selection and deduplicated objective edges", () => {
  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
    now: () => 1,
  });
  assert.deepEqual(call("GetNumQuestLogEntries", seam), [1, 1]);
  assert.deepEqual(call("QuestMapUpdateAllQuests", seam), [1]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 1), [9001]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 2), []);
  assert.deepEqual(call("GetQuestLogTitle", seam, 1), [
    "Проверка журнала заданий", 60, undefined, 0, false, false, undefined, false, 9001, false,
  ]);
  assert.deepEqual(call("GetQuestLogQuestText", seam), []);
  assert.deepEqual(call("GetNumQuestLeaderBoards", seam), [0]);

  call("SelectQuestLogEntry", seam, 1);
  assert.deepEqual(call("GetQuestLogSelection", seam), [1]);
  assert.deepEqual(call("GetQuestLogQuestText", seam), ["Описание задания.", "Проверить цели."]);
  assert.deepEqual(call("GetNumQuestLeaderBoards", seam), [1]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Проверить цель: 2/5", "monster", false]);
  assert.deepEqual(call("GetQuestLogRequiredMoney", seam), [125]);
  assert.deepEqual(call("GetQuestLogTimeLeft", seam), [90]);
  assert.deepEqual(call("GetQuestLogCompletionText", seam), ["Цель выполнена."]);
  assert.deepEqual(call("GetQuestLogGroupNum", seam), [0]);
  assert.deepEqual(call("IsCurrentQuestFailed", seam), [false]);
  assert.deepEqual(call("GetNumQuestWatches", seam), [1]);
  assert.deepEqual(call("GetQuestIndexForWatch", seam, 1), [1]);
  assert.deepEqual(call("IsQuestWatched", seam, 1), [true]);

  fired.length = 0;
  call("RemoveQuestWatch", seam, 1);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 1]]);
  assert.deepEqual(call("GetNumQuestWatches", seam), [0]);
  assert.deepEqual(call("GetQuestIndexForWatch", seam, 1), []);
  assert.deepEqual(call("IsQuestWatched", seam, 1), [false]);
  fired.length = 0;
  call("RemoveQuestWatch", seam, 1);
  assert.deepEqual(fired, [], "removing an already-unwatched quest is quiet");
  call("AddQuestWatch", seam, 1, 300);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 1]]);
  fired.length = 0;
  call("AddQuestWatch", seam, 1);
  assert.deepEqual(fired, [], "adding an already-watched quest is quiet");

  assert.equal(seam.setQuestObjective(9001, 1, 5), 2);
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.questWatchUpdate, 1],
    [FRAMEXML_SEAM_EVENTS.questLogUpdate],
  ]);
  fired.length = 0;
  assert.equal(seam.setQuestObjective(9001, 1, 5), 0);
  assert.deepEqual(fired, []);
  seam.detach();
});

test("canned unresolved template stays nil until selected row is resolved", () => {
  const seam = new CannedWorldSeam([], undefined, [], [], [{ questId: 77 }]);
  call("SelectQuestLogEntry", seam, 1);
  assert.deepEqual(call("GetQuestLogTitle", seam, 1), [
    "", 0, undefined, 0, false, false, undefined, false, 77, false,
  ]);
  assert.deepEqual(call("GetQuestLogQuestText", seam), []);
  assert.deepEqual(call("GetNumQuestLeaderBoards", seam), [0]);
  assert.deepEqual(call("GetQuestLogCompletionText", seam), []);
  seam.setQuestTemplate(77, {
    title: "Resolved", level: 12, description: "Detail", objectivesText: "Objectives",
    completedText: "Done", objectives: [{ text: "One", need: 1, have: 0 }],
  });
  assert.deepEqual(call("GetQuestLogQuestText", seam), ["Detail", "Objectives"]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["One: 0/1", "monster", false]);
});

test("live QuestLog reads update fields and cached templates without per-frame scans", () => {
  const selfGuid = 0x101n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const fields = new Map([
    [base, 77], [base + 1, 0], [base + 2, 2], [base + 3, 0], [base + 4, 150],
  ]);
  const object = { guid: selfGuid, typeId: 4, fields };
  let objectReads = 0;
  const objects = { get(guid) {
    objectReads++;
    return guid === selfGuid ? object : undefined;
  } };
  const storeListeners = new Map();
  const worldListeners = new Map();
  const store = {
    field: () => () => {},
    any: () => () => {},
    events: { on: (name, listener) => {
      storeListeners.set(name, listener);
      return () => storeListeners.delete(name);
    } },
  };
  const world = {
    mapId: 1,
    state: { selfGuid, objects },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(),
    creatureTemplates: new Map(),
    gameObjectTemplates: new Map([[456, { name: "Сундук Братства" }]]),
    questTemplates: new Map(), questPoi: new Map([
      // 3.13c: a blob counts for an objective still open (Wow.exe 0x5e2950): slot 1, the chest.
      [77, [{ map: 1, worldMapAreaId: 10, objectiveIndex: 1, points: [] }]],
      [88, [{ map: 1, worldMapAreaId: 11, objectiveIndex: 1, points: [] }]],
    ]), cooldownRemaining: () => 0,
    currentServerTime: () => 100,
    queryQuestCalls: [],
    queryQuest(questId) { this.queryQuestCalls.push(questId); },
    events: { on: (name, listener) => {
      worldListeners.set(name, listener);
      return () => worldListeners.delete(name);
    } },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    creatureInfo: (entry) => entry === 123 ? { name: "Лесной волк" } : undefined,
    itemInfo: (itemId) => itemId === 999
      ? { name: "Кусок мяса вепря", texture: "Interface\\Icons\\INV_Misc_Food_16" }
      : undefined,
    worldMapAreaId: () => 10,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
    now: () => 1,
  });
  fired.length = 0;
  // A quest whose record is not cached is not listed yet, as in the client (Wow.exe 0x005e6940),
  // and building the list asks for it.
  assert.deepEqual(call("GetNumQuestLogEntries", seam), [0, 0]);
  // 3.13c: without the quest's record there is no objective mask, so no POI (Wow.exe 0x5e2950).
  assert.deepEqual(call("QuestMapUpdateAllQuests", seam), [0]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 1), []);
  assert.deepEqual(call("GetQuestLogTitle", seam, 1), [
    "", 0, undefined, 0, false, false, undefined, false, 0, false,
  ]);
  call("SelectQuestLogEntry", seam, 1);
  assert.deepEqual([...new Set(world.queryQuestCalls)], [77]);
  assert.deepEqual(call("GetQuestLogQuestText", seam), []);
  assert.deepEqual(call("GetNumQuestLeaderBoards", seam), [0]);

  world.questTemplates.set(77, {
    questId: 77, level: 10, minLevel: 1, sortId: 0, type: 0, suggestedPlayers: 2,
    nextQuest: 0, rewardMoney: 0, rewardBonusMoney: 0, rewardSpell: 0, rewardHonor: 0,
    startItem: 0, flags: 0, rewardTitleId: 0, requiredPlayerKills: 0, rewardTalents: 0,
    rewardItems: [], rewardChoiceItems: [], poi: { map: 0, x: 0, y: 0, priority: 0 },
    title: "Resolved", objectivesText: "Objectives", details: "Detail", areaDescription: "",
    completedText: "Done", objectives: [
      { entry: 123, count: 3, gameObject: false, itemDrop: 0, text: "" },
      { entry: 456, count: 1, gameObject: true, itemDrop: 0, text: "" },
    ],
    itemObjectives: [{ itemId: 999, count: 1 }],
  });
  objectReads = 0;
  worldListeners.get("QUEST_LOG_CHANGED")?.({});
  assert.ok(objectReads <= 20, "one quest-log reconciliation takes one bounded inventory snapshot");
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]]);
  fired.length = 0;
  worldListeners.get("QUEST_LOG_CHANGED")?.({});
  assert.deepEqual(fired, [], "same template edge is deduplicated");
  // Now listed: line 1 is its ZoneOrSort 0 header, the quest is line 2.
  assert.deepEqual(call("GetNumQuestLogEntries", seam), [2, 1]);
  assert.deepEqual(call("GetQuestLogTitle", seam, 1), [
    "Missing header! (quest designers)", 0, undefined, 0, true, false, undefined, false, 0, false,
  ]);
  call("SelectQuestLogEntry", seam, 2);
  assert.deepEqual(call("GetQuestLogQuestText", seam), ["Detail", "Objectives"]);
  assert.equal(world.creatureTemplates.size, 0,
    "stock names an objective directly from context metadata without a world template");
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Лесной волк: 2/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Сундук Братства: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Кусок мяса вепря", "item", false]);
  assert.deepEqual(call("GetQuestLogTimeLeft", seam), [50]);
  assert.deepEqual(call("GetQuestLogGroupNum", seam), [2]);
  assert.deepEqual(call("GetNumQuestWatches", seam), [1], "live defaults current rows to watched");
  assert.deepEqual(call("GetQuestIndexForWatch", seam, 1), [2]);
  assert.deepEqual(call("IsQuestWatched", seam, 2), [true]);
  fired.length = 0;
  call("RemoveQuestWatch", seam, 2);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2]]);
  fired.length = 0;
  call("RemoveQuestWatch", seam, 2);
  assert.deepEqual(fired, [], "live duplicate removal is quiet");
  call("AddQuestWatch", seam, 2, 300);
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2]]);
  fired.length = 0;

  worldListeners.get("QUEST_PROGRESS")?.({ questId: 77, entry: 123, count: 2, required: 3 });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2]]);
  worldListeners.get("QUEST_PROGRESS")?.({ questId: 77, entry: 123, count: 2, required: 3 });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2]], "same progress is quiet");

  fields.set(base + 2, 3);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2],
    [FRAMEXML_SEAM_EVENTS.unitQuestLogChanged, "player"],
  ]);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(fired, [
    [FRAMEXML_SEAM_EVENTS.questWatchUpdate, 2],
    [FRAMEXML_SEAM_EVENTS.unitQuestLogChanged, "player"],
  ], "same field shape is quiet");
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Лесной волк: 3/3", "monster", true]);
  assert.deepEqual(call("GetNumQuestWatches", seam), [1]);
  assert.deepEqual(call("GetQuestIndexForWatch", seam, 1), [2]);
  assert.deepEqual(call("IsQuestWatched", seam, 2), [true]);

  // Explicit removals are retained by quest id when a row leaves and later returns; new ids
  // retain the native-compatible default watched state.
  const stride = UPDATE_FIELDS.PLAYER_QUEST_LOG_2_1.offset - base;
  call("RemoveQuestWatch", seam, 2);
  fields.set(base, 0);
  fields.set(base + stride, 77);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(call("IsQuestWatched", seam, 2), [false]);
  world.questTemplates.set(88, { ...world.questTemplates.get(77), questId: 88, title: "Other" });
  fields.set(base + stride, 88);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(call("IsQuestWatched", seam, 2), [true]);

  fields.set(base, 77);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(call("QuestMapUpdateAllQuests", seam), [1],
    "current map area excludes a remote WorldMapArea on the same map");
  // The second value is the quest's displayed log row: header, «Other» (88), «Resolved» (77).
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 1), [77, 3]);
  assert.deepEqual(call("QuestPOIGetQuestIDByVisibleIndex", seam, 2), []);

  fired.length = 0;
  objectReads = 0;
  seam.tick(1.01);
  const readsAfterBoundary = objectReads;
  seam.tick(1.02);
  assert.equal(objectReads, readsAfterBoundary, "sub-60ms render does not rescan quest state");
  seam.tick(1.08);
  assert.deepEqual(fired.filter(([event]) => [
    FRAMEXML_SEAM_EVENTS.questLogUpdate,
    FRAMEXML_SEAM_EVENTS.unitQuestLogChanged,
    FRAMEXML_SEAM_EVENTS.questWatchUpdate,
  ].includes(event)), [], "quest events come only from authoritative edges");
  seam.detach();
});

test("stock QuestLog prefetches cold objective metadata when a cached quest enters the player log", () => {
  const selfGuid = 0x202n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const fields = new Map([[base, 0], [base + 1, 0], [base + 2, 0], [base + 3, 0]]);
  const object = { guid: selfGuid, typeId: 4, fields };
  const storeListeners = new Map();
  const worldListeners = new Map();
  const store = {
    field: () => () => {},
    any: () => () => {},
    events: { on: (name, listener) => {
      storeListeners.set(name, listener);
      return () => storeListeners.delete(name);
    } },
  };
  const questTemplate = {
    questId: 77, level: 10, minLevel: 1, sortId: 0, type: 0, suggestedPlayers: 0,
    nextQuest: 0, rewardMoney: 0, rewardBonusMoney: 0, rewardSpell: 0, rewardHonor: 0,
    startItem: 0, flags: 0, rewardTitleId: 0, requiredPlayerKills: 0, rewardTalents: 0,
    rewardItems: [], rewardChoiceItems: [], poi: { map: 0, x: 0, y: 0, priority: 0 },
    title: "Cold cache", objectivesText: "Objectives", details: "Detail", areaDescription: "",
    completedText: "Done", objectives: [
      { entry: 123, count: 3, gameObject: false, itemDrop: 0, text: "" },
      { entry: 456, count: 1, gameObject: true, itemDrop: 0, text: "" },
    ],
    itemObjectives: [{ itemId: 999, count: 1 }],
  };
  const creatureQueries = [];
  const gameObjectQueries = [];
  const world = {
    mapId: 1,
    state: { selfGuid, objects: new Map([[selfGuid, object]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), itemTemplates: new Map(),
    creatureTemplates: new Map(), gameObjectTemplates: new Map(),
    questTemplates: new Map([[77, questTemplate]]), questPoi: new Map(),
    cooldownRemaining: () => 0, currentServerTime: () => 100,
    creatureTemplate(entry) {
      creatureQueries.push(entry);
      return this.creatureTemplates.get(entry);
    },
    gameObjectTemplate(entry, guid) {
      gameObjectQueries.push([entry, guid]);
      return this.gameObjectTemplates.get(entry);
    },
    events: { on: (name, listener) => {
      worldListeners.set(name, listener);
      return () => worldListeners.delete(name);
    } },
  };
  const itemMetadata = new Map();
  const prefetchCalls = [];
  let finishPrefetch;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store, spell: () => undefined,
    itemInfo: (itemId) => itemMetadata.get(itemId),
    prefetchQuestMetadata: (itemIds, spellIds, onChanged) => {
      prefetchCalls.push([[...itemIds], [...spellIds]]);
      finishPrefetch = onChanged;
    },
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({
    fire: (event, ...args) => { fired.push([event, ...args]); return 1; },
    now: () => 1,
  });
  assert.deepEqual(prefetchCalls, [], "an empty log starts no target metadata work");

  fields.set(base, 77);
  storeListeners.get("PLAYER_QUEST_LOG_UPDATE")?.({ guid: selfGuid });
  assert.deepEqual(creatureQueries, [123]);
  assert.deepEqual(gameObjectQueries, [[456, 0n]]);
  assert.deepEqual(prefetchCalls, [[[999], []]]);
  assert.equal(typeof finishPrefetch, "function");
  // Line 1 is the quest's ZoneOrSort 0 header (FrameXmlQuestLog.ts), the quest is line 2.
  call("SelectQuestLogEntry", seam, 2);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Существо #123: 0/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Объект #456: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Предмет #999", "item", false]);

  world.creatureTemplates.set(123, { name: "Лесной волк" });
  world.gameObjectTemplates.set(456, { name: "Сундук Братства" });
  itemMetadata.set(999, {
    name: "Кусок мяса вепря", texture: "Interface\\Icons\\INV_Misc_Food_16",
  });
  fired.length = 0;
  finishPrefetch();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Лесной волк: 0/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Сундук Братства: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Кусок мяса вепря", "item", false]);

  itemMetadata.clear();
  world.creatureTemplates.clear();
  world.gameObjectTemplates.clear();
  fired.length = 0;
  worldListeners.get("QUERY_CACHE_CHANGED")?.({ kind: "cleared", id: 0 });
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]],
    "cache invalidation immediately republishes the explicit id fallback");
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Существо #123: 0/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Объект #456: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Предмет #999", "item", false]);
  assert.deepEqual(creatureQueries, [123, 123]);
  assert.deepEqual(gameObjectQueries, [[456, 0n], [456, 0n]]);
  assert.deepEqual(prefetchCalls, [[[999], []], [[999], []]], "cleared resets the prefetch gate once");

  world.creatureTemplates.set(123, { name: "Лесной волк" });
  world.gameObjectTemplates.set(456, { name: "Сундук Братства" });
  itemMetadata.set(999, {
    name: "Кусок мяса вепря", texture: "Interface\\Icons\\INV_Misc_Food_16",
  });
  fired.length = 0;
  finishPrefetch();
  assert.deepEqual(fired, [[FRAMEXML_SEAM_EVENTS.questLogUpdate]]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 1), ["Лесной волк: 0/3", "monster", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 2), ["Сундук Братства: 0/1", "object", false]);
  assert.deepEqual(call("GetQuestLogLeaderBoard", seam, 3), ["Кусок мяса вепря", "item", false]);
  seam.detach();
});
}

// ── framexml-quest-share-seam.test.mjs
{
// Plan item 1.12: sharing a quest — GetQuestLogPushable, QuestLogPushQuest and the sharer's lines for
// MSG_QUEST_PUSH_RESULT (FrameXmlQuestShare.ts), as Wow.exe 0x5df520, 0x5e4ed0 and 0x6e2e90 do.

const { FrameXmlQuestShareModel, FRAMEXML_QUEST_SHARE_BINDINGS, FRAMEXML_QUEST_PUSH_MESSAGES, QUEST_FLAG_SHARABLE } =
  await import("../dist/code/browser/framexml/FrameXmlQuestShare.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const STRINGS = {
  ERR_QUEST_PUSH_ACCEPTED_S: "%s принимает ваше задание.",
  ERR_QUEST_PUSH_DECLINED_S: "%s отказывается от вашего задания",
  ERR_QUEST_PUSH_LOG_FULL_S: "Список заданий |3-1(%s) переполнен.",
  ERR_QUEST_PUSH_NOT_IN_PARTY_S: "Вы не в группе.",
};

function fixture() {
  const state = {
    selected: 1,
    log: [101, 102],
    flags: new Map([[101, QUEST_FLAG_SHARABLE], [102, 0]]),
    player: true,
    party: 1,
    raid: 0,
    names: new Map([[5n, "Ария"]]),
  };
  const shared = [];
  const fired = [];
  const model = new FrameXmlQuestShareModel({
    questIdAt: (index) => (index === 0 ? state.log[state.selected - 1] : state.log[index - 1]),
    questFlags: (id) => state.flags.get(id),
    hasPlayer: () => state.player,
    partyMemberCount: () => state.party,
    raidMemberCount: () => state.raid,
    share: (id) => shared.push(id),
    cachedName: (guid) => state.names.get(guid),
    globalString: (name) => STRINGS[name],
  });
  model.attach({ fire(event, ...args) { fired.push([event, ...args]); return 1; } });
  const call = (name, ...args) => [...FRAMEXML_QUEST_SHARE_BINDINGS[name]({ questShare: model }, args)];
  return { state, shared, fired, model, call };
}

test("the push messages are the client's twelve, in QUEST_PARTY_MSG order", () => {
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES.length, 12);
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[0], "ERR_QUEST_PUSH_SUCCESS_S");
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[2], "ERR_QUEST_PUSH_ACCEPTED_S");
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[3], "ERR_QUEST_PUSH_DECLINED_S");
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[10], "ERR_QUEST_PUSH_NOT_IN_PARTY_S");
  assert.equal(FRAMEXML_QUEST_PUSH_MESSAGES[11], "ERR_QUEST_PUSH_DIFFERENT_SERVER_DAILY_S");
});

test("GetQuestLogPushable answers 1 for a cached sharable quest and no value otherwise", () => {
  const { state, call } = fixture();
  assert.deepEqual(call("GetQuestLogPushable"), [1], "no argument: the selected quest");
  assert.deepEqual(call("GetQuestLogPushable", 0), [1]);
  assert.deepEqual(call("GetQuestLogPushable", 1), [1]);
  assert.deepEqual(call("GetQuestLogPushable", 2), [], "flags 0: nothing, not false");
  assert.deepEqual(call("GetQuestLogPushable", 3), [], "past the log");
  assert.deepEqual(call("GetQuestLogPushable", "2"), []);
  state.selected = 2;
  assert.deepEqual(call("GetQuestLogPushable"), [], "the selection moved to the unsharable quest");
  assert.deepEqual(call("GetQuestLogPushable", 1.4), [1], "the index is rounded");
  state.flags.delete(101);
  assert.deepEqual(call("GetQuestLogPushable", 1), [], "a quest not in the cache answers nothing");
  state.flags.set(101, 0x10 | 0x2);
  assert.deepEqual(call("GetQuestLogPushable", 1), [], "only bit 0x8 makes a quest sharable");
});

test("QuestLogPushQuest shares a sharable quest only with a party or raid", () => {
  const { state, shared, call } = fixture();
  assert.deepEqual(call("QuestLogPushQuest"), []);
  assert.deepEqual(shared, [101]);
  call("QuestLogPushQuest", 2);
  assert.deepEqual(shared, [101], "unsharable: nothing sent");
  state.party = 0;
  call("QuestLogPushQuest", 1);
  assert.deepEqual(shared, [101], "alone: nothing sent");
  state.raid = 3;
  call("QuestLogPushQuest", 1);
  assert.deepEqual(shared, [101, 101], "a raid is a group too");
  state.player = false;
  call("QuestLogPushQuest", 1);
  assert.equal(shared.length, 2, "no player object: nothing");
});

test("MSG_QUEST_PUSH_RESULT prints the code's line with the cached name, markup kept", () => {
  const { state, fired, model } = fixture();
  model.result(5n, 2);
  model.result(5n, 3);
  model.result(5n, 5);
  model.result(5n, 10);
  assert.deepEqual(fired.map(([event, text]) => [event, text]), [
    ["CHAT_MSG_SYSTEM", "Ария принимает ваше задание."],
    ["CHAT_MSG_SYSTEM", "Ария отказывается от вашего задания"],
    ["CHAT_MSG_SYSTEM", "Список заданий |3-1(Ария) переполнен."],
    ["CHAT_MSG_SYSTEM", "Вы не в группе."],
  ]);
  fired.length = 0;
  model.result(6n, 2);
  assert.deepEqual(fired, [], "no cached name: no line");
  model.result(5n, 12);
  model.result(5n, 1);
  assert.deepEqual(fired, [], "an unknown code, or a string this build lacks: no line");
  state.names.set(6n, "Бран");
  model.result(6n, 3);
  assert.equal(fired.length, 1);
});

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload);
  }
}

function template(questId, flags) {
  return { questId, flags, title: `Q${questId}`, objectives: [], itemObjectives: [], creatureObjectives: [],
    rewardItems: [], rewardChoiceItems: [] };
}

function questSlot(slot) {
  return UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset + slot * 5;
}

test("the live seam reads its log, templates and group, and prints the result line", () => {
  const selfGuid = 0x10n;
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, (1 << 8) | (1 << 24)],
    [questSlot(0), 101],
    [questSlot(1), 102],
  ]);
  const events = new FakeEvents();
  const shared = [];
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, fields }]]) },
    events,
    actionButtons: [],
    casts: new Map(),
    cooldownRemaining: () => 0,
    questTemplates: new Map([[101, template(101, QUEST_FLAG_SHARABLE)], [102, template(102, 0)]]),
    group: { groupType: 0, leaderGuid: selfGuid, members: [{ guid: 5n, name: "Ария", online: true }] },
    names: new Map([[5n, "Ария"]]),
    shareQuest: (id) => shared.push(id),
    queryQuest: () => {},
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 100 });
  const api = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];

  // Line 1 is the zone header both quests sit under (FrameXmlQuestLog.ts); a header names no quest.
  assert.deepEqual(api("GetQuestLogPushable", 1), []);
  assert.deepEqual(api("GetQuestLogPushable", 2), [1]);
  assert.deepEqual(api("GetQuestLogPushable", 3), []);
  api("SelectQuestLogEntry", 2);
  assert.deepEqual(api("GetQuestLogPushable"), [1]);
  assert.ok(seam.partyMemberCount() > 0, "the fixture's group has a member");
  api("QuestLogPushQuest");
  assert.deepEqual(shared, [101]);

  fired.length = 0;
  events.emit("QUEST_PUSH_RESULT", { guid: 5n, result: 3 });
  const lines = fired.filter(([event]) => event === "CHAT_MSG_SYSTEM");
  assert.equal(lines.length, 1);
  assert.match(lines[0][1], /Ария/);
  seam.detach();
  events.emit("QUEST_PUSH_RESULT", { guid: 5n, result: 3 });
  assert.equal(fired.filter(([event]) => event === "CHAT_MSG_SYSTEM").length, 1, "detached: silent");
});

test("the canned seam's quest can be shared with its party", () => {
  const seam = new CannedWorldSeam();
  const api = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  assert.deepEqual(api("GetQuestLogPushable", 1), [1]);
  assert.deepEqual(api("GetQuestLogPushable", 9), []);
  api("QuestLogPushQuest", 1);
  assert.deepEqual(seam.sharedQuests, [9001]);
});
}

// ── framexml-quest-text.test.mjs
{
const { frameXmlQuestText } = await import("../dist/code/browser/framexml/FrameXmlQuestText.js");
const { frameXmlQuestGiverRead } = await import("../dist/code/browser/framexml/FrameXmlQuestGiverAdapter.js");

// 3.53: Wow.exe's quest text parser (QuestTextParser.cpp, 0x00579590 / 0x00578f20 / 0x00576cd0),
// which every quest window text goes through before Lua sees it.

const him = { name: "Таурон", className: "Воин", raceName: "Таурен", female: false };
const her = { ...him, name: "Лира", className: "Жрица", raceName: "Ночная эльфийка", female: true };

test("$N, $B, $C and $R read for the player, case-insensitively", () => {
  assert.equal(frameXmlQuestText("Приветствую, $N.$B$BСлышишь зов, $c?", him),
    "Приветствую, Таурон.\n\nСлышишь зов, Воин?");
  assert.equal(frameXmlQuestText("$n, $R $C", him), "Таурон, Таурен Воин");
  // `_strlwr` in the C locale lowers ASCII only: an enUS name is lowered, a ruRU one keeps its capital.
  assert.equal(frameXmlQuestText("a $c and a $r", { ...him, className: "Warrior", raceName: "Tauren" }),
    "a warrior and a tauren");
  assert.equal(frameXmlQuestText("$r", her), "Ночная эльфийка");
});

test("$G picks the reader's form; spaces trimmed, a third part only selects", () => {
  assert.equal(frameXmlQuestText("Спасибо, $gдобрый сэр:миледи;!", him), "Спасибо, добрый сэр!");
  assert.equal(frameXmlQuestText("Спасибо, $gдобрый сэр:миледи;!", her), "Спасибо, миледи!");
  assert.equal(frameXmlQuestText("$g lad : lass ;", him), "lad");
  assert.equal(frameXmlQuestText("$g lad : lass ;", her), "lass");
  assert.equal(frameXmlQuestText("ты $Gготов:готова:C; к бою", her), "ты готова к бою");
  assert.equal(frameXmlQuestText("ты $Gготов:готова:C; к бою", him), "ты готов к бою");
  assert.equal(frameXmlQuestText("$tсэр:мадам;", her), "мадам");
});

test("unknown markers and missing facts stay as written; malformed $G eats one character", () => {
  assert.equal(frameXmlQuestText("цена $x и $", him), "цена $x и $");
  assert.equal(frameXmlQuestText("$N!", { ...him, name: undefined }), "$N!");
  assert.equal(frameXmlQuestText("$5b", him), "\n", "digits after the $ are skipped");
  assert.equal(frameXmlQuestText("$Gabc", him), "bc");
  assert.equal(frameXmlQuestText("без маркеров", him), "без маркеров");
});

test("the giver's pages are parsed and the title is not", () => {
  const world = {
    questList: undefined,
    questDialog: {
      kind: "details", guid: 0x700n, informGuid: 0n, questId: 42,
      title: "Дело для $N", details: "Здравствуй, $N.$BЕсть дело.", objectives: "Принеси $gему:ей; меч.",
      autoLaunched: false, flags: 0, suggestedPlayers: 0, rewards: {
        choices: [], items: [], money: 0, requiredMoney: 0, xpDifficulty: 100,
        honor: 0, displaySpell: 0, spell: 0, titleId: 0, talents: 0, arenaPoints: 0,
      },
    },
  };
  const context = { rewardMetadata: { item: () => undefined }, formatText: (text) => frameXmlQuestText(text, her) };
  const read = (name) => frameXmlQuestGiverRead(name, [], world, context);
  assert.deepEqual(read("GetQuestText"), ["Здравствуй, Лира.\nЕсть дело."]);
  assert.deepEqual(read("GetObjectiveText"), ["Принеси ей меч."]);
  assert.deepEqual(read("GetTitleText"), ["Дело для $N"], "Wow.exe keeps the title as sent");
  world.questDialog = { ...world.questDialog, kind: "reward", text: "Молодец, $c!", choices: [], items: [] };
  assert.deepEqual(read("GetRewardText"), ["Молодец, Жрица!"]);
  world.questDialog = undefined;
  world.questList = { guid: 0x700n, greeting: "Привет, $N.", emoteDelay: 0, emote: 0, quests: [] };
  assert.deepEqual(read("GetGreetingText"), ["Привет, Лира."]);
});
}
