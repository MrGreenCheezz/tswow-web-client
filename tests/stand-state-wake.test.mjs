// 6.43: a stand-state pose gives way while the unit holds a melee target or moves and comes back when neither holds, as
// Wow.exe drew Onyxia on the stand 15.11 (F:\WowOracle\runs\face6-q2b-*.bones, face6-pose.mjs) with her field left at
// Sleep (3), as TrinityCore keeps it: lying in combat with a target; the attack and the ready stance after
// SMSG_ATTACK_START; lying again at once after SMSG_ATTACK_STOP, with no SleepDown; up while a spline moves her, lying
// again when it ends; a change of the field itself plays its edge.
import assert from "node:assert/strict";
import test from "node:test";
import { shownStandState, standStateHoldsPose, standWakeEdge } from "../dist/code/browser/StandStateWake.js";

const SLEEP = 3, SIT = 1, STAND = 0, DEAD = 7, KNEEL = 8;

test("asleep in combat with a target; up while the melee target is held; asleep again after SMSG_ATTACK_STOP", () => {
  const unit = { standWake: undefined };
  assert.equal(shownStandState(unit, SLEEP, false, false), SLEEP, "UNIT_FIELD_TARGET alone does not wake her");
  assert.equal(shownStandState(unit, SLEEP, false, true), STAND, "SMSG_ATTACK_START: the ready stance");
  assert.equal(shownStandState(unit, SLEEP, false, true), STAND, "and between swings");
  assert.equal(shownStandState(unit, SLEEP, false, false), SLEEP, "SMSG_ATTACK_STOP: lying again, the field never changed");
  assert.equal(shownStandState(unit, SLEEP, false, false), SLEEP, "and she stays down");
});

test("a run gives way only while it lasts", () => {
  const unit = { standWake: undefined };
  assert.equal(shownStandState(unit, SLEEP, false), SLEEP);
  assert.equal(shownStandState(unit, SLEEP, true), STAND);
  assert.equal(shownStandState(unit, SLEEP, false), SLEEP, "the spline ended: lying again");
});

test("the rungs above the pose cross without the field's edge clip; a change of the field keeps it", () => {
  const unit = { standWake: undefined };
  let shown = shownStandState(unit, SLEEP, false, false);
  let next = shownStandState(unit, SLEEP, false, true);
  assert.equal(standWakeEdge(unit, shown, next), true, "no SleepUp for the swing");
  shown = next;
  next = shownStandState(unit, SLEEP, false, false);
  assert.equal(standWakeEdge(unit, shown, next), true, "no SleepDown after SMSG_ATTACK_STOP");
  shown = next;
  next = shownStandState(unit, STAND, false, false);
  assert.equal(next, STAND);
  assert.equal(standWakeEdge(unit, shown, next), false, "the field 3 -> 0: SleepUp plays");
  shown = next;
  next = shownStandState(unit, STAND, false, false);
  assert.equal(standWakeEdge(unit, shown, next), false, "no change, no edge");
});

test("a new value of the field is posed at once; stand, dead and 9 hold no pose", () => {
  const unit = { standWake: undefined };
  assert.equal(shownStandState(unit, SIT, false), SIT);
  assert.equal(shownStandState(unit, KNEEL, false), KNEEL);
  assert.equal(standStateHoldsPose(STAND), false);
  assert.equal(standStateHoldsPose(DEAD), false);
  assert.equal(standStateHoldsPose(9), false);
  for (const state of [1, 2, 3, 4, 5, 6, 8]) assert.equal(standStateHoldsPose(state), true, `state ${state}`);
  assert.equal(shownStandState(unit, DEAD, false, true), DEAD, "a melee target does not raise the dead");
});
