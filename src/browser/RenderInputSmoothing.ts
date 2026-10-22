/**
 * 22.10 ARC-2 S7: what the render worker draws when the page's input is late (a main thread stalled by FrameXML, a GC,
 * a packet burst). With fresh input — newer than one display period — it draws that input exactly. Older, it draws the
 * world one display period behind its own clock (the latency a fresh input has at most), so a stall continues the
 * motion instead of freezing it:
 *
 * * splines and passengers advance as the page would advance them (MirrorMotion.ts) — exact, however long the stall;
 * * everything else that moved between the last two inputs (the player's physics, ships, remote players' drifts,
 *   a bench crowd) and the camera's yaw, pitch and distance go on linearly from those two inputs' values and stamps,
 *   at most `EXTRAPOLATION_CAP_MS` past the newest input, then hold. A step over `EXTRAPOLATION_JUMP_YARDS` (or
 *   faster than 60 yd/s) between inputs — a teleport, a blink — drops that object's velocity, and the camera's too when
 *   it is the player's; a map or player change, or a reset world, stops it all until the next pair.
 *
 * Each draw starts from the exact input (MirrorRestore.ts), and the exact input is put back before the next message
 * is applied — the messages are differences against what the page sent — and for lockstep draws (`exact`).
 */

import type { WorldObjectState } from "../world/WorldState.js";
import type { FrameArgs, RenderWorld } from "./FrameInput.js";
import { MirrorRestore } from "./MirrorRestore.js";
import { advanceMirrorMotions, type CarrierPose } from "./MirrorMotion.js";

/** What a worker frame drew (bench column `inputState`). */
export const INPUT_FRESH = 0;
/** Late input; splines and passengers advanced, nothing to extrapolate. */
export const INPUT_INTERPOLATED = 1;
/** Late input; extrapolated as well, within the cap. */
export const INPUT_EXTRAPOLATED = 2;
/** Late input past the cap: the extrapolation holds (splines still advance). */
export const INPUT_HELD = 3;
export const EXTRAPOLATION_CAP_MS = 50;
export const EXTRAPOLATION_JUMP_YARDS = 10;
/** Two inputs closer than this give no velocity (a burst of messages after a stall). */
const MIN_INPUT_GAP_MS = 2;
/** Faster than any mount flies (60 yd/s): a blink, a charge, a correction — a jump, not a velocity. */
const MAX_SPEED_YARDS_PER_MS = 0.06;
const DEFAULT_PERIOD_MS = 1000 / 60;

/** The decoder's hook (FrameInputDecoder `motionLog`): a motion row is about to move an object that had a position. */
export interface MotionLog {
  noteMove(object: WorldObjectState, fromX: number, fromY: number, fromZ: number, fromOrientation: number,
    x: number, y: number, z: number, orientation: number): void;
}

interface Velocity {
  object: WorldObjectState;
  x: number;
  y: number;
  z: number;
  orientation: number;
}

/** Signed shortest turn from one angle to another. */
function turn(from: number, to: number): number {
  const delta = (to - from) % (Math.PI * 2);
  return delta > Math.PI ? delta - Math.PI * 2 : delta < -Math.PI ? delta + Math.PI * 2 : delta;
}

export class RenderInputSmoothing implements MotionLog {
  readonly restore = new MirrorRestore();
  /** Lifts' cars for the passengers (the worker's transport paths); ships move by velocity. */
  carrierPose: CarrierPose | undefined;
  /** The newest input's stamp and the one before, on this clock; NaN when unknown. */
  #stamp = Number.NaN;
  #gap = Number.NaN;
  readonly #velocities: Velocity[] = [];
  #velocityCount = 0;
  #map: number | undefined;
  #selfGuid: bigint | undefined;
  #selfJumped = false;
  #yaw: number | undefined;
  #pitch: number | undefined;
  #distance: number | undefined;
  #yawRate = 0;
  #pitchRate = 0;
  #distanceRate = 0;
  #cameraLive = false;
  #period = DEFAULT_PERIOD_MS;
  #lastNow = Number.NaN;
  #drawArgs: { -readonly [K in keyof FrameArgs]: FrameArgs[K] } | undefined;
  /** The last `advance`: how old its input was (ms; NaN without a stamp) and what it drew (`INPUT_*`). */
  lastAgeMs = Number.NaN;
  lastState = INPUT_FRESH;

  /** The display period `advance` estimates from its frames. */
  get periodMs(): number {
    return this.#period;
  }

  /** Before a frame message is applied: the exact input back, then this message's stamp (render clock). */
  beginInput(stamp: number | undefined, reset: boolean): void {
    this.restore.restore();
    const previous = this.#stamp;
    this.#stamp = stamp ?? Number.NaN;
    const gap = this.#stamp - previous;
    this.#gap = !reset && gap >= MIN_INPUT_GAP_MS ? gap : Number.NaN;
    // Only this message's rows say who moved since the previous one.
    const velocities = this.#velocities;
    for (let index = 0; index < this.#velocityCount; index++) velocities[index]!.object = undefined as unknown as WorldObjectState;
    this.#velocityCount = 0;
    this.#selfJumped = false;
  }

  noteMove(object: WorldObjectState, fromX: number, fromY: number, fromZ: number, fromOrientation: number,
    x: number, y: number, z: number, orientation: number): void {
    const gap = this.#gap;
    if (gap !== gap) return;
    const dx = x - fromX, dy = y - fromY, dz = z - fromZ;
    const squared = dx * dx + dy * dy + dz * dz;
    if (squared > EXTRAPOLATION_JUMP_YARDS * EXTRAPOLATION_JUMP_YARDS || squared > (MAX_SPEED_YARDS_PER_MS * gap) ** 2) {
      if (object.guid === this.#selfGuid) this.#selfJumped = true;
      return;
    }
    const velocity = this.#velocities[this.#velocityCount] ??= { object, x: 0, y: 0, z: 0, orientation: 0 };
    this.#velocityCount++;
    velocity.object = object;
    velocity.x = dx / gap;
    velocity.y = dy / gap;
    velocity.z = dz / gap;
    velocity.orientation = turn(fromOrientation, orientation) / gap;
  }

  /** After a frame message was applied: the camera's rates, and a reset on a new map, player or jump. */
  endInput(world: RenderWorld, args: FrameArgs | undefined, reset: boolean): void {
    const map = args?.map;
    const self = world.selfGuid;
    const broken = reset || map !== this.#map || self !== this.#selfGuid || this.#selfJumped;
    this.#map = map;
    this.#selfGuid = self;
    if (broken) {
      for (let index = 0; index < this.#velocityCount; index++) this.#velocities[index]!.object = undefined as unknown as WorldObjectState;
      this.#velocityCount = 0;
    }
    const gap = this.#gap;
    const yaw = args?.cameraYaw, pitch = args?.cameraPitch, distance = args?.cameraDistance;
    const live = !broken && gap === gap && yaw !== undefined && pitch !== undefined && distance !== undefined
      && this.#yaw !== undefined && this.#pitch !== undefined && this.#distance !== undefined;
    this.#yawRate = live ? turn(this.#yaw!, yaw) / gap : 0;
    this.#pitchRate = live ? (pitch - this.#pitch!) / gap : 0;
    this.#distanceRate = live ? (distance - this.#distance!) / gap : 0;
    this.#cameraLive = live && (this.#yawRate !== 0 || this.#pitchRate !== 0 || this.#distanceRate !== 0);
    this.#yaw = yaw;
    this.#pitch = pitch;
    this.#distance = distance;
  }

  /** The exact input, for a lockstep draw. */
  exact(): void {
    this.restore.restore();
  }

  /**
   * The world to draw at `now` (render clock): the exact input while it is fresh, else advanced as the file's head
   * says. Returns the arguments to draw with — `args` itself unless the camera was extrapolated.
   */
  advance(world: RenderWorld, args: FrameArgs, now: number, periodMs?: number): FrameArgs {
    this.restore.restore();
    const last = this.#lastNow;
    this.#lastNow = now;
    if (periodMs !== undefined) this.#period = periodMs;
    else {
      // A smoothed display period from the frame intervals; hitches are not periods.
      const interval = now - last;
      if (interval >= 2 && interval <= 50) this.#period += (interval - this.#period) * 0.1;
    }
    const stamp = this.#stamp;
    const age = now - stamp;
    this.lastAgeMs = age;
    if (!(age > this.#period)) {
      this.lastState = INPUT_FRESH;
      return args;
    }
    const target = now - this.#period;
    const past = target - stamp;
    const ahead = Math.min(past, EXTRAPOLATION_CAP_MS);
    const restore = this.restore;
    let extrapolated = false;
    // Carriers before anyone is carried: the linear part first, as the page's ship poses come before its passengers.
    for (let index = 0; index < this.#velocityCount; index++) {
      const velocity = this.#velocities[index]!;
      const object = velocity.object;
      const position = object.position;
      if (position === undefined || object.motion !== undefined || object.transport !== undefined
        || world.objects.get(object.guid) !== object) continue;
      restore.touch(object);
      position.x += velocity.x * ahead;
      position.y += velocity.y * ahead;
      position.z += velocity.z * ahead;
      position.orientation += velocity.orientation * ahead;
      extrapolated = true;
    }
    advanceMirrorMotions(world, target, this.carrierPose, restore);
    let drawArgs: FrameArgs = args;
    if (this.#cameraLive) {
      const out = this.#drawArgs ??= { ...args };
      Object.assign(out, args);
      out.cameraYaw = args.cameraYaw! + this.#yawRate * ahead;
      out.cameraPitch = args.cameraPitch! + this.#pitchRate * ahead;
      out.cameraDistance = args.cameraDistance! + this.#distanceRate * ahead;
      drawArgs = out;
      extrapolated = true;
    }
    this.lastState = !extrapolated ? INPUT_INTERPOLATED : past > EXTRAPOLATION_CAP_MS ? INPUT_HELD : INPUT_EXTRAPOLATED;
    return drawArgs;
  }
}

/** What the bench reports of its worker frames (WorkerBenchPage.ts `renderWorker.inputSmoothing`). */
export interface InputStateSummary {
  readonly fresh: number;
  readonly interpolated: number;
  readonly extrapolated: number;
  readonly held: number;
  readonly inputAgeMs: { readonly p50: number | null; readonly p99: number | null; readonly max: number | null };
}

/** The measured frames by what they drew (column `inputState`) and how old their input was (`inputAgeMs`). */
export function summarizeInputStates(frames: readonly (readonly number[])[], columns: readonly string[]): InputStateSummary {
  const ageAt = columns.indexOf("inputAgeMs");
  const stateAt = columns.indexOf("inputState");
  const counts = [0, 0, 0, 0];
  const ages: number[] = [];
  for (const row of frames) {
    const state = row[stateAt]!;
    if (state >= 0 && state < counts.length) counts[state]!++;
    const age = row[ageAt]!;
    if (Number.isFinite(age)) ages.push(age);
  }
  ages.sort((a, b) => a - b);
  const quantile = (q: number) => ages.length === 0 ? null : ages[Math.min(ages.length - 1, Math.floor(q * ages.length))]!;
  return { fresh: counts[INPUT_FRESH]!, interpolated: counts[INPUT_INTERPOLATED]!, extrapolated: counts[INPUT_EXTRAPOLATED]!,
    held: counts[INPUT_HELD]!, inputAgeMs: { p50: quantile(0.5), p99: quantile(0.99), max: quantile(1) } };
}
