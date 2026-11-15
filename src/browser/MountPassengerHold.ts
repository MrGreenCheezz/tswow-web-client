// 6.20 (15.11, combat11): a mount that keeps its passengers' seats after its rider's UNIT_FIELD_MOUNTDISPLAYID drops to 0.
//
// Recorded on the Oracle stand (Wow.exe 3.3.5a 12340, `F:\WowOracle\runs\combat11-m1-*`, `-m2-*`, `-m3-*`, `-h-mount`):
// an orc on the Traveler's Tundra Mammoth (display 27238, vehicle kit 313) with a dwarf in seat 1.
// - The field to 0 while the passenger sits: the mammoth stays under the rider, the rider in the saddle. It stayed after
//   the passenger was sent out of the seat and after the passenger was destroyed (m1: still there 9 s later).
// - SMSG_DISMOUNT first, the passenger out, then the field (TrinityCore's order, Unit::Dismount): gone at the field (m2).
// - SMSG_DISMOUNT with the passenger aboard, then the field: kept, as in m1 (m3).
// - Held, nobody aboard: SMSG_DISMOUNT removed it at once (h-mount, 3.0 s); a new mount display replaced it (5.0 s).
// This agrees with vehicle8's reading of the bit 0x10000000 (+0xa30): set by the field watcher 0x00740450 and by
// SMSG_DISMOUNT 0x00741a40 while passengers sit, ended only through 0x0073d940 (a new change of the field, SMSG_DISMOUNT,
// the own dismount request 0x007412e0, a cast visual's end 0x007fec00, the unit's reset 0x007402b0) — never by a
// passenger leaving.
//
// What this client keeps: the display the field last showed, held when the field goes from it to 0 while a passenger sits
// on the unit; any later change of the field ends it, and the unit's reset ends it with the unit (the state lives on the
// rendered unit). SMSG_DISMOUNT does not reach the renderer, so its end of a hold with nobody aboard is not modelled (with
// TrinityCore it comes before the field, where it changes nothing), nor is the own request's or a cast visual's.

/** The rendered unit's last mount field and the display held under it (0: none). */
interface MountHold {
  field: number;
  held: number;
}

const holds = new WeakMap<object, MountHold>();

/**
 * The mount display to draw under `unit` this frame: the field, or — after the field went from a display to 0 while
 * `passengersAboard()` — that display, until the field changes again. `passengersAboard` is asked only on a change.
 */
export function mountShownDisplay(unit: object, field: number, passengersAboard: () => boolean): number {
  const hold = holds.get(unit);
  if (hold === undefined) {
    holds.set(unit, { field, held: 0 });
    return field;
  }
  if (field !== hold.field) {
    hold.held = field === 0 && hold.field > 0 && passengersAboard() ? hold.field : 0;
    hold.field = field;
  }
  return field !== 0 ? field : hold.held;
}

/** The record of a mount display, as `RenderLookups.mountDisplayModel` answers for the field itself. */
export function mountDisplayModelOf<Model>(displayId: number,
  displays: { get(displayId: number): Model | undefined } | undefined): Model | undefined {
  return displayId > 0 && displays ? displays.get(displayId) : undefined;
}
