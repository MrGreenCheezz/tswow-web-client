// The boss table behind the stock instance-lock dialog (plan item 2.09): DungeonEncounter.dbc,
// served once per page as `/dbc/dungeon-encounters?v=1` (CatalogRoutes.ts).
//
// SMSG_INSTANCE_LOCK_WARNING_QUERY carries only a killed-boss mask, `1 << DungeonEncounter.Bit`
// per boss (`InstanceScript.cpp:940`). How many bosses there are and what they are called is this
// table: the original client walks its rows in file order, keeps those of the instance's map and
// difficulty, counts them for the total and tests each row's Bit against the mask (Wow.exe
// 0x00553830 for GetInstanceLockTimeRemaining's two last values; 0x005538b0 for the i-th match's
// name, SpellIcon texture and killed flag, shared by GetInstanceLockTimeRemainingEncounter,
// GetLFGProposalEncounter and SearchLFGGetEncounterResults). OrderIndex is not consulted; the file
// is already in OrderIndex order within each map and difficulty on this dataset.
//
// Not in the generated DBC_LAYOUTS; read with TrinityCore's format for build 12340 (DBCfmt.h:51):
// `DungeonEncounterfmt = "niixissssssssssssssssxx"` — {ID, MapID, Difficulty, OrderIndex, Bit,
// Name[16], Name_lang_mask, SpellIconID} (DBCStructure.h:610), 23 fields, 92 bytes. Measured on
// this dataset: 612 rows in 117 map/difficulty groups, Bit unique within each group (0..18), only
// the ruRU name slot filled, SpellIconID 0 in every row (the texture is then nil in the client).

import { DBC_LOCALES, DBC_LOCSTRING_FIELDS, type DbcLocale } from "../generated/dbcLayouts.js";
import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const DUNGEON_ENCOUNTERS_VERSION = 1;

export const DUNGEON_ENCOUNTER_LAYOUT = Object.freeze({ fieldCount: 23, recordSize: 92 });
const ID_FIELD = 0;
const MAP_FIELD = 1;
const DIFFICULTY_FIELD = 2;
const BIT_FIELD = 4;
const NAME_FIELD = 5;
const FALLBACK_LOCALE: DbcLocale = "enUS";

/** One row: `[id, mapId, difficulty, bit, name]`. */
export type DungeonEncounterRow = [id: number, mapId: number, difficulty: number, bit: number, name: string];

export interface DungeonEncounterCatalog {
  version: number;
  /** Every row in file order — the order the client numbers a map's encounters in. */
  encounters: DungeonEncounterRow[];
}

/** One locale of a localised string, then enUS, then any filled slot — as Dbc.locstring reads them. */
export function fixedLocstring(rows: FixedRows, row: number, field: number, locale: DbcLocale): string {
  for (const candidate of [locale, FALLBACK_LOCALE]) {
    const slot = (DBC_LOCALES as readonly string[]).indexOf(candidate);
    if (slot < 0) continue;
    const value = rows.string(row, field + slot);
    if (value) return value;
  }
  for (let slot = 0; slot < DBC_LOCSTRING_FIELDS - 1; slot++) {
    const value = rows.string(row, field + slot);
    if (value) return value;
  }
  return "";
}

/** The catalog out of already-checked rows; pure, so a test can feed it a synthetic file. */
export function dungeonEncounterCatalog(rows: FixedRows, locale: DbcLocale = DEFAULT_LOCALE): DungeonEncounterCatalog {
  const encounters: DungeonEncounterRow[] = [];
  for (let row = 0; row < rows.records; row++) {
    // Every row is kept, in place: the client's i-th encounter is the i-th matching row.
    encounters.push([
      rows.int(row, ID_FIELD), rows.int(row, MAP_FIELD), rows.int(row, DIFFICULTY_FIELD),
      rows.int(row, BIT_FIELD), fixedLocstring(rows, row, NAME_FIELD, locale),
    ]);
  }
  return { version: DUNGEON_ENCOUNTERS_VERSION, encounters };
}

export async function loadDungeonEncounters(dbcDirectory: string): Promise<DungeonEncounterCatalog> {
  return dungeonEncounterCatalog(await readFixed(dbcDirectory, "DungeonEncounter", DUNGEON_ENCOUNTER_LAYOUT));
}
