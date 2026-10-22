/**
 * 22.10 ARC-2 S6a: the frame codec over a real worker boundary — the same encoder, decoder and table senders the
 * loopback (RenderBridgeLoopback.ts) chains through `structuredClone`, split into the page's half (`RenderFrameSender`:
 * encode and post with the transfer list) and the worker's half (`RenderFrameReceiver`: apply every message in order,
 * keep the latest value arguments for the next draw).
 */

import type { EnvironmentObject } from "./Terrain.js";
import type { FrameArgs, RenderWorld } from "./FrameInput.js";
import { FrameInputEncoder, type FrameArgValues } from "./FrameInputEncoder.js";
import { FrameInputDecoder, type MirrorWorld } from "./FrameInputDecoder.js";
import type { RenderInputs } from "./RenderInputs.js";
import type { RenderLookups } from "./RenderLookups.js";
import { RenderInputsReceiver, RenderInputsSender, RenderLookupsReceiver, RenderLookupsSender } from "./RenderTablesBridge.js";
import { structuredSize } from "./StructuredSize.js";
import { toRenderTime } from "./RenderClock.js";
import { RenderInputSmoothing } from "./RenderInputSmoothing.js";
import { frameTransferList, type RenderWorkerCall, type RenderWorkerFrame } from "./RenderWorkerProtocol.js";

/** The page's `postMessage(message, transfer)` — a Worker, or a fake in tests. */
export interface RenderMessageTarget {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/** The environment list never crosses: the worker asks its own environment client (FrameArgs `environment`). */
const NO_ENVIRONMENT: readonly EnvironmentObject[] = Object.freeze([]);

export class RenderFrameSender {
  readonly #encoder = new FrameInputEncoder();
  readonly #inputs = new RenderInputsSender();
  readonly #lookups = new RenderLookupsSender();
  #postMs = 0;
  /** Off by default: the size walk is outside the clocks but not free. */
  measureBytes = false;

  /**
   * Encodes this frame's world, value arguments and pushed records (each optional record only when given; the
   * receiver keeps the last one) and posts them with the typed arrays transferred. Returns the message posted.
   */
  post<E extends object = Record<never, never>>(target: RenderMessageTarget, world: RenderWorld, args: FrameArgValues,
    lookups: RenderLookups | undefined, inputs: RenderInputs | undefined, call?: RenderWorkerCall,
    extra?: E, at?: number): RenderWorkerFrame & E { // 22.10 ARC-2 S6b: `extra`, the client's fields (RenderWorkerClientProtocol.ts)
    const encodeAt = performance.now();
    const input = this.#encoder.encode(world, args, NO_ENVIRONMENT);
    const lookupsMessage = lookups === undefined ? undefined : this.#lookups.encode(lookups);
    const inputsMessage = inputs === undefined ? undefined : this.#inputs.encode(inputs);
    const encodeMs = performance.now() - encodeAt;
    const frameBytes = this.measureBytes ? structuredSize(input) : 0;
    const bytes = this.measureBytes
      ? frameBytes + structuredSize(lookupsMessage ?? null) + structuredSize(inputsMessage ?? null) : 0;
    const message = {
      ...extra,
      type: "frame", input, lookups: lookupsMessage, inputs: inputsMessage,
      cost: { encodeMs, postMs: this.#postMs, bytes, frameBytes },
      at: at ?? encodeAt, // 22.10 ARC-2 S7: the world's moment
      ...(call === undefined ? {} : { call }),
    } as RenderWorkerFrame & E;
    const postAt = performance.now();
    target.postMessage(message, frameTransferList(input));
    this.#postMs = performance.now() - postAt;
    return message;
  }
}

/** What applying one or more frame messages cost on the worker, with the page's costs they carried. */
export interface RenderFrameApplied {
  messages: number;
  encodeMs: number;
  postMs: number;
  decodeMs: number;
  bytes: number;
  frameBytes: number;
}

export function emptyFrameApplied(): RenderFrameApplied {
  return { messages: 0, encodeMs: 0, postMs: 0, decodeMs: 0, bytes: 0, frameBytes: 0 };
}

export class RenderFrameReceiver {
  readonly #decoder = new FrameInputDecoder();
  /** 22.10 ARC-2 S7: the frames drawn without fresh input (`advance`), undone before each message and lockstep draw. */
  readonly smoothing = new RenderInputSmoothing();
  readonly #inputs = new RenderInputsReceiver();
  readonly #lookups = new RenderLookupsReceiver();
  #lookupsRecord: RenderLookups | undefined;
  #inputsRecord: RenderInputs | undefined;

  constructor() {
    this.#decoder.motionLog = this.smoothing; // 22.10 ARC-2 S7
  }

  /** The mirror world the renderer draws from. */
  get world(): MirrorWorld {
    return this.#decoder.world;
  }

  /** The latest frame's value arguments; undefined before the first message. */
  get args(): FrameArgs | undefined {
    return this.#decoder.args;
  }

  /** The pushed lookups (one record, refreshed in place), undefined until a message carried them. */
  get lookups(): RenderLookups | undefined {
    return this.#lookupsRecord;
  }

  get inputs(): RenderInputs | undefined {
    return this.#inputsRecord;
  }

  /**
   * 22.10 ARC-2 S7: the latest world to draw at `now` (render clock) on the worker's own frames — exact while the input
   * is fresh, advanced and extrapolated while the page is late (RenderInputSmoothing.ts). Returns the draw's arguments.
   */
  advance(now: number, periodMs?: number): FrameArgs | undefined {
    const args = this.#decoder.args;
    return args === undefined ? undefined : this.smoothing.advance(this.#decoder.world, args, now, periodMs);
  }

  /** 22.10 ARC-2 S7: the exact latest input, for a lockstep draw (a bench screenshot). */
  exact(): void {
    this.smoothing.exact();
  }

  /** Applies one message (they must all be applied, in order: each is a difference) and adds its costs. */
  apply(message: RenderWorkerFrame, applied: RenderFrameApplied): void {
    const at = performance.now();
    // 22.10 ARC-2 S7: the exact input back first: the message is a difference against it.
    const smoothing = this.smoothing;
    const decoder = this.#decoder;
    smoothing.beginInput(message.at === undefined ? undefined : toRenderTime(message.at), message.input.reset);
    decoder.apply(message.input);
    smoothing.endInput(decoder.world, decoder.args, message.input.reset);
    if (message.lookups !== undefined) this.#lookupsRecord = this.#lookups.apply(message.lookups);
    if (message.inputs !== undefined) this.#inputsRecord = this.#inputs.apply(message.inputs);
    applied.decodeMs += performance.now() - at;
    applied.messages++;
    applied.encodeMs += message.cost.encodeMs;
    applied.postMs += message.cost.postMs;
    applied.bytes += message.cost.bytes;
    applied.frameBytes += message.cost.frameBytes;
  }
}
