import { RetryingCatalogClient, type CatalogState, type RetryingCatalogOptions } from "./CatalogClient.js";
import {
  AreaTriggerIndex, areaTriggers, type AreaTriggerRow, type AreaTriggerSource, type AreaTriggerVolume,
} from "./game/AreaTriggers.js";

/**
 * The AreaTrigger.dbc volumes (`/dbc/area-triggers`, gateway/AreaTriggerMetadata.ts), for the
 * 100 ms check in game/AreaTriggers.ts (plan item 2.01).
 *
 * Held whole and indexed by map: 1,220 rows, at most 181 volumes on one map, scanned every tick the
 * character is outside its current one. Started when a world mounts and stopped when it is left,
 * never from a frame or a C-API read. A gateway process older than the route answers 404 until the
 * owner restarts it; the catalog client retries on its own schedule (CatalogClient.ts) and, until a
 * catalog lands, the check simply has nothing to check.
 */

/** gateway/AreaTriggerMetadata.ts `AREA_TRIGGERS_VERSION`; tests/area-triggers.test.mjs pins the two together. */
export const AREA_TRIGGER_ROUTE_VERSION = 1;
export const AREA_TRIGGER_ROUTE_PATH = `/dbc/area-triggers?v=${AREA_TRIGGER_ROUTE_VERSION}`;

function isNumberRow(row: unknown): row is AreaTriggerRow {
  return Array.isArray(row) && row.length === 10
    && row.every((value) => typeof value === "number" && Number.isFinite(value));
}

/** Validate a route answer; undefined when its shape is not the route's. Malformed rows are skipped. */
export function areaTriggerRows(data: unknown, version = AREA_TRIGGER_ROUTE_VERSION): readonly AreaTriggerRow[] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; triggers?: unknown };
  if (value.version !== version || !Array.isArray(value.triggers)) return undefined;
  const rows: AreaTriggerRow[] = [];
  for (const row of value.triggers as readonly unknown[]) {
    if (!isNumberRow(row)) continue;
    const [id, map] = row;
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(map) || map < 0) continue;
    rows.push(Object.freeze([...row]) as unknown as AreaTriggerRow);
  }
  return Object.freeze(rows);
}

export class AreaTriggerClient implements AreaTriggerSource {
  /** The gateway's http origin this catalog belongs to. */
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<AreaTriggerIndex>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, AREA_TRIGGER_ROUTE_PATH, (data) => {
      const rows = areaTriggerRows(data);
      return rows ? new AreaTriggerIndex(rows) : undefined;
    }, options);
  }

  get state(): CatalogState {
    return this.#catalog.state;
  }

  get index(): AreaTriggerIndex | undefined {
    return this.#catalog.value;
  }

  load(): Promise<void> {
    return this.#catalog.load();
  }

  retry(): Promise<void> {
    return this.#catalog.retry();
  }

  /** Ends the retry schedule; a catalog already held is kept for the next mount. */
  stop(): void {
    this.#catalog.stop();
  }

  triggersOn(mapId: number): readonly AreaTriggerVolume[] | undefined {
    return this.#catalog.value?.triggersOn(mapId);
  }
}

let current: AreaTriggerClient | undefined;

/**
 * Every world mount (EnterWorld.ts): the page's one catalog for this gateway, handed to the watcher.
 *
 * Kept across characters — the volumes belong to the dataset, not to anyone — and fetched again only
 * when it never arrived: a mount revives a client that gave up (`retry`), so a gateway restarted
 * between two logins is picked up without reloading the page. Another gateway is another catalog.
 */
export function startAreaTriggers(gatewayUrl: string, options: RetryingCatalogOptions = {}): AreaTriggerClient {
  const origin = new URL(gatewayUrl.replace(/^ws/, "http")).origin;
  if (current?.origin !== origin) {
    current?.stop();
    current = new AreaTriggerClient(origin, options);
  }
  areaTriggers.start(current);
  void current.retry();
  return current;
}

/**
 * The world session is retired (EnterWorld.ts, on leaving the world and before the next character):
 * no retry keeps asking behind the character screen, and the watcher forgets the session.
 */
export function stopAreaTriggers(): void {
  current?.stop();
  areaTriggers.start(undefined);
}
