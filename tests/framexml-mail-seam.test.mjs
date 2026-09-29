import assert from "node:assert/strict";
import test from "node:test";

// The stock MailFrame's C API over the canned mailbox (FrameXmlMailCanned.ts) and over the real
// WorldClient packet path: which events the model fires for which world edge, what each binding
// answers, and which wire request each command becomes.

const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const {
  FrameXmlMailModel, frameXmlAuctionInvoice, frameXmlAuctionSubject,
} = await import("../dist/code/browser/framexml/FrameXmlMail.js");
const {
  createCannedFrameXmlMail, frameXmlCannedMailList, FRAMEXML_CANNED_MAILBOX_GUID,
} = await import("../dist/code/browser/framexml/FrameXmlMailCanned.js");
const { createFrameXmlServices } = await import("../dist/code/browser/framexml/FrameXmlServices.js");
const {
  MAIL_AUCTION, MAIL_ERR_EQUIP_ERROR, MAIL_MADE_PERMANENT, MAIL_SEND, buildMailCreateTextItem,
} = await import("../dist/code/world/MailProtocol.js");
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
  const { model, world } = createCannedFrameXmlMail();
  const events = pump();
  model.attach(events);
  if (owned) model.owned = true;
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name]({ mail: model }, args);
  return { model, world, events, call };
}

test("the inbox answers the server's list: count, header tuple, auction subjects and invoices", () => {
  const { world, call } = mounted();
  assert.deepEqual(call("GetInboxNumItems"), [0, 0], "no mailbox, no letters");
  world.open();
  assert.deepEqual(call("GetInboxNumItems"), [4, 4]);
  assert.deepEqual(call("GetInboxHeaderInfo", 1), [
    "Interface\\Icons\\INV_Potion_54", "Interface\\Icons\\INV_Misc_Note_01", "Алистра", "Зелья для рейда",
    25_000, 0, 29.5, 2, false, false, false, true, false, 5,
  ], "packageIcon is the first item's, stationery 41 is item 9311's icon, firstItemQuantity its stack");
  const auction = call("GetInboxHeaderInfo", 2);
  assert.equal(auction[1], "Interface\\Icons\\INV_Scroll_03", "auction stationery 62 is item 21140's icon");
  assert.equal(auction[2], "Аукционный дом Альянса", "an auction letter's sender is AuctionHouse.dbc row 2");
  assert.equal(auction[3], "2589:0:1:1234:20", "the JS binding keeps the machine subject; the Lua prelude words it");
  assert.equal(auction[11], false, "auction mail cannot be answered");
  assert.deepEqual(call("WebClientMailAuctionSubject", 2), [1, "Льняной материал"]);
  assert.deepEqual(call("WebClientMailAuctionSubject", 1), []);
  assert.deepEqual(call("GetInboxHeaderInfo", 4).slice(8, 11), [true, false, false], "the COD parcel was read");
  assert.deepEqual(call("GetInboxHeaderInfo", 5), [undefined, undefined, undefined, undefined, 0, 0, 0],
    "no letter: nil text, numeric money/COD/days, which OpenMail_Update compares unguarded");
  assert.deepEqual(call("GetInboxHeaderInfo", 0).slice(4, 7), [0, 0, 0], "openMailID 0 after OpenMailFrame_OnHide");
  assert.deepEqual(call("GetInboxInvoiceInfo", 2),
    ["buyer", "Льняной материал", "Торвальд", 1500, 2000, 0, 0, 0, 0, 0]);
  assert.deepEqual(call("GetInboxInvoiceInfo", 3),
    ["seller", "Шелковый материал", "Торвальд", 12000, 15000, 600, 600, 0, 0, 0]);
  assert.deepEqual(call("GetInboxInvoiceInfo", 1), [], "a player's letter is no invoice");
  assert.deepEqual(call("GetInboxItem", 1, 2), ["Камень возвращения", "Interface\\Icons\\INV_Misc_Rune_01", 1, 1, true]);
  assert.deepEqual(call("GetInboxItem", 1, 3), []);
  assert.deepEqual(call("GetInboxItemLink", 1, 1),
    ["|cffffffff|Hitem:13446:0:0:0:0:0:0:0:0|h[Огромный флакон с лечебным зельем]|h|r"]);
  assert.deepEqual(call("InboxItemCanDelete", 1), [false], "a player's letter with money and items is returned");
  assert.deepEqual(call("InboxItemCanDelete", 2), [true], "auction mail is deleted, never returned");
  assert.deepEqual(call("InboxItemCanDelete", 4), [false], "COD mail is never deletable (MailHandler.cpp)");
});

test("the auction machine text parses exactly as AuctionHouseMgr.cpp writes it", () => {
  const letter = (subject, body) => ({ senderType: MAIL_AUCTION, subject, body });
  assert.deepEqual(frameXmlAuctionSubject(letter("2589:0:1:1234:20", "")),
    { entry: 2589, randomPropertyId: 0, response: 1, count: 20 });
  assert.equal(frameXmlAuctionSubject({ senderType: 0, subject: "2589:0:1:1234:20", body: "" }), undefined);
  assert.equal(frameXmlAuctionSubject(letter("Привет", "")), undefined);
  // SALE_PENDING: WowTime packed eta — minute 0..5 bits, hour 6..10 bits (WowTime.cpp:23-31).
  const eta = (26 << 24) | (9 << 20) | (25 << 14) | (4 << 11) | (17 << 6) | 42;
  const pending = frameXmlAuctionInvoice(letter("4306:0:6:77:1", `1F:12000:15000:600:600:3600:${eta}`));
  assert.equal(pending.type, "seller_temp_invoice");
  assert.equal(pending.playerGuid, 0x1fn);
  assert.deepEqual([pending.moneyDelay, pending.etaHour, pending.etaMinute], [3600, 17, 42]);
  assert.equal(frameXmlAuctionInvoice(letter("4306:0:3:77:1", "")), undefined, "an expired auction carries no invoice");
  assert.equal(frameXmlAuctionInvoice(letter("4306:0:2:77:1", "zz:1:2")), undefined, "a malformed body is no invoice");
});

test("GetInboxText marks a letter read once, and the letter commands become their wire requests", () => {
  const { world, call } = mounted();
  world.open();
  assert.deepEqual(call("GetInboxText", 1),
    ["Держи зелья и немного золота на ремонт. Увидимся в четверг!", "STATIONERYTEST", true, false]);
  call("GetInboxText", 1);
  call("GetInboxText", 4);
  assert.deepEqual(world.calls, [{ kind: "read", mailId: 101 }],
    "one CMSG_MAIL_MARK_AS_READ for the unread letter, none for the one already read");
  assert.equal(call("GetInboxHeaderInfo", 1)[8], true, "read at once, before the next list");
  assert.deepEqual(call("GetInboxText", 2), ["", "AUCTIONSTATIONERY", false, true],
    "an auction invoice shows its invoice, not its machine body, and cannot become a text item");
  world.calls.length = 0;
  call("TakeInboxItem", 1, 2);
  call("TakeInboxMoney", 1);
  call("TakeInboxTextItem", 1);
  call("DeleteInboxItem", 2);
  call("ReturnInboxItem", 1);
  call("ReturnInboxItem", 2);
  call("AutoLootMailItem", 1);
  call("AutoLootMailItem", 4);
  assert.deepEqual(world.calls, [
    { kind: "takeItem", mailId: 101, attachId: 9002 },
    { kind: "takeMoney", mailId: 101 },
    { kind: "copyText", mailId: 101 },
    { kind: "delete", mailId: 102 },
    { kind: "return", mailId: 101, senderGuid: 0x5001n },
    { kind: "takeMoney", mailId: 101 },
    { kind: "takeItem", mailId: 101, attachId: 9001 },
    { kind: "takeItem", mailId: 101, attachId: 9002 },
  ], "auction mail is not returnable, and a COD letter is never auto-looted");
  world.calls.length = 0;
  call("CheckInbox");
  assert.deepEqual(world.calls, [], "the world already asked for the list when the mailbox opened");
  world.deliver({ ...frameXmlCannedMailList(), totalCount: 57 });
  assert.deepEqual(call("GetInboxNumItems"), [4, 57]);
  call("CheckInbox");
  assert.deepEqual(world.calls, [{ kind: "requestList" }], "more letters wait on the server: ask again");
});

test("MAIL_SHOW fires only for the published owner, and taking ownership hands over an open mailbox", () => {
  const { model, world, events } = mounted({ owned: false });
  world.open();
  assert.deepEqual(events.names(), [], "the native window owns the mailbox until publication");
  model.owned = true;
  assert.deepEqual(events.names(), ["MAIL_SHOW", "MAIL_INBOX_UPDATE"], "an open mailbox is shown by stock at the edge");
  assert.equal(model.showing, true);
  events.events.length = 0;
  world.emit("open");
  assert.deepEqual(events.names(), [], "the same mailbox is not shown twice");
  world.closeMailbox();
  assert.deepEqual(events.names(), ["MAIL_CLOSED"]);
  assert.equal(model.showing, false);
  events.events.length = 0;
  world.emit("closed");
  assert.deepEqual(events.names(), [], "MAIL_CLOSED only once per shown mailbox");
});

test("while the native window owns the mailbox the stock VM hears nothing, and a result seen then is not replayed", () => {
  const { model, world, events } = mounted({ owned: false });
  world.open();
  world.deliver(frameXmlCannedMailList());
  world.answer({ mailId: 0, command: MAIL_SEND, error: 4 }, "Получатель не найден");
  world.answer({ mailId: 0, command: MAIL_SEND, error: 0 });
  assert.deepEqual(events.events, [], "the native #mail-message says why; the hidden MailFrame gets no list, error or success");
  model.owned = true;
  assert.deepEqual(events.names(), ["MAIL_SHOW", "MAIL_INBOX_UPDATE"], "the handover paints the list once, and no old result");
  events.events.length = 0;
  world.emit("result");
  assert.deepEqual(events.events, [], "a repeated edge over the result the native window already showed replays nothing");
  world.answer({ mailId: 0, command: MAIL_SEND, error: 4 }, "Получатель не найден");
  assert.deepEqual(events.events, [["UI_ERROR_MESSAGE", "Получатель не найден"], ["MAIL_FAILED"]], "a result for the stock window");
});

/** A pump whose clock the test moves: the metadata tick looks at most every 0.25 s. */
function clockedPump() {
  const events = pump();
  let now = 0;
  return { ...events, now: () => now, advance() { now += 1; } };
}

test("an auction invoice waits for its item and player names, then the metadata tick repaints it once", () => {
  const cached = new Map([[2589, { name: "Льняной материал", texture: "Interface\\Icons\\INV_Fabric_Linen_01", quality: 1 }]]);
  let itemArrived = false;
  const { model, world } = createCannedFrameXmlMail({ item: (entry) => (itemArrived ? cached.get(entry) : undefined) });
  const events = clockedPump();
  model.attach(events);
  model.owned = true;
  world.open();
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name]({ mail: model }, args);
  assert.deepEqual(call("GetInboxText", 2), ["", "AUCTIONSTATIONERY", false, false],
    "no invoice yet: OpenMail_Update hides OpenMailInvoiceFrame instead of keeping the last letter's");
  assert.deepEqual(call("GetInboxInvoiceInfo", 2), ["buyer"],
    "no names, so no «ITEM_PURCHASED_COLON..itemName» concatenation (MailFrame.lua:481)");
  events.events.length = 0;
  model.tick();
  events.advance();
  model.tick();
  assert.deepEqual(events.names(), [], "nothing arrived, nothing repainted");
  itemArrived = true;
  events.advance();
  model.tick();
  assert.deepEqual(events.names(), ["MAIL_INBOX_UPDATE"], "the item's name arrived: one repaint");
  assert.deepEqual(call("GetInboxText", 2)[3], true);
  assert.deepEqual(call("GetInboxInvoiceInfo", 2), ["buyer", "Льняной материал", "Торвальд", 1500, 2000, 0, 0, 0, 0, 0]);
  world.names.delete(0x5002n);
  assert.deepEqual(call("GetInboxInvoiceInfo", 2), ["buyer"], "the player's name is the other half");
  assert.deepEqual(call("GetInboxText", 2)[3], false);
});

test("the send draft takes the bag cursor, swaps, picks up, clears, and SendMail carries its GUIDs", () => {
  const { model, world, events, call } = mounted();
  world.open();
  model.setSendShowing(true);
  assert.deepEqual(call("GetSendMailItem", 1), [undefined, undefined, 0, undefined]);
  assert.deepEqual(call("GetSendMailPrice"), [30]);
  world.cursor = { guid: 0x4000_0001n, bag: 255, slot: 23 };
  events.events.length = 0;
  call("ClickSendMailItemButton", 1, false);
  assert.equal(world.cursor, undefined, "the cursor's item went into the slot");
  assert.deepEqual(events.names(), ["MAIL_SEND_INFO_UPDATE"]);
  assert.deepEqual(call("GetSendMailItem", 1), ["Огромный флакон с лечебным зельем", "Interface\\Icons\\INV_Potion_54", 5, 1]);
  assert.deepEqual(call("GetSendMailItemLink", 1),
    ["|cffffffff|Hitem:13446:0:0:0:0:0:0:0:0|h[Огромный флакон с лечебным зельем]|h|r"]);
  world.cursor = { guid: 0x4000_0002n, bag: 255, slot: 24 };
  call("ClickSendMailItemButton");
  assert.deepEqual(call("GetSendMailItem", 2)[0], "Камень возвращения", "a drop on the letter fills the first free slot");
  assert.deepEqual(call("GetSendMailPrice"), [60], "30 copper per attachment (MailHandler.cpp:119)");
  world.cursor = { guid: 0x4000_0002n, bag: 255, slot: 24 };
  call("ClickSendMailItemButton", 1, false);
  assert.equal(world.cursor, undefined, "an item already attached is not attached twice");
  assert.equal(call("GetSendMailItem", 1)[0], "Огромный флакон с лечебным зельем");
  call("ClickSendMailItemButton", 2, true);
  world.cursor = { guid: 0x4000_0002n, bag: 255, slot: 24 };
  call("ClickSendMailItemButton", 1, false);
  assert.deepEqual(world.cursor, { guid: 0x4000_0001n, bag: 255, slot: 23 }, "a filled slot swaps its item onto the cursor");
  assert.equal(call("GetSendMailItem", 1)[0], "Камень возвращения");
  assert.deepEqual(call("GetSendMailItem", 2), [undefined, undefined, 0, undefined]);
  world.cursor = undefined;
  call("ClickSendMailItemButton", 1, true);
  assert.equal(world.cursor, undefined, "a right click only takes the attachment out");
  assert.deepEqual(call("GetSendMailPrice"), [30]);
  assert.equal(model.useItem(0x4000_0001n), true, "a right-clicked bag item attaches while the send tab shows");
  assert.equal(model.attached(0x4000_0001n), true);
  call("SetSendMailMoney", 0);
  assert.deepEqual(call("SetSendMailMoney", 5000), [true]);
  call("SetSendMailCOD", 0);
  call("SendMail", "  Алистра ", "Тема", "Текст");
  assert.deepEqual(world.calls.at(-1), { kind: "send", draft: {
    target: "Алистра", subject: "Тема", body: "Текст", money: 5000, attachments: [0x4000_0001n],
  } });
  events.events.length = 0;
  world.answer({ mailId: 0, command: MAIL_SEND, error: 0 });
  assert.deepEqual(events.names(), ["MAIL_SEND_INFO_UPDATE", "MAIL_SEND_SUCCESS", "MAIL_SUCCESS"]);
  assert.deepEqual(call("GetSendMailItem", 1), [undefined, undefined, 0, undefined], "a sent letter clears the draft");
  assert.deepEqual(call("GetSendMailMoney"), [0]);
  events.events.length = 0;
  world.answer({ mailId: 0, command: MAIL_SEND, error: 4 }, "Получатель не найден");
  assert.deepEqual(events.events, [["UI_ERROR_MESSAGE", "Получатель не найден"], ["MAIL_FAILED"]]);
  events.events.length = 0;
  world.answer({ mailId: 101, command: 2, error: MAIL_ERR_EQUIP_ERROR, bagResult: 50 }, "Некуда положить предмет");
  assert.equal(events.events[0][0], "UI_ERROR_MESSAGE");
  assert.notEqual(events.events[0][1], "Некуда положить предмет", "an equip failure names the bag reason");
});

test("a muted model (the mount's gate) sends nothing and keeps the mailbox open", () => {
  const { model, world, call } = mounted();
  world.open();
  model.muted(() => {
    call("GetInboxText", 1);
    call("TakeInboxItem", 1, 1);
    call("CloseMail");
    call("SendMail", "Алистра", "Тема", "");
  });
  assert.deepEqual(world.calls, []);
  assert.equal(world.mailboxGuid, FRAMEXML_CANNED_MAILBOX_GUID);
});

test("GetSendMailItem/Price answer the native draft until the stock owner is published", () => {
  const { model, call } = mounted({ owned: false });
  const services = createFrameXmlServices({
    sendMailItems: () => [["Льняной материал", "Interface\\Icons\\INV_Fabric_Linen_01", 20, 1]],
    stableService: () => undefined, stableSlotPrice: () => undefined,
  });
  const host = { mail: model, services };
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSendMailItem(host, [1]),
    ["Льняной материал", "Interface\\Icons\\INV_Fabric_Linen_01", 20, 1]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSendMailPrice(host, []), [30]);
  model.owned = true;
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSendMailItem(host, [1]), [undefined, undefined, 0, undefined],
    "once published the stock draft is the draft");
  assert.deepEqual(call("GetNumStationeries"), [1]);
  assert.deepEqual(call("GetSelectedStationeryTexture"), ["STATIONERYTEST"]);
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

test("WorldClient emits one MAIL_STATE_CHANGED per mailbox edge and sends the create-text-item request", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await settle();
  const kinds = [];
  world.events.on("MAIL_STATE_CHANGED", ({ kind }) => kinds.push(kind));
  world.openMailbox(0x77n);
  connection.feed(OPCODES.SMSG_MAIL_LIST_RESULT, new PacketWriter().i32(0).u8(0).toUint8Array());
  await settle();
  connection.feed(OPCODES.SMSG_SEND_MAIL_RESULT, new PacketWriter().u32(9).u32(MAIL_MADE_PERMANENT).u32(0).toUint8Array());
  await settle();
  assert.equal(world.mailMessage.text, "Письмо скопировано");
  connection.feed(OPCODES.SMSG_RECEIVED_MAIL, new PacketWriter().f32(0).toUint8Array());
  await settle();
  world.copyMailText(9);
  const copy = connection.sent.at(-1);
  assert.equal(copy.opcode, OPCODES.CMSG_MAIL_CREATE_TEXT_ITEM);
  assert.deepEqual([...copy.payload], [...buildMailCreateTextItem(0x77n, 9)]);
  assert.deepEqual([...copy.payload], [0x77, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0],
    "MailCreateTextItem::Read: mailbox GUID then mail id (MailPackets.cpp:170-174)");
  const lists = connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_GET_MAIL_LIST).length;
  world.requestMailList();
  assert.equal(connection.sent.filter(({ opcode }) => opcode === OPCODES.CMSG_GET_MAIL_LIST).length, lists + 1);
  world.closeMailbox();
  assert.deepEqual(kinds, ["open", "list", "result", "received", "closed"]);
  world.copyMailText(9);
  world.requestMailList();
  assert.equal(connection.sent.at(-1).opcode, OPCODES.CMSG_GET_MAIL_LIST, "a closed mailbox sends nothing more");
  world.close();
});

test("the model reads a real WorldClient: SMSG_SHOW-less openMailbox, list and result drive the stock events", async () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  await world.loginCharacter(1n);
  await settle();
  const model = new FrameXmlMailModel({
    world: () => world, item: () => undefined, itemObject: () => undefined,
    cursorItem: () => undefined, clearCursor() {},
  });
  const events = pump();
  model.attach(events);
  model.owned = true;
  world.openMailbox(0x77n);
  assert.deepEqual(events.names(), ["MAIL_SHOW"]);
  connection.feed(OPCODES.SMSG_MAIL_LIST_RESULT, new PacketWriter().i32(0).u8(0).toUint8Array());
  await settle();
  connection.feed(OPCODES.SMSG_SEND_MAIL_RESULT, new PacketWriter().u32(0).u32(MAIL_SEND).u32(3).toUint8Array());
  await settle();
  assert.deepEqual(events.names(), ["MAIL_SHOW", "MAIL_INBOX_UPDATE", "UI_ERROR_MESSAGE", "MAIL_FAILED"]);
  FRAMEXML_SEAM_BINDINGS.CloseMail({ mail: model }, []);
  assert.equal(world.mailboxGuid, 0n);
  assert.equal(events.names().at(-1), "MAIL_CLOSED");
  model.detach();
  world.close();
});
