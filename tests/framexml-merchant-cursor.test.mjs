// Plan item 3.23 slice E (lane L1, 03.10): `PickupMerchantItem` and the merchant row on the cursor.
// Wow.exe 12340: 0x005853a0 sells a held bag item (0x006d2d40, CMSG_SELL_ITEM; a split part smaller than
// its stack stays held), or puts the listed row on the cursor (0x00520d30: type 5, CURSOR_UPDATE) and
// lets it go when that item is held already; anything else lets go. GetCursorInfo (0x00515200) answers
// "merchant", index; CursorHasItem (0x00515100) is false. PickupContainerItem (0x005d7ff0) and
// PickupInventoryItem (0x005e85d0) buy the row into the clicked place — CMSG_BUY_ITEM_IN_SLOT
// (0x006d2ea0; ItemHandler.cpp:556-596: vendor guid, item, list slot, container guid, u8 slot, u32 count).
import assert from "node:assert/strict";
import test from "node:test";

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { buildBuyItemInSlot } = await import("../dist/code/world/VendorSlotProtocol.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const merchant = await import("../dist/code/browser/framexml/FrameXmlMerchantCursor.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const VENDOR = 0xf130_0000_0000_0042n;
const BREAD = 0x4000_0000_0000_0801n;
const BAG = 0x4000_0000_0000_0802n;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

const object = (guid, typeId, entries = []) => ({
  guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries),
});

function row(slot, itemId) {
  return { slot, itemId, displayId: 0, leftInStock: -1, price: 10, maxDurability: 0, buyCount: 1, extendedCost: 0 };
}

function fixture() {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload: [...payload] }); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map();
  setGuid(fields, offset("PLAYER_FIELD_PACK_SLOT_1"), BREAD);
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD") + 19 * 2, BAG);
  state.objects.set(PLAYER, { ...object(PLAYER, 4), fields });
  state.objects.set(BREAD, object(BREAD, 1, [[offset("OBJECT_FIELD_ENTRY"), 4540], [offset("ITEM_FIELD_STACK_COUNT"), 5]]));
  state.objects.set(BAG, object(BAG, 2, [[offset("OBJECT_FIELD_ENTRY"), 4496], [offset("CONTAINER_FIELD_NUM_SLOTS"), 4]]));
  state.selfGuid = PLAYER;
  world.vendor = { guid: VENDOR, items: [row(1, 159), row(2, 4540), row(3, 0)] };
  world.vendor.items[2].slot = 0;
  const packets = (opcode) => sent.filter((packet) => packet.opcode === opcode);
  return { world, sent, packets };
}

function withSeam(run) {
  const setup = fixture();
  const seam = new LiveWorldSeam({
    world: () => setup.world, store: () => new WorldStore(setup.world.state), spell: () => undefined,
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const events = [];
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  seam.attach({ now: () => 100, fire(event, ...args) { events.push([event, ...args]); return 1; } });
  setup.sent.length = 0;
  const result = run({ ...setup, seam, events, call });
  // An async case keeps the seam attached until it is done: the cursor's events go out in a microtask.
  if (result && typeof result.then === "function") return result.finally(() => seam.detach());
  seam.detach();
  return result;
}

/** CMSG_BUY_ITEM_IN_SLOT read back in ItemHandler.cpp:563's order. */
function buyInSlot(payload) {
  const reader = new PacketReader(Uint8Array.from(payload));
  const read = { vendor: reader.u64(), item: reader.u32(), slot: reader.u32(), bag: reader.u64(), bagSlot: reader.u8(), count: reader.u32() };
  reader.assertFinished();
  return read;
}

test("CMSG_BUY_ITEM_IN_SLOT: vendor, item, list slot, container guid, u8 slot, u32 count", () => {
  assert.deepEqual(buyInSlot(buildBuyItemInSlot(VENDOR, 159, 1, PLAYER, 25, 1)),
    { vendor: VENDOR, item: 159, slot: 1, bag: PLAYER, bagSlot: 25, count: 1 });
  assert.equal(buildBuyItemInSlot(1n, 2, 3, 4n, 5, 6).length, 8 + 4 + 4 + 8 + 1 + 4);
});

test("PickupMerchantItem puts the listed row on the cursor as \"merchant\", index; the same row again lets go", async () => {
  await withSeam(async ({ call, events }) => {
    call("PickupMerchantItem", 1);
    assert.deepEqual(call("GetCursorInfo"), ["merchant", 1]);
    assert.deepEqual(call("CursorHasItem"), [false], "type 5 is no item (0x00515100)");
    await Promise.resolve();
    assert.ok(events.some(([event]) => event === "CURSOR_UPDATE"));
    assert.equal(events.some(([event]) => event === "ACTIONBAR_SHOWGRID"), false, "no action-bar grid for a row");
    call("PickupMerchantItem", "1");
    assert.deepEqual(call("GetCursorInfo"), [], "the held item again: ClearCursor");
    call("PickupMerchantItem", 2);
    call("PickupMerchantItem", 1);
    assert.deepEqual(call("GetCursorInfo"), ["merchant", 1], "another row replaces it");
    call("PickupMerchantItem", 3);
    assert.deepEqual(call("GetCursorInfo"), [], "a row without a list slot: let go");
    call("PickupMerchantItem", 2);
    call("PickupMerchantItem", 0);
    assert.deepEqual(call("GetCursorInfo"), [], "MerchantFrame's OnMouseUp: PickupMerchantItem(0) lets go");
  });
});

test("dropped on a backpack, bag or paper-doll slot the row is bought there and the hand lets go", () => {
  withSeam(({ call, packets }) => {
    call("PickupMerchantItem", 2);
    call("PickupContainerItem", 0, 3);
    const backpack = packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT).map((packet) => buyInSlot(packet.payload));
    assert.deepEqual(backpack, [{ vendor: VENDOR, item: 4540, slot: 2, bag: PLAYER, bagSlot: 25, count: 1 }]);
    assert.deepEqual(call("GetCursorInfo"), []);
    call("PickupMerchantItem", 1);
    call("PickupContainerItem", 1, 2);
    assert.deepEqual(buyInSlot(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT)[1].payload),
      { vendor: VENDOR, item: 159, slot: 1, bag: BAG, bagSlot: 1, count: 1 }, "a carried bag: its guid and slot");
    call("PickupMerchantItem", 1);
    call("PickupInventoryItem", 11);
    assert.deepEqual(buyInSlot(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT)[2].payload),
      { vendor: VENDOR, item: 159, slot: 1, bag: PLAYER, bagSlot: 10, count: 1 }, "the paper doll: id − 1");
    assert.deepEqual(call("GetCursorInfo"), []);
    call("PickupMerchantItem", 1);
    call("PickupInventoryItem", 0);
    assert.equal(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT).length, 3, "the AmmoSlot buys nothing");
    assert.deepEqual(call("GetCursorInfo"), [], "and lets the row go");
    assert.equal(packets(OPCODES.CMSG_BUY_ITEM).length, 0);
  });
});

test("with no merchant open the row stays held and nothing is sent", () => {
  withSeam(({ call, packets, world }) => {
    call("PickupMerchantItem", 1);
    world.vendor = undefined;
    call("PickupContainerItem", 0, 3);
    call("PickupInventoryItem", 11);
    assert.equal(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT).length, 0);
    assert.deepEqual(call("GetCursorInfo"), ["merchant", 1]);
    call("ClearCursor");
    assert.deepEqual(call("GetCursorInfo"), []);
  });
});

test("a held bag item is sold by PickupMerchantItem; a split part smaller than its stack stays held", () => {
  withSeam(({ call, packets, seam }) => {
    call("PickupContainerItem", 0, 1);
    assert.equal(seam.cursorHasItem(), true);
    call("PickupMerchantItem", 0);
    const sold = packets(OPCODES.CMSG_SELL_ITEM);
    assert.equal(sold.length, 1);
    const reader = new PacketReader(Uint8Array.from(sold[0].payload));
    assert.deepEqual([reader.u64(), reader.u64(), reader.u32()], [VENDOR, BREAD, 0], "the whole item (count 0)");
    assert.equal(seam.cursorHasItem(), false);
    assert.deepEqual(call("GetCursorInfo"), []);
    call("SplitContainerItem", 0, 1, 2);
    assert.equal(seam.cursorHasItem(), true);
    call("PickupMerchantItem", 1);
    assert.equal(packets(OPCODES.CMSG_SELL_ITEM).length, 1, "a part of a stack is not sold");
    assert.equal(seam.cursorHasItem(), true, "and stays held");
    call("ClearCursor");
  });
});

test("UseContainerItem lets the row go first (0x005d8650 → 0x00519280), then the click is the seam's", () => {
  withSeam(({ call, packets }) => {
    call("PickupMerchantItem", 1);
    call("UseContainerItem", 0, 1);
    assert.deepEqual(call("GetCursorInfo"), []);
    assert.equal(packets(OPCODES.CMSG_SELL_ITEM).length, 1, "at the merchant the right-clicked bread is sold");
    assert.equal(packets(OPCODES.CMSG_BUY_ITEM_IN_SLOT).length, 0);
  });
});

test("the pieces: the container guid, no merchant, no row", () => {
  const { world } = fixture();
  assert.equal(merchant.frameXmlMerchantBagGuid(world.state, 255), PLAYER);
  assert.equal(merchant.frameXmlMerchantBagGuid(world.state, 19), BAG);
  assert.equal(merchant.frameXmlMerchantBagGuid(world.state, 20), undefined);
  const calls = [];
  const buyer = { state: world.state, vendor: world.vendor, buyFromVendorInSlot: (...args) => { calls.push(args); return true; } };
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot(buyer, { slot: 2, itemId: 4540 }, { bag: 255, slot: 30 }), true);
  assert.deepEqual(calls, [[2, 4540, PLAYER, 30, 1]]);
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot({ ...buyer, vendor: undefined }, { slot: 2, itemId: 4540 }, { bag: 255, slot: 30 }), undefined);
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot(buyer, undefined, { bag: 255, slot: 30 }), false);
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot(buyer, { slot: 0, itemId: 4540 }, { bag: 255, slot: 30 }), false, "no list slot");
  assert.equal(merchant.frameXmlBuyMerchantItemInSlot(buyer, { slot: 2, itemId: 4540 }, { bag: 20, slot: 0 }), false, "no such bag");
  assert.equal(calls.length, 1);
});
