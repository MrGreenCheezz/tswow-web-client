import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { writeMovementInfoBody, type MovementInfo } from "./MovementProtocol.js";
import { unitSeat } from "./UnitSeat.js";
import type { WorldObjectState, WorldState } from "./WorldState.js";

// Layouts follow the active TrinityCore source: Unit.cpp (`Mount`, `Dismount`),
// SpellAuraEffects.cpp `HandleAuraSetVehicle`, Player.cpp
// `SendOnCancelExpectedVehicleRideAura`, and VehicleHandler.cpp for everything the client sends.
//
// The inbound half of riding is two opcodes wide in this build, and both are small. What actually
// hands the steering over is `SMSG_CLIENT_CONTROL_UPDATE`, which slice P4 already handles, and the
// seat arithmetic is the transport math from the same slice. `SMSG_CONTROL_VEHICLE` does not exist
// here at all, and `SMSG_FORCE_SET_VEHICLE_REC_ID` is declared and never built — this core has no
// rec-id round trip, so a client must not wait on one.

export interface VehicleData {
  /** The unit that gained or lost a vehicle kit. Packed, unlike most guids in the pet family. */
  guid: bigint;
  /** A `Vehicle.dbc` id, or zero — and zero is the message, not a filler: it means "no longer one". */
  vehicleId: number;
}

/**
 * Sent when a mount installs a vehicle kit and again when it is taken away. The size hint at two
 * of the six build sites reserves room for a full guid and the code still writes a packed one, so
 * reading eight bytes there loses the packet.
 */
export function parsePlayerVehicleData(payload: Uint8Array): VehicleData {
  const reader = new PacketReader(payload);
  const guid = reader.packedGuid();
  const vehicleId = reader.u32();
  reader.assertFinished();
  return { guid, vehicleId };
}

/**
 * `SMSG_ON_CANCEL_EXPECTED_RIDE_VEHICLE_AURA` carries nothing at all — it is the server telling the
 * client to stop waiting for the aura that would have seated it. Answered rather than dropped.
 */
export function parseCancelExpectedRideVehicleAura(payload: Uint8Array): void {
  new PacketReader(payload).assertFinished();
}

/** Leaving the seat. The server reads nothing; a non-exitable seat is ignored in silence. */
export function buildRequestVehicleExit(): Uint8Array {
  return new Uint8Array(0);
}

/** Stepping through the seats. Both bodies are empty; the opcode is the direction. */
export function buildRequestVehiclePrevSeat(): Uint8Array {
  return new Uint8Array(0);
}

export function buildRequestVehicleNextSeat(): Uint8Array {
  return new Uint8Array(0);
}

/**
 * Moving to a named seat. Of the four opcodes that share the seat handler this is the only one
 * with a body but no movement block — prev and next carry nothing at all, and only
 * `CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE` carries movement. The seat index is signed and a
 * negative value is meaningful, so it goes out as a byte in two's complement rather than clamped.
 */
export function buildRequestVehicleSwitchSeat(vehicleGuid: bigint, seat: number): Uint8Array {
  if (seat < -128 || seat > 127) throw new RangeError(`Vehicle seat ${seat} does not fit in a signed byte`);
  return new PacketWriter().packedGuid(vehicleGuid).u8(seat & 0xff).toUint8Array();
}

/**
 * Climbing onto another player's vehicle. A full eight-byte guid here, deliberately unlike its
 * neighbours in the same handler file, which pack theirs.
 */
export function buildPlayerVehicleEnter(targetGuid: bigint): Uint8Array {
  return new PacketWriter().u64(targetGuid).toUint8Array();
}

/**
 * Throwing a passenger off. Only ever send the guid of somebody really seated: the server asserts
 * on a unit that passes its "is on this vehicle" test without having a seat.
 */
export function buildEjectPassenger(passengerGuid: bigint): Uint8Array {
  return new PacketWriter().u64(passengerGuid).toUint8Array();
}

// --- 11.02-B/C: a seat by click, and the driver's own way out and between seats. ---

/** `UNIT_NPC_FLAG_SPELLCLICK` (UnitDefines.h:261): personal — the core clears it for a receiver that may not click (Unit.cpp:14666-14672). */
export const UNIT_NPC_FLAG_SPELLCLICK = 0x0100_0000;
/** `UNIT_NPC_FLAG_PLAYER_VEHICLE` (UnitDefines.h:262): a player whose vehicle kit has a usable seat (Vehicle.cpp:63-66). */
export const UNIT_NPC_FLAG_PLAYER_VEHICLE = 0x0200_0000;

/**
 * `CMSG_SPELLCLICK`: the creature's whole guid (SpellHandler.cpp:589-603). The core checks nothing but
 * that the creature is in the world; `npc_spellclick_spells`, its conditions and the spell's own range
 * decide, and a refusal reaches the client only as the clicker's `SMSG_CAST_FAILED`.
 */
export function buildSpellClick(guid: bigint): Uint8Array {
  return new PacketWriter().u64(guid).toUint8Array();
}

/**
 * `CMSG_DISMISS_CONTROLLED_VEHICLE` (VehicleHandler.cpp:27-50): the driven vehicle's packed guid and its
 * MovementInfo. The core's only test is that the player charms something; it then writes the info to
 * the player and calls `ExitVehicle`. Wow.exe sends it from the vehicle's movement queue (event 0x34
 * of 0x006ef860, queued by 0x006ef540), so the info is the vehicle's own.
 */
export function buildDismissControlledVehicle(vehicleGuid: bigint, movement: MovementInfo): Uint8Array {
  return writeMovementInfoBody(new PacketWriter().packedGuid(vehicleGuid), movement).toUint8Array();
}

/**
 * `CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE` (VehicleHandler.cpp:80-108): the driven vehicle's packed guid,
 * its MovementInfo (stored on the vehicle, :88), a packed accessory guid and a signed seat. With no
 * accessory the seat is only a direction — `ChangeSeat(-1, seat > 0)`; with one, the core spell-clicks
 * that unit into the named seat (`HandleSpellClick(player, seat)`, :101-105). The seat is the index
 * 0…7 into `Vehicle.dbc` `SeatID[]` (Vehicle.cpp:50-60), never a `VehicleSeat.dbc` id.
 */
export function buildChangeSeatsOnControlledVehicle(vehicleGuid: bigint, movement: MovementInfo, accessoryGuid: bigint,
  seat: number): Uint8Array {
  if (!Number.isInteger(seat) || seat < -128 || seat > 127) throw new RangeError(`Vehicle seat ${seat} does not fit in a signed byte`);
  const writer = writeMovementInfoBody(new PacketWriter().packedGuid(vehicleGuid), movement);
  return writer.packedGuid(accessoryGuid).u8(seat & 0xff).toUint8Array();
}

/**
 * The vehicle this character drives: the unit the server handed it (`controlledGuid`) when the
 * character sits in that very unit. Wow.exe asks the same of the active mover — the character's
 * vehicle guid equals the mover's (0x0074c7f0, 0x0074c8b0, 0x0074ca90, 0x005d46f0) — before it sends
 * the driver's packets; a passenger, a possessed unit and a character moving itself are not driving.
 */
export function drivenVehicle(objects: ReadonlyMap<bigint, WorldObjectState>, selfGuid: bigint | undefined,
  controlledGuid: bigint | undefined): bigint | undefined {
  if (selfGuid === undefined || controlledGuid === undefined || controlledGuid === selfGuid) return undefined;
  return unitSeat(objects, objects.get(selfGuid))?.guid === controlledGuid ? controlledGuid : undefined;
}

/**
 * Who is riding this vehicle right now.
 *
 * VehicleJoinEvent sets `Passenger->m_movementInfo.transport.guid` for every seat. CHARMEDBY
 * identifies the controller on the vehicle base, and is absent for ordinary passengers. Use the
 * seat relationship that `HandleEjectPassenger` checks through `Unit::IsOnVehicle`.
 */
export function vehiclePassengers(state: WorldState, vehicleGuid: bigint): bigint[] {
  if (vehicleGuid === 0n) return [];
  const seated: bigint[] = [];
  for (const object of state.objects.values()) {
    if (object.typeId !== 3 && object.typeId !== 4) continue;
    if (object.transport?.guid === vehicleGuid) seated.push(object.guid);
  }
  return seated;
}
