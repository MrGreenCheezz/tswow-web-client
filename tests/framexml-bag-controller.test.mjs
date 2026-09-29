import assert from "node:assert/strict";
import test from "node:test";

const controller = await import("../dist/code/browser/framexml/FrameXmlBagController.js");

function owner() {
  return {
    open: false,
    backpackToggles: 0,
    bagToggles: [],
    keyringToggles: 0,
    closes: 0,
    disposals: 0,
    isOpen() { return this.open; },
    toggleBackpack() { this.open = !this.open; this.backpackToggles++; },
    toggleBag(index) { this.bagToggles.push(index); this.open = true; },
    toggleKeyring() { this.keyringToggles++; this.open = !this.open; },
    toggleAllBags() { this.open = !this.open; },
    close() { this.open = false; this.closes++; },
    dispose() { this.disposals++; },
  };
}

test("stock bags controller routes all bag verbs through one owner", () => {
  const first = owner();
  const releaseFirst = controller.publishFrameXmlBags(first);

  assert.equal(controller.frameXmlBagsOpen(), false);
  assert.equal(controller.toggleFrameXmlBags(), true);
  assert.equal(first.open, true);
  assert.equal(controller.toggleFrameXmlBackpack(), true);
  assert.equal(first.backpackToggles, 1);
  assert.equal(controller.toggleFrameXmlBag(2), true);
  assert.deepEqual(first.bagToggles, [2]);
  assert.equal(controller.toggleFrameXmlKeyring(), true);
  assert.equal(first.keyringToggles, 1);
  assert.equal(controller.closeFrameXmlBags(), true);
  assert.equal(first.closes, 1);
  assert.equal(controller.frameXmlBagsOpen(), false);
  releaseFirst();
  assert.equal(first.disposals, 1, "owner disposal releases lifetime compatibility state");
  assert.equal(controller.toggleFrameXmlBags(), false);
});

test("a stale bag cleanup cannot clear the current owner", () => {
  const first = owner();
  const releaseFirst = controller.publishFrameXmlBags(first);
  const second = owner();
  const releaseSecond = controller.publishFrameXmlBags(second);

  assert.equal(first.closes, 1, "publishing a replacement closes the old owner");
  assert.equal(first.disposals, 1, "publishing a replacement disposes the old owner");
  releaseFirst();
  assert.equal(controller.toggleFrameXmlBackpack(), true);
  assert.equal(second.backpackToggles, 1);
  releaseSecond();
  releaseSecond();
  assert.equal(controller.frameXmlBagsOpen(), false);
});

test("without a gated owner the caller keeps the native fallback", () => {
  assert.equal(controller.toggleFrameXmlBags(), false);
  assert.equal(controller.toggleFrameXmlBackpack(), false);
  assert.equal(controller.toggleFrameXmlBag(1), false);
  assert.equal(controller.toggleFrameXmlKeyring(), false);
  assert.equal(controller.closeFrameXmlBags(), false);
});
