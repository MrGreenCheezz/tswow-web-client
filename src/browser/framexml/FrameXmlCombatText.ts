/**
 * Plan item 3.01 (13.10): COMBAT_TEXT_UPDATE("SPELL_CAST", name) — the one combat-text message a cast raises, as
 * Wow.exe 3.3.5a (12340) raises it (Ghidra read-only; .runtime/re-2026-10-03/stock-small/g1.c 0x007519e0,
 * .runtime/re-2026-10-11/glue-1110/1013-m1.txt 0x0074d520/0x0074d700, 1013-m3.txt 0x0074d430/0x0074d580,
 * 1013-m4.txt the registration):
 *
 * - `CombatTextSetActiveUnit(unit)` (0x0074d580, table entry 0x00adb930) keeps the unit's GUID at 0x00ca1380
 *   (0 for a token that names nobody); Blizzard_CombatText sets it to "player" or "vehicle". Nothing else
 *   writes it, so before that call no cast raises the message.
 * - SMSG_SPELL_GO's handler 0x0080e1b0 (after UNIT_SPELLCAST_SUCCEEDED, before the misses):
 *   - a GO without CAST_FLAG_PENDING, or with AttributesEx7 0x80000000, goes to 0x007519e0: the caster must be
 *     a unit in view, the spell's row known and not kept out of the log (0x0074d3f0: ATTR0 0x180, no name,
 *     effect 36, AttributesEx4 0x1) nor a lock opener (0x0074d3d0: effect 33); then — after SPELL_CAST_SUCCESS,
 *     which only an untimed cast writes — when the caster is the combat-text unit (0x0074d430) and
 *     AttributesEx6 has 0x40 (record +0x28), 0x0074d520(0x1e, name) fires event 0x1e4 with "%s%s" (0x009e1ad0):
 *     the type name from 0x00adb820[0x1e] = "SPELL_CAST" and the spell's name (record +0x220);
 *   - a GO with CAST_FLAG_PENDING (and no Ex7 0x80000000) whose row has AttributesEx6 0x40 goes to 0x0074d700,
 *     which fires the same message when the packet's first caster GUID (the item's, for an item cast) is the
 *     combat-text unit — with no other test.
 */

import { castLogHidden, type CastLogSpell } from "./FrameXmlCombatLogCasts.js";

/** 0x00adb820[0x1e]. */
export const COMBAT_TEXT_SPELL_CAST = "SPELL_CAST";
/** AttributesEx6 0x40: the cast is shown in the combat text (record +0x28). */
export const SPELL_ATTR6_COMBAT_TEXT_CAST = 0x40;
const ATTR7_ALWAYS_SUCCESS_LOG = 0x80000000;
const CAST_FLAG_PENDING = 0x1;
const EFFECT_OPEN_LOCK = 33;

export interface CombatTextGo {
  /** The packet's first caster GUID (the item's for an item cast). */
  readonly casterGuid: bigint;
  /** The casting unit. */
  readonly casterUnit: bigint;
  readonly castFlags: number;
  /** The casting unit is a unit in view (0x004d4db0, type mask 8). */
  readonly casterIsUnit: boolean;
}

function word(spell: CastLogSpell, index: number): number {
  return (spell.attributes?.[index] ?? 0) >>> 0;
}

/**
 * The name COMBAT_TEXT_UPDATE("SPELL_CAST", name) carries for this GO, or undefined when the GO raises none.
 * `unit` is the combat-text unit (0n before CombatTextSetActiveUnit names one).
 */
export function combatTextSpellCast(go: CombatTextGo, spell: CastLogSpell | undefined, unit: bigint): string | undefined {
  if (unit === 0n || spell === undefined) return undefined;
  if ((word(spell, 6) & SPELL_ATTR6_COMBAT_TEXT_CAST) === 0) return undefined;
  const name = spell.name ?? "";
  const pending = (go.castFlags & CAST_FLAG_PENDING) !== 0;
  if (pending && (word(spell, 7) & ATTR7_ALWAYS_SUCCESS_LOG) === 0) {
    return go.casterGuid === unit ? name : undefined; // 0x0074d700
  }
  // 0x007519e0
  if (!go.casterIsUnit || castLogHidden(spell) || spell.effects?.includes(EFFECT_OPEN_LOCK)) return undefined;
  return go.casterUnit === unit ? name : undefined;
}

/** `CombatTextSetActiveUnit`'s GUID from the seam's "0x…" string (or nothing): 0n names nobody. */
export function combatTextUnitGuid(text: string | undefined): bigint {
  if (typeof text !== "string" || !/^0x[0-9a-f]+$/i.test(text)) return 0n;
  return BigInt(text);
}
