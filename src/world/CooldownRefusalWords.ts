/**
 * Plan item 3.47 (12.10): the error frame's words for a refusal on cooldown, as Wow.exe 3.3.5a 12340 picks them —
 * one rule for the client's own refusal (a press on a cooling spell or item) and for the realm's NOT_READY.
 *
 * Wow.exe (read-only Ghidra, .runtime/re-2026-10-04/l12-small/g1-g3.c, re-2026-10-11/glue-1110/a347-*):
 * - Every refusal of the player's goes through 0x00808200: the client's own from the request builder 0x0080cce0
 *   (its check 0x00739650 refuses a recovering or held spell NOT_READY, 0x43, an item ITEM_NOT_READY, 0x2d, before
 *   any targeting or packet) and the realm's SMSG_CAST_FAILED (0x00809af0, last argument 1). 0x00808200 asks
 *   0x00807f10 for the error frame's message row first (`local_c`), whoever refused, and shows that row through
 *   0x005216f0 with the refusal's SPELL_FAILED_* sentence as its argument, unless its repeat rule (`local_14`: the
 *   same spell and result within 3 s) keeps the frame quiet; the combat log gets the SPELL_FAILED_* sentence.
 * - 0x00807f10 reads the spell row (Category at +0x4, Attributes at +0x10). 0x2d: Category 4 or 9 row 0x32
 *   ERR_POTION_COOLDOWN, 10 or 11 row 0x33 ERR_FOOD_COOLDOWN, any other row 0x31 ERR_ITEM_COOLDOWN. 0x43: the
 *   same potion and food rows, else `(Attributes & 0x10 | 0x340) >> 4` — row 0x35 ERR_ABILITY_COOLDOWN for
 *   SPELL_ATTR0_ABILITY, row 0x34 ERR_SPELL_COOLDOWN for any other spell. Rows 0x31-0x35 of the message table
 *   0x00ac8af0 are all of type 2 (the error frame, UI_ERROR_MESSAGE) and take no argument, so the words are the
 *   GlobalString alone. Case 0x43 also drops a held entry of the spell when the refusal's first extra is 0 (the
 *   history remover 0x00802970); TrinityCore writes no extra for NOT_READY (Spell::WriteCastResultInfo), so
 *   0x00809af0 passes -1 and that branch never runs against this realm.
 * The other results 0x00807f10 gives rows of their own (2, 3, 4, 11, 12, 28-31, 52, 72, 94, 97, 100, 129, 131,
 * 148, 170, 174, 178, 184) are not this item's; 129 (TOO_MANY_OF_ITEM) is AutoRepeatRefusal.ts's.
 */
import { globalString } from "../generated/globalStrings.js";
import { SPELL_FAILED_NOT_READY } from "./AutoRepeatRefusal.js";

/** SpellCastResult SPELL_FAILED_ITEM_NOT_READY (SharedDefines.h; 0x00739650's `0x2d`). */
export const SPELL_FAILED_ITEM_NOT_READY = 45;
/** `SPELL_ATTR0_ABILITY` (SharedDefines.h): the bit 0x00807f10 reads at record +0x10 for 0x43. */
export const SPELL_ATTR0_ABILITY = 0x10;

/** What 0x00807f10 reads of the refused spell's row; either part may be unknown to the page. */
export interface CooldownRefusalRow {
  /** Spell.dbc Category. */
  readonly category?: number | undefined;
  /** The row's eight attribute words (`attributes[0]` is Attributes). */
  readonly attributes?: readonly number[] | undefined;
}

/**
 * 0x00807f10, cases 0x2d and 0x43: the GlobalStrings name of the error frame's words for a refusal on cooldown, or
 * undefined for any other result. A row the page does not know reads as Category 0 and no attributes.
 */
export function cooldownRefusalErrorName(result: number, row: CooldownRefusalRow | undefined): string | undefined {
  if (result !== SPELL_FAILED_ITEM_NOT_READY && result !== SPELL_FAILED_NOT_READY) return undefined;
  const category = row?.category;
  if (category === 4 || category === 9) return "ERR_POTION_COOLDOWN";
  if (category === 10 || category === 11) return "ERR_FOOD_COOLDOWN";
  if (result === SPELL_FAILED_ITEM_NOT_READY) return "ERR_ITEM_COOLDOWN";
  return ((row?.attributes?.[0] ?? 0) & SPELL_ATTR0_ABILITY) !== 0 ? "ERR_ABILITY_COOLDOWN" : "ERR_SPELL_COOLDOWN";
}

/** The words of `cooldownRefusalErrorName` (the client's GlobalStrings), or undefined for any other result. */
export function cooldownRefusalText(result: number, row: CooldownRefusalRow | undefined): string | undefined {
  const name = cooldownRefusalErrorName(result, row);
  return name === undefined ? undefined : globalString(name) ?? name;
}
