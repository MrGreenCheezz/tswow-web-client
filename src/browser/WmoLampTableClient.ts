/**
 * 24.10 (7.50): a building's lamp table from the gateway (`/visual/wmo-lamps`, src/world/WmoLampTable.ts).
 *
 * One request per WMO path, asked as soon as a tile lists a placement of it (`LightTemplateCatalog`).
 * A 404 — a gateway older than the route, or a model the client does not ship — and a body that does
 * not parse are final: the building's lamp posts then light as their groups arrive, as before. Any
 * other failure retries on the 2 s / 8 s / 30 s ladder the other visual routes use, and meanwhile the
 * answer is "none", so the loading curtain never waits on a gateway that cannot answer.
 *
 * Answers are constants or the parsed table: a frame's asks allocate nothing.
 */
import { withVisualGeneration } from "./GatewayGeneration.js";
import { WMO_LAMP_TABLE_ROUTE, WMO_LAMP_TABLE_VERSION, parseWmoLampTable, type WmoLampTable } from "../world/WmoLampTable.js";

export type { WmoLampTable } from "../world/WmoLampTable.js";

/** The first request is on its way: the curtain may wait for it. */
export const LAMP_TABLE_PENDING = 0;
/** No table now (a failure being retried, or none for good): light as the groups arrive. */
export const LAMP_TABLE_NONE = 1;

/** What `LightTemplateCatalog` asks of the client; `key` is the path lower-cased with backslashes. */
export interface WmoLampTableSource {
  lookup(key: string, path: string): WmoLampTable | typeof LAMP_TABLE_PENDING | typeof LAMP_TABLE_NONE;
  /** Whether the answer for `key` will not change any more (a table, or none for good). */
  settled(key: string): boolean;
}

const RETRY_MS = [2_000, 8_000, 30_000] as const;

/** The URL of a WMO's lamp table. */
export function wmoLampTableUrl(baseUrl: string, wmoPath: string): string {
  const path = wmoPath.replaceAll("/", "\\");
  return withVisualGeneration(`${baseUrl}${WMO_LAMP_TABLE_ROUTE}?path=${encodeURIComponent(path)}&v=${WMO_LAMP_TABLE_VERSION}`);
}

export class WmoLampTableClient implements WmoLampTableSource {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** A table, or null: none for good. */
  readonly #tables = new Map<string, WmoLampTable | null>();
  readonly #pending = new Set<string>();
  readonly #retry = new Map<string, { attempts: number; at: number }>();
  /** Requests made and their outcomes (bench, tests). */
  readonly stats = { requests: 0, tables: 0, none: 0, failures: 0 };

  constructor(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = () => performance.now()) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  lookup(key: string, path: string): WmoLampTable | typeof LAMP_TABLE_PENDING | typeof LAMP_TABLE_NONE {
    const known = this.#tables.get(key);
    if (known !== undefined) return known ?? LAMP_TABLE_NONE;
    const retry = this.#retry.get(key);
    if (this.#pending.has(key)) return retry ? LAMP_TABLE_NONE : LAMP_TABLE_PENDING;
    if (retry && this.#now() < retry.at) return LAMP_TABLE_NONE;
    this.#pending.add(key);
    void this.#load(key, path);
    return retry ? LAMP_TABLE_NONE : LAMP_TABLE_PENDING;
  }

  settled(key: string): boolean {
    return this.#tables.has(key);
  }

  async #load(key: string, path: string): Promise<void> {
    this.stats.requests++;
    try {
      const response = await this.#fetch(wmoLampTableUrl(this.#baseUrl, path));
      if (response.status === 404 || response.status === 400) {
        this.#tables.set(key, null);
        this.stats.none++;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // A body that does not parse will not parse next time either.
      const table = parseWmoLampTable(await response.json() as unknown) ?? null;
      this.#tables.set(key, table);
      if (table) this.stats.tables++; else this.stats.none++;
      this.#retry.delete(key);
    } catch {
      this.stats.failures++;
      const attempts = (this.#retry.get(key)?.attempts ?? 0) + 1;
      if (attempts > RETRY_MS.length) {
        this.#tables.set(key, null);
        this.#retry.delete(key);
      } else this.#retry.set(key, { attempts, at: this.#now() + RETRY_MS[attempts - 1]! });
    } finally {
      this.#pending.delete(key);
    }
  }
}
