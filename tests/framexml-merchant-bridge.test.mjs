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
