// WORK_PLAN 5.04 (11.11): how long another unit runs on without a packet — Wow.exe 0x006E9F50
// (.runtime/re-2026-11-11/moves/m3.c, worldtails/w1.c): after half a second without a packet the move time it is
// drawn at loses min(acc − 500, 1000)²/2000 and, from 1.5 s, all the rest — a linear slowdown to a stand. Only a mover
// whose flags carry 0xc0100f (direction keys, FALLING, ASCENDING, DESCENDING) slows; a unit that only turns keeps
// turning. The clock (+0x134) starts when the packet is applied (0x006EB730), not at its sender's moment. Was 2 s at
// full speed and a dead stop.
import assert from "node:assert/strict";
import test from "node:test";
import { WorldState } from "../dist/code/world/WorldState.js";
import { MOVEMENT_FLAGS as F } from "../dist/code/world/MovementProtocol.js";
import {
  REMOTE_SLOWING_FLAGS, advanceDrift, emptyDrift, kinematicsFor, realignDrift, remoteMoveLoss,
} from "../dist/code/world/MovementExtrapolation.js";

const SELF = 1n;
const OTHER = 2n;
const at = (x = 0, y = 0, z = 0, orientation = 0) => ({ x, y, z, orientation });
const near = (actual, expected, epsilon = 1e-9, label = "") =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label} ${actual} ≠ ${expected}`);

function world() {
  const state = new WorldState();
  state.selfGuid = SELF;
  state.move(SELF, { flags: 0, position: at() }, 0);
  return state;
}

test("5.04 0x006E9F50: the loss of move time after the last packet", () => {
  assert.equal(REMOTE_SLOWING_FLAGS, 0xc0100f);
  assert.equal(remoteMoveLoss(0), 0);
  assert.equal(remoteMoveLoss(500), 0, "full speed for half a second");
  assert.equal(remoteMoveLoss(1_000), 125, "500²/2000");
  assert.equal(remoteMoveLoss(1_500), 500, "1000²/2000: the unit stands from here");
  assert.equal(remoteMoveLoss(2_000), 1_000, "every further millisecond is lost");
  assert.equal(remoteMoveLoss(-300), 0);
});

test("5.04 a runner without packets slows from 0.5 s and stands from 1.5 s, one second of travel later", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at() }, 1_000);
  const object = state.objects.get(OTHER);
  state.updateMotions(1_500);
  near(object.position.x, 3.5, 1e-9, "half a second at 7 yd/s");
  state.updateMotions(2_000);
  near(object.position.x, 7 * 0.875, 1e-9, "1000 − 125 ms of travel");
  state.updateMotions(2_500);
  near(object.position.x, 7, 1e-9, "1 s of travel: standing");
  state.updateMotions(3_500);
  near(object.position.x, 7, 1e-9, "and standing on, not running on to 2 s");
  assert.equal(object.drift, undefined, "the drift is let go once it stands");
});

test("5.04 a unit that only turns keeps turning without packets", () => {
  const state = world();
  state.move(OTHER, { flags: F.turnLeft, position: at() }, 1_000);
  const object = state.objects.get(OTHER);
  state.updateMotions(4_000);
  near(object.position.orientation, 3.141594 * 3, 1e-6, "three seconds at the turn rate");
  assert.notEqual(object.drift, undefined);
});

test("5.04 the clock starts at the packet's application, not at its sender's moment", () => {
  const drift = emptyDrift();
  kinematicsFor({ flags: F.forward }, undefined, drift);
  drift.at = 1_000;
  realignDrift(drift, 700, 1_000);
  const out = { x: 0, y: 0, z: 0, orientation: 0 };
  advanceDrift(drift, 2_000, out);
  // 1300 ms since its moment, 1000 since it was applied: 1300 − 125 ms of travel.
  near(out.x, 7 * 1.175, 1e-9);
});

test("5.04 a speed change mid-slowdown keeps the packet's clock", () => {
  const state = world();
  state.move(OTHER, { flags: F.forward, position: at() }, 1_000);
  const object = state.objects.get(OTHER);
  state.updateMotions(1_800);
  near(object.position.x, 7 * 0.755, 1e-9, "800 − 300²/2000 ms");
  state.setSpeed(OTHER, "run", 14, 1_800);
  state.updateMotions(2_500);
  // From 1.8 s to 2.5 s: 700 ms less (500 − 45) lost = 245 ms at 14 yd/s.
  near(object.position.x, 7 * 0.755 + 14 * 0.245, 1e-9);
  state.updateMotions(3_000);
  near(object.position.x, 7 * 0.755 + 14 * 0.245, 1e-9, "standing");
});
