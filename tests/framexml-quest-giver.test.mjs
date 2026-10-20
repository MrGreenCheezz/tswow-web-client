import assert from "node:assert/strict";
import test from "node:test";
import { closeFrameXmlQuestGiver, frameXmlQuestGiverOpen, frameXmlQuestGiverPageSupported, notifyFrameXmlQuestGiver, notifyFrameXmlQuestGiverItemUpdate, publishFrameXmlQuestGiver } from "../dist/code/browser/framexml/FrameXmlQuestGiverController.js";

// Merged 2026-10-20 from 4 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── framexml-quest-giver-adapter.test.mjs
{
const {
  frameXmlQuestGiverRead,
  resolveFrameXmlQuestGiverCommand,
  performFrameXmlQuestGiverCommand,
} = await import("../dist/code/browser/framexml/FrameXmlQuestGiverAdapter.js");

function worldFixture() {
  const calls = [];
  const world = {
    questList: undefined,
    questDialog: undefined,
    openQuest: (...args) => calls.push(["openQuest", ...args]),
    acceptQuest: () => calls.push(["acceptQuest"]),
    requestQuestReward: () => calls.push(["requestQuestReward"]),
    chooseQuestReward: (choice) => calls.push(["chooseQuestReward", choice]),
    closeQuest: () => calls.push(["closeQuest"]),
  };
  return { world, calls };
}

const metadata = {
  item: (itemId) => itemId === 500 ? {
    name: "Награда", texture: "Interface\\Icons\\INV_Misc_QuestionMark", quality: 2,
  } : undefined,
};

test("quest giver adapter composes packet-backed page getters without publishing stock UI", () => {
  const { world } = worldFixture();
  const read = (name, ...args) => frameXmlQuestGiverRead(name, args, world,
    { rewardMetadata: metadata, menuFacts: { activeCompleteByQuestId: new Map([[41, true]]) } });
  assert.equal(read("NoSuchQuestApi"), undefined);
  assert.deepEqual(read("GetTitleText"), []);

  world.questList = {
    guid: 0x700n, greeting: "Привет", emoteDelay: 0, emote: 0,
    quests: [
      { id: 41, icon: 4, level: 20, flags: 0, repeatable: false, title: "Сдать" },
      { id: 42, icon: 2, level: 20, flags: 0, repeatable: false, title: "Взять" },
    ],
  };
  assert.deepEqual(read("GetGreetingText"), ["Привет"]);
  assert.deepEqual(read("GetActiveTitle", 1), ["Сдать", true]);
  assert.deepEqual(read("GetNumAvailableQuests"), [1]);
  assert.deepEqual(read("GetQuestText"), []);

  world.questList = undefined;
  world.questDialog = {
    kind: "details", guid: 0x700n, informGuid: 0n, questId: 42,
    title: "Взять", details: "История", objectives: "Сделать дело", autoLaunched: false,
    flags: 0x80000, suggestedPlayers: 1, rewards: {
      choices: [], items: [], money: 0, requiredMoney: 0, xpDifficulty: 100,
      honor: 0, displaySpell: 0, spell: 0, titleId: 0, talents: 0, arenaPoints: 0,
    },
  };
  assert.deepEqual(read("GetQuestText"), ["История"]);
  assert.deepEqual(read("QuestGetAutoAccept"), [true]);
  assert.deepEqual(read("GetNumQuestRewards"), [0]);

  world.questDialog = {
    kind: "request-items", guid: 0x700n, questId: 42, title: "Взять", text: "Готово?",
    flags: 0, suggestedPlayers: 1, requiredMoney: 125,
    items: [{ id: 500, displayId: 25, count: 2 }], canComplete: true,
  };
  assert.deepEqual(read("GetProgressText"), ["Готово?"]);
  assert.deepEqual(read("GetQuestMoneyToGet"), [125]);
  assert.deepEqual(read("GetQuestItemInfo", "required", 1).slice(0, 3),
    ["Награда", "Interface\\Icons\\INV_Misc_QuestionMark", 2]);

  world.questDialog = {
    kind: "reward", guid: 0x700n, questId: 42, title: "Взять", text: "Забирай",
    autoLaunched: false, flags: 0, suggestedPlayers: 1, rewards: {
      choices: [{ id: 500, displayId: 25, count: 1 }], items: [], money: 0,
      requiredMoney: 125, xpDifficulty: 100, honor: 0, displaySpell: 0,
      spell: 0, titleId: 0, talents: 0, arenaPoints: 0,
    },
  };
  assert.deepEqual(read("GetRewardText"), ["Забирай"]);
  assert.deepEqual(read("GetNumQuestChoices"), [1]);
  assert.deepEqual(read("GetQuestMoneyToGet"), [125]);
  world.questList = { guid: 0x700n, greeting: "Конфликт", emoteDelay: 0, emote: 0, quests: [] };
  assert.deepEqual(read("GetRewardText"), [], "contradictory page state fails closed");
});

test("quest giver adapter preserves one-based selections and rejects stale actions", () => {
  const { world, calls } = worldFixture();
  const list = { guid: 0x700n, greeting: "Привет", emoteDelay: 0, emote: 0,
    quests: [{ id: 42, icon: 2, level: 20, flags: 0, repeatable: false, title: "Взять" }] };
  world.questList = list;
  assert.equal(resolveFrameXmlQuestGiverCommand("SelectAvailableQuest", [0], world), undefined);
  const selection = resolveFrameXmlQuestGiverCommand("SelectAvailableQuest", [1], world);
  assert.ok(selection);
  world.questList = { ...list };
  assert.equal(performFrameXmlQuestGiverCommand(world, selection), false);
  world.questList = list;
  assert.equal(performFrameXmlQuestGiverCommand(world, selection), true);
  assert.deepEqual(calls, [["openQuest", 0x700n, 42, false]]);

  world.questList = undefined;
  world.questDialog = { kind: "details", guid: 0x700n, questId: 42 };
  const accept = resolveFrameXmlQuestGiverCommand("AcceptQuest", [], world);
  assert.ok(accept);
  world.questDialog = { kind: "details", guid: 0x700n, questId: 42 };
  assert.equal(performFrameXmlQuestGiverCommand(world, accept), false);
  world.questDialog = accept.expectedDialog;
  assert.equal(performFrameXmlQuestGiverCommand(world, accept), true);

  world.questDialog = { kind: "request-items", guid: 0x700n, questId: 42, canComplete: true };
  const complete = resolveFrameXmlQuestGiverCommand("CompleteQuest", [], world);
  assert.ok(complete);
  assert.equal(performFrameXmlQuestGiverCommand(world, complete), true);

  world.questDialog = { kind: "reward", guid: 0x700n, questId: 42,
    rewards: { choices: [{ id: 500, count: 1, displayId: 25 }], requiredMoney: 125 } };
  const reward = resolveFrameXmlQuestGiverCommand("GetQuestReward", [1], world);
  assert.ok(reward, "stock popup OnAccept calls the ordinary C API for a paid quest");
  assert.equal(performFrameXmlQuestGiverCommand(world, reward), true);
  assert.deepEqual(calls.slice(1), [["acceptQuest"], ["requestQuestReward"], ["chooseQuestReward", 0]]);
  assert.equal(resolveFrameXmlQuestGiverCommand("GetQuestReward", [2], world), undefined);
});
}

// ── framexml-quest-giver-controller.test.mjs
{
function fixture() {
  const world = { questList: undefined, questDialog: undefined, questMessage: undefined };
  const events = [];
  let open = false;
  let nativeHides = 0;
  let failures = 0;
  let prefetched = 0;
  const owner = {
    world,
    currentWorld: () => world,
    isOpen: () => open,
    render(event) {
      events.push(event);
      open = event !== "QUEST_FINISHED";
      return true;
    },
    hideNative() { nativeHides++; },
    prefetch() { prefetched++; },
    message(text, error) { events.push(`${error ? "error" : "info"}:${text}`); },
    close() { open = false; world.questList = undefined; world.questDialog = undefined;
      notifyFrameXmlQuestGiver(world); },
    dispose() { open = false; },
    onFailure() { failures++; },
  };
  return { world, owner, events, get nativeHides() { return nativeHides; },
    get prefetched() { return prefetched; }, get failures() { return failures; } };
}

test("stock quest owner replays async page, advances through packets, then closes once", () => {
  const f = fixture();
  f.world.questList = { quests: [] };
  const release = publishFrameXmlQuestGiver(f.owner);
  try {
    assert.deepEqual(f.events, ["QUEST_GREETING"]);
    assert.equal(f.nativeHides, 1);
    assert.equal(f.prefetched, 1);
    assert.equal(notifyFrameXmlQuestGiver(f.world), true);
    assert.deepEqual(f.events, ["QUEST_GREETING"], "repaint is not a fresh quest packet");
    for (const [kind, event] of [
      ["details", "QUEST_DETAIL"], ["request-items", "QUEST_PROGRESS"],
      ["reward", "QUEST_COMPLETE"],
    ]) {
      f.world.questList = undefined;
      f.world.questDialog = kind === "request-items" ? { kind, items: [] }
        : { kind, rewards: { items: [], choices: [], displaySpell: 0 } };
      assert.equal(notifyFrameXmlQuestGiver(f.world), true);
      assert.equal(f.events.at(-1), event);
    }
    assert.equal(closeFrameXmlQuestGiver(), true);
    assert.equal(frameXmlQuestGiverOpen(), false);
    assert.equal(f.events.at(-1), "QUEST_FINISHED");
    assert.equal(f.events.filter((event) => event === "QUEST_FINISHED").length, 1);
    assert.equal(closeFrameXmlQuestGiver(), false);
  } finally { release(); }
});

test("item cache edges repaint an open page once per revision without opening a closed page", () => {
  const f = fixture();
  f.world.questDialog = { kind: "request-items", items: [] };
  const release = publishFrameXmlQuestGiver(f.owner);
  try {
    assert.equal(notifyFrameXmlQuestGiverItemUpdate(f.world, 10), true);
    assert.equal(notifyFrameXmlQuestGiverItemUpdate(f.world, 10), true);
    assert.deepEqual(f.events, ["QUEST_PROGRESS", "QUEST_ITEM_UPDATE"]);
    f.world.questMessage = { error: true, text: "Сервер отказал" };
    notifyFrameXmlQuestGiver(f.world);
    notifyFrameXmlQuestGiver(f.world);
    assert.equal(f.events.filter((value) => value === "error:Сервер отказал").length, 1);
    f.world.questDialog = undefined;
    notifyFrameXmlQuestGiver(f.world);
    assert.equal(notifyFrameXmlQuestGiverItemUpdate(f.world, 11), false);
    assert.equal(f.events.filter((value) => value === "QUEST_ITEM_UPDATE").length, 1);
  } finally { release(); }
});

test("unsupported stock row counts demote to native and stale world cannot take the route", () => {
  const f = fixture();
  const release = publishFrameXmlQuestGiver(f.owner);
  try {
    assert.equal(notifyFrameXmlQuestGiver({ questList: undefined, questDialog: undefined }), false);
    f.world.questList = { quests: Array.from({ length: 33 }, () => ({})) };
    assert.equal(frameXmlQuestGiverPageSupported(f.world), false);
    assert.equal(notifyFrameXmlQuestGiver(f.world), false);
    assert.equal(f.failures, 1);
    assert.equal(notifyFrameXmlQuestGiver(f.world), false);
  } finally { release(); }
});
}

// ── framexml-quest-giver-data.test.mjs
{
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
}

// ── framexml-quest-giver-world-seam.test.mjs
{
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_QUEST_MENU_DATA_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlQuestMenuData.js");
const { FRAMEXML_QUEST_GIVER_DATA_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlQuestGiverData.js");
const { FRAMEXML_QUEST_REWARD_DATA_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlQuestRewardData.js");
const { FRAMEXML_QUEST_FLAGS_DATA_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlQuestFlagsData.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { QUEST_STATE_COMPLETE } = await import("../dist/code/world/QuestProtocol.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} binding exists`);
  return [...binding(seam, args)];
}

test("quest giver C API names are registered while Canned answers no invented page", () => {
  const names = new Set([
    ...Object.keys(FRAMEXML_QUEST_MENU_DATA_BINDINGS),
    ...Object.keys(FRAMEXML_QUEST_GIVER_DATA_BINDINGS),
    ...Object.keys(FRAMEXML_QUEST_REWARD_DATA_BINDINGS),
    ...Object.keys(FRAMEXML_QUEST_FLAGS_DATA_BINDINGS),
    "SelectActiveQuest", "SelectAvailableQuest", "AcceptQuest", "CompleteQuest",
    "GetQuestReward", "DeclineQuest", "CloseQuest",
  ]);
  const seam = new CannedWorldSeam();
  for (const name of names) {
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), `${name} listed for VM registration`);
    assert.deepEqual(api(seam, name), [], `${name} has no canned giver page`);
  }
});

test("live quest giver C API reads current packet page and routes valid commands", () => {
  const calls = [];
  const player = { guid: 1n, typeId: 4, fields: new Map() };
  const world = {
    state: { selfGuid: 1n, objects: { get: (guid) => guid === 1n ? player : undefined } },
    questList: {
      guid: 0x700n, greeting: "Здравствуй", emoteDelay: 0, emote: 0,
      quests: [
        { id: 41, icon: 4, level: 20, flags: 0, repeatable: false, title: "Сдать" },
        { id: 42, icon: 2, level: 20, flags: 0x1000, repeatable: false, title: "Взять" },
      ],
    },
    questDialog: undefined,
    openQuest: (...args) => calls.push(["openQuest", ...args]),
    acceptQuest: () => calls.push(["acceptQuest"]),
    requestQuestReward: () => calls.push(["requestQuestReward"]),
    chooseQuestReward: (choice) => calls.push(["chooseQuestReward", choice]),
    closeQuest: () => calls.push(["closeQuest"]),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 1, globalCooldownUntil: () => 0, castSpell: () => {},
  });

  assert.deepEqual(api(seam, "GetGreetingText"), ["Здравствуй"]);
  assert.deepEqual(api(seam, "GetNumActiveQuests"), [1]);
  assert.deepEqual(api(seam, "GetNumAvailableQuests"), [1]);
  assert.deepEqual(api(seam, "GetActiveTitle", 1), ["Сдать", undefined],
    "a list icon alone cannot prove completion");
  const questSlot = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  player.fields.set(questSlot, 41);
  player.fields.set(questSlot + 1, QUEST_STATE_COMPLETE);
  assert.deepEqual(api(seam, "GetActiveTitle", 1), ["Сдать", true],
    "the complete bit in the player's quest log establishes completion");
  player.fields.set(questSlot + 1, 0);
  assert.deepEqual(api(seam, "GetActiveTitle", 1), ["Сдать", false]);
  assert.deepEqual(api(seam, "GetAvailableQuestInfo", 1), [undefined, true, false]);
  assert.deepEqual(api(seam, "GetAvailableTitle", 2), []);
  api(seam, "SelectAvailableQuest", 0);
  api(seam, "SelectAvailableQuest", 1);
  api(seam, "SelectActiveQuest", 1);
  assert.deepEqual(calls, [
    ["openQuest", 0x700n, 42, false], ["openQuest", 0x700n, 41, true],
  ]);

  world.questList = undefined;
  world.questDialog = {
    kind: "details", guid: 0x700n, informGuid: 0n, questId: 42,
    title: "Взять", details: "История", objectives: "Сделать дело", autoLaunched: false,
    flags: 0x80000, suggestedPlayers: 1, rewards: {
      choices: [], items: [], money: 0, requiredMoney: 0, xpDifficulty: 100,
      honor: 0, displaySpell: 0, spell: 0, titleId: 0, talents: 0, arenaPoints: 0,
    },
  };
  assert.deepEqual(api(seam, "GetQuestText"), ["История"]);
  assert.deepEqual(api(seam, "QuestGetAutoAccept"), [true]);
  api(seam, "CompleteQuest");
  api(seam, "AcceptQuest");
  assert.deepEqual(calls.slice(2), [["acceptQuest"]]);

  world.questDialog = {
    kind: "request-items", guid: 0x700n, questId: 42, title: "Взять", text: "Готово?",
    flags: 0, suggestedPlayers: 1, requiredMoney: 125, items: [], canComplete: true,
  };
  assert.deepEqual(api(seam, "GetProgressText"), ["Готово?"]);
  api(seam, "CompleteQuest");
  world.questDialog = {
    kind: "reward", guid: 0x700n, questId: 42, title: "Взять", text: "Забирай",
    autoLaunched: false, flags: 0, suggestedPlayers: 1, rewards: {
      choices: [{ id: 500, displayId: 25, count: 1 }], items: [], money: 50,
      requiredMoney: 125, xpDifficulty: 100, honor: 0, displaySpell: 0,
      spell: 0, titleId: 0, talents: 0, arenaPoints: 0,
    },
  };
  assert.deepEqual(api(seam, "GetRewardMoney"), [50]);
  api(seam, "GetQuestReward", 2);
  api(seam, "GetQuestReward", 1);
  assert.deepEqual(calls.slice(3), [["requestQuestReward"], ["chooseQuestReward", 0]]);

  world.questList = { guid: 0x700n, greeting: "conflict", emoteDelay: 0, emote: 0, quests: [] };
  assert.deepEqual(api(seam, "GetRewardText"), [], "conflicting pages fail closed");
  api(seam, "GetQuestReward", 1);
  assert.equal(calls.length, 5, "conflicting pages send no command");
});
}
