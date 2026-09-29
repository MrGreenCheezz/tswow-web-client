/**
 * One gateway catalog (`GET /dbc/<name>?v=<n>`, gateway/CatalogRoutes.ts), fetched until it lands.
 *
 * The clients before this one (CharTitleClient, FactionClient, TalentClient) fetch once, and a
 * failed fetch leaves the table empty until the page is reloaded — nobody calls `load()` again.
 * That is survivable for a picker; it is not for a mechanic such as the area triggers, and the
 * common failure is not a broken network but a gateway process older than the route, which
 * answers 404 until the owner restarts it (IMPLEMENTATION_PLAN §6). So the retry is scheduled here,
 * by the client itself:
 *
 * - success is memoised: `load()` after it does nothing, and `onLoaded` is told once;
 * - failure is not: attempt 1 at once, then after 2, 5, 15 and 60 s, the last pause repeating, six
 *   attempts in all, and then `failed` until `retry()` — which the next world mount calls;
 * - a 404 (a gateway without the route) or a 400 (one that serves it at another `?v=`) is an older
 *   gateway rather than a bad moment: one more attempt after 15 s, and a second such answer ends the
 *   cycle at once instead of asking every minute for a route that is not there;
 * - `stop()` (a world leave) ends the schedule, so nothing is asked behind the character screen.
 *
 * The clock and `fetch` are injected, so the schedule is tested without waiting for it.
 */

export type CatalogState = "idle" | "loading" | "ready" | "failed";

/** The two timer calls the schedule needs; `globalThis` in the page, a fake in tests. */
export interface CatalogClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RetryingCatalogOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: CatalogClock;
  /** Pauses before the second, third… attempt; the last one repeats. */
  readonly delays?: readonly number[];
  /** Attempts in one cycle before the client waits for `retry()`. */
  readonly maxAttempts?: number;
  /** The single pause after a 404 or a 400. */
  readonly staleGatewayDelay?: number;
}

export const CATALOG_RETRY_DELAYS: readonly number[] = Object.freeze([2_000, 5_000, 15_000, 60_000]);
export const CATALOG_MAX_ATTEMPTS = 6;
export const CATALOG_STALE_GATEWAY_DELAY = 15_000;

const SYSTEM_CLOCK: CatalogClock = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export class RetryingCatalogClient<T> {
  /** The absolute URL asked for, `?v=` included. */
  readonly url: string;
  readonly #validate: (data: unknown) => T | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: CatalogClock;
  readonly #delays: readonly number[];
  readonly #maxAttempts: number;
  readonly #staleGatewayDelay: number;
  #state: CatalogState = "idle";
  #value: T | undefined;
  /** Attempts made in the current cycle; `retry()` starts a new cycle. */
  #attempts = 0;
  /** Whether the current cycle has already been answered by an older gateway once. */
  #staleSeen = false;
  #timer: unknown;
  /** The latest attempt, shared by concurrent `load()` calls. */
  #inFlight: Promise<void> | undefined;
  /** Bumped by `stop()`, so an answer arriving afterwards is ignored. */
  #generation = 0;
  #lastStatus: number | undefined;
  /** Told once, when a valid answer lands. */
  onLoaded: ((value: T) => void) | undefined;

  constructor(
    origin: string,
    path: string,
    validate: (data: unknown) => T | undefined,
    options: RetryingCatalogOptions = {},
  ) {
    this.url = new URL(path, origin).href;
    this.#validate = validate;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#delays = options.delays?.length ? options.delays : CATALOG_RETRY_DELAYS;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? CATALOG_MAX_ATTEMPTS);
    this.#staleGatewayDelay = options.staleGatewayDelay ?? CATALOG_STALE_GATEWAY_DELAY;
  }

  get state(): CatalogState {
    return this.#state;
  }

  /** The validated answer; undefined until it lands. */
  get value(): T | undefined {
    return this.#value;
  }

  /** The last attempt's HTTP status, 0 when the request itself failed; undefined before any. */
  get lastStatus(): number | undefined {
    return this.#lastStatus;
  }

  /** Attempts made in the current cycle. */
  get attempts(): number {
    return this.#attempts;
  }

  /**
   * Starts the first cycle; afterwards only reports on it. Resolves when the latest attempt settles
   * (at once while a retry is merely scheduled) and never rejects. After `failed` it does nothing —
   * that is `retry()`'s job.
   */
  load(): Promise<void> {
    if (this.#state === "idle") this.#startCycle();
    return this.#inFlight ?? Promise.resolve();
  }

  /**
   * A new cycle after `failed` or `stop()` (or the first one). While loading — an attempt in flight
   * or one scheduled — or loaded, the same as `load()`: it never adds a request.
   */
  retry(): Promise<void> {
    if (this.#state === "failed") this.#state = "idle";
    return this.load();
  }

  /** Ends the schedule and ignores any answer still on the way; a value already held is kept. */
  stop(): void {
    this.#generation++;
    this.#cancelTimer();
    this.#inFlight = undefined;
    if (this.#state === "loading") this.#state = "idle";
  }

  #startCycle(): void {
    this.#state = "loading";
    this.#attempts = 0;
    this.#staleSeen = false;
    this.#attempt();
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #attempt(): void {
    this.#timer = undefined;
    const generation = this.#generation;
    this.#attempts++;
    // A failed attempt is not memoised as the answer: the retry is a new request and a new promise.
    this.#inFlight = this.#request().then((outcome) => {
      if (generation !== this.#generation) return;
      this.#settle(outcome);
    });
  }

  async #request(): Promise<{ value: T } | { status: number }> {
    try {
      const response = await this.#fetch(this.url);
      if (!response.ok) return { status: response.status };
      const value = this.#validate(await response.json() as unknown);
      // A 200 whose body is not this shape is a failure like any other: another attempt may meet a
      // gateway that has been restarted into the right version.
      return value === undefined ? { status: response.status } : { value };
    } catch {
      return { status: 0 };
    }
  }

  #settle(outcome: { value: T } | { status: number }): void {
    if ("value" in outcome) {
      this.#lastStatus = 200;
      this.#value = outcome.value;
      this.#state = "ready";
      this.onLoaded?.(outcome.value);
      return;
    }
    this.#lastStatus = outcome.status;
    let delay: number | undefined;
    if (this.#attempts < this.#maxAttempts) {
      if (outcome.status === 404 || outcome.status === 400) {
        if (!this.#staleSeen) {
          this.#staleSeen = true;
          delay = this.#staleGatewayDelay;
        }
      } else {
        delay = this.#delays[Math.min(this.#attempts - 1, this.#delays.length - 1)];
      }
    }
    if (delay === undefined) {
      this.#state = "failed";
      return;
    }
    this.#timer = this.#clock.setTimeout(() => this.#attempt(), delay);
  }
}
