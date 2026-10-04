// One ceiling for environment requests on the wire (10.21 (c), mechanism М-A10-6).
//
// `EnvironmentClient` (Terrain.ts) loads three kinds of environment payloads through three lanes —
// models (4), WMO groups (4) and animation sidecars (2) — and before this each lane counted only
// itself: up to ten requests at once. Chromium keeps six HTTP/1.1 connections per origin, so four of
// them queued inside the browser ahead of the unit-layer `/texture` requests, while the gateway
// builds cold artifacts one at a time anyway (`visualModelLane`), so the extra parallelism bought
// nothing but held sockets.
//
// The budget is shared by the three lanes: `limit` requests at once (4), and a `critical` request
// (the player's own model, a unit) may take one slot above it so it never waits behind scenery.
// The per-lane limits stay; the budget only stops the three from adding up. Pure: no timers, no
// I/O; `onRelease` lets the owner restart its other lanes when a slot frees.

export type EnvironmentRequestKind = "model" | "group" | "animation";
export type EnvironmentRequestPriority = "critical" | "normal" | "background";

export const ENVIRONMENT_REQUEST_LIMIT = 4;
/** Slots a `critical` request may take beyond the limit. */
export const ENVIRONMENT_REQUEST_CRITICAL_SPARE = 1;

export class EnvironmentRequestBudget {
  readonly limit: number;
  #active = 0;
  #peak = 0;
  readonly #onRelease: ((kind: EnvironmentRequestKind) => void) | undefined;

  constructor(limit = ENVIRONMENT_REQUEST_LIMIT, onRelease?: (kind: EnvironmentRequestKind) => void) {
    this.limit = Math.max(1, Math.floor(limit));
    this.#onRelease = onRelease;
  }

  /** Requests holding a slot now. */
  get active(): number {
    return this.#active;
  }

  /** The most slots ever held at once (diagnostics and tests). */
  get peak(): number {
    return this.#peak;
  }

  /** Whether a request of this priority would be admitted now (does not take a slot). */
  admits(priority: EnvironmentRequestPriority): boolean {
    return this.#active < this.limit
      || (priority === "critical" && this.#active < this.limit + ENVIRONMENT_REQUEST_CRITICAL_SPARE);
  }

  /**
   * A slot for one request, or `undefined` when the budget is spent. The returned function gives
   * the slot back; calling it again does nothing, so a `.finally` and an abort path may both call it.
   */
  tryAcquire(kind: EnvironmentRequestKind, priority: EnvironmentRequestPriority): (() => void) | undefined {
    if (!this.admits(priority)) return undefined;
    this.#active++;
    if (this.#active > this.#peak) this.#peak = this.#active;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#active--;
      this.#onRelease?.(kind);
    };
  }
}

/** `fetch` priority for a request class: scenery yields to everything else in Chromium's queue. */
export function environmentFetchPriority(priority: EnvironmentRequestPriority): RequestPriority | undefined {
  return priority === "background" ? "low" : undefined;
}
