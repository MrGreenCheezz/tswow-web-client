// 05.10-A7a-E (6.12): one spell missile in flight — where it is, which way it faces, when it has arrived.
//
// Read from Wow.exe 3.3.5a 12340 (Ghidra, read-only; .runtime/re-2026-10-05/A7a-E/r1.c, r2.c):
//
// - The missile homes (Missile_C update 0x007015d0): every frame it moves `speed · dt` straight at the
//   target's *current* point (0x006ff320 re-reads it) and has arrived when the remaining distance is no
//   more than one step. No arc is added anywhere: a bolt bows only when its motion script says so.
// - progress (0x006ffed0): 1 − remaining / |target − fire point|, never decreasing.
// - The script's inputs (0x00700350): progress; time = seconds since launch; missileIndex/missileCount;
//   distanceToFirePos = |fire − here|; distanceToImpactPos = |target − here|; startDistance (fixed at
//   launch); totalDistance = |target − fire| now; rand1..3 (fixed per missile); spellID.
// - Its speed outputs (same function): speedAbs > 0 → speed = speedAbs; speedScalar > 0 → speed =
//   speedScalar · base; speedOffset ≠ 0 → speed = max(base + speedOffset, 0.01).
// - Its offsets (0x00700550) are drawn, not flown: with h = the horizontal unit vector from the fire point
//   to the target and r = (−h.y, h.x, 0), the model stands at here + transMag·(sin a · r + cos a · up)
//   (a = transAngle in degrees: 0° is straight up) + transRight · r + transFront · h + transUp · up.
// - Its facing (0x00701230): model +X along (target − here), +Y = (−dir.y, dir.x, 0) normalised, then the
//   script's modelYaw, modelPitch, modelRoll (degrees, 0x006feb20: 0x004c3380/3340/3300 in that order);
//   scale only when the script sets it above 0, never below 0.01.
//
// 13.10 (6.12, .runtime/re-2026-10-11/glue-1110/1013-m1…m3.txt; constants read from the PE):
//
// - The launcher 0x00732ff0 sets Missile_C +0x68 |= 0x3800 for a missile with a MissileMotion and 0x7800 for
//   MissileFollowGroundFlags bit 1, and 0x10800 for a SPELL_GO with CAST_FLAG_ADJUST_MISSILE (0x20000).
//   0x800: the model faces along its own drawn travel (0x00701230: Δ = drawn − last drawn; under 0.01 yards
//   it is blended with the last Δ by max(100·|Δ|, 0.05)), not at the target. 0x1000: progress is kept.
//   0x2000: the fire point is carried with the target too. 0x4000: the flight follows the ground.
// - Every frame, before the step, the missile (and with 0x2000 its fire point, in a first call) is carried
//   by the target's smoothed motion (0x006ffd70): the target's position change since the last frame drives
//   a critically damped spring (0x006ff4c0, ω = 5 (0x009ebf34), 1/(1 + x + 0.48x² + 0.235x³)) whose position
//   is added to the point. The two calls share one spring and one last position, so the second sees no
//   change — kept as written.
// - The aim at a unit (0x006ff6d0, every frame unless +0x68 & 8): its MissileDestinationAttachment point
//   moved by MissileImpactOffset (SpellVisualAttach.ts), or 0.75 · height · scale above its feet; with
//   MissileFollowGroundFlags bits 0 and 3 the aim's height is the unit's feet + FollowGroundHeight. Then the
//   lead: the unit's velocity (its movement direction × current speed, mover +0x64/+0x8c), shortened to the
//   missile's speed if faster, halved (0x009e2ec4), and the earliest positive t of
//   (|v|² − s²)t² + 2(v·d)t + |d|² = 0 moves the aim by v·t (no root, or |v|² − s² ≈ 0: no lead).
// - Ground following (0x006fffc0, step clamped to [0, 50]): the step runs horizontally; a solid in the way
//   (ray mask 0x111) stops it, lifts it by Height and the rest of the step runs on, at most four times
//   (after the fourth the step ends where it would have without the hit); a step that met nothing looks down
//   Height + 20 yards and closes the gap to (ground + Height) by DropSpeed · step of it, never below it. Past
//   the Approach share of the horizontal progress (+0xfc) the point bends onto the aim (onto the point two
//   steps ahead with Flags bit 2) by ((p − a) / (1 − a))².
// - A trajectory (0x00700880 at launch, 0x007015d0's 0x10000 branch): the elevation mirrored into
//   [−π/2, π/2]; 0x0076c070 solves the flight time T and the launch velocity v of the parabola through the
//   aim under the spell's SpellMissile Gravity (19.2911 without a row, 0x00a32f74); unsolvable, it retries
//   0.01 rad higher (lower for gravity ≤ 0); degenerate (vertical, no distance, no gravity) it flies the
//   straight line. The clock is scaled by T / (time left to the packet's delay), clamped to [0, 2]:
//   here = fire + v·τ − ½ g τ² ẑ, τ = (now − launch) · scale; it arrives at the delay.
//
// Kept from this client's planner instead of Wow.exe: the base speed is `startDistance / planned seconds`,
// so a missile without a speed script arrives on the frame its impact kit was scheduled for (the server's
// hit time, `Spell.Speed`, MISSILE_MAX_SECONDS cap and the zero-speed fallback, SpellVisuals.ts). A script
// that changes speed makes it arrive earlier (it is then hidden) or later (its life is extended, bounded).
// The unit velocity of the lead is the change of its position over the frame (the renderer keeps no mover
// direction); the ground test is the renderer's terrain height (MissilePoints.ground), not the full world.
// Not done: MissileCastOffset on a missile (only the beam builder 0x007fc5f0 was seen reading it), the
// collision of 0x3c rows, the 0x40000 time-scale ease, MissilePathType.
//
// Cost: one WeakMap lookup, one script run and a handful of square roots per missile and frame; nothing
// is allocated after launch.

import * as THREE from "three";
import { MISSILE_MOTION_INPUTS, MISSILE_MOTION_OUTPUTS, MOTION_IN, MOTION_OUT, missileProgram, type MissileProgram } from "./MissileScript.js";
import {
  FOLLOW_GROUND_AIM_AT_HEIGHT, FOLLOW_GROUND_APPROACH_AHEAD, FOLLOW_GROUND_ON, MISSILE_DEFAULT_GRAVITY, type MissileFollowGround,
} from "./SpellVisualAttach.js";

export interface MissilePoint {
  x: number;
  y: number;
  z: number;
}

/** The motion row a missile flies by (gateway `SpellVisualMissile.motion`). */
export interface MissileMotion {
  readonly id: number;
  readonly script: string;
  readonly count: number;
}

/** 13.10: a SPELL_GO with CAST_FLAG_ADJUST_MISSILE (Missile_C +0x10000). */
export interface MissileTrajectoryPlan {
  /** Radians, from the packet. */
  readonly elevation: number;
  /** The spell's SpellMissile Gravity, or MISSILE_DEFAULT_GRAVITY. */
  readonly gravity: number;
}

/** What a flight needs beyond its two planned points. */
export interface MissileFlightPlan {
  readonly from: MissilePoint;
  readonly to: MissilePoint;
  readonly launch?: { readonly guid: bigint; readonly attachment: number };
  readonly target?: { readonly guid: bigint; readonly attachment: number };
  readonly motion?: MissileMotion;
  readonly missileIndex?: number;
  readonly missileCount?: number;
  readonly spellId?: number;
  /** 13.10: MissileImpactOffset as Wow.exe reads it, (x, −y, z), in the aim attachment's frame. */
  readonly impactOffset?: readonly [number, number, number];
  /** 13.10: MissileFollowGround (SpellVisualAttach.ts `followGroundOf`). */
  readonly followGround?: MissileFollowGround;
  /** 13.10: a trajectory missile. */
  readonly trajectory?: MissileTrajectoryPlan;
}

/**
 * The renderer's world for a flight, in server coordinates. Only `point` is required: without `origin`
 * there is no lead and no carry, without `ground` no ground following.
 */
export interface MissilePoints {
  /**
   * An attachment point of a unit now, moved by `offset` in the attachment's frame (or, without the
   * attachment, 0.75 of the unit's height above its feet with the offset in its model frame); false when
   * the unit is not here.
   */
  point(guid: bigint, attachment: number, out: MissilePoint, offset?: readonly [number, number, number]): boolean;
  /** 13.10: the unit's position (its feet); false when it is not here. */
  origin?(guid: bigint, out: MissilePoint): boolean;
  /**
   * 13.10: the world's ray test from `from` to `to`: the fraction 0…1 where something solid is met, with the
   * point written to `hit`, or undefined for nothing.
   */
  ground?(from: Readonly<MissilePoint>, to: Readonly<MissilePoint>, hit: MissilePoint): number | undefined;
}

/** One frame of a missile: where to draw it and how to turn it. */
export interface MissileSample {
  readonly position: MissilePoint;
  /** Unit vector the model's +X takes (server frame). */
  readonly direction: MissilePoint;
  /** Degrees, from the script. */
  yaw: number;
  pitch: number;
  roll: number;
  /** The script's scale, or 0 when it set none. */
  scale: number;
}

export function missileSample(): MissileSample {
  return { position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, scale: 0 };
}

/** The lowest speed a script may set through speedOffset, and the lowest scale (Wow.exe 0x009f1968). */
export const MISSILE_SCRIPT_MIN = 0.01;
/** A slower-than-planned missile lives at most this long past its planned arrival. */
export const MISSILE_OVERRUN_MS = 4_000;
export { MISSILE_DEFAULT_GRAVITY };
/** 0x009ebf34: the spring of the target-motion carry. */
const CARRY_OMEGA = 5;
/** 0x009f22ec: the longest ground-following step. */
const FOLLOW_GROUND_MAX_STEP = 50;
/** 0x009f281c: how far below the height a ground-following step looks for the ground. */
const FOLLOW_GROUND_PROBE = 20;
/** 0x00a32f70. */
const ALMOST_ONE = 0.999;
const TINY = 2.384185791015625e-7; // 0x009ea27c
const EPSILON_SQ = 0.000009999999747378752; // 0x009ea558
const SOLVE_EPSILON = 0.0001; // 0x009e8cd0

/** Missile_C +0x68 bits this flight keeps. */
const FACE_TRAVEL = 0x800;
const CARRY_FIRE = 0x2000;
const FOLLOW_GROUND = 0x4000;

interface CarrySpring {
  ready: boolean;
  lastX: number;
  lastY: number;
  lastZ: number;
  pos: Float64Array; // 0..2 position, 3..5 velocity
}

/** One missile's state, made at launch. */
export interface MissileFlightState {
  readonly fire: MissilePoint;
  readonly here: MissilePoint;
  readonly target: MissilePoint;
  readonly launchedAt: number;
  lastAt: number;
  progress: number;
  /** 13.10: horizontal progress (+0xfc), what the ground-following approach reads. */
  progressFlat: number;
  readonly startDistance: number;
  readonly baseSpeed: number;
  speed: number;
  /** Dropped (undefined) for good when a run fails, as Wow.exe 0x00701230 sets the script handle to −1. */
  program: MissileProgram | undefined;
  readonly inputs: Float64Array;
  readonly outputs: Float64Array;
  arrived: boolean;
  /** 13.10: Missile_C +0x68 (FACE_TRAVEL, CARRY_FIRE, FOLLOW_GROUND). */
  readonly flags: number;
  readonly followGround: MissileFollowGround | undefined;
  readonly carry: CarrySpring;
  /** 13.10: the last drawn point (+0x5c) and travel (+0x194) for FACE_TRAVEL; `faced` once one exists. */
  readonly drawn: Float64Array;
  faced: number;
  /** 13.10: a solved trajectory: launch velocity, gravity and clock scale (+0x120, +0x140, +0x130). */
  trajectory: { vx: number; vy: number; vz: number; gravity: number; scale: number } | undefined;
  /** 13.10: when it arrives (a trajectory's end, +0x134). */
  endsAt: number;
}

function distance(a: MissilePoint, b: MissilePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/**
 * Starts a missile at `fire`, aimed at `target`, to arrive after `plannedMs` at constant speed.
 * `random` gives rand1..3 (Wow.exe keeps three per missile, +0x188..+0x190).
 */
export function launchMissile(
  plan: MissileFlightPlan,
  fire: MissilePoint,
  target: MissilePoint,
  now: number,
  plannedMs: number,
  random: () => number = Math.random,
): MissileFlightState {
  const startDistance = distance(fire, target);
  const baseSpeed = plannedMs > 0 ? startDistance / (plannedMs / 1000) : Number.POSITIVE_INFINITY;
  const inputs = new Float64Array(MISSILE_MOTION_INPUTS.length);
  inputs[MOTION_IN.missileIndex] = plan.missileIndex ?? 0;
  inputs[MOTION_IN.missileCount] = plan.missileCount ?? plan.motion?.count ?? 1;
  inputs[MOTION_IN.startDistance] = startDistance;
  inputs[MOTION_IN.rand1] = random();
  inputs[MOTION_IN.rand2] = random();
  inputs[MOTION_IN.rand3] = random();
  inputs[MOTION_IN.spellID] = plan.spellId ?? 0;
  const program = plan.motion && plan.motion.script !== "" ? missileProgram(plan.motion.script) : undefined;
  const followGround = plan.followGround !== undefined && (plan.followGround.flags & FOLLOW_GROUND_ON) !== 0
    ? plan.followGround : undefined;
  // 0x00732ff0: 0x3800 for a motion row, 0x7800 for ground following, 0x10800 for a trajectory.
  let flags = 0;
  if (plan.motion) flags |= FACE_TRAVEL | CARRY_FIRE;
  if (followGround) flags |= FACE_TRAVEL | CARRY_FIRE | FOLLOW_GROUND;
  if (plan.trajectory) flags |= FACE_TRAVEL;
  const state: MissileFlightState = {
    fire: { ...fire },
    here: { ...fire },
    target: { ...target },
    launchedAt: now,
    lastAt: now,
    progress: 0,
    progressFlat: 0,
    startDistance,
    baseSpeed,
    speed: baseSpeed,
    program,
    inputs,
    outputs: new Float64Array(MISSILE_MOTION_OUTPUTS.length),
    arrived: false,
    flags,
    followGround,
    carry: { ready: false, lastX: 0, lastY: 0, lastZ: 0, pos: new Float64Array(6) },
    drawn: new Float64Array(6),
    faced: 0,
    trajectory: undefined,
    endsAt: now + Math.max(0, plannedMs),
  };
  if (plan.trajectory) state.trajectory = solveTrajectory(fire, target, plan.trajectory, plannedMs);
  return state;
}

// ---------------------------------------------------------------------------------------------
// 13.10: the pieces of 0x007015d0, each as Wow.exe has it.

/**
 * 0x0076c070: the parabola leaving at `elevation` that passes `delta` (target − fire) under `gravity`.
 * 0 unsolvable, 1 degenerate, 2 solved (`out` = [time, vx, vy, vz]).
 */
export function trajectoryLaunch(elevation: number, delta: MissilePoint, gravity: number, out: Float64Array): 0 | 1 | 2 {
  const cosine = Math.cos(elevation);
  const sine = Math.sin(elevation);
  const flat = Math.hypot(delta.x, delta.y);
  if (Math.abs(cosine) < SOLVE_EPSILON || Math.abs(flat) < SOLVE_EPSILON || Math.abs(gravity) < SOLVE_EPSILON) return 1;
  let squared = ((1 / cosine) * flat * sine - delta.z) / gravity;
  squared += squared;
  if (squared <= 0.009999999776482582) return 0;
  const time = Math.sqrt(squared);
  const speed = (flat / time) * (1 / cosine);
  out[0] = time;
  out[1] = speed * delta.x * (1 / flat) * cosine;
  out[2] = speed * (1 / flat) * cosine * delta.y;
  out[3] = sine * speed;
  return 2;
}

/** 0x00700880: the elevation folded back into [−π/2, π/2] (a mirror at each end). */
export function foldElevation(elevation: number): number {
  const half = Math.PI / 2;
  if (elevation > half) return elevation - 2 * (elevation - half);
  if (elevation < -half) return elevation + 2 * (-half - elevation);
  return elevation;
}

const _solve = new Float64Array(4);

/** 0x00700880 for a trajectory: velocity and clock scale, or undefined to fly the straight line. */
function solveTrajectory(fire: MissilePoint, aim: MissilePoint, plan: MissileTrajectoryPlan, remainingMs: number):
  MissileFlightState["trajectory"] {
  const delta = { x: aim.x - fire.x, y: aim.y - fire.y, z: aim.z - fire.z };
  const gravity = Number.isFinite(plan.gravity) ? plan.gravity : MISSILE_DEFAULT_GRAVITY;
  let result = trajectoryLaunch(foldElevation(plan.elevation), delta, gravity, _solve);
  if (result === 0) {
    result = trajectoryLaunch(foldElevation(plan.elevation + (gravity > 0 ? 0.01 : -0.01)), delta, gravity, _solve);
  }
  // Degenerate (or still unsolvable): the line, timed to the delay — 0x0076bf80's speed cancels out of
  // v = Δ / T over a clock scaled by T / left.
  if (result !== 2) return undefined;
  const left = Math.max(remainingMs / 1000, SOLVE_EPSILON);
  const scale = _solve[0]! / left;
  return { vx: _solve[1]!, vy: _solve[2]!, vz: _solve[3]!, gravity, scale: scale < 0 ? 0 : scale >= 2 ? 2 : scale };
}

/**
 * 0x006ff6d0's lead: the aim at a unit moving at `velocity`, for a missile at `here` flying `speed`.
 * Writes `aim` in place; no root (or a speed equal to the unit's) leaves it.
 */
export function leadAim(aim: MissilePoint, here: MissilePoint, velocity: MissilePoint, speed: number): void {
  const dx = aim.x - here.x;
  const dy = aim.y - here.y;
  const dz = aim.z - here.z;
  let vx = velocity.x;
  let vy = velocity.y;
  let vz = velocity.z;
  const speedSq = speed * speed;
  const unitSq = vx * vx + vy * vy + vz * vz;
  if (speedSq < unitSq) {
    const k = speed / Math.sqrt(unitSq);
    vx *= k; vy *= k; vz *= k;
  }
  vx *= 0.5; vy *= 0.5; vz *= 0.5;
  const a = vx * vx + vy * vy + vz * vz - speedSq;
  let b = vx * dx + vy * dy + vz * dz;
  b += b;
  const discriminant = b * b - (dx * dx + dz * dz + dy * dy) * a * 4;
  if (!(discriminant >= 0) || !(EPSILON_SQ <= a * a)) return;
  const root = Math.sqrt(discriminant);
  const first = (-b - root) * (0.5 / a);
  const second = (root - b) * (0.5 / a);
  let t = Number.MAX_VALUE;
  if (first > 0 && first < t) t = first;
  if (second > 0 && second < t) t = second;
  if (t === Number.MAX_VALUE) return;
  aim.x += vx * t;
  aim.y += vy * t;
  aim.z += vz * t;
}

/** 0x006ff4c0 + 0x006ffd70: carries `point` by the smoothed change of `origin` since the last call. */
function carry(spring: CarrySpring, origin: MissilePoint, point: MissilePoint, dt: number): void {
  if (!spring.ready) {
    spring.pos.fill(0);
    spring.ready = true;
  } else {
    const p = spring.pos;
    const x = CARRY_OMEGA * dt;
    const decay = 1 / (x * x * 0.47999998927116394 + x * x * x * 0.23499999940395355 + x + 1);
    for (let axis = 0; axis < 3; axis++) {
      const target = axis === 0 ? origin.x - spring.lastX : axis === 1 ? origin.y - spring.lastY : origin.z - spring.lastZ;
      const change = p[axis]! - target;
      const temp = (change * CARRY_OMEGA + p[axis + 3]!) * dt;
      p[axis] = target + (temp + change) * decay;
      p[axis + 3] = (p[axis + 3]! - temp * CARRY_OMEGA) * decay;
    }
    point.x += p[0]!;
    point.y += p[1]!;
    point.z += p[2]!;
  }
  spring.lastX = origin.x;
  spring.lastY = origin.y;
  spring.lastZ = origin.z;
}

const _from = { x: 0, y: 0, z: 0 };
const _to = { x: 0, y: 0, z: 0 };
const _hit = { x: 0, y: 0, z: 0 };

/**
 * 0x006fffc0: one ground-following step of `step` yards along `direction` from `state.here` towards
 * `state.target` (the aim). `ground` is the world's ray test.
 */
export function followGroundStep(state: MissileFlightState, direction: MissilePoint, step: number,
  world: Pick<MissilePoints, "ground"> | undefined): void {
  const row = state.followGround!;
  const here = state.here;
  let length = step >= 0 ? (step < FOLLOW_GROUND_MAX_STEP ? step : FOLLOW_GROUND_MAX_STEP) : 0;
  const stepLength = length;
  const aheadX = here.x + direction.x * length * 2;
  const aheadY = here.y + direction.y * length * 2;
  const aheadZ = here.z + direction.z * length * 2;
  let hx = 1;
  let hy = 0;
  if (Math.abs(direction.z) <= ALMOST_ONE) {
    const flat = 1 / Math.hypot(direction.x, direction.y);
    hx = direction.x * flat;
    hy = direction.y * flat;
  }
  let tries = 4;
  for (;;) {
    _from.x = here.x; _from.y = here.y; _from.z = here.z;
    _to.x = here.x + hx * length; _to.y = here.y + hy * length; _to.z = here.z;
    const fraction = world?.ground?.(_from, _to, _hit);
    if (fraction === undefined) break;
    here.x += hx * length * fraction;
    here.y += hy * length * fraction;
    length *= 1 - fraction;
    here.z += row.height;
    if (fraction > ALMOST_ONE || --tries < 1) break;
  }
  // The step ends at the last segment's end (even past a solid, once the tries are spent).
  here.x = _to.x;
  here.y = _to.y;
  here.z = _to.z;
  if (tries === 4 && world?.ground) {
    _from.x = here.x; _from.y = here.y; _from.z = here.z;
    _to.x = here.x; _to.y = here.y; _to.z = here.z - (row.height + FOLLOW_GROUND_PROBE);
    if (world.ground(_from, _to, _hit) !== undefined) {
      const floor = row.height + _hit.z;
      const lowered = here.z - (here.z - floor) * row.dropSpeed * stepLength;
      here.z = floor < lowered ? lowered : floor;
    }
  }
  if (state.progressFlat <= row.approach) return;
  let weight = (state.progressFlat - row.approach) * (1 / (1 - row.approach));
  weight *= weight;
  const keep = 1 - weight;
  if ((row.flags & FOLLOW_GROUND_APPROACH_AHEAD) === 0) {
    here.x = here.x * keep + state.target.x * weight;
    here.y = here.y * keep + state.target.y * weight;
    here.z = here.z * keep + state.target.z * weight;
  } else {
    here.x = here.x * keep + aheadX * weight;
    here.y = here.y * keep + aheadY * weight;
    here.z = here.z * keep + aheadZ * weight;
  }
}

/** 0x006ffed0: progress and horizontal progress, neither ever decreasing. */
function updateProgress(state: MissileFlightState, left: number): void {
  const fire = state.fire;
  const target = state.target;
  const dx = target.x - fire.x;
  const dy = target.y - fire.y;
  const dz = target.z - fire.z;
  const total = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const progress = total > 1e-6 ? 1 - left / total : 1;
  if (progress > state.progress) state.progress = Math.min(1, progress);
  const flatTotal = Math.hypot(dx, dy);
  const flat = flatTotal > 1e-6 ? 1 - Math.hypot(target.x - state.here.x, target.y - state.here.y) / flatTotal : 1;
  if (flat > state.progressFlat) state.progressFlat = flat;
}

// ---------------------------------------------------------------------------------------------

/** 13.10: what one frame knows of the world beyond the aim point (all optional). */
export interface MissileFrame {
  /** The target unit's position now (motion carry). */
  origin?: MissilePoint | undefined;
  /** The target unit's velocity, yards a second (lead). */
  velocity?: MissilePoint | undefined;
  /** The world whose ray test ground following uses (`MissilePoints.ground`). */
  world?: Pick<MissilePoints, "ground">;
}

/**
 * Advances a missile to `now` towards `target` (its current point) and fills `out`. Returns false once
 * it has arrived; `out` then holds the arrival point and nothing should be drawn.
 */
export function stepMissile(state: MissileFlightState, target: MissilePoint, now: number, out: MissileSample,
  frame?: MissileFrame): boolean {
  const here = state.here;
  const dt = Math.max(0, now - state.lastAt) / 1000;
  state.lastAt = now;
  const aim = state.target;
  aim.x = target.x;
  aim.y = target.y;
  aim.z = target.z;
  // 0x006ff6d0: the lead on a moving unit (aimed again every frame).
  if (frame?.velocity && Number.isFinite(state.speed)) leadAim(aim, here, frame.velocity, state.speed);
  // 0x006ffd70: carried by the target's motion — the fire point first (0x2000), then the missile.
  if (frame?.origin && dt > 0) {
    if ((state.flags & CARRY_FIRE) !== 0) carry(state.carry, frame.origin, state.fire, dt);
    carry(state.carry, frame.origin, here, dt);
  }
  const position = out.position as MissilePoint;
  const direction = out.direction as MissilePoint;
  const dx = aim.x - here.x;
  const dy = aim.y - here.y;
  const dz = aim.z - here.z;
  const remaining = Math.hypot(dx, dy, dz);
  if (remaining > 1e-6) {
    direction.x = dx / remaining;
    direction.y = dy / remaining;
    direction.z = dz / remaining;
  }

  let left: number;
  if (state.trajectory) {
    // 0x007015d0's 0x10000 branch: the parabola on its scaled clock; it arrives at the delay.
    if (state.arrived || now >= state.endsAt) return arrive(state, out);
    const flight = state.trajectory!;
    const tau = ((now - state.launchedAt) / 1000) * flight.scale;
    here.x = state.fire.x + flight.vx * tau;
    here.y = state.fire.y + flight.vy * tau;
    here.z = state.fire.z + flight.vz * tau - flight.gravity * tau * tau * 0.5;
    left = distance(here, aim);
    updateProgress(state, left);
  } else {
    // 05.10 review E: an unbounded speed (no time left) arrives now — Infinity · 0 on the launch frame is NaN.
    const step = state.speed === Number.POSITIVE_INFINITY ? state.speed : state.speed * dt;
    if (state.arrived || remaining <= step) return arrive(state, out);
    if (step > 0) {
      if ((state.flags & FOLLOW_GROUND) !== 0) followGroundStep(state, direction, step, frame?.world);
      else {
        here.x += direction.x * step;
        here.y += direction.y * step;
        here.z += direction.z * step;
      }
    }
    left = remaining - step;
    updateProgress(state, left);
  }

  position.x = here.x;
  position.y = here.y;
  position.z = here.z;
  out.yaw = 0;
  out.pitch = 0;
  out.roll = 0;
  out.scale = 0;
  const program = state.program;
  if (program) runScript(state, program, position, out, aim, now, Math.max(0, left));
  if ((state.flags & FACE_TRAVEL) !== 0) faceTravel(state, position, direction);
  return true;
}

function arrive(state: MissileFlightState, out: MissileSample): false {
  state.arrived = true;
  const here = state.here;
  const aim = state.target;
  here.x = aim.x;
  here.y = aim.y;
  here.z = aim.z;
  const position = out.position as MissilePoint;
  position.x = aim.x;
  position.y = aim.y;
  position.z = aim.z;
  return false;
}

function runScript(state: MissileFlightState, program: MissileProgram, position: MissilePoint, out: MissileSample,
  target: MissilePoint, now: number, left: number): void {
  const fire = state.fire;
  const here = state.here;
  const inputs = state.inputs;
  inputs[MOTION_IN.progress] = state.progress;
  inputs[MOTION_IN.time] = (now - state.launchedAt) / 1000;
  inputs[MOTION_IN.distanceToFirePos] = distance(fire, here);
  inputs[MOTION_IN.distanceToImpactPos] = left;
  inputs[MOTION_IN.totalDistance] = distance(fire, target);
  const o = state.outputs;
  try {
    program.evaluate(inputs, o);
  } catch {
    // 05.10 review E: a run that fails (a chain nested past the JS stack) drops the script; straight flight.
    state.program = undefined;
    return;
  }

  // Speed for the next step (0x00700350: absolute, then scalar, then offset; each overrides the last).
  if (o[MOTION_OUT.speedAbs]! > 0) state.speed = o[MOTION_OUT.speedAbs]!;
  if (o[MOTION_OUT.speedScalar]! > 0) state.speed = o[MOTION_OUT.speedScalar]! * state.baseSpeed;
  if (o[MOTION_OUT.speedOffset]! !== 0) state.speed = Math.max(state.baseSpeed + o[MOTION_OUT.speedOffset]!, MISSILE_SCRIPT_MIN);

  // Offsets (0x00700550), in the horizontal frame of fire point → target.
  let hx = target.x - fire.x;
  let hy = target.y - fire.y;
  const horizontal = Math.hypot(hx, hy);
  if (horizontal > 1e-6) {
    hx /= horizontal;
    hy /= horizontal;
  } else {
    hx = 0;
    hy = 0;
  }
  const magnitude = o[MOTION_OUT.transMag]!;
  if (magnitude !== 0) {
    const angle = o[MOTION_OUT.transAngle]! * (Math.PI / 180);
    const side = magnitude * Math.sin(angle);
    position.x += side * -hy;
    position.y += side * hx;
    position.z += magnitude * Math.cos(angle);
  }
  const right = o[MOTION_OUT.transRight]!;
  position.x += right * -hy;
  position.y += right * hx;
  const front = o[MOTION_OUT.transFront]!;
  position.x += front * hx;
  position.y += front * hy;
  position.z += o[MOTION_OUT.transUp]!;
  out.yaw = o[MOTION_OUT.modelYaw]!;
  out.pitch = o[MOTION_OUT.modelPitch]!;
  out.roll = o[MOTION_OUT.modelRoll]!;
  const scale = o[MOTION_OUT.scale]!;
  out.scale = scale > 0 ? Math.max(scale, MISSILE_SCRIPT_MIN) : 0;
}

/**
 * 0x00701230 with +0x68 & 0x800: the model faces along its drawn travel since the last frame; a travel under
 * 0.01 yards is blended with the last by max(100 · |Δ|, 0.05); none at all keeps the aim direction.
 */
function faceTravel(state: MissileFlightState, position: MissilePoint, direction: MissilePoint): void {
  const last = state.drawn;
  let dx = position.x - last[0]!;
  let dy = position.y - last[1]!;
  let dz = position.z - last[2]!;
  const first = state.faced === 0;
  last[0] = position.x;
  last[1] = position.y;
  last[2] = position.z;
  state.faced = state.faced === 0 ? 1 : state.faced;
  if (first) return;
  let length = Math.sqrt(dx * dx + dz * dz + dy * dy);
  if (!(length > TINY)) return;
  if (length < MISSILE_SCRIPT_MIN && state.faced === 2) {
    const t = Math.max(length * 100, 0.05);
    dx = dx * t + last[3]! * (1 - t);
    dy = dy * t + last[4]! * (1 - t);
    dz = dz * t + last[5]! * (1 - t);
    length = Math.sqrt(dx * dx + dz * dz + dy * dy);
    if (!(length > 0)) return;
  }
  last[3] = dx;
  last[4] = dy;
  last[5] = dz;
  state.faced = 2;
  direction.x = dx / length;
  direction.y = dy / length;
  direction.z = dz / length;
}

// ---------------------------------------------------------------------------------------------
// The renderer's side: a missile instance keeps its state here, keyed by the instance itself.

const states = new WeakMap<object, MissileFlightState>();
/** 13.10: the target unit's last position and frame time, per instance, for its velocity (the lead). */
const motions = new WeakMap<object, { x: number; y: number; z: number; at: number; vx: number; vy: number; vz: number }>();
const _launch = { x: 0, y: 0, z: 0 };
const _target = { x: 0, y: 0, z: 0 };
const _origin = { x: 0, y: 0, z: 0 };
const _velocity = { x: 0, y: 0, z: 0 };
const _frame: MissileFrame = {};
/** A unit moving faster than this between two frames was placed, not moved: no lead from it. */
const LEAD_MAX_SPEED = 100;

/** The subset of a planned VisualInstance this needs. */
export interface MissileInstance {
  readonly flight?: MissileFlightPlan;
  readonly startedAt: number;
  endsAt: number;
}

/**
 * One frame of a planned missile instance. Launches it on its first visible frame (the launch point
 * read once: the missile has left the hand), then follows the target's current point. Returns false once
 * it has arrived: the caller hides it, and its life is cut to `now` so the sweep takes it.
 */
export function flyMissileInstance(instance: MissileInstance, now: number, points: MissilePoints, out: MissileSample): boolean {
  const plan = instance.flight;
  if (!plan) return false;
  let state = states.get(instance);
  const unit = plan.target && plan.target.guid !== 0n ? plan.target.guid : undefined;
  // A target that left (despawned, out of range) keeps its last point rather than snapping to the planned one.
  const target = unit !== undefined && points.point(unit, plan.target!.attachment, _target, plan.impactOffset)
    ? _target : state?.target ?? plan.to;
  // 13.10: the unit's feet — the carry, the lead and (FollowGround flags 1|8) the aim's height.
  const origin = unit !== undefined && points.origin?.(unit, _origin) ? _origin : undefined;
  if (origin && target === _target && plan.followGround
    && (plan.followGround.flags & FOLLOW_GROUND_AIM_AT_HEIGHT) === FOLLOW_GROUND_AIM_AT_HEIGHT) {
    _target.z = origin.z + plan.followGround.height;
  }
  if (!state) {
    const fire = plan.launch && plan.launch.guid !== 0n && points.point(plan.launch.guid, plan.launch.attachment, _launch)
      ? _launch : plan.from;
    // 05.10 review E: over the time left, not the whole planned life — a first frame after a hitch (or a
    // late model) still lands with the impact kit; one first seen after its arrival is not drawn at all.
    state = launchMissile(plan, fire, target, now, instance.endsAt - Math.max(now, instance.startedAt));
    states.set(instance, state);
  }
  _frame.origin = origin;
  _frame.velocity = origin && !plan.trajectory ? unitVelocity(instance, origin, now) : undefined;
  _frame.world = points;
  const flying = stepMissile(state, target, now, out, _frame);
  if (!flying) {
    instance.endsAt = Math.min(instance.endsAt, now);
    return false;
  }
  // A missile the script slowed down lives past its planned arrival, boundedly.
  if (now >= instance.endsAt) {
    const plannedEnd = state.launchedAt + (Number.isFinite(state.baseSpeed) && state.baseSpeed > 0
      ? (state.startDistance / state.baseSpeed) * 1000 : 0);
    instance.endsAt = Math.min(Math.max(instance.endsAt, now + 50), plannedEnd + MISSILE_OVERRUN_MS);
  }
  return true;
}

/** The unit's velocity from its position over the last frame (undefined on its first frame). */
function unitVelocity(instance: object, origin: MissilePoint, now: number): MissilePoint | undefined {
  const last = motions.get(instance);
  if (!last) {
    motions.set(instance, { x: origin.x, y: origin.y, z: origin.z, at: now, vx: 0, vy: 0, vz: 0 });
    return undefined;
  }
  const dt = (now - last.at) / 1000;
  if (dt > 0) {
    const vx = (origin.x - last.x) / dt;
    const vy = (origin.y - last.y) / dt;
    const vz = (origin.z - last.z) / dt;
    const fast = Math.hypot(vx, vy, vz) > LEAD_MAX_SPEED;
    last.vx = fast ? 0 : vx;
    last.vy = fast ? 0 : vy;
    last.vz = fast ? 0 : vz;
    last.x = origin.x; last.y = origin.y; last.z = origin.z; last.at = now;
  }
  _velocity.x = last.vx;
  _velocity.y = last.vy;
  _velocity.z = last.vz;
  return _velocity;
}

/** Tests: the state a planned instance flies with, if launched. */
export function missileStateOf(instance: object): MissileFlightState | undefined {
  return states.get(instance);
}

// ---------------------------------------------------------------------------------------------
// Facing, as a scene-space quaternion for the missile's outer node (the inner frame keeps the M2→scene
// turn, `#orientVisualFrame`): model +X along the direction, then yaw/pitch/roll about model Z/Y/X.

const _basis = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "ZYX");
/** Server (x, y, z-up) → scene (x, z, −y): a −90° turn about X, the same turn as M2_TO_SCENE. */
const SERVER_TO_SCENE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const SCENE_TO_SERVER = SERVER_TO_SCENE.clone().invert();
const DEG = Math.PI / 180;

export function missileQuaternion(sample: MissileSample, target: THREE.Quaternion): THREE.Quaternion {
  const d = sample.direction;
  _x.set(d.x, d.y, d.z);
  if (_x.lengthSq() < 1e-12) _x.set(1, 0, 0);
  _x.normalize();
  _y.set(-_x.y, _x.x, 0);
  if (_y.lengthSq() < 1e-12) _y.set(0, 1, 0);
  _y.normalize();
  _z.crossVectors(_x, _y).normalize();
  _basis.makeBasis(_x, _y, _z);
  _q.setFromRotationMatrix(_basis);
  if (sample.yaw !== 0 || sample.pitch !== 0 || sample.roll !== 0) {
    _euler.set(sample.roll * DEG, sample.pitch * DEG, sample.yaw * DEG, "ZYX");
    _q.multiply(target.setFromEuler(_euler));
  }
  // The node turns scene-space vectors; the server-frame rotation conjugated into the scene.
  return target.copy(SERVER_TO_SCENE).multiply(_q).multiply(SCENE_TO_SERVER);
}
