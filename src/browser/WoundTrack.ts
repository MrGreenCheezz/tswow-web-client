// 6.43 (15.11, combat11): which track a wound takes over a unit lying in its stand-state pose.
//
// Wow.exe 3.3.5a 12340: the wound chooser 0x00736640 refuses the dead, the feigning and stand state 7, and puts the wound
// on the split (upper-body) track only for the sitting states 1 and 4–6 (0x00716190); any other pose takes it on the
// whole model (face6-report, `.runtime/re-2026-11-15/face6/g1.c`). Recorded on the Oracle stand
// (`F:\WowOracle\runs\combat11-e1-sleep-hit`): an orc asleep (UNIT_FIELD_BYTES_1 = 3) hit by a horse in view plays
// StandWound on its legs and upper body alike, blended over Sleep for about 0.4 s, then lies on; a sitting orc
// (`face6-react-b-hit-sit`) keeps its legs seated. Only the sleeping pose is taken here, the one recorded; kneeling and
// the chair (2) would follow the same branch of 0x00736640 but were not seen.

/** UNIT_STAND_STATE_SLEEP. */
const STAND_STATE_SLEEP = 3;

/** What the choice reads of the unit's pose this frame. */
export interface WoundPose {
  readonly standState?: number | undefined;
  readonly dead?: boolean | undefined;
  readonly mounted?: boolean | undefined;
  readonly vehicleSeat?: unknown;
}

/**
 * Whether a wound plays on the whole body: always over a plain standing base (`baseIdle`), and over a sleeping unit
 * lying still on its own (not dead, not riding, not seated in a vehicle); otherwise the split track, as before.
 */
export function woundTakesWholeBody(baseIdle: boolean, pose: WoundPose): boolean {
  if (baseIdle) return true;
  return pose.standState === STAND_STATE_SLEEP && pose.dead !== true && pose.mounted !== true
    && pose.vehicleSeat === undefined;
}
