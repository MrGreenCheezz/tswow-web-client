// 15.11 (6.43): which units Wow.exe plays an SMSG_EMOTE on.
//
// Read (.runtime/re-2026-11-15/face6/g1.c): the opcode's handler 0x006cfe70 looks the unit up and plays the emote
// (0x0073ab90) only when byte 0 of its UNIT_FIELD_BYTES_1 — the stand state the server sent, not the pose drawn — is not
// Sleep (3) and its movement flags carry no MOVEMENTFLAG_SWIMMING (0x200000). Nothing else is refused: a sitting or
// kneeling unit plays it, on the split track over its legs (0x00723e30 splits a listed pose over any stand state).
//
// Measured on the Wow.exe stand 15.11 (F:\WowOracle\runs\face6-q2b-d-stop-then-emote, -f-emote, face6-react-f-talk-sleep,
// read by face6-pose.mjs): Onyxia with stand state 3 drew neither EmoteRoar (15) nor EmoteTalk (1), awake with a melee
// target or not; with stand state 0 she talked (face6-react-h-talk-awake). A naked orc sitting (1) talked with the
// upper body while its legs stayed seated (face6-react-d-talk-sit, bones-parts.mjs). The swimming half is read, not measured.

import { UPDATE_FIELDS } from "../../generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../../world/MovementProtocol.js";
import { UNIT_STAND_STATE_SLEEP } from "../../world/CharacterProgressProtocol.js";
import type { WorldObjectState } from "../../world/WorldState.js";

const BYTES_1 = UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset;

/** Whether 0x006cfe70 plays an SMSG_EMOTE on this unit; a unit the client does not have plays nothing. */
export function unitTakesEmote(object: WorldObjectState | undefined): boolean {
  if (object === undefined) return false;
  if (((object.fields.get(BYTES_1) ?? 0) & 0xff) === UNIT_STAND_STATE_SLEEP) return false;
  return (object.movementFlags & MOVEMENT_FLAGS.swimming) === 0;
}
