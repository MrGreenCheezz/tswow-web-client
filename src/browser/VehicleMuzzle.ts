/**
 * 11.02 (04.11): where a steered unit's shot leaves from: Wow.exe 0x006fcd60 asks the model for its `$AIM` event, and 0x0071a720
 * then `$CSL`, `$CSR` and `$CST`; 0x008317e0 places the event on its bone. Without any of them it is the unit's own position.
 * The events come from `/visual/model-events` (tools/generate-model-events.mjs), once per model; a gateway older than the route
 * answers nothing and the shot leaves from the unit as before.
 */

/** One event as the file holds it: model coordinates, bone index. */
export interface ModelShotEvent {
  readonly id: string;
  readonly bone: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Wow.exe's reading order. */
const ORDER = ["$AIM", "$CSL", "$CSR", "$CST"];

/** The event a shot leaves from, or undefined. */
export function muzzleEvent(events: readonly ModelShotEvent[]): ModelShotEvent | undefined {
  for (const id of ORDER) {
    const event = events.find((candidate) => candidate.id === id);
    if (event !== undefined) return event;
  }
  return undefined;
}

export const MODEL_EVENTS_ROUTE = "/visual/model-events";
export const MODEL_EVENTS_VERSION = 1;

/** The events of each model asked for: undefined while it is on its way, an empty list when it has none. */
export class ModelShotEvents {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #known = new Map<string, readonly ModelShotEvent[] | undefined>();

  constructor(baseUrl: string, fetcher: typeof fetch = (...args) => fetch(...args)) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetcher;
  }

  /** The model's events; the first ask starts the request. `model` is the .mdx or .m2 path. */
  of(model: string): readonly ModelShotEvent[] | undefined {
    if (this.#known.has(model)) return this.#known.get(model);
    this.#known.set(model, undefined);
    const path = model.replace(/\.(mdx|mdl)$/i, ".m2");
    void this.#fetch(`${this.#baseUrl}${MODEL_EVENTS_ROUTE}?v=${MODEL_EVENTS_VERSION}&path=${encodeURIComponent(path)}`)
      .then((response) => (response.ok ? response.json() as Promise<{ events?: ModelShotEvent[] }> : { events: [] }))
      .then((answer) => this.#known.set(model, Array.isArray(answer.events) ? answer.events : []))
      .catch(() => this.#known.set(model, []));
    return undefined;
  }
}
