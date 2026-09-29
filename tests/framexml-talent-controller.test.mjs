import assert from "node:assert/strict";
import test from "node:test";

const {
  closeFrameXmlTalent,
  frameXmlTalentOpen,
  publishFrameXmlTalent,
  toggleFrameXmlTalent,
} = await import("../dist/code/browser/framexml/FrameXmlTalentController.js");

function owner() {
  let open = false;
  const calls = [];
  return {
    calls,
    isOpen: () => open,
    show: () => { open = true; calls.push("show"); },
    hide: () => { open = false; calls.push("hide"); },
    dispose: () => { calls.push("dispose"); },
  };
}

test("talent owner routes toggle and Escape, then cleans up idempotently", () => {
  const first = owner();
  const cleanup = publishFrameXmlTalent(first);
  assert.equal(frameXmlTalentOpen(), false);
  assert.equal(toggleFrameXmlTalent(), true);
  assert.deepEqual(first.calls, ["show"]);
  assert.equal(frameXmlTalentOpen(), true);
  assert.equal(closeFrameXmlTalent(), true);
  assert.deepEqual(first.calls, ["show", "hide"]);
  cleanup();
  cleanup();
  assert.deepEqual(first.calls, ["show", "hide", "hide", "dispose"]);
  assert.equal(frameXmlTalentOpen(), false);
});

test("stale talent cleanup cannot hide or clear a newer owner", () => {
  const first = owner();
  const cleanupFirst = publishFrameXmlTalent(first);
  const second = owner();
  const cleanupSecond = publishFrameXmlTalent(second);
  assert.deepEqual(first.calls, ["hide", "dispose"]);
  cleanupFirst();
  assert.deepEqual(second.calls, []);
  assert.equal(toggleFrameXmlTalent(), true);
  assert.deepEqual(second.calls, ["show"]);
  cleanupSecond();
  assert.deepEqual(second.calls, ["show", "hide", "dispose"]);
  assert.equal(frameXmlTalentOpen(), false);
});
