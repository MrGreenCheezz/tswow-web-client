import { clientDirectory } from "../../tools/paths.mjs";
import { clientArchives } from "../../tools/mpq.mjs";
import { FrameXmlBoot } from "../../dist/code/browser/framexml/FrameXmlBoot.js";
import { FRAMEXML_VERTICAL_TOC } from "../../dist/code/browser/framexml/FrameXmlCorpus.js";
import { CannedWorldSeam, CANNED_ACTION_BAR } from "../../dist/code/browser/framexml/CannedWorldSeam.js";
import { itemChatLink } from "../../dist/code/browser/ui/ChatLink.js";

const mark = (label, data = {}) => process.stdout.write(`${JSON.stringify({ label, ...data })}\n`);
const bought = itemChatLink(90001, 4, "Эмблемный предмет");
const required = itemChatLink(90002, 3, "Тестовый редкий жетон");
const merchant = {
  guid: 0x600n, name: "Торговец за жетоны",
  items: [{
    slot: 9, itemId: 90001, name: "Эмблемный предмет", quality: 4,
    texture: "Interface\\Icons\\INV_Misc_Coin_01", price: 0, quantity: 1,
    numAvailable: 1, isUsable: true, extendedCost: 7, link: bought,
    cost: { honor: 0, arena: 0, items: [{
      itemId: 90002, name: "Тестовый редкий жетон", quality: 3,
      texture: "Interface\\Icons\\INV_Misc_Rune_01", count: 2, link: required,
    }] },
  }], buyback: [],
};
mark("archive-start");
const chain = await clientArchives(clientDirectory());
const seam = new CannedWorldSeam(CANNED_ACTION_BAR, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, merchant);
const decoder = new TextDecoder("utf-8");
const boot = new FrameXmlBoot({
  provider: { async read(path) {
    const bytes = await chain.read(path);
    return bytes ? decoder.decode(bytes) : undefined;
  } },
  locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
  screen: () => ({ width: 1024, height: 768 }), exercise: false,
});
try {
  mark("boot-start");
  const inventory = await boot.load();
  mark("boot-complete", {
    files: inventory.files.total, bytes: inventory.files.bytes,
    widgets: inventory.widgets.total, chunks: inventory.plan.chunks,
    lua: inventory.lua.executed, luaFailed: inventory.lua.failed,
    unhandled: inventory.errors.filter((error) => !error.handled).length,
  });
  const frame = (name) => boot.bridge.getFrame(name);
  seam.openMerchant();
  mark("merchant-open", { row: frame("MerchantItem1Name")?.text, button: !!frame("MerchantItem1ItemButton") });
  const inspect = boot.vm.execute(`__merchantProbe = table.concat({
    tostring(MerchantFrame.selectedTab),
    tostring(MerchantItem1ItemButton.extendedCost),
    tostring(MerchantItem1ItemButton.link),
    tostring(MerchantItem1ItemButton:GetID()),
    tostring(GetItemInfo(MerchantItem1ItemButton.link)),
    tostring(select(3, GetItemInfo(select(3, GetMerchantItemCostItem(1, 1)))))
  }, "|")`, "@mounted-token-state");
  mark("merchant-state", { inspect, value: boot.vm.getGlobal("__merchantProbe") });
  const beforeDiagnostics = boot.bridge.diagnostics.length;
  const clicked = boot.bridge.Click(frame("MerchantItem1ItemButton"), "RightButton", false);
  mark("merchant-click", {
    clicked, buys: seam.merchantBuyRequests,
    popups: [1, 2, 3, 4].map((i) => ({ visible: frame(`StaticPopup${i}`)?.visible, which: frame(`StaticPopup${i}`)?.which })),
    luaErrors: boot.vm.errors,
    bridgeDiagnostics: boot.bridge.diagnostics.slice(beforeDiagnostics),
  });
  const popup = [1, 2, 3, 4].map((i) => frame(`StaticPopup${i}`)).find((f) => f?.visible);
  if (!popup) throw new Error("confirmation popup is not visible");
  const whichRead = boot.vm.execute(`__tokenPopupWhich = ${popup.name}.which`, "@mounted-token-which");
  mark("popup-which", { whichRead, which: boot.vm.getGlobal("__tokenPopupWhich") });
  if (boot.vm.getGlobal("__tokenPopupWhich") !== "CONFIRM_PURCHASE_TOKEN_ITEM") {
    throw new Error("visible popup is not token purchase confirmation");
  }
  const cancel = frame(`${popup.name}Button2`);
  if (!cancel) throw new Error("confirmation cancel button missing");
  boot.bridge.Click(cancel, "LeftButton", false);
  mark("cancel-click", { buys: seam.merchantBuyRequests, visible: popup.visible });
  boot.bridge.Click(frame("MerchantItem1ItemButton"), "RightButton", false);
  mark("merchant-reclick", { visible: popup.visible, buys: seam.merchantBuyRequests });
  const active = [1, 2, 3, 4].map((i) => frame(`StaticPopup${i}`)).find((f) => f?.visible);
  if (!active) throw new Error("confirmation popup did not re-open");
  const accept = frame(`${active.name}Button1`);
  if (!accept) throw new Error("confirmation accept button missing");
  boot.bridge.Click(accept, "LeftButton", false);
  mark("accept-click", { buys: seam.merchantBuyRequests, visible: active.visible, luaErrors: boot.vm.errors });
} finally {
  boot.close();
  chain.close();
  mark("closed");
}
