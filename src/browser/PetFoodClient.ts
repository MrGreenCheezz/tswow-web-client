import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * 05.10-petfood: the pet diet tables (`/dbc/pet-foods`, gateway/PetFoodMetadata.ts) behind
 * `GetPetFoodTypes` (framexml/FrameXmlPetFood.ts).
 *
 * A gateway process older than the route answers 404 until the owner restarts it; the catalog client
 * retries on its own schedule (CatalogClient.ts).
 */

/** gateway/PetFoodMetadata.ts `PET_FOODS_VERSION`; tests/framexml-pet-food-types.test.mjs pins the two together. */
export const PET_FOODS_ROUTE_VERSION = 1;
export const PET_FOODS_ROUTE_PATH = `/dbc/pet-foods?v=${PET_FOODS_ROUTE_VERSION}`;

export class PetFoodTable {
  readonly #masks: ReadonlyMap<number, number>;
  /** `[id, name]` in the table's own order: the order Wow.exe 0x005d3bd0 pushes the names. */
  readonly #foods: readonly (readonly [number, string])[];
  /** Answers per mask, built once: the tooltip asks on every hover. */
  readonly #byMask = new Map<number, readonly string[]>();

  constructor(masks: ReadonlyMap<number, number>, foods: readonly (readonly [number, string])[]) {
    this.#masks = masks;
    this.#foods = foods;
  }

  /** A family's PetFoodMask; 0 for a family with no row or no diet. */
  familyMask(family: number): number {
    return this.#masks.get(family) ?? 0;
  }

  /** The names whose bit `1 << (ID - 1)` is in `mask`, in table order (frozen, shared). */
  foodNames(mask: number): readonly string[] {
    let names = this.#byMask.get(mask);
    if (!names) {
      const out: string[] = [];
      // The client shifts by (ID - 1) & 31, as x86 SHL masks the count.
      for (const [id, name] of this.#foods) if ((mask & (1 << ((id - 1) & 31))) !== 0) out.push(name);
      names = Object.freeze(out);
      this.#byMask.set(mask, names);
    }
    return names;
  }
}

/** Validate a route answer; undefined when its shape is not the route's. */
export function petFoodTableFrom(data: unknown, version = PET_FOODS_ROUTE_VERSION): PetFoodTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; families?: unknown; foods?: unknown };
  if (value.version !== version || !Array.isArray(value.families) || !Array.isArray(value.foods)) return undefined;
  const masks = new Map<number, number>();
  for (const row of value.families as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || !Number.isSafeInteger(row[1])) return undefined;
    masks.set(row[0] as number, row[1] as number);
  }
  const foods: (readonly [number, string])[] = [];
  for (const row of value.foods as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || typeof row[1] !== "string") return undefined;
    foods.push([row[0] as number, row[1]]);
  }
  return new PetFoodTable(masks, foods);
}

export class PetFoodClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<PetFoodTable>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, PET_FOODS_ROUTE_PATH, (data) => petFoodTableFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The table; undefined until it lands. Starts the first cycle, never restarts one that gave up. */
  table(): PetFoodTable | undefined {
    const table = this.#catalog.value;
    if (!table) void this.#catalog.load();
    return table;
  }

  /** A new cycle after the last gave up (a world mount); never a second request in flight. */
  retry(): void {
    void this.#catalog.retry();
  }
}

let current: PetFoodClient | undefined;

/** The page's one pet diet table for this gateway origin. */
export function petFoodClient(gatewayOrigin: string | undefined): PetFoodClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new PetFoodClient(gatewayOrigin);
  return current;
}
