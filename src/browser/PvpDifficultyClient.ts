import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * 3.24 (11.11): the battleground level brackets (`/dbc/pvp-difficulty`, gateway/PvpDifficultyMetadata.ts) behind
 * `canEnter` of GetBattlegroundInfo and GetBattlefieldInfo (framexml/FrameXmlBattlegroundRules.ts, Wow.exe 0x0054ba00).
 *
 * A gateway process older than the route answers 404 until the owner restarts it; the catalog client retries on its
 * own schedule (CatalogClient.ts).
 */

/** gateway/PvpDifficultyMetadata.ts `PVP_DIFFICULTY_VERSION`; tests/framexml-battleground-rules.test.mjs pins both. */
export const PVP_DIFFICULTY_ROUTE_VERSION = 1;
export const PVP_DIFFICULTY_ROUTE_PATH = `/dbc/pvp-difficulty?v=${PVP_DIFFICULTY_ROUTE_VERSION}`;

/** One PvpDifficulty record as 0x0054ba00 reads it. */
export interface PvpDifficultyRow {
  readonly mapId: number;
  readonly rangeIndex: number;
  readonly minLevel: number;
  readonly maxLevel: number;
}

export class PvpDifficultyTable {
  readonly rows: readonly PvpDifficultyRow[];

  constructor(rows: readonly PvpDifficultyRow[]) {
    this.rows = rows;
  }

  /**
   * Wow.exe 0x0054ba00's scan for a non-random battleground: the records in table order; the first run of rows on
   * `mapId` is searched for one whose [MinLevel, MaxLevel] holds `level` (both ends included), and the scan stops
   * at the first row after that run — a later run of the same map is never reached. The bracket's RangeIndex, or
   * undefined when the level has none.
   */
  bracket(mapId: number, level: number): number | undefined {
    let inRun = false;
    for (const row of this.rows) {
      if (row.mapId !== mapId) {
        if (inRun) break;
        continue;
      }
      if (row.minLevel <= level && level <= row.maxLevel) return row.rangeIndex;
      inRun = true;
    }
    return undefined;
  }
}

/** Validate a route answer; undefined when its shape is not the route's. */
export function pvpDifficultyTableFrom(data: unknown, version = PVP_DIFFICULTY_ROUTE_VERSION): PvpDifficultyTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; rows?: unknown };
  if (value.version !== version || !Array.isArray(value.rows)) return undefined;
  const rows: PvpDifficultyRow[] = [];
  for (const row of value.rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== 4 || !row.every((field) => Number.isSafeInteger(field))) return undefined;
    const [mapId, rangeIndex, minLevel, maxLevel] = row as number[];
    rows.push(Object.freeze({ mapId: mapId!, rangeIndex: rangeIndex!, minLevel: minLevel!, maxLevel: maxLevel! }));
  }
  return new PvpDifficultyTable(Object.freeze(rows));
}

export class PvpDifficultyClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<PvpDifficultyTable>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, PVP_DIFFICULTY_ROUTE_PATH, (data) => pvpDifficultyTableFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The table; undefined until it lands. Starts the first cycle, never restarts one that gave up. */
  table(): PvpDifficultyTable | undefined {
    const table = this.#catalog.value;
    if (!table) void this.#catalog.load();
    return table;
  }

  /** A new cycle after the last gave up (a world mount); never a second request in flight. */
  retry(): void {
    void this.#catalog.retry();
  }
}

let current: PvpDifficultyClient | undefined;

/** The page's one bracket table for this gateway origin. */
export function pvpDifficultyClient(gatewayOrigin: string | undefined): PvpDifficultyClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new PvpDifficultyClient(gatewayOrigin);
  return current;
}
