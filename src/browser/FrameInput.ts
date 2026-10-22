/**
 * 22.10 ARC-2 S5: one frame of the world as the renderer reads it, as structured-clonable data — what the main thread
 * will post to the renderer's DedicatedWorker each frame (FrameInputEncoder.ts builds it, FrameInputDecoder.ts applies
 * it to a mirror state the renderer draws from).
 *
 * Everything is a difference against the previous frame's message: a world that did not move encodes to empty arrays.
 * Objects are named by a slot the encoder gives each object *incarnation* (a CREATE over a live guid is a new object
 * on the main thread, so it is a new slot and a new mirror object here), and the per-frame numbers ride typed arrays
 * that a worker transport can transfer instead of copying.
 *
 * The renderer reads, of `WorldState`, only `objects`, `selfGuid` and `predictedGuid` (`RenderWorld`), and of each
 * object: guid, typeId, position, movementFlags, fields, transport, motion (presence, flying, duration, totalLength,
 * startedAt, track), splineTier, speeds, runSpeed, fallJumped, rotation, vehicleId, transportTime/At — every one of
 * them is carried. Also carried, unread today: updateFlags, targetGuid, turnRate, pitch, vehicleOrientation,
 * positionTransport. Not carried: `drift` and `glide`, the main thread's own movement integrators, whose result is the
 * position.
 */

import type { WorldObjectState } from "../world/WorldState.js";
import type { StaticWmoFloor } from "./game/CollisionSource.js";
import type { RenderFrameTime } from "./WorldRenderer3D.js";

/** What the renderer reads of a world state: the type `draw` takes since S5. */
export interface RenderWorld {
  readonly objects: ReadonlyMap<bigint, WorldObjectState>;
  readonly selfGuid: bigint | undefined;
  readonly predictedGuid: bigint | undefined;
}

/** `motion` rows: slot, position generation (0: no position), x, y, z, orientation, movementFlags. */
export const MOTION_STRIDE = 7;
export const MOTION_SLOT = 0;
export const MOTION_GENERATION = 1;
export const MOTION_X = 2;
export const MOTION_Y = 3;
export const MOTION_Z = 4;
export const MOTION_ORIENTATION = 5;
export const MOTION_FLAGS = 6;

/** In a `fields` record, a delete count of this means "the Map was replaced: clear it before the sets". */
export const FIELDS_REPLACED = -1;

/** An object incarnation the renderer has not seen. Its data follows in the same message. */
export interface AddedObject {
  readonly slot: number;
  readonly guid: bigint;
  /** The slot this object replaced under the same guid (a CREATE over a live guid), else -1. */
  readonly replaces: number;
}

/** The scalars that change rarely; sent whole when any of them changed. */
export interface ObjectScalars {
  readonly typeId: number | undefined;
  readonly runSpeed: number | undefined;
  readonly turnRate: number | undefined;
  readonly updateFlags: number;
  readonly targetGuid: bigint | undefined;
  readonly pitch: number | undefined;
  readonly fallJumped: boolean | undefined;
  readonly vehicleId: number | undefined;
  readonly vehicleOrientation: number | undefined;
  readonly transportTime: number | undefined;
  readonly transportTimeAt: number | undefined;
}

/** A transport seat's values; `fresh` when the main object holds a different seat object than last frame. */
export interface SeatChange {
  readonly fresh: boolean;
  readonly guid: bigint;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly orientation: number;
  readonly seat: number;
}

/**
 * The spline and its animation latch, sent together whenever either moved, so the latch can be linked to the
 * mirror's own track (`splineAnimationTier` compares `latch.track === motion.track` by identity).
 */
export interface SplineChange {
  /**
   * Present when the spline or its track is another object: the main thread's `SplineMotion` itself, which the post
   * (or the loopback's clone) copies. Absent when only the latch moved, so the mirror's spline keeps its identity.
   */
  readonly motion?: WorldObjectState["motion"];
  readonly latch: { readonly tier: number | undefined; readonly fieldTier: number | undefined; readonly linked: boolean }
    | undefined;
}

export interface RatesChange {
  readonly fresh: boolean;
  readonly entries: ReadonlyArray<readonly [string, number]>;
}

export interface QuatChange {
  readonly fresh: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** The rarely moving parts of one object: a key present means "changed", its value `undefined` means "none". */
export interface ObjectChange {
  readonly slot: number;
  scalars?: ObjectScalars;
  transport?: SeatChange | undefined;
  spline?: SplineChange;
  speeds?: RatesChange | undefined;
  rotation?: QuatChange | undefined;
  positionTransport?: WorldObjectState["positionTransport"];
}

/** `draw`'s other arguments that are values. The clients (terrain, environment, splat…) stay on the renderer's side. */
export interface FrameArgs {
  readonly map: number | undefined;
  readonly cameraYaw: number | undefined;
  readonly cameraPitch: number | undefined;
  readonly cameraDistance: number | undefined;
  readonly cameraAnchorDistance: number | undefined;
  readonly cameraPivotHeight: number | undefined;
  readonly wmoFloor: StaticWmoFloor | undefined;
  readonly frameTime: RenderFrameTime | undefined;
  /**
   * The environment placement list by identity: a new number whenever `objectsAround` answered with a different
   * array (it returns the same array while the footprint and the tiles stand). 0: the empty list. A worker renderer
   * answers it with its own environment client's `objectsAround` (game/Loop.ts asks with the subject's x and y).
   */
  readonly environment: number;
}

export interface FrameInput {
  /** The encoder's frame counter (1, 2, …). */
  readonly frame: number;
  /** A new world (or the first frame): drop every mirror object before applying the rest. */
  readonly reset: boolean;
  readonly selfGuid: bigint | undefined;
  readonly predictedGuid: bigint | undefined;
  readonly added: readonly AddedObject[];
  /** Slots gone this frame, replaced ones included. */
  readonly removed: Int32Array;
  /** The whole slot order of `objects` when it is not "the previous order without `removed`, then `added`". */
  readonly order: Int32Array | undefined;
  /** `MOTION_STRIDE` numbers per object whose position or movement flags moved. */
  readonly motion: Float64Array;
  /** Per object whose fields were written: slot, set count, delete count (or FIELDS_REPLACED), key/value pairs, keys. */
  readonly fields: Float64Array;
  readonly changes: readonly ObjectChange[];
  readonly args: FrameArgs;
}

/** Whether two numbers are the same value: NaN equals NaN, 0 differs from -0 (`Object.is` without the call). */
export function sameNumber(a: number, b: number): boolean {
  return a === b ? a !== 0 || 1 / a === 1 / b : a !== a && b !== b;
}
