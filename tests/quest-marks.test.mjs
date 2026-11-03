// 03.11 (6.37): the mark over a quest giver's head is a model, chosen as Wow.exe chooses it (0x00a34f5c, 0x00adac98).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  QUEST_MARK_ATTACHMENT, QUEST_MARK_SEQUENCE, questMarkModel, questMarksByUnit, sameQuestMarks,
} from "../dist/code/browser/ui/QuestMarks.js";

const model = (name) => `Interface\\Buttons\\${name}.m2`;

test("each status has the model the client's two tables give it", () => {
  const expected = [
    [0, undefined],
    [1, "TalkToMeGrey"], // unavailable
    [2, "TalkToMe"], // low level available
    [3, "TalkToMeQuestion_LTBlue"], // low level reward (repeatable)
    [4, "TalkToMeBlue"], // low level available (repeatable)
    [5, "TalkToMeQuestion_Grey"], // incomplete
    [6, "TalkToMeQuestion_LTBlue"], // reward (repeatable)
    [7, "TalkToMeBlue"], // available (repeatable)
    [8, "TalkToMe"], // available
    [9, "TalkToMeQuestionMark"], // reward, no dot on the minimap
    [10, "TalkToMeQuestionMark"], // reward
  ];
  for (const [status, name] of expected) {
    assert.equal(questMarkModel(status, true), name && model(name), `status ${status}`);
  }
  assert.equal(questMarkModel(11, true), undefined, "past the table");
});

test("the three low level statuses wait for low level quests to be tracked, and nothing else does", () => {
  for (const status of [2, 3, 4]) assert.equal(questMarkModel(status, false), undefined, `status ${status}`);
  for (const status of [1, 5, 6, 7, 8, 9, 10]) assert.ok(questMarkModel(status, false), `status ${status}`);
});

test("marks are by unit, and what is not a unit here has none", () => {
  const statuses = new Map([[1n, 8], [2n, 10], [3n, 0], [4n, 8], [5n, 2]]);
  const marks = questMarksByUnit(statuses, (guid) => guid !== 4n, false);
  assert.deepEqual([...marks], [[1n, model("TalkToMe")], [2n, model("TalkToMeQuestionMark")]]);
});

test("the marks are compared, so an unchanged frame hands nothing over", () => {
  const one = new Map([[1n, "a"]]);
  assert.equal(sameQuestMarks(one, new Map([[1n, "a"]])), true);
  assert.equal(sameQuestMarks(one, new Map([[1n, "b"]])), false);
  assert.equal(sameQuestMarks(one, new Map([[2n, "a"]])), false);
  assert.equal(sameQuestMarks(one, new Map()), false);
});

test("the mark hangs on PlayerName and plays its own sequence: 0 would leave it half a yard low", () => {
  assert.equal(QUEST_MARK_ATTACHMENT, 18);
  assert.equal(QUEST_MARK_SEQUENCE, 190);
  const coordinator = readFileSync(new URL("../src/browser/SpellVisualLifecycle.ts", import.meta.url), "utf8");
  assert.match(coordinator, /attachment: QUEST_MARK_ATTACHMENT, scale: 1, occurrence: "questmark", modelSequence: QUEST_MARK_SEQUENCE/);
  const renderer = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /this\.#holdModelSequence\(visual, client\);[\s\S]{0,200}?this\.#sequenceSpellModel\(visual, now, client\)/);
  assert.match(renderer, /modelSequence: effect\.modelSequence/);
  const loop = readFileSync(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.match(loop, /syncQuestMarks\(\);/);
});
