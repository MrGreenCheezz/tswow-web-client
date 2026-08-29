import type { GameObjectDisplayMetadata } from "../gateway/GameObjectMetadata.js";
import type { BenchmarkAsyncReadinessStats } from "./RenderBenchmarkReadiness.js";

export type { GameObjectDisplayMetadata };

/** How many ids the route accepts in one request. */
const BATCH_LIMIT = 200;

export class GameObjectMetadataClient {
  readonly #baseUrl: string;
  readonly #cache = new Map<number, GameObjectDisplayMetadata>();
  readonly #requested = new Set<number>();
  readonly #httpPending = new Set<number>();
  readonly #failures = new Map<number, { attempts: number; after: number }>();
  #pending = 0;
  #success = 0;
  #error = 0;
  #generation = 0;
  readonly #now: () => number;

  /** Immutable current batch ownership; finite retry delays remain pending work. */
  get stats(): Readonly<BenchmarkAsyncReadinessStats> {
    const pending = new Set<number>(this.#httpPending);
    for (const [id, failure] of this.#failures) {
      if (failure.after !== Infinity && !this.#httpPending.has(id)) pending.add(id);
    }
    return Object.freeze({
      pending: pending.size,
      success: this.#success,
      error: [...this.#failures.values()].filter((failure) => failure.after === Infinity).length,
      generation: this.#generation,
    });
  }

  get generation(): number {
    return this.#generation;
  }

  get revision(): number {
    return this.#generation;
  }

  constructor(gatewayWebSocketUrl: string, now: () => number = Date.now) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#now = now;
  }

  get(id: number): GameObjectDisplayMetadata | undefined {
    return this.#cache.get(id);
  }

  async load(ids: readonly number[]): Promise<boolean> {
    const now = this.#now();
    const missing = [...new Set(ids)].filter((id) => id > 0 && !this.#requested.has(id)
      && (this.#failures.get(id)?.after ?? 0) <= now);
    if (missing.length === 0) return false;
    for (const id of missing) {
      this.#requested.add(id);
      this.#httpPending.add(id);
      this.#failures.delete(id);
    }
    this.#pending++;
    let settled = false;
    const settle = (success: boolean): void => {
      if (settled) return;
      settled = true;
      this.#pending--;
      for (const id of missing) this.#httpPending.delete(id);
      this.#generation++;
      if (success) this.#success++;
      else this.#error++;
    };
    try {
      // In batches, because the route refuses more than two hundred ids and this used to hand it
      // whatever it was given. It was never given more than forty — the caller capped the whole
      // nearby list at that — and the moment the game objects got a list of their own, an
      // unchunked request would have been a 400 for the whole city.
      for (let offset = 0; offset < missing.length; offset += BATCH_LIMIT) {
        const batch = missing.slice(offset, offset + BATCH_LIMIT);
        const response = await fetch(`${this.#baseUrl}/dbc/gameobjects?ids=${batch.join(",")}`);
        if (!response.ok) throw new Error(`GameObject metadata gateway returned ${response.status}`);
        const value: unknown = await response.json();
        if (!Array.isArray(value) || !value.every(isMetadata)) throw new Error("GameObject metadata gateway returned invalid data");
        for (const metadata of value) {
          const previous = this.#cache.get(metadata.id);
          this.#cache.set(metadata.id, metadata);
          if (!sameMetadata(previous, metadata)) this.#generation++;
        }
      }
      settle(true);
      return true;
    } catch (error) {
      for (const id of missing) this.#requested.delete(id);
      for (const id of missing) this.#httpPending.delete(id);
      for (const id of missing) {
        const attempts = (this.#failures.get(id)?.attempts ?? 0) + 1;
        const wait = GAME_OBJECT_METADATA_RETRY_MS[attempts - 1];
        this.#failures.set(id, {
          attempts,
          after: wait === undefined ? Infinity : this.#now() + wait,
        });
      }
      settle(false);
      throw error;
    }
  }
}

function isMetadata(value: unknown): value is GameObjectDisplayMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return typeof metadata.id === "number" && typeof metadata.model === "string";
}

const GAME_OBJECT_METADATA_RETRY_MS: readonly number[] = [2_000, 8_000, 30_000];

function sameMetadata(left: GameObjectDisplayMetadata | undefined, right: GameObjectDisplayMetadata): boolean {
  return left?.id === right.id && left.model === right.model;
}
