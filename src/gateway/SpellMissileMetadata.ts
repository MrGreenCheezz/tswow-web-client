// 11.02-E-review: the missile tables for the browser, `GET /dbc/spell-missiles?v=1` — a row of CatalogRoutes.ts
// (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the memo dropped). The shape is the
// contract in world/SpellMissileDbc.ts, which the page's SpellMissileClient.ts reads:
//
//   { version: 1, missiles: [[ID, Flags, 13 floats in file order], …], spells: [[spellId, SpellMissileID], …] }
//
// - SpellMissile.dbc: every row in file order, 15 fields of 4 bytes (ID, Flags, DefaultPitchMin/Max,
//   DefaultSpeedMin/Max, RandomizeFacingMin/Max, RandomizePitchMin/Max, RandomizeSpeedMin/Max, Gravity,
//   MaxDuration, CollisionRadius — tswow-scripts/wotlk/dbc/SpellMissile.ts; Wow.exe's solver 0x006fcd60 reads the
//   same offsets). TrinityCore does not load the table, so there is no DBCfmt.h string for it: the header is
//   checked against these 15 × 4 bytes (`readFixed`), and a dataset built otherwise is a 500.
// - Spell.dbc: `[ID, SpellMissileID]` for every row whose SpellMissileID (column 227 of 234, tools/dbd
//   3.3.3.11685-3.3.5.12340; the in-memory record's +0x28c Wow.exe 0x0080ac90 reads) is not zero, in file order.
//   The header is checked by the generated layout (`openDbcFile`). A spell naming an id with no row is kept: the
//   page finds no row for it and casts it as before, as Wow.exe's lookup (0x00ad492c…0x00ad493c) finds none.
//
// Measured on this dataset (the handler called offline): 105 missile rows, 106 spells (one, 66223, names the absent
// row 1823), 6,903 bytes of JSON (1,493 gzipped; catalog routes are not compressed). Reading Spell.dbc (71 MB, about
// 50 ms) is the cost, once per dataset — the memo serves the string afterwards.
// Floats travel in their shortest decimal form that reads back as the same single-precision value
// (VehicleMetadata.ts `float32Json`); a float that is not finite travels as null and the page drops that row.

import { openDbcFile, type Dbc } from "./Dbc.js";
import { readFixed, type FixedLayout, type FixedRows } from "./DbcFixed.js";
import { float32Json } from "./VehicleMetadata.js";
import {
  SPELL_MISSILE_CATALOG_VERSION, SPELL_MISSILE_COLUMN, SPELL_MISSILE_COLUMNS, type SpellMissileCatalogAnswer,
} from "../world/SpellMissileDbc.js";

export const SPELL_MISSILES_VERSION = SPELL_MISSILE_CATALOG_VERSION;

/** 15 fields, 60 bytes. */
export const SPELL_MISSILE_LAYOUT: FixedLayout = Object.freeze({ fieldCount: SPELL_MISSILE_COLUMNS, recordSize: SPELL_MISSILE_COLUMNS * 4 });

/** What the answer reads of Spell.dbc. */
export interface SpellMissileIds {
  readonly records: number;
  id(row: number): number;
  spellMissileId(row: number): number;
}

function spellMissileIds(spells: Dbc<"Spell">): SpellMissileIds {
  return {
    records: spells.records,
    id: (row) => spells.id(row),
    spellMissileId: (row) => spells.int(row, "SpellMissileID"),
  };
}

/** `SpellMissileCatalogAnswer` as it travels: a float that is not finite is null (JSON has no NaN). */
export interface SpellMissileRouteAnswer extends Omit<SpellMissileCatalogAnswer, "missiles"> {
  readonly missiles: readonly (readonly (number | null)[])[];
}

/** The answer out of already-checked tables; pure, so a test can feed it synthetic files. */
export function spellMissileCatalogAnswer(missiles: FixedRows, spells: SpellMissileIds): SpellMissileRouteAnswer {
  const rows: (number | null)[][] = [];
  for (let row = 0; row < missiles.records; row++) {
    const values: (number | null)[] = [missiles.int(row, SPELL_MISSILE_COLUMN.ID), missiles.int(row, SPELL_MISSILE_COLUMN.Flags) >>> 0];
    for (let column = SPELL_MISSILE_COLUMN.DefaultPitchMin; column < SPELL_MISSILE_COLUMNS; column++) {
      values.push(float32Json(missiles.float(row, column)));
    }
    rows.push(values);
  }
  const named: [number, number][] = [];
  for (let row = 0; row < spells.records; row++) {
    const missileId = spells.spellMissileId(row);
    if (missileId !== 0) named.push([spells.id(row), missileId]);
  }
  // A null float is not a number: the page's `spellMissileEntry` drops that row, as it drops any malformed one.
  return { version: SPELL_MISSILES_VERSION, missiles: rows, spells: named };
}

export async function loadSpellMissiles(dbcDirectory: string): Promise<SpellMissileRouteAnswer> {
  const [missiles, spells] = await Promise.all([
    readFixed(dbcDirectory, "SpellMissile", SPELL_MISSILE_LAYOUT),
    openDbcFile(dbcDirectory, "Spell"),
  ]);
  return spellMissileCatalogAnswer(missiles, spellMissileIds(spells));
}
