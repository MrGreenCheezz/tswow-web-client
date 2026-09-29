import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { inventorySignature } from "../dist/code/browser/Inventory.js";

/** One slot as the inventory model holds it, with only what the signature reads. */
function slot(entry, count, options = {}) {
  if (entry === 0) return { index: 0, item: undefined, guid: 0n, bag: 255, slot: 0 };
  const fields = new Map();
  fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry);
  fields.set(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, count);
  if (options.durability !== undefined) fields.set(UPDATE_FIELDS.ITEM_FIELD_DURABILITY.offset, options.durability);
  if (options.maxDurability !== undefined) fields.set(UPDATE_FIELDS.ITEM_FIELD_MAXDURABILITY.offset, options.maxDurability);
  if (options.enchant !== undefined) {
    fields.set(UPDATE_FIELDS.ITEM_FIELD_ENCHANTMENT_1_1.offset + (options.enchantSlot ?? 0) * 3, options.enchant);
  }
  const guid = options.guid ?? 1n;
  return { index: 0, item: { guid, typeId: 1, fields }, guid, bag: 255, slot: 0 };
}
const empty = { bags: [], bankBags: [], bankBagSlotsBought: 0 };

test("an inventory that has not moved signs the same, and one that has does not", () => {
  // The signature is what stops the bags being torn down and rebuilt sixty times a second, so the
  // only thing that matters about it is that it moves exactly when a slot does.
  const before = inventorySignature([slot(1234, 5), slot(0)], empty);
  assert.equal(inventorySignature([slot(1234, 5), slot(0)], empty), before, "nothing moved");

  assert.notEqual(inventorySignature([slot(1234, 4), slot(0)], empty), before, "the stack shrank");
  assert.notEqual(inventorySignature([slot(9999, 5), slot(0)], empty), before, "a different item");
  assert.notEqual(inventorySignature([slot(0), slot(0)], empty), before, "the slot emptied");
  assert.notEqual(inventorySignature([slot(0), slot(1234, 5)], empty), before, "it moved slots");
});

test("wear and enchantments sign differently without the entry or count moving", () => {
  // A repair, combat wear or a socketed gem changes nothing about `entry:count`, so without these
  // two the slot markers would stay frozen until some unrelated move forced a rebuild.
  const full = inventorySignature([slot(1234, 1, { durability: 90, maxDurability: 90 })], empty);
  const worn = inventorySignature([slot(1234, 1, { durability: 40, maxDurability: 90 })], empty);
  const broken = inventorySignature([slot(1234, 1, { durability: 0, maxDurability: 90 })], empty);
  assert.notEqual(worn, full, "worn gear signs differently");
  assert.notEqual(broken, worn, "a broken item is not merely a worn one");
  assert.notEqual(inventorySignature([slot(1234, 1, { enchant: 2343 })], empty), full, "an enchantment signs");
  assert.equal(inventorySignature([slot(1234, 1, { durability: 90, maxDurability: 90 })], empty), full,
    "the same wear signs the same");
});

test("swapping equal item instances changes the inventory signature", () => {
  // Player::SwapItem performs a real swap when equal, non-stackable items cannot merge.
  // The slot DOM closes over its old GUID for CMSG_USE_ITEM; it must be rebuilt after the
  // server changes only the two GUID fields, with entry/count/wear otherwise identical.
  const first = slot(1234, 1, { guid: 0x11n });
  const second = slot(1234, 1, { guid: 0x22n });
  const before = inventorySignature([first, second], empty);
  assert.notEqual(inventorySignature([second, first], empty), before);
});

test("swapping equal empty bag instances refreshes their drag targets", () => {
  // Bag-bar buttons close over the bag GUID too; empty bags need no inner-slot changes to move.
  const first = slot(1234, 1, { guid: 0x11n });
  const second = slot(1234, 1, { guid: 0x22n });
  const carried = (left, right) => ({
    bags: [
      { bagSlot: 19, bag: left.item, guid: left.guid, slots: [] },
      { bagSlot: 20, bag: right.item, guid: right.guid, slots: [] },
    ],
    bankBags: [], bankBagSlotsBought: 0,
  });
  assert.notEqual(inventorySignature([], carried(first, second)),
    inventorySignature([], carried(second, first)));
});

test("carrying a different bag signs differently even when every slot is empty", () => {
  const one = inventorySignature([], { bags: [{ bagSlot: 19, bag: slot(11, 1).item }], bankBags: [], bankBagSlotsBought: 0 });
  const other = inventorySignature([], { bags: [{ bagSlot: 19, bag: slot(22, 1).item }], bankBags: [], bankBagSlotsBought: 0 });
  const none = inventorySignature([], { bags: [{ bagSlot: 19, bag: undefined }], bankBags: [], bankBagSlotsBought: 0 });
  assert.notEqual(one, other);
  assert.notEqual(one, none);
  // A bag in the bank is not the same as the same bag worn.
  assert.notEqual(
    inventorySignature([], { bags: [{ bagSlot: 19, bag: slot(11, 1).item }], bankBags: [], bankBagSlotsBought: 0 }),
    inventorySignature([], { bags: [], bankBags: [{ bagSlot: 19, bag: slot(11, 1).item }], bankBagSlotsBought: 0 }),
  );
});

test("buying an empty bank bag slot repaints its lock before any bag is placed", () => {
  // The core updates PLAYER_BYTES_2 after a purchase. Its result packet can arrive before that
  // field update, so the bank must repaint when only the bought-slot count changes.
  const before = inventorySignature([], { bags: [], bankBags: [], bankBagSlotsBought: 0 });
  const after = inventorySignature([], { bags: [], bankBags: [], bankBagSlotsBought: 1 });
  assert.notEqual(after, before, "one newly bought slot must unlock without moving an item");
});
