import { frameBudgetProbe, type FrameBudgetId, type FrameBudgetProbe } from "./FrameBudgetProbe.js";

/** Limits synchronous resource construction, without holding stale jobs or world objects. */
export class FrameBuildBudget {
  #count = 0;
  #startedAt = 0;
  /** P2-09a: the start of the build `take` allowed and `done` has not closed (0: none, or the probe is off). */
  #probeAt = 0;

  constructor(
    readonly maxBuilds = 2,
    readonly milliseconds = 2,
    private readonly clock: () => number = () => performance.now(),
    /** P2-09a: the limiter this budget is in the frame budget sensor (`FrameBudgetProbe.ts`). */
    readonly probeId?: FrameBudgetId,
    /** P2-09a: the sensor (the shared one; a test gives its own clocked one). */
    private readonly probe: FrameBudgetProbe = frameBudgetProbe,
  ) {}

  begin(): void {
    this.#count = 0;
    this.#probeAt = 0;
  }

  /** Call only after dependencies are ready. One indivisible build may exceed the time slice. */
  take(): boolean {
    if (this.#count >= this.maxBuilds) return false;
    const now = this.clock();
    if (this.#count > 0 && now - this.#startedAt >= this.milliseconds) return false;
    if (this.#count === 0) this.#startedAt = now;
    this.#count++;
    if (this.probeId !== undefined) {
      // A build whose `done` was missed ends here: an upper bound rather than a lost build.
      this.done();
      this.#probeAt = this.probe.begin();
    }
    return true;
  }

  /** P2-09a: the build the last `take` allowed has finished. Nothing open, nothing done. */
  done(): void {
    if (this.#probeAt === 0) return;
    this.probe.end(this.probeId!, this.#probeAt);
    this.#probeAt = 0;
  }
}
