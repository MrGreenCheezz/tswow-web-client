import assert from "node:assert/strict";
import test from "node:test";

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
