import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { inventorySignature } from "../dist/code/browser/Inventory.js";

/** One slot as the inventory model holds it, with only what the signature reads. */
function slot(entry, count) {
  if (entry === 0) return { index: 0, item: undefined, guid: 0n, bag: 255, slot: 0 };
  const fields = new Map();
  fields.set(UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry);
  fields.set(UPDATE_FIELDS.ITEM_FIELD_STACK_COUNT.offset, count);
  return { index: 0, item: { guid: 1n, typeId: 1, fields }, guid: 1n, bag: 255, slot: 0 };
}
const empty = { bags: [], bankBags: [] };

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

test("carrying a different bag signs differently even when every slot is empty", () => {
  const one = inventorySignature([], { bags: [{ bagSlot: 19, bag: slot(11, 1).item }], bankBags: [] });
  const other = inventorySignature([], { bags: [{ bagSlot: 19, bag: slot(22, 1).item }], bankBags: [] });
  const none = inventorySignature([], { bags: [{ bagSlot: 19, bag: undefined }], bankBags: [] });
  assert.notEqual(one, other);
  assert.notEqual(one, none);
  // A bag in the bank is not the same as the same bag worn.
  assert.notEqual(
    inventorySignature([], { bags: [{ bagSlot: 19, bag: slot(11, 1).item }], bankBags: [] }),
    inventorySignature([], { bags: [], bankBags: [{ bagSlot: 19, bag: slot(11, 1).item }] }),
  );
});
