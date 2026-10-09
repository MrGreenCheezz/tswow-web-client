import assert from "node:assert/strict";
import test from "node:test";

// 2.10 through the stock Lua (MPQ): ContainerFrame_GetExtendedPriceString reads
// GetContainerItemPurchaseInfo and shows CONFIRM_REFUND_TOKEN_ITEM, whose accept calls
// ContainerRefundItemPurchase with the remembered place; with nothing answered it returns false
// (the click is a sale). END_REFUND(1) shows its popup and the accept is EndRefund(1).
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

test("MPQ ContainerFrame/StaticPopup: the refund question, its accept, and END_REFUND", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  let boot;
  try {
    const seam = new CannedWorldSeam();
    const refunds = [];
    const ends = [];
    let answer = [12000, 0, 0, 0, 3600];
    seam.containerItemPurchaseInfo = (bag, slot) => (bag === 0 && slot === 1 ? answer : undefined);
    seam.containerItemPurchaseItem = () => undefined;
    seam.containerRefundItemPurchase = (bag, slot, equipped) => { refunds.push([bag, slot, equipped]); };
    seam.endRefund = (kind) => { ends.push(kind); };
    boot = new FrameXmlBoot({
      provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
      locale: "ruRU",
      subset: FRAMEXML_VERTICAL_TOC,
      seam,
      screen: () => ({ width: 1024, height: 768 }),
    });
    await boot.load();
    const run = (code, name) => {
      const result = boot.vm.execute(code, name);
      assert.equal(result.ok, true, result.error);
    };
    run(`
      local button = { GetID = function() return 1 end, GetParent = function() return { GetID = function() return 0 end } end }
      __refundShown = ContainerFrame_GetExtendedPriceString(button) and true or false
      __refundDialog = StaticPopup_Visible("CONFIRM_REFUND_TOKEN_ITEM")
    `, "@refund:ask");
    assert.equal(boot.vm.getGlobal("__refundShown"), true, "a refundable purchase asks");
    const dialog = boot.vm.getGlobal("__refundDialog");
    assert.ok(typeof dialog === "string" && dialog.startsWith("StaticPopup"), `CONFIRM_REFUND_TOKEN_ITEM shown: ${dialog}`);
    run(`_G["${dialog}Button1"]:Click()`, "@refund:accept");
    assert.deepEqual(refunds.map(([bag, slot]) => [bag, slot]), [[0, 1]], "ContainerRefundItemPurchase(bag, slot)");

    answer = undefined;
    run(`
      local button = { GetID = function() return 1 end, GetParent = function() return { GetID = function() return 0 end } end }
      __refundShown = ContainerFrame_GetExtendedPriceString(button) and true or false
    `, "@refund:none");
    assert.equal(boot.vm.getGlobal("__refundShown"), false, "no answer: an ordinary sale");

    boot.bridge.dispatchEvent("END_REFUND", 1);
    run(`__endDialog = StaticPopup_Visible("END_REFUND")`, "@refund:end");
    const end = boot.vm.getGlobal("__endDialog");
    assert.ok(typeof end === "string" && end.startsWith("StaticPopup"), `END_REFUND shown: ${end}`);
    run(`_G["${end}Button1"]:Click()`, "@refund:end-accept");
    assert.deepEqual(ends, [1], "EndRefund(1)");
  } finally {
    boot?.close();
    chain.close();
  }
});
