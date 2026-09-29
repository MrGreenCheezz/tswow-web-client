import assert from "node:assert/strict";
import test from "node:test";

// LiveWorldSeam's mail and trade wiring over a real item projection: the stock bag cursor feeds the
// send draft and the trade slots, a right-clicked bag item attaches while the send tab or a trade is
// open, and UnitName("NPC") names the trade partner.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

function fixture() {
  const player = { guid: 1n, fields: new Map() };
  const potion = { guid: 2n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446],
    [UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, 5]]) };
  const stone = { guid: 4n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 6948]]) };
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, potion.guid);
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset + 2, stone.guid);
  const sent = [];
  const events = new EventBus();
  const world = {
    events,
    state: { selfGuid: player.guid, objects: new Map([[player.guid, player], [potion.guid, potion], [stone.guid, stone]]) },
    names: new Map([[9n, "Эльмира"]]),
    itemTemplates: new Map(),
    // What LiveWorldSeam.attach reads of a world (casts in flight, the action bar, cooldowns).
    casts: new Map(), channels: new Map(), actionButtons: [], creatureTemplates: new Map(), questTemplates: new Map(),
    cooldownRemaining: () => 0,
    mailboxGuid: 0n, mail: undefined, mailResult: undefined, mailMessage: undefined,
    tradeOpen: false, tradePartnerGuid: 0n, tradePartnerAccepted: false, theirOffer: undefined,
    sendMail: (draft) => sent.push(["send", draft]),
    closeMailbox: () => sent.push(["close"]),
    useItem: (...args) => sent.push(["use", ...args]),
    offerTradeItem: (...args) => sent.push(["offer", ...args]),
    ownTradeOffer: () => ({ money: 0, spellId: 0, items: [] }),
    moveItem: (...args) => sent.push(["move", ...args]),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    itemInfo: (entry) => entry === 13446 ? { name: "Огромный флакон с лечебным зельем", quality: 1 }
      : entry === 6948 ? { name: "Камень возвращения", quality: 1 } : undefined,
  });
  const fired = [];
  seam.mail.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  seam.trade.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  return { world, seam, sent, fired, events };
}

test("the stock bag cursor fills the send draft, and SendMail sends the picked item's GUID", () => {
  const { world, seam, sent, fired, events } = fixture();
  seam.mail.owned = true;
  world.mailboxGuid = 0x77n;
  events.emit("MAIL_STATE_CHANGED", { kind: "open" });
  assert.deepEqual(fired.map(([event]) => event), ["MAIL_SHOW"]);
  call("PickupContainerItem", seam, 0, 1);
  assert.deepEqual(call("CursorHasItem", seam), [true]);
  call("ClickSendMailItemButton", seam, 1);
  assert.deepEqual(call("CursorHasItem", seam), [false], "the attachment took the cursor's item");
  assert.deepEqual(call("GetSendMailItem", seam, 1), ["Огромный флакон с лечебным зельем", undefined, 5, 1]);
  assert.match(call("GetSendMailItemLink", seam, 1)[0], /\|Hitem:13446:/, "the inventory item's own link");
  call("ClickSendMailItemButton", seam, 1);
  assert.deepEqual(call("GetCursorInfo", seam).slice(0, 2), ["item", 13446], "clicking it again picks it back up");
  call("ClickSendMailItemButton", seam, 1);
  call("SendMail", seam, "Алистра", "Тема", "");
  assert.deepEqual(sent, [["send", { target: "Алистра", subject: "Тема", body: "", money: 0, attachments: [2n] }]]);
});

test("a right-clicked bag item attaches while the send tab shows, and is used otherwise", () => {
  const { world, seam, sent, events } = fixture();
  seam.mail.owned = true;
  world.mailboxGuid = 0x77n;
  events.emit("MAIL_STATE_CHANGED", { kind: "open" });
  call("UseContainerItem", seam, 0, 2);
  assert.deepEqual(sent.map(([kind]) => kind), ["use"], "the inbox tab: an ordinary use");
  call("SetSendMailShowing", seam, true);
  call("UseContainerItem", seam, 0, 2);
  assert.equal(sent.length, 1, "the send tab: no use packet");
  assert.equal(call("GetSendMailItem", seam, 1)[0], "Камень возвращения");
});

test("attached and offered items are locked in the bags, and the carried bags repaint when that changes", () => {
  const { world, seam, events } = fixture();
  const fired = [];
  seam.attach({ fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 0 });
  try {
    seam.mail.owned = true;
    world.mailboxGuid = 0x77n;
    events.emit("MAIL_STATE_CHANGED", { kind: "open" });
    assert.equal(call("GetContainerItemInfo", seam, 0, 1)[2], undefined, "not attached: not locked");
    fired.length = 0;
    call("PickupContainerItem", seam, 0, 1);
    call("ClickSendMailItemButton", seam, 1);
    assert.equal(call("GetContainerItemInfo", seam, 0, 1)[2], true, "the attached potion is locked");
    assert.equal(call("GetContainerItemInfo", seam, 0, 2)[2], undefined);
    assert.deepEqual(fired.filter(([event]) => event === "BAG_UPDATE").map(([, id]) => id), [0, 1, 2, 3, 4]);
    call("ClickSendMailItemButton", seam, 1, true);
    assert.equal(call("GetContainerItemInfo", seam, 0, 1)[2], undefined, "taken out of the letter: unlocked");
    seam.trade.owned = true;
    world.tradeOpen = true;
    world.tradePartnerGuid = 9n;
    events.emit("TRADE_STATE_CHANGED", { kind: "status", status: 2 });
    call("UseContainerItem", seam, 0, 2);
    assert.equal(call("GetContainerItemInfo", seam, 0, 2)[2], true, "the offered hearthstone is locked");
    world.tradeOpen = false;
    events.emit("TRADE_STATE_CHANGED", { kind: "status", status: 3 });
    assert.equal(call("GetContainerItemInfo", seam, 0, 2)[2], undefined, "a closed trade releases it");
    world.tradeOpen = true;
    events.emit("TRADE_STATE_CHANGED", { kind: "status", status: 2 });
    assert.equal(call("GetContainerItemInfo", seam, 0, 2)[2], undefined, "the next trade starts with nothing offered");
  } finally {
    seam.detach();
  }
});

test("a locked bag item is neither picked up, swapped with the cursor's item, nor used", () => {
  {
    const { world, seam, sent, events } = fixture();
    seam.mail.owned = true;
    world.mailboxGuid = 0x77n;
    events.emit("MAIL_STATE_CHANGED", { kind: "open" });
    call("PickupContainerItem", seam, 0, 1);
    call("ClickSendMailItemButton", seam, 1);
    assert.equal(call("GetContainerItemInfo", seam, 0, 1)[2], true);
    call("PickupContainerItem", seam, 0, 1);
    assert.deepEqual(call("CursorHasItem", seam), [false], "the attached potion stays in the letter");
    call("UseContainerItem", seam, 0, 1);
    assert.deepEqual(sent, [], "on the inbox tab a locked item is not used either");
    call("PickupContainerItem", seam, 0, 2);
    call("PickupContainerItem", seam, 0, 1);
    assert.deepEqual(sent, [], "no swap onto the locked slot");
    assert.deepEqual(call("GetCursorInfo", seam).slice(0, 2), ["item", 6948], "the hearthstone stays on the cursor");
    call("PickupContainerItem", seam, 0, 2);
    assert.deepEqual(call("CursorHasItem", seam), [false], "dropped back on its own slot");
  }
  {
    const { world, seam, sent, events } = fixture();
    seam.trade.owned = true;
    world.tradeOpen = true;
    world.tradePartnerGuid = 9n;
    events.emit("TRADE_STATE_CHANGED", { kind: "status", status: 2 });
    call("UseContainerItem", seam, 0, 2);
    assert.deepEqual(sent, [["offer", 0, 255, 24]]);
    call("PickupContainerItem", seam, 0, 2);
    assert.deepEqual(call("CursorHasItem", seam), [false], "the offered hearthstone cannot be offered a second time");
  }
});

test("an open trade: the cursor offers into a slot, a right click offers, UnitName(\"NPC\") is the partner", () => {
  const { world, seam, sent, fired, events } = fixture();
  seam.trade.owned = true;
  assert.deepEqual(call("UnitName", seam, "npc"), []);
  world.tradeOpen = true;
  world.tradePartnerGuid = 9n;
  events.emit("TRADE_STATE_CHANGED", { kind: "status", status: 2 });
  assert.deepEqual(fired.map(([event]) => event), ["TRADE_SHOW"]);
  assert.deepEqual(call("UnitName", seam, "NPC"), ["Эльмира"]);
  assert.deepEqual(call("UnitExists", seam, "npc"), [true]);
  call("PickupContainerItem", seam, 0, 1);
  call("ClickTradeButton", seam, 3);
  assert.deepEqual(sent, [["offer", 2, 255, 23]], "stock slot 3 is wire slot 2; the item's wire bag/slot");
  assert.deepEqual(call("CursorHasItem", seam), [false]);
  call("UseContainerItem", seam, 0, 2);
  assert.deepEqual(sent.at(-1), ["offer", 0, 255, 24], "the first free tradable slot");
});
