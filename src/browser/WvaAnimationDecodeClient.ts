import type { WvmSkeletonClip } from "./Wvm.js";
import {
  decodeWvaAnimationRequest, decodedAnimationResidencyCost, unpackWvaAnimations,
} from "./WvaAnimationDecode.js";
import {
  WVA_CHANNEL_STRIDE, WVA_CLIP_STRIDE,
  type WvaAnimationDecodeRequest, type WvaAnimationDecodeResponse, type WvaAnimationDecodeResult,
  type WvaPackedAnimations,
} from "./WvaAnimationDecodeProtocol.js";

/** Both network lanes remain occupied until decode completes: no third response can accumulate. */
export const WVA_ANIMATION_DECODE_LIMIT = 2;

/** Only a rejected WVA payload should bypass HTTP cache on the scheduler's next attempt. */
export class WvaAnimationPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WvaAnimationPayloadError";
  }
}

export interface WvaAnimationWorker {
  onmessage: ((event: MessageEvent<WvaAnimationDecodeResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: WvaAnimationDecodeRequest, transfer: ArrayBuffer[]): void;
  terminate(): void;
}

interface DecodeJob extends WvaAnimationDecodeRequest {
  readonly resolve: (result: WvaAnimationDecodeResult) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
  /** Held sets the worker was told about, kept strongly until it answers with one of them. */
  held: Map<string, WvmSkeletonClip[]>;
}

/** A decoded set this client handed out, by the content it was decoded from. */
interface DecodedContent {
  readonly bones: number;
  readonly digest: string;
  readonly clips: WeakRef<WvmSkeletonClip[]>;
}

function createAnimationWorker(): WvaAnimationWorker | undefined {
  if (typeof Worker !== "undefined") {
    // Vite bundles the TS entry; NodeNext leaves this URL alone for the browser build.
    return new Worker(new URL("./WvaAnimationDecode.worker.ts", import.meta.url), {
      type: "module", name: "wva-animation-decode",
    });
  }
  if (typeof window !== "undefined") throw new Error("Animation decoding requires a Web Worker");
  // Pure Node tooling and existing source tests retain the synchronous decoder contract.
  return undefined;
}

/**
 * One lazy worker, one dispatched job, and at most one waiting input owned by the caller.
 *
 * Byte-identical blocks decoded for the same rig resolve to the same clip array — the
 * HumanMalGuard/_withHelm pair ships one sidecar twice — so a consumer that compiles by clip
 * identity compiles them once. A block whose digest names a set still alive is not decoded at all;
 * two copies that were decoded concurrently collapse onto the first on arrival. The registry holds
 * only weak references: it keeps nothing alive that its users have let go of.
 */
export class WvaAnimationDecodeClient {
  readonly #queue: DecodeJob[] = [];
  readonly #contents = new Map<string, DecodedContent>();
  #active: DecodeJob | undefined;
  #worker: WvaAnimationWorker | undefined;
  #nextId = 1;
  #disposed = false;

  constructor(private readonly createWorker: () => WvaAnimationWorker | undefined = createAnimationWorker) {}

  decode(data: ArrayBuffer, bones: number, signal?: AbortSignal): Promise<WvaAnimationDecodeResult> {
    if (this.#disposed || signal?.aborted) return Promise.reject(abortedDecode());
    if (this.#queue.length + Number(this.#active !== undefined) >= WVA_ANIMATION_DECODE_LIMIT) {
      return Promise.reject(new Error("Animation decode queue is full"));
    }
    return new Promise((resolve, reject) => {
      const job: DecodeJob = {
        id: this.#nextId++, data, bones, resolve, reject, signal,
        abort: () => this.#cancel(job), held: new Map(),
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.#queue.push(job);
      this.#drain();
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dropWorker();
    const jobs = this.#active ? [this.#active, ...this.#queue] : this.#queue;
    this.#active = undefined;
    for (const job of jobs) {
      this.#cleanup(job);
      job.reject(abortedDecode());
    }
    this.#queue.length = 0;
    this.#contents.clear();
  }

  #drain(): void {
    if (this.#disposed || this.#active) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#active = job;
    // Decided at dispatch rather than at `decode()`: the job ahead of this one has just finished
    // and may be the very set this one duplicates.
    job.held = this.#heldContents(job.bones);
    const request: WvaAnimationDecodeRequest = {
      id: job.id, data: job.data, bones: job.bones, known: [...job.held.keys()],
    };
    try {
      const worker = this.#worker ?? this.createWorker();
      if (!worker) {
        this.#receive(decodeWvaAnimationRequest(request).response);
        return;
      }
      if (!this.#worker) {
        this.#worker = worker;
        worker.onmessage = (event) => {
          if (this.#worker === worker) this.#receive(event.data);
        };
        worker.onerror = (event) => {
          if (this.#worker === worker) this.#fail(new Error(event.message || "Animation worker failed"));
        };
        worker.onmessageerror = () => {
          if (this.#worker === worker) this.#fail(new Error("Animation worker response could not be read"));
        };
      }
      worker.postMessage(request, [job.data]);
    } catch (error) {
      this.#fail(error);
    }
  }

  /**
   * The message handler's whole cost: a few numbers checked, one small object per clip, no
   * channel touched (see `unpackWvaAnimations`).
   */
  #receive(response: WvaAnimationDecodeResponse): void {
    const job = this.#active;
    if (!job) return;
    if (!response || response.id !== job.id) {
      this.#fail(new Error("Animation worker returned an unexpected request"));
      return;
    }
    if ("error" in response && typeof response.error === "string") {
      this.#finish(undefined, new WvaAnimationPayloadError(response.error));
      return;
    }
    if ("duplicate" in response && typeof response.duplicate === "string") {
      const clips = job.held.get(response.duplicate);
      if (!clips) {
        this.#fail(new Error("Animation worker named a decoded set this request did not hold"));
        return;
      }
      this.#finish({ clips, cost: decodedAnimationResidencyCost(clips) });
      return;
    }
    if (!("packed" in response) || !validPacked(response.packed, job.bones)) {
      this.#fail(new Error("Animation worker returned an invalid result"));
      return;
    }
    const key = contentKey(job.bones, response.packed.digest);
    let clips = this.#contents.get(key)?.clips.deref();
    if (!clips) {
      clips = unpackWvaAnimations(response.packed);
      this.#contents.set(key, { bones: job.bones, digest: response.packed.digest, clips: new WeakRef(clips) });
    }
    this.#finish({ clips, cost: decodedAnimationResidencyCost(clips) });
  }

  /** Decoded sets still alive for this rig, by digest; forgets the ones that were collected. */
  #heldContents(bones: number): Map<string, WvmSkeletonClip[]> {
    const held = new Map<string, WvmSkeletonClip[]>();
    for (const [key, content] of this.#contents) {
      const clips = content.clips.deref();
      if (!clips) this.#contents.delete(key);
      else if (content.bones === bones) held.set(content.digest, clips);
    }
    return held;
  }

  #fail(error: unknown): void {
    this.#dropWorker();
    this.#finish(undefined, error);
  }

  #finish(result: WvaAnimationDecodeResult | undefined, error?: unknown): void {
    const job = this.#active;
    this.#active = undefined;
    if (job) {
      this.#cleanup(job);
      if (result) job.resolve(result);
      else job.reject(error);
    }
    this.#drain();
  }

  #cancel(job: DecodeJob): void {
    if (this.#active === job) {
      // Terminating active work also prevents an aborted decode from occupying the next world's
      // CPU. The queued input has not transferred and can safely use a new worker.
      this.#dropWorker();
      this.#finish(undefined, abortedDecode());
      return;
    }
    const index = this.#queue.indexOf(job);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#cleanup(job);
    job.reject(abortedDecode());
  }

  #cleanup(job: DecodeJob): void {
    job.signal?.removeEventListener("abort", job.abort);
    job.held.clear();
  }

  #dropWorker(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
}

/**
 * Own-worker data is trusted; avoid another walk of every channel on the browser thread. The
 * shape checks are constant-time, and a clip's ranges are read only when that clip is built.
 */
function validPacked(packed: WvaPackedAnimations | undefined, bones: number): packed is WvaPackedAnimations {
  return packed !== undefined && packed !== null
    && packed.clipTable instanceof Float64Array && packed.clipTable.length % WVA_CLIP_STRIDE === 0
    && packed.channelTable instanceof Uint32Array && packed.channelTable.length % WVA_CHANNEL_STRIDE === 0
    && packed.keys instanceof Float32Array
    && Number.isSafeInteger(packed.span) && packed.span >= 0 && packed.span <= bones
    && typeof packed.digest === "string" && packed.digest.length > 0
    && packed.cost !== undefined && packed.cost !== null
    && packed.cost.typedBackingBytes === packed.keys.byteLength
    && packed.keys.byteLength === packed.keys.buffer.byteLength
    && packed.cost.numericArrayElements === 0;
}

function contentKey(bones: number, digest: string): string {
  return `${bones}\u0000${digest}`;
}

function abortedDecode(): Error {
  const error = new Error("Animation decode was cancelled");
  error.name = "AbortError";
  return error;
}
