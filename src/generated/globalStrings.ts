/**
 * Stable, redistributable facade for locale text generated from the user's own client dataset.
 * The ignored implementation is neutral in a clean checkout and contains real text only after
 * `npm run strings:generate` has been run locally.
 */
import * as implementation from "./client-data/globalStrings.js";

export const GLOBAL_STRING_DATA_AVAILABLE: boolean = implementation.GLOBAL_STRING_DATA_AVAILABLE;
export const GLOBAL_STRINGS: Readonly<Record<string, string>> = implementation.GLOBAL_STRINGS;
export const SPELL_CAST_RESULT_NAMES: Readonly<Record<number, string>> =
  implementation.SPELL_CAST_RESULT_NAMES;
export const ITEM_MOD_NAMES: Readonly<Record<number, string>> = implementation.ITEM_MOD_NAMES;

/** The words for one code, or nothing when this local build has no string for it. */
export function globalString(name: string): string | undefined {
  return GLOBAL_STRINGS[name];
}
