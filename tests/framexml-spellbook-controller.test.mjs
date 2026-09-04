import assert from "node:assert/strict";
import test from "node:test";

const controller = await import("../dist/code/browser/framexml/FrameXmlSpellBookController.js");

function owner() {
  return {
    open: false,
    shows: 0,
    hides: 0,
    isOpen() { return this.open; },
    show() { this.open = true; this.shows++; },
    hide() { this.open = false; this.hides++; },
  };
}

test("stock SpellBook controller is one owner for toggle, Escape close and teardown", () => {
  const first = owner();
  const releaseFirst = controller.publishFrameXmlSpellBook(first);
  assert.equal(controller.frameXmlSpellBookOpen(), false);
  assert.equal(controller.toggleFrameXmlSpellBook(), true);
  assert.equal(first.open, true);
  assert.equal(controller.frameXmlSpellBookOpen(), true);
  assert.equal(controller.closeFrameXmlSpellBook(), true);
  assert.equal(first.open, false);
  assert.equal(first.hides, 1);

  // A stale cleanup from an earlier mount cannot clear the current owner.
  const second = owner();
  const releaseSecond = controller.publishFrameXmlSpellBook(second);
  releaseFirst();
  assert.equal(controller.toggleFrameXmlSpellBook(), true);
  assert.equal(second.open, true);
  releaseSecond();
  releaseSecond();
  assert.equal(second.open, false);
  assert.equal(controller.frameXmlSpellBookOpen(), false);
});

test("without a published stock owner the caller can use the native fallback", () => {
  assert.equal(controller.toggleFrameXmlSpellBook(), false);
  assert.equal(controller.closeFrameXmlSpellBook(), false);
});
