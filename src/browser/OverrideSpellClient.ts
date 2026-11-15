import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";
import type { OverrideSpellRow } from "../world/CastPreflightRule.js";

/**
 * 5.05 (15.11, combat7): OverrideSpellData rows (`/dbc/override-spells`, gateway/OverrideSpellMetadata.ts) — the
 * spells a vehicle or a possession bar leaves the player (PLAYER_FIELD_BYTES2's low word), which Wow.exe's request
 * builder 0x0080cce0 holds every other own cast against (world/CastPreflightRule.ts, CANT_DO_THAT_RIGHT_NOW).
 *
 * Asked for at the world mount. A gateway process older than the route answers 404 until the owner restarts it; the
 * catalog client retries on its own schedule (CatalogClient.ts), and until the rows land no cast is refused for it —
 * the realm decides, as before.
 */

/** gateway/OverrideSpellMetadata.ts `OVERRIDE_SPELLS_VERSION`; tests pin the two together. */
export const OVERRIDE_SPELLS_ROUTE_VERSION = 1;
export const OVERRIDE_SPELLS_ROUTE_PATH = `/dbc/override-spells?v=${OVERRIDE_SPELLS_ROUTE_VERSION}`;

/** Validate a route answer into rows by id; undefined when its shape is not the route's. */
export function overrideSpellRowsFrom(data: unknown, version = OVERRIDE_SPELLS_ROUTE_VERSION):
  ReadonlyMap<number, OverrideSpellRow> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; rows?: unknown };
  if (value.version !== version || !Array.isArray(value.rows)) return undefined;
  const rows = new Map<number, OverrideSpellRow>();
  for (const row of value.rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== 12 || !row.every((field) => Number.isSafeInteger(field))) return undefined;
    const [id, flags, ...spells] = row as number[];
    rows.set(id!, Object.freeze({ flags: flags!, spells: Object.freeze(spells) }));
  }
  return rows;
}

export class OverrideSpellClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<ReadonlyMap<number, OverrideSpellRow>>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, OVERRIDE_SPELLS_ROUTE_PATH,
      (data) => overrideSpellRowsFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The row, once the rows have landed; undefined before or for an id without one. */
  row(id: number): OverrideSpellRow | undefined {
    return this.#catalog.value?.get(id);
  }

  /** Starts the first cycle, or a new one after the last gave up; never a second request in flight. */
  load(): void {
    void this.#catalog.retry();
  }
}

let current: OverrideSpellClient | undefined;

/** The page's one OverrideSpellData catalog for this gateway origin; another gateway is another catalog. */
export function overrideSpellClient(gatewayOrigin: string | undefined): OverrideSpellClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new OverrideSpellClient(gatewayOrigin);
  return current;
}
