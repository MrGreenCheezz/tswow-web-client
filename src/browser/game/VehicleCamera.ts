import { zoomedDistance } from "./CameraRig.js";
import { CAMERA_FIRST_PERSON_DISTANCE, CAMERA_MAX_DISTANCE, CAMERA_MIN_DISTANCE } from "../SimpleScene.js"; // 11.02-input
import type { VehicleCatalog, VehicleEntry, VehicleSeatEntry } from "../../world/VehicleDbc.js";
import { VEHICLE_SEAT_FLAGS, isVehicleCarrierGuid } from "../../world/VehicleSeatModel.js";
import type { WorldObjectState } from "../../world/WorldState.js";

/**
 * 11.02-G: the camera of a character seated in a vehicle, driver or passenger — what the seat's and
 * the vehicle's rows (VehicleDbc.ts) do to it, and when.
 *
 * Read from Wow.exe 3.3.5a 12340 (Ghidra, read-only; .runtime/re-2026-10-03/l1102gf3/r1-r7.c):
 *
 * - Who the camera watches: on the passenger state change (VehiclePassenger_C 0x007489c0) the camera's
 *   target becomes the vehicle when the seat has CAN_CONTROL (0x800), otherwise the passenger itself.
 *   The core does the same with PLAYER_FARSIGHT, which ViewSubject.ts follows: a driver's camera
 *   pivots on the vehicle, a passenger's on the character in its seat.
 * - The vehicle camera is applied by 0x0074c0e0 (UnitVehicle_C), called through VehicleCamera_C
 *   (0x0075a630) once the player's seat state settles, with a start time and an end time:
 *   - seat Flags ENABLE_VEHICLE_ZOOM 0x01000000 (DBCEnums.h:495): the camera switches to the vehicle
 *     distance (0x00600590 mode 1). The distance the wheel had is first written into the CVar of the
 *     mode being left (0x005ff320: `cameraSavedDistance` 0x00c24e7c, or `cameraSavedVehicleDistance`
 *     0x00c24e78 while camera+0x2c4 says vehicle), then the camera glides to the other one:
 *     `cameraSavedVehicleDistance` (registered at 0x005fd95b, default "-1.0"; below zero means 50
 *     yards, 0x00a1e2fc), or `cameraSavedDistance` clamped to 0…50 on the way back. While in vehicle
 *     mode the wheel lets the camera out to 50 yards whatever cameraDistanceMax × factor says
 *     (0x006000e0, case 1 of the zoom keys);
 *   - else seat FlagsB 0x400: the seat's own zoom (rare: six seats of this dataset): with FlagsB
 *     0x4000 CameraSeatZoomMin is the wheel's floor, with 0x8000 CameraSeatZoomMax its ceiling, with
 *     0x800 the camera goes to CameraEnteringZoom (0x1000: never out to it, 0x2000: never in); the
 *     distance before is kept (camera+0x2d0) and given back when the seat is left;
 *   - Vehicle CameraYawOffset and CameraPitchOffset (columns 33, 17) ease in over the same interval
 *     (0x005fe890/0x005fe8d0, eased by 0x006006a0/0x006007b0 with smoothstep 0x005fffd0);
 *   - leaving every seat undoes all of it (the ordinary distance, the bounds, the offsets 0).
 * - The interval (VehicleCamera_C 0x0075aac0): entering a seat waits FlagsB 0x40 ? CameraEnteringDelay
 *   : EnterPreDelay, then lasts FlagsB 0x40 ? CameraEnteringDuration : EnterMaxDuration clamped to
 *   0.5…3 s; leaving waits FlagsB 0x80 ? CameraExitingDelay : ExitPreDelay and lasts FlagsB 0x80 ?
 *   CameraExitingDuration : ExitMaxDuration clamped; a seat switch waits nothing (but FlagsB 0x40's
 *   CameraEnteringDelay — review); without a seat row, 0.5 s. The distance switch never takes less
 *   than 0.5 s (0x00600590). Glides are linear in time (the zoom keys' own motion, 0x005ffa60 →
 *   0x006000e0); a turn of the wheel takes over from the vehicle distance's glide, but a seat's own
 *   zoom and its give-back are locked against the wheel until they end (review: 0x005ffb70's bit 0x40).
 *
 * Not applied here (the params carry them, the hooks cannot yet):
 * - the yaw and pitch offsets are lens offsets, not an orbit: 0x00600730 turns only the vector the
 *   camera is pushed back along (the view keeps its direction), and the update 0x00606f90 turns the
 *   finished view by −pitch offset about the camera (0x004c55b0). Both put the vehicle off the
 *   centre of the screen; every camera here is rebuilt from (pivot, yaw, pitch, distance) by
 *   SimpleScene.createCamera at seven call sites, which has no way to say that;
 * - the vehicle's model fading as the camera nears it (0x00606f90: Vehicle Flags 0x80000, alpha 0 at
 *   CameraFadeDistScalarMin × the model's radius, 1 at …Max × radius) is the renderer's;
 * - the seat's CameraOffset and the chase rates (VehicleCamera_C 0x00759200/0x00759d80: the pivot
 *   moved by the offset turned with the facing, and chased; 25 seats have an offset, 19 a chase).
 *
 * Without vehicle rows, outside a vehicle seat, or riding a ship, nothing here touches the camera and
 * the wheel answers exactly as `zoomedDistance` does. Once a frame, nothing is allocated unless the
 * seat changed: the seat is recognised by comparing the transport block's guid and seat byte with the
 * last ones.
 */

/** VehicleSeat FlagsB bits the camera reads (Wow.exe 0x0075aac0, 0x0074c0e0); unnamed in DBCEnums.h:505-517. */
export const SEAT_CAMERA_FLAGS_B = Object.freeze({
  /** Entering uses CameraEnteringDelay/Duration (TrinityCore calls the bit USABLE_FORCED_2). */
  ENTER_TIMING: 0x0000_0040,
  /** Leaving uses CameraExitingDelay/Duration. */
  EXIT_TIMING: 0x0000_0080,
  /** The seat's own zoom rules below. */
  SEAT_ZOOM: 0x0000_0400,
  /** The camera goes to CameraEnteringZoom. */
  ENTERING_ZOOM: 0x0000_0800,
  /** …but never out to it. */
  ENTERING_ZOOM_NOT_OUT: 0x0000_1000,
  /** …but never in to it. */
  ENTERING_ZOOM_NOT_IN: 0x0000_2000,
  /** CameraSeatZoomMin is the wheel's floor. */
  ZOOM_MIN: 0x0000_4000,
  /** CameraSeatZoomMax is the wheel's ceiling. */
  ZOOM_MAX: 0x0000_8000,
});

/** Vehicle Flags bit 0x80000 (unnamed in VehicleDefines.h): the camera fades the vehicle's model (0x00606f90). */
export const VEHICLE_FLAG_CAMERA_FADE = 0x0008_0000;

/** The vehicle distance's default and the vehicle-mode ceiling, in yards (0x00a1e2fc). */
export const VEHICLE_ZOOM_DISTANCE = 50;
/** The shortest distance switch, in seconds (0x00600590, 0x00a1e378). */
export const VEHICLE_ZOOM_MIN_SECONDS = 0.5;
/** A seat's Enter/ExitMaxDuration is clamped to this band for the camera, in seconds (0x009e2ec4, 0x009ebbc4). */
export const VEHICLE_CAMERA_SECONDS_MIN = 0.5;
export const VEHICLE_CAMERA_SECONDS_MAX = 3;
/** Leaving without a seat row, in seconds (0x009e2f68 = 500 ms). */
export const VEHICLE_CAMERA_DEFAULT_SECONDS = 0.5;
/** Two distances closer than this are the same distance (0x00a1e34c). */
const SAME_DISTANCE = 1e-3;

/** A seat's own zoom (FlagsB 0x400). */
export interface VehicleSeatZoom {
  /** CameraSeatZoomMin with FlagsB 0x4000, else undefined. */
  readonly min: number | undefined;
  /** CameraSeatZoomMax with FlagsB 0x8000, else undefined. */
  readonly max: number | undefined;
  /** CameraEnteringZoom with FlagsB 0x800, else undefined. */
  readonly entering: number | undefined;
  /** FlagsB 0x1000 clear: the entering zoom may pull the camera out. */
  readonly enteringOut: boolean;
  /** FlagsB 0x2000 clear: the entering zoom may pull the camera in. */
  readonly enteringIn: boolean;
}

/** What the seat and its vehicle do to the camera. */
export interface VehicleCameraParams {
  readonly vehicleId: number | undefined;
  readonly seatId: number;
  /** Vehicle CameraYawOffset, radians (a lens offset: see the header — not applied). */
  readonly yawOffset: number;
  /** Vehicle CameraPitchOffset, radians (a lens offset: see the header — not applied). */
  readonly pitchOffset: number;
  /** Seat ENABLE_VEHICLE_ZOOM: the vehicle distance and its 50-yard ceiling. */
  readonly vehicleZoom: boolean;
  /** FlagsB 0x400 without ENABLE_VEHICLE_ZOOM: the seat's own zoom. */
  readonly seatZoom: VehicleSeatZoom | undefined;
  /** Seconds before the camera starts, entering this seat from none. */
  readonly enterDelay: number;
  /**
   * Seconds before the camera starts on a switch into this seat from another: CameraEnteringDelay with
   * FlagsB 0x40, else none (review: 0x0075aac0 takes the 0x40 delay for passenger states 1 and 2 alike).
   */
  readonly switchDelay: number;
  /** Seconds the camera takes, entering this seat. */
  readonly enterSeconds: number;
  /** Seconds before the camera starts, leaving this seat. */
  readonly exitDelay: number;
  /** Seconds the camera takes, leaving this seat. */
  readonly exitSeconds: number;
  /** Vehicle Flags 0x80000: the model fades between these multiples of its radius (the renderer's; not applied). */
  readonly fade: { readonly near: number; readonly far: number } | undefined;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** A seat's Enter/ExitMaxDuration as the camera takes it (0x00482940 between 0.5 and 3 s). */
function clampedSeconds(seconds: number): number {
  return Math.min(VEHICLE_CAMERA_SECONDS_MAX, Math.max(VEHICLE_CAMERA_SECONDS_MIN, finiteOr(seconds, 0)));
}

/** The camera's reading of one seat and its vehicle (pure). */
export function vehicleCameraParams(vehicle: VehicleEntry | undefined, seat: VehicleSeatEntry): VehicleCameraParams {
  const B = SEAT_CAMERA_FLAGS_B;
  const flagsB = seat.flagsB;
  const vehicleZoom = (seat.flags & VEHICLE_SEAT_FLAGS.ENABLE_VEHICLE_ZOOM) !== 0;
  const seatZoom: VehicleSeatZoom | undefined = !vehicleZoom && (flagsB & B.SEAT_ZOOM) !== 0
    ? Object.freeze({
      min: flagsB & B.ZOOM_MIN ? finiteOr(seat.cameraSeatZoomMin, 0) : undefined,
      max: flagsB & B.ZOOM_MAX ? finiteOr(seat.cameraSeatZoomMax, VEHICLE_ZOOM_DISTANCE) : undefined,
      entering: flagsB & B.ENTERING_ZOOM ? finiteOr(seat.cameraEnteringZoom, 0) : undefined,
      enteringOut: (flagsB & B.ENTERING_ZOOM_NOT_OUT) === 0,
      enteringIn: (flagsB & B.ENTERING_ZOOM_NOT_IN) === 0,
    })
    : undefined;
  const enterTiming = (flagsB & B.ENTER_TIMING) !== 0;
  const exitTiming = (flagsB & B.EXIT_TIMING) !== 0;
  const fades = vehicle !== undefined && (vehicle.flags & VEHICLE_FLAG_CAMERA_FADE) !== 0;
  const enterDelay = Math.max(0, finiteOr(enterTiming ? seat.cameraEnteringDelay : seat.enterPreDelay, 0));
  return Object.freeze({
    vehicleId: vehicle?.id,
    seatId: seat.id,
    yawOffset: finiteOr(vehicle?.cameraYawOffset ?? 0, 0),
    pitchOffset: finiteOr(vehicle?.cameraPitchOffset ?? 0, 0),
    vehicleZoom,
    seatZoom,
    enterDelay,
    switchDelay: enterTiming ? enterDelay : 0,
    enterSeconds: enterTiming ? Math.max(0, finiteOr(seat.cameraEnteringDuration, 0)) : clampedSeconds(seat.enterMaxDuration),
    exitDelay: Math.max(0, finiteOr(exitTiming ? seat.cameraExitingDelay : seat.exitPreDelay, 0)),
    exitSeconds: exitTiming ? Math.max(0, finiteOr(seat.cameraExitingDuration, 0)) : clampedSeconds(seat.exitMaxDuration),
    fade: fades
      ? Object.freeze({ near: finiteOr(vehicle!.cameraFadeDistScalarMin, 0), far: finiteOr(vehicle!.cameraFadeDistScalarMax, 0) })
      : undefined,
  });
}

/** Where a seat's own zoom puts the camera and what bounds it gives the wheel (0x0074c0e0, FlagsB 0x400 branch). */
export interface SeatZoomResult {
  readonly distance: number;
  /** The wheel's floor, when the seat sets one. */
  readonly floor: number | undefined;
  /** The wheel's ceiling, when the seat sets one. */
  readonly ceiling: number | undefined;
}

/**
 * The seat zoom against the distance the camera has (pure). The entering zoom moves the camera to it
 * unless a FlagsB bit forbids that direction; a floor below zero or a ceiling past 50 yards comes
 * from the entering zoom itself when the seat names none; the distance is then held inside both.
 */
export function seatZoomTarget(zoom: VehicleSeatZoom, current: number): SeatZoomResult {
  let floor = zoom.min;
  let ceiling = zoom.max;
  let distance = current;
  const entering = zoom.entering;
  if (entering !== undefined) {
    if (current < entering && zoom.enteringOut) distance = entering;
    if (entering < distance && zoom.enteringIn) distance = entering;
    if (floor === undefined && entering < 0) floor = entering;
    if (ceiling === undefined && entering > VEHICLE_ZOOM_DISTANCE) ceiling = entering;
  }
  if (floor !== undefined && distance < floor) distance = floor;
  if (ceiling !== undefined && distance > ceiling) distance = ceiling;
  return { distance, floor, ceiling };
}

/** The camera numbers the tracker moves: CameraRig's wheel distance. */
export interface VehicleCameraRig {
  distance: number;
}

/** The parts of WorldState read here. */
export interface VehicleCameraWorld {
  readonly selfGuid: bigint | undefined;
  readonly objects: ReadonlyMap<bigint, WorldObjectState>;
}

/**
 * The character's vehicle seat as the camera sees it, frame by frame: when it changes, the camera
 * switch of 0x0074c0e0 is scheduled after the seat's delay and carried out over its interval. One
 * per page (`vehicleCamera`); the two saved distances live here, as Wow.exe's two CVars live for the
 * session (not written to any settings blob here).
 */
export class VehicleCameraTracker {
  // The last transport block seen and what it meant: compared, not rebuilt, every frame.
  #keyGuid: bigint | undefined;
  #keySlot = -1;
  #keyVehicleId: number | undefined;
  #keyCatalog: VehicleCatalog | undefined;
  #keyParams: VehicleCameraParams | undefined;

  /** The seat the character is in now (undefined: none). */
  #seat: VehicleCameraParams | undefined;
  /** The seat whose camera is in force (what 0x0074c0e0 last applied). */
  #applied: VehicleCameraParams | undefined;
  #pendingAt: number | undefined;
  #pendingSeconds = 0;

  /** camera+0x2c4: 1 while the vehicle distance is in force. */
  #vehicleMode = false;
  /** `cameraSavedDistance`; undefined until the first switch writes it. */
  #savedDistance: number | undefined;
  /** `cameraSavedVehicleDistance`: below zero means VEHICLE_ZOOM_DISTANCE. */
  #savedVehicleDistance = -1;
  /** camera+0x2d0 with flag 0x20: the distance a seat zoom will give back. */
  #seatPreDistance: number | undefined;
  /** camera+0x2c8 / +0x2cc: the seat's bounds on the wheel. */
  #floor: number | undefined;
  #ceiling: number | undefined;

  #gliding = false;
  /**
   * Review: camera+0x9c bit 0x40 — the glide was started by 0x005ffb70 with its lock (a seat's own zoom,
   * the give-back), and the zoom motions 0x005ff950/0x005ffa60 that Lua CameraZoomIn/Out (0x006017e0/
   * 0x00601840) call do nothing until it ends. The vehicle distance's glide (0x00600590) sets no lock.
   */
  #glideLocked = false;
  #glideFrom = 0;
  #glideTo = 0;
  #glideStart = 0;
  #glideMs = 0;
  /** The distance the glide wrote last: anything else there now is the wheel's. */
  #written = 0;

  /** The seat the camera is in force for (tests, diagnostics). */
  get appliedSeat(): VehicleCameraParams | undefined {
    return this.#applied;
  }

  /** Whether the vehicle distance (and its ceiling) is in force. */
  get vehicleMode(): boolean {
    return this.#vehicleMode;
  }

  /** `cameraSavedVehicleDistance` as it stands. */
  get savedVehicleDistance(): number {
    return this.#savedVehicleDistance;
  }

  /** Once a frame, before the boom: the seat, a switch that is due, and a glide under way. */
  update(world: VehicleCameraWorld | undefined, catalog: VehicleCatalog | undefined, rig: VehicleCameraRig, now: number): void {
    const seat = this.#seatOf(world, catalog);
    if (seat !== this.#seat) this.#seatChanged(seat, now);
    if (this.#pendingAt !== undefined && now >= this.#pendingAt) {
      this.#pendingAt = undefined;
      this.#apply(this.#seat, this.#pendingSeconds, rig, now);
    }
    if (this.#gliding) this.#advanceGlide(rig, now);
  }

  /**
   * The wheel: `zoomedDistance` with the vehicle bounds in force — the seat's ceiling, else 50 yards
   * in vehicle mode, else the player's own — and the seat's floor (0x006000e0).
   */
  zoom(distance: number, step: number, maxDistance: number): number {
    if (this.#gliding && this.#glideLocked) return distance;
    const ceiling = this.#ceiling ?? (this.#vehicleMode ? VEHICLE_ZOOM_DISTANCE : maxDistance);
    const next = zoomedDistance(distance, step, ceiling);
    return this.#floor !== undefined && next < this.#floor ? this.#floor : next;
  }

  /**
   * 11.02-input: CameraZoomIn/Out(yards) — the VEHICLECAMERAZOOMIN/OUT keys' VehicleCameraZoomIn/Out(1.0)
   * (0x006018a0/0x006018b0 → 0x006017e0/0x00601840): the distance moves by `yards` (out positive; 0x005ffa60
   * glides by the number given), nothing while a seat's own zoom holds the camera (camera+0x9c bit 0x40, the
   * wheel's lock), with the wheel's bounds — the seat's or the vehicle's ceiling, the seat's floor, and the
   * first-person stop below the closest orbit (`zoomedDistance`).
   */
  zoomBy(distance: number, yards: number, maxDistance: number): number {
    if (this.#gliding && this.#glideLocked) return distance;
    const ceiling = Math.min(CAMERA_MAX_DISTANCE, this.#ceiling ?? (this.#vehicleMode ? VEHICLE_ZOOM_DISTANCE : maxDistance));
    let next: number;
    if (distance <= CAMERA_FIRST_PERSON_DISTANCE) next = yards > 0 ? Math.min(ceiling, CAMERA_MIN_DISTANCE) : distance;
    else {
      next = distance + yards;
      if (next < CAMERA_MIN_DISTANCE) next = yards < 0 ? CAMERA_FIRST_PERSON_DISTANCE : CAMERA_MIN_DISTANCE;
      else if (next > ceiling) next = ceiling;
    }
    return this.#floor !== undefined && next < this.#floor ? this.#floor : next;
  }

  /** Forgets everything (tests). */
  reset(): void {
    this.#keyGuid = undefined;
    this.#keySlot = -1;
    this.#keyVehicleId = undefined;
    this.#keyCatalog = undefined;
    this.#keyParams = undefined;
    this.#seat = undefined;
    this.#applied = undefined;
    this.#pendingAt = undefined;
    this.#pendingSeconds = 0;
    this.#vehicleMode = false;
    this.#savedDistance = undefined;
    this.#savedVehicleDistance = -1;
    this.#seatPreDistance = undefined;
    this.#floor = undefined;
    this.#ceiling = undefined;
    this.#gliding = false;
    this.#glideLocked = false;
  }

  /** The character's seat, recognised without allocating while its transport block stays the same. */
  #seatOf(world: VehicleCameraWorld | undefined, catalog: VehicleCatalog | undefined): VehicleCameraParams | undefined {
    const self = world?.selfGuid;
    if (catalog === undefined || self === undefined) return undefined;
    const transport = world!.objects.get(self)?.transport;
    if (transport === undefined) return undefined;
    const vehicleId = world!.objects.get(transport.guid)?.vehicleId;
    if (transport.guid === this.#keyGuid && transport.seat === this.#keySlot && vehicleId === this.#keyVehicleId
      && catalog === this.#keyCatalog) return this.#keyParams;
    this.#keyGuid = transport.guid;
    this.#keySlot = transport.seat;
    this.#keyVehicleId = vehicleId;
    this.#keyCatalog = catalog;
    // Wow.exe 0x0074b8b0 and 0x00613600: a vehicle's or a player's guid, the carrier in view with a kit.
    const seatRow = vehicleId && isVehicleCarrierGuid(transport.guid) ? catalog.seatInSlot(vehicleId, transport.seat) : undefined;
    this.#keyParams = seatRow ? vehicleCameraParams(catalog.vehicle(vehicleId), seatRow) : undefined;
    return this.#keyParams;
  }

  /** 0x0075aac0: when the camera switch happens and how long it takes. */
  #seatChanged(seat: VehicleCameraParams | undefined, now: number): void {
    const previous = this.#seat;
    this.#seat = seat;
    let delay: number;
    let seconds: number;
    if (seat !== undefined) {
      // From no seat the passenger state is 1 (entering, the seat's delay); from another seat it is 2
      // (review: still CameraEnteringDelay for a FlagsB 0x40 seat).
      delay = previous === undefined ? seat.enterDelay : seat.switchDelay;
      seconds = seat.enterSeconds;
    } else {
      delay = previous?.exitDelay ?? 0;
      seconds = previous?.exitSeconds ?? VEHICLE_CAMERA_DEFAULT_SECONDS;
    }
    this.#pendingAt = now + delay * 1000;
    this.#pendingSeconds = seconds;
  }

  /** 0x0074c0e0 for the seat now in force (undefined: none). */
  #apply(seat: VehicleCameraParams | undefined, seconds: number, rig: VehicleCameraRig, now: number): void {
    if (seat === this.#applied) return;
    this.#applied = seat;
    const restoring = this.#seatPreDistance !== undefined;
    let giveBack = false;
    let floor: number | undefined;
    let ceiling: number | undefined;
    if (seat?.vehicleZoom) {
      this.#switchDistance(true, seconds, true, rig, now);
    } else if (seat?.seatZoom === undefined) {
      this.#switchDistance(false, seconds, !restoring, rig, now);
      giveBack = restoring;
    } else {
      this.#switchDistance(false, seconds, false, rig, now);
      const result = seatZoomTarget(seat.seatZoom, rig.distance);
      floor = result.floor;
      ceiling = result.ceiling;
      if (Math.abs(result.distance - rig.distance) >= SAME_DISTANCE) {
        if (this.#seatPreDistance === undefined) this.#seatPreDistance = rig.distance;
        this.#glide(result.distance, seconds, rig, now, true);
      }
    }
    this.#floor = floor;
    this.#ceiling = ceiling;
    if (giveBack) {
      this.#glide(this.#seatPreDistance!, seconds, rig, now, true);
      this.#seatPreDistance = undefined;
    }
  }

  /** 0x00600590: the distance of the other mode, after writing the current one where it belongs (0x005ff320). */
  #switchDistance(vehicle: boolean, seconds: number, animate: boolean, rig: VehicleCameraRig, now: number): void {
    if (vehicle === this.#vehicleMode) return;
    const current = this.#seatPreDistance ?? rig.distance;
    if (this.#vehicleMode) this.#savedVehicleDistance = current;
    else this.#savedDistance = current;
    this.#vehicleMode = vehicle;
    let target: number;
    if (vehicle) {
      target = this.#savedVehicleDistance >= 0 ? this.#savedVehicleDistance : VEHICLE_ZOOM_DISTANCE;
    } else {
      target = Math.min(VEHICLE_ZOOM_DISTANCE, Math.max(0, this.#savedDistance ?? current));
    }
    if (animate && Math.abs(target - rig.distance) >= SAME_DISTANCE) {
      this.#glide(target, Math.max(seconds, VEHICLE_ZOOM_MIN_SECONDS), rig, now);
    }
  }

  #glide(target: number, seconds: number, rig: VehicleCameraRig, now: number, locked = false): void {
    this.#glideLocked = locked;
    this.#glideFrom = rig.distance;
    this.#glideTo = target;
    this.#glideStart = now;
    this.#glideMs = Math.max(0, seconds) * 1000;
    this.#written = rig.distance;
    this.#gliding = true;
  }

  #advanceGlide(rig: VehicleCameraRig, now: number): void {
    // The wheel turned since the last frame: the player's number wins.
    if (rig.distance !== this.#written) {
      this.#gliding = false;
      return;
    }
    const t = this.#glideMs > 0 ? (now - this.#glideStart) / this.#glideMs : 1;
    const distance = t >= 1 ? this.#glideTo : this.#glideFrom + (this.#glideTo - this.#glideFrom) * Math.max(0, t);
    rig.distance = distance;
    this.#written = distance;
    if (t >= 1) this.#gliding = false;
  }
}

/** The page's one tracker: Loop.ts updates it, Controls.ts asks it about the wheel. */
export const vehicleCamera = new VehicleCameraTracker();
