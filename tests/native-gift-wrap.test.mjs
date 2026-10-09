// Plan item 2.05 slice E, the native bags (lane L1, 03.10): using wrapping paper arms it (Wow.exe
// Item::Use 0x00708c20 → 0x006d67e0) and, with paper waiting, a container item's click wraps it
// (PickupContainerItem 0x005d7ff0 → 0x006dcf20 → CMSG_WRAP_ITEM) — the backpack, a bag's contents and
// the keyring; worn items, the bag bar and the bank are not PickupContainerItem's. A locked item (the
// paper itself) eats the click and the paper keeps waiting.
import assert from "node:assert/strict";
import test from "node:test";

const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { playerInventory } = await import("../dist/code/browser/Inventory.js");
const wrap = await import("../dist/code/browser/game/GiftWrap.js");
const native = await import("../dist/code/browser/ui/NativeGiftWrap.js");

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n;
const PAPER = 0x4000_0000_0000_0601n;
const WATCH = 0x4000_0000_0000_0602n;
const GIFT = 0x4000_0000_0000_0603n;
const BELT = 0x4000_0000_0000_0604n;

function setGuid(fields, at, guid) {
  fields.set(at, Number(guid & 0xffff_ffffn));
  fields.set(at + 1, Number(guid >> 32n));
}

function template(entry, flags) {
  return {
    entry, found: true, name: String(entry), quality: 1, itemClass: 0, subClass: 0, flags, inventoryType: 0,
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
  setGuid(fields, offset("PLAYER_FIELD_INV_SLOT_HEAD") + 5 * 2, BELT);
  const object = (guid, entries) => ({
    guid, typeId: 1, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, fields: new Map(entries),
  });
  state.objects.set(PLAYER, { ...object(PLAYER, []), typeId: 4, fields });
  state.objects.set(PAPER, object(PAPER, [[offset("OBJECT_FIELD_ENTRY"), 5042]]));
  state.objects.set(WATCH, object(WATCH, [[offset("OBJECT_FIELD_ENTRY"), 2820]]));
  state.objects.set(GIFT, object(GIFT, [[offset("OBJECT_FIELD_ENTRY"), 5043], [offset("ITEM_FIELD_FLAGS"), 0x8]]));
  state.objects.set(BELT, object(BELT, [[offset("OBJECT_FIELD_ENTRY"), 5044]]));
  state.selfGuid = PLAYER;
  world.itemTemplates.set(5042, template(5042, 0x200));
  world.itemTemplates.set(2820, template(2820, 0));
  world.itemTemplates.set(5043, template(5043, 0x200 | 0x4));
  world.itemTemplates.set(5044, template(5044, 0x200));
  const inventory = playerInventory(state);
  return { world, sent, inventory };
}

test("the places a container click answers for: backpack, a bag's contents, the keyring", () => {
  const at = (bag, slot) => native.nativeWrapPlace({ index: 0, item: undefined, guid: 0n, bag, slot });
  assert.equal(at(255, 23), true, "backpack");
  assert.equal(at(255, 38), true);
  assert.equal(at(19, 0), true, "a carried bag's contents");
  assert.equal(at(22, 15), true);
  assert.equal(at(255, 86), true, "keyring");
  assert.equal(at(255, 117), true);
  assert.equal(at(255, 5), false, "worn");
  assert.equal(at(255, 19), false, "the bag bar");
  assert.equal(at(255, 39), false, "bank");
  assert.equal(at(67, 0), false, "a bank bag's contents");
  assert.equal(at(255, 118), false, "currency");
});

test("using paper arms it; a wrapped gift, other items and worn paper do not", () => {
  const { world, inventory, sent } = fixture();
  const [paper, watch, gift] = inventory.backpack;
  const belt = inventory.equipment[5];
  assert.equal(native.armNativeGiftWrap(watch, world), false, "not paper: the ordinary use");
  assert.equal(native.armNativeGiftWrap(gift, world), false, "a wrapped gift opens");
  assert.equal(native.armNativeGiftWrap(belt, world), false, "worn: not a container's item");
  assert.equal(wrap.pendingGiftWrap(world), undefined);
  assert.equal(native.armNativeGiftWrap(paper, world), true);
  assert.equal(wrap.pendingGiftWrap(world)?.guid, PAPER);
  assert.deepEqual(sent, [], "nothing sent on arming");
  wrap.cancelGiftWrap();
});

test("with paper waiting a container click wraps once; the paper itself and worn items do not", () => {
  const { world, inventory, sent } = fixture();
  const [paper, watch] = inventory.backpack;
  const belt = inventory.equipment[5];
  assert.equal(native.wrapNativeSlot(watch, world), false, "no paper: an ordinary click");
  native.armNativeGiftWrap(paper, world);
  assert.equal(native.wrapNativeSlot(belt, world), false, "worn: PickupInventoryItem does not look");
  assert.equal(native.wrapNativeSlot(paper, world), true, "the locked paper eats the click");
  assert.equal(wrap.pendingGiftWrap(world)?.guid, PAPER, "and keeps waiting");
  assert.equal(sent.length, 0);
  assert.equal(native.wrapNativeSlot(watch, world), true);
  assert.deepEqual(sent.map(({ opcode, payload }) => [opcode, payload]), [[OPCODES.CMSG_WRAP_ITEM, [255, 23, 255, 24]]]);
  assert.equal(wrap.pendingGiftWrap(world), undefined, "the paper is let go");
  assert.equal(native.wrapNativeSlot(watch, world), false, "the next click is ordinary");
});
