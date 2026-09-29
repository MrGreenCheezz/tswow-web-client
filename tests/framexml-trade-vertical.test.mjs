import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: stock TradeFrame.xml in the production vertical over the canned partner. The real
// TradeFrame.lua paints both sides, the accept highlights and the money frames from FrameXmlTrade.ts.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { createFrameXmlTradeOwner, frameXmlTradeGate } = await import("../dist/code/browser/framexml/FrameXmlTradeOwner.js");
const { frameXmlCannedTradeItem } = await import("../dist/code/browser/framexml/FrameXmlTradeCanned.js");
const { FRAMEXML_CANNED_MAIL_ITEMS } = await import("../dist/code/browser/framexml/FrameXmlMailCanned.js");
const {
  TRADE_STATUS_BACK_TO_TRADE, TRADE_STATUS_TRADE_ACCEPT, TRADE_STATUS_TRADE_CANCELED, TRADE_STATUS_TRADE_COMPLETE,
} = await import("../dist/code/world/TradeProtocol.js");
const decoder = new TextDecoder("utf-8");

async function load() {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "trade-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function renderer() {
  return {
    elementFor(frame) {
      const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
      return { dataset: {}, getAttribute: (name) => attributes.get(name) ?? null };
    },
  };
}

test("an open trade runs stock TradeFrame: both sides, money, the accept highlights, completion", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const gate = frameXmlTradeGate(seam, boot, renderer());
    assert.ok(gate);
    const owner = createFrameXmlTradeOwner(boot, gate.frame);
    seam.trade.owned = true;
    const world = seam.tradeWorld;
    const errors = boot.errorCount;
    world.open();
    assert.equal(owner.isOpen(), true, "TRADE_SHOW opened TradeFrame");
    assert.deepEqual(lua(boot, "return TradeFrameRecipientNameText:GetText(), TradeFramePlayerNameText:GetText()", 2),
      ["Эльмира", lua(boot, "return UnitName('player')")[0]], "the partner is UnitName(\"NPC\")");
    world.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
    lua(boot, "TradePlayerItem1ItemButton:Click()", 0);
    assert.deepEqual(world.calls, [{ kind: "offer", tradeSlot: 0, bag: 255, slot: 23 }]);
    assert.deepEqual(lua(boot, "return TradePlayerItem1Name:GetText(), TradePlayerItem1ItemButtonCount:GetText(), TradePlayerItem1ItemButton.hasItem", 3),
      ["Огромный флакон с лечебным зельем", "5", 1]);
    world.partnerOffers(12_345, [frameXmlCannedTradeItem(0, 2589, 20), frameXmlCannedTradeItem(1, 4306, 10)]);
    assert.deepEqual(lua(boot, "return TradeRecipientItem1Name:GetText(), TradeRecipientItem2Name:GetText(), TradeRecipientItem1ItemButtonCount:GetText()", 3),
      ["Льняной материал", "Шелковый материал", "20"]);
    assert.deepEqual(lua(boot, "return TradeRecipientMoneyFrame.staticMoney or GetTargetTradeMoney()"), [12_345]);
    // Typing into the box runs its onValueChanged, TradeFrame_UpdateMoney (MoneyInputFrame_SetCopper alone
    // is silent: it counts its own edits in expectChanges).
    lua(boot, "MoneyInputFrame_SetCopper(TradePlayerInputMoneyFrame, 5000) TradeFrame_UpdateMoney()", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "gold", copper: 5000 }, "the money box sends SetTradeMoney on change");
    lua(boot, "TradeFrameTradeButton:Click()", 0);
    assert.deepEqual(world.calls.at(-1), { kind: "accept" });
    assert.deepEqual(lua(boot, "return TradeHighlightPlayer:IsShown() and 1 or 0, TradeHighlightRecipient:IsShown() and 1 or 0, TradeFrameTradeButton:IsEnabled()", 3),
      [1, 0, 0], "stock greys the button once the player accepted");
    world.status(TRADE_STATUS_TRADE_ACCEPT);
    assert.deepEqual(lua(boot, "return TradeHighlightRecipient:IsShown() and 1 or 0"), [1]);
    world.status(TRADE_STATUS_BACK_TO_TRADE);
    assert.deepEqual(lua(boot, "return TradeHighlightPlayer:IsShown() and 1 or 0, TradeHighlightRecipient:IsShown() and 1 or 0, TradeFrameTradeButton:IsEnabled()", 3),
      [0, 0, 1], "a changed offer clears both accepts");
    lua(boot, "TradeFrameTradeButton:Click() TradeFrameCancelButton:Click()", 0);
    assert.deepEqual(world.calls.slice(-2), [{ kind: "accept" }, { kind: "unaccept" }],
      "Cancel after accepting takes the accept back (TradeFrameCancelButton_OnClick)");
    assert.equal(owner.isOpen(), true);
    const hovered = boot.errorCount;
    lua(boot, `TradePlayerItem1ItemButton:GetScript("OnEnter")(TradePlayerItem1ItemButton) GameTooltip:Hide()
      TradeRecipientItem1ItemButton:GetScript("OnEnter")(TradeRecipientItem1ItemButton) GameTooltip:Hide()`, 0);
    assert.equal(boot.errorCount, hovered, "hovering both sides raises nothing");
    world.status(TRADE_STATUS_TRADE_COMPLETE, "Обмен завершён");
    assert.equal(owner.isOpen(), false, "TRADE_CLOSED hid TradeFrame");
    assert.deepEqual(boot.errors.slice(errors), []);
  } finally {
    boot.close();
  }
});

test("a partner item's name arriving after both accepts keeps the highlights; a canceled trade gives the bags their gold back", withClient, async () => {
  const { boot, seam } = await load();
  // The canned cache without Silk Cloth, as a live trade is until the item metadata answers.
  const silk = FRAMEXML_CANNED_MAIL_ITEMS.get(4306);
  FRAMEXML_CANNED_MAIL_ITEMS.delete(4306);
  try {
    const gate = frameXmlTradeGate(seam, boot, renderer());
    assert.ok(gate);
    seam.trade.owned = true;
    const world = seam.tradeWorld;
    const errors = boot.errorCount;
    // A PLAYER money frame, as the backpack's: GetMoney() - GetCursorMoney() - GetPlayerTradeMoney().
    lua(boot, `local money = CreateFrame("Frame", "TradeLaneBagMoney", UIParent, "SmallMoneyFrameTemplate")
      MoneyFrame_UpdateMoney(money)`, 0);
    const carried = lua(boot, "return TradeLaneBagMoney.staticMoney")[0];
    assert.equal(carried, lua(boot, "return GetMoney()")[0]);
    world.open();
    world.partnerOffers(0, [frameXmlCannedTradeItem(0, 4306, 10)]);
    lua(boot, "MoneyInputFrame_SetCopper(TradePlayerInputMoneyFrame, 5000) TradeFrame_UpdateMoney()", 0);
    assert.deepEqual(lua(boot, "return TradeLaneBagMoney.staticMoney"), [carried - 5000], "the offered gold is out of the bags");
    lua(boot, "TradeFrameTradeButton:Click()", 0);
    world.status(TRADE_STATUS_TRADE_ACCEPT);
    const accepted = () => lua(boot, `return TradeHighlightPlayer:IsShown() and 1 or 0, TradeHighlightRecipient:IsShown() and 1 or 0,
      TradeFrameTradeButton:IsEnabled(), TradeRecipientItem1Name:GetText()`, 4);
    assert.deepEqual(accepted().slice(0, 3), [1, 1, 0]);
    FRAMEXML_CANNED_MAIL_ITEMS.set(4306, silk);
    await new Promise((resolve) => setTimeout(resolve, 300));
    seam.trade.tick();
    assert.deepEqual(accepted(), [1, 1, 0, "Шелковый материал"],
      "TRADE_UPDATE painted the name, and both accepts are painted again after it");
    world.status(TRADE_STATUS_TRADE_CANCELED, "Обмен отменен");
    assert.equal(gate.frame.visible, false);
    seam.trade.tick();
    assert.deepEqual(lua(boot, "return TradeLaneBagMoney.staticMoney"), [carried], "PLAYER_TRADE_MONEY after the cancel");
    assert.deepEqual(boot.errors.slice(errors), []);
  } finally {
    if (silk) FRAMEXML_CANNED_MAIL_ITEMS.set(4306, silk);
    boot.close();
  }
});

test("closing TradeFrame cancels the trade, as its OnHide does in the client", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const gate = frameXmlTradeGate(seam, boot, renderer());
    const owner = createFrameXmlTradeOwner(boot, gate.frame);
    seam.trade.owned = true;
    seam.tradeWorld.open();
    owner.hide();
    assert.deepEqual(seam.tradeWorld.calls, [{ kind: "cancel" }]);
    assert.equal(seam.tradeWorld.tradeOpen, false);
    assert.equal(owner.isOpen(), false);
  } finally {
    boot.close();
  }
});
