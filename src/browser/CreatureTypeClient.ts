import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * The creature type and family names (`/dbc/creature-types`, gateway/CreatureTypeMetadata.ts) for
 * plan item 3.23A: what `UnitCreatureType` and `UnitCreatureFamily` name.
 *
 * A gateway process older than the route answers 404 until the owner restarts it; the catalog
 * client retries on its own schedule (CatalogClient.ts), and until the table lands both answers
 * are nil — as they were before the route existed.
 */

/** gateway/CreatureTypeMetadata.ts `CREATURE_TYPES_VERSION`; tests/creature-type-metadata.test.mjs pins the two together. */
export const CREATURE_TYPES_ROUTE_VERSION = 1;
export const CREATURE_TYPES_ROUTE_PATH = `/dbc/creature-types?v=${CREATURE_TYPES_ROUTE_VERSION}`;

export class CreatureTypeTable {
  readonly #types: ReadonlyMap<number, string>;
  readonly #families: ReadonlyMap<number, string>;
  readonly #races: ReadonlyMap<number, number>;
  readonly #forms: ReadonlyMap<number, number>;

  constructor(
    types: ReadonlyMap<number, string>, families: ReadonlyMap<number, string>,
    races: ReadonlyMap<number, number>, forms: ReadonlyMap<number, number>,
  ) {
    this.#types = types;
    this.#families = families;
    this.#races = races;
    this.#forms = forms;
  }

  typeName(id: number): string | undefined { return this.#types.get(id) || undefined; }
  familyName(id: number): string | undefined { return this.#families.get(id) || undefined; }
  raceType(race: number): number | undefined { return this.#races.get(race); }
  /** A shapeshift form's own creature type, only when above 0. */
  formType(form: number): number | undefined { return this.#forms.get(form); }
}

function pairs<Value>(rows: unknown, valid: (value: unknown) => value is Value): Map<number, Value> | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out = new Map<number, Value>();
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || !valid(row[1])) return undefined;
    out.set(row[0] as number, row[1]);
  }
  return out;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isInteger = (value: unknown): value is number => Number.isSafeInteger(value);

/** Validate a route answer; undefined when its shape is not the route's. */
export function creatureTypeTableFrom(data: unknown, version = CREATURE_TYPES_ROUTE_VERSION): CreatureTypeTable | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; types?: unknown; families?: unknown; races?: unknown; forms?: unknown };
  if (value.version !== version) return undefined;
  const types = pairs(value.types, isString);
  const families = pairs(value.families, isString);
  const races = pairs(value.races, isInteger);
  const forms = pairs(value.forms, isInteger);
  if (!types || !families || !races || !forms) return undefined;
  return new CreatureTypeTable(types, families, races, forms);
}

export class CreatureTypeClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<CreatureTypeTable>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, CREATURE_TYPES_ROUTE_PATH,
      (data) => creatureTypeTableFrom(data), options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  /** The table; undefined until it lands. Starts the first cycle, never restarts one that gave up. */
  table(): CreatureTypeTable | undefined {
    const table = this.#catalog.value;
    if (!table) void this.#catalog.load();
    return table;
  }

  /** A new cycle after the last gave up (a world mount); never a second request in flight. */
  retry(): void {
    void this.#catalog.retry();
  }
}

let current: CreatureTypeClient | undefined;

/** The page's one creature type table for this gateway origin. */
export function creatureTypeClient(gatewayOrigin: string | undefined): CreatureTypeClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new CreatureTypeClient(gatewayOrigin);
  return current;
}
