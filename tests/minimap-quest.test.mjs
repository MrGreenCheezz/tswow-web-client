import assert from "node:assert/strict";
import test from "node:test";
import {
  QUEST_STATUS_AVAILABLE, QUEST_STATUS_AVAILABLE_REP, QUEST_STATUS_INCOMPLETE, QUEST_STATUS_LOW_LEVEL_AVAILABLE,
  QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP, QUEST_STATUS_LOW_LEVEL_REWARD_REP, QUEST_STATUS_REWARD, QUEST_STATUS_REWARD2,
  QUEST_STATUS_REWARD_REP, QUEST_STATUS_UNAVAILABLE,
} from "../dist/code/world/QuestProtocol.js";
import { minimapQuestCell } from "../dist/code/browser/ui/MinimapArt.js";

// 03.11: read off Wow.exe's frames, a ring of NPCs round the character with one status each.
const YELLOW_MARK = { column: 1, row: 1 };
const YELLOW_QUESTION = { column: 2, row: 1 };
const BLUE_MARK = { column: 3, row: 1 };

test("three statuses mark the map", () => {
  assert.deepEqual(minimapQuestCell(QUEST_STATUS_AVAILABLE, false), YELLOW_MARK);
  assert.deepEqual(minimapQuestCell(QUEST_STATUS_REWARD, false), YELLOW_QUESTION);
  assert.deepEqual(minimapQuestCell(QUEST_STATUS_AVAILABLE_REP, false), BLUE_MARK);
});

test("the low-level ones wait for their tracker", () => {
  assert.equal(minimapQuestCell(QUEST_STATUS_LOW_LEVEL_AVAILABLE, false), undefined);
  assert.equal(minimapQuestCell(QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP, false), undefined);
  assert.deepEqual(minimapQuestCell(QUEST_STATUS_LOW_LEVEL_AVAILABLE, true), YELLOW_MARK);
  assert.deepEqual(minimapQuestCell(QUEST_STATUS_LOW_LEVEL_AVAILABLE_REP, true), BLUE_MARK);
});

test("the rest draw nothing, tracker or not", () => {
  for (const status of [0, QUEST_STATUS_UNAVAILABLE, QUEST_STATUS_INCOMPLETE, QUEST_STATUS_REWARD_REP, QUEST_STATUS_REWARD2, QUEST_STATUS_LOW_LEVEL_REWARD_REP]) {
    assert.equal(minimapQuestCell(status, false), undefined, `status ${status}`);
    assert.equal(minimapQuestCell(status, true), undefined, `status ${status} with the tracker`);
  }
});
