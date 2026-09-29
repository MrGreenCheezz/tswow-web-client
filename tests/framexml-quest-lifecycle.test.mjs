import assert from "node:assert/strict";
import test from "node:test";

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
