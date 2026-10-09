// The creature type and family names behind `UnitCreatureType` and `UnitCreatureFamily` (plan item
// 3.23A), served once per page as `/dbc/creature-types?v=1` (CatalogRoutes.ts).
//
// The original client (Wow.exe 3.3.5a 12340, read-only), in this file's words:
//
// * `UnitCreatureType(unit)` (0x611780) names a CreatureType.dbc row (`Name_lang`). The row comes
//   from 0x71f300: the unit's shapeshift form (UNIT_FIELD_BYTES_2 byte 3) when its
//   SpellShapeshiftForm row has a `CreatureType` above 0 (bear and cat forms are beasts); otherwise
//   the creature cache's type; otherwise — a player — the race's `ChrRaces.CreatureType`.
// * `UnitCreatureFamily(unit)` (0x611820) names the CreatureFamily.dbc row of the creature cache's
//   family; a unit with no cache entry (a player) answers nil.
//
// Formats from TrinityCore's DBCfmt.h for build 12340: CreatureType "nxxxxxxxxxxxxxxxxxx" (19 fields:
// ID, Name_lang[17], Flags); CreatureFamily "nfifiiiiixssssssssssssssssxx" (28: Name_lang at 10);
// ChrRaces 69 fields (CreatureType at 8, DBCStructure.h:430); SpellShapeshiftForm 35 fields
// (CreatureType at 20, DBCStructure.h:1635). Measured on this dataset: 13, 40, 21 and 32 rows; the
// type names are only in the ruRU slot («Животное», «Существо», «Облако газа»…).

import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import { fixedLocstring } from "./DungeonEncounterMetadata.js";
import type { DbcLocale } from "../generated/dbcLayouts.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const CREATURE_TYPES_VERSION = 1;

export const CREATURE_TYPE_LAYOUT = Object.freeze({ fieldCount: 19, recordSize: 76 });
export const CREATURE_FAMILY_LAYOUT = Object.freeze({ fieldCount: 28, recordSize: 112 });
export const CHR_RACES_LAYOUT = Object.freeze({ fieldCount: 69, recordSize: 276 });
export const SPELL_SHAPESHIFT_FORM_LAYOUT = Object.freeze({ fieldCount: 35, recordSize: 140 });

const TYPE_NAME_FIELD = 1;
const FAMILY_NAME_FIELD = 10;
const RACE_CREATURE_TYPE_FIELD = 8;
const FORM_CREATURE_TYPE_FIELD = 20;

export interface CreatureTypeCatalog {
  version: number;
  /** CreatureType rows: `[id, name]`. */
  types: [id: number, name: string][];
  /** CreatureFamily rows: `[id, name]`. */
  families: [id: number, name: string][];
  /** ChrRaces: `[raceId, creatureType]`. */
  races: [id: number, creatureType: number][];
  /** SpellShapeshiftForm rows whose CreatureType is above 0: `[formId, creatureType]`. */
  forms: [id: number, creatureType: number][];
}

function names(rows: FixedRows, field: number, locale: DbcLocale): [number, string][] {
  const out: [number, string][] = [];
  for (let row = 0; row < rows.records; row++) out.push([rows.int(row, 0), fixedLocstring(rows, row, field, locale)]);
  return out;
}

function numbers(rows: FixedRows, field: number, keep: (value: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let row = 0; row < rows.records; row++) {
    const value = rows.int(row, field);
    if (keep(value)) out.push([rows.int(row, 0), value]);
  }
  return out;
}

/** The catalog out of already-checked rows; pure, so a test can feed it synthetic files. */
export function creatureTypeCatalog(
  types: FixedRows, families: FixedRows, races: FixedRows, forms: FixedRows, locale: DbcLocale = DEFAULT_LOCALE,
): CreatureTypeCatalog {
  return {
    version: CREATURE_TYPES_VERSION,
    types: names(types, TYPE_NAME_FIELD, locale),
    families: names(families, FAMILY_NAME_FIELD, locale),
    races: numbers(races, RACE_CREATURE_TYPE_FIELD, () => true),
    forms: numbers(forms, FORM_CREATURE_TYPE_FIELD, (value) => value > 0),
  };
}

export async function loadCreatureTypes(dbcDirectory: string): Promise<CreatureTypeCatalog> {
  const [types, families, races, forms] = await Promise.all([
    readFixed(dbcDirectory, "CreatureType", CREATURE_TYPE_LAYOUT),
    readFixed(dbcDirectory, "CreatureFamily", CREATURE_FAMILY_LAYOUT),
    readFixed(dbcDirectory, "ChrRaces", CHR_RACES_LAYOUT),
    readFixed(dbcDirectory, "SpellShapeshiftForm", SPELL_SHAPESHIFT_FORM_LAYOUT),
  ]);
  return creatureTypeCatalog(types, families, races, forms);
}
