// 12.10 6.07 — falling and pose transitions as Wow.exe 3.3.5a 12340 animates them.
// * The mover raises MOVEMENTFLAG_FALLING_FAR (0x2000) in its airborne step (0x007618b0 at 0x007617f0–0x0076182b, the
//   same test as 0x0075cf80): a fall with no jump velocity (+0xb8 = 0) once its clock (+0x80) passes 499 ms, a jump
//   once the mover (+0x18) is at or below where it began (+0x84) less 1/9 yard (0x00a1ea9c).
// * The base chain reads it (0x00723350 «really falling»: FALLING with FALLING_FAR or a jump velocity; 0x00724200:
//   keep a jump clip — 0x0071dc20, BehaviorID 37–40 or 0x1d3 — else Fall): a jump keeps Jump to the ground, a
//   walk-off runs on (its ground pose) until FALLING_FAR and then falls.
// * A movement change re-picks the base (0x0073ee14 → 0x0073ac30): a landing one-shot gives way when the unit stops.
// * A transition whose clip is still in the sidecar waits for it (PendingTransition.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FALLING_FAR_DROP, FALLING_FAR_MS, fallsFar } from "../dist/code/browser/game/Physics.js";
import {
  isBaseIdle, isJumpAnimation, isReallyFalling, poseAnimation, poseTransition,
} from "../dist/code/browser/AnimatedModel.js";
import { TRANSITION_SIDECAR_WAIT, settleTransition } from "../dist/code/browser/PendingTransition.js";
import { animationPlaysOnUpperBody, unitActionDisplay } from "../dist/code/browser/UnitActionArbiter.js";
import { WorldState } from "../dist/code/world/WorldState.js";
import { MOVEMENT_FLAGS as F } from "../dist/code/world/MovementProtocol.js";
import { ANIMATION_DATA_AVAILABLE, ANIMATION_IDS as A } from "../dist/code/generated/animations.js";

const withData = { skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data" };
const pose = (extra = {}) => ({ dead: false, movementFlags: 0, spline: false, standState: 0, ...extra });

test("0x007617f0: FALLING_FAR — a walk-off after 500 ms, a jump once 1/9 yard below where it began", () => {
  assert.equal(FALLING_FAR_MS, 500);
  assert.ok(Math.abs(FALLING_FAR_DROP - 0.1111111) < 1e-6, "0x00a1ea9c");
  const walkOff = (fallTime) => fallsFar({ jump: { velocity: 0 }, fallTime, fallStartZ: 10 }, -100);
  assert.equal(walkOff(499), false, "`499 < fallTime`");
  assert.equal(walkOff(499.5), true);
  assert.equal(fallsFar({ jump: undefined, fallTime: 600, fallStartZ: 10 }, 10), true, "no jump block: a walk-off");
  const jump = (z) => fallsFar({ jump: { velocity: 7.9 }, fallTime: 5_000, fallStartZ: 10 }, z);
  assert.equal(jump(12), false, "rising, however long");
  assert.equal(jump(10 - FALLING_FAR_DROP + 0.01), false);
  assert.equal(jump(10 - FALLING_FAR_DROP), true, "at or below");
  assert.equal(fallsFar({ jump: { velocity: 7.9 }, fallTime: 0, fallStartZ: Number.NaN }, -50), false, "no start yet");
});

test("the physics raises and clears the flag, and the own packets carry it", () => {
  const physics = readFileSync(new URL("../src/browser/game/Physics.ts", import.meta.url), "utf8");
  const airborne = physics.slice(physics.indexOf("function stepAirborne("), physics.indexOf("function land("));
  assert.ok(airborne.indexOf("if (!motion.fallingFar) motion.fallingFar = fallsFar(motion, position.z);")
    > airborne.indexOf("motion.fallTime += elapsed * 1000;"), "after the step moved the mover");
  assert.match(airborne, /if \(Number\.isNaN\(motion\.fallStartZ\)\) motion\.fallStartZ = zBefore;/);
  const land = physics.slice(physics.indexOf("function land("), physics.indexOf("function stepSwimming("));
  assert.match(land, /motion\.fallingFar = false;/);
  const movement = readFileSync(new URL("../src/browser/input/Movement.ts", import.meta.url), "utf8");
  assert.match(movement, /if \(motion\.mode === "air" && !flying && motion\.fallingFar\) flags \|= MOVEMENT_FLAGS\.fallingFar;/);
  assert.match(movement, /if \(self\) self\.fallJumped = event === "jump";/);
});

test("WorldState keeps whether a remote fall began with a jump, from the packet's jump block", () => {
  const state = new WorldState();
  const at = { x: 0, y: 0, z: 0, orientation: 0 };
  state.move(5n, { flags: F.falling, position: at, jump: { velocity: -7.955547, sinAngle: 0, cosAngle: 1, speed: 7 } });
  assert.equal(state.objects.get(5n).fallJumped, true);
  state.move(5n, { flags: F.falling | F.fallingFar, position: at });
  assert.equal(state.objects.get(5n).fallJumped, true, "a packet without the block leaves it");
  state.move(5n, { flags: 0, position: at });
  assert.equal(state.objects.get(5n).fallJumped, undefined, "landed: no fall to describe");
  state.move(6n, { flags: F.falling, position: at, jump: { velocity: 0, sinAngle: 0, cosAngle: 1, speed: 7 } });
  assert.equal(state.objects.get(6n).fallJumped, false, "walked off");
});

test("0x00723350/0x00724200: a jump keeps Jump to the ground; a walk-off runs on, then falls", withData, () => {
  assert.equal(isJumpAnimation(A.JumpStart) && isJumpAnimation(A.Jump) && isJumpAnimation(A.JumpEnd) && isJumpAnimation(A.Fall), true);
  assert.equal(isJumpAnimation(A.JumpLandRun), false, "behaviour 0xbb is not one of 0x0071dc20's");
  assert.equal(isJumpAnimation(A.Run), false);
  // A walk-off, not yet far: the ground's rungs.
  const walkOff = { movementFlags: F.falling, fallJumped: false, airborneBase: null };
  assert.equal(isReallyFalling(pose(walkOff)), false);
  assert.deepEqual(poseAnimation(pose(walkOff)).wanted, [A.Stand]);
  assert.equal(poseAnimation(pose({ ...walkOff, movementFlags: F.falling | F.forward })).wanted[0], A.Run, "it runs on");
  assert.equal(isBaseIdle(pose(walkOff)), true, "and stands, for the action layer too");
  // Far now: the clip it is in (Run) is no jump: Fall.
  assert.deepEqual(poseAnimation(pose({ ...walkOff, movementFlags: F.falling | F.fallingFar })).wanted, [A.Fall, A.Jump]);
  // A jump: really falling at once; after JumpStart its loop, Jump — and still Jump once far.
  const jump = { movementFlags: F.falling, fallJumped: true, airborneBase: A.JumpStart };
  assert.deepEqual(poseAnimation(pose(jump)).wanted, [A.Jump, A.Fall]);
  assert.deepEqual(poseAnimation(pose({ ...jump, movementFlags: F.falling | F.fallingFar, airborneBase: A.Jump })).wanted,
    [A.Jump, A.Fall], "0x0071dc20 keeps it");
  assert.deepEqual(poseAnimation(pose({ ...jump, airborneBase: A.Fall })).wanted, [A.Fall, A.Jump], "a fall stays a fall");
  // A caller that knows nothing keeps the old ladders.
  assert.deepEqual(poseAnimation(pose({ movementFlags: F.falling })).wanted, [A.Jump, A.Fall]);
  assert.deepEqual(poseAnimation(pose({ movementFlags: F.fallingFar })).wanted, [A.Fall, A.Jump]);
});

test("the jump's own start and landing belong to falls Wow.exe animates as falls", withData, () => {
  const ground = pose();
  assert.equal(poseTransition(ground, pose({ movementFlags: F.falling, fallJumped: true })), A.JumpStart);
  assert.equal(poseTransition(ground, pose({ movementFlags: F.falling })), A.JumpStart, "not known: as before");
  const walkOff = pose({ movementFlags: F.falling, fallJumped: false });
  assert.equal(poseTransition(ground, walkOff), undefined, "a walk-off has no JumpStart");
  const far = pose({ movementFlags: F.falling | F.fallingFar, fallJumped: false });
  assert.equal(poseTransition(walkOff, far), undefined, "nor when it becomes far: Fall comes with the base");
  assert.equal(poseTransition(ground, far), undefined, "nor when the first packet of it is already far");
  assert.equal(poseTransition(walkOff, ground), undefined, "a kerb: no landing");
  assert.equal(poseTransition(far, ground), A.JumpEnd, "a real fall lands");
  assert.equal(poseTransition(pose({ movementFlags: F.falling, fallJumped: true }), pose({ movementFlags: F.forward })), A.JumpLandRun);
});

test("PendingTransition: an edge waits for its clip while the pose holds, and no longer", () => {
  const kneel = { standState: 8, moving: false };
  const none = () => false;
  const claimed = (id) => id === 114;
  let choice = settleTransition(114, undefined, kneel, 1_000, none, claimed);
  assert.equal(choice.play, undefined);
  assert.deepEqual(choice.pending, { animation: 114, until: 1_000 + TRANSITION_SIDECAR_WAIT, standState: 8, moving: false });
  choice = settleTransition(undefined, choice.pending, kneel, 1_200, none, claimed);
  assert.equal(choice.play, undefined);
  assert.ok(choice.pending, "still waiting");
  const pending = choice.pending;
  assert.deepEqual(settleTransition(undefined, pending, kneel, 1_400, () => true, claimed), { play: 114, pending: undefined }, "built: plays");
  assert.deepEqual(settleTransition(undefined, pending, { standState: 0, moving: false }, 1_400, () => true, claimed),
    { play: undefined, pending: undefined }, "stood up meanwhile: dropped");
  assert.deepEqual(settleTransition(undefined, pending, { standState: 8, moving: true }, 1_400, () => true, claimed),
    { play: undefined, pending: undefined }, "walked off: dropped");
  assert.deepEqual(settleTransition(undefined, pending, kneel, 1_000 + TRANSITION_SIDECAR_WAIT, () => true, claimed),
    { play: undefined, pending: undefined }, "too late");
  assert.deepEqual(settleTransition(114, undefined, kneel, 0, () => true, claimed), { play: 114, pending: undefined }, "built at once");
  assert.deepEqual(settleTransition(115, undefined, kneel, 0, none, claimed), { play: undefined, pending: undefined }, "not claimed: nothing to wait for");
});

test("a stunned rider is stunned on the upper body: Stun is on 0x71d800's list and a mount is no standing base", withData, () => {
  assert.equal(animationPlaysOnUpperBody(A.Stun), true);
  const rider = pose({ mounted: true });
  assert.equal(isBaseIdle(rider), false);
  assert.equal(unitActionDisplay("state", true, isBaseIdle(rider)), "upper");
});

test("the renderer: a movement change ends a transition; an edge waits for its clip", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const animate = source.slice(source.indexOf("  #animateUnit("), source.indexOf("  #flatPose("));
  assert.match(animate, /const transitionCut = unit\.transitionMoving !== undefined\s+&& unit\.transitionMoving !== isUnitMoving\(pose\.movementFlags, pose\.spline\);/);
  assert.match(animate, /if \(deathTransition \|\| unit\.overlayPreservesLocomotion === true \|\| transitionCut/);
  assert.match(animate, /if \(object\.fallJumped !== undefined\) pose\.fallJumped = object\.fallJumped;/);
  assert.match(animate, /pose\.airborneBase = isJumpAnimation\(unit\.animationId\) \? unit\.animationId : null;/);
  const poseUnit = source.slice(source.indexOf("  #poseUnit("), source.indexOf("  #showUnitAction("));
  assert.match(poseUnit, /settleTransition\(poseTransition\(unit\.pose, pose\), unit\.pendingTransition/);
  assert.match(poseUnit, /unit\.transitionMoving = moving;/);
  assert.ok(poseUnit.indexOf("unit.transitionMoving = undefined;") < poseUnit.indexOf("#showUnitAction("));
});
