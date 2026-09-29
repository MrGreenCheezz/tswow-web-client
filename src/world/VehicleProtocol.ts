import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import type { WorldState } from "./WorldState.js";

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
