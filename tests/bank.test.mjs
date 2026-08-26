import assert from "node:assert/strict";
import test from "node:test";
import { PacketReader, PacketWriter } from "../dist/code/protocol/index.js";
import {
  BANK_SLOT_OK, bankSlotResultText, buildAutoBankItem, buildAutoStoreBankItem, buildBankerActivate,
  parseBuyBankSlotResult,
} from "../dist/code/world/BankProtocol.js";
import {
  EQUIPMENT_SET_IGNORED, EQUIPMENT_SET_SLOTS, MAX_EQUIPMENT_SETS, buildEquipmentSetDelete,
  buildEquipmentSetSave, buildEquipmentSetUse, parseEquipmentSetUseResult,
} from "../dist/code/world/CharacterProgressProtocol.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import {
  BANK_ITEM_SLOTS, BANK_SLOT_BAG_START, BANK_SLOT_ITEM_START, BUYBACK_SLOT_START, KEYRING_SLOTS,
  KEYRING_SLOT_START, INVENTORY_SLOT_BAG_0, firstFreeSlot, freeSlots, isBankSlot, locateItem,
  playerInventory, slotAt,
} from "../dist/code/browser/Inventory.js";
import { WorldState } from "../dist/code/world/WorldState.js";

function object(guid, typeId) {
  return { guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined, runSpeed: undefined, turnRate: undefined, motion: undefined, fields: new Map() };
}

function guid(fields, offset, value) {
  fields.set(offset, Number(value & 0xffffffffn));
  fields.set(offset + 1, Number(value >> 32n));
}

test("the bank opcodes carry the two bytes and the one guid their handlers read", () => {
  // HandleBankerActivateOpcode reads WorldPackets::NPC::Hello, which is a plain guid.
  assert.equal(buildBankerActivate(0xf130000000000404n).length, 8);
  assert.equal(new DataView(buildBankerActivate(0x1234n).buffer).getBigUint64(0, true), 0x1234n);
  // HandleAutoBankItemOpcode and HandleAutoStoreBankItemOpcode both read bag then slot.
  assert.deepEqual([...buildAutoBankItem(INVENTORY_SLOT_BAG_0, 23)], [255, 23]);
  assert.deepEqual([...buildAutoStoreBankItem(19, 4)], [19, 4]);
});

test("a bank slot purchase reports its one word, and only three means it worked", () => {
  assert.equal(parseBuyBankSlotResult(new PacketWriter().u32(BANK_SLOT_OK).toUint8Array()), BANK_SLOT_OK);
  assert.match(bankSlotResultText(BANK_SLOT_OK), /куплен/i);
  // ERR_BANKSLOT_INSUFFICIENT_FUNDS is 1 and ERR_BANKSLOT_NOTBANKER is 2; neither is success.
  assert.match(bankSlotResultText(1), /денег/i);
  assert.match(bankSlotResultText(2), /банкир/i);
  assert.match(bankSlotResultText(99), /99/);
});

test("bank positions are the slot ranges Player::IsBankPos accepts and no others", () => {
  // Bank items 39..66 and bank bag slots 67..73, both of INVENTORY_SLOT_BAG_0.
  assert.equal(isBankSlot(INVENTORY_SLOT_BAG_0, 38), false, "the last backpack slot is not the bank");
  assert.equal(isBankSlot(INVENTORY_SLOT_BAG_0, 39), true);
  assert.equal(isBankSlot(INVENTORY_SLOT_BAG_0, 73), true);
  assert.equal(isBankSlot(INVENTORY_SLOT_BAG_0, 74), false, "buyback is not the bank");
  assert.equal(isBankSlot(INVENTORY_SLOT_BAG_0, KEYRING_SLOT_START), false);
  // A bank bag's own contents, addressed by the container slot rather than by BAG_0.
  assert.equal(isBankSlot(BANK_SLOT_BAG_START, 0), true);
  assert.equal(isBankSlot(BANK_SLOT_BAG_START + 6, 35), true);
  assert.equal(isBankSlot(19, 0), false, "a carried bag is not a bank bag");
});

test("the inventory resolves the bank, its bags, the keyring and the buyback shelf", () => {
  const state = new WorldState();
  const player = object(1n, 4);
  const banked = object(40n, 1);
  const keyed = object(41n, 1);
  const sold = object(42n, 1);
  const bankBag = object(50n, 2);
  const inBankBag = object(51n, 1);
  state.selfGuid = player.guid;
  for (const value of [player, banked, keyed, sold, bankBag, inBankBag]) state.objects.set(value.guid, value);

  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset, banked.guid);
  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_KEYRING_SLOT_1.offset + 2, keyed.guid);
  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_VENDORBUYBACK_SLOT_1.offset, sold.guid);
  player.fields.set(UPDATE_FIELDS.PLAYER_FIELD_BUYBACK_PRICE_1.offset, 4_500);
  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANKBAG_SLOT_1.offset, bankBag.guid);
  bankBag.fields.set(UPDATE_FIELDS.CONTAINER_FIELD_NUM_SLOTS.offset, 3);
  guid(bankBag.fields, UPDATE_FIELDS.CONTAINER_FIELD_SLOT_1.offset, inBankBag.guid);
  // PLAYER_BYTES_2 byte 2 is the bought bank bag slot count, and nothing else says it.
  player.fields.set(UPDATE_FIELDS.PLAYER_BYTES_2.offset, 0x00_02_00_00);

  const inventory = playerInventory(state);
  assert.equal(inventory.bank.length, BANK_ITEM_SLOTS);
  assert.equal(inventory.bank[0].item, banked);
  assert.equal(inventory.keyring.length, KEYRING_SLOTS);
  assert.equal(inventory.keyring[1].item, keyed);
  assert.equal(inventory.bankBagSlotsBought, 2);
  assert.equal(inventory.bankBags[0].slots[0].item, inBankBag);
  assert.equal(inventory.bankBags[0].bagSlot, BANK_SLOT_BAG_START);

  // Every one of them is addressed as a slot of the player's own inventory, at its absolute
  // number: an off-by-BANK_SLOT_ITEM_START here moves the wrong item.
  assert.equal(inventory.bank[0].bag, INVENTORY_SLOT_BAG_0);
  assert.equal(inventory.bank[0].slot, BANK_SLOT_ITEM_START);
  assert.equal(inventory.keyring[1].slot, KEYRING_SLOT_START + 1);
  // CMSG_BUYBACK_ITEM subtracts BUYBACK_SLOT_START to find the price, so the slot is absolute.
  assert.equal(inventory.buyback[0].slot, BUYBACK_SLOT_START);
  assert.equal(inventory.buyback[0].price, 4_500);
  assert.equal(inventory.buyback[0].item, sold);

  assert.equal(slotAt(inventory, INVENTORY_SLOT_BAG_0, BANK_SLOT_ITEM_START).item, banked);
  assert.equal(slotAt(inventory, BANK_SLOT_BAG_START, 0).item, inBankBag);
  assert.equal(locateItem(inventory, inBankBag.guid).bag, BANK_SLOT_BAG_START);
  assert.equal(locateItem(inventory, keyed.guid).slot, KEYRING_SLOT_START + 1);
  assert.equal(locateItem(inventory, 0n), undefined);
});

test("saving an equipment set writes the header and nineteen packed guids", () => {
  const pieces = Array.from({ length: EQUIPMENT_SET_SLOTS }, (_, index) => (index === 0 ? 0x1234n : 0n));
  pieces[15] = EQUIPMENT_SET_IGNORED;
  const packet = buildEquipmentSetSave(0n, 2, "Танк", "icon", pieces);

  const reader = new PacketReader(packet);
  assert.equal(reader.packedGuid(), 0n, "a new set is saved under a zero guid and named by the reply");
  assert.equal(reader.u32(), 2);
  assert.equal(reader.cString(), "Танк");
  assert.equal(reader.cString(), "icon");
  const read = [];
  for (let slot = 0; slot < EQUIPMENT_SET_SLOTS; slot++) read.push(reader.packedGuid());
  reader.assertFinished();
  assert.equal(read.length, 19, "EQUIPMENT_SLOT_END is nineteen, whatever the character wears");
  assert.equal(read[0], 0x1234n);
  // A raw one is not a guid: HandleEquipmentSetSave turns it into a bit of IgnoreMask, and a zero
  // means the opposite — empty the slot.
  assert.equal(read[15], EQUIPMENT_SET_IGNORED);
  assert.equal(read[1], 0n);

  // The index is checked against MAX_EQUIPMENT_SET_INDEX before the packet is sent, and the
  // core's own comment calls that number the client's limit rather than the server's.
  assert.equal(MAX_EQUIPMENT_SETS, 10);
});

test("using an equipment set names no set at all, only where each piece is now", () => {
  const pieces = Array.from({ length: EQUIPMENT_SET_SLOTS }, (_, index) => ({
    guid: index === 3 ? 0x99n : 0n,
    bag: index === 3 ? 19 : 0,
    slot: index === 3 ? 5 : 0,
  }));
  const reader = new PacketReader(buildEquipmentSetUse(pieces));
  for (let slot = 0; slot < EQUIPMENT_SET_SLOTS; slot++) {
    const itemGuid = reader.packedGuid();
    const bag = reader.u8();
    const position = reader.u8();
    if (slot === 3) {
      assert.equal(itemGuid, 0x99n);
      assert.deepEqual([bag, position], [19, 5]);
    } else {
      assert.equal(itemGuid, 0n, "a slot the set leaves empty is unequipped rather than skipped");
    }
  }
  reader.assertFinished();

  assert.deepEqual([...buildEquipmentSetDelete(0n)], [0], "a packed zero guid is one empty mask byte");
  // SMSG_EQUIPMENT_SET_USE_RESULT is one byte and the core writes zero whatever happened.
  assert.equal(parseEquipmentSetUseResult(Uint8Array.from([0])), 0);
  assert.equal(parseEquipmentSetUseResult(Uint8Array.from([4])), 4);
});

test("a split started in the bank lands in the bank, and one in the bags in the bags", () => {
  const state = new WorldState();
  const player = object(1n, 4);
  const banked = object(40n, 1);
  const carried = object(41n, 1);
  state.selfGuid = player.guid;
  for (const value of [player, banked, carried]) state.objects.set(value.guid, value);
  // The first bank slot and the first backpack slot are both taken, so the first free one on each
  // side is the second — and the two sides must not be confused: the server refuses a split that
  // names a destination the item may not go to.
  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset, banked.guid);
  guid(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, carried.guid);

  const inventory = playerInventory(state);
  assert.equal(firstFreeSlot(inventory, true).slot, BANK_SLOT_ITEM_START + 1);
  assert.equal(firstFreeSlot(inventory, false).slot, 24);
  assert.equal(firstFreeSlot(undefined, false), undefined);

  assert.equal(freeSlots(inventory.bank), BANK_ITEM_SLOTS - 1);
  assert.equal(freeSlots(inventory.backpack), 15);
  assert.equal(freeSlots([]), 0);
});
