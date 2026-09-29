import type { ItemSlotState } from "../Inventory.js";

/** The stock bag VM and the native bank panel share one local item cursor while FrameXML owns bags. */
export interface FrameXmlNativeBankCursorOwner {
  clickBankSlot(slot: Pick<ItemSlotState, "bag" | "slot">): boolean;
}

let owner: FrameXmlNativeBankCursorOwner | undefined;

export function publishFrameXmlNativeBankCursor(next: FrameXmlNativeBankCursorOwner): () => void {
  owner = next;
  return () => { if (owner === next) owner = undefined; };
}

/** False leaves the native bank's existing click/menu route in control. */
export function clickFrameXmlNativeBankSlot(slot: Pick<ItemSlotState, "bag" | "slot">): boolean {
  return owner?.clickBankSlot(slot) ?? false;
}
