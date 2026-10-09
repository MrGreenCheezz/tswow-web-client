import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * 05.10-3.01: ItemLimitCategory rows (`/dbc/item-limit-categories`, gateway/ItemLimitCategoryMetadata.ts) —
 * the name and quantity a SPELL_FAILED_TOO_MANY_OF_ITEM refusal names (Wow.exe 0x00808200, case 0x81).
 *
 * Asked for when the combat log attaches. A gateway process older than the route answers 404 until the
 * owner restarts it; the catalog client retries on its own schedule (CatalogClient.ts), and until the rows
 * land a refusal reads as Wow.exe's own «row not found» path does: the plain SPELL_FAILED_TOO_MANY_OF_ITEM.
 */

/** gateway/ItemLimitCategoryMetadata.ts `ITEM_LIMIT_CATEGORIES_VERSION`; tests pin the two together. */
export const ITEM_LIMIT_CATEGORIES_ROUTE_VERSION = 1;
export const ITEM_LIMIT_CATEGORIES_ROUTE_PATH = `/dbc/item-limit-categories?v=${ITEM_LIMIT_CATEGORIES_ROUTE_VERSION}`;

export interface ItemLimitCategory {
  readonly name: string;
  readonly quantity: number;
  readonly flags: number;
}

/** Validate a route answer into rows by id; undefined when its shape is not the route's. */
export function itemLimitCategoriesFrom(data: unknown, version = ITEM_LIMIT_CATEGORIES_ROUTE_VERSION):
  ReadonlyMap<number, ItemLimitCategory> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; categories?: unknown };
  if (value.version !== version || !Array.isArray(value.categories)) return undefined;
  const rows = new Map<number, ItemLimitCategory>();
  for (const row of value.categories) {
    if (!Array.isArray(row) || row.length !== 4) return undefined;
    const [id, name, quantity, flags] = row as unknown[];
    if (!Number.isSafeInteger(id) || typeof name !== "string" || !Number.isSafeInteger(quantity)
      || !Number.isSafeInteger(flags)) return undefined;
    rows.set(id as number, { name, quantity: quantity as number, flags: flags as number });
  }
  return rows;
}

export class ItemLimitCategoryClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<ReadonlyMap<number, ItemLimitCategory>>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, ITEM_LIMIT_CATEGORIES_ROUTE_PATH,
      (data) => itemLimitCategoriesFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The row, once the rows have landed; undefined before or for an id without one. */
  category(id: number): ItemLimitCategory | undefined {
    return this.#catalog.value?.get(id);
  }

  /** Starts the first cycle, or a new one after the last gave up; never a second request in flight. */
  load(): void {
    void this.#catalog.retry();
  }
}

let current: ItemLimitCategoryClient | undefined;

/** The page's one ItemLimitCategory catalog for this gateway origin; another gateway is another catalog. */
export function itemLimitCategoryClient(gatewayOrigin: string | undefined): ItemLimitCategoryClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new ItemLimitCategoryClient(gatewayOrigin);
  return current;
}
