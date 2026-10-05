/**
 * 05.10-A7b-4 (7.13): WMOAreaTable in the browser, from `GET /dbc/wmo-areas?v=1` (gateway/WmoAreaMetadata.ts).
 *
 * Rows are looked up by the core's key, `tuple<int16, int8, int32>` (TrinityCore DBCStores.cpp:725-731
 * `GetWMOAreaTableEntryByTripple`): the root WMO id (`MOHD.wmoID`, u32 in the visual tile) cut to int16,
 * the placement's MODF name set (u16) cut to int8, the MOGP group id whole. The gateway already cut and
 * merged the rows (last row wins, as the core's `map[key] = entry`); the lookup cuts the query the same
 * way, so a name set of 200 finds the row stored under −56 exactly as the server does.
 *
 * The index is two `Map`s deep — the 24-bit (root, name set) pair, then the group id — so a lookup is
 * two `Map.get` with integer keys and no string or object made per call: the locator asks every time
 * the character moves.
 *
 * A gateway older than the route answers 404; `RetryingCatalogClient` then gives up after its second
 * stale answer and everything that reads the table behaves as before it existed (no room names, the
 * MOGP flag alone for indoors).
 */

import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

export const WMO_AREAS_ROUTE_VERSION = 1;
export const WMO_AREAS_ROUTE_PATH = `/dbc/wmo-areas?v=${WMO_AREAS_ROUTE_VERSION}`;

/** `WMOGroupID` of the row that names the whole building rather than one group. */
export const WMO_AREA_WHOLE_GROUP = -1;

export interface WmoAreaEntry {
  /** `AreaTableID`; 0 leaves the area to the terrain grid. */
  readonly areaId: number;
  /** `Flags`: 4 outdoors, 2 indoors (over the group's MOGP 0x8). */
  readonly flags: number;
  /** `AreaName_lang` in the dataset's locale; "" when the row has none. */
  readonly name: string;
}

/** The (int16 root, int8 name set) half of the key as one non-negative integer below 2^24. */
export function wmoAreaRootKey(wmoId: number, nameSet: number): number {
  return (((wmoId << 16) >> 16) & 0xffff) * 256 + ((((nameSet << 24) >> 24)) & 0xff);
}

export class WmoAreaTable {
  readonly #roots = new Map<number, Map<number, WmoAreaEntry>>();

  constructor(rows: readonly (readonly [number, number, number, number, number, string])[]) {
    for (const [wmoId, nameSet, groupId, areaId, flags, name] of rows) {
      const root = wmoAreaRootKey(wmoId, nameSet);
      let groups = this.#roots.get(root);
      if (!groups) {
        groups = new Map();
        this.#roots.set(root, groups);
      }
      groups.set(groupId | 0, Object.freeze({ areaId, flags, name }));
    }
  }

  /** The row for an exact key, as the core finds it; undefined without one. */
  lookup(wmoId: number, nameSet: number, groupId: number): WmoAreaEntry | undefined {
    return this.#roots.get(wmoAreaRootKey(wmoId, nameSet))?.get(groupId | 0);
  }

  /** The whole-building row (`WMOGroupID` −1). */
  whole(wmoId: number, nameSet: number): WmoAreaEntry | undefined {
    return this.lookup(wmoId, nameSet, WMO_AREA_WHOLE_GROUP);
  }
}

/** The route's answer, validated; undefined for any other shape or version. */
export function wmoAreaTableFrom(data: unknown, version = WMO_AREAS_ROUTE_VERSION): WmoAreaTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; rows?: unknown };
  if (value.version !== version || !Array.isArray(value.rows)) return undefined;
  const rows: [number, number, number, number, number, string][] = [];
  for (const row of value.rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== 6) return undefined;
    const [wmoId, nameSet, groupId, areaId, flags, name] = row as unknown[];
    if (!Number.isInteger(wmoId) || !Number.isInteger(nameSet) || !Number.isInteger(groupId)
      || !Number.isInteger(areaId) || !Number.isInteger(flags) || typeof name !== "string") return undefined;
    rows.push([wmoId as number, nameSet as number, groupId as number, areaId as number, flags as number, name]);
  }
  return new WmoAreaTable(rows);
}

export class WmoAreaClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<WmoAreaTable>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, WMO_AREAS_ROUTE_PATH, (data) => wmoAreaTableFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The table; undefined until it lands. Starts the first cycle, never restarts one that gave up. */
  table(): WmoAreaTable | undefined {
    const table = this.#catalog.value;
    if (!table && this.#catalog.state === "idle") void this.#catalog.load();
    return table;
  }

  /** Ends the schedule (a realm left). */
  stop(): void {
    this.#catalog.stop();
  }
}
