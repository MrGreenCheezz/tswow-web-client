import { PacketWriter } from "../protocol/PacketWriter.js";
import { writeMovementInfo, type MovementInfo } from "./MovementProtocol.js";
import type { PetCastTrajectory } from "./PetCastSpell.js";
import type { SpellMissileEntry } from "./SpellMissileDbc.js";
import { writeSpellTargets, type SpellTargetSpec } from "./SpellTargets.js";

/**
 * 11.02-E: aiming a missile trajectory — siege engines, catapults, cannons and the few spells a
 * character fires the same way — as Wow.exe 3.3.5a 12340 does it, and the three packets that carry it.
 *
 * Wow.exe (Ghidra, read-only; .runtime/re-2026-10-03/l1102e/r1-r4.c):
 *
 * - The cast sender (0x0080ac90) asks the spell's SpellMissile row (SpellMissileDbc.ts): with Flags bit 0
 *   the caster must be the active mover (0x00ca1238; otherwise the cast is dropped with "Missile
 *   trajectory does not have active mover caster"), the cast flags byte is 2, 0x00809f80 solves the shot
 *   and writes SOURCE_LOCATION | DEST_LOCATION (0x60) — the fire point and the impact point, replacing any
 *   point the targets held — then the packet carries `f32 elevation, f32 speed, u8 1, u32 MSG_MOVE_STOP
 *   (0xB7), packed mover guid, MovementInfo` (0x0071f060 → 0x0071ef80; `u8 0` and nothing more when the
 *   mover may not send movement, 0x0071ef20). CMSG_PET_CAST_SPELL for a vehicle, CMSG_CAST_SPELL for the
 *   character. Before that 0x00809f80 refuses a second trajectory cast while the first has started and
 *   not yet been re-aimed (0x006fbeb0) with SPELL_FAILED_SPELL_IN_PROGRESS (0x69).
 * - The solver (0x006fcd60, `param_10` 0 for a cast, 1 for the aim arc):
 *   elevation = the mover's pitch when its Vehicle row has ALLOW_PITCHING 0x10, clamped to
 *   [PitchMin, PitchMax] with CUSTOM_PITCH 0x40 (0x00497a90), else the middle of the missile's
 *   [DefaultPitchMin, DefaultPitchMax]; speed = DefaultSpeedMin + (DefaultSpeedMax − DefaultSpeedMin) ×
 *   the aim power (0x005f96e0, the global VehicleAimSetNormPower sets) when the row has ADJUST_AIM_POWER
 *   0x800, else the middle of [DefaultSpeedMin, DefaultSpeedMax]; the facing is the unit's. A cast then adds
 *   a uniform draw from each Randomize pair (pitch, speed, facing — in that order) and a jitter of ±0.01 to
 *   elevation and speed, ±0.1 to the fire point's x and y and ±0.01 to its z; the arc takes the middles of
 *   the Randomize pairs and no jitter. The fire point is the model's "$AIM" point (0x4d494124) when the
 *   model has one, else the unit's position (0x0071a720) moved by 0x00720bf0 for the spell.
 *   The flight is stepped at 0.1 s: per step `x += cos f · cos e · s · 0.1`, `y += sin f · cos e · s · 0.1`,
 *   `z += vz` with `vz` starting at `s · 0.1 · sin e − g · 0.01 / 2` and losing `g · 0.01` each step —
 *   exactly the parabola at the step ends. At most 200 steps, or `ftol(MaxDuration × 10)` when MaxDuration is
 *   over 1e-4 and that is fewer (bytes at 0x006fd226: `fld [row+0x34]; fmul [0x009e30cc] = 10; call ftol`).
 *   Each step's segment goes to the world's ray test (0x0077f310, mask 0x100111); the first hit is the
 *   impact and the time is `(steps taken + fraction) × 0.1`; no hit in all the steps leaves the impact at
 *   the last step's end. Units on the way are tested only by the arc, and only for Flags & 0x3c.
 * - CMSG_UPDATE_MISSILE_TRAJECTORY (0x006fd6b0): once per cast with a cast time. The SMSG_SPELL_START
 *   handler (0x00806700) notes, for a cast of the active mover with a cast time and a trajectory row, when
 *   it started and how long it takes (0x006fbe50 → unit+0xf70/+0xf74, only for the spell the sender noted
 *   at +0xf68/+0xf6c, 0x006fbe30); each frame (0x006fe7e0 from 0x004fa5f0) once `now − castTime − sentAt`
 *   is not negative the shot is solved again with the aim as it is now and sent — `u64 caster, u32 spell,
 *   f32 elevation, f32 speed, f32 fire xyz, f32 impact xyz` and the same `u8` + MSG_MOVE_STOP tail — and the
 *   note is cleared (0x006fbe80). (A spell whose visual flies a pre-launch missile sends it from that
 *   missile's update instead, 0x0072df00 — the same moment within a frame.) There is no rate limit and no
 *   update while aiming between casts. An instant cast is never re-aimed.
 * - CMSG_UPDATE_PROJECTILE_POSITION (0x00703640: `u64 caster, u32 spell, u8 castCount, f32 xyz`) is sent
 *   by a missile in flight (0x007015d0) when its collision test (0x006fc9b0 → 0x006fc360: spheres around
 *   the units on the path) stops it early — only for missiles whose row has Flags & 0x3c and the in-flight
 *   flag 0x200000 (0x00700880). That needs the flying missile itself; `buildUpdateProjectilePosition` is
 *   here for the day the renderer's missiles collide.
 * - Not repeated: the low bits 0x007fe520 stirs into elevation, speed and both points before writing them
 *   (a counter-keyed hash the core ignores), and the solver's tilt of the aim by the ground normal for a
 *   model with flag 0x8000 that stands on a slope.
 *
 * TrinityCore takes what it is sent: `HandleClientCastFlags` (SpellHandler.cpp:52-73), TARGET_DEST_TRAJ
 * asks the client for both points (SpellInfo.cpp:136-145), `HandleUpdateMissileTrajectory` edits the
 * current generic spell's points, elevation and speed without an owner check (MiscHandler.cpp:1565-1601),
 * and `SelectImplicitTrajTargets` (Spell.cpp:1688-1775) flies `height(d) = d · (a · d + b)` with
 * `b = tan(elevation)` and `a` chosen so that the arc ends at the destination — the gravity parabola
 * above, whenever the destination lies on it; the flight time is `dist2d / (speed · cos elevation)`.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 0x006fcd60: the step the flight is walked in, seconds (`*param_7 = steps × 0.1`). */
export const MISSILE_STEP_SECONDS = 0.1;
/** The most steps a flight is walked (0x006fcd60: 0xc8). */
export const MISSILE_MAX_STEPS = 200;
/** 0x009e8cd0: a MaxDuration at or under this means none. */
const MAX_DURATION_EPSILON = 1e-4;
/** The cast's jitter (0x009e2efc = 0.02 wide around 0x009f1968 = 0.01; 0x009e8d84 = 0.2 around 0x009e3004 = 0.1). */
const JITTER_ANGLE = 0.02;
const JITTER_POSITION = 0.2;

/** Vehicle Flags the solver reads (VehicleDefines.h; the same bits as VehicleSeatModel.ts `VEHICLE_FLAGS`). */
const ALLOW_PITCHING = 0x10;
const CUSTOM_PITCH = 0x40;
const ADJUST_AIM_POWER = 0x800;

/** What of the mover's Vehicle row the solver reads. */
export interface MissileAimVehicle {
  readonly flags: number;
  readonly pitchMin: number;
  readonly pitchMax: number;
}

export interface MissileAim {
  elevation: number;
  speed: number;
}

/**
 * 0x006fcd60's head: the elevation and the speed before any randomness. `vehicle` is the mover's own
 * Vehicle row (undefined for a unit without a kit), `moverPitch` its pitch, `power` the global aim power.
 */
export function missileAim(missile: SpellMissileEntry, vehicle: MissileAimVehicle | undefined, moverPitch: number,
  power: number, out: MissileAim = { elevation: 0, speed: 0 }): MissileAim {
  if (vehicle === undefined || (vehicle.flags & ALLOW_PITCHING) === 0) {
    out.elevation = (missile.defaultPitchMax + missile.defaultPitchMin) * 0.5;
  } else {
    let pitch = Number.isFinite(moverPitch) ? moverPitch : 0;
    if ((vehicle.flags & CUSTOM_PITCH) !== 0) {
      if (pitch < vehicle.pitchMin) pitch = vehicle.pitchMin;
      else if (pitch > vehicle.pitchMax) pitch = vehicle.pitchMax;
    }
    out.elevation = pitch;
  }
  out.speed = vehicle === undefined || (vehicle.flags & ADJUST_AIM_POWER) === 0
    ? (missile.defaultSpeedMax + missile.defaultSpeedMin) * 0.5
    : missile.defaultSpeedMin + (missile.defaultSpeedMax - missile.defaultSpeedMin) * (Number.isFinite(power) ? power : 0);
  return out;
}

/** Where and how the missile leaves. */
export interface MissileLaunch {
  elevation: number;
  speed: number;
  facing: number;
  fire: Vec3;
}

/**
 * The launch of a cast (`random` given: 0x006fcd60 with `param_10` 0 — each Randomize pair drawn, then
 * the jitter, eight draws in that order) or of the aim arc (`random` undefined: the pairs' middles).
 * `fire` is copied, never changed.
 */
export function missileLaunch(missile: SpellMissileEntry, aim: MissileAim, facing: number, fire: Vec3,
  random?: () => number): MissileLaunch {
  const launch: MissileLaunch = {
    elevation: aim.elevation, speed: aim.speed, facing: Number.isFinite(facing) ? facing : 0,
    fire: { x: fire.x, y: fire.y, z: fire.z },
  };
  if (random === undefined) {
    launch.elevation += (missile.randomizePitchMax + missile.randomizePitchMin) * 0.5;
    launch.speed += (missile.randomizeSpeedMax + missile.randomizeSpeedMin) * 0.5;
    launch.facing += (missile.randomizeFacingMax + missile.randomizeFacingMin) * 0.5;
    return launch;
  }
  launch.elevation += missile.randomizePitchMin + random() * (missile.randomizePitchMax - missile.randomizePitchMin);
  launch.speed += missile.randomizeSpeedMin + random() * (missile.randomizeSpeedMax - missile.randomizeSpeedMin);
  launch.facing += missile.randomizeFacingMin + random() * (missile.randomizeFacingMax - missile.randomizeFacingMin);
  launch.elevation += random() * JITTER_ANGLE - JITTER_ANGLE / 2;
  launch.speed += random() * JITTER_ANGLE - JITTER_ANGLE / 2;
  launch.fire.x += random() * JITTER_POSITION - JITTER_POSITION / 2;
  launch.fire.y += random() * JITTER_POSITION - JITTER_POSITION / 2;
  launch.fire.z += random() * JITTER_ANGLE - JITTER_ANGLE / 2;
  return launch;
}

/** How many 0.1 s steps a flight may take (0x006fcd60). */
export function missileMaxSteps(maxDuration: number): number {
  if (!(maxDuration > MAX_DURATION_EPSILON)) return MISSILE_MAX_STEPS;
  const steps = Math.trunc(maxDuration * 10);
  return steps > MISSILE_MAX_STEPS ? MISSILE_MAX_STEPS : steps;
}

/**
 * The world's ray test for one step (0x0077f310): the fraction 0…1 of the segment `from → to` at which
 * something solid is met, or undefined for nothing.
 */
export type MissileSegmentHit = (from: Readonly<Vec3>, to: Readonly<Vec3>) => number | undefined;

export interface MissileFlight {
  /** Where it lands. */
  impact: Vec3;
  /** Seconds from the fire point to the impact. */
  time: number;
}

/**
 * 0x006fcd60's walk: the flight from `launch` under `gravity`, a step at a time, stopped by `hit`.
 * Allocates only the answer.
 */
export function flyMissile(launch: MissileLaunch, gravity: number, maxDuration: number, hit: MissileSegmentHit): MissileFlight {
  const cosElevation = Math.cos(launch.elevation);
  const stepLength = launch.speed * MISSILE_STEP_SECONDS;
  const vx = Math.cos(launch.facing) * cosElevation * stepLength;
  const vy = Math.sin(launch.facing) * cosElevation * stepLength;
  const drop = gravity * MISSILE_STEP_SECONDS * MISSILE_STEP_SECONDS;
  let vz = stepLength * Math.sin(launch.elevation) - drop * 0.5;
  const steps = missileMaxSteps(maxDuration);
  const from = { x: launch.fire.x, y: launch.fire.y, z: launch.fire.z };
  const to = { x: from.x + vx, y: from.y + vy, z: from.z + vz };
  let left = steps;
  let fraction = hit(from, to);
  while (fraction === undefined) {
    left -= 1;
    if (left < 1) return { impact: { x: to.x, y: to.y, z: to.z }, time: steps * MISSILE_STEP_SECONDS };
    vz -= drop;
    from.x = to.x;
    from.y = to.y;
    from.z = to.z;
    to.x += vx;
    to.y += vy;
    to.z += vz;
    fraction = hit(from, to);
  }
  const t = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  return {
    impact: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t },
    time: (steps - left + t) * MISSILE_STEP_SECONDS,
  };
}

/** A solved shot: what the cast and the re-aim carry. */
export interface MissileShot {
  readonly elevation: number;
  readonly speed: number;
  readonly fire: Readonly<Vec3>;
  readonly impact: Readonly<Vec3>;
  /** Seconds of flight (the client's own estimate; the core times the flight itself). */
  readonly time: number;
}

/** Everything 0x006fcd60 reads about the caster. */
export interface MissileShotInput {
  readonly missile: SpellMissileEntry;
  readonly vehicle: MissileAimVehicle | undefined;
  readonly moverPitch: number;
  readonly power: number;
  readonly facing: number;
  readonly fire: Readonly<Vec3>;
}

/** 0x006fcd60 whole: aim, launch (randomised for a cast when `random` is given), flight. */
export function solveMissileShot(input: MissileShotInput, hit: MissileSegmentHit, random?: () => number): MissileShot {
  const aim = missileAim(input.missile, input.vehicle, input.moverPitch, input.power);
  const launch = missileLaunch(input.missile, aim, input.facing, input.fire, random);
  const flight = flyMissile(launch, input.missile.gravity, input.missile.maxDuration, hit);
  return { elevation: launch.elevation, speed: launch.speed, fire: launch.fire, impact: flight.impact, time: flight.time };
}

/**
 * TrinityCore's arc (`Spell::SelectImplicitTrajTargets`, Spell.cpp:1709-1712): the height above the source
 * at horizontal distance `d` of an arc leaving at `elevation` and ending `dz` above the source `dist2d` away.
 */
export function coreTrajectoryHeight(elevation: number, dist2d: number, dz: number, d: number): number {
  const b = Math.tan(elevation);
  let a = (dz - dist2d * b) / (dist2d * dist2d);
  if (a > -0.0001) a = 0;
  return d * (a * d + b);
}

// ---- the packets ----------------------------------------------------------------------------------

/** A mover's movement riding at the end of a trajectory packet: Wow.exe always writes MSG_MOVE_STOP. */
export interface MissileMovementTail {
  readonly opcode: number;
  readonly guid: bigint;
  readonly info: MovementInfo;
}

function writeMovementTail(writer: PacketWriter, movement: MissileMovementTail | undefined): void {
  writer.u8(movement ? 1 : 0);
  if (movement) writeMovementInfo(writer.u32(movement.opcode >>> 0), movement.guid, movement.info);
}

/**
 * `CMSG_UPDATE_MISSILE_TRAJECTORY` (0x006fd6b0; MiscHandler.cpp:1565-1601): `u64 caster | u32 spell |
 * f32 elevation | f32 speed | f32 fire xyz | f32 impact xyz | u8 moveStop [| u32 opcode | packed guid |
 * MovementInfo]`.
 */
export function buildUpdateMissileTrajectory(casterGuid: bigint, spellId: number, shot: MissileShot,
  movement?: MissileMovementTail): Uint8Array {
  const writer = new PacketWriter().u64(casterGuid).u32(spellId >>> 0).f32(shot.elevation).f32(shot.speed)
    .f32(shot.fire.x).f32(shot.fire.y).f32(shot.fire.z)
    .f32(shot.impact.x).f32(shot.impact.y).f32(shot.impact.z);
  writeMovementTail(writer, movement);
  return writer.toUint8Array();
}

/** `CMSG_UPDATE_PROJECTILE_POSITION` (0x00703640; SpellHandler.cpp:805-842): `u64 caster | u32 spell | u8 castCount | f32 xyz`. */
export function buildUpdateProjectilePosition(casterGuid: bigint, spellId: number, castCount: number, position: Readonly<Vec3>): Uint8Array {
  return new PacketWriter().u64(casterGuid).u32(spellId >>> 0).u8(castCount & 0xff)
    .f32(position.x).f32(position.y).f32(position.z).toUint8Array();
}

/** `CAST_FLAG` 2 of a client cast: the trajectory tail follows the targets (SpellHandler.cpp:55). */
export const CAST_FLAG_TRAJECTORY = 0x02;

/** A shot's targets: the press's unit (the core drops it when the spell names none), the fire point and the impact. */
export function trajectoryTargets(shot: MissileShot, unit?: bigint): SpellTargetSpec {
  return { unit: unit === 0n ? undefined : unit, source: shot.fire, destination: shot.impact };
}

/** The tail `buildPetCastSpell` writes for flag 2 (PetCastSpell.ts). */
export function trajectoryTail(shot: MissileShot, movement: MissileMovementTail | undefined): PetCastTrajectory {
  return { elevation: shot.elevation, speed: shot.speed, movement };
}

/**
 * `CMSG_CAST_SPELL` of a trajectory spell (0x0080ac90 with the character as the caster):
 * `u8 castCount | u32 spell | u8 2 | targets | f32 elevation | f32 speed | u8 hasMovement [| u32 opcode |
 * packed guid | MovementInfo]`. Undefined for targets `writeSpellTargets` refuses.
 */
export function buildCastSpellTrajectory(spellId: number, castCount: number, targets: SpellTargetSpec,
  shot: MissileShot, movement?: MissileMovementTail): Uint8Array | undefined {
  const writer = new PacketWriter().u8(castCount & 0xff).u32(spellId >>> 0).u8(CAST_FLAG_TRAJECTORY);
  if (!writeSpellTargets(writer, targets)) return undefined;
  writer.f32(shot.elevation).f32(shot.speed);
  writeMovementTail(writer, movement);
  return writer.toUint8Array();
}
