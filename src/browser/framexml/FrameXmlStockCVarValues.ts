import { stockCVarSlots } from "../ui/StockCVarSlots.js";
import { wowCVarStartValue } from "./WowCVarRegistry.js";

/**
 * 5.28 (follow-up, 15.11): a stock CVar's current value for TypeScript readers, by the same path the FrameXML neutral
 * map takes (FrameXmlCVarPersistence.ts): the browser's saved value, over it the account config slot's line when the
 * slots answered with one, over both a write made since (SetCVar → `__fxNoteCVar`), and with none of these Wow.exe's
 * registered default (WowCVarRegistry.ts). A new slot answer replaces the session's writes, as the map's slot step
 * does. Used where a C function reads a CVar the settings model does not carry (`profanityFilter` for GetInboxText).
 */

let saved = new Map<string, string>();
const written = new Map<string, string>();

/** The VM booted with these saved values (`__fxCVarSavedValues`); a new boot forgets the session's writes. */
export function setFrameXmlStockCVarSaved(rows: Iterable<readonly [string, string]>): void {
  saved = new Map([...rows].map(([name, value]) => [name.toLowerCase(), value]));
  written.clear();
}

/** A stock CVar written in this session (the map's `__fxNoteCVar`). */
export function noteFrameXmlStockCVarWrite(name: string, value: string): void {
  written.set(name.toLowerCase(), value);
}

/** The slots answered after the boot: their lines replace what was written before. */
export function clearFrameXmlStockCVarWrites(): void {
  written.clear();
}

export function frameXmlStockCVarValue(name: string): string | undefined {
  const key = name.toLowerCase();
  const write = written.get(key);
  if (write !== undefined) return write;
  for (const [row, value] of stockCVarSlots()?.rows() ?? []) if (row.toLowerCase() === key) return value;
  return saved.get(key) ?? wowCVarStartValue(name);
}
