/**
 * Plan item 3.23C: `GetCritChanceFromAgility(unit)`, `GetUnitHealthRegenRateFromSpirit(unit)` and
 * `GetUnitManaRegenRateFromSpirit(unit)` as Wow.exe 3.3.5a 12340 answers them (read 2026-10-02), over
 * the game tables of `/dbc/character-regen` (CharacterRegenClient.ts).
 *
 * The three Lua functions (0x60e130, 0x612980, 0x612a00) take a unit token; a unit that is the active
 * player, or one with a UNIT_FIELD_PETNUMBER (a hunter's or warlock's pet), is measured by its own class,
 * level and stats; any other unit — or none — answers 0. The stats are the unit's UNIT_FIELD_STAT1/3/4,
 * a negative value read as 0. Each game table is read at (class - 1) × 100 + level - 1 (0x7f6990); the
 * crit base table one row per class.
 *
 * - Crit (0x71bae0): 0 when the class/level ratio is 0, else (ratio × agility + base) × 100 — the core's
 *   Player::GetMeleeCritFromAgility.
 * - Health (0x71ba60): the first 50 spirit at gtOCTRegenHP, the rest at gtRegenHPPerSpt — the core's
 *   Player::OCTRegenHPPerSpirit.
 * - Mana (0x71b9f0): √intellect × gtRegenMPPerSpt × spirit, and the Lua function adds 0.001 (a float,
 *   0x9e1134) to it — the core's 0.001 + √int × OCTRegenMPPerSpirit in Player::UpdateManaRegen.
 *
 * A table not loaded yet, or a class/level outside it, answers 0 (the value before the route existed).
 */

import type { CharacterRegenTables } from "../CharacterRegenClient.js";

const GT_MAX_LEVEL = 100;
/** DAT_00adaa10: the spirit counted at the gtOCTRegenHP rate. */
export const FRAMEXML_REGEN_BASE_SPIRIT = 50;
/** 0x9e1134, the float the mana answer adds. */
export const FRAMEXML_MANA_REGEN_EPSILON = Math.fround(0.001);

export interface FrameXmlRegenUnit {
  readonly classId: number;
  readonly level: number;
  readonly agility: number;
  readonly intellect: number;
  readonly spirit: number;
}

function stat(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function row(table: readonly number[] | undefined, classId: number, level: number): number {
  if (!table || !Number.isInteger(classId) || !Number.isInteger(level) || classId < 1 || level < 1 || level > GT_MAX_LEVEL) {
    return 0;
  }
  return table[(classId - 1) * GT_MAX_LEVEL + level - 1] ?? 0;
}

export function frameXmlCritChanceFromAgility(tables: CharacterRegenTables | undefined, unit: FrameXmlRegenUnit | undefined): number {
  if (!tables || !unit) return 0;
  const ratio = row(tables.meleeCritPerAgility, unit.classId, unit.level);
  if (ratio === 0) return 0;
  const base = Number.isInteger(unit.classId) && unit.classId >= 1 ? tables.meleeCritBase[unit.classId - 1] ?? 0 : 0;
  return (ratio * stat(unit.agility) + base) * 100;
}

export function frameXmlHealthRegenFromSpirit(tables: CharacterRegenTables | undefined, unit: FrameXmlRegenUnit | undefined): number {
  if (!tables || !unit) return 0;
  const spirit = stat(unit.spirit);
  const base = Math.min(spirit, FRAMEXML_REGEN_BASE_SPIRIT);
  return base * row(tables.healthPerBaseSpirit, unit.classId, unit.level)
    + row(tables.healthPerSpirit, unit.classId, unit.level) * (spirit - base);
}

export function frameXmlManaRegenFromSpirit(tables: CharacterRegenTables | undefined, unit: FrameXmlRegenUnit | undefined): number {
  if (!tables || !unit) return 0;
  return Math.sqrt(stat(unit.intellect)) * row(tables.manaPerSpirit, unit.classId, unit.level) * stat(unit.spirit)
    + FRAMEXML_MANA_REGEN_EPSILON;
}
