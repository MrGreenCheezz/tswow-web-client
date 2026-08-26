import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";

// Layouts follow the active TrinityCore source: BankHandler.cpp (`HandleBankerActivateOpcode`,
// `HandleAutoBankItemOpcode`, `HandleAutoStoreBankItemOpcode`, `HandleBuyBankSlotOpcode`,
// `SendShowBank`) and BankPackets.cpp.
//
// The bank is not a container the server hands over: it is a second stretch of the player's own
// slot numbering, private update fields that have been arriving since the first login. Opening it
// is only permission — `m_currentBankerGUID` is set by `CMSG_BANKER_ACTIVATE` and every bank move
// is refused without it, which is why a bank window can draw itself from state it already has but
// cannot move a single item until the player is standing at a banker.

/** `CMSG_BANKER_ACTIVATE`, read as `WorldPackets::NPC::Hello`: the banker's guid, unpacked. */
export function buildBankerActivate(bankerGuid: bigint): Uint8Array {
  return new PacketWriter().u64(bankerGuid).toUint8Array();
}

/** `CMSG_AUTOBANK_ITEM`: bags to bank, into whatever slot fits. */
export function buildAutoBankItem(bag: number, slot: number): Uint8Array {
  return new PacketWriter().u8(bag).u8(slot).toUint8Array();
}

/**
 * `CMSG_AUTOSTORE_BANK_ITEM`: bank to bags.
 *
 * The handler reads the same two bytes as `CMSG_AUTOBANK_ITEM` and then decides which way the item
 * is going by asking `IsBankPos` about the position it was handed — so the opcode is really "move
 * this item to the other side", and sending it for a bag slot banks the item instead.
 */
export function buildAutoStoreBankItem(bag: number, slot: number): Uint8Array {
  return new PacketWriter().u8(bag).u8(slot).toUint8Array();
}

/** `ERR_BANKSLOT_*` in Player.h; the packet is this one word and nothing else. */
export const BANK_SLOT_OK = 3;

export function parseBuyBankSlotResult(payload: Uint8Array): number {
  const reader = new PacketReader(payload);
  const result = reader.u32();
  reader.assertFinished();
  return result;
}

export function bankSlotResultText(result: number): string {
  if (result === BANK_SLOT_OK) return "Ячейка банка куплена";
  if (result === 0) return "Больше ячеек банка не продаётся";
  if (result === 1) return "Не хватает денег на ячейку банка";
  if (result === 2) return "Рядом нет банкира";
  return `Банк отказал (код ${result})`;
}
