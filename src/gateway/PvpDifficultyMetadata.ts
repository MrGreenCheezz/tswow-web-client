// 3.24 (11.11): the battleground level brackets, PvpDifficulty.dbc, for the browser — `GET /dbc/pvp-difficulty?v=1`,
// a row of CatalogRoutes.ts (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the memo dropped).
//
// Why: whether the character may queue for a battleground. Wow.exe 3.3.5a 12340 answers `canEnter` of
// GetBattlegroundInfo (0x0054e010) and GetBattlefieldInfo (0x0054d770) through 0x0054ba00 (Ghidra,
// .runtime/re-2026-11-11/pvpui/r1.txt): for the random battleground (BattlemasterList id 32) the player's level must
// be exactly 80; otherwise it walks the PvpDifficulty records in table order (0x00ad43e0, a 0x18-byte stride) for the
// run of rows whose MapID is the BattlemasterList row's MapID[0], and the level must lie in one row's
// [MinLevel, MaxLevel], both ends included. The bracket's RangeIndex is its by-product (unused by these two calls).
//
// Layout: DBCfmt.h "diiiii" — {ID, MapID, RangeIndex, MinLevel, MaxLevel, Difficulty}.
//
//   { version: 1, rows: [[mapId, rangeIndex, minLevel, maxLevel], …] } — every record, in file order.

import { readFixed, type FixedRows } from "./DbcFixed.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const PVP_DIFFICULTY_VERSION = 1;

export const PVP_DIFFICULTY_LAYOUT = Object.freeze({ fieldCount: 6, recordSize: 24 });
const MAP_FIELD = 1;
const RANGE_FIELD = 2;
const MIN_LEVEL_FIELD = 3;
const MAX_LEVEL_FIELD = 4;

export interface PvpDifficultyCatalog {
  version: number;
  rows: [mapId: number, rangeIndex: number, minLevel: number, maxLevel: number][];
}

/** The catalog out of an already-read table; pure, so a test can feed it a synthetic image. */
export function pvpDifficultyCatalog(table: FixedRows): PvpDifficultyCatalog {
  const rows: PvpDifficultyCatalog["rows"] = [];
  for (let row = 0; row < table.records; row++) {
    rows.push([table.int(row, MAP_FIELD), table.int(row, RANGE_FIELD), table.int(row, MIN_LEVEL_FIELD),
      table.int(row, MAX_LEVEL_FIELD)]);
  }
  return { version: PVP_DIFFICULTY_VERSION, rows };
}

export async function loadPvpDifficulty(dbcDirectory: string): Promise<PvpDifficultyCatalog> {
  return pvpDifficultyCatalog(await readFixed(dbcDirectory, "PvpDifficulty", PVP_DIFFICULTY_LAYOUT));
}
