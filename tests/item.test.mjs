import assert from "node:assert/strict";
import test from "node:test";
import {
  INVENTORY_SLOT_BAG_0,
  buildAutoEquipItem,
  buildAutoStoreBagItem,
  buildDestroyItem,
  buildSplitItem,
  buildSwapInvItem,
  buildSwapItem,
  buildUseItem,
  equipErrorText,
  parseInventoryChangeFailure,
  parseItemPushResult,
} from "../dist/code/world/ItemProtocol.js";

test("the swap opcodes write the destination before the source", () => {
  // HandleSwapInvItemOpcode reads dstslot then srcslot, the reverse of the opcode name.
  assert.deepEqual([...buildSwapInvItem(23, 5)], [5, 23]);
  // HandleSwapItem reads dstbag, dstslot, srcbag, srcslot.
  assert.deepEqual([...buildSwapItem(19, 2, INVENTORY_SLOT_BAG_0, 24)], [255, 24, 19, 2]);
});

test("the remaining item opcodes match their handlers", () => {
  assert.deepEqual([...buildAutoEquipItem(255, 23)], [255, 23]);
  assert.deepEqual([...buildAutoStoreBagItem(255, 23, 19)], [255, 23, 19]);
  // HandleDestroyItemOpcode reads bag, slot, count and three unused bytes.
  assert.deepEqual([...buildDestroyItem(19, 3)], [19, 3, 0, 0, 0, 0]);
  assert.deepEqual([...buildDestroyItem(19, 3, 5)], [19, 3, 5, 0, 0, 0]);

  const split = buildSplitItem(255, 23, 19, 0, 7);
  assert.equal(split.length, 4 + 4);
  assert.equal(new DataView(split.buffer, split.byteOffset).getUint32(4, true), 7);
});

test("use item writes the handler's field order and a no-target cast", () => {
  // HandleUseItemOpcode reads bagIndex, slot, castCount, spellId, itemGUID, glyphIndex, castFlags.
  const packet = buildUseItem(255, 24, 3, 0, 0x1234n);
  assert.equal(packet.length, 1 + 1 + 1 + 4 + 8 + 4 + 1 + 4);
  const view = new DataView(packet.buffer, packet.byteOffset);
  assert.equal(view.getUint8(0), 255);
  assert.equal(view.getUint8(1), 24);
  assert.equal(view.getUint8(2), 3);
  assert.equal(view.getUint32(3, true), 0);
  assert.equal(view.getBigUint64(7, true), 0x1234n);
});

test("an equip failure decodes its guids and the optional detail", () => {
  // Player::SendEquipError writes the result, two guids, a subclass byte and sometimes a detail.
  const plain = new Uint8Array(1 + 8 + 8 + 1);
  const plainView = new DataView(plain.buffer);
  plainView.setUint8(0, 50); // EQUIP_ERR_INVENTORY_FULL
  plainView.setBigUint64(1, 0xaaan, true);
  plainView.setBigUint64(9, 0n, true);
  const failure = parseInventoryChangeFailure(plain);
  assert.equal(failure.result, 50);
  assert.equal(failure.itemGuid, 0xaaan);
  assert.equal(failure.detail, undefined);
  assert.match(equipErrorText(failure), /заполнен/i);

  const levelled = new Uint8Array(1 + 8 + 8 + 1 + 4);
  const levelledView = new DataView(levelled.buffer);
  levelledView.setUint8(0, 1); // EQUIP_ERR_CANT_EQUIP_LEVEL_I
  levelledView.setUint32(18, 40, true);
  const levelFailure = parseInventoryChangeFailure(levelled);
  assert.equal(levelFailure.detail, 40);
  assert.match(equipErrorText(levelFailure), /40/);

  // A zero result carries no body.
  assert.deepEqual(parseInventoryChangeFailure(Uint8Array.from([0])), {
    result: 0, itemGuid: 0n, otherItemGuid: 0n, bagTypeSubclass: 0,
  });
  assert.match(equipErrorText({ result: 200 }), /200/);
});

test("item push result decodes the whole Player::SendNewItem body", () => {
  const bytes = new Uint8Array(8 + 4 + 4 + 4 + 1 + 4 + 4 + 4 + 4 + 4 + 4);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 0x99n, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 0, true);
  view.setUint32(16, 1, true);
  view.setUint8(20, 255);
  view.setInt32(21, -1, true);
  view.setUint32(25, 2589, true);
  view.setUint32(29, 0, true);
  view.setInt32(33, 0, true);
  view.setUint32(37, 3, true);
  view.setUint32(41, 12, true);

  assert.deepEqual(parseItemPushResult(bytes), {
    playerGuid: 0x99n, fromNpc: true, created: false, showInChat: true,
    bag: 255, slot: -1, itemId: 2589, suffixFactor: 0, randomPropertyId: 0,
    count: 3, countInInventory: 12,
  });
});
