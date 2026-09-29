/** A safe load boundary: Lua chunks and individual widget declarations remain atomic. */
export type GlueLoadCheckpoint = () => void | Promise<void>;

/** Yield to a browser task, not a resolved Promise (which would still starve paint/input). */
export class GlueLoadScheduler {
  readonly #now: () => number;
  readonly #yieldTask: () => Promise<void>;
  readonly #milliseconds: number;
  #started: number;
  #pending: Promise<void> | undefined;

  constructor(options: {
    readonly now?: () => number;
    readonly yieldTask?: () => Promise<void>;
    readonly milliseconds?: number;
  } = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#yieldTask = options.yieldTask ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
    this.#milliseconds = options.milliseconds ?? 8;
    this.#started = this.#now();
  }

  readonly checkpoint: GlueLoadCheckpoint = () => {
    if (this.#pending) return this.#pending;
    if (this.#now() - this.#started < this.#milliseconds) return;
    this.#pending = this.#yieldTask().finally(() => {
      this.#started = this.#now();
      this.#pending = undefined;
    });
    return this.#pending;
  };
}
