/** Limits synchronous resource construction, without holding stale jobs or world objects. */
export class FrameBuildBudget {
  #count = 0;
  #startedAt = 0;

  constructor(
    readonly maxBuilds = 2,
    readonly milliseconds = 2,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  begin(): void {
    this.#count = 0;
  }

  /** Call only after dependencies are ready. One indivisible build may exceed the time slice. */
  take(): boolean {
    if (this.#count >= this.maxBuilds) return false;
    const now = this.clock();
    if (this.#count > 0 && now - this.#startedAt >= this.milliseconds) return false;
    if (this.#count === 0) this.#startedAt = now;
    this.#count++;
    return true;
  }
}
