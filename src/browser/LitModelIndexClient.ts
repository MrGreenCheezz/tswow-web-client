/**
 * 25.10 (7.50): the gateway's index of models that give light by themselves (`/visual/lit-models`,
 * src/world/LitModelIndex.ts): one request per gateway, asked on the first frame of the cinematic light pass.
 *
 * A 404 or 400 — a gateway older than the route — and a body that does not parse are final: no index, and a
 * model past no name gate lights when its first placement is built, as before (`LightTemplateCatalog.noteLit`).
 * Any other failure retries on the 2 s / 8 s / 30 s ladder the other visual routes use, then gives up; while a
 * retry waits the answer is "none", so the loading curtain never waits on a gateway that cannot answer.
 */
import { withVisualGeneration } from "./GatewayGeneration.js";
import { LIT_MODEL_INDEX_ROUTE, LIT_MODEL_INDEX_VERSION, parseLitModelIndex } from "../world/LitModelIndex.js";

/** The first request is on its way: the curtain may wait for it. */
export const LIT_INDEX_PENDING = 0;
/** No index now (a failure being retried, or none for good). */
export const LIT_INDEX_NONE = 1;

/** What `LightTemplateCatalog` asks of the client. */
export interface LitModelIndexSource {
  /** The set of lit model keys (`litModelKey`), or why there is none; asking starts the request. */
  lookup(): ReadonlySet<string> | typeof LIT_INDEX_PENDING | typeof LIT_INDEX_NONE;
}

const RETRY_MS = [2_000, 8_000, 30_000] as const;

/** The URL of the index. */
export function litModelIndexUrl(baseUrl: string): string {
  return withVisualGeneration(`${baseUrl}${LIT_MODEL_INDEX_ROUTE}?v=${LIT_MODEL_INDEX_VERSION}`);
}

export class LitModelIndexClient implements LitModelIndexSource {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** The index, or null: none for good; undefined: not answered yet. */
  #index: ReadonlySet<string> | null | undefined;
  #pending = false;
  #attempts = 0;
  #retryAt = 0;
  /** Requests made and their outcomes (bench, tests). */
  readonly stats = { requests: 0, models: 0, failures: 0 };

  constructor(baseUrl: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = () => performance.now()) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  lookup(): ReadonlySet<string> | typeof LIT_INDEX_PENDING | typeof LIT_INDEX_NONE {
    const index = this.#index;
    if (index !== undefined) return index ?? LIT_INDEX_NONE;
    if (this.#pending) return this.#attempts > 0 ? LIT_INDEX_NONE : LIT_INDEX_PENDING;
    if (this.#attempts > 0 && this.#now() < this.#retryAt) return LIT_INDEX_NONE;
    this.#pending = true;
    void this.#load();
    return this.#attempts > 0 ? LIT_INDEX_NONE : LIT_INDEX_PENDING;
  }

  async #load(): Promise<void> {
    this.stats.requests++;
    try {
      const response = await this.#fetch(litModelIndexUrl(this.#baseUrl));
      if (response.status === 404 || response.status === 400) {
        this.#index = null;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // A body that does not parse will not parse next time either.
      const index = parseLitModelIndex(await response.json() as unknown) ?? null;
      this.#index = index;
      this.stats.models = index?.size ?? 0;
    } catch {
      this.stats.failures++;
      this.#attempts++;
      if (this.#attempts > RETRY_MS.length) this.#index = null;
      else this.#retryAt = this.#now() + RETRY_MS[this.#attempts - 1]!;
    } finally {
      this.#pending = false;
    }
  }
}
