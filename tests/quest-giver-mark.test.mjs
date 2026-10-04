// Plan item 5.28 (04.10, L6): the mark over an NPC with a flight master's discovery folded in, as Wow.exe
// 3.3.5a 12340 picks it (SMSG_TAXINODE_STATUS 0x6d5fc0 → unit mark 7/0; 0x745dcd; table 0xa34f5c; models
// 0xadac98; read 2026-10-04).
import assert from "node:assert/strict";
import test from "node:test";

const { questGiverMark, QUEST_GIVER_MARK_MODELS, TAXI_UNKNOWN_MARK } = await import("../dist/code/world/QuestGiverMarker.js");

test("an undiscovered flight master shows the green mark when no quest mark is up", () => {
  assert.equal(TAXI_UNKNOWN_MARK, 7);
  assert.equal(QUEST_GIVER_MARK_MODELS[7], "Interface\\Buttons\\TalkToMeGreen.mdx");
  assert.equal(questGiverMark(undefined, false, false), 7);
  assert.equal(questGiverMark(0, false, false), 7);
  assert.equal(questGiverMark(0, true, false), 0, "discovered: nothing");
  assert.equal(questGiverMark(undefined, undefined, false), 0, "no answer yet: nothing");
});

test("a quest mark wins, through the client's table; low-level ones only while tracked", () => {
  // DIALOG_STATUS_AVAILABLE (8) → the yellow «!», REWARD (10) → «?», INCOMPLETE (5) → the grey «?».
  assert.equal(QUEST_GIVER_MARK_MODELS[questGiverMark(8, false, false)], "Interface\\Buttons\\TalkToMe.mdx");
  assert.equal(QUEST_GIVER_MARK_MODELS[questGiverMark(10, false, false)], "Interface\\Buttons\\TalkToMeQuestionMark.mdx");
  assert.equal(QUEST_GIVER_MARK_MODELS[questGiverMark(5, true, false)], "Interface\\Buttons\\TalkToMeQuestion_Grey.mdx");
  assert.equal(questGiverMark(1, false, false), 6, "UNAVAILABLE: the grey «!»");
  assert.equal(questGiverMark(2, false, false), 7, "a low-level quest untracked falls to the taxi mark");
  assert.equal(questGiverMark(2, false, true), 1, "tracked: its own mark");
  assert.equal(questGiverMark(4, true, false), 0);
});
