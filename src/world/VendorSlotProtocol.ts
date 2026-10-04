import { PacketWriter } from "../protocol/PacketWriter.js";

/**
 * CMSG_BUY_ITEM_IN_SLOT (plan item 3.23, lane L1): a vendor row bought into a chosen place — what the
 * client sends when a merchant row held on the cursor is dropped on a bag or paper-doll slot
 * (Wow.exe 0x006d2ea0: vendor guid, item id, the row's list slot, the container's guid, the slot
 * inside it, then the count; `WorldSession::HandleBuyItemInSlotOpcode`, ItemHandler.cpp:556-596 reads
 * `vendorguid >> item >> slot >> bagguid >> bagslot(u8) >> count(u32)`). `vendorSlot` is the one-based
 * list number SMSG_LIST_INVENTORY gave; the container is the player himself for his own inventory
 * (INVENTORY_SLOT_BAG_0) or a carried bag.
 */
export function buildBuyItemInSlot(
  vendorGuid: bigint, itemId: number, vendorSlot: number, bagGuid: bigint, bagSlot: number, count: number,
): Uint8Array {
  return new PacketWriter().u64(vendorGuid).u32(itemId).u32(vendorSlot).u64(bagGuid).u8(bagSlot).u32(count).toUint8Array();
}
