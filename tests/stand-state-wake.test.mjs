// 06.11 (6.43): a stand-state pose lasts until the unit swings or moves, as Wow.exe draws Onyxia, whose field TrinityCore
// leaves at Sleep (3) through the whole fight: lying, lying in combat, standing after a swing and after a run.
import assert from "node:assert/strict";
import test from "node:test";
import { shownStandState, standStateHoldsPose, wakeStandState } from "../dist/code/browser/StandStateWake.js";

const SLEEP = 3, SIT = 1, STAND = 0, DEAD = 7, KNEEL = 8;

test("asleep until a swing, then standing though the field still says asleep", () => {
  const unit = { standWake: undefined };
  assert.equal(shownStandState(unit, SLEEP, false), SLEEP);
  assert.equal(shownStandState(unit, SLEEP, false), SLEEP, "in combat with a target she still lies");
  wakeStandState(unit);
  assert.equal(shownStandState(unit, SLEEP, false), STAND);
  assert.equal(shownStandState(unit, SLEEP, false), STAND, "and stays up between swings");
});

test("a run ends the pose too, and it does not come back when the run is over", () => {
  const unit = { standWake: undefined };
  assert.equal(shownStandState(unit, SLEEP, false), SLEEP);
  assert.equal(shownStandState(unit, SLEEP, true), STAND);
  assert.equal(shownStandState(unit, SLEEP, false), STAND);
});

test("a new value of the field brings its pose back", () => {
  const unit = { standWake: undefined };
  shownStandState(unit, SLEEP, true);
  assert.equal(shownStandState(unit, SIT, false), SIT, "the server seats it: seated");
  assert.equal(shownStandState(unit, STAND, false), STAND);
  assert.equal(shownStandState(unit, KNEEL, false), KNEEL, "after a stand, a kneel is held again");
});

test("stand, dead and 9 are never turned: the rung holds no pose for them", () => {
  assert.equal(standStateHoldsPose(STAND), false);
  assert.equal(standStateHoldsPose(DEAD), false);
  assert.equal(standStateHoldsPose(9), false);
  for (const state of [1, 2, 3, 4, 5, 6, 8]) assert.equal(standStateHoldsPose(state), true, `state ${state}`);
  const unit = { standWake: undefined };
  wakeStandState(unit);
  assert.equal(shownStandState(unit, DEAD, false), DEAD, "a swing does not raise the dead");
  assert.equal(unit.standWake, undefined);
});
