/**
 * Asynchronous WebGL2 frame timing without ever waiting for the GPU.
 *
 * The browser exposes elapsed GPU time in nanoseconds. Queries are deliberately kept behind this
 * small interface so queueing, loss and disjoint behaviour can be tested without a real canvas.
 */

import { FrameClock, type FrameSnapshot } from "./RenderStats.js";

export const MAX_PENDING_GPU_QUERIES = 4;

export interface DisjointTimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

export interface GpuTimerGl<Query> {
  readonly QUERY_RESULT_AVAILABLE: number;
  readonly QUERY_RESULT: number;
  getExtension(name: string): unknown;
  getParameter(parameter: number): unknown;
  createQuery(): Query | null;
  beginQuery(target: number, query: Query): void;
  endQuery(target: number): void;
  getQueryParameter(query: Query, parameter: number): unknown;
  deleteQuery(query: Query): void;
  isContextLost(): boolean;
}

export type GpuTimerUnavailableReason = "unsupported" | "context-lost" | "disjoint" | "query-error";

/** Stable event sink for completed queries and validity/coverage changes. */
export interface GpuTimerObserver {
  onSample?(milliseconds: number): void;
  onUnavailable?(reason: GpuTimerUnavailableReason): void;
  onDropped?(count: number, reason: GpuTimerDropReason): void;
}

export type GpuTimerDropReason = "queue-full" | "discarded" | "epoch-reset";

interface GpuTimerReadingBase {
  readonly pending: number;
  readonly dropped: number;
}

export type GpuTimerReading =
  | (GpuTimerReadingBase & FrameSnapshot & { readonly status: "available"; readonly milliseconds: number })
  | (GpuTimerReadingBase & { readonly status: "pending" })
  | (GpuTimerReadingBase & {
    readonly status: "unavailable";
    readonly reason: GpuTimerUnavailableReason;
  });

/**
 * A bounded FIFO of elapsed-time queries. Polling reads QUERY_RESULT only after the corresponding
 * availability flag is true; a full queue skips a sample instead of allocating without bound.
 */
export class GpuTimer<Query> {
  readonly #gl: GpuTimerGl<Query> | undefined;
  readonly #observer: GpuTimerObserver | undefined;
  #extension: DisjointTimerQueryExtension | null | undefined;
  readonly #pending: Query[] = [];
  #active: Query | undefined;
  #milliseconds: number | undefined;
  readonly #samples = new FrameClock();
  #reason: GpuTimerUnavailableReason | undefined;
  #dropped = 0;

  constructor(gl?: GpuTimerGl<Query>, observer?: GpuTimerObserver) {
    this.#gl = gl;
    this.#observer = observer;
    if (!gl) {
      this.#extension = null;
      this.#setReason("unsupported");
      return;
    }
    this.#acquireExtension();
  }

  /** Begins one frame sample. False means this frame is intentionally not being measured. */
  beginFrame(): boolean {
    if (this.#active !== undefined) return false;
    if (!this.#poll()) return false;
    const gl = this.#gl;
    const extension = this.#extension;
    if (!gl || !extension) return false;
    if (this.#pending.length >= MAX_PENDING_GPU_QUERIES) {
      this.#recordDropped(1, "queue-full");
      return false;
    }

    let query: Query | null;
    try {
      query = gl.createQuery();
    } catch {
      const contextLost = this.#contextLost();
      if (contextLost) this.#loseContext();
      else this.#fail("query-error", true);
      return false;
    }
    if (query === null) {
      const contextLost = this.#contextLost();
      if (contextLost) this.#loseContext();
      else this.#fail("query-error", true);
      return false;
    }
    try {
      gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
      this.#active = query;
      return true;
    } catch {
      const contextLost = this.#contextLost();
      if (contextLost) this.#loseContext();
      else {
        // Publish the causal failure before its cleanup drop. Accumulators keep the first invalid
        // reason, so reporting these in the opposite order would mislabel this as query-discard.
        this.#setReason("query-error");
        this.#safeDelete(query);
        this.#recordDropped(1, "discarded");
        this.#fail("query-error", true);
      }
      return false;
    }
  }

  /** Ends a successful beginFrame. The query joins the FIFO only after endQuery succeeds. */
  endFrame(): void {
    const query = this.#active;
    if (query === undefined) return;
    const gl = this.#gl;
    const extension = this.#extension;
    if (!gl || !extension) {
      this.#active = undefined;
      this.#recordDropped(1, "discarded");
      return;
    }
    if (this.#contextLost()) {
      this.#loseContext();
      return;
    }
    try {
      gl.endQuery(extension.TIME_ELAPSED_EXT);
      this.#active = undefined;
      this.#pending.push(query);
    } catch {
      const contextLost = this.#contextLost();
      if (contextLost) this.#loseContext();
      else this.#fail("query-error", true);
    }
  }

  /** Polls without blocking and returns an immutable diagnostic reading. */
  get reading(): Readonly<GpuTimerReading> {
    this.#poll();
    const base = { pending: this.#pending.length + (this.#active === undefined ? 0 : 1), dropped: this.#dropped };
    if (this.#reason !== undefined) {
      return Object.freeze({ ...base, status: "unavailable" as const, reason: this.#reason });
    }
    if (this.#milliseconds !== undefined) {
      return Object.freeze({
        ...base,
        ...this.#samples.snapshot(),
        status: "available" as const,
        milliseconds: this.#milliseconds,
      });
    }
    return Object.freeze({ ...base, status: "pending" as const });
  }

  /**
   * Discards the current timing epoch without disabling future samples.
   *
   * Pending/active queries are reported as dropped before the public lifetime counter is reset, so
   * a benchmark can invalidate its own coverage without inheriting pre-run diagnostic history.
   */
  resetEpoch(): GpuTimerUnavailableReason | undefined {
    const contextLost = this.#contextLost();
    if (contextLost) this.#setReason("context-lost");
    this.#dropQueries(!contextLost, "epoch-reset");
    this.#dropped = 0;
    this.#milliseconds = undefined;
    this.#samples.reset();
    if (contextLost) {
      this.#extension = undefined;
      return this.#reason;
    }
    if (this.#extension === undefined) this.#acquireExtension();
    if (this.#extension === undefined) return this.#reason;
    if (this.#extension === null) this.#setReason("unsupported");
    else this.#setReason(undefined);
    return this.#reason;
  }

  /** Deletes every query while the context is valid and permanently stops future samples. */
  dispose(): void {
    this.#dropQueries(!this.#contextLost(), "discarded");
    this.#extension = null;
    this.#milliseconds = undefined;
    this.#samples.reset();
    this.#setReason("unsupported");
  }

  /** False means this frame must not open a fresh query. */
  #poll(): boolean {
    const gl = this.#gl;
    if (!gl) return false;
    if (this.#contextLost()) {
      this.#loseContext();
      return false;
    }
    if (this.#extension === undefined) this.#acquireExtension();
    const extension = this.#extension;
    if (!extension) return false;

    const originalLength = this.#pending.length;
    let read = 0;
    let write = 0;
    try {
      // A disjoint invalidates the whole timing epoch, including queries which are not available
      // yet. Sample it once per poll and never touch QUERY_RESULT when it is set.
      if (Boolean(gl.getParameter(extension.GPU_DISJOINT_EXT))) {
        this.#fail("disjoint", true);
        return false;
      }

      for (; read < originalLength; read++) {
        const query = this.#pending[read]!;
        if (!Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))) {
          this.#pending[write++] = query;
          continue;
        }
        const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT);
        if (typeof nanoseconds !== "number" || !Number.isFinite(nanoseconds) || nanoseconds < 0) {
          throw new Error("invalid GPU timer result");
        }
        this.#safeDelete(query);
        this.#milliseconds = nanoseconds / 1_000_000;
        this.#samples.add(this.#milliseconds);
        this.#notifySample(this.#milliseconds);
      }
      this.#pending.length = write;
      this.#setReason(undefined);
      return true;
    } catch {
      // Keep unresolved and not-yet-visited queries only. Completed queries before `read` were
      // already deleted and must not be counted or deleted again if a later query fails.
      for (let tail = read; tail < originalLength; tail++) this.#pending[write++] = this.#pending[tail]!;
      this.#pending.length = write;
      const contextLost = this.#contextLost();
      if (contextLost) this.#loseContext();
      else this.#fail("query-error", true);
      return false;
    }
  }

  #acquireExtension(): void {
    const gl = this.#gl;
    if (!gl) return;
    if (this.#contextLost()) {
      this.#loseContext();
      return;
    }
    try {
      const candidate = gl.getExtension("EXT_disjoint_timer_query_webgl2") as Partial<DisjointTimerQueryExtension> | null;
      if (!candidate || !Number.isFinite(candidate.TIME_ELAPSED_EXT)
        || !Number.isFinite(candidate.GPU_DISJOINT_EXT)) {
        this.#extension = null;
        this.#setReason("unsupported");
        return;
      }
      this.#extension = candidate as DisjointTimerQueryExtension;
      this.#setReason(undefined);
    } catch {
      const contextLost = this.#contextLost();
      if (contextLost) this.#loseContext();
      else {
        this.#extension = undefined;
        this.#setReason("query-error");
      }
    }
  }

  #contextLost(): boolean {
    try {
      return this.#gl?.isContextLost() ?? false;
    } catch {
      return true;
    }
  }

  #loseContext(): void {
    this.#setReason("context-lost");
    this.#dropQueries(false, "discarded");
    // Extension objects become invalid on loss. Undefined asks for a fresh object after restore.
    this.#extension = undefined;
    this.#milliseconds = undefined;
    this.#samples.reset();
  }

  #fail(reason: GpuTimerUnavailableReason, deleteQueries: boolean): void {
    this.#setReason(reason);
    this.#dropQueries(deleteQueries, "discarded");
    this.#milliseconds = undefined;
    this.#samples.reset();
  }

  #dropQueries(deleteQueries: boolean, reason: GpuTimerDropReason): void {
    const queries = this.#active === undefined ? [...this.#pending] : [this.#active, ...this.#pending];
    this.#recordDropped(queries.length, reason);
    this.#active = undefined;
    this.#pending.length = 0;
    if (deleteQueries) for (const query of queries) this.#safeDelete(query);
  }

  #safeDelete(query: Query): void {
    try {
      this.#gl?.deleteQuery(query);
    } catch {
      // Deletion is best-effort during teardown; the queue is still bounded and forgets the query.
    }
  }

  #setReason(reason: GpuTimerUnavailableReason | undefined): void {
    if (this.#reason === reason) return;
    this.#reason = reason;
    if (reason === undefined) return;
    try { this.#observer?.onUnavailable?.(reason); } catch { /* diagnostics never break rendering */ }
  }

  #recordDropped(count: number, reason: GpuTimerDropReason): void {
    if (count <= 0) return;
    this.#dropped += count;
    try { this.#observer?.onDropped?.(count, reason); } catch { /* diagnostics never break rendering */ }
  }

  #notifySample(milliseconds: number): void {
    try { this.#observer?.onSample?.(milliseconds); } catch { /* diagnostics never break rendering */ }
  }
}

/** Builds the real timer only for a WebGL2-shaped context; WebGL1 reports unsupported explicitly. */
export function createWebGlGpuTimer(
  context: WebGLRenderingContext,
  observer?: GpuTimerObserver,
): GpuTimer<WebGLQuery> {
  const candidate = context as WebGLRenderingContext & Partial<WebGL2RenderingContext>;
  if (typeof candidate.createQuery !== "function" || typeof candidate.beginQuery !== "function"
    || typeof candidate.endQuery !== "function" || typeof candidate.getQueryParameter !== "function"
    || typeof candidate.deleteQuery !== "function") {
    return new GpuTimer<WebGLQuery>(undefined, observer);
  }
  return new GpuTimer<WebGLQuery>(candidate as WebGL2RenderingContext, observer);
}
