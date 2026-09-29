// What the stock currency tab (Blizzard_TokenUI) reads from the client's own tables.
//
// In 3.3.5a a currency is an item: CurrencyTypes.dbc names the item (ItemID), the heading it is
// listed under (CategoryID → CurrencyCategory.dbc) and its bit in PLAYER_FIELD_KNOWN_CURRENCIES
// (BitIndex; TrinityCore's Player::AddKnownCurrency sets `1 << (BitIndex - 1)`, Player.cpp:26092).
// The server sends none of these tables, so the browser asks for them here once.
//
// Neither table is in the generated DBC_LAYOUTS; both are read with fixed layouts and the header is
// checked against them. TrinityCore declares `CurrencyTypesfmt = "xnxi"` (DBCfmt.h:49: ID, ItemID,
// CategoryID, BitIndex) and keeps CurrencyCategory commented out ("not used", DBCStructure.h:569-576:
// ID, Flags, Name_lang[16], Name_lang_mask). Measured on the tswow dataset: 26 CurrencyTypes rows of
// 4 fields/16 bytes and 8 CurrencyCategory rows of 19 fields/76 bytes.
//
// Rows keep the files' own record order: the client's list order is not documented anywhere this
// project can check, and the record order is the one order the tables themselves carry (the dataset's
// CurrencyCategory ends with «Неактивно», the unused heading).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DBC_LOCALES } from "../generated/dbcLayouts.js";
import { DEFAULT_LOCALE } from "./Dbc.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const CURRENCY_CATALOG_VERSION = 1;

export interface CurrencyCatalogCategory {
  id: number;
  flags: number;
  name: string;
}

export interface CurrencyCatalogType {
  id: number;
  itemId: number;
  categoryId: number;
  bitIndex: number;
}

export interface CurrencyCatalog {
  version: number;
  categories: CurrencyCatalogCategory[];
  types: CurrencyCatalogType[];
}

/** `CurrencyTypesfmt` "xnxi": ID, ItemID, CategoryID, BitIndex. */
export const CURRENCY_TYPES_LAYOUT = Object.freeze({
  fieldCount: 4, recordSize: 16, id: 0, itemId: 1, categoryId: 2, bitIndex: 3,
});
/** CurrencyCategory: ID, Flags, Name_lang[16], Name_lang_mask. */
export const CURRENCY_CATEGORY_LAYOUT = Object.freeze({
  fieldCount: 19, recordSize: 76, id: 0, flags: 1, name: 2,
});

interface RawTable {
  readonly records: number;
  word(row: number, field: number): number;
  text(row: number, field: number): string;
}

function openFixed(data: Buffer, name: string, layout: { fieldCount: number; recordSize: number }): RawTable {
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") throw new Error(`${name}: not a WDBC file`);
  const records = data.readUInt32LE(4);
  const fields = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const stringsSize = data.readUInt32LE(16);
  const stringsOffset = 20 + records * recordSize;
  if (fields !== layout.fieldCount || recordSize !== layout.recordSize || stringsOffset + stringsSize !== data.byteLength) {
    throw new Error(`${name}: ${fields} fields of ${recordSize} bytes, expected ${layout.fieldCount} of ${layout.recordSize}`);
  }
  const at = (row: number, field: number): number => 20 + row * recordSize + field * 4;
  return {
    records,
    word: (row, field) => data.readUInt32LE(at(row, field)),
    text: (row, field) => {
      const offset = data.readUInt32LE(at(row, field));
      if (offset <= 0 || offset >= stringsSize) return "";
      const start = stringsOffset + offset;
      const end = data.indexOf(0, start);
      return end < start ? "" : data.subarray(start, end).toString("utf8");
    },
  };
}

/** The configured client locale's slot first, then enUS, then any filled slot. */
function localized(table: RawTable, row: number, first: number): string {
  const preferred = (DBC_LOCALES as readonly string[]).indexOf(DEFAULT_LOCALE);
  const slots = [preferred, 0, ...Array.from({ length: 16 }, (_unused, index) => index)].filter((slot) => slot >= 0);
  for (const slot of slots) {
    const value = table.text(row, first + slot);
    if (value) return value;
  }
  return "";
}

/** Parse both tables' bytes; exported for the tests, which feed the dataset's files. */
export function parseCurrencyCatalog(typesData: Buffer, categoriesData: Buffer): CurrencyCatalog {
  const types = openFixed(typesData, "CurrencyTypes", CURRENCY_TYPES_LAYOUT);
  const categories = openFixed(categoriesData, "CurrencyCategory", CURRENCY_CATEGORY_LAYOUT);
  const typeLayout = CURRENCY_TYPES_LAYOUT;
  const categoryLayout = CURRENCY_CATEGORY_LAYOUT;
  const catalog: CurrencyCatalog = { version: CURRENCY_CATALOG_VERSION, categories: [], types: [] };
  for (let row = 0; row < categories.records; row++) {
    catalog.categories.push({
      id: categories.word(row, categoryLayout.id),
      flags: categories.word(row, categoryLayout.flags),
      name: localized(categories, row, categoryLayout.name),
    });
  }
  for (let row = 0; row < types.records; row++) {
    catalog.types.push({
      id: types.word(row, typeLayout.id),
      itemId: types.word(row, typeLayout.itemId),
      categoryId: types.word(row, typeLayout.categoryId),
      bitIndex: types.word(row, typeLayout.bitIndex),
    });
  }
  return catalog;
}

export async function loadCurrencyCatalog(dbcDirectory: string): Promise<CurrencyCatalog> {
  const [typesData, categoriesData] = await Promise.all([
    readFile(join(dbcDirectory, "CurrencyTypes.dbc")),
    readFile(join(dbcDirectory, "CurrencyCategory.dbc")),
  ]);
  return parseCurrencyCatalog(typesData, categoriesData);
}
