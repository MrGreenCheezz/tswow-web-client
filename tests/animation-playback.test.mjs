// 12.10 6.03/6.07 — how Wow.exe plays an animation a model lacks: 0x00826350 walks AnimationData.Fallback and each row
// it leaves adds its Flags (0x10 backwards, 0x20 hold) to a mode that 0x00826b00 applies (modes 1/3 negate the speed
// and start at the end, 2/3 then stop it). See src/browser/AnimationPlayback.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import {
  PLAYBACK_BACKWARD, PLAYBACK_FORWARD, PLAYBACK_HOLD_FIRST, PLAYBACK_HOLD_LAST, applyPlayback, fallbackPlayback,
  playbackHolds, wantedPlayback,
} from "../dist/code/browser/AnimationPlayback.js";
import { chooseAnimation, poseAnimation } from "../dist/code/browser/AnimatedModel.js";
import { ANIMATION_DATA_AVAILABLE, ANIMATION_IDS as A, ANIMATION_PLAYBACK_FLAGS } from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

const withData = { skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data" };
const standing = (extra = {}) => ({ dead: false, movementFlags: 0, spline: false, standState: 0, ...extra });

test("0x00826350: the mode is the Flags of the rows walked, in order", () => {
  // A synthetic table: 1 → 2 → 3 → 4.
  const fallback = { 1: 2, 2: 3, 3: 4 };
  const mode = (flags, from, to) => fallbackPlayback(from, to, flags, fallback);
  assert.equal(mode({}, 1, 1), PLAYBACK_FORWARD, "the model has it");
  assert.equal(mode({}, 1, 3), PLAYBACK_FORWARD, "no bits on the way");
  assert.equal(mode({ 1: 0x10 }, 1, 2), PLAYBACK_BACKWARD);
  assert.equal(mode({ 1: 0x10, 2: 0x10 }, 1, 3), PLAYBACK_FORWARD, "backwards twice is forwards");
  assert.equal(mode({ 1: 0x20 }, 1, 2), PLAYBACK_HOLD_LAST, "offset +1, direction 0: the last frame");
  assert.equal(mode({ 1: 0x10, 2: 0x20 }, 1, 3), PLAYBACK_HOLD_FIRST, "backwards, then held: the first frame");
  assert.equal(mode({ 1: 0x30 }, 1, 2), PLAYBACK_HOLD_FIRST, "both bits on one row: 0x10 first, then 0x20");
  assert.equal(mode({ 1: 0x20, 2: 0x10 }, 1, 3), PLAYBACK_HOLD_LAST, "a hold stays a hold");
  assert.equal(mode({ 3: 0x20 }, 1, 3), PLAYBACK_FORWARD, "the row played is not a row walked");
  assert.equal(mode({ 1: 0x10 }, 1, 9), PLAYBACK_FORWARD, "not on the chain: a later rung, played as asked");
  assert.equal(playbackHolds(PLAYBACK_HOLD_FIRST) && playbackHolds(PLAYBACK_HOLD_LAST), true);
  assert.equal(playbackHolds(PLAYBACK_FORWARD) || playbackHolds(PLAYBACK_BACKWARD), false);
});

test("this build's AnimationData: the rows the owner sees", withData, () => {
  assert.equal(ANIMATION_PLAYBACK_FLAGS[A.LootHold], 0x20);
  assert.equal(ANIMATION_PLAYBACK_FLAGS[A.LootUp], 0x10);
  assert.equal(fallbackPlayback(A.LootHold, A.Loot), PLAYBACK_HOLD_LAST, "down at the corpse");
  assert.equal(fallbackPlayback(A.LootUp, A.Loot), PLAYBACK_BACKWARD, "getting up");
  assert.equal(fallbackPlayback(A.Dead, A.Death), PLAYBACK_HOLD_LAST);
  assert.equal(fallbackPlayback(A.KneelLoop, A.KneelStart), PLAYBACK_HOLD_LAST);
  assert.equal(fallbackPlayback(A.KneelEnd, A.KneelStart), PLAYBACK_BACKWARD);
  assert.equal(fallbackPlayback(A.Walkbackwards, A.Walk), PLAYBACK_BACKWARD);
  assert.equal(fallbackPlayback(A.SwimBackwards, A.Swim), PLAYBACK_BACKWARD);
  assert.equal(fallbackPlayback(A.SitGroundUp, A.SitGroundDown), PLAYBACK_BACKWARD);
  assert.equal(fallbackPlayback(A.Sleep, A.SleepDown), PLAYBACK_HOLD_LAST);
  assert.equal(fallbackPlayback(A.Attack2H, A.Attack1H), PLAYBACK_FORWARD, "an attack's chain carries no bit");
  // A wanted list: the first rung whose chain reaches the answer.
  assert.equal(wantedPlayback([A.Walkbackwards, A.Walk], A.Walk), PLAYBACK_BACKWARD);
  assert.equal(wantedPlayback([A.KneelLoop, A.SitGround], A.KneelStart), PLAYBACK_HOLD_LAST);
  assert.equal(wantedPlayback([A.KneelLoop, A.SitGround], A.SitGround), PLAYBACK_FORWARD, "a later rung of its own");
  assert.equal(wantedPlayback([A.Stand], undefined), PLAYBACK_FORWARD);
});

test("chooseAnimation carries the mode of the base it resolved, and only when it is not forwards", withData, () => {
  const rig = (...ids) => new Map(ids.map((id) => [id, {}]));
  const back = standing({ movementFlags: MOVEMENT_FLAGS.backward });
  assert.deepEqual(chooseAnimation(rig(A.Stand, A.Walk, A.Run), back), { animation: A.Walk, loop: true, mode: PLAYBACK_BACKWARD },
    "a creature without Walkbackwards walks backwards, not forwards");
  assert.deepEqual(chooseAnimation(rig(A.Stand, A.Walk, A.Walkbackwards), back), { animation: A.Walkbackwards, loop: true });
  assert.deepEqual(chooseAnimation(rig(A.Stand, A.KneelStart), standing({ standState: 8 })),
    { animation: A.KneelStart, loop: true, mode: PLAYBACK_HOLD_LAST }, "a bear kneels and stays down");
  assert.deepEqual(chooseAnimation(rig(A.Stand, A.LootHold), standing({ emoteState: A.LootHold })),
    { animation: A.LootHold, loop: true });
  assert.deepEqual(chooseAnimation(rig(A.Stand, A.Loot), standing({ emoteState: A.LootHold })),
    { animation: A.Loot, loop: true, mode: PLAYBACK_HOLD_LAST }, "STATE_LOOT 428 on a rig without 188: down, not bobbing");
  assert.deepEqual(poseAnimation(standing({ emoteState: A.LootHold })).wanted, [A.LootHold, A.Stand]);
  // Dead → Death keeps playing the dying through, once (the death itself is not modelled apart).
  assert.deepEqual(chooseAnimation(rig(A.Stand, A.Death), standing({ dead: true })), { animation: A.Death, loop: false });
});

/** One bone turning about x from 0 to `angle` over a second. */
function rig() {
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = "bone0";
  root.add(bone);
  const clip = new THREE.AnimationClip("turn", 1, [new THREE.QuaternionKeyframeTrack("bone0.quaternion", [0, 1],
    [...new THREE.Quaternion().toArray(), ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1).toArray()])]);
  const mixer = new THREE.AnimationMixer(root);
  return { bone, clip, mixer };
}
const angle = (bone) => 2 * Math.atan2(bone.quaternion.x, bone.quaternion.w);

test("0x00826b00 on a mixer action: backwards from the end, or held on the first or last frame", () => {
  for (const [mode, loop, steps, expected, label] of [
    [PLAYBACK_FORWARD, true, [0.25], 0.25, "forwards: untouched"],
    [PLAYBACK_BACKWARD, true, [0.25], 0.75, "backwards: from the end"],
    [PLAYBACK_BACKWARD, false, [0.6, 0.6], 0, "a backwards one-shot ends on its first frame"],
    [PLAYBACK_HOLD_LAST, true, [0.25, 0.5, 2], 1, "held on the last frame at once, however long"],
    [PLAYBACK_HOLD_FIRST, true, [0.25, 2], 0, "held on the first frame"],
  ]) {
    const { bone, clip, mixer } = rig();
    const action = mixer.clipAction(clip);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.play();
    applyPlayback(action, mode, loop);
    for (const step of steps) mixer.update(step);
    assert.ok(Math.abs(angle(bone) - expected) < 1e-4, `${label}: ${angle(bone)} vs ${expected}`);
  }
});

test("the renderer plays the base, the transitions and the packet poses in their mode", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const play = source.slice(source.indexOf("  #playAnimation("), source.indexOf("  #clearOverlay("));
  assert.match(play, /mode: PlaybackMode = PLAYBACK_FORWARD,/);
  assert.equal((play.match(/applyPlayback\(/g) ?? []).length, 4, "every start and restart of either slot");
  assert.match(play, /unit\.animationMode = mode;/);
  assert.match(play, /unit\.overlayAnimationMode = mode;/);
  assert.match(play, /if \(held \|\| \(unit\.action\.loop === wantedLoop && unit\.action\.isRunning\(\)\)\) return;/);
  const base = source.slice(source.indexOf("  #poseBase("), source.indexOf("  #playAnimation("));
  assert.match(base, /const mode = gait === chosen\.animation \? chosen\.mode \?\? PLAYBACK_FORWARD : unit\.animationMode;/);
  const poseUnit = source.slice(source.indexOf("  #poseUnit("), source.indexOf("  #showUnitAction("));
  assert.match(poseUnit, /fallbackPlayback\(transition!, overlay\)/);
  const start = source.slice(source.indexOf("  #startUnitAction("), source.indexOf("  #shownAs("));
  assert.match(start, /wantedPlayback\(pending\.wanted, animation\)/);
  const gait = source.slice(source.indexOf("  #applyUnitGait("), source.indexOf("  #poseUnit("));
  assert.match(gait, /unit\.animationMode === PLAYBACK_BACKWARD \? -1 : 1/);
});
