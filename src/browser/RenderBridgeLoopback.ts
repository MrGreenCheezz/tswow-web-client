/**
 * 22.10 ARC-2 S5: `?renderbridge=loopback` — the renderer fed exactly as a DedicatedWorker renderer will be, on the
 * same thread. Each frame the world is encoded (FrameInputEncoder.ts), passed through `structuredClone` as `postMessage`
 * would copy it, and decoded into a mirror (FrameInputDecoder.ts) that `draw` reads instead of the live `WorldState`;
 * the pushed records (RenderTablesBridge.ts) and the portrait targets go the same way. What the measurement is for:
 * the per-frame cost of that crossing (encode, clone, decode, bytes), and pixels equal to the direct path.
 *
 * Not crossed here, because a worker renderer will own them itself: the terrain, environment, splat, liquid,
 * transport-path and horizon clients and the height sampler (passed through by reference), and the environment list,
 * which crosses as a number and the query that made it (`FrameArgs.environment`) — the loopback hands the renderer the
 * very array, as a worker's own `objectsAround` would hand it the same placements.
 */

import type { WorldRenderer3D } from "./WorldRenderer3D.js";
import type { RenderInputs } from "./RenderInputs.js";
import type { RenderLookups } from "./RenderLookups.js";
import type { PortraitTargetInputs } from "./PortraitTargetData.js";
import { FrameInputEncoder } from "./FrameInputEncoder.js";
import { FrameInputDecoder } from "./FrameInputDecoder.js";
import { RenderInputsReceiver, RenderInputsSender, RenderLookupsReceiver, RenderLookupsSender } from "./RenderTablesBridge.js";
import { structuredSize } from "./StructuredSize.js";
import type { RenderWorld } from "./FrameInput.js";

export type RenderBridgeMode = "direct" | "loopback";

/** The page's (or the bench's) `renderbridge` flag; anything but `loopback` is the direct path. */
export function renderBridgeMode(flags: URLSearchParams): RenderBridgeMode {
  return flags.get("renderbridge") === "loopback" ? "loopback" : "direct";
}

/** What one frame's crossing cost, summed over every message of the frame. */
export interface RenderBridgeFrameStats {
  encodeMs: number;
  cloneMs: number;
  decodeMs: number;
  /** Estimated wire bytes (StructuredSize.ts); typed arrays exactly. */
  bytes: number;
  /** The world message's share of `bytes`. */
  frameBytes: number;
}

/** The renderer surface the bridge drives (a fake one in tests). */
export type BridgedRenderer = Pick<WorldRenderer3D, "draw" | "setRenderInputs" | "setRenderLookups" | "setPortraitTargets">;

type DrawArguments = Parameters<WorldRenderer3D["draw"]>;

export class RenderBridgeLoopback {
  readonly #encoder = new FrameInputEncoder();
  readonly #decoder = new FrameInputDecoder();
  readonly #inputsSender = new RenderInputsSender();
  readonly #inputsReceiver = new RenderInputsReceiver();
  readonly #lookupsSender = new RenderLookupsSender();
  readonly #lookupsReceiver = new RenderLookupsReceiver();
  #stats: RenderBridgeFrameStats = { encodeMs: 0, cloneMs: 0, decodeMs: 0, bytes: 0, frameBytes: 0 };
  #portraitTarget: { renderer: BridgedRenderer; target: Pick<WorldRenderer3D, "setPortraitTargets"> } | undefined;

  /** The mirror the renderer drew from last (tests and diagnostics). */
  get mirror(): RenderWorld {
    return this.#decoder.world;
  }

  /** This frame's costs so far, and a fresh account for the next. */
  takeFrameStats(): RenderBridgeFrameStats {
    const stats = this.#stats;
    this.#stats = { encodeMs: 0, cloneMs: 0, decodeMs: 0, bytes: 0, frameBytes: 0 };
    return stats;
  }

  setRenderInputs(renderer: BridgedRenderer, inputs: RenderInputs | undefined): void {
    if (inputs === undefined) {
      renderer.setRenderInputs(undefined);
      return;
    }
    renderer.setRenderInputs(this.#cross(() => this.#inputsSender.encode(inputs),
      (message) => this.#inputsReceiver.apply(message)));
  }

  setRenderLookups(renderer: BridgedRenderer, lookups: RenderLookups | undefined): void {
    if (lookups === undefined) {
      renderer.setRenderLookups(undefined);
      return;
    }
    renderer.setRenderLookups(this.#cross(() => this.#lookupsSender.encode(lookups),
      (message) => this.#lookupsReceiver.apply(message)));
  }

  /** What `ui/Portraits.ts` `syncPortraitTargets` pushes to: the targets cross whole, every frame (a few records). */
  portraitTarget(renderer: BridgedRenderer): Pick<WorldRenderer3D, "setPortraitTargets"> {
    if (this.#portraitTarget?.renderer !== renderer) {
      this.#portraitTarget = {
        renderer,
        target: {
          setPortraitTargets: (inputs: PortraitTargetInputs) => renderer.setPortraitTargets(
            this.#cross(() => inputs, (message) => message)),
        },
      };
    }
    return this.#portraitTarget.target;
  }

  /** `renderer.draw(...)` with the world, the value arguments and the environment list crossed first. */
  draw(renderer: BridgedRenderer, ...args: DrawArguments): ReturnType<WorldRenderer3D["draw"]> {
    const [state, map, heightAt, terrainClient, objects, environmentClient, cameraYaw, cameraPitch, cameraDistance,
      splatClient, liquidTextures, transportPaths, horizonClient, cameraAnchorDistance, cameraPivotHeight, wmoFloor,
      frameTime] = args;
    const encoder = this.#encoder;
    const bytesBefore = this.#stats.bytes;
    const mirror = this.#cross(() => encoder.encode(state, {
      map, cameraYaw, cameraPitch, cameraDistance, cameraAnchorDistance, cameraPivotHeight, wmoFloor, frameTime,
    }, objects), (input) => this.#decoder.apply(input));
    this.#stats.frameBytes += this.#stats.bytes - bytesBefore;
    const decoded = this.#decoder.args!;
    return renderer.draw(mirror, decoded.map, heightAt, terrainClient, encoder.environmentList, environmentClient,
      decoded.cameraYaw, decoded.cameraPitch, decoded.cameraDistance, splatClient, liquidTextures, transportPaths,
      horizonClient, decoded.cameraAnchorDistance, decoded.cameraPivotHeight, decoded.wmoFloor, decoded.frameTime);
  }

  /** Encode, clone as a post would, decode — each timed, and the message's size estimated outside the clocks. */
  #cross<M, R>(encode: () => M, decode: (message: M) => R): R {
    const stats = this.#stats;
    const encodeAt = performance.now();
    const message = encode();
    const cloneAt = performance.now();
    const copy = structuredClone(message);
    const decodeAt = performance.now();
    const result = decode(copy);
    const doneAt = performance.now();
    stats.encodeMs += cloneAt - encodeAt;
    stats.cloneMs += decodeAt - cloneAt;
    stats.decodeMs += doneAt - decodeAt;
    stats.bytes += structuredSize(message);
    return result;
  }
}
