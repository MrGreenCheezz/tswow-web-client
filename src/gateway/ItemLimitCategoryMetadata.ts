// 05.10-3.01: ItemLimitCategory.dbc for the browser, `GET /dbc/item-limit-categories?v=1` — a row of
// CatalogRoutes.ts (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the memo dropped).
//
// Why: SMSG_CAST_FAILED with SPELL_FAILED_TOO_MANY_OF_ITEM (129) carries the item's limit category
// (Spell.cpp:4243-4262, `proto->ItemLimitCategory`). Wow.exe's refusal handler 0x00808200 looks the id up in
// this table (the client DB at 0x00ad3e60, call at 0x00808a90 — the same object the item tooltip's
// ITEM_LIMIT_CATEGORY lines read near 0x006280a1) and, when the row is there, says
// ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED_IS (game error 0x272, 0x00807f10) with the row's Quantity
// (record +8) and Name (record +4) instead of the plain SPELL_FAILED_TOO_MANY_OF_ITEM — and writes that text
// to the combat log past its repeat rules (0x00808aa5 → 0x005216f0, 0x00808ac3 → 0x00751ad0).
//
// Layout: TrinityCore's ItemLimitCategoryEntryfmt "nxxxxxxxxxxxxxxxxxii" (DBCfmt.h:84) — ID, Name_lang
// (16 locales + flags), Quantity, Flags: 20 fields, 80 bytes. Measured on this dataset: 83 rows.
//
//   { version: 1, categories: [[id, name, quantity, flags], …] }  — every row in file order.

import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import { fixedLocstring } from "./DungeonEncounterMetadata.js";
import type { DbcLocale } from "../generated/dbcLayouts.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const ITEM_LIMIT_CATEGORIES_VERSION = 1;

export const ITEM_LIMIT_CATEGORY_LAYOUT = Object.freeze({ fieldCount: 20, recordSize: 80 });
const ID_FIELD = 0;
const NAME_FIELD = 1;
const QUANTITY_FIELD = 18;
const FLAGS_FIELD = 19;

/** One row: `[id, name, quantity, flags]`. */
export type ItemLimitCategoryRow = [id: number, name: string, quantity: number, flags: number];

export interface ItemLimitCategoryCatalog {
  version: number;
  categories: ItemLimitCategoryRow[];
}

/** The catalog out of already-checked rows; pure, so a test can feed it a synthetic file. */
export function itemLimitCategoryCatalog(rows: FixedRows, locale: DbcLocale = DEFAULT_LOCALE): ItemLimitCategoryCatalog {
  const categories: ItemLimitCategoryRow[] = [];
  for (let row = 0; row < rows.records; row++) {
    categories.push([
      rows.int(row, ID_FIELD), fixedLocstring(rows, row, NAME_FIELD, locale), rows.int(row, QUANTITY_FIELD),
      rows.int(row, FLAGS_FIELD) >>> 0,
    ]);
  }
  return { version: ITEM_LIMIT_CATEGORIES_VERSION, categories };
}

export async function loadItemLimitCategories(dbcDirectory: string): Promise<ItemLimitCategoryCatalog> {
  return itemLimitCategoryCatalog(await readFixed(dbcDirectory, "ItemLimitCategory", ITEM_LIMIT_CATEGORY_LAYOUT));
}
