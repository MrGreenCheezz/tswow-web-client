import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.09 (L5c, 04.10): money on the cursor, as Wow.exe 3.3.5a 12340 keeps it (read-only
// Ghidra, .runtime/re-2026-10-04/l5c/): PickupPlayerMoney 0x00522980 → 0x00520880, DropCursorMoney
// 0x00522950, GetCursorMoney 0x00515a50, CursorHasMoney 0x005151c0, GetCursorInfo 0x00515200 (type 2
// "money"), PickupTradeMoney 0x00586810 → 0x00704320, AddTradeMoney 0x00586d90 → 0x00704220, ClearCursor
// 0x0051a3b0 → 0x00519280. Only the trade's own CMSG_SET_TRADE_GOLD ever carries the money anywhere.
const { FrameXmlCursorModel } = await import("../dist/code/browser/framexml/FrameXmlCursor.js");
const { FRAMEXML_CURSOR_MONEY_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlCursorMoney.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function seam({ coinage = 10_000, tradeOpen = false } = {}) {
  const fired = [];
  const cleared = [];
  const host = {
    cursorInfo: () => [], cursorHasItem: () => false, clearCursor: () => { cleared.push(true); },
    spellIsPassive: () => false, itemInfo: () => undefined, spellTexture: () => undefined,
  };
  const cursor = new FrameXmlCursorModel(host);
  cursor.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  const offers = [];
  let offered = 0;
  const trade = {
    playerMoney: () => (tradeOpen ? offered : 0),
    setMoney: (value) => { if (!tradeOpen || value === offered) return; offered = value; offers.push(value); },
  };
  const target = { cursor, trade, money: () => coinage, cursorInfo: () => [], cursorHasItem: () => false, clearCursor: () => {} };
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](target, args);
  const events = async () => { await Promise.resolve(); return fired.splice(0).map(([name]) => name); };
  return { target, cursor, call, events, offers, cleared, setOffered: (value) => { offered = value; } };
}

test("the money bindings answer for the seam table, over the trade's inert pair and the neutral 0", () => {
  for (const name of ["PickupPlayerMoney", "DropCursorMoney", "GetCursorMoney", "CursorHasMoney", "PickupTradeMoney", "AddTradeMoney"]) {
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_CURSOR_MONEY_BINDINGS[name], name);
  }
});

test("PickupPlayerMoney holds up to the coinage; the money is answered, and DropCursorMoney gives it back", async () => {
  const { call, events } = seam({ coinage: 5000 });
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  assert.deepEqual([...call("CursorHasMoney")], [undefined]);
  call("PickupPlayerMoney", 6000);
  call("PickupPlayerMoney", 0);
  call("PickupPlayerMoney", "x");
  assert.deepEqual([...call("GetCursorMoney")], [0], "more than the purse, zero or no number: nothing held");
  assert.deepEqual(await events(), []);
  call("PickupPlayerMoney", 1234.4);
  assert.deepEqual([...call("GetCursorMoney")], [1234]);
  assert.deepEqual([...call("CursorHasMoney")], [1]);
  assert.deepEqual([...call("GetCursorInfo")], ["money", 1234]);
  assert.deepEqual(await events(), ["CURSOR_UPDATE", "PLAYER_MONEY"], "the backpack's money frame redraws without it");
  call("DropCursorMoney");
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  assert.deepEqual([...call("GetCursorInfo")], []);
  assert.deepEqual(await events(), ["PLAYER_MONEY", "CURSOR_UPDATE"]);
  call("DropCursorMoney");
  assert.deepEqual(await events(), [], "nothing held: nothing happens");
});

test("ClearCursor and a new pickup let the money go with PLAYER_MONEY; no action-bar grid for money", async () => {
  const { call, cursor, events } = seam();
  call("PickupPlayerMoney", 100);
  await events();
  call("ClearCursor");
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  assert.deepEqual(await events(), ["PLAYER_MONEY", "CURSOR_UPDATE"]);
  call("PickupPlayerMoney", 100);
  await events();
  cursor.pickupItem(6948);
  assert.deepEqual([...call("GetCursorMoney")], [0], "one thing on the cursor");
  const after = await events();
  assert.ok(after.includes("PLAYER_MONEY"), `the money went back: ${after}`);
  call("ClearCursor");
  await events();
  call("PickupPlayerMoney", 100);
  const grid = await events();
  assert.ok(!grid.includes("ACTIONBAR_SHOWGRID"), `no grid for money: ${grid}`);
});

test("PickupTradeMoney takes from the offer through CMSG_SET_TRADE_GOLD; AddTradeMoney puts it back quietly", async () => {
  const { call, events, offers, setOffered } = seam({ coinage: 10_000, tradeOpen: true });
  setOffered(3000);
  call("PickupTradeMoney", 5000);
  call("PickupTradeMoney", 0);
  call("PickupTradeMoney", -1);
  assert.deepEqual(offers, [], "more than offered, zero or negative: the offer stays");
  call("PickupTradeMoney", 1000);
  assert.deepEqual(offers, [2000], "the new total goes to the realm");
  assert.deepEqual([...call("GetCursorMoney")], [1000]);
  assert.deepEqual(await events(), ["CURSOR_UPDATE", "PLAYER_MONEY"]);
  call("AddTradeMoney");
  assert.deepEqual(offers, [2000, 3000]);
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  assert.deepEqual(await events(), ["CURSOR_UPDATE"], "0x00519280(1, 0): no PLAYER_MONEY");
  // From the purse into the trade: the sum may not pass the coinage.
  call("PickupPlayerMoney", 8000);
  await events();
  call("AddTradeMoney");
  assert.deepEqual(offers, [2000, 3000], "3000 + 8000 > 10000: refused, the money stays held");
  assert.deepEqual([...call("GetCursorMoney")], [8000]);
  call("DropCursorMoney");
  call("PickupPlayerMoney", 7000);
  call("AddTradeMoney");
  assert.deepEqual(offers, [2000, 3000, 10_000]);
  assert.deepEqual([...call("GetCursorMoney")], [0]);
});

test("with no open trade nothing moves and the hand keeps its money", () => {
  const { call, offers } = seam({ tradeOpen: false });
  call("PickupTradeMoney", 10);
  assert.deepEqual([...call("GetCursorMoney")], [0]);
  call("PickupPlayerMoney", 50);
  call("AddTradeMoney");
  assert.deepEqual(offers, []);
  assert.deepEqual([...call("GetCursorMoney")], [50], "the trade did not take it");
});

// L5c-review (04.10): the hand's coin picture by amount, Wow.exe 0x00616510 → 0x007e7cc0 (signed
// compares against 10, 100, 1000, 10000, 100000; the icon directory of 0x00634910 row 3).
test("the hand shows the client's coins for the amount held, and nothing once they are let go", async () => {
  const { frameXmlCoinCursorTexture } = await import("../dist/code/browser/framexml/FrameXmlCursorMoney.js");
  const COIN = "Interface\\Icons\\INV_Misc_Coin_";
  const coin = (amount) => {
    const texture = frameXmlCoinCursorTexture(amount);
    assert.ok(texture.startsWith(COIN), texture);
    return texture.slice(COIN.length);
  };
  assert.deepEqual([1, 9, 10, 99, 100, 999, 1000, 9999, 10_000, 99_999, 100_000, 5_000_000].map(coin),
    ["05", "05", "06", "06", "03", "03", "04", "04", "01", "01", "02", "02"]);
  const { call, cursor, events } = seam({ coinage: 50_000 });
  const pictures = [];
  cursor.onPicture((texture) => pictures.push(texture));
  call("PickupPlayerMoney", 1234);
  assert.equal(cursor.picture(), `${COIN}04`);
  call("DropCursorMoney");
  assert.equal(cursor.picture(), undefined);
  call("PickupPlayerMoney", 20_000);
  call("ClearCursor");
  assert.deepEqual(pictures, [`${COIN}04`, undefined, `${COIN}01`, undefined]);
  await events();
});

// L5c-review (04.10): the documented deviation — money goes only into a trade the stock TradeFrame shows.
test("a trade stock does not show (the native window's) takes no stock money drop", () => {
  const { target, call, offers, setOffered } = seam({ coinage: 10_000, tradeOpen: true });
  setOffered(1000);
  target.trade.showing = false;
  call("PickupPlayerMoney", 500);
  call("AddTradeMoney");
  call("PickupTradeMoney", 200);
  assert.deepEqual(offers, [], "no CMSG_SET_TRADE_GOLD");
  assert.deepEqual([...call("GetCursorMoney")], [500], "the hand keeps its money");
  target.trade.showing = true;
  call("AddTradeMoney");
  assert.deepEqual(offers, [1500]);
  assert.deepEqual([...call("GetCursorMoney")], [0]);
});
