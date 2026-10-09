// 05.10-A7b-4 (7.13): WMOAreaTable for the browser, `GET /dbc/wmo-areas?v=1` — a row of CatalogRoutes.ts
// (Origin 403, `?v=` 400, memo per dataset, 200 JSON no-store, 500 with the memo dropped).
//
// Why: the server never says which room a character stands in. TrinityCore answers the area of a point
// inside a building from this table (Map.cpp `GetAreaId`, :2694-2728): the vmap floor's (root WMO id,
// MODF name set, MOGP group id) names a row, its `AreaTableID` is the area when non-zero, then the
// terrain grid, then `Map.AreaTableID`; and its `Flags` override the group's MOGP 0x8 for «outdoors»
// (Map.cpp :2882-2911: `Flags & 4` outdoors, else `Flags & 2` indoors). The client names a room from the
// same rows: the whole-building row (`WMOGroupID` −1) and the group's own `AreaName_lang`
// (browser/AreaLocator.ts).
//
// Layout: TrinityCore `WMOAreaTableEntryfmt` "niiixxxxxiixxxxxxxxxxxxxxxxx" (DBCfmt.h:143) — 28 fields, 112
// bytes; DBCStructure.h:1890-1905: 0 ID, 1 WMOID, 2 NameSetID, 3 WMOGroupID, 4-8 sound/music (not read:
// sound is out of the plan), 9 Flags, 10 AreaTableID, 11-27 AreaName_lang (16 locales + mask).
//
// The key is the core's: `GetWMOAreaTableEntryByTripple` (DBCStores.cpp:725-731) looks up
// `tuple<int16, int8, int32>` — the root id cut to int16 and the name set to int8 — and the store is
// filled with `map[key] = entry` in file order (:653-654), so a later row with the same cut key wins.
// The cut and the last-wins merge are done here, once; rows that answer nothing (area 0, flags without
// 2/4, no name) are left out, which is the same as no row for every rule that reads the table.
//
//   { version: 1, rows: [[wmoId:int16, nameSet:int8, groupId:int32, areaId, flags, name], …] }

import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import { fixedLocstring } from "./DungeonEncounterMetadata.js";
import type { DbcLocale } from "../generated/dbcLayouts.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const WMO_AREAS_VERSION = 1;

export const WMO_AREA_TABLE_LAYOUT = Object.freeze({ fieldCount: 28, recordSize: 112 });

const WMO_ID_FIELD = 1;
const NAME_SET_FIELD = 2;
const GROUP_ID_FIELD = 3;
const FLAGS_FIELD = 9;
const AREA_FIELD = 10;
const NAME_FIELD = 11;

/** `Flags` bits the core reads (Map.cpp :2891-2894): 4 forces outdoors, 2 indoors. */
export const WMO_AREA_FLAG_INDOORS = 0x2;
export const WMO_AREA_FLAG_OUTDOORS = 0x4;

export type WmoAreaRow = [wmoId: number, nameSet: number, groupId: number, areaId: number, flags: number, name: string];

export interface WmoAreaCatalog {
  version: number;
  rows: WmoAreaRow[];
}

/** `int16(rootid)` of the core's key. */
export function wmoAreaRootId(wmoId: number): number {
  return (wmoId << 16) >> 16;
}

/** `int8(adtid)` of the core's key. */
export function wmoAreaNameSet(nameSet: number): number {
  return (nameSet << 24) >> 24;
}

/** The catalog out of already-checked rows; pure, so a test can feed it synthetic files. */
export function wmoAreaCatalog(rows: FixedRows, locale: DbcLocale = DEFAULT_LOCALE): WmoAreaCatalog {
  const byKey = new Map<string, WmoAreaRow>();
  for (let row = 0; row < rows.records; row++) {
    const wmoId = wmoAreaRootId(rows.int(row, WMO_ID_FIELD));
    const nameSet = wmoAreaNameSet(rows.int(row, NAME_SET_FIELD));
    const groupId = rows.int(row, GROUP_ID_FIELD) | 0;
    const key = `${wmoId}:${nameSet}:${groupId}`;
    // Deleted and inserted again so the surviving row sits where the last one was read; either order
    // gives the same lookups, this one keeps the payload in file order for a reader.
    byKey.delete(key);
    byKey.set(key, [
      wmoId, nameSet, groupId,
      rows.int(row, AREA_FIELD) >>> 0,
      rows.int(row, FLAGS_FIELD) >>> 0,
      fixedLocstring(rows, row, NAME_FIELD, locale),
    ]);
  }
  const out: WmoAreaRow[] = [];
  for (const entry of byKey.values()) {
    const [, , , areaId, flags, name] = entry;
    if (areaId === 0 && (flags & (WMO_AREA_FLAG_INDOORS | WMO_AREA_FLAG_OUTDOORS)) === 0 && name === "") continue;
    out.push(entry);
  }
  return { version: WMO_AREAS_VERSION, rows: out };
}

export async function loadWmoAreas(dbcDirectory: string): Promise<WmoAreaCatalog> {
  return wmoAreaCatalog(await readFixed(dbcDirectory, "WMOAreaTable", WMO_AREA_TABLE_LAYOUT));
}
