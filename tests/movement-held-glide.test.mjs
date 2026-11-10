// 5.04 (11.11): another player's glide toward its first held packet — Wow.exe 0x006EA6A0 (set up) and 0x006EA7E0
// (each engine step), MovementSchedule.ts `MoveGlide`, wired by HeldMoveGlide.ts into WorldState. Times are explicit.
import assert from "node:assert/strict";
import test from "node:test";
import { WorldState } from "../dist/code/world/WorldState.js";
import { MOVEMENT_FLAGS as F } from "../dist/code/world/MovementProtocol.js";
import {
  GLIDE_FACING, GLIDE_MAX_SPEED, GLIDE_PITCH, GLIDE_POSITION, MoveGlide,
} from "../dist/code/world/MovementSchedule.js";

const SELF = 1n;
const OTHER = 2n;
const near = (actual, expected, epsilon = 1e-6, label = "") =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label} ${actual} ≠ ${expected}`);
const pose = (x = 0, y = 0, z = 0, orientation = 0, pitch = 0) => ({ x, y, z, orientation, pitch });
const at = (x = 0, y = 0, z = 0, orientation = 0) => ({ x, y, z, orientation });

test("0x006EA6A0: which parts glide, from the mover's flags and the head's differences", () => {
  const glide = new MoveGlide();
  assert.equal(glide.setup(0, pose(), F.forward, pose(5), 200), GLIDE_POSITION, "a runner's position, facings equal");
  assert.equal(glide.setup(0, pose(), F.turnLeft, pose(5, 0, 0, 1)), 0, "no moment: nothing (length 0)");
  assert.equal(glide.setup(0, pose(), F.turnLeft, pose(5, 0, 0, 1), 100), GLIDE_FACING,
    "a unit only turning: the facing, never the position (0xc0100f leaves the turn bits out)");
  assert.equal(glide.setup(0, pose(), F.forward, pose(5, 0, 0, 0, 0.5), 100), GLIDE_POSITION,
    "a walker's pitch does not glide");
  assert.equal(glide.setup(0, pose(), F.forward | F.swimming, pose(5, 0, 0, 0, 0.5), 100), GLIDE_POSITION | GLIDE_PITCH,
    "a swimmer's does");
  assert.equal(glide.setup(0, pose(0, 0, 0, 1), F.forward, pose(5, 0, 0, 1 + 2 ** -21), 100), GLIDE_POSITION,
    "facings closer than 2^-20 are equal (0x006E9320)");
});

test("0x006EA7E0: the line point blended with the engine's, the facing turned g of the short way", () => {
  const glide = new MoveGlide();
  // From x = 0 facing 6.2 (just short of a turn) toward x = 10 facing 0.1, due at 1 000 ms, set up at 0.
  glide.setup(0, pose(0, 0, 0, 6.2), F.forward, pose(10, 0, 0, 0.1), 1_000);
  // A step from 600: f = 0.4, g = 0.6; the engine has the unit at x = 4.
  const out = pose(4, 0, 0, 6.2);
  assert.equal(glide.step(600, 100, { x: 3.9, y: 0 }, out), true);
  near(out.x, (10 - 10 * 0.4) * 0.6 + 4 * 0.4, 1e-9, "point·g + engine·f");
  // The offset wraps the short way (+0.183 through 0), the target is head − offset·f, the turn g of the way to it.
  const offset = 0.1 - 6.2 + Math.PI * 2;
  const target = 0.1 - offset * 0.4;
  near(out.orientation, 6.2 + (target - 6.2 + Math.PI * 2) * 0.6, 1e-9, "facing, the short way through 0");
  // Past the head's moment: everything stops.
  const late = pose(4);
  assert.equal(glide.step(1_001, 16, { x: 4, y: 0 }, late), false);
  assert.equal(glide.bits, 0);
  assert.equal(late.x, 4);
});

test("0x006EA7E0: a step that would carry the unit faster than 60 yards a second ends the position glide", () => {
  const glide = new MoveGlide();
  glide.setup(0, pose(), F.forward, pose(100), 1_000);
  const out = pose(1);
  // f = 0.5: 0.5·50 + 0.5·1 = 25.5 yards from x = 1 in 100 ms, over 60·0.1 = 6.
  assert.equal(glide.step(500, 100, { x: 1, y: 0 }, out), false);
  assert.equal(out.x, 1, "the engine's point is kept");
  assert.equal(glide.bits & GLIDE_POSITION, 0, "and the position never glides again");
  assert.equal(GLIDE_MAX_SPEED, 60);
});

/** A world whose other player runs forward from x = 0 at its first packet (stamp 0, arrival 0). */
function running(heldX, heldOrientation = 0) {
  const state = new WorldState();
  state.selfGuid = SELF;
  state.move(SELF, { flags: 0, position: at() }, 0);
  state.move(OTHER, { flags: F.forward, position: at(), time: 0 }, 0);
  // Frames run: the unit is drawn where it runs (0x006EA7E0's speed test starts from there).
  for (let now = 20; now <= 300; now += 20) state.updateMotions(now);
  // The next one, stamped 500, arrives at 300: held to 500 (0x006EB730), set up at 300 from x = 2.1.
  state.move(OTHER, { flags: F.forward, position: at(heldX, 0, 0, heldOrientation), time: 500 }, 300);
  return { state, object: state.objects.get(OTHER) };
}

test("5.04 a held packet: the unit leaves its extrapolation and reaches the packet's place as its moment comes", () => {
  const { state, object } = running(5, 1);
  assert.equal(object.movementFlags, F.forward);
  state.updateMotions(320);
  near(object.position.x, 7 * 0.32, 1e-9, "the step from the setup has f = 1: the engine's place");
  state.updateMotions(400);
  // t0 320: f = 0.9, g = 0.1; the line point 5 − 2.9·0.9, the engine 2.8.
  near(object.position.x, (5 - 2.9 * 0.9) * 0.1 + 2.8 * 0.9, 1e-9, "glided");
  near(object.position.orientation, 0.1 * 0.1, 1e-9, "facing g of the way to 1 − 1·0.9");
  state.updateMotions(480);
  near(object.position.x, (5 - 2.9 * 0.5) * 0.5 + 3.36 * 0.5, 1e-9, "half way in time, closer to the packet");
  near(object.position.orientation, 0.01 + 0.5 * (0.5 - 0.01), 1e-9);
  const drawn = object.position.x;
  state.updateMotions(500);
  assert.equal(object.drift.x, 5, "applied at its moment");
  near(object.position.x, drawn, 1e-9, "and the picture stays where it was drawn, the rest closing as before");
});

test("5.04 a held packet too far to glide to: the extrapolation is kept once a step would be too fast", () => {
  const { state, object } = running(100);
  state.updateMotions(320);
  state.updateMotions(400);
  near(object.position.x, (100 - 97.9 * 0.9) * 0.1 + 2.8 * 0.9, 1e-9, "1.47 yards in 80 ms: still under 4.8");
  state.updateMotions(480);
  near(object.position.x, 7 * 0.48, 1e-9, "23 yards in 80 ms is not: the engine's place");
  state.updateMotions(490);
  near(object.position.x, 7 * 0.49, 1e-9, "and the glide does not come back");
});

test("5.04 no glide for a blink, nor without a held packet", () => {
  const { state, object } = running(5);
  state.teleport(OTHER, { flags: F.forward, position: at(30) }, 310);
  state.updateMotions(400);
  near(object.position.x, 30 + 7 * 0.09, 1e-9, "the blink's own run, nothing pulls it toward x = 5");
});
