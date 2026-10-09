import assert from "node:assert/strict";
import test, { after } from "node:test";

// L5c-review (04.10), plan item 3.09: money on the stock cursor in ordinary play, MPQ-backed — the real
// CoinPickupFrame, ContainerFrame, TradeFrame and MailFrame Lua over the canned seam and its recording
// trade, mail and guild-bank worlds. The table: which flows may put money on the wire and which never
// may. Only the stock TradeFrame's own drop (AddTradeMoney) and pick-up (PickupTradeMoney) send, one
// CMSG_SET_TRADE_GOLD each with the offer's new TOTAL (TradeHandler.cpp HandleSetTradeGoldOpcode →
// TradeData::SetMoney sets, it does not add); the coin dialog, a bag slot, Escape, another pickup, a
// trade the stock window does not show, a closed trade and the mail money box send nothing.
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
const { TRADE_STATUS_TRADE_CANCELED } = await import("../dist/code/world/TradeProtocol.js");
const decoder = new TextDecoder("utf-8");

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "cursor-money-flows", []);
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

test("money on the cursor reaches the wire only through the stock trade's own drop and pick-up", withClient, async () => {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    const gate = frameXmlTradeGate(seam, boot, renderer());
    assert.ok(gate, "the stock TradeFrame passes its gate");
    const owner = createFrameXmlTradeOwner(boot, gate.frame);
    const purse = seam.money();
    assert.ok(purse >= 1000, `the canned purse: ${purse}`);
    const errors = boot.vm.errors.length;
    // Every money packet the three recording worlds can see.
    const wire = () => [
      ...seam.tradeWorld.calls.filter((call) => call.kind === "gold").map((call) => `trade gold ${call.copper}`),
      ...seam.mailWorld.calls.filter((call) => call.kind === "send" || call.kind === "takeMoney").map((call) => `mail ${call.kind}`),
      ...seam.guildBankWorld.calls.filter((call) => call.kind === "deposit" || call.kind === "withdraw")
        .map((call) => `vault ${call.kind} ${call.copper}`),
    ];
    const held = () => lua(boot, "return GetCursorMoney()")[0];
    const shown = () => lua(boot, "return MoneyTypeInfo.PLAYER.UpdateFunc(FlowPurse)")[0];
    lua(boot, `
      local purse = CreateFrame("Frame", "FlowPurse", UIParent, "SmallMoneyFrameTemplate")
      MoneyFrame_SetType(purse, "PLAYER")
    `, 0);
    // The backpack's coin button: OpenCoinPickupFrame, digits, «OK» (CoinPickupFrame.lua).
    const hold = (amount) => {
      lua(boot, `
        OpenCoinPickupFrame(1, MoneyTypeInfo.PLAYER.UpdateFunc(FlowPurse), FlowPurse)
        for digit in string.gmatch("${amount}", "%d") do CoinPickupFrame_OnChar(CoinPickupFrame, digit) end
        CoinPickupFrameOkay_Click()
      `, 0);
      assert.equal(held(), amount, `the hand holds ${amount}`);
    };
    const rows = [];
    const row = (name, run, expectWire, expectHeld) => {
      const before = wire().length;
      run();
      const sent = wire().slice(before);
      rows.push([name, sent.join(", ") || "-", held()]);
      assert.deepEqual(sent, expectWire, `${name}: the wire`);
      assert.equal(held(), expectHeld, `${name}: the hand`);
    };

    row("coin dialog «OK» (PickupPlayerMoney)", () => hold(250), [], 250);
    assert.equal(shown(), purse - 250, "the purse shows the money out while it is held");
    row("dropped on a bag slot (ContainerFrameItemButton_OnClick)",
      () => lua(boot, "ContainerFrameItemButton_OnClick(ContainerFrame1Item1, 'LeftButton')", 0), [], 0);
    assert.equal(shown(), purse, "back in the purse");
    row("Escape / a press on the world (ClearCursor)", () => { hold(250); lua(boot, "ClearCursor()", 0); }, [], 0);
    row("a coin button clicked with money held (OpenCoinPickupFrame drops it)",
      () => { hold(250); lua(boot, "OpenCoinPickupFrame(1, 500, FlowPurse)", 0); }, [], 0);
    row("another pickup takes the hand (PickupItem)", () => { hold(250); lua(boot, "PickupItem(6948) ClearCursor()", 0); }, [], 0);
    row("TradeFrame clicked with no trade (AddTradeMoney)", () => { hold(250); lua(boot, "TradeFrame_OnMouseUp()", 0); }, [], 250);

    // A trade the native window owns: stock TradeFrame never showed it, so a stock drop does not reach it.
    seam.trade.owned = false;
    seam.tradeWorld.open();
    row("a native-owned trade (AddTradeMoney, PickupTradeMoney)",
      () => lua(boot, "AddTradeMoney() PickupTradeMoney(10)", 0), [], 250);
    seam.tradeWorld.status(TRADE_STATUS_TRADE_CANCELED);

    // The stock trade.
    seam.trade.owned = true;
    seam.tradeWorld.open();
    assert.equal(owner.isOpen(), true, "TRADE_SHOW opened TradeFrame");
    row("open trade: no packet for the hand by itself", () => {}, [], 250);
    row("dropped on the stock TradeFrame (AddTradeMoney: offer 0 + 250)",
      () => lua(boot, "TradeFrame_OnMouseUp()", 0), ["trade gold 250"], 0);
    assert.equal(lua(boot, "return GetPlayerTradeMoney()")[0], 250);
    row("picked back from the offer (PickupTradeMoney 100: the new total 150)",
      () => lua(boot, "MoneyTypeInfo.PLAYER_TRADE.PickupFunc(TradePlayerInputMoneyFrame, 100)", 0), ["trade gold 150"], 100);
    row("more than offered (PickupTradeMoney 1000)", () => lua(boot, "PickupTradeMoney(1000)", 0), [], 100);
    assert.equal(shown(), purse - 100 - 150, "GetMoney - GetCursorMoney - GetPlayerTradeMoney");
    // The partner cancels with money in the hand: nothing is sent, the hand keeps the character's money
    // (Wow.exe's TRADE_CLOSED sites 0x58710e/0x5879bc/0x58812b show no cursor clear nearby).
    row("the partner cancels (TRADE_CLOSED)",
      () => seam.tradeWorld.status(TRADE_STATUS_TRADE_CANCELED), [], 100);
    assert.equal(owner.isOpen(), false);
    assert.equal(shown(), purse - 100);
    // A later trade: nothing moves on its own; an explicit drop offers the character's own money,
    // capped by the coinage (0x00704220).
    seam.tradeWorld.open();
    assert.equal(owner.isOpen(), true);
    row("the next trade opens: nothing on its own", () => {}, [], 100);
    row("the trade's money box offers 100 (SetTradeMoney)",
      () => lua(boot, "MoneyInputFrame_SetCopper(TradePlayerInputMoneyFrame, 100) TradeFrame_UpdateMoney()", 0),
      ["trade gold 100"], 100);
    seam.setPlayerMoney(150);
    row("dropped while the coinage (150) no longer covers offer + hand (200)", () => lua(boot, "AddTradeMoney()", 0), [], 100);
    seam.setPlayerMoney(purse);
    row("dropped on the next trade explicitly (offer 100 + 100)", () => lua(boot, "TradeFrame_OnMouseUp()", 0), ["trade gold 200"], 0);
    lua(boot, "HideUIPanel(TradeFrame)", 0);
    assert.equal(seam.tradeWorld.tradeOpen, false, "closing TradeFrame cancels the trade");

    // The send-mail money box: the sum goes into the box (SendMailMoneyButton_OnClick); a letter leaves
    // only by SendMail, which nothing here calls.
    row("dropped on the send-mail money box", () => { hold(300); lua(boot, "SendMailMoneyButton_OnClick()", 0); }, [], 0);
    assert.equal(lua(boot, "return MoneyInputFrame_GetCopper(SendMailMoney)")[0], 300);
    lua(boot, "MoneyInputFrame_SetCopper(SendMailMoney, 0)", 0);

    // A UI teardown (reload, logout) with money held: the hand is emptied, nothing is sent.
    hold(250);
    const beforeTeardown = wire().length;
    seam.cursor.detach();
    rows.push(["UI teardown with money held (cursor detach)", wire().slice(beforeTeardown).join(", ") || "-", seam.cursor.money()?.amount ?? 0]);
    assert.equal(wire().length, beforeTeardown);
    assert.equal(seam.cursor.money(), undefined);
    assert.deepEqual(wire(), ["trade gold 250", "trade gold 150", "trade gold 100", "trade gold 200"], "the whole wire");
    assert.equal(boot.vm.errors.length, errors, "no Lua error on the way");
    console.log(`[cursor money flows] ${JSON.stringify(rows)}`);
  } finally {
    boot.close();
  }
});
