/**
 * 22.10 (12.14): the asset warm-up's models in worker mode. The page's warm-up (AssetWarmup.ts `SessionAssetWarmup`,
 * the spell-visual metadata warm in EnterWorld.ts) used to call `model()` on the page's environment client — a download
 * and a decode on the page that the worker, which draws, then asked the gateway for again (a 304 on a revalidating
 * route). In worker mode the page forwards the paths instead (app/WarmModelTarget.ts → the `#warmModels` command) and
 * they are asked for here, of the environment client the worker draws with, inside its resource frame as the page asked
 * them inside its own. Once a model is resident its textures are warmed into the browser cache, response-only, as the
 * page's warm-up does with the models it holds (`modelTextureUrls`).
 */

import { ASSET_WARMUP_BUDGET, BoundedWarmFetchQueue, modelTextureUrls, type WarmFetch, type WarmFetchPriority } from "./AssetWarmup.js";
import type { EnvironmentClient, ModelLoadPriority } from "./Terrain.js";

/** Paths waiting for their model at once; the page's own lanes are smaller than this (AssetWarmup.ts budgets). */
export const WORKER_MODEL_WARM_LIMIT = 128;

const RANK: Readonly<Record<ModelLoadPriority, number>> = { background: 0, normal: 1, critical: 2 };

/** The texture lane a model's warm priority stands for (AssetWarmup.ts: the player's are critical, spells normal). */
function textureLane(priority: ModelLoadPriority): WarmFetchPriority {
  return priority === "critical" ? "player" : priority === "normal" ? "spell" : "scenery";
}

export type WarmModelClient = Pick<EnvironmentClient, "model" | "modelState" | "baseUrl">;

export class RenderWorkerModelWarmup {
  readonly #pending = new Map<string, ModelLoadPriority>();
  readonly #textures: BoundedWarmFetchQueue;
  /** Paths asked of the client and then left (resident, absent or failed), so a repeat does not ask again. */
  readonly #done = new Set<string>();

  constructor(fetcher?: WarmFetch) {
    this.#textures = new BoundedWarmFetchQueue(fetcher, ASSET_WARMUP_BUDGET.textures, ASSET_WARMUP_BUDGET.textureConcurrency);
  }

  get pending(): number { return this.#pending.size; }

  /** One forwarded path; a higher priority than the one waiting replaces it. */
  add(path: string, priority: ModelLoadPriority): void {
    if (typeof path !== "string" || path.length === 0 || this.#done.has(path)) return;
    const waiting = this.#pending.get(path);
    if (waiting !== undefined) {
      if (RANK[priority] > RANK[waiting]) this.#pending.set(path, priority);
      return;
    }
    if (this.#pending.size >= WORKER_MODEL_WARM_LIMIT) return;
    this.#pending.set(path, RANK[priority] === undefined ? "normal" : priority);
  }

  /**
   * Asks the client for every waiting path (call inside its resource frame, so the asks count as this frame's demand,
   * as the page's warm-up did); a path whose model has an answer leaves the queue, and a resident one's textures go to
   * the browser cache.
   */
  apply(client: WarmModelClient | undefined): void {
    if (client === undefined || this.#pending.size === 0) return;
    for (const [path, priority] of this.#pending) {
      const model = client.model(path, priority);
      if (model !== undefined) {
        this.#textures.add(modelTextureUrls(model, client.baseUrl), textureLane(priority));
      } else if (client.modelState(path) === "pending") continue;
      this.#pending.delete(path);
      this.#done.add(path);
    }
  }

  /** Another set of clients (a world entry): what waited is asked of the new one; nothing counts as done there yet. */
  clientsChanged(): void {
    this.#done.clear();
  }

  dispose(): void {
    this.#pending.clear();
    this.#textures.close();
  }
}
