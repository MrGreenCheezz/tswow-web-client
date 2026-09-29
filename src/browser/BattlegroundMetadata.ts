/** The seven 3.3.5 battleground rows this client can present. */
export const BATTLEGROUND_TYPE_IDS = Object.freeze([1, 2, 3, 7, 9, 30, 32] as const);

export interface BattlegroundMap {
  readonly id: number;
  readonly name: string;
  readonly description0?: string;
  readonly description1?: string;
}

/** Browser-facing projection of the gateway's fixed BattlemasterList catalog. */
export interface BattlegroundMetadata {
  readonly bgTypeId: number;
  readonly name: string;
  readonly mapIds: readonly number[];
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly maxGroupSize: number;
  readonly groupsAllowed: number;
  readonly holidayWorldState: number;
  readonly random: boolean;
  readonly maps: readonly BattlegroundMap[];
}

export type BattlegroundCatalog = readonly BattlegroundMetadata[];

const BATTLEGROUND_CATALOG_TIMEOUT_MS = 5_000;

function validMap(value: unknown): value is BattlegroundMap {
  if (!value || typeof value !== "object") return false;
  const map = value as Partial<BattlegroundMap>;
  return Number.isInteger(map.id) && (map.id ?? 0) > 0
    && typeof map.name === "string" && map.name.length > 0
    && (map.description0 === undefined || typeof map.description0 === "string")
    && (map.description1 === undefined || typeof map.description1 === "string");
}

function validRow(value: unknown, expectedId: number): value is BattlegroundMetadata {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<BattlegroundMetadata>;
  return row.bgTypeId === expectedId
    && typeof row.name === "string" && row.name.length > 0
    && Array.isArray(row.mapIds) && row.mapIds.every((id) => Number.isInteger(id) && id > 0)
    && Number.isInteger(row.minLevel) && Number.isInteger(row.maxLevel)
    && Number.isInteger(row.maxGroupSize) && Number.isInteger(row.groupsAllowed)
    && Number.isInteger(row.holidayWorldState)
    && typeof row.random === "boolean"
    && Array.isArray(row.maps) && row.maps.every(validMap);
}

function validateCatalog(value: unknown): BattlegroundCatalog {
  if (!Array.isArray(value) || value.length !== BATTLEGROUND_TYPE_IDS.length) {
    throw new Error("malformed battleground catalog");
  }
  const catalog = BATTLEGROUND_TYPE_IDS.map((id, index) => {
    const row = value[index];
    if (!validRow(row, id)) throw new Error(`malformed battleground row ${id}`);
    if (row.random !== (id === 32)) throw new Error(`invalid random battleground row ${id}`);
    return Object.freeze({
      ...row,
      mapIds: Object.freeze([...row.mapIds]),
      maps: Object.freeze(row.maps.map((map) => Object.freeze({ ...map }))),
    });
  });
  return Object.freeze(catalog);
}

/**
 * Fetches and retains the fixed battleground catalog for both native and FrameXML interfaces.
 * The gateway's cache headers provide the HTTP cache; this instance keeps later UI reads
 * synchronous and side-effect free after the one asynchronous load.
 */
export class BattlegroundClient {
  readonly #url: string;
  #catalog: BattlegroundCatalog | undefined;
  #pending: Promise<BattlegroundCatalog | undefined> | undefined;
  #failed = false;
  onStatus: ((message: string, error: boolean) => void) | undefined;
  onLoaded: (() => void) | undefined;

  constructor(gatewayOrigin: string) {
    this.#url = new URL("/dbc/battlegrounds", gatewayOrigin).href;
  }

  get ready(): boolean {
    return this.#catalog !== undefined;
  }

  get catalog(): BattlegroundCatalog | undefined {
    return this.#catalog;
  }

  load(): Promise<BattlegroundCatalog | undefined> {
    if (this.#catalog !== undefined) return Promise.resolve(this.#catalog);
    if (this.#pending) return this.#pending;
    if (this.#failed) return Promise.resolve(undefined);
    this.#pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), BATTLEGROUND_CATALOG_TIMEOUT_MS);
      try {
        const response = await fetch(this.#url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Battleground gateway returned ${response.status}`);
        const catalog = validateCatalog(await response.json());
        this.#catalog = catalog;
        this.onLoaded?.();
        return catalog;
      } catch (error) {
        this.#failed = true;
        this.onStatus?.(`поля боя: ${error instanceof Error ? error.message : String(error)}`, true);
        return undefined;
      } finally {
        clearTimeout(timeout);
        this.#pending = undefined;
      }
    })();
    return this.#pending;
  }
}
