import type { GameObjectDisplayMetadata } from "../gateway/GameObjectMetadata.js";

export type { GameObjectDisplayMetadata };

/** How many ids the route accepts in one request. */
const BATCH_LIMIT = 200;

export class GameObjectMetadataClient {
  readonly #baseUrl: string;
  readonly #cache = new Map<number, GameObjectDisplayMetadata>();
  readonly #requested = new Set<number>();

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  get(id: number): GameObjectDisplayMetadata | undefined {
    return this.#cache.get(id);
  }

  async load(ids: readonly number[]): Promise<boolean> {
    const missing = [...new Set(ids)].filter((id) => id > 0 && !this.#requested.has(id));
    if (missing.length === 0) return false;
    for (const id of missing) this.#requested.add(id);
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
        for (const metadata of value) this.#cache.set(metadata.id, metadata);
      }
      return true;
    } catch (error) {
      for (const id of missing) this.#requested.delete(id);
      throw error;
    }
  }
}

function isMetadata(value: unknown): value is GameObjectDisplayMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return typeof metadata.id === "number" && typeof metadata.model === "string";
}
