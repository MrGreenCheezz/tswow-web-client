import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * The melee crit and spirit regeneration tables (`/dbc/character-regen`,
 * gateway/CharacterRegenMetadata.ts) for plan item 3.23C: `GetCritChanceFromAgility`,
 * `GetUnitHealthRegenRateFromSpirit` and `GetUnitManaRegenRateFromSpirit`.
 *
 * A gateway process older than the route answers 404 until the owner restarts it; the catalog client
 * retries on its own schedule (CatalogClient.ts), and until the tables land the three answers stay 0,
 * as they were before the route existed.
 */

/** gateway/CharacterRegenMetadata.ts `CHARACTER_REGEN_VERSION`; tests/framexml-regen-stats.test.mjs pins the two together. */
export const CHARACTER_REGEN_ROUTE_VERSION = 1;
export const CHARACTER_REGEN_ROUTE_PATH = `/dbc/character-regen?v=${CHARACTER_REGEN_ROUTE_VERSION}`;

export interface CharacterRegenTables {
  readonly meleeCritBase: readonly number[];
  readonly meleeCritPerAgility: readonly number[];
  readonly healthPerBaseSpirit: readonly number[];
  readonly healthPerSpirit: readonly number[];
  readonly manaPerSpirit: readonly number[];
}

const MAX_LEVEL = 100;

function floats(value: unknown, length?: number): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8192
    && (length === undefined || value.length === length)
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/** Validate a route answer; undefined when its shape is not the route's. */
export function characterRegenTablesFrom(data: unknown, version = CHARACTER_REGEN_ROUTE_VERSION): CharacterRegenTables | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  if (value.version !== version || !floats(value.meleeCritBase) || value.meleeCritBase.length > 32) return undefined;
  const rows = value.meleeCritBase.length * MAX_LEVEL;
  if (!floats(value.meleeCritPerAgility, rows) || !floats(value.healthPerBaseSpirit, rows)
    || !floats(value.healthPerSpirit, rows) || !floats(value.manaPerSpirit, rows)) return undefined;
  return Object.freeze({
    meleeCritBase: value.meleeCritBase, meleeCritPerAgility: value.meleeCritPerAgility,
    healthPerBaseSpirit: value.healthPerBaseSpirit, healthPerSpirit: value.healthPerSpirit,
    manaPerSpirit: value.manaPerSpirit,
  });
}

export class CharacterRegenClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<CharacterRegenTables>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, CHARACTER_REGEN_ROUTE_PATH,
      (data) => characterRegenTablesFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The tables; undefined until they land. Starts the first cycle, never restarts one that gave up. */
  table(): CharacterRegenTables | undefined {
    const table = this.#catalog.value;
    if (!table) void this.#catalog.load();
    return table;
  }

  /** A new cycle after the last gave up (a world mount); never a second request in flight. */
  retry(): void {
    void this.#catalog.retry();
  }
}

let current: CharacterRegenClient | undefined;

/** The page's one regeneration table for this gateway origin. */
export function characterRegenClient(gatewayOrigin: string | undefined): CharacterRegenClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new CharacterRegenClient(gatewayOrigin);
  return current;
}
