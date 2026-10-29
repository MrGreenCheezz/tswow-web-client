// 29.10: an ammo pair (SMSG_SPELL_GO's CAST_FLAG_AMMO, world/SpellAmmo.ts) → the model it flies as, from
// `/dbc/ammo-models` (gateway/AmmoModels.ts, Wow.exe 0x004eab50's rule). Batched per JavaScript turn and remembered
// for the tab: the answer to a display never changes within a dataset. A failed batch is asked again on the texture
// ladder; a 404 is a gateway that predates the route (it waits for the owner's restart), and then nothing flies —
// the shot itself still plays — until the page is reloaded.

import type { AmmoModel } from "../gateway/AmmoModels.js";
import type { SpellAmmo } from "../world/SpellAmmo.js";
import { IMAGE_RETRY_BACKOFF_MS } from "./CharacterAtlas.js";

/** `/dbc/ammo-models?v=`. */
export const AMMO_MODELS_VERSION = 1;
/** gateway/AmmoModels.ts AMMO_MODELS_MAX_ITEMS. */
const ITEMS_PER_REQUEST = 64;

const keyOf = (ammo: SpellAmmo): string => `${ammo.displayId}:${ammo.inventoryType}`;

export class AmmoModelClient {
  readonly #baseUrl: string;
  readonly #now: () => number;
  /** null: the display flies nothing (no record, another inventory type, or no second model/texture). */
  readonly #known = new Map<string, AmmoModel | null>();
  readonly #requested = new Set<string>();
  readonly #failures = new Map<string, { attempts: number; after: number }>();
  #queue: string[] = [];
  #scheduled = false;
  #absent = false;
  /** Called after every batch that settled something (answered, failed for good, or found the route absent). */
  onLoaded: ((models: readonly AmmoModel[]) => void) | undefined;

  /** @param gatewayWebSocketUrl the gateway's ws(s) or http(s) URL; only its origin is used. */
  constructor(gatewayWebSocketUrl: string, now: () => number = Date.now) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
    this.#now = now;
  }

  /**
   * The flight model of a pair: the model, null when it flies nothing (or will not be answered), undefined while
   * the answer is coming — asking for it if it is not.
   */
  model(ammo: SpellAmmo): AmmoModel | null | undefined {
    const key = keyOf(ammo);
    const known = this.#known.get(key);
    if (known !== undefined) return known;
    if (this.#absent) return null;
    if (this.#requested.has(key)) return undefined;
    const failure = this.#failures.get(key);
    if (failure) {
      if (failure.after === Infinity) return null;
      if (this.#now() < failure.after) return null;
    }
    this.#requested.add(key);
    this.#queue.push(key);
    if (!this.#scheduled) {
      this.#scheduled = true;
      void Promise.resolve().then(() => this.#flush());
    }
    return undefined;
  }

  async #flush(): Promise<void> {
    this.#scheduled = false;
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, ITEMS_PER_REQUEST);
      const settled: AmmoModel[] = [];
      try {
        const response = await fetch(`${this.#baseUrl}/dbc/ammo-models?v=${AMMO_MODELS_VERSION}&items=${batch.join(",")}`);
        if (response.status === 404) {
          this.#absent = true;
          for (const key of batch) this.#requested.delete(key);
          for (const key of this.#queue.splice(0)) this.#requested.delete(key);
          this.onLoaded?.(settled);
          return;
        }
        if (!response.ok) throw new Error(`ammo model gateway returned ${response.status}`);
        const value: unknown = await response.json();
        if (!Array.isArray(value) || !value.every(isAmmoModel)) throw new Error("ammo model gateway returned invalid data");
        const answered = new Map(value.map((model) => [keyOf(model), model]));
        for (const key of batch) {
          const model = answered.get(key);
          this.#known.set(key, model && model.model ? model : null);
          if (model && model.model) settled.push(model);
          this.#requested.delete(key);
          this.#failures.delete(key);
        }
      } catch {
        for (const key of batch) {
          this.#requested.delete(key);
          const attempts = (this.#failures.get(key)?.attempts ?? 0) + 1;
          const wait = IMAGE_RETRY_BACKOFF_MS[attempts - 1];
          this.#failures.set(key, { attempts, after: wait === undefined ? Infinity : this.#now() + wait });
        }
      }
      this.onLoaded?.(settled);
    }
  }
}

function isAmmoModel(value: unknown): value is AmmoModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return Number.isSafeInteger(model["displayId"]) && Number.isSafeInteger(model["inventoryType"])
    && typeof model["model"] === "string" && typeof model["texture"] === "string"
    && (model["itemVisual"] === undefined || Number.isSafeInteger(model["itemVisual"]));
}
