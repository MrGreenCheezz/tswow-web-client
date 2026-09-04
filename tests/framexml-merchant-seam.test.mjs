import assert from "node:assert/strict";
import test from "node:test";

const { CannedWorldSeam, CANNED_MERCHANT } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} binding exists`);
  return [...binding(seam, args)];
}

function pump() {
  const events = [];
  return {
    events,
    now: () => 100,
    fire(event, ...args) { events.push([event, ...args]); return 1; },
  };
}

test("Canned Merchant answers truthful rows, repair-neutral APIs, and NPC context", () => {
  const seam = new CannedWorldSeam();
  const worldPump = pump();
  seam.attach(worldPump);
  worldPump.events.length = 0;
  assert.deepEqual(api(seam, "GetMerchantNumItems"), [0]);
  assert.deepEqual(api(seam, "UnitName", "NPC"), []);
  seam.openMerchant();
  assert.deepEqual(worldPump.events, [[FRAMEXML_SEAM_EVENTS.merchantShow]]);
  assert.deepEqual(api(seam, "UnitName", "NPC"), [CANNED_MERCHANT.name]);
  assert.deepEqual(api(seam, "UnitExists", "NPC"), [true]);
  assert.deepEqual(api(seam, "GetMerchantNumItems"), [2]);
  assert.deepEqual(api(seam, "GetMerchantItemInfo", 1), [
    CANNED_MERCHANT.items[0].name, CANNED_MERCHANT.items[0].texture, 1250, 1, -1, true, false,
  ]);
  assert.deepEqual(api(seam, "GetMerchantItemInfo", 2), [
    CANNED_MERCHANT.items[1].name, CANNED_MERCHANT.items[1].texture, 100, 1, 1, true, false,
  ]);
  assert.deepEqual(api(seam, "GetMerchantItemInfo", 3), []);
  assert.deepEqual(api(seam, "GetMerchantItemCostInfo", 1), [0, 0, 0]);
  assert.deepEqual(api(seam, "GetMerchantItemCostItem", 1, 1), []);
  assert.deepEqual(api(seam, "CanMerchantRepair"), [false]);
  assert.deepEqual(api(seam, "GetRepairAllCost"), [0, false]);
  assert.deepEqual(api(seam, "CanGuildBankRepair"), [false]);
  assert.deepEqual(api(seam, "InRepairMode"), [false]);

  seam.refreshMerchant();
  assert.deepEqual(worldPump.events.slice(-1), [[FRAMEXML_SEAM_EVENTS.merchantUpdate]]);
  seam.closeMerchant();
  assert.deepEqual(worldPump.events.slice(-1), [[FRAMEXML_SEAM_EVENTS.merchantClosed]]);
  assert.deepEqual(api(seam, "UnitName", "NPC"), []);
  seam.detach();
});

test("Canned Merchant routes standard purchases and absolute buyback slots", () => {
  const seam = new CannedWorldSeam();
  seam.attach(pump());
  seam.openMerchant();
  api(seam, "BuyMerchantItem", 2);
  api(seam, "BuyMerchantItem", 1, 3);
  api(seam, "BuyMerchantItem", 2, 0);
  api(seam, "BuybackItem", 1);
  api(seam, "BuybackItem", 0);
  assert.deepEqual(seam.merchantBuyRequests, [{ slot: 2, count: 1 }, { slot: 1, count: 3 }, { slot: 2, count: 1 }]);
  assert.deepEqual(seam.merchantBuybackRequests, [74]);
  seam.detach();
});
