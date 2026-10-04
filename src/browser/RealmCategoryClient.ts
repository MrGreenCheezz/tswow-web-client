import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * Cfg_Categories.dbc in the browser (plan items 10.08 and 1.19): the realm list's tab names and a
 * new character name's alphabet mask, from `/dbc/realm-categories?v=1`
 * (gateway/RealmCategoryMetadata.ts). A gateway older than the route answers 404; until the table
 * lands the realm tabs keep their numbers and the name check uses mask 0, as before the route.
 */

export const REALM_CATEGORIES_ROUTE_VERSION = 1;
export const REALM_CATEGORIES_ROUTE_PATH = `/dbc/realm-categories?v=${REALM_CATEGORIES_ROUTE_VERSION}`;

export interface RealmCategory {
  readonly id: number;
  /** `LocaleMask`: bit n is client locale n (enUS 0 … ruRU 8). */
  readonly localeMask: number;
  /** `Create_charset_mask`: the alphabets a new character's name may take (0 — all of them). */
  readonly createCharsetMask: number;
  readonly flags: number;
  /** `Name_lang` in the gateway's locale — what `GetRealmCategories` prints on the tab. */
  readonly name: string;
}

/** Validate a route answer into rows by id; undefined when its shape is not the route's. */
export function realmCategoryTableFrom(data: unknown, version = REALM_CATEGORIES_ROUTE_VERSION): ReadonlyMap<number, RealmCategory> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; categories?: unknown };
  if (value.version !== version || !Array.isArray(value.categories)) return undefined;
  const table = new Map<number, RealmCategory>();
  for (const row of value.categories as unknown[]) {
    if (!Array.isArray(row) || row.length !== 5) return undefined;
    const [id, localeMask, createCharsetMask, flags, name] = row as unknown[];
    if (![id, localeMask, createCharsetMask, flags].every((field) => Number.isSafeInteger(field)) || typeof name !== "string") {
      return undefined;
    }
    // The first row of an id wins, as a lookup over the file does.
    if (!table.has(id as number)) {
      table.set(id as number, Object.freeze({
        id: id as number, localeMask: localeMask as number, createCharsetMask: createCharsetMask as number,
        flags: flags as number, name,
      }));
    }
  }
  return table;
}

export class RealmCategoryClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<ReadonlyMap<number, RealmCategory>>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, REALM_CATEGORIES_ROUTE_PATH,
      (data) => realmCategoryTableFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** Told once, when the table lands. */
  set onLoaded(callback: ((table: ReadonlyMap<number, RealmCategory>) => void) | undefined) {
    this.#catalog.onLoaded = callback;
  }

  /** The rows by id; undefined until the table lands. Starts the first cycle if none has run. */
  table(): ReadonlyMap<number, RealmCategory> | undefined {
    const table = this.#catalog.value;
    if (table) return table;
    void this.#catalog.load();
    return undefined;
  }

  retry(): void {
    void this.#catalog.retry();
  }
}
