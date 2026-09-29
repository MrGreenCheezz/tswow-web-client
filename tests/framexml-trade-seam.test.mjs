import assert from "node:assert/strict";
import test from "node:test";

// The stock TradeFrame's C API over the canned partner (FrameXmlTradeCanned.ts) and over the real
// WorldClient packet path: which TRADE_* events fire for which edge, what the slot getters answer, and
// which wire request each stock command becomes.

const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FrameXmlTradeModel } = await import("../dist/code/browser/framexml/FrameXmlTrade.js");
const {
  createCannedFrameXmlTrade, frameXmlCannedTradeItem, FRAMEXML_CANNED_TRADE_PARTNER,
} = await import("../dist/code/browser/framexml/FrameXmlTradeCanned.js");
const {
  TRADE_STATUS_BACK_TO_TRADE, TRADE_STATUS_OPEN_WINDOW, TRADE_STATUS_TRADE_ACCEPT, TRADE_STATUS_TRADE_CANCELED,
  TRADE_STATUS_TRADE_COMPLETE,
} = await import("../dist/code/world/TradeProtocol.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");

function pump() {
  const events = [];
  return {
    events,
    fire(event, ...args) { events.push([event, ...args]); return 1; },
    now: () => 0,
    names: () => events.map(([event]) => event),
  };
}

function mounted({ owned = true } = {}) {
  const { model, world } = createCannedFrameXmlTrade();
  const events = pump();
  model.attach(events);
  if (owned) model.owned = true;
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name]({ trade: model }, args);
  return { model, world, events, call };
}

test("TRADE_SHOW fires only for the published owner; the ownership edge hands an open trade over", () => {
  const { model, world, events } = mounted({ owned: false });
  world.open();
  assert.deepEqual(events.names(), [], "the native window owns the trade until publication");
  model.owned = true;
  assert.deepEqual(events.names(), ["TRADE_SHOW"]);
  assert.equal(model.partnerName(), "Эльмира", "UnitName(\"NPC\") is the partner while the trade is open");
  world.status(TRADE_STATUS_TRADE_COMPLETE, "Обмен завершён");
  assert.deepEqual(events.names(), ["TRADE_SHOW", "TRADE_CLOSED"]);
  assert.equal(model.partnerName(), undefined);
});

test("both offers answer the stock getters and fire one edge per changed slot and side", () => {
  const { world, events, call } = mounted();
  world.open();
  events.events.length = 0;
  world.partnerOffers(12_345, [frameXmlCannedTradeItem(0, 2589, 20), { ...frameXmlCannedTradeItem(6, 4306, 10), enchantId: 1887 }]);
  assert.deepEqual(events.events, [["TRADE_TARGET_ITEM_CHANGED", 1], ["TRADE_TARGET_ITEM_CHANGED", 7], ["TRADE_MONEY_CHANGED"]]);
  assert.deepEqual(call("GetTradeTargetItemInfo", 1),
    ["Льняной материал", "Interface\\Icons\\INV_Fabric_Linen_01", 20, 1, true, undefined]);
  assert.deepEqual(call("GetTradeTargetItemInfo", 2), []);
  assert.deepEqual(call("GetTradeTargetItemLink", 7),
    ["|cffffffff|Hitem:4306:1887:0:0:0:0:0:0:0|h[Шелковый материал]|h|r"], "SendUpdateTrade's enchant rides the link");
  assert.deepEqual(call("GetTargetTradeMoney"), [12_345]);
  events.events.length = 0;
  world.partnerOffers(12_345, [frameXmlCannedTradeItem(0, 2589, 20)]);
  assert.deepEqual(events.events, [["TRADE_TARGET_ITEM_CHANGED", 7]], "only the slot that moved");
});

test("ClickTradeButton offers the cursor's item, swaps, picks back up, and a right click only clears", () => {
  const { world, events, call } = mounted();
  world.open();
  world.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
  events.events.length = 0;
  call("ClickTradeButton", 1);
  assert.deepEqual(world.calls, [{ kind: "offer", tradeSlot: 0, bag: 255, slot: 23 }], "stock slot 1 is wire slot 0");
  assert.equal(world.cursor, undefined);
  assert.deepEqual(events.names(), ["TRADE_PLAYER_ITEM_CHANGED"]);
  assert.deepEqual(events.events[0], ["TRADE_PLAYER_ITEM_CHANGED", 1]);
  assert.deepEqual(call("GetTradePlayerItemInfo", 1),
    ["Огромный флакон с лечебным зельем", "Interface\\Icons\\INV_Potion_54", 5, 1, undefined]);
  world.cursor = { guid: 0x4000_0002n, bag: 255, slot: 24 };
  call("ClickTradeButton", 1);
  assert.deepEqual(world.calls.at(-1), { kind: "offer", tradeSlot: 0, bag: 255, slot: 24 });
  assert.deepEqual(world.cursor, { guid: 0x4000_0001n, bag: 255, slot: 23 }, "the replaced item is back on the cursor");
  world.cursor = undefined;
  call("ClickTradeButton", 1);
  assert.deepEqual(world.calls.at(-1), { kind: "clear", tradeSlot: 0 });
  assert.deepEqual(world.cursor, { guid: 0x4000_0002n, bag: 255, slot: 24 }, "an empty cursor picks the offer back up");
  call("ClickTradeButton", 2);
  assert.deepEqual(world.calls.at(-1), { kind: "offer", tradeSlot: 1, bag: 255, slot: 24 });
  call("ClickTradeButton", 2, true);
  assert.deepEqual(world.calls.at(-1), { kind: "clear", tradeSlot: 1 });
  assert.equal(world.cursor, undefined, "a right click does not pick it up");
  const calls = world.calls.length;
  call("ClickTradeButton", 3);
  assert.equal(world.calls.length, calls, "an empty slot with an empty cursor does nothing");
});

test("money is sent only when it changes, and the accept pair follows AcceptTrade and the server", () => {
  const { world, events, call } = mounted();
  world.open();
  call("SetTradeMoney", 0);
  assert.deepEqual(world.calls, [], "TradeFrame_OnShow's SetTradeMoney(0) sends nothing");
  call("SetTradeMoney", 5000);
  assert.deepEqual(world.calls, [{ kind: "gold", copper: 5000 }]);
  assert.deepEqual(call("GetPlayerTradeMoney"), [5000]);
  assert.equal(events.names().includes("PLAYER_TRADE_MONEY"), true);
  events.events.length = 0;
  call("AcceptTrade");
  assert.deepEqual(world.calls.at(-1), { kind: "accept" });
  assert.deepEqual(events.events, [["TRADE_ACCEPT_UPDATE", 1, 0]]);
  world.status(TRADE_STATUS_TRADE_ACCEPT);
  assert.deepEqual(events.events.at(-1), ["TRADE_ACCEPT_UPDATE", 1, 1]);
  world.status(TRADE_STATUS_BACK_TO_TRADE);
  assert.deepEqual(events.events.at(-1), ["TRADE_ACCEPT_UPDATE", 0, 0], "BACK_TO_TRADE clears both sides");
  call("AcceptTrade");
  call("CancelTradeAccept");
  assert.deepEqual(world.calls.slice(-2), [{ kind: "accept" }, { kind: "unaccept" }]);
  assert.deepEqual(events.events.at(-1), ["TRADE_ACCEPT_UPDATE", 0, 0]);
  call("CloseTrade");
  assert.deepEqual(world.calls.at(-1), { kind: "cancel" });
  assert.equal(events.names().at(-1), "TRADE_CLOSED");
});

test("a right-clicked bag item goes into the first free tradable slot; a muted model sends nothing", () => {
  const { model, world, call } = mounted();
  world.open();
  assert.equal(model.useItem(0x4000_0001n), true);
  assert.deepEqual(world.calls, [{ kind: "offer", tradeSlot: 0, bag: 255, slot: 23 }]);
  assert.equal(model.offered(0x4000_0001n), true, "the bags show it locked");
  assert.equal(model.useItem(0x4000_0001n), true);
  assert.equal(world.calls.length, 1, "an offered item is not offered twice");
  model.muted(() => {
    call("SetTradeMoney", 100);
    call("CloseTrade");
    call("AcceptTrade");
    call("ClickTradeButton", 2);
  });
  assert.equal(world.calls.length, 1);
  assert.equal(world.tradeOpen, true);
});

test("an offered item dropped on another trade slot stays where it is", () => {
  const { model, world, events, call } = mounted();
  world.open();
  world.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
  call("ClickTradeButton", 1);
  world.cursor = { guid: 0x4000_0002n, bag: 255, slot: 24 };
  call("ClickTradeButton", 2);
  const calls = world.calls.length;
  events.events.length = 0;
  world.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
  call("ClickTradeButton", 2);
  assert.equal(world.calls.length, calls, "no second SET_TRADE_ITEM for it (TradeHandler would cancel the trade)");
  assert.equal(world.cursor, undefined, "the drop is taken back; the hearthstone is not swapped onto the cursor");
  assert.deepEqual([model.offered(0x4000_0001n), model.offered(0x4000_0002n)], [true, true]);
  assert.equal(call("GetTradePlayerItemInfo", 2)[0], "Камень возвращения", "slot 2 still holds what the realm holds");
  assert.deepEqual(events.events, []);
});

/** A pump whose clock the test moves: the metadata tick looks at most every 0.25 s. */
function clockedPump() {
  const events = pump();
  let now = 0;
  return { ...events, now: () => now, advance() { now += 1; } };
}

test("item names arriving after an accept repaint the window and then both accepts", () => {
  let arrived = false;
  const names = new Map([[2589, { name: "Льняной материал", texture: "Interface\\Icons\\INV_Fabric_Linen_01", quality: 1 }]]);
  const { model, world } = createCannedFrameXmlTrade({ item: (entry) => (arrived ? names.get(entry) : undefined) });
  const events = clockedPump();
  model.attach(events);
  model.owned = true;
  world.open();
  world.partnerOffers(0, [frameXmlCannedTradeItem(0, 2589, 20)]);
  model.tick();
  FRAMEXML_SEAM_BINDINGS.AcceptTrade({ trade: model }, []);
  world.status(TRADE_STATUS_TRADE_ACCEPT);
  events.events.length = 0;
  arrived = true;
  events.advance();
  model.tick();
  assert.deepEqual(events.events, [["TRADE_UPDATE"], ["TRADE_ACCEPT_UPDATE", 1, 1]],
    "TradeFrame_Update hides the highlights and re-enables the button; the realm still holds both accepts");
  events.events.length = 0;
  events.advance();
  model.tick();
  assert.deepEqual(events.events, [], "one repaint per arrival");
});

test("TRADE_SHOW paints what is there: the first tick after a handover leaves the partner's accept alone", () => {
  const { model, world, events } = mounted({ owned: false });
  world.open();
  world.partnerOffers(0, [frameXmlCannedTradeItem(0, 2589, 20)]);
  world.status(TRADE_STATUS_TRADE_ACCEPT);
  model.owned = true;
  assert.deepEqual(events.events, [["TRADE_SHOW"], ["TRADE_ACCEPT_UPDATE", 0, 1]]);
  model.tick();
  assert.deepEqual(events.events.length, 2, "no TRADE_UPDATE erasing the highlight just painted");
});

test("a trade that closes with the player's gold untraded repaints the bags' gold on the next tick", () => {
  const { model, world, events, call } = mounted();
  world.open();
  call("SetTradeMoney", 5000);
  events.events.length = 0;
  world.status(TRADE_STATUS_TRADE_CANCELED, "Обмен отменен");
  assert.deepEqual(events.events, [["TRADE_CLOSED"]]);
  assert.deepEqual(call("GetPlayerTradeMoney"), [0]);
  model.tick();
  assert.deepEqual(events.names(), ["TRADE_CLOSED", "PLAYER_TRADE_MONEY"],
    "MoneyTypeInfo[\"PLAYER\"] no longer subtracts the 5000 copper (MoneyFrame.lua:19)");
  model.tick();
  assert.equal(events.events.length, 2, "once");
  for (const [end, expected] of [
    [() => call("CloseTrade"), ["TRADE_CLOSED", "PLAYER_TRADE_MONEY"]],
    [() => world.status(TRADE_STATUS_TRADE_COMPLETE), ["TRADE_CLOSED"]],
  ]) {
    world.open();
    call("SetTradeMoney", 700);
    events.events.length = 0;
    end();
    model.tick();
    assert.deepEqual(events.names(), expected, "a completed trade moved the gold: the coinage update's PLAYER_MONEY repaints");
  }
  world.open();
  events.events.length = 0;
  world.status(TRADE_STATUS_TRADE_CANCELED);
  model.tick();
  assert.deepEqual(events.names(), ["TRADE_CLOSED"], "no gold offered, nothing to repaint");
});

test("a partner item without metadata shows SendUpdateTrade's display icon and count, not an empty slot", () => {
  // Synthetic display id and icon: the resolver is the loot host's ItemDisplayInfo lookup in the live seam.
  const bare = createCannedFrameXmlTrade({
    item: () => undefined,
    displayIcon: (displayId) => (displayId === 4242 ? "icon:4242" : undefined),
  });
  const events = pump();
  bare.model.attach(events);
  bare.model.owned = true;
  bare.world.open();
  bare.world.partnerOffers(0, [{ ...frameXmlCannedTradeItem(0, 2589, 20), displayId: 4242 }, frameXmlCannedTradeItem(1, 4306, 10)]);
  const target = (name, id) => FRAMEXML_SEAM_BINDINGS[name]({ trade: bare.model }, [id]);
  assert.deepEqual(target("GetTradeTargetItemInfo", 1), [undefined, "icon:4242", 20, 1, true, undefined],
    "the icon and the stack at once; a nil name paints white and the tick's TRADE_UPDATE adds it");
  assert.deepEqual(target("GetTradeTargetItemInfo", 2), [], "no display id resolved: nothing to paint");
  assert.deepEqual(target("GetTradeTargetItemLink", 1), [], "no name, no link");
});

// ---- the WorldClient side -------------------------------------------------------------------------

function fakeConnection() {
  const queue = [{
    opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(4).toUint8Array(),
  }];
  let pending;
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { pending = resolve; });
    },
    feed(opcode, payload) {
      const packet = { opcode, payload };
      if (!pending) { queue.push(packet); return; }
      const resolve = pending;
      pending = undefined;
      resolve(packet);
    },
    close() {},
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const status = (code) => {
  const writer = new PacketWriter().u32(code);
  if (code === TRADE_STATUS_OPEN_WINDOW) writer.u32(0);
  return writer.toUint8Array();
};

/** SendUpdateTrade: trader flag, three words, gold, spell, then seven 1+72-byte slots. */
function extended(trader, money, itemId) {
  const writer = new PacketWriter().u8(trader ? 1 : 0).u32(0).u32(7).u32(7).u32(money).u32(0);
  for (let slot = 0; slot < 7; slot += 1) {
    writer.u8(slot).u32(slot === 0 ? itemId : 0).u32(0).u32(slot === 0 ? 3 : 0);
    for (let word = 0; word < 16; word += 1) writer.u32(0);
  }
  return writer.toUint8Array();
}

test("WorldClient emits TRADE_STATE_CHANGED per status, offer and local change; CancelTradeAccept is UNACCEPT", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await settle();
  const changes = [];
  world.events.on("TRADE_STATE_CHANGED", (change) => changes.push(change));
  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_OPEN_WINDOW));
  await settle();
  connection.feed(OPCODES.SMSG_TRADE_STATUS_EXTENDED, extended(true, 700, 2589));
  await settle();
  world.offerTradeGold(50);
  world.unacceptTrade();
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_UNACCEPT_TRADE);
  assert.equal(connection.sent.at(-1).payload.length, 0, "HandleUnacceptTradeOpcode reads no body");
  world.cancelTrade();
  assert.deepEqual(changes, [
    { kind: "status", status: TRADE_STATUS_OPEN_WINDOW },
    { kind: "offer", trader: true },
    { kind: "local" },
    { kind: "local" },
  ]);
  world.unacceptTrade();
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_CANCEL_TRADE, "no UNACCEPT once the trade is gone");
  world.close();
});

test("the model reads a real WorldClient: OPEN_WINDOW shows stock, the partner's packet fills its slot", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await settle();
  const model = new FrameXmlTradeModel({
    world: () => world,
    item: (entry) => entry === 2589 ? { name: "Льняной материал", quality: 1 } : undefined,
    cursorItem: () => undefined, clearCursor() {},
  });
  const events = pump();
  model.attach(events);
  model.owned = true;
  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_OPEN_WINDOW));
  await settle();
  connection.feed(OPCODES.SMSG_TRADE_STATUS_EXTENDED, extended(true, 700, 2589));
  await settle();
  assert.deepEqual(events.events, [["TRADE_SHOW"], ["TRADE_TARGET_ITEM_CHANGED", 1], ["TRADE_MONEY_CHANGED"]]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetTradeTargetItemInfo({ trade: model }, [1]),
    ["Льняной материал", undefined, 3, 1, true, undefined]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetTargetTradeMoney({ trade: model }, []), [700]);
  FRAMEXML_SEAM_BINDINGS.CloseTrade({ trade: model }, []);
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_CANCEL_TRADE);
  assert.equal(events.names().at(-1), "TRADE_CLOSED");
  assert.equal(FRAMEXML_CANNED_TRADE_PARTNER, 0x5004n);
  model.detach();
  world.close();
});

test("WorldClient reports TRADE_COMPLETE after its own close edge; the model still tells completion from cancel", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await settle();
  const model = new FrameXmlTradeModel({ world: () => world, item: () => undefined, cursorItem: () => undefined, clearCursor() {} });
  const events = pump();
  model.attach(events);
  model.owned = true;
  for (const [end, expected] of [[TRADE_STATUS_TRADE_COMPLETE, []], [TRADE_STATUS_TRADE_CANCELED, ["PLAYER_TRADE_MONEY"]]]) {
    connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_OPEN_WINDOW));
    await settle();
    FRAMEXML_SEAM_BINDINGS.SetTradeMoney({ trade: model }, [900]);
    events.events.length = 0;
    connection.feed(OPCODES.SMSG_TRADE_STATUS, status(end));
    await settle();
    model.tick();
    assert.deepEqual(events.names(), ["TRADE_CLOSED", ...expected]);
  }
  model.detach();
  world.close();
});

test("an item the native window offered before the handover is refused by WorldClient; the model records nothing", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await settle();
  let cursor;
  const picked = [];
  const model = new FrameXmlTradeModel({
    world: () => world,
    item: () => ({ name: "Льняной материал", quality: 1 }),
    cursorItem: () => cursor,
    clearCursor: () => { cursor = undefined; },
    pickupItem: (guid) => picked.push(guid),
    itemPosition: (guid) => (guid === 0xa1n ? { bag: 255, slot: 23 } : undefined),
  });
  const events = pump();
  model.attach(events);
  connection.feed(OPCODES.SMSG_TRADE_STATUS, status(TRADE_STATUS_OPEN_WINDOW));
  await settle();
  assert.equal(world.offerTradeItem(0, 255, 23), true, "the native window's offer went out");
  model.owned = true;
  const offers = () => connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_SET_TRADE_ITEM).length;
  const sent = offers();
  events.events.length = 0;
  cursor = { guid: 0xa1n, bag: 255, slot: 23 };
  FRAMEXML_SEAM_BINDINGS.ClickTradeButton({ trade: model }, [2]);
  assert.equal(offers(), sent, "WorldClient sent nothing: TradeHandler would cancel the whole trade");
  assert.equal(model.offered(0xa1n), false, "not recorded as the stock offer of slot 2");
  assert.deepEqual(cursor, { guid: 0xa1n, bag: 255, slot: 23 }, "nothing moved: it stays on the cursor");
  assert.deepEqual(picked, [], "nothing was replaced, so nothing is picked up");
  assert.deepEqual(events.events, [["UI_ERROR_MESSAGE", "Этот предмет уже предложен в обмен"]]);
  assert.equal(model.useItem(0xa1n), true, "a bag right-click is consumed");
  assert.equal(offers(), sent, "and refused the same way");
  assert.equal(model.offered(0xa1n), false);
  assert.equal(events.events.length, 2);
  model.detach();
  world.close();
});
