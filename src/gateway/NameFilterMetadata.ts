// The name filters (plan item 1.19): NamesProfanity.dbc, ChatProfanity.dbc and NamesReserved.dbc, served once per
// page as `/dbc/name-filters?v=1` (CatalogRoutes.ts) for the client's own check of a new character's or pet's name
// (browser/glue/GlueNameFilters.ts).
//
// Wow.exe 3.3.5a 12340 (read-only Ghidra, .runtime/re-2026-11-11/glue): on the way to the character list
// (0x4dab40 → 0x7e2250) the client compiles, for every locale bit of the realm category's LocaleMask (or its own
// locale's bit without a row), the rows of the three tables whose `Language` is that locale index or -1 — in file
// order, a pattern that does not compile skipped with "Warning: invalid … filter expression" — into three lists per
// locale (0xd37e28 «profane names», 0xd37ea0 «chat profanity», 0xd37f10 «reserved names»). The name check reads the
// lists of the client's own locale (DAT_00c5de9c, ruRU = 8).
//
// Layout: three 4-byte fields, `{ID, Name, Language}` — DBCfmt.h "dsi" for NamesProfanity and NamesReserved, and
// the same 12-byte record in the file header of ChatProfanity, which TrinityCore does not load; 0x7e2250 reads
// `record[1]` as the pattern and `record[2]` as the language with a 0xc stride in all three. Measured on this dataset:
// NamesProfanity 8,267 rows, NamesReserved 16,330, ChatProfanity 5,222; for ruRU (8) and -1: 154, 15 and 60.
//
// Only the gateway's own locale's rows (and -1's) are served: the browser is that client, and the whole tables are
// ~0.6 MB of patterns the check never reads.

import { DBC_LOCALES } from "../generated/dbcLayouts.js";
import type { DbcLocale } from "../generated/dbcLayouts.js";
import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const NAME_FILTERS_VERSION = 1;

export const NAME_FILTER_LAYOUT = Object.freeze({ fieldCount: 3, recordSize: 12 });
const PATTERN_FIELD = 1;
const LANGUAGE_FIELD = 2;

export interface NameFilterCatalog {
  version: number;
  /** The client locale index the rows were chosen for (enUS 0 … ruRU 8). */
  locale: number;
  /** NamesProfanity patterns, file order. */
  profane: string[];
  /** ChatProfanity patterns, file order. */
  chat: string[];
  /** NamesReserved patterns, file order. */
  reserved: string[];
}

function patternsFor(rows: FixedRows, locale: number): string[] {
  const patterns: string[] = [];
  for (let row = 0; row < rows.records; row++) {
    const language = rows.int(row, LANGUAGE_FIELD);
    if (language === locale || language === -1) patterns.push(rows.string(row, PATTERN_FIELD));
  }
  return patterns;
}

/** The catalog out of already-checked rows; pure, so a test can feed it synthetic files. */
export function nameFilterCatalog(
  tables: { readonly profane: FixedRows; readonly chat: FixedRows; readonly reserved: FixedRows },
  locale: DbcLocale = DEFAULT_LOCALE,
): NameFilterCatalog {
  const index = (DBC_LOCALES as readonly string[]).indexOf(locale);
  return {
    version: NAME_FILTERS_VERSION,
    locale: index,
    profane: patternsFor(tables.profane, index),
    chat: patternsFor(tables.chat, index),
    reserved: patternsFor(tables.reserved, index),
  };
}

export async function loadNameFilters(dbcDirectory: string): Promise<NameFilterCatalog> {
  const [profane, chat, reserved] = await Promise.all([
    readFixed(dbcDirectory, "NamesProfanity", NAME_FILTER_LAYOUT),
    readFixed(dbcDirectory, "ChatProfanity", NAME_FILTER_LAYOUT),
    readFixed(dbcDirectory, "NamesReserved", NAME_FILTER_LAYOUT),
  ]);
  return nameFilterCatalog({ profane, chat, reserved });
}
