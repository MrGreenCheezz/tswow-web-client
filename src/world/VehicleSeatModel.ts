// 11.02-F1: who sits where in a vehicle, and what each seat allows — the answers the stock vehicle UI
// asks the C API for (slice F2: UnitVehicleSeatInfo, CanExitVehicle, UnitVehicleSkin…), out of the
// vehicle tables (VehicleDbc.ts) and the objects in view. Pure: no DOM, no network, nothing kept.
//
// Read from Wow.exe 3.3.5a (Ghidra, read-only; .runtime/re-2026-10-03/l1102f1/r1-r3.c):
//
// - A unit is a vehicle when it carries a vehicle kit whose Vehicle.dbc row exists (unit+0xf5c, its
//   +0xc the row). Here: `object.vehicleId` (the create block's UPDATEFLAG_VEHICLE, or
//   SMSG_PLAYER_VEHICLE_DATA for a player) with a row in the catalog.
// - A unit rides a vehicle when its transport guid is a vehicle's or a player's (0x0074b8b0: high word
//   0xF?5????? — HighGuid::Vehicle — or a player guid, top nibble 0 and not empty). A creature carrier
//   with HighGuid::Unit (0xF130) is not a vehicle to the client, a ship or a lift never is.
// - The root vehicle (0x0074c650): from the unit, up the chain of carriers while the next carrier guid
//   is a vehicle's or a player's; the topmost one in view. A unit riding nothing is its own root if it
//   is a vehicle. A carrier out of view ends the walk with no root.
// - The virtual seats (0x00757550, counted by 0x00757470): slot 0…7 of the root in order; a slot whose
//   passenger is itself a vehicle and not a player (an accessory: the turret on a siege engine) is
//   replaced by that accessory's own seats, recursively; any other slot with a non-zero SeatID is one
//   seat, occupied or not. `UnitVehicleSeatInfo(unit, i)` takes i 1-based (0x006138c0 passes i − 1).
// - A seat's answers (0x007579e0): no row for its SeatID → nothing at all; controlType "None" unless
//   the seat has CAN_CONTROL, then "Root" when the seat is the root's own and "Child" when an
//   accessory's (strings 0x00ad6734/38/3c); the occupant is the first passenger of that vehicle whose
//   seat byte is the slot (0x00757680); ejectable = FlagsB EJECTABLE 0x20; canSwitchSeats = Flags
//   CAN_SWITCH 0x04000000.
// - The unit's own seat row (0x00613600): its transport guid passes the test above, the carrier is in
//   view with a kit, and the row is SeatID[seat byte]. UnitHasVehicleUI = Flags CAN_CAST 0x20000000
//   (0x00613740), UnitInVehicleControlSeat = CAN_CONTROL 0x800 (0x00613700), UnitTargetsVehicleInRaidUI
//   = FlagsB 0x8 (0x00613780), UnitVehicleSkin = UiSkin through the table at 0x00ad8660 (0x006137d0).
// - CanExitVehicle / CanSwitchVehicleSeats test the character's seat for CAN_ENTER_OR_EXIT 0x02000000
//   and CAN_SWITCH 0x04000000 (0x005fb9c0 and 0x005fba10 push the mask for 0x005fb560) — only those
//   bits: a driver's seat without CAN_ENTER_OR_EXIT cannot be left from the UI, although the core lets
//   it go (`CanEnterOrExit` also takes CAN_CONTROL, DBCStructure.h:1882).
//
// What the model cannot see the way Wow.exe does: the passenger's own state (unit+0xf60, 3 = seated,
// non-zero also while moving between seats) — here a passenger is seated from the moment its transport
// block names the vehicle; and the kit's passenger list — here every unit in view whose transport guid
// is the vehicle's, in the order the objects arrived.

import { UPDATE_FIELDS } from "../generated/updateFields.js";
import { MAX_VEHICLE_SEATS, type VehicleCatalog, type VehicleEntry, type VehicleSeatEntry } from "./VehicleDbc.js";
import type { WorldObjectState } from "./WorldState.js";

/** `VehicleSeatFlags`, DBCEnums.h:469-503. */
export const VEHICLE_SEAT_FLAGS = Object.freeze({
  HAS_LOWER_ANIM_FOR_ENTER: 0x0000_0001,
  HAS_LOWER_ANIM_FOR_RIDE: 0x0000_0002,
  SHOULD_USE_VEH_SEAT_EXIT_ANIM_ON_VOLUNTARY_EXIT: 0x0000_0008,
  HIDE_PASSENGER: 0x0000_0200,
  ALLOW_TURNING: 0x0000_0400,
  CAN_CONTROL: 0x0000_0800,
  CAN_CAST_MOUNT_SPELL: 0x0000_1000,
  UNCONTROLLED: 0x0000_2000,
  CAN_ATTACK: 0x0000_4000,
  SHOULD_USE_VEH_SEAT_EXIT_ANIM_ON_FORCED_EXIT: 0x0000_8000,
  HAS_VEH_EXIT_ANIM_VOLUNTARY_EXIT: 0x0004_0000,
  HAS_VEH_EXIT_ANIM_FORCED_EXIT: 0x0008_0000,
  PASSENGER_NOT_SELECTABLE: 0x0010_0000,
  REC_HAS_VEHICLE_ENTER_ANIM: 0x0040_0000,
  IS_USING_VEHICLE_CONTROLS: 0x0080_0000,
  ENABLE_VEHICLE_ZOOM: 0x0100_0000,
  CAN_ENTER_OR_EXIT: 0x0200_0000,
  CAN_SWITCH: 0x0400_0000,
  HAS_START_WAITING_FOR_VEH_TRANSITION_ANIM_ENTER: 0x0800_0000,
  HAS_START_WAITING_FOR_VEH_TRANSITION_ANIM_EXIT: 0x1000_0000,
  CAN_CAST: 0x2000_0000,
  UNK2: 0x4000_0000,
  ALLOWS_INTERACTION: 0x8000_0000,
});

/** `VehicleSeatFlagsB`, DBCEnums.h:505-517. */
export const VEHICLE_SEAT_FLAGS_B = Object.freeze({
  USABLE_FORCED: 0x0000_0002,
  TARGETS_IN_RAIDUI: 0x0000_0008,
  EJECTABLE: 0x0000_0020,
  USABLE_FORCED_2: 0x0000_0040,
  USABLE_FORCED_3: 0x0000_0100,
  KEEP_PET: 0x0002_0000,
  USABLE_FORCED_4: 0x0200_0000,
  CAN_SWITCH: 0x0400_0000,
  VEHICLE_PLAYERFRAME_UI: 0x8000_0000,
});

/** `VehicleFlags`, VehicleDefines.h:38-49 (slice F3 wires the movement ones). */
export const VEHICLE_FLAGS = Object.freeze({
  NO_STRAFE: 0x0000_0001,
  NO_JUMPING: 0x0000_0002,
  FULLSPEEDTURNING: 0x0000_0004,
  ALLOW_PITCHING: 0x0000_0010,
  FULLSPEEDPITCHING: 0x0000_0020,
  CUSTOM_PITCH: 0x0000_0040,
  ADJUST_AIM_ANGLE: 0x0000_0400,
  ADJUST_AIM_POWER: 0x0000_0800,
  FIXED_POSITION: 0x0020_0000,
});

/** `UnitVehicleSeatInfo`'s first value. */
export type VehicleSeatControlType = "None" | "Root" | "Child";

type Objects = ReadonlyMap<bigint, WorldObjectState>;

const TYPEID_UNIT = 3;
const TYPEID_PLAYER = 4;
/** A chain longer than this is a stale loop in the objects, not a vehicle. */
const MAX_CHAIN = 16;
const CHARM = UPDATE_FIELDS.UNIT_FIELD_CHARM.offset;

/**
 * Wow.exe 0x0074b8b0: a transport guid that names a vehicle — HighGuid::Vehicle (0xF150…) or a player
 * (top nibble 0, not empty). Ships (0x1FC…), lifts and creatures of HighGuid::Unit (0xF130…) are not.
 */
export function isVehicleCarrierGuid(guid: bigint): boolean {
  const high = Number((guid >> 32n) & 0xffff_ffffn);
  if (((high & 0xf0f0_0000) >>> 0) === 0xf050_0000) return true;
  if ((high & 0xf000_0000) !== 0) return false;
  return (guid & 0xffff_ffffn) !== 0n || (high & 0xf07f_ffff) !== 0;
}

/** The unit's vehicle kit: its Vehicle.dbc row, when it is a vehicle the catalog knows. */
export function vehicleOf(catalog: VehicleCatalog, object: WorldObjectState | undefined): VehicleEntry | undefined {
  return object?.vehicleId ? catalog.vehicle(object.vehicleId) : undefined;
}

/**
 * Wow.exe 0x0074c650 without a target: the topmost vehicle above `guid` (see the header), or the
 * unit itself when it rides nothing and is a vehicle; undefined otherwise. The topmost carrier is
 * returned whether or not it is a vehicle the catalog knows — the callers test that, as Wow.exe's do.
 */
export function rootVehicleGuid(catalog: VehicleCatalog, objects: Objects, guid: bigint): bigint | undefined {
  const unit = objects.get(guid);
  if (!unit) return undefined;
  const first = unit.transport?.guid ?? 0n;
  if (!isVehicleCarrierGuid(first)) return vehicleOf(catalog, unit) ? guid : undefined;
  let current = objects.get(first);
  for (let depth = 0; current && depth < MAX_CHAIN; depth++) {
    const next = current.transport?.guid ?? 0n;
    if (!isVehicleCarrierGuid(next)) return current.guid;
    current = objects.get(next);
  }
  return undefined;
}

/**
 * Wow.exe 0x0074c650 with a target: whether `target` is `from` itself (as a vehicle) or one of the
 * carriers above it — "the passenger rides on me". CanEjectPassengerFromSeat asks it.
 */
export function ridesOn(catalog: VehicleCatalog, objects: Objects, from: bigint, target: bigint): boolean {
  const unit = objects.get(from);
  if (!unit) return false;
  if (from === target && vehicleOf(catalog, unit)) return true;
  const first = unit.transport?.guid ?? 0n;
  if (!isVehicleCarrierGuid(first)) return false;
  let current = objects.get(first);
  for (let depth = 0; current && depth < MAX_CHAIN; depth++) {
    if (current.guid === target) return true;
    const next = current.transport?.guid ?? 0n;
    if (!isVehicleCarrierGuid(next)) return false;
    current = objects.get(next);
  }
  return false;
}

/** Units in view riding each carrier, in the order the objects arrived. */
function passengersByCarrier(objects: Objects): Map<bigint, WorldObjectState[]> {
  const riders = new Map<bigint, WorldObjectState[]>();
  for (const object of objects.values()) {
    if (object.typeId !== TYPEID_UNIT && object.typeId !== TYPEID_PLAYER) continue;
    const carrier = object.transport?.guid;
    if (carrier === undefined || carrier === 0n) continue;
    let list = riders.get(carrier);
    if (!list) riders.set(carrier, list = []);
    list.push(object);
  }
  return riders;
}

/** One seat of a vehicle as the stock UI numbers them. */
export interface VirtualSeat {
  /** 1-based, `UnitVehicleSeatInfo(unit, index)`. */
  readonly index: number;
  /** The vehicle whose slot this is: the root, or an accessory on it. */
  readonly vehicleGuid: bigint;
  /** 0…7 in that vehicle's Vehicle.dbc SeatID[] — the seat byte of the transport block. */
  readonly slot: number;
  /** Undefined when the SeatID names no VehicleSeat row: the seat is counted but answers nothing. */
  readonly seat: VehicleSeatEntry | undefined;
  /** The passenger in it: the first unit in view riding that vehicle with that seat byte. */
  readonly occupantGuid: bigint | undefined;
}

/**
 * Wow.exe 0x00757550 / 0x00757470: every seat of the vehicle `rootGuid`, accessories expanded in
 * place, in the order `UnitVehicleSeatInfo` numbers them; empty when it is not a vehicle the catalog
 * knows. `UnitVehicleSeatCount` is the length.
 */
export function vehicleVirtualSeats(catalog: VehicleCatalog, objects: Objects, rootGuid: bigint): VirtualSeat[] {
  const seats: VirtualSeat[] = [];
  const riders = passengersByCarrier(objects);
  const visited = new Set<bigint>();
  const walk = (vehicleGuid: bigint): void => {
    const vehicle = vehicleOf(catalog, objects.get(vehicleGuid));
    if (!vehicle || visited.has(vehicleGuid)) return;
    visited.add(vehicleGuid);
    const passengers = riders.get(vehicleGuid) ?? [];
    // A later accessory claiming the same slot replaces an earlier one, as the slot array is filled.
    const accessories = new Array<bigint | undefined>(MAX_VEHICLE_SEATS);
    for (const passenger of passengers) {
      const slot = passenger.transport!.seat;
      if (passenger.typeId === TYPEID_PLAYER || !vehicleOf(catalog, passenger)) continue;
      if (Number.isInteger(slot) && slot >= 0 && slot < MAX_VEHICLE_SEATS) accessories[slot] = passenger.guid;
    }
    for (let slot = 0; slot < MAX_VEHICLE_SEATS; slot++) {
      const accessory = accessories[slot];
      if (accessory !== undefined) {
        walk(accessory);
        continue;
      }
      if (!(vehicle.seatIds[slot]! > 0)) continue;
      const occupant = passengers.find((passenger) => passenger.transport!.seat === slot);
      seats.push(Object.freeze({
        index: seats.length + 1,
        vehicleGuid,
        slot,
        seat: catalog.seat(vehicle.seatIds[slot]),
        occupantGuid: occupant?.guid,
      }));
    }
  };
  walk(rootGuid);
  return seats;
}

export interface VehicleSeatInfo {
  readonly controlType: VehicleSeatControlType;
  /** F2 turns it into `occupantName, serverName` (the unit's name, a player's realm). */
  readonly occupantGuid: bigint | undefined;
  readonly ejectable: boolean;
  readonly canSwitchSeats: boolean;
}

/** Wow.exe 0x007579e0 for one virtual seat; undefined when its SeatID names no row (Lua gets nothing). */
export function virtualSeatInfo(seat: VirtualSeat | undefined, rootGuid: bigint): VehicleSeatInfo | undefined {
  const row = seat?.seat;
  if (!seat || !row) return undefined;
  let controlType: VehicleSeatControlType = "None";
  if (row.flags & VEHICLE_SEAT_FLAGS.CAN_CONTROL) controlType = seat.vehicleGuid === rootGuid ? "Root" : "Child";
  return {
    controlType,
    occupantGuid: seat.occupantGuid,
    ejectable: (row.flagsB & VEHICLE_SEAT_FLAGS_B.EJECTABLE) !== 0,
    canSwitchSeats: (row.flags & VEHICLE_SEAT_FLAGS.CAN_SWITCH) !== 0,
  };
}

/**
 * `UnitVehicleSeatInfo(unit, index)` (0x006138c0): the `index`-th (1-based) seat of the root vehicle
 * above `unitGuid` — the unit's own vehicle, or the unit if it is one. Undefined: no root, the root is
 * no vehicle the catalog knows, no such seat, or a seat without a row.
 */
export function unitVehicleSeatInfo(catalog: VehicleCatalog, objects: Objects, unitGuid: bigint,
  index: number): VehicleSeatInfo | undefined {
  const root = rootVehicleGuid(catalog, objects, unitGuid);
  if (root === undefined || !Number.isInteger(index) || index < 1) return undefined;
  return virtualSeatInfo(vehicleVirtualSeats(catalog, objects, root)[index - 1], root);
}

/** `UnitVehicleSeatCount(unit)` (0x00613830): the root's virtual seats; 0 without one. */
export function unitVehicleSeatCount(catalog: VehicleCatalog, objects: Objects, unitGuid: bigint): number {
  const root = rootVehicleGuid(catalog, objects, unitGuid);
  return root === undefined ? 0 : vehicleVirtualSeats(catalog, objects, root).length;
}

/** The 1-based virtual seat of `slot` in `vehicleGuid` among `seats`; undefined when not among them. */
export function virtualSeatIndexOf(seats: readonly VirtualSeat[], vehicleGuid: bigint, slot: number): number | undefined {
  return seats.find((seat) => seat.vehicleGuid === vehicleGuid && seat.slot === slot)?.index;
}

/** Where a unit in view sits: the vehicle, the slot 0…7 and its VehicleSeat row. */
export interface UnitVehicleSeat {
  readonly vehicleGuid: bigint;
  readonly slot: number;
  readonly seat: VehicleSeatEntry;
}

/**
 * Wow.exe 0x00613600 for a unit in view: the seat it occupies — its transport guid names a vehicle
 * (0x0074b8b0), the vehicle is in view with a row, and its SeatID[seat byte] has a row. A party
 * member out of view is answered from SMSG_PARTY_MEMBER_STATS' VehicleSeat id instead (+0x308 of the
 * party record), which F2 looks up with `catalog.seat(id)`.
 */
export function unitVehicleSeat(catalog: VehicleCatalog, objects: Objects, unitGuid: bigint): UnitVehicleSeat | undefined {
  const transport = objects.get(unitGuid)?.transport;
  if (!transport || !isVehicleCarrierGuid(transport.guid)) return undefined;
  const seat = catalog.seatInSlot(objects.get(transport.guid)?.vehicleId, transport.seat);
  return seat ? { vehicleGuid: transport.guid, slot: transport.seat, seat } : undefined;
}

/**
 * The vehicle a unit in view is attached to: its transport guid names a vehicle (0x0074b8b0) that is
 * in view. Wow.exe asks the passenger state instead (unit+0xf60; `UnitInVehicle` wants 3 = seated,
 * `UnitUsingVehicle` any non-zero state, 0x006133d0/0x006134a0), which has no counterpart here: both
 * are this.
 */
export function unitVehicleGuid(objects: Objects, unitGuid: bigint): bigint | undefined {
  const carrier = objects.get(unitGuid)?.transport?.guid;
  return carrier !== undefined && isVehicleCarrierGuid(carrier) && objects.has(carrier) ? carrier : undefined;
}

/**
 * `UnitControllingVehicle(unit)` (0x00613570): seated, and its UNIT_FIELD_CHARM (the first unit word,
 * unit+0xd0) is the vehicle it rides — the core makes the driver the vehicle's charmer
 * (`Unit::SetCharmedBy`, CHARM_TYPE_VEHICLE).
 */
export function unitControllingVehicle(objects: Objects, unitGuid: bigint): boolean {
  const vehicle = unitVehicleGuid(objects, unitGuid);
  const unit = objects.get(unitGuid);
  if (vehicle === undefined || !unit) return false;
  const low = unit.fields.get(CHARM) ?? 0;
  const high = unit.fields.get(CHARM + 1) ?? 0;
  return BigInt(low >>> 0) + (BigInt(high >>> 0) << 32n) === vehicle;
}

/** The character's seat has a bit of `mask` (0x005fb560 tests `Flags & mask`; every caller passes one bit). */
function characterSeatHas(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined, mask: number): boolean {
  if (selfGuid === undefined) return false;
  const seated = unitVehicleSeat(catalog, objects, selfGuid);
  return seated !== undefined && (seated.seat.flags & mask) !== 0;
}

/** `CanExitVehicle()`: the character's seat has CAN_ENTER_OR_EXIT (0x005fb9c0 → 0x005fb560(0x02000000)). */
export function canExitVehicle(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined): boolean {
  return characterSeatHas(catalog, objects, selfGuid, VEHICLE_SEAT_FLAGS.CAN_ENTER_OR_EXIT);
}

/**
 * `CanSwitchVehicleSeats()` (0x005fba10) and `CanSwitchVehicleSeat()` (0x00608580, which also needs
 * the input controller every world has): the character's seat has CAN_SWITCH.
 */
export function canSwitchVehicleSeats(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined): boolean {
  return characterSeatHas(catalog, objects, selfGuid, VEHICLE_SEAT_FLAGS.CAN_SWITCH);
}

/**
 * `CanEjectPassengerFromSeat(index)` (0x00613d20): the `index`-th seat of the character's root vehicle
 * is occupied, the character is that passenger's vehicle or above it (a player vehicle — a mammoth, a
 * motorcycle — ejects its own riders), and the seat is EJECTABLE (FlagsB 0x20).
 */
export function canEjectPassengerFromSeat(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined,
  index: number): boolean {
  if (selfGuid === undefined || !Number.isInteger(index) || index < 1) return false;
  const root = rootVehicleGuid(catalog, objects, selfGuid);
  if (root === undefined || !vehicleOf(catalog, objects.get(root))) return false;
  const seat = vehicleVirtualSeats(catalog, objects, root)[index - 1];
  if (!seat?.seat || seat.occupantGuid === undefined) return false;
  if (!ridesOn(catalog, objects, seat.occupantGuid, selfGuid)) return false;
  return (seat.seat.flagsB & VEHICLE_SEAT_FLAGS_B.EJECTABLE) !== 0;
}

/**
 * `IsVehicleAimAngleAdjustable()` (0x005f9f70 over 0x005f9d20): the vehicle the character drives (its
 * seat has CAN_CONTROL), otherwise the character itself, has Vehicle.dbc Flags ADJUST_AIM_ANGLE 0x400.
 */
export function isVehicleAimAngleAdjustable(catalog: VehicleCatalog, objects: Objects, selfGuid: bigint | undefined): boolean {
  if (selfGuid === undefined) return false;
  const seated = unitVehicleSeat(catalog, objects, selfGuid);
  const aimer = seated && (seated.seat.flags & VEHICLE_SEAT_FLAGS.CAN_CONTROL) ? seated.vehicleGuid : selfGuid;
  return ((vehicleOf(catalog, objects.get(aimer))?.flags ?? 0) & VEHICLE_FLAGS.ADJUST_AIM_ANGLE) !== 0;
}

/**
 * `UnitVehicleSkin` and the skin of UNIT_ENTERING/ENTERED_VEHICLE (0x006137d0, 0x00748810): VehicleSeat
 * UiSkin through Wow.exe's two-entry table at 0x00ad8660 — 0 "Natural", 1 "Mechanical", anything else
 * (the -1 of four seats) an empty string, which VehicleMenuBar_SetSkin draws as "Mechanical".
 */
export function vehicleSkinName(uiSkin: number): string {
  if (uiSkin === 0) return "Natural";
  if (uiSkin === 1) return "Mechanical";
  return "";
}
