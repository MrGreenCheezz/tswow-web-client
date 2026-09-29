import assert from "node:assert/strict";
import test from "node:test";

const { CannedWorldSeam, CANNED_ACTION_BAR } = await import(
  "../dist/code/browser/framexml/CannedWorldSeam.js"
);
const { FRAMEXML_SEAM_BINDINGS } = await import(
  "../dist/code/browser/framexml/FrameXmlWorldSeam.js"
);
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { itemChatLink } = await import("../dist/code/browser/ui/ChatLink.js");

function merchantFixture() {
  const bought = itemChatLink(90001, 4, "Эмблемный предмет");
  const required = itemChatLink(90002, 3, "Тестовый редкий жетон");
  const merchant = {
    guid: 0x600n,
    name: "Торговец за жетоны",
    items: [{
      slot: 9, itemId: 90001, name: "Эмблемный предмет", quality: 4,
      texture: "Interface\\Icons\\INV_Misc_Coin_01", price: 0, quantity: 1,
      numAvailable: 1, isUsable: true, extendedCost: 7, link: bought,
      cost: { honor: 0, arena: 0, items: [{
        itemId: 90002, name: "Тестовый редкий жетон", quality: 3,
        texture: "Interface\\Icons\\INV_Misc_Rune_01", count: 2, link: required,
      }] },
    }],
    buyback: [],
  };
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, merchant);
  seam.attach({ now: () => 1, fire: () => 1 });
  seam.openMerchant();
  return { seam, bought, required };
}

test("GetItemInfo gives stock MerchantFrame the cached quality for both token links", () => {
  const { seam, bought, required } = merchantFixture();
  try {
    const getItemInfo = FRAMEXML_SEAM_BINDINGS.GetItemInfo;
    assert.equal(typeof getItemInfo, "function", "stock GetItemInfo needs an actual C API binding");
    assert.deepEqual(getItemInfo(seam, [required]).slice(0, 3), ["Тестовый редкий жетон", required, 3]);
    assert.deepEqual(getItemInfo(seam, [bought]).slice(0, 3), ["Эмблемный предмет", bought, 4]);
    assert.deepEqual(getItemInfo(seam, ["|Hitem:999999|h[Unknown]|h"]), [],
      "uncached item data must remain nil");
  } finally { seam.detach(); }
});

test("selected stock token-cost function opens confirmation; stock accept buys once", async (t) => {
  let clientDirectory;
  try { ({ clientDirectory } = await import("../tools/paths.mjs")); clientDirectory = clientDirectory(); }
  catch { t.skip("no selected 3.3.5a client"); return; }
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const { seam, bought } = merchantFixture();
  const vm = new GlueLuaVm();
  try {
    const merchantBytes = await chain.read("interface/framexml/merchantframe.lua");
    const popupBytes = await chain.read("interface/framexml/staticpopup.lua");
    assert.ok(merchantBytes && popupBytes, "selected client provides both stock Lua sources");
    const merchantLua = new TextDecoder().decode(merchantBytes);
    const popupLua = new TextDecoder().decode(popupBytes);
    const functionStart = merchantLua.indexOf("function MerchantFrame_ConfirmExtendedItemCost(");
    const functionEnd = merchantLua.indexOf("function MerchantFrame_ResetRefundItem(", functionStart);
    const popupStart = popupLua.indexOf('StaticPopupDialogs["CONFIRM_PURCHASE_TOKEN_ITEM"] = {');
    const popupEnd = popupLua.indexOf('StaticPopupDialogs["CONFIRM_REFUND_TOKEN_ITEM"]', popupStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart && popupStart >= 0 && popupEnd > popupStart,
      "selected stock contains the expected merchant and confirmation definitions");
    const buyRequests = [];
    const popups = [];
    for (const name of ["GetItemInfo", "GetMerchantItemCostInfo", "GetMerchantItemCostItem"]) {
      const binding = FRAMEXML_SEAM_BINDINGS[name];
      assert.equal(typeof binding, "function", `${name} must use the world seam`);
      vm.registerGlobal(name, (args) => binding(seam, args));
    }
    vm.registerGlobal("BuyMerchantItem", (args) => { buyRequests.push(args); return []; });
    vm.registerGlobal("StaticPopup_Show", (args) => { popups.push(args); return []; });
    vm.registerGlobal("UnitFactionGroup", () => ["Alliance"]);
    vm.registerGlobal("GetItemQualityColor", () => [1, 1, 1]);
    for (const [name, value] of Object.entries({
      MAX_ITEM_COST: 5, ITEM_QUALITY_UNCOMMON: 2,
      ITEM_QUANTITY_TEMPLATE: "%d %s", MERCHANT_HONOR_POINTS: "%d", MERCHANT_ARENA_POINTS: "%d",
      YES: "Да", NO: "Нет", CONFIRM_PURCHASE_TOKEN_ITEM: "%s",
    })) vm.setGlobal(name, value);
    const source = `StaticPopupDialogs = {}\n${popupLua.slice(popupStart, popupEnd)}\n${merchantLua.slice(functionStart, functionEnd)}`;
    const loaded = vm.execute(source, "@selected-client-merchant-confirmation");
    assert.equal(loaded.ok, true, loaded.error);
    const called = vm.execute(`
      MerchantFrame = {}
      local button = { link = ${JSON.stringify(bought)}, texture = "Interface\\\\Icons\\\\INV_Misc_Coin_01", count = 1 }
      function button:GetID() return 1 end
      MerchantFrame_ConfirmExtendedItemCost(button)
    `, "@selected-client-merchant-click");
    assert.equal(called.ok, true, called.error);
    assert.deepEqual(buyRequests, [], "rare token purchase waits for confirmation");
    assert.equal(popups.length, 1);
    assert.equal(popups[0][0], "CONFIRM_PURCHASE_TOKEN_ITEM");
    const accepted = vm.execute('StaticPopupDialogs["CONFIRM_PURCHASE_TOKEN_ITEM"].OnAccept()',
      "@selected-client-merchant-accept");
    assert.equal(accepted.ok, true, accepted.error);
    assert.deepEqual(buyRequests, [[1, 1]], "stock accept emits one purchase with the selected row/count");
  } finally {
    vm.close();
    seam.detach();
    chain.close();
  }
});
