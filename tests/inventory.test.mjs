import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { playerInventory } from "../dist/code/browser/Inventory.js";
import { WorldState } from "../dist/code/world/WorldState.js";

function object(guid, typeId) {
  return { guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined, turnRate: undefined, motion: undefined, fields: new Map() };
}

function guid(fields, offset, value) {
  fields.set(offset, Number(value & 0xffffffffn));
  fields.set(offset + 1, Number(value >> 32n));
}

test("inventory resolves equipment, backpack and equipped bag contents from update fields", () => {
  const state = new WorldState();
  const player = object(1n, 4);
  const helmet = object(10n, 1);
  const backpackItem = object(11n, 1);
  const bagItem = object(12n, 1);
  const bag = object(20n, 2);
  state.selfGuid = player.guid;
  for (const value of [player, helmet, backpackItem, bagItem, bag]) state.objects.set(value.guid, value);

  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset, helmet.guid);
  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 19 * 2, bag.guid);
  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, backpackItem.guid);
  bag.fields.set(UPDATE_FIELDS.CONTAINER_FIELD_NUM_SLOTS.offset, 2);
  guid(bag.fields, UPDATE_FIELDS.CONTAINER_FIELD_SLOT_1.offset, bagItem.guid);

  const inventory = playerInventory(state);
  assert.equal(inventory.equipment[0].item, helmet);
  assert.equal(inventory.backpack[0].item, backpackItem);
  assert.equal(inventory.bags[0].slots[0].item, bagItem);
  assert.equal(inventory.bags[0].slots.length, 2);
});
