// 5.05 (15.11, combat7): OverrideSpellData.dbc for the browser — `GET /dbc/override-spells?v=1`, a row of
// CatalogRoutes.ts (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the memo dropped).
//
// Why: Wow.exe 3.3.5a 12340's request builder 0x0080cce0 refuses a player's own cast with CANT_DO_THAT_RIGHT_NOW
// (0xad) before anything is sent when PLAYER_FIELD_BYTES2's low word names an OverrideSpellData row whose Flags
// (+0x2c) lack 0x4 and the spell is not one of the row's ten (0x007fe820) — world/CastPreflightRule.ts. The realm
// does not make that check (TrinityCore only reads the row to learn and unlearn its spells, SpellAuraEffects.cpp:5003),
// so without the table the cast went out and was cast.
//
// Layout: DBCfmt.h "niiiiiiiiiix" — {ID, Spells[10], Flags}; the client reads Flags too (+0x2c).
//
//   { version: 1, rows: [[id, flags, spell0, …, spell9], …] } — every record, in file order.

import { readFixed, type FixedRows } from "./DbcFixed.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const OVERRIDE_SPELLS_VERSION = 1;

export const OVERRIDE_SPELL_DATA_LAYOUT = Object.freeze({ fieldCount: 12, recordSize: 48 });
const ID_FIELD = 0;
const FIRST_SPELL_FIELD = 1;
const SPELL_FIELDS = 10;
const FLAGS_FIELD = 11;

export interface OverrideSpellCatalog {
  version: number;
  /** [id, flags, ten spell ids]. */
  rows: number[][];
}

/** The catalog out of an already-read table; pure, so a test can feed it a synthetic image. */
export function overrideSpellCatalog(table: FixedRows): OverrideSpellCatalog {
  const rows: number[][] = [];
  for (let row = 0; row < table.records; row++) {
    const values = [table.int(row, ID_FIELD), table.int(row, FLAGS_FIELD) >>> 0];
    for (let spell = 0; spell < SPELL_FIELDS; spell++) values.push(table.int(row, FIRST_SPELL_FIELD + spell));
    rows.push(values);
  }
  return { version: OVERRIDE_SPELLS_VERSION, rows };
}

export async function loadOverrideSpells(dbcDirectory: string): Promise<OverrideSpellCatalog> {
  return overrideSpellCatalog(await readFixed(dbcDirectory, "OverrideSpellData", OVERRIDE_SPELL_DATA_LAYOUT));
}
