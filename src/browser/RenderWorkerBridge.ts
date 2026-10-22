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
  post(target: RenderMessageTarget, world: RenderWorld, args: FrameArgValues, lookups: RenderLookups | undefined,
    inputs: RenderInputs | undefined, call?: RenderWorkerCall): RenderWorkerFrame {
    const encodeAt = performance.now();
    const input = this.#encoder.encode(world, args, NO_ENVIRONMENT);
    const lookupsMessage = lookups === undefined ? undefined : this.#lookups.encode(lookups);
    const inputsMessage = inputs === undefined ? undefined : this.#inputs.encode(inputs);
    const encodeMs = performance.now() - encodeAt;
    const frameBytes = this.measureBytes ? structuredSize(input) : 0;
    const bytes = this.measureBytes
      ? frameBytes + structuredSize(lookupsMessage ?? null) + structuredSize(inputsMessage ?? null) : 0;
    const message: RenderWorkerFrame = {
      type: "frame", input, lookups: lookupsMessage, inputs: inputsMessage,
      cost: { encodeMs, postMs: this.#postMs, bytes, frameBytes },
      ...(call === undefined ? {} : { call }),
    };
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
  readonly #inputs = new RenderInputsReceiver();
  readonly #lookups = new RenderLookupsReceiver();
  #lookupsRecord: RenderLookups | undefined;
  #inputsRecord: RenderInputs | undefined;

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

  /** Applies one message (they must all be applied, in order: each is a difference) and adds its costs. */
  apply(message: RenderWorkerFrame, applied: RenderFrameApplied): void {
    const at = performance.now();
    this.#decoder.apply(message.input);
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
