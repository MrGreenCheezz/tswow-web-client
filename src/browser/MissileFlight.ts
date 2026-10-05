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
// Kept from this client's planner instead of Wow.exe: the base speed is `startDistance / planned seconds`,
// so a missile without a speed script arrives on the frame its impact kit was scheduled for (the server's
// hit time, `Spell.Speed`, MISSILE_MAX_SECONDS cap and the zero-speed fallback, SpellVisuals.ts). A script
// that changes speed makes it arrive earlier (it is then hidden) or later (its life is extended, bounded).
//
// Not done here (listed): the target point Wow.exe uses without an attachment (position + 0.75 · height ·
// scale, 0x006ff6d0) and its lead on a moving target (same function); MissileFollowGround* (0x006fffc0);
// SpellMissile gravity (trajectory spells, 0x007015d0's 0x10000 branch); MissileCastOffset/ImpactOffset.
//
// Cost: one WeakMap lookup, one script run and a handful of square roots per missile and frame; nothing
// is allocated after launch.

import * as THREE from "three";
import { MISSILE_MOTION_INPUTS, MISSILE_MOTION_OUTPUTS, MOTION_IN, MOTION_OUT, missileProgram, type MissileProgram } from "./MissileScript.js";

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
}

/** Where the renderer finds an attachment point now, in server coordinates; false when it cannot. */
export interface MissilePoints {
  point(guid: bigint, attachment: number, out: MissilePoint): boolean;
}

/** One frame of a missile: where to draw it and how to turn it. */
export interface MissileSample {
  readonly position: MissilePoint;
  /** Unit vector from the missile's base point to the target (server frame). */
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

/** One missile's state, made at launch. */
export interface MissileFlightState {
  readonly fire: MissilePoint;
  readonly here: MissilePoint;
  readonly target: MissilePoint;
  readonly launchedAt: number;
  lastAt: number;
  progress: number;
  readonly startDistance: number;
  readonly baseSpeed: number;
  speed: number;
  /** Dropped (undefined) for good when a run fails, as Wow.exe 0x00701230 sets the script handle to −1. */
  program: MissileProgram | undefined;
  readonly inputs: Float64Array;
  readonly outputs: Float64Array;
  arrived: boolean;
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
  return {
    fire: { ...fire },
    here: { ...fire },
    target: { ...target },
    launchedAt: now,
    lastAt: now,
    progress: 0,
    startDistance,
    baseSpeed,
    speed: baseSpeed,
    program: plan.motion && plan.motion.script !== "" ? missileProgram(plan.motion.script) : undefined,
    inputs,
    outputs: new Float64Array(MISSILE_MOTION_OUTPUTS.length),
    arrived: false,
  };
}

/**
 * Advances a missile to `now` towards `target` (its current point) and fills `out`. Returns false once
 * it has arrived; `out` then holds the arrival point and nothing should be drawn.
 */
export function stepMissile(state: MissileFlightState, target: MissilePoint, now: number, out: MissileSample): boolean {
  const here = state.here;
  state.target.x = target.x;
  state.target.y = target.y;
  state.target.z = target.z;
  const dt = Math.max(0, now - state.lastAt) / 1000;
  state.lastAt = now;
  const dx = target.x - here.x;
  const dy = target.y - here.y;
  const dz = target.z - here.z;
  const remaining = Math.hypot(dx, dy, dz);
  // 05.10 review E: an unbounded speed (no time left) arrives now — Infinity · 0 on the launch frame is NaN.
  const step = state.speed === Number.POSITIVE_INFINITY ? state.speed : state.speed * dt;
  const direction = out.direction as MissilePoint;
  if (remaining > 1e-6) {
    direction.x = dx / remaining;
    direction.y = dy / remaining;
    direction.z = dz / remaining;
  }
  if (state.arrived || remaining <= step) {
    state.arrived = true;
    here.x = target.x;
    here.y = target.y;
    here.z = target.z;
    const position = out.position as MissilePoint;
    position.x = target.x;
    position.y = target.y;
    position.z = target.z;
    return false;
  }
  if (step > 0) {
    here.x += direction.x * step;
    here.y += direction.y * step;
    here.z += direction.z * step;
  }
  const fire = state.fire;
  const total = distance(fire, target);
  const left = remaining - step;
  if (total > 1e-6) state.progress = Math.max(state.progress, Math.min(1, 1 - left / total));
  else state.progress = 1;

  const position = out.position as MissilePoint;
  position.x = here.x;
  position.y = here.y;
  position.z = here.z;
  out.yaw = 0;
  out.pitch = 0;
  out.roll = 0;
  out.scale = 0;
  const program = state.program;
  if (!program) return true;

  const inputs = state.inputs;
  inputs[MOTION_IN.progress] = state.progress;
  inputs[MOTION_IN.time] = (now - state.launchedAt) / 1000;
  inputs[MOTION_IN.distanceToFirePos] = distance(fire, here);
  inputs[MOTION_IN.distanceToImpactPos] = Math.max(0, left);
  inputs[MOTION_IN.totalDistance] = total;
  const o = state.outputs;
  try {
    program.evaluate(inputs, o);
  } catch {
    // 05.10 review E: a run that fails (a chain nested past the JS stack) drops the script; straight flight.
    state.program = undefined;
    return true;
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
  return true;
}

// ---------------------------------------------------------------------------------------------
// The renderer's side: a missile instance keeps its state here, keyed by the instance itself.

const states = new WeakMap<object, MissileFlightState>();
const _launch = { x: 0, y: 0, z: 0 };
const _target = { x: 0, y: 0, z: 0 };

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
  // A target that left (despawned, out of range) keeps its last point rather than snapping to the planned one.
  const target = plan.target && plan.target.guid !== 0n && points.point(plan.target.guid, plan.target.attachment, _target)
    ? _target : state?.target ?? plan.to;
  if (!state) {
    const fire = plan.launch && plan.launch.guid !== 0n && points.point(plan.launch.guid, plan.launch.attachment, _launch)
      ? _launch : plan.from;
    // 05.10 review E: over the time left, not the whole planned life — a first frame after a hitch (or a
    // late model) still lands with the impact kit; one first seen after its arrival is not drawn at all.
    state = launchMissile(plan, fire, target, now, instance.endsAt - Math.max(now, instance.startedAt));
    states.set(instance, state);
  }
  const flying = stepMissile(state, target, now, out);
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
