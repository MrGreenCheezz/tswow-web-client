/**
 * 22.10 ARC-2 S6a: the messages between the page and a world renderer in a DedicatedWorker, and what each one
 * transfers instead of copying.
 *
 * page → worker: `init` once (the OffscreenCanvas, the host values, the gateway origin and generation, the page's
 * time origin for RenderClock.ts, the driver's own data), `frame` per page frame (FrameInput.ts and the pushed records
 * of RenderTablesBridge.ts, each a difference against the previous message, so every one is applied in order),
 * `host` when the canvas or the display changed, `call` for the driver's commands.
 * worker → page: `ready` once, `results` after every drawn frame (RenderResults.ts with its queued reports — the page
 * applies them, RendererReports.ts — and the driver's per-frame row), `reply` per call, `error` for an uncaught one.
 *
 * Everything is structured-clonable; the frame's typed arrays are fresh per message (FrameInputEncoder `take`), so
 * they are transferred. The results record is the renderer's own and reused, so it is copied, and its report queues
 * are emptied once posted (`clearPostedReports`).
 */

import type { FrameInput } from "./FrameInput.js";
import type { GatewayGenerationPush } from "./GatewayGeneration.js";
import type { RenderInputsMessage, RenderLookupsMessage } from "./RenderTablesBridge.js";
import type { RenderResults } from "./RenderResults.js";

/** What the worker's RenderHost answers (WorkerRenderHost.ts): the page's reads, pushed. */
export interface RenderWorkerHostValues {
  readonly devicePixelRatio: number;
  /** The world canvas's CSS size, rounded as `clientWidth` rounds. */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** The page's `location.search` (`?poseworker=0` and the like). */
  readonly query: string;
}

export interface RenderWorkerInit<D = unknown> {
  readonly type: "init";
  readonly canvas: OffscreenCanvas;
  readonly host: RenderWorkerHostValues;
  /** The origin the renderer's clients fetch from (the page's gateway base). */
  readonly baseUrl: string;
  readonly gatewayGeneration: GatewayGenerationPush;
  /** The page's `performance.timeOrigin`: the worker sets the RenderClock offset from it. */
  readonly mainTimeOrigin: number;
  readonly driver: D;
}

/** What the page spent on one frame message, for the bridge columns (the post's own time rides the next message). */
export interface RenderFrameCost {
  readonly encodeMs: number;
  /** The `postMessage` time of the previous frame message. */
  readonly postMs: number;
  /** Estimated wire bytes (StructuredSize.ts) of the whole message and of its world part. */
  readonly bytes: number;
  readonly frameBytes: number;
}

export interface RenderWorkerFrame {
  readonly type: "frame";
  readonly input: FrameInput;
  readonly lookups: RenderLookupsMessage | undefined;
  readonly inputs: RenderInputsMessage | undefined;
  readonly cost: RenderFrameCost;
  /** A frame drawn as soon as it arrives (not on the worker's next animation frame) and answered by this call. */
  readonly call?: RenderWorkerCall;
}

export interface RenderWorkerHostUpdate {
  readonly type: "host";
  readonly host: RenderWorkerHostValues;
}

export interface RenderWorkerCall {
  readonly type: "call";
  readonly id: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

export type PageToRenderWorker = RenderWorkerInit | RenderWorkerFrame | RenderWorkerHostUpdate | RenderWorkerCall;

export interface RenderWorkerReady {
  readonly type: "ready";
  /** Whether the worker realm is cross-origin isolated (the pose engine's SharedArrayBuffer needs it). */
  readonly crossOriginIsolated: boolean;
}

export interface RenderWorkerResults {
  readonly type: "results";
  readonly results: RenderResults;
  /** The driver's per-frame record (the bench's measured row), transferred. */
  readonly row: Float64Array | undefined;
}

export interface RenderWorkerReply {
  readonly type: "reply";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: string;
}

export interface RenderWorkerError {
  readonly type: "error";
  readonly message: string;
}

export type RenderWorkerToPage = RenderWorkerReady | RenderWorkerResults | RenderWorkerReply | RenderWorkerError;

/** The buffers a frame message can give away: the per-frame typed arrays of its FrameInput. */
export function frameTransferList(input: FrameInput): ArrayBuffer[] {
  const list: ArrayBuffer[] = [];
  for (const array of [input.removed, input.motion, input.fields, input.order]) {
    if (array === undefined) continue;
    const buffer = array.buffer as ArrayBuffer;
    if (buffer.byteLength > 0 && !list.includes(buffer)) list.push(buffer);
  }
  return list;
}

/** After `results` was posted: the queues the page now owns are emptied here, so each report is applied once. */
export function clearPostedReports(results: RenderResults): void {
  results.portraits.length = 0;
  results.gpuEvents.length = 0;
  results.patchChainSuspects.length = 0;
  results.budgetMs.fill(0);
  results.budgetPending = false;
}
