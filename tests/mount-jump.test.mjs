// 03.11 (6.35): the jump chain and the feet after a turn, as the owner saw them go wrong: feet that went on shuffling after the
// body had come round, a horse standing in its landing while it ran on, a landing clip playing on under the next jump.
// Wow.exe's bones on a running jump on RidingHorse (F:\WowOracle\runs\m1, f633–f668): JumpStart, Jump, and at the ground Run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as THREE from "three";
import {
  airborneChanged, chooseAnimation, clipMovingSpeed, drawClipVariation, gaitTimeScale, isUnitMoving, mountPose, mountPoseTransition,
  mountSpecialAnimation, playedSeconds, playsAs, poseAnimation, poseTransition, stepStrafeYaw, strafeYawTarget, strideStartTime,
  turnOnTheSpot,
} from "../dist/code/browser/AnimatedModel.js";
import { blendInto } from "../dist/code/browser/AnimationBlend.js";
import { PLAYBACK_BACKWARD, PLAYBACK_FORWARD, applyPlayback, playbackHolds } from "../dist/code/browser/AnimationPlayback.js";
import { poseTransitionClip } from "../dist/code/browser/UnitFlagPoses.js";
import { ANIMATION_IDS } from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS as F } from "../dist/code/world/MovementProtocol.js";

const { Stand, Walk, Run, JumpStart, Jump, JumpEnd, Fall, JumpLandRun, MountSpecial, ShuffleLeft, ShuffleRight } = ANIMATION_IDS;
const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");

function methods(names, dependencies) {
  const parsed = ts.createSourceFile("renderer.ts", source, ts.ScriptTarget.ES2022, true);
  const renderer = parsed.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "WorldRenderer3D");
  const members = names.map((name) => {
    const member = renderer.members.find((candidate) => candidate.name?.getText(parsed) === name);
    assert.ok(member, name);
    return member.getText(parsed).replaceAll("#", "");
  });
  const body = ts.transpileModule(`class Harness { ${members.join("\n")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const deps = { THREE, ...dependencies };
  return Function(...Object.keys(deps), `${body}; return Harness;`)(...Object.values(deps));
}

const clip = (name, seconds, movingSpeed) => {
  const built = new THREE.AnimationClip(name, seconds, [
    new THREE.VectorKeyframeTrack("bone0.position", [0, seconds], [0, 0, 0, 0, 1, 0]),
  ]);
  if (movingSpeed !== undefined) built.userData.movingSpeed = movingSpeed;
  return built;
};

/** A horse under a rider, driven the way `#animateUnit` drives it: a pose a frame, then the mixer. */
function horse({ landRun = false } = {}) {
  const Harness = methods(["#poseMount", "#baseClipCameRound", "#turnOnTheSpot", "#drawAgainAtCycleEnd", "#playAnimation", "#strideOneShot", "#applyMountGait"], {
    mountPose, mountPoseTransition, poseTransitionClip, mountSpecialAnimation, chooseAnimation, poseAnimation, airborneChanged, isUnitMoving,
    turnOnTheSpot, clipMovingSpeed, gaitTimeScale, playedSeconds, playsAs, drawClipVariation, strideStartTime, blendInto, applyPlayback, playbackHolds,
    PLAYBACK_BACKWARD, PLAYBACK_FORWARD, TURN_ON_THE_SPOT: [ShuffleLeft, ShuffleRight],
    animationBlend: () => 0.15, clipBlendTime: () => undefined,
  });
  const h = new Harness();
  h.noteStart = () => {}; // 5.05 (11.11): #playAnimation counts the active player's starts (WorldRenderer3D `#noteStart`)
  h.requestAnimations = () => false;
  h.mountSpecials = new Map();
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = "bone0";
  root.add(bone);
  const clips = new Map([
    [Stand, clip("stand", 4)], [Walk, clip("walk", 0.8, 2.5)], [Run, clip("run", 0.8, 6.94)], [JumpStart, clip("jumpstart", 0.467)],
    [Jump, clip("jump", 0.667)], [JumpEnd, clip("jumpend", 1)], [Fall, clip("fall", 0.667)], [MountSpecial, clip("special", 2)],
    [ShuffleLeft, clip("left", 0.5)], [ShuffleRight, clip("right", 0.5)],
  ]);
  if (landRun) clips.set(JumpLandRun, clip("landrun", 0.8, 6.94));
  const mount = {
    skinned: { mixer: new THREE.AnimationMixer(root) },
    template: { clips, overlayClips: new Map(), animations: new Set(clips.keys()), parents: [-1] },
    action: undefined, animationId: -1, overlayUntil: 0, animationMode: PLAYBACK_FORWARD,
  };
  const unit = { mount, strafeYawTurning: 0 };
  let now = 1_000;
  const frame = (flags, seconds = 1 / 30, extra = {}, speed = 7) => {
    h.poseMount(unit, 1n, { movementFlags: flags, dead: false, standState: 0, mounted: true, spline: false, fallJumped: true, ...extra }, now, undefined, speed);
    mount.skinned.mixer.update(seconds);
    now += seconds * 1000;
    return mount.animationId;
  };
  const run = (flags, seconds, extra, speed) => {
    let last;
    for (let t = 0; t < seconds - 1e-6; t += 1 / 30) last = frame(flags, 1 / 30, extra, speed);
    return last;
  };
  return { h, mount, clips, frame, run };
}

const air = F.falling;
const forward = F.forward;

test("a running jump on a horse: JumpStart, Jump, and at the ground straight back to the run", () => {
  const { frame, run, mount } = horse();
  assert.equal(run(forward, 0.5), Run);
  assert.equal(frame(forward | air), JumpStart, "off the ground");
  assert.equal(run(forward | air, 0.4), JumpStart);
  assert.equal(run(forward | air, 0.2), Jump, "the takeoff has run out in the air");
  assert.equal(frame(forward), Run, "at the ground: no JumpEnd, not for a moment");
  assert.notEqual(mount.action.getClip().name, "jumpend");
});

test("JumpLandRun where the horse has one, at the speed it is travelling", () => {
  const { frame, run, mount } = horse({ landRun: true });
  run(forward, 0.3);
  frame(forward | air);
  run(forward | air, 0.6);
  assert.equal(frame(forward, 1 / 30, {}, 14), JumpLandRun);
  assert.equal(mount.action.getEffectiveTimeScale(), 2, "14 yd/s on a stride for 6.94");
  assert.equal(run(forward, 0.35, {}, 14), JumpLandRun, "still in it");
  assert.equal(run(forward, 0.1, {}, 14), Run, "and over in half its length");
});

test("going over a rise is no jump: the gait goes on, up and down", () => {
  const { frame, run } = horse();
  run(forward, 0.3);
  // A walk-off: the fall has no jump in it, and it is not far yet.
  assert.equal(frame(forward | air, 1 / 30, { fallJumped: false }), Run);
  assert.equal(run(forward | air, 0.2, { fallJumped: false }), Run);
  assert.equal(frame(forward), Run, "no landing either");
  // Far: it falls, and the landing is the one of a fall.
  run(forward | air, 0.1, { fallJumped: false });
  assert.equal(frame(forward | air | F.fallingFar, 1 / 30, { fallJumped: false }), Fall);
  assert.equal(frame(forward), Run);
});

test("a landing on the spot is JumpEnd, and it gives way to moving off and to the next jump", () => {
  const { frame, run } = horse();
  run(0, 0.3);
  frame(air);
  run(air, 0.6);
  assert.equal(frame(0), JumpEnd);
  assert.equal(run(0, 0.2), JumpEnd);
  assert.equal(frame(forward), Run, "setting off ends it at once");
  // The next jump out of a landing.
  const again = horse();
  again.run(0, 0.3);
  again.frame(air);
  again.run(air, 0.6);
  assert.equal(again.frame(0), JumpEnd);
  assert.equal(again.run(0, 0.2), JumpEnd);
  assert.equal(again.frame(air), JumpStart, "a jump does not wait for the landing to finish");
  // And a landing that comes while the takeoff is still playing cuts it.
  const short = horse();
  short.run(0, 0.3);
  short.frame(air);
  assert.equal(short.run(air, 0.2), JumpStart);
  assert.equal(short.frame(0), JumpEnd);
});

test("a stride one-shot takes the declared speed: the frame of a landing measures the fall as well", () => {
  assert.match(source, /unit\.travelSpeed = unitTravelSpeed\(pose, object\.speeds, object\.runSpeed\);/);
  assert.match(source, /this\.#strideOneShot\(unit, unit\.travelSpeed, now\);/);
  assert.match(source, /this\.#poseMount\(unit, object\.guid, pose, now, client, unit\.travelSpeed\);/);
});

test("an edge is a change of the ground under a unit, or of a walk-off into a fall", () => {
  const pose = (movementFlags, fallJumped) => ({ movementFlags, fallJumped, dead: false, standState: 0 });
  assert.equal(airborneChanged(undefined, pose(air)), false, "no earlier frame, no edge");
  assert.equal(airborneChanged(pose(0), pose(forward)), false);
  assert.equal(airborneChanged(pose(0), pose(air)), true);
  assert.equal(airborneChanged(pose(air), pose(0)), true);
  assert.equal(airborneChanged(pose(air), pose(air)), false);
  assert.equal(airborneChanged(pose(air, false), pose(air | F.fallingFar, false)), true, "a walk-off become a fall");
  // The unit's transitions read the same half as a horse's.
  assert.equal(poseTransition(pose(0), pose(air, true)), JumpStart);
  assert.equal(poseTransition(pose(0), pose(air, false)), undefined);
  assert.equal(poseTransition(pose(0), pose(air | F.fallingFar, false)), undefined, "off a ledge in one frame: a fall, no takeoff");
  assert.equal(poseTransition(pose(air, true), pose(0)), JumpEnd);
  assert.equal(poseTransition(pose(air, true), pose(forward)), JumpLandRun);
  assert.equal(poseTransition(pose(air, false), pose(forward)), undefined);
  // The renderer lets an edge through a unit's transition.
  assert.match(source, /isUnitMoving\(pose\.movementFlags, pose\.spline\) \|\| airborneChanged\(unit\.pose, pose\)\);/);
});

test("feet stop shuffling when the body has come home, on the path where no turn is stepped", () => {
  const Harness = methods(["#strafeYawIdle"], {
    strafeYawTarget, strafeYawBonesFor: () => ({ pelvis: 0, torso: [] }),
  });
  const h = new Harness();
  const still = { movementFlags: 0, dead: false, standState: 0 };
  // The step that brings the body home says it moved: that is what starts a Shuffle, and it is true.
  const state = { yaw: 0.001, velocity: 0, hold: 1, turning: 0 };
  stepStrafeYaw(state, 0, still, 1 / 30);
  assert.equal(state.yaw, 0);
  assert.notEqual(state.turning, 0);
  // Nothing steps the turn again from here: the renderer takes the flat path, and the turn has to be let go of there.
  const unit = { strafeYaw: state.yaw, strafeYawTurning: state.turning, strafeYawFacing: 1, node: { rotation: { y: 1 } } };
  assert.equal(h.strafeYawIdle(unit, {}, still), true);
  assert.equal(unit.strafeYawTurning, 0);
  assert.equal(turnOnTheSpot(Stand, ShuffleLeft, still, unit.strafeYawTurning, true), Stand, "so the clip's end hands back");
  // Turned or turning, it is not idle and it keeps what the step said.
  const turned = { strafeYaw: 0.2, strafeYawTurning: 1, strafeYawFacing: 1, node: { rotation: { y: 1 } } };
  assert.equal(h.strafeYawIdle(turned, {}, still), false);
  assert.equal(turned.strafeYawTurning, 1);
  const facing = { strafeYaw: 0, strafeYawTurning: 1, strafeYawFacing: 1, node: { rotation: { y: 1.2 } } };
  assert.equal(h.strafeYawIdle(facing, {}, still), false);
  assert.equal(facing.strafeYawTurning, 1);
});
