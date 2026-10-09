// 05.10-petfood: a hunter pet's diet for the browser, `GET /dbc/pet-foods?v=1` — a row of
// CatalogRoutes.ts (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the memo dropped).
//
// Why: the stock pet page's diet tooltip (PetPaperDollFrame.xml:298) and the stable's (PetStable.lua:140)
// format `BuildListString(GetPetFoodTypes())`. Wow.exe 3.3.5a 12340 answers `GetPetFoodTypes` at 0x005d3bd0
// (registration beside its name at .data 0x00ad0d00; notes .runtime/re-2026-10-05/l-petfood/g1.c): the pet
// unit of PetInfo, only a hunter's (0x0071b630), its creature cache family (0x007153e0), that
// CreatureFamily row's PetFoodMask (record +0x1c), and then every ItemPetFood row in table order whose
// bit `1 << (ID - 1)` is set pushes its name. `GetStablePetFoodTypes` (0x005a16a0) walks the same two
// tables for a stabled pet's family.
//
// Layouts: CreatureFamily "nfifiiiiixssssssssssssssssxx" (DBCfmt.h:45; PetFoodMask is field 7,
// DBCStructure.h:506; tools/dbd/CreatureFamily.dbd 3.0.1.8622-3.3.5.12340), 28 fields, 112 bytes.
// ItemPetFood has no TrinityCore format (the core keeps the food type on item_template, Pet.cpp:1140-1152,
// with the same `1 << (FoodType - 1)` test); its WDBC header says 18 fields, 72 bytes: ID and Name_lang
// (16 locales + flags). Measured on this dataset: 8 rows, the names only in the ruRU slot.
//
//   { version: 1, families: [[familyId, petFoodMask], …], foods: [[id, name], …] }
//   — families with a non-zero mask; foods every row in file order (the order the client pushes them).

import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import { fixedLocstring } from "./DungeonEncounterMetadata.js";
import { CREATURE_FAMILY_LAYOUT } from "./CreatureTypeMetadata.js";
import type { DbcLocale } from "../generated/dbcLayouts.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const PET_FOODS_VERSION = 1;

export const ITEM_PET_FOOD_LAYOUT = Object.freeze({ fieldCount: 18, recordSize: 72 });

const FAMILY_PET_FOOD_MASK_FIELD = 7;
const FOOD_NAME_FIELD = 1;

export interface PetFoodCatalog {
  version: number;
  /** CreatureFamily rows whose PetFoodMask is not 0: `[familyId, petFoodMask]` (mask unsigned). */
  families: [id: number, mask: number][];
  /** ItemPetFood rows in file order: `[id, name]`. */
  foods: [id: number, name: string][];
}

/** The catalog out of already-checked rows; pure, so a test can feed it synthetic files. */
export function petFoodCatalog(families: FixedRows, foods: FixedRows, locale: DbcLocale = DEFAULT_LOCALE): PetFoodCatalog {
  const familyRows: [number, number][] = [];
  for (let row = 0; row < families.records; row++) {
    const mask = families.int(row, FAMILY_PET_FOOD_MASK_FIELD) >>> 0;
    if (mask !== 0) familyRows.push([families.int(row, 0), mask]);
  }
  const foodRows: [number, string][] = [];
  for (let row = 0; row < foods.records; row++) {
    foodRows.push([foods.int(row, 0), fixedLocstring(foods, row, FOOD_NAME_FIELD, locale)]);
  }
  return { version: PET_FOODS_VERSION, families: familyRows, foods: foodRows };
}

export async function loadPetFoods(dbcDirectory: string): Promise<PetFoodCatalog> {
  const [families, foods] = await Promise.all([
    readFixed(dbcDirectory, "CreatureFamily", CREATURE_FAMILY_LAYOUT),
    readFixed(dbcDirectory, "ItemPetFood", ITEM_PET_FOOD_LAYOUT),
  ]);
  return petFoodCatalog(families, foods);
}
