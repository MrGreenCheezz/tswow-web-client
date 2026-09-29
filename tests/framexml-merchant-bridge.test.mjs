import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam, CANNED_ACTION_BAR, CANNED_MERCHANT } = await import(
  "../dist/code/browser/framexml/CannedWorldSeam.js",
);
const { itemChatLink } = await import("../dist/code/browser/ui/ChatLink.js");
const decoder = new TextDecoder("utf-8");

test("MPQ MerchantFrame uses stock show, rows, right-click purchase, buyback tab, and close", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
    exercise: false,
  });
  try {
    const inventory = await boot.load();
    const frame = (name) => boot.bridge.getFrame(name);
    const root = frame("MerchantFrame");
    assert.ok(root);
    assert.equal(root.visible, false, "stock merchant starts hidden");
    assert.equal(inventory.lua.failed, 0, "MerchantFrame.lua executes cleanly");
    assert.deepEqual(inventory.errors.filter(({ file, handled }) => !handled && /merchant/i.test(file)), [],
      "MerchantFrame adds no unhandled load errors");

    seam.openMerchant();
    assert.equal(root.visible, true, "MERCHANT_SHOW opens the stock root");
    assert.equal(frame("MerchantNameText").text, CANNED_MERCHANT.name);
    assert.equal(frame("MerchantItem1").visible, true);
    assert.equal(frame("MerchantItem1Name").text, CANNED_MERCHANT.items[0].name);
    assert.equal(frame("MerchantItem1MoneyFrame").visible, true,
      "ordinary copper purchase keeps its money price");
    assert.equal(frame("MerchantItem1AltCurrencyFrame").visible, false,
      "ordinary copper purchase has no alternate-cost bar");
    assert.equal(frame("MerchantItem2Name").text, CANNED_MERCHANT.items[1].name);
    assert.equal(frame("MerchantItem3ItemButton").visible, false,
      "unsupported/absent merchant rows hide their item buttons");
    assert.ok(!frame("MerchantRepairAllButton").visible || !frame("MerchantRepairAllButton").enabled,
      "repair-all stays hidden or disabled");
    assert.ok(!frame("MerchantRepairItemButton").visible || !frame("MerchantRepairItemButton").enabled,
      "item repair stays hidden or disabled");

    const firstItemButton = frame("MerchantItem1ItemButton");
    assert.ok(firstItemButton);
    assert.equal(boot.bridge.Click(firstItemButton, "RightButton", false), true);
    assert.deepEqual(seam.merchantBuyRequests, [{ slot: 1, count: 1 }],
      "stock right-click calls BuyMerchantItem through the seam");

    const buybackTab = frame("MerchantFrameTab2");
    assert.equal(boot.bridge.Click(buybackTab, "LeftButton", false), true);
    assert.equal(frame("MerchantItem1Name").text, CANNED_MERCHANT.buyback[0].name);
    assert.equal(boot.bridge.Click(firstItemButton, "LeftButton", false), true);
    assert.deepEqual(seam.merchantBuybackRequests, [74],
      "stock buyback button keeps one-based row semantics and absolute protocol slot");

    assert.equal(boot.bridge.Click(frame("MerchantFrameCloseButton"), "LeftButton", false), true);
    assert.equal(root.visible, false, "close button hides stock root");
    const callGlobal = (name, ...args) => {
      const ref = boot.vm.globalFunction(name);
      assert.ok(ref, `${name} must be installed by the bridge`);
      try { return boot.vm.call(ref, args, 1); } finally { boot.vm.release(ref); }
    };
    assert.deepEqual(callGlobal("UnitName", "NPC"), [undefined],
      "stock OnHide CloseMerchant clears the NPC context");
    assert.deepEqual(callGlobal("GetMerchantNumItems"), [0],
      "stock OnHide CloseMerchant closes the merchant source");
    assert.equal(seam.merchantBuyRequests.length, 1);
    assert.equal(seam.merchantBuybackRequests.length, 1);
    assert.deepEqual(boot.vm.errors, [], "merchant interactions add no Lua errors");
  } finally {
    boot.close();
    chain.close();
  }
});

test("stock MerchantFrame renders extended-cost rows with honor, arena and required items", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { openClientArchives } = await import("../tools/mpq.mjs");
  const chain = await openClientArchives(clientDirectory);
  const merchant = {
    guid: 0x600n,
    name: "Торговец за эмблемы",
    items: [{
      slot: 9, itemId: 90001, name: "Эмблемный предмет",
      texture: "Interface\\Icons\\INV_Misc_Coin_01", price: 0, quantity: 1,
      numAvailable: 1, isUsable: true, extendedCost: 7,
      link: itemChatLink(90001, 4, "Эмблемный предмет"),
      cost: { honor: 125, arena: 20, items: [{
        texture: "Interface\\Icons\\INV_Misc_Rune_01", count: 2,
        link: itemChatLink(6948, 1, "Камень возвращения"),
      }] },
    }],
    buyback: [],
  };
  const seam = new CannedWorldSeam(CANNED_ACTION_BAR, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, merchant);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
    exercise: false,
  });
  try {
    await boot.load();
    const frame = (name) => boot.bridge.getFrame(name);
    seam.openMerchant();
    assert.equal(frame("MerchantItem1Name").text, "Эмблемный предмет");
    const costInfo = boot.vm.globalFunction("GetMerchantItemCostInfo");
    assert.ok(costInfo);
    try { assert.deepEqual(boot.vm.call(costInfo, [1], 3), [125, 20, 1]); }
    finally { boot.vm.release(costInfo); }
    assert.equal(frame("MerchantItem1AltCurrencyFrame").visible, true);
    assert.equal(frame("MerchantItem1MoneyFrame").visible, false,
      "zero-copper extended cost uses the alternate-price branch");
    assert.equal(frame("MerchantItem1AltCurrencyFrameItem1").visible, true);
    assert.deepEqual(boot.vm.errors, [], "rendering the extended price raises no Lua errors");
  } finally {
    boot.close();
    chain.close();
  }
});
