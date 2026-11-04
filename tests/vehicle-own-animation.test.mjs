// 11.02 (04.11): what a vehicle plays for its seats (Wow.exe 0x0074be80, 0x007489c0, 0x00756f80, 0x00748070) and the passenger's
// upper body and landing (0x007385c0, 0x007485b0, 0x0074b9c0), on a real mixer where it matters.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  SEAT_VEHICLE_ANIM_FLAGS, SEAT_VEHICLE_WAIT_SECONDS, VehicleOwnAnimations, boneSubtreeClip, seatVehicleAnimation, seatVehicleWaitSeconds,
} from "../dist/code/browser/VehicleOwnAnimation.js";
import { SEAT_TRANSITION_FLAGS, VehicleSeatTransitions } from "../dist/code/browser/VehicleSeatTransition.js";
import { seatSplitsPose, seatUpperMove, vehiclePassengerSeatPose, vehicleSeatTransition, vehicleSeatTransitionPose } from "../dist/code/browser/VehicleSeatPose.js";

const F = SEAT_VEHICLE_ANIM_FLAGS;
const seat = (over = {}) => ({
  flags: 0, vehicleEnterAnim: 226, vehicleExitAnim: 228, vehicleRideAnimLoop: 227,
  vehicleEnterAnimBone: 1, vehicleExitAnimBone: 26, vehicleRideAnimLoopBone: -1, vehicleEnterAnimDelay: 0.75, vehicleExitAnimDelay: 9, ...over,
});

test("which animation a seat asks for, by its flags", () => {
  assert.equal(seatVehicleAnimation(seat(), "enter"), undefined, "no Flags 0x400000");
  assert.deepEqual(seatVehicleAnimation(seat({ flags: F.ENTER }), "enter"), { animation: 226, keyBone: 1 });
  assert.equal(seatVehicleAnimation(seat({ flags: F.ENTER }), "ride"), undefined);
  assert.deepEqual(seatVehicleAnimation(seat({ flags: F.RIDE }), "ride"), { animation: 227, keyBone: undefined }, "bone −1 is the whole model");
  assert.deepEqual(seatVehicleAnimation(seat({ flags: F.EXIT_VOLUNTARY }), "exit"), { animation: 228, keyBone: undefined }, "the root key bone is the whole model");
  assert.deepEqual(seatVehicleAnimation(seat({ flags: F.EXIT_FORCED }), "exit"), { animation: 228, keyBone: undefined });
  assert.equal(seatVehicleAnimation(seat({ flags: F.ENTER, vehicleEnterAnim: -1 }), "enter"), undefined);
  assert.equal(seatVehicleAnimation(seat({ flags: F.ENTER, vehicleEnterAnim: 0x1fa }), "enter"), undefined);
  assert.deepEqual(seatVehicleAnimation(seat({ flags: F.ENTER, vehicleEnterAnimBone: 0x23 }), "enter"), { animation: 226, keyBone: undefined }, "past the table: the root");
});

test("how the passenger waits: the column with its flag, else for the animation", () => {
  assert.equal(seatVehicleWaitSeconds(seat(), "enter"), undefined);
  assert.equal(seatVehicleWaitSeconds(seat({ flags: F.WAIT_DELAY_ENTER }), "enter"), 0.75);
  assert.equal(seatVehicleWaitSeconds(seat({ flags: F.WAIT_DELAY_ENTER }), "exit"), undefined, "each way its own flag");
  assert.equal(seatVehicleWaitSeconds(seat({ flags: F.WAIT_DELAY_EXIT }), "exit"), SEAT_VEHICLE_WAIT_SECONDS, "at most 3 seconds");
});

// A three-bone rig: bone0 the root, bone1 its child, bone2 a child of bone1.
const PARENTS = [-1, 0, 1];
const UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const held = (name, bones, quaternion, duration = 1) => new THREE.AnimationClip(name, duration, bones.map((bone) =>
  new THREE.QuaternionKeyframeTrack(`bone${bone}.quaternion`, [0, duration], [...quaternion.toArray(), ...quaternion.toArray()])));
function rig() {
  const root = new THREE.Group();
  const bones = PARENTS.map((_, index) => Object.assign(new THREE.Object3D(), { name: `bone${index}` }));
  root.add(bones[0]);
  bones[0].add(bones[1]);
  bones[1].add(bones[2]);
  const mixer = new THREE.AnimationMixer(root);
  const base = mixer.clipAction(held("base", [0, 1, 2], new THREE.Quaternion()));
  base.play();
  return { bones, mixer, model: { mixer, parents: PARENTS, keyBones: [-1, 1] } };
}
const turned = (bone) => Math.abs(bone.quaternion.x - UP.x) < 0.01;

test("the cut holds the bone and what hangs from it, once per clip and bone", () => {
  const clip = held("own", [0, 1, 2], UP);
  const cut = boneSubtreeClip(clip, PARENTS, 1);
  assert.deepEqual(cut.tracks.map((track) => track.name), ["bone1.quaternion", "bone2.quaternion"]);
  assert.equal(boneSubtreeClip(clip, PARENTS, 1), cut);
});

test("an animation on a key bone owns that bone and leaves the rest to the base", () => {
  const { bones, mixer, model } = rig();
  const own = new VehicleOwnAnimations();
  const clip = held("own", [0, 1, 2], UP, 5);
  const ended = [];
  own.play(7n, 9n, "enter", { animation: 226, keyBone: 1 }, 0);
  own.step(7n, model, 0, () => clip, (guid) => ended.push(guid));
  own.step(7n, model, 1000, () => clip, (guid) => ended.push(guid));
  mixer.update(1);
  assert.equal(turned(bones[1]), true, "the base did not average it away");
  assert.equal(turned(bones[2]), true);
  assert.equal(turned(bones[0]), false, "above the bone stays the base's");
  assert.deepEqual(ended, []);
  own.step(7n, model, 5000, () => clip, (guid) => ended.push(guid));
  assert.deepEqual(ended, [9n], "the passenger hears the end");
  own.step(7n, model, 5000 + 400, () => clip, (guid) => ended.push(guid));
  assert.equal(own.size, 0, "faded out and gone");
  mixer.update(0.01);
  assert.equal(turned(bones[1]), false);
});

test("a clip the model has not got ends at once, one still coming waits", () => {
  const { model } = rig();
  const own = new VehicleOwnAnimations();
  const ended = [];
  own.play(7n, 9n, "enter", { animation: 226, keyBone: undefined }, 0);
  own.step(7n, model, 0, () => undefined, (guid) => ended.push(guid));
  assert.deepEqual(ended, [9n]);
  assert.equal(own.size, 0);
  own.play(7n, 9n, "exit", { animation: 228, keyBone: undefined }, 100);
  own.step(7n, model, 200, () => "wait", (guid) => ended.push(guid));
  assert.equal(own.has(7n), true, "still coming");
  own.step(7n, model, 100 + SEAT_VEHICLE_WAIT_SECONDS * 1000, () => "wait", (guid) => ended.push(guid));
  assert.equal(own.has(7n), false, "not past the wait");
  assert.deepEqual(ended, [9n, 9n]);
});

test("a ride loop runs until its passenger leaves, and gives way to a one-shot on its bone", () => {
  const { bones, mixer, model } = rig();
  const own = new VehicleOwnAnimations();
  const loop = held("ride", [0, 1, 2], UP, 1);
  const shot = held("shot", [0, 1, 2], new THREE.Quaternion(), 3);
  const clips = new Map([[227, loop], [228, shot]]);
  own.play(7n, 9n, "ride", { animation: 227, keyBone: undefined }, 0);
  own.step(7n, model, 0, (id) => clips.get(id), () => {});
  own.step(7n, model, 2000, (id) => clips.get(id), () => {});
  mixer.update(2);
  assert.equal(turned(bones[0]), true);
  own.play(7n, 8n, "exit", { animation: 228, keyBone: undefined }, 2000);
  own.step(7n, model, 2000, (id) => clips.get(id), () => {});
  mixer.update(0.1);
  assert.equal(turned(bones[0]), false, "the one-shot's bone");
  own.step(7n, model, 5100, (id) => clips.get(id), () => {});
  own.stopRide(7n, 9n, 6000);
  own.step(7n, model, 6000, (id) => clips.get(id), () => {});
  own.step(7n, model, 7000, (id) => clips.get(id), () => {});
  assert.equal(own.has(7n), false);
});

test("a vehicle gone from view forgets its plays; a passenger gone ends its ride", () => {
  const { model } = rig();
  const own = new VehicleOwnAnimations();
  const clip = held("ride", [0], UP, 1);
  own.play(7n, 9n, "ride", { animation: 227, keyBone: undefined }, 0);
  own.step(7n, model, 0, () => clip, () => {});
  own.sweep((guid) => guid === 7n, 100);
  own.step(7n, model, 2000, () => clip, () => {});
  assert.equal(own.has(7n), false);
  own.play(7n, 9n, "ride", { animation: 227, keyBone: undefined }, 0);
  own.sweep(() => false, 100);
  assert.equal(own.size, 0);
});

test("the passenger's way waits for the vehicle: a set time, or until the animation ends", () => {
  const T = SEAT_TRANSITION_FLAGS;
  const row = {
    flags: T.ENTER, enterPreDelay: 0.5, enterSpeed: 7, enterGravity: 0, enterMinDuration: 0.1, enterMaxDuration: 1, enterMinArcHeight: 0, enterMaxArcHeight: 0,
  };
  const node = new THREE.Object3D();
  const nodeOf = () => node;
  const placed = (at) => {
    node.position.set(10, 0, 0);
    transitions.apply(nodeOf, at);
    return node.position.x;
  };
  const transitions = new VehicleSeatTransitions();
  node.position.set(0, 0, 0);
  transitions.begin(1n, undefined, row, node, 0);
  transitions.hold(1n, 2, false);
  assert.equal(placed(2400), 0, "2 s and the pre-delay: still where it began");
  assert.ok(placed(2600) > 0, "then on its way");
  transitions.clear();
  node.position.set(0, 0, 0);
  transitions.begin(2n, undefined, row, node, 0);
  transitions.hold(2n, 3, true);
  assert.equal(placed(1000), 0);
  transitions.release(2n, 1000);
  assert.equal(placed(1400), 0, "the pre-delay runs from the release");
  assert.ok(placed(1600) > 0);
});

const POSE = {
  flags: 0x2 | 0x4, rideAnimStart: -1, rideAnimLoop: 102, rideUpperAnimStart: 124, rideUpperAnimLoop: 123, exitAnimStart: -1, exitAnimLoop: 38, exitAnimEnd: 39,
};

test("legs and upper body are two layers on a seat with both", () => {
  const both = vehiclePassengerSeatPose({ id: 1, ...POSE });
  assert.deepEqual([...both.wanted], [102], "the base is the legs'");
  assert.deepEqual(both.upper, { start: 124, loop: 123 });
  assert.equal(both.split, true);
  const legs = vehiclePassengerSeatPose({ id: 2, ...POSE, flags: 0x2 });
  assert.equal(legs.upper, undefined, "no Flags 0x4: a stand stays out of the split track");
  assert.equal(legs.split, true);
  const upperOnly = vehiclePassengerSeatPose({ id: 3, ...POSE, flags: 0x4 });
  assert.deepEqual([...upperOnly.wanted], [123], "no legs: the upper pair takes the whole body");
  assert.equal(upperOnly.upper, undefined);
  assert.equal(upperOnly.split, undefined);
  const stand = vehiclePassengerSeatPose({ id: 4, ...POSE, rideUpperAnimLoop: 0 });
  assert.equal(stand.upper, undefined, "BehaviorID 0 does not split");
});

test("over a seat's legs any pose of the unit's own splits, a stand does not", () => {
  const pose = vehiclePassengerSeatPose({ id: 5, ...POSE });
  assert.equal(seatSplitsPose(pose, 51), true);
  assert.equal(seatSplitsPose(pose, 0), false, "Stand");
  assert.equal(seatSplitsPose(vehiclePassengerSeatPose({ id: 6, ...POSE, flags: 0x4 }), 51), false, "no legs: nothing to split over");
  assert.equal(seatSplitsPose(undefined, 51), false);
});

test("the upper start plays once, then the loop", () => {
  const has = () => true;
  const upper = { start: 124, loop: 123 };
  assert.deepEqual(seatUpperMove(upper, true, undefined, false, has), { animation: 124, loop: false });
  assert.equal(seatUpperMove(upper, false, 124, true, has), undefined, "while it plays");
  assert.deepEqual(seatUpperMove(upper, false, 124, false, has), { animation: 123, loop: true });
  assert.deepEqual(seatUpperMove(upper, true, undefined, false, (id) => id === 123), { animation: 123, loop: true }, "no start on this rig");
  assert.equal(seatUpperMove(upper, true, undefined, false, () => false), undefined, "nothing cut yet");
});

test("the landing: ExitAnimEnd at the end of the way out, JumpEnd on the move is JumpLandRun", () => {
  const out = vehicleSeatTransitionPose({ id: 7, ...POSE, flags: 0x8 }, "exit");
  assert.equal(vehicleSeatTransition(out, undefined, 0), 39);
  assert.equal(vehicleSeatTransition(out, undefined, 0x1), 187, "moving forward");
  assert.equal(vehicleSeatTransition(out, undefined, 0x1000), undefined, "falling has its own pose");
  assert.equal(vehicleSeatTransition(out, undefined, 0x20_0000), undefined, "swimming too");
  const always = vehicleSeatTransitionPose({ id: 8, ...POSE, flags: 0x8 | 0x20_0000, exitAnimEnd: 55 }, "exit");
  assert.equal(vehicleSeatTransition(always, undefined, 0x1000), 55, "Flags 0x200000 plays it anyway");
  const none = vehicleSeatTransitionPose({ id: 9, ...POSE, flags: 0x8, exitAnimEnd: -1 }, "exit");
  assert.equal(vehicleSeatTransition(none, undefined, 0), undefined);
  const seated = vehiclePassengerSeatPose({ id: 10, ...POSE });
  assert.equal(vehicleSeatTransition(seated, undefined, 0), undefined, "a seat left without the way out has no landing");
});
