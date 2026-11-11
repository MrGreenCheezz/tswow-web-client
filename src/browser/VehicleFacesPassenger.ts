import type { VehicleSeatEntry } from "../world/VehicleDbc.js";
import { seatVehicleAnimation } from "./VehicleOwnAnimation.js";

/**
 * 11.11 (5.32): a vehicle turning to the passenger who boards it — Wow.exe 3.3.5a 12340's vehicle kit +0x160 (a guid)
 * and +0x168 (a key bone), which 0x00735f60 faces before the vehicle's channel object and target (world/UnitFacing.ts).
 * Read in `.runtime/re-2026-11-11/combat4` (capstone over Wow.exe; Ghidra 0x00735f60 in re-2026-10-11/glue-1110/mov-4.txt):
 *
 * - 0x0074be10 (boarding a seat, 0x0074be80 on): with Flags VEHICLE_SEAT_FLAG_REC_HAS_VEHICLE_ENTER_ANIM (0x400000) and a
 *   VehicleEnterAnim under 0x1fa that the vehicle's model has (0x00756f80), the vehicle plays it on VehicleEnterAnimBone
 *   (VehicleOwnAnimation.ts) and, when the seat's FlagsB has 0x800000, 0x00756db0 writes the passenger's guid at +0x160
 *   and the bone at +0x168 (0x23 and up read as the root, 0x1a), on the root of the seat chain (0x00757000).
 * - 0x00757280, the end of an animation on one of the vehicle's key bones (the model callback 0x0073c090 hands bone
 *   animations of a vehicle there), clears both when the bone is +0x168's (0x0075734e); the kit's reset clears the guid
 *   (0x00757949) and a new kit starts without one (0x007580c4).
 * - 0x00735f60 reads +0x160 when the unit is a vehicle (0x004f6210: its kit has a row); a guid not in view keeps the
 *   vehicle's own facing.
 *
 * Here the aim lasts while the boarding passenger's enter animation does: VehicleOwnAnimations reports its end (or that it
 * will not play) per passenger, not per bone, which differs from the original only while two passengers' animations on
 * one bone overlap.
 */

/** VehicleSeat.dbc FlagsB bit 0x00756db0's caller tests; unnamed in DBCEnums.h:505-517. */
export const SEAT_FLAG_B_VEHICLE_FACES_PASSENGER = 0x0080_0000;

type AimColumns = Pick<VehicleSeatEntry, "flags" | "flagsB" | "vehicleEnterAnim" | "vehicleExitAnim" | "vehicleRideAnimLoop"
  | "vehicleEnterAnimBone" | "vehicleExitAnimBone" | "vehicleRideAnimLoopBone" | "vehicleEnterAnimDelay" | "vehicleExitAnimDelay">;

/** Whether boarding this seat points the vehicle at its passenger (0x0074be10 → 0x00756db0). */
export function seatAimsVehicle(seat: AimColumns): boolean {
  return (seat.flagsB & SEAT_FLAG_B_VEHICLE_FACES_PASSENGER) !== 0 && seatVehicleAnimation(seat, "enter") !== undefined;
}

/** The vehicles that face a boarding passenger now, by the root vehicle's guid. */
export class VehicleAims {
  readonly #byVehicle = new Map<bigint, bigint>();

  get size(): number {
    return this.#byVehicle.size;
  }

  /** The passenger `vehicle` faces, or undefined. */
  of(vehicle: bigint): bigint | undefined {
    return this.#byVehicle.size === 0 ? undefined : this.#byVehicle.get(vehicle);
  }

  /** 0x00756db0: `passenger` boards `vehicle` through a seat that aims it (a later boarding takes the aim over). */
  aim(vehicle: bigint, passenger: bigint): void {
    this.#byVehicle.set(vehicle, passenger);
  }

  /** 0x00757280: `passenger`'s animation on `vehicle` is over or will not play. */
  ended(vehicle: bigint, passenger: bigint): void {
    if (this.#byVehicle.get(vehicle) === passenger) this.#byVehicle.delete(vehicle);
  }

  /** Drops the aim of a vehicle no longer drawn (its kit goes with the unit). */
  sweep(drawn: (guid: bigint) => boolean): void {
    for (const vehicle of this.#byVehicle.keys()) if (!drawn(vehicle)) this.#byVehicle.delete(vehicle);
  }
}
