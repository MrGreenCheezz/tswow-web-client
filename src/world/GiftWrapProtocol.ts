import { PacketWriter } from "../protocol/PacketWriter.js";

/** `ITEM_FLAG_IS_WRAPPER` (ItemTemplate.h:165): the template bit of wrapping paper. */
export const ITEM_FLAG_IS_WRAPPER = 0x200;
/** `ITEM_FIELD_FLAG_WRAPPED` (ItemTemplate.h:121): the instance bit of a wrapped gift. */
export const ITEM_FIELD_FLAG_WRAPPED = 0x8;

/**
 * `CMSG_WRAP_ITEM`: the paper's bag and slot, then the item's — four bytes
 * (`WorldSession::HandleWrapItemOpcode`, ItemHandler.cpp:886-893; Wow.exe 0x006dcf20 writes the same
 * four through 0x006d29f0/0x006d6820). The realm checks the rest and answers a refusal with
 * `SMSG_INVENTORY_CHANGE_FAILURE` (EQUIP_ERR_*_CANT_BE_WRAPPED).
 */
export function buildWrapItem(giftBag: number, giftSlot: number, itemBag: number, itemSlot: number): Uint8Array {
  return new PacketWriter().u8(giftBag).u8(giftSlot).u8(itemBag).u8(itemSlot).toUint8Array();
}
