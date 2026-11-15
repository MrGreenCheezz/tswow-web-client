/**
 * 5.37 (15.11): the login screens' CVar table answers from the same registration table as the world
 * (framexml/WowCVarRegistry.ts). Wow.exe has one CVar table for the glue and the world: every 0x00767fc0 call has run
 * before the first glue screen, so a registered CVar has its registered (or computed) default there too, a name is
 * found in any case, and `GetCVarDefault` answers the registered string. The world's neutral map does the same
 * (FrameXmlNeutralApi.ts, FrameXmlCVarPersistence.ts).
 */
import { wowCVar, wowCVarStartValue } from "../framexml/WowCVarRegistry.js";
import { isGlueWindowCVar } from "./GlueWindowMode.js";

/**
 * Names the glue corpus reads that the registration census has no row for (`showTooltips`, `playIntroMovie`), kept at
 * the values the corpus expects. Every other start value comes from the registration table.
 */
export const GLUE_OWN_CVAR_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  showTooltips: "1",
  playIntroMovie: "1",
});

const OWN_BY_LOWER = new Map(Object.keys(GLUE_OWN_CVAR_DEFAULTS).map((name) => [name.toLowerCase(), name]));

/**
 * The key a name is kept under: the stored key that matches it in any case, else the registered spelling, else the
 * glue's own spelling, else the name as given — so `SetCVar("accountname", …)` and `GetCVar("ACCOUNTNAME")` meet the
 * `accountName` the store keeps (a CVar name is case-insensitive in Wow.exe, as the world's map is).
 */
export function glueCVarKey(name: string, stored: ReadonlyMap<string, string>): string {
  if (stored.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of stored.keys()) if (key.toLowerCase() === lower) return key;
  return wowCVar(name)?.name ?? OWN_BY_LOWER.get(lower) ?? name;
}

/** What a CVar is before anything is stored: Wow.exe's registered or computed default, else the glue's own seed. */
export function glueCVarStartValue(name: string, locale: string): string | undefined {
  const own = OWN_BY_LOWER.get(name.toLowerCase());
  return wowCVarStartValue(name, locale) ?? (own === undefined ? undefined : GLUE_OWN_CVAR_DEFAULTS[own]);
}

/**
 * `GetCVarDefault`: the registered default, as the world answers it; `gxWindow` is the page's window (default "1", a
 * window), as the world's settings adapter answers it (FrameXmlSettingsCVar.ts); nil for a name nothing registers.
 */
export function glueCVarDefault(name: string, locale: string): string | undefined {
  if (isGlueWindowCVar(name)) return "1";
  return glueCVarStartValue(name, locale);
}

/** The C conversion of a CVar's text to a number: a text that does not parse is 0. */
function cvarFloat(text: string | undefined): number {
  const value = Number.parseFloat(text ?? "");
  return Number.isFinite(value) ? value : 0;
}

/** `GetGamma` (Wow.exe 0x0054ea60): 1 − the float of the CVar `gamma` (registered "1.0", so 0 by default). */
export function glueGamma(read: (name: string) => string | undefined): number {
  return 1 - cvarFloat(read("gamma"));
}

/** `GetTerrainMip` (Wow.exe 0x0054eb10): 1 − the integer of the CVar `shadowLevel` (registered "1", so 0). */
export function glueTerrainMip(read: (name: string) => string | undefined): number {
  return 1 - Math.trunc(cvarFloat(read("shadowLevel")));
}

/** Whether Wow.exe registers the name (any case); `RegisterCVar` from Lua does not replace such a default. */
export function isRegisteredGlueCVar(name: string): boolean {
  return wowCVar(name) !== undefined || OWN_BY_LOWER.has(name.toLowerCase());
}
