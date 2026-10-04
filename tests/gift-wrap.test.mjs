// Plan item 2.05, slice E: gift wrapping through the stock seam, in Wow.exe's order — UseContainerItem
// on wrapping paper (ITEM_FLAG_IS_WRAPPER) arms it (Item::Use 0x00708c20 → 0x006d67e0, the paper
// locked), PickupContainerItem with an empty hand wraps the clicked bag item (0x005d7ff0 → 0x006dcf20:
// CMSG_WRAP_ITEM, four bytes, ItemHandler.cpp:886-893) and lets the paper go, ClearCursor lets it go
// (0x00519280 → 0x006cef80); a wrapped gift (ITEM_FIELD_FLAGS 0x8) opens instead.
import assert from "node:assert/strict";
import test from "node:test";

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { buildWrapItem } = await import("../dist/code/world/GiftWrapProtocol.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const wrap = await import("../dist/code/browser/game/GiftWrap.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const PAPER = 0x4000_0000_0000_0401n;
const WATCH = 0x4000_0000_0000_0402n;
const GIFT = 0x4000_0000_0000_0403n;
const PAPER_ENTRY = 5042;
const WATCH_ENTRY = 2820;
const GIFT_ENTRY = 5043;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

function template(entry, name, flags) {
  return {
    entry, found: true, name, quality: 1, itemClass: 0, subClass: 0, flags, inventoryType: 0,
    bonding: 0, stackable: 1, bagFamily: 0, spells: [], itemLevel: 10, requiredLevel: 1, containerSlots: 0,
    maxDurability: 0, pageText: 0, startQuest: 0,
  };
}

function fixture() {
  wrap.cancelGiftWrap();
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map();
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), PAPER);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 2, WATCH);
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1") + 4, GIFT);
  const object = (guid, typeId, entries) => ({
    guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries),
  });
  state.objects.set(PLAYER, { ...object(PLAYER, 4, []), fields });
  state.objects.set(PAPER, object(PAPER, 1, [[offset("OBJECT_FIELD_ENTRY"), PAPER_ENTRY], [offset("ITEM_FIELD_STACK_COUNT"), 5]]));
  state.objects.set(WATCH, object(WATCH, 1, [[offset("OBJECT_FIELD_ENTRY"), WATCH_ENTRY]]));
  state.objects.set(GIFT, object(GIFT, 1, [[offset("OBJECT_FIELD_ENTRY"), GIFT_ENTRY], [offset("ITEM_FIELD_FLAGS"), 0x8]]));
  state.selfGuid = PLAYER;
  world.itemTemplates.set(PAPER_ENTRY, template(PAPER_ENTRY, "Оберточная бумага", 0x200));
  world.itemTemplates.set(WATCH_ENTRY, template(WATCH_ENTRY, "Часы", 0));
  world.itemTemplates.set(GIFT_ENTRY, template(GIFT_ENTRY, "Подарок", 0x200 | 0x4));
  const seam = new LiveWorldSeam({
    world: () => world, store: () => new WorldStore(world.state), spell: () => undefined, monotonic: () => 1000,
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  seam.attach({ now: () => 100, fire: () => 1 });
  sent.length = 0; // attach asks for the calendar; only this test's packets count
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  const packets = (opcode) => sent.filter((packet) => packet.opcode === opcode);
  return { world, seam, call, sent, packets };
}

test("CMSG_WRAP_ITEM is the paper's bag and slot, then the item's", () => {
  assert.deepEqual([...buildWrapItem(255, 23, 19, 4)], [255, 23, 19, 4]);
});

test("paper arms, locks, and the next empty-hand click on a bag item wraps it", () => {
  const { seam, call, sent, packets } = fixture();
  call("UseContainerItem", 0, 1);
  assert.deepEqual(sent, [], "using the paper sends nothing");
  assert.equal(call("GetContainerItemInfo", 0, 1)[2], true, "the waiting paper is locked");
  call("UseContainerItem", 0, 1);
  assert.deepEqual(sent, [], "a locked paper is not used again");
  call("PickupContainerItem", 0, 2);
  assert.deepEqual(packets(OPCODES.CMSG_WRAP_ITEM).map((packet) => packet.payload), [[255, 23, 255, 24]]);
  assert.equal(call("GetContainerItemInfo", 0, 1)[2], undefined, "the paper is let go");
  assert.equal(call("CursorHasItem")[0], false, "the item was not picked up");
  call("PickupContainerItem", 0, 2);
  assert.equal(packets(OPCODES.CMSG_WRAP_ITEM).length, 1, "one wrap per paper use");
  seam.detach();
});

test("ClearCursor lets the paper go; a locked target keeps it waiting; a wrapped gift opens", () => {
  const { seam, call, packets } = fixture();
  call("UseContainerItem", 0, 1);
  call("ClearCursor");
  call("PickupContainerItem", 0, 2);
  assert.equal(packets(OPCODES.CMSG_WRAP_ITEM).length, 0);
  call("ClearCursor");

  call("UseContainerItem", 0, 1);
  call("PickupContainerItem", 0, 1);
  assert.equal(packets(OPCODES.CMSG_WRAP_ITEM).length, 0, "the paper itself is locked: nothing");
  assert.equal(call("GetContainerItemInfo", 0, 1)[2], true, "and it keeps waiting");
  call("ClearCursor");

  call("UseContainerItem", 0, 3);
  assert.equal(packets(OPCODES.CMSG_OPEN_ITEM).length, 1, "a wrapped gift opens (CMSG_OPEN_ITEM)");
  assert.equal(call("GetContainerItemInfo", 0, 3)[2], undefined);
  seam.detach();
});

test("the wrap names the paper where it is now, and sends nothing once the paper object is gone (0x006dcf20)", () => {
  const { world, call, packets } = fixture();
  call("UseContainerItem", 0, 1);
  // The paper moves to backpack slot 4 (the realm can move a stack the client does not drag).
  const player = world.state.objects.get(PLAYER).fields;
  const pack = offset("PLAYER_FIELD_PACK_SLOT_1");
  setGuid(player, pack, 0n);
  setGuid(player, pack + 6, PAPER);
  call("PickupContainerItem", 0, 2);
  assert.deepEqual(packets(OPCODES.CMSG_WRAP_ITEM).map((packet) => packet.payload), [[255, 23 + 3, 255, 24]]);

  // Armed again, then the paper object goes away: 0x006dcf20 finds no paper and does nothing.
  call("UseContainerItem", 0, 4);
  world.state.objects.delete(PAPER);
  setGuid(player, pack + 6, 0n);
  call("PickupContainerItem", 0, 2);
  assert.equal(packets(OPCODES.CMSG_WRAP_ITEM).length, 1, "no paper object, no packet");
  assert.equal(call("CursorHasItem")[0], false, "the click was the wrap's, not a pickup");
  assert.notEqual(wrap.pendingGiftWrap(world), undefined, "the pending paper is not let go by it");
  call("ClearCursor");
});

test("Escape and a right click on the world let the waiting paper go (0x0051fa50, 0x0051fb00)", async () => {
  const { installFrameXmlCursorDom } = await import("../dist/code/browser/framexml/FrameXmlCursorDom.js");
  const { world, seam, call, packets } = fixture();
  const listeners = new Map();
  const doc = { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener() {} };
  const cleanup = installFrameXmlCursorDom(doc, seam.cursor, { setCursorPicture() {} });
  const worldTarget = { closest: () => null };
  const event = (extra) => {
    const state = { prevented: false, stopped: false };
    return { state, event: { target: worldTarget, preventDefault() { state.prevented = true; }, stopImmediatePropagation() { state.stopped = true; }, ...extra } };
  };

  call("UseContainerItem", 0, 1);
  const left = event({ button: 0 });
  listeners.get("mousedown")(left.event);
  assert.notEqual(wrap.pendingGiftWrap(world), undefined, "a left click on the world keeps it (0x0051fb00 is the right button's)");
  listeners.get("mousedown")(event({ button: 2 }).event);
  assert.equal(wrap.pendingGiftWrap(world), undefined, "a right click on the world lets it go");
  call("PickupContainerItem", 0, 2);
  assert.equal(packets(OPCODES.CMSG_WRAP_ITEM).length, 0);
  call("ClearCursor");

  call("UseContainerItem", 0, 1);
  const escape = event({ key: "Escape" });
  listeners.get("keydown")(escape.event);
  assert.equal(wrap.pendingGiftWrap(world), undefined, "Escape lets it go…");
  assert.deepEqual([escape.state.prevented, escape.state.stopped], [true, true], "…and goes no further (no game menu)");
  const idle = event({ key: "Escape" });
  listeners.get("keydown")(idle.event);
  assert.equal(idle.state.stopped, false, "with nothing waiting Escape passes on");
  call("ClearCursor");
  cleanup();
  seam.detach();
});
