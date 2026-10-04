// The quest log's words the realm never sends (plan item 3.13a): QuestSort.dbc and QuestInfo.dbc,
// served once per page as `/dbc/quest-log-names?v=1` (CatalogRoutes.ts).
//
// The original client (Wow.exe 3.3.5a 12340, read-only), in this file's words:
//
// * A quest log header is the quest's `ZoneOrSort` (quest cache offset 0x10). `GetQuestLogTitle`'s
//   header name (0x005e0000) is AreaTable's `AreaName_lang` for a positive key and QuestSort's
//   `SortName_lang` (record offset 4) for a negative one, by its absolute value; key 0 is the
//   literal "Missing header! (quest designers)". The headers are ordered by that name (0x005dfdc0).
// * `GetQuestLogTitle`'s third value, questTag (0x005e0070), is QuestInfo's `InfoName_lang` (offset 4)
//   for the quest's `Type` (cache offset 0x14); a type with no row answers nil.
//
// Area names come from the areas catalog the map already loads; this route carries only the two
// small tables. TrinityCore declares QuestSort as "nxxxxxxxxxxxxxxxxx" (DBCfmt.h:101) — an id and a
// 17-field locstring, 18 fields of 4 bytes — and does not load QuestInfo; measured on this dataset
// both files are 18 fields × 72 bytes (41 and 11 rows).

import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import { fixedLocstring } from "./DungeonEncounterMetadata.js";
import type { DbcLocale } from "../generated/dbcLayouts.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const QUEST_LOG_NAMES_VERSION = 1;

export const QUEST_LOG_NAME_LAYOUT = Object.freeze({ fieldCount: 18, recordSize: 72 });
const ID_FIELD = 0;
const NAME_FIELD = 1;

/** One row: `[id, name]`. */
export type QuestLogNameRow = [id: number, name: string];

export interface QuestLogNameCatalog {
  version: number;
  /** QuestSort rows in file order: the negative-`ZoneOrSort` headers. */
  sorts: QuestLogNameRow[];
  /** QuestInfo rows in file order: questTag by quest `Type`. */
  infos: QuestLogNameRow[];
}

function namedRows(rows: FixedRows, locale: DbcLocale): QuestLogNameRow[] {
  const out: QuestLogNameRow[] = [];
  for (let row = 0; row < rows.records; row++) {
    out.push([rows.int(row, ID_FIELD), fixedLocstring(rows, row, NAME_FIELD, locale)]);
  }
  return out;
}

/** The catalog out of already-checked rows; pure, so a test can feed it synthetic files. */
export function questLogNameCatalog(sorts: FixedRows, infos: FixedRows, locale: DbcLocale = DEFAULT_LOCALE): QuestLogNameCatalog {
  return { version: QUEST_LOG_NAMES_VERSION, sorts: namedRows(sorts, locale), infos: namedRows(infos, locale) };
}

export async function loadQuestLogNames(dbcDirectory: string): Promise<QuestLogNameCatalog> {
  const [sorts, infos] = await Promise.all([
    readFixed(dbcDirectory, "QuestSort", QUEST_LOG_NAME_LAYOUT),
    readFixed(dbcDirectory, "QuestInfo", QUEST_LOG_NAME_LAYOUT),
  ]);
  return questLogNameCatalog(sorts, infos);
}
