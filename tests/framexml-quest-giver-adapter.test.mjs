import assert from "node:assert/strict";
import test from "node:test";

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
