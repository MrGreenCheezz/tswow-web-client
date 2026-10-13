/**
 * Plan item 4.03 (13.10): the two C API answers the first line of the stock stamina and intellect tooltips
 * reads (PaperDollFrame.lua:277-296: DEFAULT_STAT3_TOOLTIP with `GetUnitMaxHealthModifier`, DEFAULT_STAT4_TOOLTIP
 * with `GetSpellCritChanceFromIntellect`), as Wow.exe 3.3.5a 12340 answers them (read-only Ghidra 2026-10-13,
 * `.runtime/re-2026-10-11/glue-1110/t1013-b.txt`, `-c.txt`):
 *
 * * `GetUnitMaxHealthModifier(unit)` 0x00612870: for the active player (0x004cee50) or a unit with a pet number
 *   (UNIT_FIELD_PETNUMBER, +0x114) the float UNIT_FIELD_MAXHEALTHMODIFIER (+0x22c) plus 1.0f (0x009e1130); any other
 *   unit, or none, 0. TrinityCore never writes the field, so the player's answer is 1.
 * * `GetSpellCritChanceFromIntellect(unit)` 0x0060e1b0 → 0x0071bb70, the same two units, else 0: the class's
 *   gtChanceToSpellCrit ratio at the unit's level (0x007f6990 table 4) — 0 when that ratio is 0 — times the
 *   intellect (UNIT_FIELD_STAT3, +0x144, a negative value read as 0), plus the class's gtChanceToSpellCritBase
 *   (table 5), times 100.
 */
import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { CHARACTER_STAT_MAX_LEVEL, type CharacterStatCatalog } from "./CharacterStatData.js";
import { readByte, readField } from "./Fields.js";
import type { WorldObjectState } from "./WorldState.js";

/** The units 0x00612870 and 0x0060e1b0 answer for: the active player, or anything with a pet number. */
export function statTooltipUnit(object: WorldObjectState | undefined, selfGuid: bigint | undefined): object is WorldObjectState {
  return object !== undefined && (object.guid === selfGuid || (readField(object, "UNIT_FIELD_PETNUMBER") ?? 0) !== 0);
}

/** 0x00612870: UNIT_FIELD_MAXHEALTHMODIFIER + 1.0f for the player or a pet, else 0. */
export function maxHealthModifierOf(object: WorldObjectState | undefined, selfGuid: bigint | undefined): number {
  if (!statTooltipUnit(object, selfGuid)) return 0;
  return Math.fround((readField(object, "UNIT_FIELD_MAXHEALTHMODIFIER") ?? 0) + 1);
}

/** 0x0071bb70 over the stat catalog; 0 for any other unit, without the catalog, or with a zero ratio. */
export function spellCritFromIntellectOf(
  object: WorldObjectState | undefined, selfGuid: bigint | undefined, catalog: CharacterStatCatalog | undefined,
): number {
  if (!catalog || !statTooltipUnit(object, selfGuid)) return 0;
  const classId = readByte(object, "UNIT_FIELD_BYTES_0", 1) ?? 0;
  const level = (readField(object, "UNIT_FIELD_LEVEL") ?? 0) | 0;
  if (classId < 1 || level < 1) return 0;
  const ratio = catalog.spellCritPerIntellect[(classId - 1) * CHARACTER_STAT_MAX_LEVEL + Math.min(level, CHARACTER_STAT_MAX_LEVEL) - 1];
  if (ratio === undefined || ratio === 0) return 0;
  const base = catalog.spellCritBase[classId - 1] ?? 0;
  const intellect = (object.fields.get(UPDATE_FIELDS.UNIT_FIELD_STAT0.offset + 3) ?? 0) | 0;
  return (ratio * Math.max(0, intellect) + base) * 100;
}
