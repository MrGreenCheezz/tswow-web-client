import type { VehicleSeatEntry } from "../world/VehicleDbc.js";

/**
 * 11.02 (15.11): VehicleSeat FlagsB 0x10000 — the passenger plays what its vehicle plays. Read from Wow.exe 3.3.5a 12340
 * (.runtime/re-2026-11-11/transport/t1.lst, t2.c; .runtime/re-2026-11-11/vehicle2/v1.c, v2.c):
 *
 * - On reaching such a seat (0x007489c0, state 3 → 0x00748620) the passenger gets passenger+0x10 bit 0x800 and its model is
 *   set to the vehicle model's current animation (0x008266b0 on the vehicle's model, 0x00832ab0 on the passenger's), whole
 *   model and each key bone. The copy is redone when either model finishes loading (0x0073e840 → 0x00757e70 / 0x00748620).
 * - 0x007487e0 is "bit 0x800 and the passenger alive" (its UNIT_FIELD_HEALTH above 0). While it holds, every animation
 *   setter of the passenger's own returns without playing unless called forced (0x00735820, 0x00735a60, 0x00735cc0,
 *   0x00735bb0, 0x00735dd0; 0x007385c0 and 0x00738440 skip their split-track call), and every animation the vehicle's
 *   model starts — whole model 0x00735820 or key bone 0x00735a60 — is started forced on each such passenger's model with
 *   the same arguments. The model is the vehicle's seat model (vtable +0xd4: the mount's when it is mounted).
 *
 * The dataset has four such seats: 2903 and 2906 (Vehicle 328), 2963 (Vehicle 332), 3886 (Vehicle 370).
 *
 * Here: the vehicle's whole-model animation, started on the passenger when the vehicle starts one and on taking the seat.
 * Not modelled: the variation (Wow.exe passes the vehicle's when the passenger's model has that many, 0x008262f0) — the
 * passenger draws its own; and the key-bone copies (VehicleOwnAnimation.ts plays those on the vehicle only).
 */

/** VehicleSeat FlagsB 0x10000: the passenger mirrors the vehicle's animations (0x00748620). */
export const SEAT_FLAG_B_COPIES_VEHICLE_ANIMATION = 0x0001_0000;

/** Whether a passenger seated here (state 3) plays its vehicle's animations instead of its own (0x007487e0). */
export function seatCopiesVehicleAnimation(seat: Pick<VehicleSeatEntry, "flagsB"> | undefined, alive: boolean): boolean {
  return alive && seat !== undefined && (seat.flagsB & SEAT_FLAG_B_COPIES_VEHICLE_ANIMATION) !== 0;
}

/** What the vehicle's seat model is playing: the animation, whether it loops, and the start it came from. */
export interface VehicleAnimationShown {
  readonly animation: number | undefined;
  readonly loop: boolean;
  /** The vehicle's model instance: a rebuilt model is a load, which copies again (0x0073e840 → 0x00757e70). */
  readonly model: unknown;
  /** How many times the vehicle's model has started its whole-model animation: a restart of the same one counts. */
  readonly starts: number;
}

interface Given {
  vehicle: bigint;
  model: unknown;
  starts: number;
  animation: number;
  /** The passenger's own model instance: a rebuilt one copies again (0x0073e840 → 0x00748620). */
  own: unknown;
}

/** Per passenger: which of its vehicle's starts it has already been given. */
export class VehicleAnimationCopies {
  readonly #given = new Map<bigint, Given>();

  /**
   * This frame's start for a copying passenger: the vehicle's animation when it has started one the passenger was not given
   * yet, or the passenger has just taken the seat or its model was rebuilt; else undefined. `given` follows once the
   * passenger plays it (or cannot: a model with no such clip and no stand-in).
   */
  next(passenger: bigint, vehicle: bigint, shown: VehicleAnimationShown, own: unknown): { readonly animation: number; readonly loop: boolean } | undefined {
    if (shown.animation === undefined) return undefined;
    const known = this.#given.get(passenger);
    if (known !== undefined && known.vehicle === vehicle && known.model === shown.model && known.starts === shown.starts
      && known.animation === shown.animation && known.own === own) return undefined;
    return { animation: shown.animation, loop: shown.loop };
  }

  /** The passenger has been given this start of the vehicle's. */
  given(passenger: bigint, vehicle: bigint, shown: VehicleAnimationShown, own: unknown): void {
    if (shown.animation === undefined) return;
    this.#given.set(passenger, { vehicle, model: shown.model, starts: shown.starts, animation: shown.animation, own });
  }

  /** The passenger left such a seat (or died): the next one copies afresh. */
  forget(passenger: bigint): void {
    this.#given.delete(passenger);
  }

  get size(): number {
    return this.#given.size;
  }

  /** Drops the passengers no longer drawn: back in view, they copy afresh, as on a model load. */
  sweep(drawn: (guid: bigint) => boolean): void {
    for (const passenger of this.#given.keys()) if (!drawn(passenger)) this.#given.delete(passenger);
  }

  has(passenger: bigint): boolean {
    return this.#given.size > 0 && this.#given.has(passenger);
  }

  clear(): void {
    this.#given.clear();
  }
}
