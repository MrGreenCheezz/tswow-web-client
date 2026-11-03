// 03.11 (6.33): how Wow.exe mixes clips, against its own bones. The numbers are off a stand recording of HumanMale, its palette
// fitted to the clip tracks to 0.1° (F:\WowOracle\runs t1, s1, b1, b2, c4, c5; docs/implementation/anim-blends.ru.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { blendInto, blendWeight, FLINCH_WEIGHT, flinchWith } from "../dist/code/browser/AnimationBlend.js";
import {
  chooseAnimation, facingTurnBetween, gaitTimeScale, poseAnimation, stepStrafeYaw, strideStartTime, turnOnTheSpot,
  STRAFE_YAW_PURE, STRAFE_YAW_SETTLE_RATE,
} from "../dist/code/browser/AnimatedModel.js";
import { ANIMATION_IDS } from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

const FRAME = 0.035;
const near = (actual, expected, tolerance, what) => assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} against ${expected}`);

/** Three clips on one bone, whose position says how much of each is in the pose: A is 1 on x, B on y, C on z. */
function rig() {
  const root = new THREE.Object3D();
  const bone = new THREE.Bone();
  bone.name = "bone0";
  root.add(bone);
  const mixer = new THREE.AnimationMixer(root);
  const clip = (name, value) => new THREE.AnimationClip(name, 10, [
    new THREE.VectorKeyframeTrack("bone0.position", [0, 10], [...value, ...value]),
  ]);
  const clips = { A: clip("A", [1, 0, 0]), B: clip("B", [0, 1, 0]), C: clip("C", [0, 0, 1]) };
  const start = (name) => {
    const action = mixer.clipAction(clips[name]);
    action.reset();
    action.setEffectiveWeight(1);
    action.play();
    return action;
  };
  const shares = () => ({ A: bone.position.x, B: bone.position.y, C: bone.position.z });
  return { mixer, start, shares };
}

test("the weight of the incoming clip is the curve Wow.exe's bones are on, over the incoming clip's blend time", () => {
  assert.equal(blendWeight(0), 0);
  assert.equal(blendWeight(1), 1);
  assert.equal(blendWeight(-1), 0);
  assert.equal(blendWeight(2), 1);
  // Stand into Run, frames 35–38 of t1: time since the key → the weight that fits the frame.
  const measured = [[35.2, 0.14], [70.1, 0.45], [105.5, 0.78], [140.3, 0.985]];
  for (const [ms, weight] of measured) near(blendWeight(ms / 150), weight, 0.01, `${ms} ms`);

  const { mixer, start, shares } = rig();
  const a = start("A");
  mixer.update(0.5);
  const b = start("B");
  blendInto(b, a, 0.15, mixer.time);
  for (const [ms, weight] of measured) {
    const before = mixer.time;
    mixer.update(ms / 1000 - (before - 0.5));
    near(shares().B, weight, 0.01, `a real mixer at ${ms} ms`);
    near(shares().A, 1 - weight, 0.01, `and what is left of the other at ${ms} ms`);
  }
  mixer.update(0.1);
  assert.deepEqual(shares(), { A: 0, B: 1, C: 0 }, "and after it only the new clip");
  assert.ok(a.time > 0.6, "the outgoing clip's clock ran on under the blend, as the frames fit only that way");
});

test("a switch in the first half of a blend keeps the outgoing clip and the blend's own clock", () => {
  // b1: Stand, Run at frame 28, Walkbackwards at frame 30 (70 ms in): frame 31 is 0.78 of the new clip, 33 all of it.
  const { mixer, start, shares } = rig();
  const a = start("A");
  mixer.update(0.5);
  const b = start("B");
  blendInto(b, a, 0.15, mixer.time);
  mixer.update(0.07);
  near(shares().B, 0.45, 0.01, "the second clip has come in a little");
  const c = start("C");
  blendInto(c, b, 0.15, mixer.time);
  mixer.update(0.035);
  assert.equal(shares().B, 0, "the second clip is gone at once");
  near(shares().C, 0.78, 0.01, "and the third is where the second would have been");
  near(shares().A, 0.22, 0.01, "the first still going out");
  mixer.update(0.07);
  assert.deepEqual(shares(), { A: 0, B: 0, C: 1 }, "over when the first blend would have been");
});

test("a switch in the second half starts over from the clip coming in, whole", () => {
  // b2: Stand, Run at frame 29, Stand at 32 (105 ms in): frames 33–36 are a fresh blend out of Run, 0.14 0.45 0.78 0.985 back.
  const { mixer, start, shares } = rig();
  const a = start("A");
  mixer.update(0.5);
  const b = start("B");
  blendInto(b, a, 0.15, mixer.time);
  mixer.update(0.105);
  near(shares().B, 0.78, 0.01, "the second clip nearly in");
  const c = start("C");
  blendInto(c, b, 0.15, mixer.time);
  assert.equal(a.isRunning(), false, "the first is gone");
  for (const weight of [0.14, 0.45, 0.78, 0.985]) {
    mixer.update(FRAME);
    near(shares().C, weight, 0.02, "the new blend");
    near(shares().B, 1 - weight, 0.02, "out of the second clip alone");
    assert.equal(shares().A, 0);
  }
});

test("a quick change of mind goes straight back to the first clip", () => {
  // s1: Stand, Run at frame 86, Stand at 88: frame 89 is Stand again to 0.22°.
  const { mixer, start, shares } = rig();
  const a = start("A");
  mixer.update(0.5);
  const b = start("B");
  blendInto(b, a, 0.15, mixer.time);
  mixer.update(0.07);
  const again = start("A");
  blendInto(again, b, 0.15, mixer.time);
  mixer.update(FRAME);
  assert.deepEqual(shares(), { A: 1, B: 0, C: 0 });
});

test("a blend that ran out leaves nothing to keep", () => {
  const { mixer, start, shares } = rig();
  const a = start("A");
  mixer.update(0.5);
  const b = start("B");
  blendInto(b, a, 0.15, mixer.time);
  mixer.update(0.5);
  const c = start("C");
  blendInto(c, b, 0.15, mixer.time);
  mixer.update(FRAME);
  near(shares().C, 0.14, 0.02, "an ordinary blend");
  near(shares().B, 0.86, 0.02, "out of the clip on show");
});

test("a wound lies over the pose at once at 3/4, and the same curve takes it away", () => {
  // c5, a hit taken standing (f474…) and running (f558…): clip time → the wound's share, the same on both.
  const measured = [[32, 0.75], [104, 0.72], [176, 0.68], [248, 0.64], [312, 0.58], [384, 0.5], [448, 0.44], [520, 0.36], [592, 0.28],
    [656, 0.2], [728, 0.14], [792, 0.08], [872, 0.04]];
  assert.equal(FLINCH_WEIGHT, 0.75);
  const { mixer, start, shares } = rig();
  start("A");
  mixer.update(0.5);
  const wound = start("B");
  flinchWith(wound, 1);
  let at = 0;
  for (const [ms, share] of measured) {
    mixer.update(ms / 1000 - at);
    at = ms / 1000;
    near(shares().B, share, 0.025, `${ms} ms in`);
    near(shares().A, 1 - shares().B, 1e-6, "over the clip that goes on underneath");
  }
  mixer.update(0.2);
  assert.deepEqual(shares(), { A: 1, B: 0, C: 0 }, "and gone with the clip");
  assert.equal(wound.enabled, false);
});

test("a stride runs at speed over its own number, and only a stride that has one", () => {
  // c4: Walk (2.5) at 3.5 and at 5; Run (6.94) at 7.
  assert.equal(gaitTimeScale(3.5, 2.5), 1.4);
  assert.equal(gaitTimeScale(5, 2.5), 2);
  assert.equal(gaitTimeScale(7, 6.9444), 1);
  // Walkbackwards at 9, Sprint at 14, Shuffle: no number, 1.000 measured.
  assert.equal(gaitTimeScale(9, undefined), 1);
});

test("a stride with a number hands over at its phase, any other starts from zero", () => {
  // b2: Run @339 of 667 → Walk @508 of 1000; Walk @24 → Run @16. s4: Run → Walkbackwards from zero.
  const clip = (duration, movingSpeed) => {
    const built = new THREE.AnimationClip("gait", duration, []);
    if (movingSpeed !== undefined) built.userData.movingSpeed = movingSpeed;
    return built;
  };
  const run = clip(0.667, 6.94), walk = clip(1, 2.5), back = clip(1);
  const action = (of, time) => ({ getClip: () => of, time });
  near(strideStartTime(action(run, 0.339), walk), 0.508, 0.001, "Run into Walk");
  near(strideStartTime(action(walk, 0.024), run), 0.016, 0.001, "Walk into Run");
  assert.equal(strideStartTime(action(run, 0.339), back), undefined);
  assert.equal(strideStartTime(action(back, 0.339), run), undefined);
});

const standing = (over = {}) => ({ movementFlags: 0, dead: false, standState: 0, ...over });

test("walk, run and sprint go by speed as 0x00717050 has them", () => {
  const { Walk, Run, Sprint, Walkbackwards } = ANIMATION_IDS;
  const moving = (speed, flags = MOVEMENT_FLAGS.forward) => poseAnimation(standing({ movementFlags: flags, speed })).wanted[0];
  assert.equal(moving(3.5), Walk, "measured: a run at 3.5 plays Walk");
  assert.equal(moving(5), Walk, "measured: a walk at 5 is still Walk");
  assert.equal(moving(5.5), Run);
  assert.equal(moving(11), Run);
  assert.equal(moving(14), Sprint, "measured at 14");
  assert.equal(moving(14, MOVEMENT_FLAGS.strafeLeft), Sprint, "a strafe too");
  assert.equal(moving(14, MOVEMENT_FLAGS.backward), Walkbackwards, "backward goes first");
  assert.equal(chooseAnimation(new Map([[Run, {}]]), standing({ movementFlags: MOVEMENT_FLAGS.forward, speed: 14 })).animation, Run,
    "a rig without one runs");
});

test("the body keeps its place when the facing moves, up to a quarter turn behind", () => {
  // b3: TurnLeft at π rad/s, 90° behind after half a second, then dragged along for as long as the key is held.
  const F = MOVEMENT_FLAGS;
  const turnKey = standing({ movementFlags: F.turnLeft });
  const state = { yaw: 0, velocity: 0, hold: 1, turning: 0 };
  const frame = 1 / 30;
  let t = 0;
  for (; t < 0.45; t += frame) stepStrafeYaw(state, 0, turnKey, frame, Math.PI * frame);
  near(state.yaw, -Math.PI * t, 1e-6, "behind by what the facing has turned");
  assert.equal(state.turning, 0, "the feet have not moved");
  for (let i = 0; i < 10; i++) stepStrafeYaw(state, 0, turnKey, frame, Math.PI * frame);
  near(state.yaw, -STRAFE_YAW_PURE, 1e-6, "90° held");
  assert.equal(state.turning, 1, "the body dragged to the left, so ShuffleLeft");
  // Let go: a straight line back at the settle's rate.
  const still = standing();
  const before = state.yaw;
  stepStrafeYaw(state, 0, still, frame);
  near(state.yaw, before + STRAFE_YAW_SETTLE_RATE * frame, 1e-9, "the settle");
  assert.equal(state.turning, 1);
  // The player's own mouse holds it the same way while it moves; another unit's facing does not.
  const mine = { yaw: -1, velocity: 0, hold: 1, turning: 0 };
  stepStrafeYaw(mine, 0, still, frame, 0.01, true);
  near(mine.yaw, -1.01, 1e-9, "no settle under the player's own mouse");
  const theirs = { yaw: -1, velocity: 0, hold: 1, turning: 0 };
  stepStrafeYaw(theirs, 0, still, frame, 0.01, false);
  near(theirs.yaw, -1.01 + STRAFE_YAW_SETTLE_RATE * frame, 1e-9);
  // c8: on the run the body is simply on the facing once the hold has gone.
  const running = standing({ movementFlags: F.forward | F.turnLeft });
  const onTheRun = { yaw: 0, velocity: 0, hold: 0, turning: 0 };
  stepStrafeYaw(onTheRun, 0, running, frame, Math.PI * frame);
  assert.equal(onTheRun.yaw, 0, "no lag at all, measured to 0.4°");
  // A transport's turn is no turn of the facing.
  const aboard = { yaw: 0, velocity: 0, hold: 1, turning: 0 };
  stepStrafeYaw(aboard, 0, standing({ movementFlags: F.onTransport }), frame, 0.2);
  assert.equal(aboard.yaw, 0);
  // The short way round.
  near(facingTurnBetween(3, -3), 2 * Math.PI - 6, 1e-9, "across the seam");
  assert.equal(facingTurnBetween(undefined, 2), 0);
});

test("feet shuffle under a turning body and only out of Stand, and a Shuffle finishes its cycle", () => {
  const { Stand, ShuffleLeft, ShuffleRight, Run } = ANIMATION_IDS;
  const F = MOVEMENT_FLAGS;
  const idle = standing();
  assert.equal(turnOnTheSpot(Stand, Stand, idle, 0, true), Stand);
  assert.equal(turnOnTheSpot(Stand, undefined, standing({ movementFlags: F.turnLeft }), 0, true), ShuffleLeft, "under the key");
  assert.equal(turnOnTheSpot(Stand, undefined, standing({ movementFlags: F.turnRight }), 0, true), ShuffleRight);
  assert.equal(turnOnTheSpot(Stand, Stand, idle, 1, true), ShuffleLeft, "a body coming round to the left");
  assert.equal(turnOnTheSpot(Stand, Stand, idle, -1, true), ShuffleRight, "b3: after a strafe left, ShuffleRight");
  // b3 f154–165, f342–346: the body is home and the clip plays out its 500 ms.
  assert.equal(turnOnTheSpot(Stand, ShuffleRight, idle, 0, false), ShuffleRight);
  assert.equal(turnOnTheSpot(Stand, ShuffleRight, idle, 0, true), Stand);
  // c9: a combat stance keeps its pose while the body turns under it.
  const { ReadyUnarmed } = ANIMATION_IDS;
  assert.equal(turnOnTheSpot(ReadyUnarmed, ReadyUnarmed, idle, 1, true), ReadyUnarmed);
  // Moving: the gait answers.
  assert.equal(turnOnTheSpot(Run, Run, standing({ movementFlags: F.forward | F.turnLeft }), 1, true), Run);
});
