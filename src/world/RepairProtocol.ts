import { PacketWriter } from "../protocol/PacketWriter.js";

/**
 * `CMSG_REPAIR_ITEM` (0x2A8): the merchant, the item (0 for everything) and whether the guild bank
 * pays — `u64 npcGuid, u64 itemGuid, u8 guildBank` (`WorldSession::HandleRepairItemOpcode`,
 * NPCHandler.cpp:758-794; the same three writes in Wow.exe 0x00585c90 and the repair cursor's
 * clicks at 0x005d7ff0 and 0x005e85d0, which always send 0 for the bank).
 */
export function buildRepairItem(npcGuid: bigint, itemGuid: bigint, guildBank: boolean): Uint8Array {
  return new PacketWriter().u64(npcGuid).u64(itemGuid).u8(guildBank ? 1 : 0).toUint8Array();
}
