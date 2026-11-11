// 06.11 (6.43): a unit's stand-state pose — asleep, seated, kneeling — lasts only until the unit swings or moves.
//
// Measured on the Wow.exe stand (F:\WowOracle\tools\onyxia-sleep.mjs): Onyxia spawned with stand state 3 in
// UNIT_FIELD_BYTES_1 lies asleep, still lies with UNIT_FLAG_IN_COMBAT and a target, and stands after her first swing
// and after a run, though the field stays 3 all the while. TrinityCore keeps it there: creature_template_addon gives
// her StandState 3, and neither the core nor boss_onyxia.cpp stands a creature up (Unit.cpp only stands up players
// that take damage). In the code, the stand-state rung of the base chain (0x0071E1F0) plays only while unit+0xA38 bit
// 0x40 is up and the unit is not mounted (+0x98C), and the field's handler (0x0073F0BF) raises the bit only when the
// value changes — to anything but stand (0), dead (7) or 9. So a pose a swing or a run ended comes back only with a
// new value. Not measured: whether a cast, an emote or being hit ends it too.
//
// 11.11, read but not settled (.runtime/re-2026-11-11/combat4, anim4/r6.c): every animation that ends on the unit's own
// model reaches 0x0073bbd0 through the model callback 0x0073c090 — swings, casts, emotes and hits alike; 0x0073bff0
// (through 0x0073c140) is the mount model's. At a whole-body end 0x0073bbd0 raises 0x40 (clearing 0x30) before it re-picks
// the base (0x0073b510 → 0x0073ac30(0x10, −1): the −1 is the rung mask of the chain 0x00724500, 0x100 its stand-state
// rung 0x0071e1f0, 0x200 the emote-state rung 0x007171c0), and nothing clears 0x40 for good. In that chain the rung
// 0x0071e0d0 — a melee target at +0xa20, written by SMSG_ATTACK_START and cleared by SMSG_ATTACK_STOP — comes before
// the stand-state pose and gives the ready stance; the idle flying pose (0x0071e340) comes after it. So the code reads
// as: a unit whose base is re-picked while it holds no melee target takes its stand-state pose again. The stand showed
// Onyxia standing after a swing with no SMSG_ATTACK_START sent, which that reading does not explain; until a measurement
// settles it (swing, then SMSG_ATTACK_STOP, then another animation's end; and a hovering unit), the measured rule stays.

import { UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_STAND } from "../world/CharacterProgressProtocol.js";

/** The stand state the 0x0073F0BF handler leaves out of the rung besides stand and dead. */
const UNIT_STAND_STATE_NO_POSE = 9;

/** Where a unit keeps the wake: "pending" after a swing, then the stand state it woke from. */
export interface StandStateWake {
  standWake: "pending" | number | undefined;
}

/** Whether a stand state is one the rung holds as a pose. */
export function standStateHoldsPose(standState: number): boolean {
  return standState !== UNIT_STAND_STATE_STAND && standState !== UNIT_STAND_STATE_DEAD && standState !== UNIT_STAND_STATE_NO_POSE;
}

/** The unit swung: its stand-state pose ends at its next frame. */
export function wakeStandState(unit: StandStateWake): void {
  unit.standWake = "pending";
}

/**
 * The stand state the unit is posed with this frame: its own, or stand once a swing or a move has ended the pose.
 * A new value of the field brings the pose back, as the handler raising the bit again does.
 */
export function shownStandState(unit: StandStateWake, standState: number, moving: boolean): number {
  if (!standStateHoldsPose(standState)) {
    unit.standWake = undefined;
    return standState;
  }
  if (unit.standWake === "pending" || moving) unit.standWake = standState;
  else if (unit.standWake !== undefined && unit.standWake !== standState) unit.standWake = undefined;
  return unit.standWake === standState ? UNIT_STAND_STATE_STAND : standState;
}
