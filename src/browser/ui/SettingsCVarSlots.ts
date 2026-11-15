/**
 * Which of this client's settings Wow.exe keeps in the account's data (5.37), and where.
 *
 * Wow.exe 12340 registers each CVar with a flag (0x00767fc0's third argument): 0x10 is written to the
 * account's config slot 0, 0x20 to the character's slot 1 (0x00512890 → 0x007670e0, the mask compared with
 * `flags & 0x30`), anything else to Config.wtf on the machine — and only when the value is not the default
 * (0x00767030). The table of every registration is `framexml/WowCVarRegistry.ts`; the rows here are the
 * settings whose stock CVar (`FrameXmlSettingsCVar.ts`) that table puts in slot 0 or 1 with a known default.
 *
 * Every other setting is this client's own, or a CVar Wow.exe keeps on the machine: those are kept in slot 6
 * beside the window layout (`SettingsAccountStore.ts`), never as `SET` lines — an unknown `SET` name is made
 * a CVar of no slot by Wow.exe (0x007681f0) and dropped at its next write.
 */

import { FRAME_XML_SETTINGS_CVARS } from "../framexml/FrameXmlSettingsCVar.js";
import { wowCVar, wowCVarSlot } from "../framexml/WowCVarRegistry.js";

/** Account-data slots 0 and 1: GLOBAL_CONFIG_CACHE and PER_CHARACTER_CONFIG_CACHE. */
export type ConfigSlot = 0 | 1;
export const ACCOUNT_CONFIG_SLOT: ConfigSlot = 0;
export const CHARACTER_CONFIG_SLOT: ConfigSlot = 1;

export interface SettingsCVarSlot {
  /** The name as Wow.exe registers it (and writes it when the slot has no line of its own spelling). */
  readonly cvar: string;
  readonly slot: ConfigSlot;
  /** The registered default: a value equal to it is not written (0x00767030). */
  readonly wowDefault: string;
}

export const SETTINGS_CVAR_SLOTS: readonly SettingsCVarSlot[] = Object.freeze(FRAME_XML_SETTINGS_CVARS.flatMap((row) => {
  const registration = wowCVar(row.cvar);
  const slot = wowCVarSlot(row.cvar);
  if (!registration || slot === undefined || registration.defaultValue === undefined) return [];
  return [Object.freeze({ cvar: registration.name, slot, wowDefault: registration.defaultValue })];
}));
