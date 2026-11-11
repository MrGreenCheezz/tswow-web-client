import { cameraTerrainTiltCVar } from "./CameraCVars.js";

/**
 * 5.14 (11.11): the stock «Следование рельефу» — `cameraTerrainTilt` (default "0", 0x005fd910) — as Wow.exe 3.3.5a
 * (12340) does it. Read-only notes: .runtime/re-2026-11-11/camera/ (c1.c, c1.data.txt, refs1.txt) with 0x00603a10 and
 * 0x00601b70 in .runtime/re-2026-10-04/l8-movement/g1.c, 0x00604490 in .runtime/re-2026-10-03/l1102gf3/r2.c.
 *
 * Every camera frame (0x00603d30 ends with both calls):
 * - 0x00603a10 measures the ground ahead, at most every 100 ms: from the subject's feet raised 1.6667 yards (0x00a0b634)
 *   a line 3.3333 yards (0x00a3ea48) along its facing (mask 0x151); from where it stops, 0.2778 (0x00a1ea1c) back, a
 *   plumb line 7.1111 yards (0x00a1ea18) down. The slope is the ground there over the feet, divided by the level run
 *   to that point. Its size picks an angle from the table at 0x00a1e9c8 — 0, 0.09, 0.18, 0.27, 0.36, 0.47, 0.58, 0.70,
 *   0.84, 1.0 to 0°…45° by 5°, the last row whose slope is reached — downhill looking down, uphill up, held to ±20°
 *   (0x00a1e318/0x00a1e31c). Off, or with no unit to watch, the measure is 0 at once.
 * - 0x00601b70 picks the row `cameraTerrainTilt<cameraSmoothStyle><state>` by the subject: on a taxi Taxi, swimming or
 *   flying Swim, falling Fall, the camera tracking Track, on a server spline Fear, then forward/back Move, a strafe
 *   Strafe, a turn Turn, else Idle (Jump comes after Fall in the same test and is not reached). Absorb × the measure is
 *   the target; a negative Factor keeps the tilt where it is; a Factor of 0 sets it; any other glides it there (0x00600fa0)
 *   at cameraGroundSmoothSpeed (7.5°/s, 0x00a1e73c) × Factor, the time held to Factor × cameraTerrainTiltTimeMin…Max
 *   (3–10 s), after Delay, on the camera's half cosine; a glide already heading for the same numbers runs on.
 * - The tilt (camera+0x134) is added to the drawn pitch (0x00604490), which is held to ±1.5533 (0x00ad1b4c); the follow
 *   and the views keep working on the pitch without it.
 *
 * Kept to this client: the 0x151 line is the collision world's segment and the plumb line the higher of its floor and
 * the heightfield; the subject's tracking is never set (click-to-move is not supported here).
 */

/** 0x00a0b634, 0x00a3ea48, 0x00a1ea1c, 0x00a1ea18: the probe's rise, reach, step back and drop, yards. */
export const TERRAIN_TILT_RISE = 1.6666666269302368;
export const TERRAIN_TILT_REACH = 3.3333332538604736;
export const TERRAIN_TILT_STEP_BACK = 0.2777777910232544;
export const TERRAIN_TILT_DROP = 7.111111164093018;
/** 0x00603a10: a new measure at most every 100 ms. */
export const TERRAIN_TILT_SAMPLE_MS = 100;
/** 0x00a1e318: the tilt is held to ±20°, radians. */
export const TERRAIN_TILT_LIMIT = 0.3490658402442932;
/** cameraGroundSmoothSpeed's default "7.5" (0x00a1e73c), degrees a second. */
export const TERRAIN_TILT_SPEED_DEGREES = 7.5;
/** 0x00a1e9c8: ten rows of the slope reached and its angle (radians, 0°…45° by 5°). */
const SLOPES = [0, 0.09, 0.18, 0.27, 0.36, 0.47, 0.58, 0.7, 0.84, 1] as const;
const ANGLES = [0, 0.08726646, 0.17453292, 0.2617994, 0.34906584, 0.43633232, 0.5235988, 0.61086524, 0.6981317,
  0.7853982] as const;
/** 0x00ad1b4c: the drawn pitch's bound. */
export const CAMERA_DRAWN_PITCH_LIMIT = 1.5533430576324463;
const SAME = 1e-3;
const DEG = Math.PI / 180;

/** The states' rows (CameraCVars.CAMERA_TERRAIN_TILT_STATES). */
export const TERRAIN_TILT_FALL = 0;
export const TERRAIN_TILT_FEAR = 1;
export const TERRAIN_TILT_IDLE = 2;
export const TERRAIN_TILT_MOVE = 4;
export const TERRAIN_TILT_STRAFE = 5;
export const TERRAIN_TILT_SWIM = 6;
export const TERRAIN_TILT_TAXI = 7;
export const TERRAIN_TILT_TRACK = 8;
export const TERRAIN_TILT_TURN = 9;

/**
 * The angle a slope (ground rise over level run) asks for, Wow.exe's sign (positive looks down): 0x00603a10's table.
 * A slope that is not a number asks for none, as no row is reached.
 */
export function terrainTiltAngle(slope: number): number {
  const sign = slope < 0 ? 1 : -1;
  const size = slope < 0 ? -slope : slope;
  for (let row = SLOPES.length - 1; row >= 0; row -= 1) {
    if (!(SLOPES[row]! <= size)) continue;
    const angle = ANGLES[row]!;
    if (angle <= 0) return 0;
    const tilt = sign * angle;
    if (tilt < -TERRAIN_TILT_LIMIT) return -TERRAIN_TILT_LIMIT;
    return tilt < TERRAIN_TILT_LIMIT ? tilt : TERRAIN_TILT_LIMIT;
  }
  return 0;
}

/** What the probe asks of the world. */
export interface TerrainTiltWorld {
  /** Where along the segment the first solid triangle is (0–1), or undefined. */
  readonly firstHit?: ((from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => number | undefined) | undefined;
  /** The highest floor at (x, y) between `fromZ` and `toZ` (below it), or undefined. */
  readonly floorUnder?: ((x: number, y: number, fromZ: number, toZ: number) => number | undefined) | undefined;
  /** The heightfield at (x, y), or undefined. */
  readonly heightAt?: ((x: number, y: number) => number | undefined) | undefined;
}

/** 0x00603a10's measure for a subject with its feet at (x, y, z) facing `facing`: radians, positive looks down. */
export function sampleTerrainTilt(world: TerrainTiltWorld, x: number, y: number, z: number, facing: number): number {
  const cos = Math.cos(facing);
  const sin = Math.sin(facing);
  const fromZ = z + TERRAIN_TILT_RISE;
  const from = { x, y, z: fromZ };
  const to = { x: x + cos * TERRAIN_TILT_REACH, y: y + sin * TERRAIN_TILT_REACH, z: fromZ };
  const t = world.firstHit?.(from, to);
  const reach = t !== undefined && t >= 0 && t <= 1 ? t * TERRAIN_TILT_REACH : TERRAIN_TILT_REACH;
  const run = reach - TERRAIN_TILT_STEP_BACK;
  const px = x + cos * run;
  const py = y + sin * run;
  const lowest = fromZ - TERRAIN_TILT_DROP;
  // The plumb line stops at the first thing under it: the higher of the solid floor and the heightfield in the drop.
  let ground = lowest;
  const floor = world.floorUnder?.(px, py, fromZ, lowest);
  if (floor !== undefined && floor > ground && floor <= fromZ) ground = floor;
  const height = world.heightAt?.(px, py);
  if (height !== undefined && height > ground && height <= fromZ) ground = height;
  // The level run is the 2D distance from the start to the stepped-back point (0x004c4df0 copies its x and y).
  return terrainTiltAngle((ground - z) / Math.abs(run));
}

/** The subject as 0x00601b70 asks about it. */
export interface TerrainTiltSubject {
  /** A unit (type 3 or 4): nothing else is measured. */
  readonly unit: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing: number;
  readonly movementFlags: number;
  /** UNIT_FLAG_TAXI_FLIGHT (0x100000) in UNIT_FIELD_FLAGS. */
  readonly taxi: boolean;
  /** On a server spline (camera+0x98 bit 0x1000, CameraFollow's Fear). */
  readonly fear: boolean;
}

/** 0x00601b70's row for a subject. */
export function terrainTiltState(subject: TerrainTiltSubject): number {
  if (subject.taxi) return TERRAIN_TILT_TAXI;
  const flags = subject.movementFlags;
  if ((flags & 0x2200000) !== 0) return TERRAIN_TILT_SWIM;
  if ((flags & 0x1000) !== 0) return TERRAIN_TILT_FALL;
  if (subject.fear) return TERRAIN_TILT_FEAR;
  if ((flags & 0x3) !== 0) return TERRAIN_TILT_MOVE;
  if ((flags & 0xc) !== 0) return TERRAIN_TILT_STRAFE;
  if ((flags & 0x30) !== 0) return TERRAIN_TILT_TURN;
  return TERRAIN_TILT_IDLE;
}

/** What one frame of the tilt reads. */
export interface TerrainTiltHost {
  /** The `cameraTerrainTilt` switch. */
  readonly enabled: boolean;
  /** cameraSmoothStyle, 0–4. */
  readonly style: number;
  /** A camera CVar's number (CameraViews.cvarNumber): the table and the time bounds. */
  readonly cvar: (name: string) => number;
  readonly world: TerrainTiltWorld;
}

export class CameraTerrainTilt {
  /** camera+0x134: the tilt drawn, radians, positive looks down. */
  #tilt = 0;
  /** camera+0xa8: the last measure. */
  #measure = 0;
  /** camera+0x1d8: when it was taken, ms. */
  #measuredAt = Number.NEGATIVE_INFINITY;
  /** The glide (+0x200 target, +0x204 from, +0x1f8 start, +0x1fc seconds, +0x20c delay, +0x208 factor, bit 0x10000000). */
  #gliding = false;
  #to = 0;
  #from = 0;
  #start = 0;
  #seconds = 0;
  #delay = 0;
  #factor = 0;

  /** The tilt to add to the drawn pitch, radians, positive looks down. */
  get tilt(): number {
    return this.#tilt;
  }

  /** The last measure (tests). */
  get measure(): number {
    return this.#measure;
  }

  /** A new camera (0x00606b30) starts level. */
  reset(): void {
    this.#tilt = 0;
    this.#measure = 0;
    this.#measuredAt = Number.NEGATIVE_INFINITY;
    this.#gliding = false;
  }

  /** One camera frame at `now` (ms): the glide, then 0x00603a10 and 0x00601b70. Allocates only when it measures. */
  frame(now: number, subject: TerrainTiltSubject | undefined, host: TerrainTiltHost): number {
    this.#advance(now);
    if (subject === undefined || !subject.unit) return this.#tilt;
    if (!host.enabled) this.#measure = 0;
    else if (now - this.#measuredAt - TERRAIN_TILT_SAMPLE_MS >= 0) {
      this.#measuredAt = now;
      this.#measure = sampleTerrainTilt(host.world, subject.x, subject.y, subject.z, subject.facing);
    }
    const style = Math.trunc(host.style);
    if (!(style >= 0 && style <= 4)) return this.#tilt;
    const state = terrainTiltState(subject);
    const absorb = host.cvar(cameraTerrainTiltCVar(style, state, 0));
    const delay = host.cvar(cameraTerrainTiltCVar(style, state, 1));
    const factor = host.cvar(cameraTerrainTiltCVar(style, state, 2));
    let target = absorb * this.#measure;
    if (factor >= 0) {
      if (!(Math.abs(factor) < 2.384185791015625e-7)) {
        if (this.#glide(target, delay, factor, now)) {
          const low = factor * host.cvar("cameraTerrainTiltTimeMin");
          const high = host.cvar("cameraTerrainTiltTimeMax") * factor;
          this.#seconds = Math.min(high, Math.max(low, this.#seconds));
        }
        return this.#tilt;
      }
      this.#tilt = target;
    } else {
      target = this.#tilt;
    }
    // A set or a hold: the glide stops there (0x00601b70's tail).
    this.#gliding = false;
    this.#to = target;
    return this.#tilt;
  }

  /** 0x00600fa0: a glide to `target`; true while one heads there. */
  #glide(target: number, delay: number, factor: number, now: number): boolean {
    if (this.#gliding && Math.abs(this.#to - target) < SAME && Math.abs(this.#delay - delay) < SAME
      && Math.abs(this.#factor - factor) < SAME) return true;
    if (!(Math.abs(this.#tilt - target) >= SAME)) return false;
    this.#gliding = true;
    this.#from = this.#tilt;
    this.#to = target;
    this.#delay = delay;
    this.#factor = factor;
    this.#start = now + delay * 1000;
    this.#seconds = (Math.abs(target - this.#tilt) / (TERRAIN_TILT_SPEED_DEGREES * DEG)) * factor;
    return true;
  }

  /** 0x00603d30 on +0x134: along 0.5·(1 − cos πt) once its start has come. */
  #advance(now: number): void {
    if (!this.#gliding) return;
    if (Math.abs(this.#to - this.#tilt) < 2.384185791015625e-7) {
      this.#gliding = false;
      this.#tilt = this.#to;
      return;
    }
    const elapsed = now - this.#start;
    if (elapsed < 0) return;
    const ratio = this.#seconds > 0 ? (elapsed / 1000) / this.#seconds : Number.POSITIVE_INFINITY;
    this.#tilt = ratio <= 1 ? this.#from + (this.#to - this.#from) * 0.5 * (1 - Math.cos(Math.PI * ratio)) : this.#to;
  }
}

/** The pitch drawn from the rig's (positive looks up) with a tilt (positive looks down): 0x00604490's sum and bound. */
export function tiltedPitch(pitch: number, tilt: number | undefined): number {
  if (tilt === undefined || tilt === 0) return pitch;
  const sum = pitch - tilt;
  return Math.max(-CAMERA_DRAWN_PITCH_LIMIT, Math.min(CAMERA_DRAWN_PITCH_LIMIT, sum));
}
