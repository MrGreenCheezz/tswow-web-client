import assert from "node:assert/strict";
import test from "node:test";

import {
  closeFrameXmlQuestGiver, frameXmlQuestGiverOpen, frameXmlQuestGiverPageSupported,
  notifyFrameXmlQuestGiver, notifyFrameXmlQuestGiverItemUpdate,
  publishFrameXmlQuestGiver,
} from "../dist/code/browser/framexml/FrameXmlQuestGiverController.js";

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
