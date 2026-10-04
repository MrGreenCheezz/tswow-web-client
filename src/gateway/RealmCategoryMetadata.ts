// The realm-list categories (plan items 10.08 and 1.19): Cfg_Categories.dbc, served once per page as
// `/dbc/realm-categories?v=1` (CatalogRoutes.ts).
//
// The authserver names a realm's category by number only — the byte TrinityCore calls `timezone`
// (`realmlist.timezone`, written by AuthSession's realm list). The original client turns it into
// the realm list's tab names and into the alphabets a new character's name may use:
//
// * `GetRealmCategories` (Wow.exe 0x4df110) pushes, for every category that holds a realm, the
//   `Name_lang` of its Cfg_Categories row (record offset 0x10), or "UNKNOWN" when the row is missing.
// * On the way to the character list (0x4dab40 → 0x7e2250) the current realm's category row gives
//   the name filters their `LocaleMask` (offset 4) and the name check its `Create_charset_mask`
//   (offset 8) — the alphabet mask FUN_007e18c0 tests a name's first letter against (bit 0 Latin
//   with Latin-1, 1 ASCII, 2 Cyrillic, 3 Hangul, 4 CJK). No row: the client's own locale bit and a
//   charset mask of 0 (every alphabet).
//
// Not loaded by TrinityCore (no format in DBCfmt.h); the layout is WoWDBDefs' for 3.3.5.12340:
// {ID, LocaleMask, Create_charset_mask, Flags, Name_lang[17]} — 21 fields, 84 bytes. Measured on this
// dataset: 37 rows; «Разработка» (1) mask 0, the four US/Oceanic/Latin/Tournament rows 1 (Latin),
// Korea 10 (ASCII + Hangul), the five European language rows 1, «Русский» (12) 4 (Cyrillic), the
// Taiwanese and Chinese rows 17 (Latin + CJK). TrinityCore's default `realmlist.timezone` is 1.

import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import { fixedLocstring } from "./DungeonEncounterMetadata.js";
import type { DbcLocale } from "../generated/dbcLayouts.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const REALM_CATEGORIES_VERSION = 1;

export const REALM_CATEGORY_LAYOUT = Object.freeze({ fieldCount: 21, recordSize: 84 });
const ID_FIELD = 0;
const LOCALE_MASK_FIELD = 1;
const CHARSET_MASK_FIELD = 2;
const FLAGS_FIELD = 3;
const NAME_FIELD = 4;

/** One row: `[id, localeMask, createCharsetMask, flags, name]`. */
export type RealmCategoryRow = [id: number, localeMask: number, createCharsetMask: number, flags: number, name: string];

export interface RealmCategoryCatalog {
  version: number;
  /** Every Cfg_Categories row in file order. */
  categories: RealmCategoryRow[];
}

/** The catalog out of already-checked rows; pure, so a test can feed it a synthetic file. */
export function realmCategoryCatalog(rows: FixedRows, locale: DbcLocale = DEFAULT_LOCALE): RealmCategoryCatalog {
  const categories: RealmCategoryRow[] = [];
  for (let row = 0; row < rows.records; row++) {
    categories.push([
      rows.int(row, ID_FIELD), rows.int(row, LOCALE_MASK_FIELD) >>> 0, rows.int(row, CHARSET_MASK_FIELD) >>> 0,
      rows.int(row, FLAGS_FIELD) >>> 0, fixedLocstring(rows, row, NAME_FIELD, locale),
    ]);
  }
  return { version: REALM_CATEGORIES_VERSION, categories };
}

export async function loadRealmCategories(dbcDirectory: string): Promise<RealmCategoryCatalog> {
  return realmCategoryCatalog(await readFixed(dbcDirectory, "Cfg_Categories", REALM_CATEGORY_LAYOUT));
}
