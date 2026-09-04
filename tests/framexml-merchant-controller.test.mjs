import assert from "node:assert/strict";
import test from "node:test";

const {
  closeFrameXmlMerchant,
  frameXmlMerchantOpen,
  notifyFrameXmlMerchant,
  publishFrameXmlMerchant,
} = await import("../dist/code/browser/framexml/FrameXmlMerchantController.js");

test("Merchant owner is identity-safe and forwards forced metadata refreshes", () => {
  const calls = [];
  let open = false;
  const owner = {
    isOpen: () => open,
    show: () => { open = true; calls.push("show"); },
    hide: () => { open = false; calls.push("hide"); },
    refresh: (event, force) => calls.push([event, force === true]),
  };
  const cleanup = publishFrameXmlMerchant(owner);
  assert.equal(frameXmlMerchantOpen(), false);
  owner.show();
  assert.equal(frameXmlMerchantOpen(), true);
  assert.equal(notifyFrameXmlMerchant("update"), true);
  assert.equal(notifyFrameXmlMerchant("update", true), true);
  assert.deepEqual(calls, ["show", ["update", false], ["update", true]]);
  assert.equal(closeFrameXmlMerchant(), true);
  assert.equal(frameXmlMerchantOpen(), false);
  cleanup();
  assert.equal(notifyFrameXmlMerchant("closed"), false);
});
