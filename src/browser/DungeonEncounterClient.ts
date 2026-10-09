import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * The boss table (`/dbc/dungeon-encounters`, gateway/DungeonEncounterMetadata.ts) for plan item
 * 2.09: what the killed-boss mask of SMSG_INSTANCE_LOCK_WARNING_QUERY counts against.
 *
 * Asked for once per world mount (the popup model's live context) and read by the stock
 * INSTANCE_LOCK dialog's C API and the native prompt. A gateway process older than the route
 * answers 404 until the owner restarts it; the catalog client retries on its own schedule
 * (CatalogClient.ts), and until the table lands `encounters()` is undefined — the stock dialog is
 * then not asked (its «Убито боссов: %d/%d» would be invented) and the native prompt keeps the
 * question, saying only the killed count.
 */

/** gateway/DungeonEncounterMetadata.ts `DUNGEON_ENCOUNTERS_VERSION`; tests/dungeon-encounter-metadata.test.mjs pins the two together. */
export const DUNGEON_ENCOUNTERS_ROUTE_VERSION = 1;
export const DUNGEON_ENCOUNTERS_ROUTE_PATH = `/dbc/dungeon-encounters?v=${DUNGEON_ENCOUNTERS_ROUTE_VERSION}`;

/** One boss of a map and difficulty: its bit in the killed-boss mask and its name. */
export interface DungeonEncounter {
  readonly bit: number;
  readonly name: string;
}

const NONE: readonly DungeonEncounter[] = Object.freeze([]);

/** The table indexed as the client walks it: per `map/difficulty`, the rows in file order. */
export class DungeonEncounterTable {
  readonly #groups: ReadonlyMap<string, readonly DungeonEncounter[]>;
  readonly rows: number;

  constructor(groups: ReadonlyMap<string, readonly DungeonEncounter[]>, rows: number) {
    this.#groups = groups;
    this.rows = rows;
  }

  /** The bosses of a map and difficulty, in the client's order; empty where the table has none (the client's 0/0). */
  encounters(mapId: number, difficulty: number): readonly DungeonEncounter[] {
    return this.#groups.get(`${mapId}/${difficulty}`) ?? NONE;
  }
}

/** Bit `bit` of a killed-boss mask, as the client tests it (`1 << (Bit & 31)`, Wow.exe 0x00553830). */
export function encounterKilled(mask: number, bit: number): boolean {
  return ((mask >>> 0) & (1 << (bit & 31))) !== 0;
}

/** Validate a route answer; undefined when its shape is not the route's. */
export function dungeonEncounterTableFrom(data: unknown, version = DUNGEON_ENCOUNTERS_ROUTE_VERSION): DungeonEncounterTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; encounters?: unknown };
  if (value.version !== version || !Array.isArray(value.encounters)) return undefined;
  const groups = new Map<string, DungeonEncounter[]>();
  for (const row of value.encounters as unknown[]) {
    if (!Array.isArray(row) || row.length !== 5) return undefined;
    const [id, mapId, difficulty, bit, name] = row as unknown[];
    if (![id, mapId, difficulty, bit].every((field) => Number.isSafeInteger(field)) || typeof name !== "string") return undefined;
    const key = `${mapId as number}/${difficulty as number}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = []);
    group.push(Object.freeze({ bit: bit as number, name }));
  }
  for (const group of groups.values()) Object.freeze(group);
  return new DungeonEncounterTable(groups, value.encounters.length);
}

export class DungeonEncounterClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<DungeonEncounterTable>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, DUNGEON_ENCOUNTERS_ROUTE_PATH,
      (data) => dungeonEncounterTableFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  get table(): DungeonEncounterTable | undefined {
    return this.#catalog.value;
  }

  /** A new cycle after the last gave up (a world mount); never a second request in flight. */
  retry(): void {
    void this.#catalog.retry();
  }

  /**
   * The bosses of a map and difficulty; undefined until the table lands. Starts the first cycle if
   * none has run, but never restarts one that gave up — this is read every frame a lock is pending.
   */
  encounters(mapId: number, difficulty: number): readonly DungeonEncounter[] | undefined {
    const table = this.#catalog.value;
    if (table) return table.encounters(mapId, difficulty);
    void this.#catalog.load();
    return undefined;
  }
}

let current: DungeonEncounterClient | undefined;

/** The page's one boss table for this gateway origin; another gateway is another table. */
export function dungeonEncounterClient(gatewayOrigin: string | undefined): DungeonEncounterClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new DungeonEncounterClient(gatewayOrigin);
  return current;
}
