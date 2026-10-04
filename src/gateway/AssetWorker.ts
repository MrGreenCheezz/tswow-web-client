import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { constants, setPriority } from "node:os";
import { SOURCE_MISSING_EXIT } from "./GenerationLane.js";

/**
 * One publish, in the shape `tools/asset-worker.mjs` takes it. Every kind is an entry of
 * `ASSET_JOBS` in `tools/asset-jobs.mjs`, and `tests/asset-jobs.test.mjs` keeps the two lists equal.
 */
export type AssetWorkerJob =
  | { kind: "texture"; path: string }
  | { kind: "visual-model"; path: string; hash: string }
  | { kind: "item-icon"; displayId: number }
  | { kind: "spell-icon"; iconId: number }
  | { kind: "creature-icon"; familyId: number }
  | { kind: "minimap-index"; map: number }
  | { kind: "zone-map"; map: number }
  | { kind: "liquid"; liquidClass: string }
  | { kind: "client-file"; path: string }
  | { kind: "terrain-splat"; map: number; gridX: number; gridY: number }
  | { kind: "visual-tile"; map: number; gridX: number; gridY: number }
  | { kind: "horizon"; map: number }
  /** 10.22: the models a published visual tile places; answers `string[]`, or `null` when unpublished. */
  | { kind: "tile-models"; map: number; gridX: number; gridY: number };

export interface AssetWorkerOptions {
  /** `tools/asset-worker.mjs`, absolute. */
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Named in failures, so a log line says which family's worker died. */
  label: string;
  /** Registers the child with whoever kills children on shutdown. */
  track?: (child: ChildProcess) => ChildProcess;
  /** Retire after this long without a job, so the archives are not held open between visits. */
  idleMs?: number;
  /** Retire after this many jobs. */
  maxJobs?: number;
  /** Retire once the worker says its resident set has passed this. */
  maxRssBytes?: number;
  /**
   * Kill the child when one job has run this long (10.20 review): every job of the family waits
   * behind it, so a hung job would otherwise stall the family for the life of the gateway.
   */
  jobTimeoutMs?: number;
}

/**
 * 120 s. The slowest legitimate jobs measured on 02.10 are a cold visual tile (~1.4 s with the
 * worker's own start) and a Gundrak WMO with its textures (~2 s); this is some sixty times that.
 */
export const ASSET_JOB_TIMEOUT_MS = 120_000;

interface PendingJob {
  /** With the worker's `result` (only kinds registered with `result: true` send one). */
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** A job that has not been handed to the child yet. */
interface WaitingJob extends PendingJob {
  readonly job: AssetWorkerJob;
  readonly priority: number;
  readonly sequence: number;
}

interface WorkerReply {
  id?: unknown;
  ok?: unknown;
  missing?: unknown;
  message?: unknown;
  rss?: unknown;
  result?: unknown;
}

/**
 * One long-lived generator process for a family of assets, spawned on the first job and retired by
 * this side only.
 *
 * Why it exists is in `tools/asset-worker.mjs`: a cold texture was 387 ms as a process of its own
 * and 18 ms out of an archive chain already open. What this class adds is the lifetime, decided
 * here and never by the child, because a child that decides to stop races the job already on its
 * way to it:
 *
 * - **idle** — no job for `idleMs` (20 s): the child is disconnected and exits, closing the chain.
 *   A worker does not hold thirty file handles on the client's archives while nobody is walking
 *   anywhere new, and a dataset build that rewrites an archive does not find it open.
 * - **worn** — `maxJobs` jobs or `maxRssBytes` of resident memory: StormLib's WebAssembly heap
 *   only grows, so a worker is replaced before it gets large rather than trusted to stay small.
 * - **stale** — `recycle()`: the gateway saw the archives change, and a chain opened before the
 *   change would go on answering out of the old one.
 *
 * A retiring worker is forgotten at once and the next job spawns a new one; the old one finishes
 * whatever it was already given. A worker that dies with jobs in flight fails them without an
 * exit code, which the routes answer 500 — the browser retries those — and never 404, which it
 * would take as final.
 */
export class AssetWorker {
  readonly #options: Required<Omit<AssetWorkerOptions, "track">> & Pick<AssetWorkerOptions, "track">;
  #child: ChildProcess | undefined;
  /** Handed to the child and not answered yet: at most one (10.20). */
  #pending = new Map<number, PendingJob>();
  /** Not handed to the child yet; the highest priority goes next, then the oldest. */
  readonly #waiting: WaitingJob[] = [];
  #sequence = 0;
  #nextId = 1;
  #jobs = 0;
  #retireWhenIdle = false;
  #idleTimer: NodeJS.Timeout | undefined;
  /** Armed while the child has a job. */
  #jobTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: AssetWorkerOptions) {
    this.#options = {
      idleMs: 20_000,
      maxJobs: 2_000,
      maxRssBytes: 1_536 * 1024 * 1024,
      jobTimeoutMs: ASSET_JOB_TIMEOUT_MS,
      ...options,
    };
  }

  /**
   * Publishes one asset. The child is given one job at a time (10.20): inside it jobs run strictly
   * in arrival order, so a job sent ahead would make every later one wait behind it whatever its
   * priority. Here they wait instead, and the next one handed over is the most urgent
   * (`priority`, higher first; equal priorities in arrival order).
   */
  run(job: AssetWorkerJob, priority = 0): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`${this.#options.label} worker is closed`));
    return new Promise<unknown>((resolve, reject) => {
      this.#waiting.push({ job, priority, sequence: this.#sequence++, resolve, reject });
      this.#pump();
    });
  }

  /** Jobs waiting for the child (not counting the one it has). */
  get waiting(): number {
    return this.#waiting.length;
  }

  /** Hands the best waiting job to the child when it has none. */
  #pump(): void {
    if (this.#closed || this.#pending.size > 0 || this.#waiting.length === 0) return;
    let best = 0;
    for (let index = 1; index < this.#waiting.length; index++) {
      const candidate = this.#waiting[index]!;
      const chosen = this.#waiting[best]!;
      if (candidate.priority > chosen.priority
        || (candidate.priority === chosen.priority && candidate.sequence < chosen.sequence)) best = index;
    }
    const [next] = this.#waiting.splice(best, 1);
    this.#clearIdle();
    const child = this.#child ?? this.#spawn();
    const id = this.#nextId++;
    this.#pending.set(id, next!);
    this.#armJobTimer(child, id);
    try {
      child.send({ id, ...next!.job });
    } catch (error) {
      this.#pending.delete(id);
      next!.reject(error instanceof Error ? error : new Error(String(error)));
      queueMicrotask(() => this.#pump());
    }
  }

  /** The archives changed: the chain this worker holds is not the client's any more. */
  recycle(): void {
    if (this.#child === undefined) return;
    if (this.#pending.size === 0) this.#retire();
    else this.#retireWhenIdle = true;
  }

  close(): void {
    this.#closed = true;
    this.#clearIdle();
    this.#clearJobTimer();
    const child = this.#child;
    this.#child = undefined;
    this.#failPending(`${this.#options.label} worker closed`);
    // Waiting jobs too, and also without an exit code: a closing gateway is not "no such file".
    for (const job of this.#waiting.splice(0)) job.reject(new Error(`${this.#options.label} worker closed`));
    child?.kill();
  }

  #spawn(): ChildProcess {
    const options: ForkOptions & { windowsHide: boolean } = {
      cwd: this.#options.cwd,
      env: this.#options.env,
      execArgv: [],
      // `fork` hands its options to `spawn`, which honours this; the typings just do not list it.
      // Without it a gateway started without a console (the Electron app's) opens a window per
      // worker, as it would per generator child.
      windowsHide: true,
      // StormLib's WebAssembly build prints its banner and every heap resize on stdout, so stdout
      // is dropped; stderr is kept only to explain a death.
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    };
    const child = fork(this.#options.script, [], options);
    this.#options.track?.(child);
    this.#child = child;
    this.#jobs = 0;
    this.#retireWhenIdle = false;
    try {
      // Below the renderer it is serving: on a machine that is also running the game, a burst of
      // publishing should take idle cores, not frames.
      if (child.pid !== undefined) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Not permitted here; the worker runs at the gateway's own priority, as the children did.
    }
    let errors = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (data: string) => { errors = (errors + data).slice(-16_384); });
    child.on("message", (message: WorkerReply) => this.#answer(child, message));
    child.once("error", (error) => this.#died(child, error.message));
    child.once("exit", (code, signal) => {
      this.#died(child, `${errors.trim() || "no message"} (exit ${String(code ?? signal)})`);
    });
    return child;
  }

  #answer(child: ChildProcess, message: WorkerReply): void {
    const id = typeof message.id === "number" ? message.id : undefined;
    const job = id === undefined ? undefined : this.#pending.get(id);
    if (id === undefined || job === undefined) return;
    this.#pending.delete(id);
    this.#clearJobTimer();
    this.#jobs++;
    if (message.ok === true) job.resolve(message.result);
    else {
      const failure = new Error(typeof message.message === "string" ? message.message : `${this.#options.label} job failed`);
      // The one answer that is a fact about the file and not about this run: the routes read it
      // off the rejection exactly as they read a one-shot generator's exit code.
      if (message.missing === true) (failure as Error & { exitCode?: number }).exitCode = SOURCE_MISSING_EXIT;
      job.reject(failure);
    }
    // Only the worker the gateway is still sending to decides anything; a retired one is finishing.
    if (child !== this.#child || this.#pending.size > 0) {
      this.#pump();
      return;
    }
    const rss = typeof message.rss === "number" ? message.rss : 0;
    if (this.#retireWhenIdle || this.#jobs >= this.#options.maxJobs || rss >= this.#options.maxRssBytes) {
      // Retired between jobs: whatever waits goes to a fresh child (a changed client is read
      // through a new chain, a worn worker is replaced).
      this.#retire();
      this.#pump();
      return;
    }
    if (this.#waiting.length > 0) {
      this.#pump();
      return;
    }
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#child === child && this.#pending.size === 0) this.#retire();
    }, this.#options.idleMs);
    this.#idleTimer.unref();
  }

  #retire(): void {
    this.#clearIdle();
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined) return;
    // The worker closes its chain and exits when the channel goes; a kill is the fallback for one
    // that does not.
    try {
      if (child.connected) child.disconnect();
    } catch {
      // Already gone.
    }
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); }, 5_000).unref();
  }

  /**
   * A job that outlives `jobTimeoutMs` takes its child with it: the job fails without an exit code
   * (a 500 the browser retries), and the waiting jobs go to a fresh child, as after a crash.
   */
  #armJobTimer(child: ChildProcess, id: number): void {
    this.#clearJobTimer();
    this.#jobTimer = setTimeout(() => {
      this.#jobTimer = undefined;
      if (child !== this.#child || !this.#pending.has(id)) return;
      this.#died(child, `job timed out after ${String(this.#options.jobTimeoutMs)} ms`);
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }, this.#options.jobTimeoutMs);
    this.#jobTimer.unref();
  }

  #clearJobTimer(): void {
    if (this.#jobTimer !== undefined) clearTimeout(this.#jobTimer);
    this.#jobTimer = undefined;
  }

  #died(child: ChildProcess, reason: string): void {
    if (child !== this.#child) return;
    this.#child = undefined;
    this.#clearIdle();
    this.#clearJobTimer();
    this.#failPending(`${this.#options.label} worker died: ${reason}`);
    // Only the job the child had dies with it; the waiting ones go to a new child.
    this.#pump();
  }

  #failPending(reason: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    // No exit code: this is a 500 the browser retries, never the 404 it would take as final.
    for (const job of pending) job.reject(new Error(reason));
  }

  #clearIdle(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }
}
