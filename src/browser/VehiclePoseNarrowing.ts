import type { UnitActionDisplay, UnitActionLayer } from "./UnitActionArbiter.js";

/**
 * 11.02 (15.11, vehicle9): the narrowing of a vehicle's own pose while it casts — Wow.exe 3.3.5a's base-animation chooser
 * 0x00724500 (.runtime/re-2026-11-15/vehicle8/b2.c), its test 0x00756f40 and the cast rung 0x00724330 with what that reads
 * (0x007224d0, 0x007172b0, 0x00715af0: .runtime/re-2026-11-15/vehicle9/c1.c, c2.c).
 *
 * - 0x00756f40: the unit's own vehicle (+0xf5c) has a Vehicle row with Flags 0x10000 (12 of the dataset's 412 rows), and the
 *   unit has a precast animation on (+0xa38 bit 0x400, set by 0x00715af0(1) from the cast visual's start 0x007fa2e0 when the
 *   spell's PrecastKit names an animation, cleared when the cast visual ends, 0x0072ed80) or a kit animation played with
 *   flag 0x80 (+0xfa4 ≠ −1, 0x0073b140; back to −1 when it ends, 0x0073bbd0).
 * - Then 0x00724500 asks 0x00724330 alone and skips every other rung — the movement, jump, stand-state, stance and emote
 *   rungs and the final Stand (0x0071e340). 0x00724330 answers only the cast's own animation (0x007224d0: the cast bar's
 *   spell's PrecastKit StartAnimID or AnimID, nothing while +0xfa4 holds), and otherwise 0x1fa, "no change", which
 *   0x0073ac30 leaves as it is. So while either mark holds, nothing the unit does — setting off, running, stopping — takes
 *   the precast or kit animation off the whole body. Once the mark drops, the next base choice is the ordinary chain: Run
 *   while it moves, Stand when it stands.
 *
 * Here the cast layer's held entry (UnitActionArbiter.ts, a precast pose for the cast's time) stands for +0xa38 0x400, and
 * the unit's channel field tells a channel's hold (ChannelKit, which 0x007fa2e0 never marks) apart from it. The flag-0x80 kit
 * mark is not carried by this client's kit plan and is left out.
 */

/** Vehicle Flags bit 0x00756f40 tests. */
export const VEHICLE_FLAG_CAST_POSE_ONLY = 0x0001_0000;

/** 0x00756f40 for the vehicle half: the unit's own Vehicle row narrows its pose while a cast mark holds. */
export function vehicleNarrowsPose(vehicleFlags: number | undefined): boolean {
  return vehicleFlags !== undefined && (vehicleFlags & VEHICLE_FLAG_CAST_POSE_ONLY) !== 0;
}

/**
 * Where the top request of such a vehicle is drawn: a held cast-layer pose that is a precast (not a channel's) takes the
 * whole body over any base, moving or not (0x00724500 → 0x00724330 only); everything else as the ordinary choice said.
 */
export function narrowedActionDisplay(display: UnitActionDisplay, narrows: boolean, layer: UnitActionLayer, held: boolean,
  channelling: boolean): UnitActionDisplay {
  return narrows && layer === "cast" && held && !channelling ? "full" : display;
}
