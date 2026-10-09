import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";
import { DurabilityTables } from "../world/DurabilityCost.js";

/**
 * The repair price tables (`/dbc/durability`, gateway/DurabilityMetadata.ts) for plan item 2.02.
 *
 * Asked for when a merchant who repairs is open (browser/Repair.ts), never from a C-API read. A
 * gateway process older than the route answers 404 until the owner restarts it; the catalog client
 * retries on its own schedule (CatalogClient.ts), and until the tables land every price reads 0 —
 * the buttons still work, the realm still charges its own price.
 */

/** gateway/DurabilityMetadata.ts `DURABILITY_VERSION`; tests/durability-cost.test.mjs pins the two together. */
export const DURABILITY_ROUTE_VERSION = 1;
export const DURABILITY_ROUTE_PATH = `/dbc/durability?v=${DURABILITY_ROUTE_VERSION}`;

function integerRow(row: unknown, length: number): row is number[] {
  return Array.isArray(row) && row.length === length && row.every((value) => Number.isSafeInteger(value));
}

/** Validate a route answer; undefined when its shape is not the route's. */
export function durabilityTablesFrom(data: unknown, version = DURABILITY_ROUTE_VERSION): DurabilityTables | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; costs?: unknown; quality?: unknown };
  if (value.version !== version || !Array.isArray(value.costs) || !Array.isArray(value.quality)) return undefined;
  // Rows are kept in place, never skipped: the client reads one column into the next row and
  // indexes the quality table by position, so a dropped row would move every later price.
  if (!value.costs.every((row) => integerRow(row, 30))) return undefined;
  if (!value.quality.every((row) => Array.isArray(row) && row.length === 2
    && Number.isSafeInteger(row[0]) && typeof row[1] === "number" && Number.isFinite(row[1]))) return undefined;
  return new DurabilityTables({
    version,
    costs: value.costs as number[][],
    quality: value.quality as Array<[number, number]>,
  });
}

export class DurabilityClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<DurabilityTables>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, DURABILITY_ROUTE_PATH, (data) => durabilityTablesFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  get tables(): DurabilityTables | undefined {
    return this.#catalog.value;
  }

  /** Starts the first cycle, or a new one after the last gave up; never a second request in flight. */
  load(): void {
    void this.#catalog.retry();
  }

  set onLoaded(callback: ((tables: DurabilityTables) => void) | undefined) {
    this.#catalog.onLoaded = callback;
  }
}

let current: DurabilityClient | undefined;

/** The page's one durability catalog for this gateway origin; another gateway is another catalog. */
export function durabilityClient(gatewayOrigin: string | undefined): DurabilityClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new DurabilityClient(gatewayOrigin);
  return current;
}
