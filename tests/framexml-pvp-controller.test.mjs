import assert from "node:assert/strict";
import test from "node:test";

const controller = await import("../dist/code/browser/framexml/FrameXmlPvpController.js");
const bindings = await import("../dist/code/browser/input/Bindings.js");

function owner() {
  return {
    open: false,
    shows: 0,
    hides: 0,
    isOpen() { return this.open; },
    show() { this.open = true; this.shows += 1; },
    hide() { this.open = false; this.hides += 1; },
  };
}

test("PvP controller owns the stock summary, Escape closes it, and stale cleanup is harmless", () => {
  const first = owner();
  const releaseFirst = controller.publishFrameXmlPvp(first);
  assert.equal(controller.frameXmlPvpOpen(), false);
  assert.equal(controller.toggleFrameXmlPvp(), true);
  assert.equal(first.open, true);
  assert.equal(controller.frameXmlPvpOpen(), true);
  assert.equal(controller.closeFrameXmlPvp(), true);
  assert.equal(first.open, false);

  const second = owner();
  const releaseSecond = controller.publishFrameXmlPvp(second);
  releaseFirst();
  assert.equal(controller.toggleFrameXmlPvp(), true);
  assert.equal(second.open, true);
  releaseSecond();
  releaseSecond();
  assert.equal(second.open, false);
  assert.equal(controller.frameXmlPvpOpen(), false);
});

test("without a stock gate the caller can retain its native fallback", () => {
  assert.equal(controller.toggleFrameXmlPvp(), false);
  assert.equal(controller.closeFrameXmlPvp(), false);
});

test("stock PvP keeps the H route and closes through its owner", () => {
  assert.deepEqual(bindings.DEFAULT_BINDINGS.togglePvp, ["KeyH", ""]);
  assert.equal(bindings.actionFor("KeyH"), "togglePvp");
  const current = owner();
  const release = controller.publishFrameXmlPvp(current);
  try {
    assert.equal(controller.toggleFrameXmlPvp(), true, "H's action reaches the stock owner");
    assert.equal(current.open, true);
    assert.equal(controller.closeFrameXmlPvp(), true, "Escape reaches the same owner");
    assert.equal(current.open, false);
  } finally {
    release();
  }
});
