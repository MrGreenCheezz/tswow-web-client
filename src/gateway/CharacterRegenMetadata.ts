// The class/level tables behind `GetCritChanceFromAgility`, `GetUnitHealthRegenRateFromSpirit` and
// `GetUnitManaRegenRateFromSpirit` (plan item 3.23C), served once per page as
// `/dbc/character-regen?v=1` (CatalogRoutes.ts).
//
// The original client (Wow.exe 3.3.5a 12340, read 2026-10-02) reads five game tables through 0x7f6990
// (table, row, column = class - 1): table 3 (gtChanceToMeleeCritBase, row 0), 2 (gtChanceToMeleeCrit,
// row level - 1), 7 (gtOCTRegenHP), 9 (gtRegenHPPerSpt) and 10 (gtRegenMPPerSpt), the same five
// TrinityCore's Player::GetMeleeCritFromAgility / OCTRegenHPPerSpirit / OCTRegenMPPerSpirit read
// (DBCStores.cpp:336-345). Every one is DBCfmt.h's "f": one float a row, rows implicit — a class's
// hundred levels in a row (GT_MAX_LEVEL), the base table one row per class.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHARACTER_STAT_MAX_LEVEL, parseCharacterStatTable } from "../world/CharacterStatData.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const CHARACTER_REGEN_VERSION = 1;

export interface CharacterRegenCatalog {
  version: number;
  /** gtChanceToMeleeCritBase: one row per class. */
  meleeCritBase: number[];
  /** gtChanceToMeleeCrit: (class - 1) × 100 + level - 1. */
  meleeCritPerAgility: number[];
  /** gtOCTRegenHP: the health per point of the first 50 spirit. */
  healthPerBaseSpirit: number[];
  /** gtRegenHPPerSpt: the health per point of spirit above 50. */
  healthPerSpirit: number[];
  /** gtRegenMPPerSpt: the mana per point of spirit (times √intellect). */
  manaPerSpirit: number[];
}

export async function loadCharacterRegen(directory: string): Promise<CharacterRegenCatalog> {
  const [critBase, crit, hpBase, hp, mp] = await Promise.all([
    "gtChanceToMeleeCritBase.dbc", "gtChanceToMeleeCrit.dbc", "gtOCTRegenHP.dbc", "gtRegenHPPerSpt.dbc", "gtRegenMPPerSpt.dbc",
  ].map((name) => readFile(join(directory, name))));
  const catalog: CharacterRegenCatalog = {
    version: CHARACTER_REGEN_VERSION,
    meleeCritBase: [...parseCharacterStatTable(critBase!)],
    meleeCritPerAgility: [...parseCharacterStatTable(crit!)],
    healthPerBaseSpirit: [...parseCharacterStatTable(hpBase!)],
    healthPerSpirit: [...parseCharacterStatTable(hp!)],
    manaPerSpirit: [...parseCharacterStatTable(mp!)],
  };
  const classes = catalog.meleeCritBase.length;
  for (const table of [catalog.meleeCritPerAgility, catalog.healthPerBaseSpirit, catalog.healthPerSpirit, catalog.manaPerSpirit]) {
    if (table.length !== classes * CHARACTER_STAT_MAX_LEVEL) {
      throw new Error("Character regen tables: class/level rows disagree");
    }
  }
  return catalog;
}
