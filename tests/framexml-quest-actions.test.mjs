import assert from "node:assert/strict";
import test from "node:test";

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
