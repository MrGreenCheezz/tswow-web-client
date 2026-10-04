// 11.02-tails: where the overlays hang a seated vehicle passenger, and whether a click can find it.
// VehiclePassengerPose.ts draws a passenger's model on its seat point (11.02-H); the plate, the
// bubbles, the floating numbers, the click box, the sight test and the selection ring used to stay on
// the unit's own place — the server's "vehicle + AttachmentOffset", which on a mammoth (offset
// 0, 0, 0) is inside the beast while the model sits on its back. Wow.exe 3.3.5a 12340, Ghidra
// read-only (.runtime/re-2026-10-03/l1102tails/r1-r6.c):
// - The name plate (0x0072b350 → gate 0x0072b060 → 0x00715720) is projected from the unit's name
//   position, CGUnit_C vtable +0x20 = 0x0071fef0 (the same slot in both unit vtables 0x00a34d90 and
//   0x00a326c8): with the model ready (0x00824f00), the drawn model's PlayerNameMounted 29 point when
//   mounted, else its PlayerName 18 point, in the world as drawn (0x00831330); without them a
//   passenger (unit+0xf60) takes its model's own world place (0x007446c0), anyone else its position
//   plus scale × height. The overhead world text (0x007e5420) reads the same point. So everything over
//   a head follows the model where it is drawn — on the seat point for a passenger.
// - The mouse picks (0x004fa040 → 0x004f9da0 → 0x004f9930 → FindClosestModel 0x004f9550) only among
//   the objects the world frame listed while drawing (0x004f8d10): an object whose render query
//   (vtable +0x90: units 0x00730f30, players 0x006e0840) answers "hidden" is not listed, and its model
//   is not drawn. A HIDE_PASSENGER seat answers hidden (0x00730f30, passenger+0x10 bit 0x400), so the
//   passenger has no click and no mouse-over, whatever its unit flags say. The pick tests the drawn
//   model's triangles (0x0081daf0), so a seen passenger is clicked where it is drawn.
// - The name plate gate (0x0072b060: alive, no UNIT_FLAG_UNINTERACTIBLE 0x02000000, map entity placed
//   0x0077f0b0, the plate CVars, no CREATURE_TYPE_FLAG_NO_NAME_PLATE) and Tab (0x00524440) do not ask
//   the render query: the hidden passenger of the 18 HIDE seats without PASSENGER_NOT_SELECTABLE
//   keeps its plate and its place in Tab; here the plate stays a click target, as this client's
//   plates are (the plate frame's own click handler was not decompiled). The other 63 get
//   UNIT_FLAG_UNINTERACTIBLE from the core (Vehicle.cpp:933-934), which takes plate, click and Tab.
//
// The poser writes one record per seated passenger it handles in a frame (`place`); a record older
// than the latest `place` is stale, so a passenger that left its seat, or a frame without the vehicle
// tables, reads as "not seated". A unit off every transport costs the readers one property read.
// Records are made once per passenger object and reused, so a frame allocates nothing here.

import type { WorldObjectState } from "../world/WorldState.js";

/** A point in world coordinates: x and y on the map, z up. */
export interface DrawnPoint {
  x: number;
  y: number;
  z: number;
}

/** What the last `VehiclePassengerPoser.place` did with one seated passenger. */
export interface SeatDrawnRecord {
  /** The world-space step from the unit's own place to where its model was drawn. */
  x: number;
  y: number;
  z: number;
  /** HIDE_PASSENGER: no model while it sits there (Wow.exe 0x00730f30). */
  hidden: boolean;
  /** The `place` that wrote it. */
  frame: number;
}

const records = new WeakMap<WorldObjectState, SeatDrawnRecord>();
let frame = 0;

/** A new `place` begins: every record written before it is stale from now on. */
export function beginSeatDrawnFrame(): void {
  frame++;
}

/**
 * This passenger's record for the current `place`, zero step, `hidden` as given; the poser writes
 * the step once the model is on its point. Made once per passenger object and reused after that.
 */
export function seatDrawnRecord(object: WorldObjectState, hidden: boolean): SeatDrawnRecord {
  let record = records.get(object);
  if (record === undefined) {
    record = { x: 0, y: 0, z: 0, hidden, frame };
    records.set(object, record);
    return record;
  }
  record.x = 0;
  record.y = 0;
  record.z = 0;
  record.hidden = hidden;
  record.frame = frame;
  return record;
}

/** The unit's record from the latest `place`, or undefined: off a transport, not seated, or stale. */
export function seatDrawnRecordOf(object: WorldObjectState): SeatDrawnRecord | undefined {
  if (object.transport === undefined) return undefined;
  const record = records.get(object);
  return record !== undefined && record.frame === frame ? record : undefined;
}

/**
 * Where the overlays hang this unit: its own position object, untouched, unless the latest frame drew
 * it on a vehicle seat point somewhere else — then that position moved with the model, written into
 * the caller's `out` (scratch the caller owns and reads before its next call).
 */
export function drawnUnitPosition(object: WorldObjectState, out: DrawnPoint): DrawnPoint | undefined {
  const position = object.position;
  if (position === undefined) return undefined;
  const record = seatDrawnRecordOf(object);
  if (record === undefined || (record.x === 0 && record.y === 0 && record.z === 0)) return position;
  out.x = position.x + record.x;
  out.y = position.y + record.y;
  out.z = position.z + record.z;
  return out;
}

/** Whether a HIDE_PASSENGER seat hid this unit in the latest frame: no model, nothing for a click. */
export function hiddenBySeat(object: WorldObjectState): boolean {
  return seatDrawnRecordOf(object)?.hidden === true;
}
