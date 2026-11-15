// 15.11 (6.43): SMSG_EMOTE is played only on a unit not asleep and not swimming (Wow.exe 0x006cfe70), as the stand drew it:
// Onyxia with stand state 3 drew neither EmoteRoar nor EmoteTalk, with stand state 0 she talked, and a sitting orc talked
// with its upper body (F:\WowOracle\runs\face6-q2b-f-emote, face6-react-f-talk-sleep, -h-talk-awake, -d-talk-sit).
import assert from "node:assert/strict";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import { unitTakesEmote } from "../dist/code/browser/game/EmoteRefusal.js";

const unit = (standState, movementFlags = 0) => ({
  guid: 1n, typeId: 3, movementFlags, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_BYTES_1.offset, standState]]),
});

test("asleep, the field says 3: no emote, even while a melee target holds her up", () => {
  assert.equal(unitTakesEmote(unit(3)), false);
  // The field, not the pose drawn: the other bytes of UNIT_FIELD_BYTES_1 do not matter.
  assert.equal(unitTakesEmote(unit(3 | (0xff << 8))), false);
});

test("standing, sitting or kneeling: the emote plays", () => {
  for (const state of [0, 1, 2, 4, 5, 6, 8]) assert.equal(unitTakesEmote(unit(state)), true, `state ${state}`);
});

test("a swimming unit and a unit the client does not have play nothing", () => {
  assert.equal(unitTakesEmote(unit(0, MOVEMENT_FLAGS.swimming)), false);
  assert.equal(unitTakesEmote(undefined), false);
});
