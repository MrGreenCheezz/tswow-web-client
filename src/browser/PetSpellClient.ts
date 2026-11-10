import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * 4.04 (11.11): a creature family's pet spells (`/dbc/pet-spells`, gateway/PetSpellMetadata.ts) behind beast lore's
 * PET_SPELLS_TEMPLATE line (framexml/FrameXmlUnitTooltipFacts.ts, Wow.exe 0x00620950).
 *
 * A gateway process older than the route answers 404 until the owner restarts it; the catalog client retries on its
 * own schedule (CatalogClient.ts), and until then the line is not written.
 */

/** gateway/PetSpellMetadata.ts `PET_SPELLS_VERSION`; tests/unit-tooltip-pet-spells.test.mjs pins the two together. */
export const PET_SPELLS_ROUTE_VERSION = 1;
export const PET_SPELLS_ROUTE_PATH = `/dbc/pet-spells?v=${PET_SPELLS_ROUTE_VERSION}`;

export class PetSpellTable {
  readonly #families: ReadonlyMap<number, readonly string[]>;

  constructor(families: ReadonlyMap<number, readonly string[]>) {
    this.#families = families;
  }

  /** The family's spell names in 0x00620950's order; empty for a family with none. */
  familySpells(family: number): readonly string[] {
    return this.#families.get(family) ?? NONE;
  }
}
const NONE: readonly string[] = Object.freeze([]);

/** Validate a route answer; undefined when its shape is not the route's. */
export function petSpellTableFrom(data: unknown, version = PET_SPELLS_ROUTE_VERSION): PetSpellTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; families?: unknown };
  if (value.version !== version || !Array.isArray(value.families)) return undefined;
  const families = new Map<number, readonly string[]>();
  for (const row of value.families as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || !Array.isArray(row[1])
      || !(row[1] as unknown[]).every((name) => typeof name === "string")) return undefined;
    families.set(row[0] as number, Object.freeze([...(row[1] as string[])]));
  }
  return new PetSpellTable(families);
}

export class PetSpellClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<PetSpellTable>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, PET_SPELLS_ROUTE_PATH, (data) => petSpellTableFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The table; undefined until it lands. Starts the first cycle, never restarts one that gave up. */
  table(): PetSpellTable | undefined {
    const table = this.#catalog.value;
    if (!table) void this.#catalog.load();
    return table;
  }

  /** A new cycle after the last gave up (a world mount); never a second request in flight. */
  retry(): void {
    void this.#catalog.retry();
  }
}

let current: PetSpellClient | undefined;

/** The page's one pet spell table for this gateway origin. */
export function petSpellClient(gatewayOrigin: string | undefined): PetSpellClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new PetSpellClient(gatewayOrigin);
  return current;
}
