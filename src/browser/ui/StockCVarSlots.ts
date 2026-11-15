/**
 * The stock interface's own CVars in the account's config slots (5.37): the names the FrameXML neutral map
 * keeps (trackedQuests, minimapZoom, the lfg ones, …) that Wow.exe registers with flag 0x10 or 0x20
 * (`framexml/WowCVarRegistry.ts`). The settings store (`SettingsAccountStore.ts`) owns the slots and registers
 * itself here; the CVar persistence of the FrameXML VM (`framexml/FrameXmlCVarPersistence.ts`) seeds the
 * slots' values, reports the stock interface's writes and takes values that arrive after it booted.
 */

export interface StockCVarSlots {
  /** `[name, value]` of every slot CVar the server's slots set, once they have answered. */
  rows(): readonly (readonly [string, string])[];
  /** A value the stock interface set; false when the name is not a slot CVar. */
  note(name: string, value: string): boolean;
  /** Called with the rows when the slots answer (after the VM may have booted); returns the unsubscribe. */
  subscribe(listener: (rows: readonly (readonly [string, string])[]) => void): () => void;
}

let current: StockCVarSlots | undefined;

export function setStockCVarSlots(slots: StockCVarSlots | undefined): void {
  current = slots;
}

export function stockCVarSlots(): StockCVarSlots | undefined {
  return current;
}
