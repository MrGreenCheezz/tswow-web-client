// 15.11 (6.11): a new unit fades in as Wow.exe 3.3.5a 12340 fades it (Ghidra read-only, .runtime/re-2026-11-15/fx7/r4–r8):
//
// - The object constructor 0x00745e60 leaves the model-alpha byte +0xc8 at 0 (and the other factor +0xcb at 255).
// - The unit's creation 0x0073fcc0 calls 0x00744a50: 0x00744030 walks the byte to CreatureModelAlpha over 1000 ms when
//   vfunc +0xe4 (0x00716650, the same slot in both unit vtables) answers true, else sets it at once (time 0). The walk
//   is 0x0071ac30's: from + trunc((to − from) · elapsed / time) in whole bytes, so the shown alpha is trunc(T·t/1000)/255
//   for a target byte T.
// - 0x00716650 answers false — no fade, the model is there at once — for UNIT_FIELD_FLAGS_2 0x20
//   (UNIT_FLAG2_DO_NOT_FADE_IN), UNIT_FIELD_FLAGS 0x2 (UNIT_FLAG_NON_ATTACKABLE, the core's old UNIT_FLAG_SPAWNING) and
//   UNIT_FIELD_BYTES_1 byte 2 & 0x2 (UNIT_VIS_FLAGS_CREEP, stealth). Descriptor offsets +0xd8, +0xd4, +0x112 from the
//   unit fields' start, checked against DISPLAYID +0xf4, MOUNTDISPLAYID +0xfc, HEALTH +0x48 read by the same code.
// - A passenger (0x0074b8b0: the guid at unit +0x790 is a vehicle's, high 0xF?5?, or a player's, high nibble 0) asks its
//   carrier: carrier not here → no fade; the seat says fade → the fade; carrier itself walking its byte (+0xc4 ≠ 0) → no
//   fade; else the fade. Here +0x790 is taken as the unit's transport guid.
//   15.11 (vehicle8, .runtime/re-2026-11-15/vehicle8/b1.c): the seat test is 0x005d3340 on the carrier with the
//   passenger's seat byte (+0x7d2): the carrier's vehicle (+0xf5c) row for that slot (0x00756ec0), whose AttachmentID
//   (row +8) below 0 — a seat with no attachment point, 27 of the dataset's 720 — gives the fade even while the carrier
//   is fading itself. A carrier with no vehicle row answers nothing here and the carrier's byte decides.
// - What restarts it: only creation (0x0073fcc0; and the re-setup 0x00734fd0 → 0x00744d20 zeroes the byte again for an
//   object that is set up anew). A new model for a shown unit (0x0073e410 → 0x0071abe0) walks only to a new
//   CreatureModelAlpha (UnitDisplayFade.ts) and is taken at once when the byte already matches.
//
// This client's clock for it starts on the first frame the unit can be drawn (`RenderedUnit.admittedAt`, moved on by the
// warm hold): Wow.exe's starts at creation, with its model read from local archives in the same moment; here a model
// streams from the gateway, and a clock started at creation would be spent before the first pixel.

import { displayAlphaFading, displayAlphaTargetByte } from "./UnitDisplayFade.js";
import { readField, unit as unitFields } from "../world/Fields.js";
import type { WorldObjectState } from "../world/WorldState.js";

/** 0x00744a50: the fade-in's time. */
export const UNIT_SPAWN_FADE_MS = 1000;
/** UnitDefines.h UNIT_FLAG_NON_ATTACKABLE (UNIT_FIELD_FLAGS). */
export const UNIT_FLAG_NON_ATTACKABLE = 0x2;
/** UnitDefines.h UNIT_FLAG2_DO_NOT_FADE_IN (UNIT_FIELD_FLAGS_2). */
export const UNIT_FLAG2_DO_NOT_FADE_IN = 0x20;
/** UnitDefines.h UNIT_VIS_FLAGS_CREEP (UNIT_FIELD_BYTES_1 byte 2). */
const UNIT_VIS_FLAGS_CREEP = 0x2;

/** 0x0074b8b0: whether `guid` is a carrier a passenger asks — a vehicle (high 0xF?5?) or a player (high nibble 0). */
export function carrierGuid(guid: bigint | undefined): boolean {
  if (guid === undefined || guid === 0n) return false;
  const hi = Number((guid >> 32n) & 0xffffffffn);
  const lo = Number(guid & 0xffffffffn);
  if (((hi & 0xf0f00000) >>> 0) === 0xf0500000) return true;
  return (hi & 0xf0000000) === 0 && !(lo === 0 && (hi & 0xf07fffff) === 0);
}

export interface SpawnFadeQuestion {
  flags?: number | undefined;
  flags2?: number | undefined;
  visFlags?: number | undefined;
  /**
   * Set for a passenger: whether its carrier is here, whether that carrier's own byte is walking, and (15.11, vehicle8)
   * the AttachmentID of the carrier's seat row the passenger sits in, undefined without one (0x005d3340).
   */
  carrier?: { present: boolean; fading: boolean; seatAttachment?: number | undefined } | undefined;
}

/** 0x00716650: whether a new unit fades in. */
export function unitFadesIn(question: SpawnFadeQuestion): boolean {
  if (((question.flags2 ?? 0) & UNIT_FLAG2_DO_NOT_FADE_IN) !== 0) return false;
  if (((question.flags ?? 0) & UNIT_FLAG_NON_ATTACKABLE) !== 0) return false;
  if (((question.visFlags ?? 0) & UNIT_VIS_FLAGS_CREEP) !== 0) return false;
  const carrier = question.carrier;
  if (carrier !== undefined) {
    if (!carrier.present) return false;
    if (carrier.seatAttachment !== undefined && carrier.seatAttachment < 0) return true; // 15.11 (vehicle8): 0x005d3340
    return !carrier.fading;
  }
  return true;
}

/**
 * 0x00716650 asked of a unit's wire state; `carrier` answers for the unit its transport guid names (a passenger's
 * vehicle or player), undefined when that unit is not here; `seatAttachment` (15.11, vehicle8) is the AttachmentID of
 * that carrier's seat row for the passenger's slot, undefined when the carrier has no vehicle row.
 */
export function unitFadesInFrom(object: WorldObjectState,
  carrier: (guid: bigint) => { fading: boolean; seatAttachment?: number | undefined } | undefined): boolean {
  const guid = object.transport?.guid;
  const passenger = carrierGuid(guid);
  const found = passenger ? carrier(guid!) : undefined;
  return unitFadesIn({
    flags: unitFields.flags(object),
    flags2: readField(object, "UNIT_FIELD_FLAGS_2"),
    visFlags: unitFields.visFlags(object),
    ...(passenger ? { carrier: { present: found !== undefined, fading: found?.fading === true, seatAttachment: found?.seatAttachment } } : {}),
  });
}

const decisions = new WeakMap<object, boolean>();

/** Notes the creation-time answer for `unit` (asked once, when its clock starts). */
export function noteUnitSpawn(unit: object, fadesIn: boolean): void {
  decisions.set(unit, fadesIn);
}

/**
 * The fade-in's share of `unit`'s alpha now, 0…1: trunc(T · elapsed / 1000) / T for its display target byte T (255
 * before its first look), 1 once the time is up or when it does not fade in.
 */
export function unitSpawnFactor(unit: object, admittedAt: number | undefined, now: number): number {
  if (admittedAt === undefined || !Number.isFinite(admittedAt) || !Number.isFinite(now)) return 1;
  if (decisions.get(unit) === false) return 1;
  const elapsed = Math.floor(now - admittedAt);
  if (elapsed >= UNIT_SPAWN_FADE_MS) return 1;
  if (elapsed <= 0) return 0;
  const target = displayAlphaTargetByte(unit) ?? 255;
  if (target <= 0) return 1;
  return Math.trunc((target * elapsed) / UNIT_SPAWN_FADE_MS) / target;
}

/** Whether `unit`'s byte is walking now — its fade-in or a display-alpha change (+0xc4 ≠ 0), as a passenger asks. */
export function unitAlphaWalking(unit: object, admittedAt: number | undefined, now: number): boolean {
  return unitSpawnFactor(unit, admittedAt, now) < 1 || displayAlphaFading(unit);
}
