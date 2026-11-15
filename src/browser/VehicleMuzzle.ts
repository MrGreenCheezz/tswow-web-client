/**
 * 11.02 (04.11): where a steered unit's shot leaves from: Wow.exe 0x006fcd60 asks the model for its `$AIM` event, and 0x0071a720
 * then `$CSL`, `$CSR` and `$CST`; 0x008317e0 places the event on its bone. Without any of them it is the unit's own position.
 * The events come from `/visual/model-events` (tools/generate-model-events.mjs), once per model; a gateway older than the route
 * answers nothing and the shot leaves from the unit as before.
 *
 * 15.11 (events8): version 2 of the route serves every event the unit's model-event callback 0x00732650 acts on, each with
 * its keys per sequence (`keys`), and the model's sequences. A gateway that predates version 2 refuses it (400): the client
 * then asks version 1 once, which has positions and no keys — the moments are then unknown, as before.
 */

/** One event as the file holds it: model coordinates, bone index. */
export interface ModelShotEvent {
  readonly id: string;
  readonly bone: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 15.11 (events8): `[animationId, variation, [ms...]]` per sequence with keys; absent from a version 1 answer. */
  readonly keys?: readonly (readonly [number, number, readonly number[]])[];
  /** 15.11 (events8): the global sequence the track runs on, when it does. */
  readonly globalSequence?: number;
}

/** 15.11 (events8): a model's events and sequences; `sequences` undefined from a version 1 gateway. */
export interface ModelEvents {
  readonly events: readonly ModelShotEvent[];
  /** `[animationId, variation, duration ms]` for every sequence the model can play (0x00832ab0's records). */
  readonly sequences: readonly (readonly [number, number, number])[] | undefined;
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
/** tools/generate-model-events.mjs `MODEL_EVENTS_VERSION`. */
export const MODEL_EVENTS_VERSION = 2;
/** What a gateway before 15.11 answers. */
const MODEL_EVENTS_V1 = 1;

const NONE: ModelEvents = { events: [], sequences: undefined };

function eventsFrom(answer: unknown): ModelEvents {
  if (typeof answer !== "object" || answer === null) return NONE;
  const { events, sequences } = answer as { events?: unknown; sequences?: unknown };
  return {
    events: Array.isArray(events) ? events as ModelShotEvent[] : [],
    sequences: Array.isArray(sequences) ? sequences as [number, number, number][] : undefined,
  };
}

/** The events of each model asked for: undefined while it is on its way, an empty list when it has none. */
export class ModelShotEvents {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #known = new Map<string, ModelEvents | undefined>();

  constructor(baseUrl: string, fetcher: typeof fetch = (...args) => fetch(...args)) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetcher;
  }

  /** The model's events; the first ask starts the request. `model` is the .mdx or .m2 path. */
  of(model: string): readonly ModelShotEvent[] | undefined {
    return this.model(model)?.events;
  }

  /** 15.11 (events8): the model's events and sequences; undefined while on the way. */
  model(model: string): ModelEvents | undefined {
    if (this.#known.has(model)) return this.#known.get(model);
    this.#known.set(model, undefined);
    const path = encodeURIComponent(model.replace(/\.(mdx|mdl)$/i, ".m2"));
    const ask = (version: number): Promise<Response> =>
      this.#fetch(`${this.#baseUrl}${MODEL_EVENTS_ROUTE}?v=${version}&path=${path}`);
    void ask(MODEL_EVENTS_VERSION)
      .then((response) => (response.status === 400 ? ask(MODEL_EVENTS_V1) : response))
      .then((response) => (response.ok ? response.json() as Promise<unknown> : NONE))
      .then((answer) => this.#known.set(model, eventsFrom(answer)))
      .catch(() => this.#known.set(model, NONE));
    return undefined;
  }
}
