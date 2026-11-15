import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { SPELLMOD, spellTextModFloat, spellTextModInt, type SpellTextCasterRecord } from "./SpellTextCaster.js";
import type { SpellCostUnit } from "./SpellTextCost.js";
import { spellTextFloat, spellTextInt } from "./SpellTextPlayer.js";
import { spellTextRoundEven } from "./SpellTextWowRules.js";

/**
 * 3.43 (15.11): a spell's cast time and GetSpellInfo's range pair as Wow.exe 3.3.5a 12340 works them out (Ghidra
 * 2026-11-15: .runtime/re-2026-11-11/spelltext/a.c for 0x007ff180; .runtime/re-2026-11-15/spell7/s1.c and s1.lst for
 * 0x007ff380, 0x007ff3c0, 0x007ff400 and 0x007ff180's ranged branch; .runtime/re-2026-09-30/gw-data/r1.c for 0x00801650
 * and 0x007ff480). GetSpellInfo (0x00540a30) and the tooltip's cast row (0x006238a0) both call 0x007ff180 with its last
 * argument 1, so the time is not clamped at 0 there.
 *
 * **Cast time, 0x007ff180(spell, pet, 0, 1).**
 * 1. The SpellCastTimes row: Base + PerLevel × (the unit's level for the spell − BaseLevel), at least Minimum.
 * 2. SPELLMOD_CASTING_TIME (op 10) as an integer: (t + flat) × pct / 100 (0x007fdb50).
 * 3. Neither Attributes 0x30 (ABILITY, TRADESPELL) nor AttributesEx3 0x20000000 (NO_CASTER_MODIFIERS), and t above 0:
 *    × the unit's UNIT_MOD_CAST_SPEED (unit field +0x128) when it is not 1, as a float rounded to nearest-even.
 *    The unit is the active player, or for a pet spell the player's charm (or summon).
 * 4. Attributes 0x2 (SPELL_ATTR0_RANGED): + 500 ms; then for the player's own spell with an item in the ranged slot
 *    (equipment slot 17) whose template Delay is not 0 and a UNIT_FIELD_RANGEDATTACKTIME not 0: t = RangedAttackTime /
 *    Delay × t, truncated (0x007ff343..0x007ff354: FILD, FIDIV, FIMUL, ftol).
 *
 * **GetSpellInfo's range, 0x00540a30.** With a player (and the unit, the pet for the pet book):
 * - a melee range row (SpellRange flags 1, 0x007ff380): 0 and 0;
 * - else 0x00801650 without a target → 0x007ff480: SPELL_ATTR0 0x404 gives 0 and 100; otherwise the row's slot — the
 *   friendly one when 0x007fe1b0 calls the spell helpful — RangeMin and RangeMax (a ranged row's min also gets the
 *   reach term, overwritten below); SPELL_ATTR0 0x2 on a player × the ranged weapon's RangedModRange %; then
 *   SPELLMOD_RANGE (op 5) on the max;
 * - a ranged row (flags 2, 0x007ff3c0) then takes its min from 0x007ff400: 5 + the slot's RangeMin.
 */

/** The columns these read. */
export type SpellCastTimeRecord = Partial<Pick<SpellMetadata,
  "castTime" | "castTimePerLevel" | "castTimeMinimum" | "rangeMin" | "rangeMax" | "rangeMinFriendly" | "rangeMaxFriendly"
  | "rangeFlags">> & SpellTextCasterRecord;

const SPELLMOD_CASTING_TIME = 10;
const ATTR0_RANGED = 0x2;
const ATTR0_ABILITY_OR_TRADESPELL = 0x30;
const ATTR0_ON_NEXT_SWING_ANY = 0x404;
const ATTR3_NO_CASTER_MODIFIERS = 0x20000000;
const RANGED_CAST_BONUS = 500;
const EQUIPMENT_SLOT_RANGED = 17;
const SPELL_RANGE_MELEE = 1;
const SPELL_RANGE_RANGED = 2;
/** DAT_00a42178: the max of an on-next-swing spell. */
const NEXT_SWING_RANGE = 100;
/** DAT_009ebf34: the nominal melee range 0x007ff400 adds to a ranged row's min. */
const NOMINAL_MELEE_RANGE = 5;

/** 0x007ff180 (see the module comment); undefined when a fact is missing (a level, the ranged item's template). */
export function spellCastTimeFor(record: SpellCastTimeRecord, unit: SpellCostUnit | undefined, pet = false): number | undefined {
  if (record.castTime === undefined) return undefined;
  let time = record.castTime;
  const perLevel = record.castTimePerLevel ?? 0;
  if (perLevel !== 0) {
    const level = unit?.caster ? unit.caster.level(record) : 0;
    if (level === undefined) return undefined;
    time += (level - (record.baseLevel ?? 0)) * perLevel;
  }
  const minimum = record.castTimeMinimum ?? 0;
  if (time < minimum) time = minimum;
  time = spellTextModInt(record, time, SPELLMOD_CASTING_TIME, unit?.caster);
  const attr0 = record.attributes?.[0] ?? 0;
  if ((attr0 & ATTR0_ABILITY_OR_TRADESPELL) === 0 && ((record.attributes?.[3] ?? 0) & ATTR3_NO_CASTER_MODIFIERS) === 0
    && unit && time > 0 && unit.player.slot(UPDATE_FIELDS.UNIT_MOD_CAST_SPEED.offset) !== undefined) {
    // A field this client has not been sent is left alone (Wow.exe always has the word; 1.0 is the server's start).
    const speed = spellTextFloat(unit.player, "UNIT_MOD_CAST_SPEED");
    if (speed !== 1) time = spellTextRoundEven(Math.fround(Math.fround(time) * speed));
  }
  if ((attr0 & ATTR0_RANGED) !== 0) {
    time += RANGED_CAST_BONUS;
    if (!pet && unit?.isActivePlayer) {
      const item = unit.inventoryItem?.(EQUIPMENT_SLOT_RANGED);
      if (item === undefined) return undefined;
      if (item !== null) {
        if (item.delay === undefined) return undefined;
        const attackTime = spellTextInt(unit.player, "UNIT_FIELD_RANGEDATTACKTIME") >>> 0;
        if (item.delay !== 0 && attackTime !== 0) time = Math.trunc((attackTime / item.delay) * time);
      }
    }
  }
  return time;
}

/**
 * GetSpellInfo's minRange and maxRange (0x00540a30, see the module comment) for `unit`; `helpful` is 0x007fe1b0's 1,
 * `rangedModRange` the ranged-slot item's RangedModRange (undefined: no item, or its template not known).
 */
export function spellInfoRangeFor(record: SpellCastTimeRecord, unit: SpellCostUnit, helpful: boolean,
  rangedModRange: () => number | undefined): readonly [number, number] {
  const flags = record.rangeFlags ?? 0;
  if ((flags & SPELL_RANGE_MELEE) !== 0) return [0, 0];
  const attr0 = record.attributes?.[0] ?? 0;
  if ((attr0 & ATTR0_ON_NEXT_SWING_ANY) !== 0) return [0, NEXT_SWING_RANGE];
  const rangeMin = (helpful ? record.rangeMinFriendly ?? record.rangeMin : record.rangeMin) ?? 0;
  let max = (helpful ? record.rangeMaxFriendly ?? record.rangeMax : record.rangeMax) ?? 0;
  if ((attr0 & ATTR0_RANGED) !== 0 && unit.isPlayer) {
    const modRange = rangedModRange();
    if (modRange !== undefined) max = Math.fround(Math.fround(modRange * Math.fround(0.01)) * max);
  }
  max = spellTextModFloat(record, max, SPELLMOD.range, unit.caster);
  const min = (flags & SPELL_RANGE_RANGED) !== 0 ? NOMINAL_MELEE_RANGE + rangeMin : rangeMin;
  return [min, max];
}
