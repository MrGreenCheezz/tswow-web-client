// 11.02-F2: the stock vehicle interface's rules that are not seat-model answers (VehicleSeatModel.ts):
// the vehicle's bar on the main bar, the arguments of UNIT_ENTERING/ENTERED_VEHICLE, the passengers'
// signature behind VEHICLE_PASSENGERS_CHANGED, the gates of UnitSwitchToVehicleSeat and
// EjectPassengerFromSeat, and the aim answers VehicleMenuBar reads. Pure: no DOM, no network.
//
// Read from Wow.exe 3.3.5a 12340 (Ghidra, read-only; .runtime/re-2026-10-03/l1102f2/r1.c and the notes of
// l1102f1, l1102if, l1102bcd, l1102h, l1102gf3):
//
// - 0x005d4ad0 (the main-bar bit): when the pet bar's unit is the far sight unit and 0x005d35b0 lets it
//   carry a bar, the bit is set — except that, when the character rides the bar's unit (its transport
//   guid, vfunc +0x40, is the bar's guid) and that unit has a kit and the character's seat byte names a
//   VehicleSeat row (0x00756ec0), the row's VehicleAbilityDisplay (+0xa4, column 41) must be 1. No kit
//   or no row: the bit is set as for possession.
// - 0x00748810 (UNIT_ENTERING_VEHICLE 0x24b / UNIT_ENTERED_VEHICLE 0x24c, "%s%b%s%s%b%d"): unit, the
//   seat's CAN_CAST bit, the skin name (table 0x00ad8660 by UiSkin), a SoundEntries-like name by the
//   seat's EnterUISoundID (table 0x00ad4670, row +8), the seat's CAN_CONTROL bit, the Vehicle row's
//   VehicleUIIndicatorID (+0x90). No seat row: false, "", "", false. No vehicle row: 0.
// - 0x00749650/0x00749fb0: the passenger's state 0 (none), 1-2 (entering), 3 (seated), 4-5 (exiting)
//   picks the events — 0→3 and 3→3 (a seat switch) ENTERING then ENTERED, 3→0 EXITING then EXITED
//   ("%s%s": unit, a name by ExitUISoundID, 0x00749650), each for every unit token of the guid.
// - 0x0074ad70: VEHICLE_PASSENGERS_CHANGED (0x24f, no arguments) after a passenger of the character's
//   root vehicle enters, leaves or switches.
// - 0x0074ca90 (UnitSwitchToVehicleSeat's core): the virtual seat has a row, nobody in it (0x00757680),
//   CAN_SWITCH 0x04000000 on it and on the character's own seat (0x005fb560(0x04000000)).
// - 0x00613e10 (EjectPassengerFromSeat): the virtual seat of the active mover's root is occupied →
//   0x00757200(occupant); no EJECTABLE test at the Lua entry (the dropdown is offered only when
//   CanEjectPassengerFromSeat says so).
// - 0x005f9fe0 IsVehicleAimPowerAdjustable: the aimer of 0x005f9d20 (the vehicle the character drives,
//   else the character) has Vehicle Flags ADJUST_AIM_POWER 0x800; 0x005fb970 IsUsingVehicleControls:
//   the character's seat has IS_USING_VEHICLE_CONTROLS 0x00800000 (the mask pushed at 0x005fb979).
// - 0x0074c5a0 / 0x005fa910 (after VEHICLE_UPDATE 0x290, 0x00747f40): VEHICLE_ANGLE_SHOW 0x248 ("%d" 1
//   with ADJUST_AIM_ANGLE, else no argument), VEHICLE_POWER_SHOW 0x24a (1 with ADJUST_AIM_POWER), then
//   VEHICLE_ANGLE_UPDATE 0x249 ("%f%f": the pitch normalised over [PitchMin, PitchMax] with CUSTOM_PITCH
//   0x40, else over ±π/2 — 0x009f1ff4/0x009e8d88 — 0 when the span is under 1e-4, and the pitch).

import type { PetActionButton } from "./PetProtocol.js";
import type { VehicleCatalog, VehicleSeatEntry } from "./VehicleDbc.js";
import {
  VEHICLE_FLAGS, VEHICLE_SEAT_FLAGS, canEjectPassengerFromSeat, canSwitchVehicleSeats, isVehicleAimAngleAdjustable,
  rootVehicleGuid, unitVehicleGuid, unitVehicleSeat, vehicleOf, vehicleSkinName, vehicleVirtualSeats,
} from "./VehicleSeatModel.js";
import type { WorldObjectState } from "./WorldState.js";

type Objects = ReadonlyMap<bigint, WorldObjectState>;

/** VehicleSeat.VehicleAbilityDisplay that keeps a driven vehicle's bar on the main bar (0x005d4ad0: `== 1`). */
export const VEHICLE_ABILITY_DISPLAY_MAIN_BAR = 1;
/** VehicleSeatFlags IS_USING_VEHICLE_CONTROLS (DBCEnums.h:491), the mask of IsUsingVehicleControls. */
const IS_USING_VEHICLE_CONTROLS = 0x0080_0000;
/** 0x009f1ff4 / 0x009e8d88: the pitch span without CUSTOM_PITCH; 0x009e8cd0 the smallest span. */
const DEFAULT_PITCH_MIN = -Math.PI / 2;
const DEFAULT_PITCH_MAX = Math.PI / 2;
const PITCH_SPAN_EPSILON = 1e-4;

/** The bar a `SMSG_PET_SPELLS` left, as 0x005d4ad0 reads it. */
export interface VehicleBarSource {
  readonly guid: bigint;
  readonly closed: boolean;
  readonly bar: readonly PetActionButton[];
}

/**
 * 0x005d4ad0 for a vehicle's bar (`VehicleSpellInitialize`'s slot words): on the main bar when it is
 * the far sight unit's, the unit may carry a bar (`unitUsable`, 0x005d35b0) and — when the character
 * rides that unit and its seat has a row — the seat's VehicleAbilityDisplay is 1. Without the vehicle
 * tables nothing can be read: false, the answer before slice F2.
 */
export function vehicleBarOnMainBar(
  catalog: VehicleCatalog | undefined,
  objects: { get(guid: bigint): WorldObjectState | undefined },
  selfGuid: bigint | undefined,
  farSight: bigint | undefined,
  bar: VehicleBarSource | undefined,
  unitUsable: boolean,
): boolean {
  if (catalog === undefined) return false;
  if (farSight === undefined || farSight === 0n || bar === undefined || bar.closed || bar.guid !== farSight) return false;
  if (!unitUsable) return false;
  const self = selfGuid === undefined ? undefined : objects.get(selfGuid);
  const transport = self?.transport;
  if (transport === undefined || transport.guid !== bar.guid) return true;
  const seat = catalog.seatInSlot(objects.get(bar.guid)?.vehicleId, transport.seat);
  return seat === undefined || seat.vehicleAbilityDisplay === VEHICLE_ABILITY_DISPLAY_MAIN_BAR;
}

/** Where a unit in view sits: the vehicle (in view) and the seat byte; undefined when it rides none. */
export interface PassengerSeat {
  readonly vehicleGuid: bigint;
  readonly slot: number;
}

/** The unit's seat as the events follow it: its transport names a vehicle in view (`unitVehicleGuid`). */
export function passengerSeatOf(objects: Objects, guid: bigint | undefined): PassengerSeat | undefined {
  if (guid === undefined) return undefined;
  const vehicleGuid = unitVehicleGuid(objects, guid);
  const slot = objects.get(guid)?.transport?.seat;
  return vehicleGuid === undefined || slot === undefined ? undefined : { vehicleGuid, slot };
}

/** UNIT_ENTERING/ENTERED_VEHICLE's arguments after the unit (0x00748810). */
export type VehicleEnterArgs = readonly [showVehicleUI: boolean, skin: string, enterSound: string, canControl: boolean,
  indicatorId: number];

const NO_SEAT_ARGS = Object.freeze([false, "", "", false, 0] as const);

/**
 * 0x00748810's arguments for a seat: the seat row's CAN_CAST, skin and CAN_CONTROL, the vehicle row's
 * indicator. The sound name is "" — the SoundEntries name the seat's EnterUISoundID points at is not
 * served to this client (and no stock handler reads it).
 */
export function vehicleEnterArgs(seat: VehicleSeatEntry | undefined, indicatorId: number): VehicleEnterArgs {
  if (seat === undefined) return indicatorId === 0 ? NO_SEAT_ARGS : [false, "", "", false, indicatorId];
  return [
    (seat.flags & VEHICLE_SEAT_FLAGS.CAN_CAST) !== 0,
    vehicleSkinName(seat.uiSkin),
    "",
    (seat.flags & VEHICLE_SEAT_FLAGS.CAN_CONTROL) !== 0,
    indicatorId,
  ];
}

/** The arguments for a passenger in view: the immediate vehicle's seat row and indicator. */
export function passengerEnterArgs(catalog: VehicleCatalog, objects: Objects, seat: PassengerSeat): VehicleEnterArgs {
  const vehicleId = objects.get(seat.vehicleGuid)?.vehicleId;
  return vehicleEnterArgs(catalog.seatInSlot(vehicleId, seat.slot), catalog.vehicle(vehicleId)?.vehicleUIIndicatorId ?? 0);
}

/**
 * What VEHICLE_PASSENGERS_CHANGED follows: the root vehicle and who sits in which of its virtual seats —
 * "" while nobody does (a kit gained with no rider is no passenger's change), undefined when the
 * character has no root vehicle (its own exit is not announced: 0x0074ad70 compares the passenger's
 * root with the character's, which is gone). Read only when the world moved (it walks the objects).
 */
export function vehiclePassengersSignature(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined): string | undefined {
  if (selfGuid === undefined) return undefined;
  const root = rootVehicleGuid(catalog, objects, selfGuid);
  if (root === undefined || !vehicleOf(catalog, objects.get(root))) return undefined;
  let occupied = "";
  for (const seat of vehicleVirtualSeats(catalog, objects, root)) {
    if (seat.occupantGuid !== undefined) occupied += `|${seat.index}:${seat.occupantGuid.toString(16)}`;
  }
  return occupied === "" ? "" : root.toString(16) + occupied;
}

/** A virtual seat of the character's root vehicle: the vehicle that owns the slot, the slot and the occupant. */
export interface VirtualSeatTarget {
  readonly vehicleGuid: bigint;
  readonly slot: number;
  readonly occupantGuid: bigint | undefined;
}

function virtualSeatOf(catalog: VehicleCatalog, objects: Objects, fromGuid: bigint | undefined,
  index: number): (VirtualSeatTarget & { readonly seat: VehicleSeatEntry | undefined }) | undefined {
  if (fromGuid === undefined || !Number.isInteger(index) || index < 1) return undefined;
  const root = rootVehicleGuid(catalog, objects, fromGuid);
  if (root === undefined || !vehicleOf(catalog, objects.get(root))) return undefined;
  const seat = vehicleVirtualSeats(catalog, objects, root)[index - 1];
  return seat === undefined ? undefined
    : { vehicleGuid: seat.vehicleGuid, slot: seat.slot, occupantGuid: seat.occupantGuid, seat: seat.seat };
}

/**
 * `UnitSwitchToVehicleSeat("player", index)` (0x006139b0 → 0x0074ca90): the seat to ask for, or
 * undefined when Wow.exe sends nothing — the character is not seated, the seat has no row or is taken,
 * or either it or the character's own seat lacks CAN_SWITCH.
 */
export function switchableVehicleSeat(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined,
  index: number): VirtualSeatTarget | undefined {
  if (selfGuid === undefined || unitVehicleGuid(objects, selfGuid) === undefined) return undefined;
  const target = virtualSeatOf(catalog, objects, selfGuid, index);
  if (!target?.seat || target.occupantGuid !== undefined) return undefined;
  if ((target.seat.flags & VEHICLE_SEAT_FLAGS.CAN_SWITCH) === 0) return undefined;
  if (!canSwitchVehicleSeats(catalog, objects, selfGuid)) return undefined;
  return { vehicleGuid: target.vehicleGuid, slot: target.slot, occupantGuid: undefined };
}

/** `EjectPassengerFromSeat(index)` (0x00613e10): the passenger of that virtual seat of the mover's root. */
export function ejectableOccupant(catalog: VehicleCatalog, objects: Objects, moverGuid: bigint | undefined,
  index: number): bigint | undefined {
  return virtualSeatOf(catalog, objects, moverGuid, index)?.occupantGuid;
}

/**
 * `CanEjectPassengerFromSeat` for a passenger named by guid (the native bar lists passengers, not seat
 * numbers): its virtual seat of the character's root vehicle, through 0x00613d20's rule.
 */
export function canEjectPassenger(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined,
  passengerGuid: bigint): boolean {
  if (selfGuid === undefined) return false;
  const root = rootVehicleGuid(catalog, objects, selfGuid);
  if (root === undefined) return false;
  const seat = vehicleVirtualSeats(catalog, objects, root).find((candidate) => candidate.occupantGuid === passengerGuid);
  return seat !== undefined && canEjectPassengerFromSeat(catalog, objects, selfGuid, seat.index);
}

/** `IsUsingVehicleControls()` (0x005fb970): the character's seat has IS_USING_VEHICLE_CONTROLS. */
export function isUsingVehicleControls(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined): boolean {
  if (selfGuid === undefined) return false;
  const seated = unitVehicleSeat(catalog, objects, selfGuid);
  return seated !== undefined && (seated.seat.flags & IS_USING_VEHICLE_CONTROLS) !== 0;
}

/** The aimer of 0x005f9d20: the vehicle the character drives (seat CAN_CONTROL), else the character. */
function aimerOf(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint): bigint {
  const seated = unitVehicleSeat(catalog, objects, selfGuid);
  return seated && (seated.seat.flags & VEHICLE_SEAT_FLAGS.CAN_CONTROL) ? seated.vehicleGuid : selfGuid;
}

/** `IsVehicleAimPowerAdjustable()` (0x005f9fe0): the aimer's Vehicle Flags ADJUST_AIM_POWER 0x800. */
export function isVehicleAimPowerAdjustable(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined): boolean {
  if (selfGuid === undefined) return false;
  return ((vehicleOf(catalog, objects.get(aimerOf(catalog, objects, selfGuid)))?.flags ?? 0) & VEHICLE_FLAGS.ADJUST_AIM_POWER) !== 0;
}

/** Re-exported for the C API's one import site. */
export { isVehicleAimAngleAdjustable };

/** The events 0x0074c5a0/0x005fa910 raise for the active mover after VEHICLE_UPDATE, in order. */
export type VehicleAimEvent = readonly [event: string, ...args: unknown[]];

/**
 * 0x0074c5a0 for the active mover (undefined: none in view): VEHICLE_ANGLE_SHOW and VEHICLE_POWER_SHOW
 * with 1 for the mover's Vehicle Flags ADJUST_AIM_ANGLE / ADJUST_AIM_POWER and no argument otherwise,
 * then — for a mover with a vehicle row — VEHICLE_ANGLE_UPDATE(normalised pitch, pitch) (0x005fa910).
 * 0x0074ba40, which turns both SHOW events argument-less, is not read here (taken as false).
 */
export function vehicleAimEvents(catalog: VehicleCatalog, mover: WorldObjectState | undefined): VehicleAimEvent[] {
  const row = vehicleOf(catalog, mover);
  const flags = row?.flags ?? 0;
  const events: VehicleAimEvent[] = [];
  events.push(mover !== undefined && (flags & VEHICLE_FLAGS.ADJUST_AIM_ANGLE) !== 0 ? ["VEHICLE_ANGLE_SHOW", 1] : ["VEHICLE_ANGLE_SHOW"]);
  events.push(mover !== undefined && (flags & VEHICLE_FLAGS.ADJUST_AIM_POWER) !== 0 ? ["VEHICLE_POWER_SHOW", 1] : ["VEHICLE_POWER_SHOW"]);
  if (mover !== undefined && row !== undefined) {
    const pitch = mover.pitch ?? 0;
    const custom = (row.flags & VEHICLE_FLAGS.CUSTOM_PITCH) !== 0;
    const min = custom ? row.pitchMin : DEFAULT_PITCH_MIN;
    const max = custom ? row.pitchMax : DEFAULT_PITCH_MAX;
    const span = max - min;
    events.push(["VEHICLE_ANGLE_UPDATE", Math.abs(span) <= PITCH_SPAN_EPSILON ? 0 : (pitch - min) / span, pitch]);
  }
  return events;
}
