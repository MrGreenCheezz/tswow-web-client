import assert from "node:assert/strict";
import test from "node:test";

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
