import type { VehicleCatalog, VehicleEntry } from "../../world/VehicleDbc.js";
import { VEHICLE_FLAGS } from "../../world/VehicleSeatModel.js";
import { vehicleCatalog } from "../VehicleClient.js";
import { moverObject, type MoverWorld } from "./Mover.js";

/**
 * 11.02-F3: what a vehicle's Vehicle.dbc row does to moving it — for the unit the keys move
 * (Mover.ts): a driven vehicle, or the character itself when it is a player vehicle.
 *
 * The core turns the row's flags into the vehicle's MovementFlags2 once, when the kit is made
 * (`Vehicle::InitMovementInfoForBase`, Vehicle.cpp:684-698: NO_STRAFE, NO_JUMPING, FULLSPEEDTURNING,
 * ALLOW_PITCHING → ALWAYS_ALLOW_PITCHING, FULLSPEEDPITCHING), and roots a FIXED_POSITION vehicle
 * (Vehicle.cpp:236-237 — the root bit Mover.ts already honours). Wow.exe 3.3.5a reads those
 * MovementFlags2 bits (CMovement+0x48) and the row itself (Ghidra, read-only;
 * .runtime/re-2026-10-03/l1102gf3/r1-r7.c):
 *
 * - NO_STRAFE 0x1: starting a strafe is refused (0x00988b00 returns before setting STRAFE_LEFT/RIGHT),
 *   and so is rising or sinking while swimming or flying (0x009898e0); the turn keys go on turning
 *   under the right-button steer, where they would strafe otherwise (0x005fb0b0 asks 0x0074b9a0 —
 *   the unit's MovementFlags2 at +0x7d0, its CMovement being embedded at +0x788, 0x0073f67a).
 * - ALWAYS_ALLOW_PITCHING 0x20: the pitch keys act on the ground as they do in water or the air
 *   (0x005fbbc0 → 0x005fb1a0 when SWIMMING|FLYING or this bit; CMovement 0x00989220 refuses a
 *   pitch otherwise), and the MovementInfo carries the pitch (WorldSession.cpp:982, 1117).
 * - Any pitch set on a vehicle is held between PitchMin and PitchMax with CUSTOM_PITCH 0x40, else
 *   between ±π/2 (0x005fb3a0; the movement events 0x006ee460/0x006ef490 again).
 * - The right-button steer pitches the mover as the camera looks plus Vehicle MouseLookOffsetPitch
 *   (0x005fbe70 from 0x006023d0), if the mover may be pitched by the mouse at all (0x005fa790: in
 *   water or the air; on the ground with ALWAYS_ALLOW_PITCHING only when Flags has 0x40000) and is
 *   not a vehicle that aims with the mouse instead (0x00756f00: Flags & 0x40040000 == 0x40000, not
 *   swimming or flying), whose steering drag's vertical turns its pitch while the camera's stays
 *   (0x005fba60 diverting 0x006020b0's pitch to 0x005fb3a0).
 * - FIXED_POSITION 0x00200000: every facing the mover takes is held between base − FacingLimitRight
 *   and base + FacingLimitLeft (0x006eaa50, used by 0x006ee3a0, 0x006ef3d0, 0x0071c1e0, 0x006f0f70;
 *   the angle is first brought next to the window, 0x006e9290), where the base is the orientation
 *   the vehicle's create block carried after its id (kit+0x50, 0x00757fa0; Object.cpp:463-467) —
 *   `WorldObjectState.vehicleOrientation`.
 *
 * Not established, so not done: NO_JUMPING 0x2 has no reader in Wow.exe that a search found (the jump
 * path 0x005fbf80 → 0x005fa9e0/0x0072eb80/0x00988370 tests ROOT, ONTRANSPORT, PENDING_ROOT, health and
 * stand state; no `test [movement+0x48], 2`); Vehicle TurnSpeed/PitchSpeed (row +0x8/+0xc) are read
 * next to none of the 175 vehicle-kit loads — the server's turn and pitch rates stay;
 * FULLSPEEDTURNING/FULLSPEEDPITCHING choose between two facing/pitch event paths (0x005fb260,
 * 0x005fb3a0, 0x005face0) whose difference was not traced.
 *
 * Without vehicle rows, or a mover without a Vehicle.dbc row, every answer is undefined and the
 * movement code behaves exactly as before. The rules of a row are built once and kept with it.
 */

/** MovementFlags2 (UnitDefines.h:325-341) the core derives from a vehicle row. */
export const MOVEMENT_FLAGS2 = Object.freeze({
  NO_STRAFE: 0x0001,
  NO_JUMPING: 0x0002,
  FULL_SPEED_TURNING: 0x0008,
  FULL_SPEED_PITCHING: 0x0010,
  ALWAYS_ALLOW_PITCHING: 0x0020,
});

/** Vehicle Flags 0x40000 (unnamed in VehicleDefines.h): the mouse may pitch it on the ground (0x005fa790). */
export const VEHICLE_FLAG_MOUSE_PITCH = 0x0004_0000;
/** Vehicle Flags 0x40000000 (unnamed): with it, 0x40000 no longer means aiming by the drag (0x00756f00). */
export const VEHICLE_FLAG_CAMERA_PITCH = 0x4000_0000;
/** A vehicle's pitch without CUSTOM_PITCH (0x009f1ff4, 0x009e8d88: ∓1.5707964). */
export const VEHICLE_DEFAULT_PITCH_LIMIT = Math.PI / 2;

/** What one Vehicle.dbc row does to moving that vehicle. */
export interface VehicleMoverRules {
  readonly vehicleId: number;
  /** The MovementFlags2 the core gives the vehicle; echoed in its packets. */
  readonly flags2: number;
  readonly noStrafe: boolean;
  /** ALWAYS_ALLOW_PITCHING: the pitch matters on the ground and goes on the wire. */
  readonly alwaysPitch: boolean;
  readonly pitchMin: number;
  readonly pitchMax: number;
  /** Added to the camera's pitch when the steer pitches the vehicle. */
  readonly mouseLookOffsetPitch: number;
  /** Flags 0x40000: the mouse may pitch it on the ground (0x005fa790). */
  readonly groundMousePitch: boolean;
  /** 0x00756f00: on the ground the steering drag's vertical aims it, not the camera. */
  readonly mouseAims: boolean;
  readonly fixedPosition: boolean;
  readonly facingLimitRight: number;
  readonly facingLimitLeft: number;
}

/** `Vehicle::InitMovementInfoForBase` (Vehicle.cpp:684-698): the row's flags as MovementFlags2. */
export function vehicleMovementFlags2(flags: number): number {
  let flags2 = 0;
  if (flags & VEHICLE_FLAGS.NO_STRAFE) flags2 |= MOVEMENT_FLAGS2.NO_STRAFE;
  if (flags & VEHICLE_FLAGS.NO_JUMPING) flags2 |= MOVEMENT_FLAGS2.NO_JUMPING;
  if (flags & VEHICLE_FLAGS.FULLSPEEDTURNING) flags2 |= MOVEMENT_FLAGS2.FULL_SPEED_TURNING;
  if (flags & VEHICLE_FLAGS.ALLOW_PITCHING) flags2 |= MOVEMENT_FLAGS2.ALWAYS_ALLOW_PITCHING;
  if (flags & VEHICLE_FLAGS.FULLSPEEDPITCHING) flags2 |= MOVEMENT_FLAGS2.FULL_SPEED_PITCHING;
  return flags2;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Rules per row object: a reloaded catalog brings new rows and so new rules. */
const RULES = new WeakMap<VehicleEntry, VehicleMoverRules>();

/** The rules of one Vehicle.dbc row (pure; built once per row). */
export function vehicleMoverRules(vehicle: VehicleEntry): VehicleMoverRules {
  const known = RULES.get(vehicle);
  if (known) return known;
  const flags = vehicle.flags;
  const custom = (flags & VEHICLE_FLAGS.CUSTOM_PITCH) !== 0;
  const rules: VehicleMoverRules = Object.freeze({
    vehicleId: vehicle.id,
    flags2: vehicleMovementFlags2(flags),
    noStrafe: (flags & VEHICLE_FLAGS.NO_STRAFE) !== 0,
    alwaysPitch: (flags & VEHICLE_FLAGS.ALLOW_PITCHING) !== 0,
    pitchMin: custom ? finiteOr(vehicle.pitchMin, -VEHICLE_DEFAULT_PITCH_LIMIT) : -VEHICLE_DEFAULT_PITCH_LIMIT,
    pitchMax: custom ? finiteOr(vehicle.pitchMax, VEHICLE_DEFAULT_PITCH_LIMIT) : VEHICLE_DEFAULT_PITCH_LIMIT,
    mouseLookOffsetPitch: finiteOr(vehicle.mouseLookOffsetPitch, 0),
    groundMousePitch: (flags & VEHICLE_FLAG_MOUSE_PITCH) !== 0,
    mouseAims: ((flags & (VEHICLE_FLAG_MOUSE_PITCH | VEHICLE_FLAG_CAMERA_PITCH)) >>> 0) === VEHICLE_FLAG_MOUSE_PITCH,
    fixedPosition: (flags & VEHICLE_FLAGS.FIXED_POSITION) !== 0,
    facingLimitRight: finiteOr(vehicle.facingLimitRight, 0),
    facingLimitLeft: finiteOr(vehicle.facingLimitLeft, 0),
  });
  RULES.set(vehicle, rules);
  return rules;
}

/**
 * The rules of the unit the keys move, when it is a vehicle the tables know; undefined otherwise
 * (no tables yet, an old gateway, a character on foot). Three map lookups, nothing allocated.
 */
export function moverVehicleRules(world: MoverWorld | undefined,
  catalog: VehicleCatalog | undefined = vehicleCatalog()): VehicleMoverRules | undefined {
  if (catalog === undefined) return undefined;
  const vehicleId = moverObject(world)?.vehicleId;
  if (!vehicleId) return undefined;
  const row = catalog.vehicle(vehicleId);
  return row ? vehicleMoverRules(row) : undefined;
}

/** 0x005fb3a0: a vehicle's pitch inside its band. */
export function clampVehiclePitch(rules: VehicleMoverRules, pitch: number): number {
  if (!(pitch >= rules.pitchMin)) return rules.pitchMin;
  return pitch > rules.pitchMax ? rules.pitchMax : pitch;
}

/**
 * 0x005fa790 and 0x00756f00 together: whether the right-button steer sets this vehicle's pitch from
 * the camera's (plus MouseLookOffsetPitch). `aloft` is SWIMMING or FLYING.
 */
export function vehicleSteerPitchesFromCamera(rules: VehicleMoverRules, aloft: boolean): boolean {
  if (aloft) return true;
  return rules.groundMousePitch && !rules.mouseAims;
}

/** 0x00756f00: whether the steering drag's vertical aims this vehicle instead of tilting the camera. */
export function vehicleAimsWithMouse(rules: VehicleMoverRules, aloft: boolean): boolean {
  return rules.mouseAims && !aloft;
}

const TWO_PI = Math.PI * 2;

/**
 * 0x006eaa50 with 0x006e9290 and the clamp of 0x0071c1e0/0x006ee3a0: a FIXED_POSITION vehicle's
 * facing held between `base − FacingLimitRight` and `base + FacingLimitLeft`, in (−π, π]. Any other
 * vehicle's facing comes back unchanged.
 */
export function clampVehicleFacing(rules: VehicleMoverRules, base: number, facing: number): number {
  if (!rules.fixedPosition || !Number.isFinite(base) || !Number.isFinite(facing)) return facing;
  const low = base - rules.facingLimitRight;
  const high = base + rules.facingLimitLeft;
  // 0x006e9290: up past the low end, then down to the window or just under it, whichever end is nearer.
  let angle = facing;
  while (angle < low) angle += TWO_PI;
  if (angle >= high) {
    let above = angle;
    angle -= TWO_PI;
    while (high < angle) {
      above = angle;
      angle -= TWO_PI;
    }
    if (angle <= low && above - high < low - angle) angle = above;
  }
  if (angle < low) angle = low;
  else if (angle > high) angle = high;
  return ((angle + Math.PI * 3) % TWO_PI) - Math.PI;
}
