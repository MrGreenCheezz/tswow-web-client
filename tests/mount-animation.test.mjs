// Slice A2: what a mount is allowed to know about its rider, and how fast its stride runs.
//
// Four mechanisms, each of which was a visible defect: the rider's whole pose reaching the horse,
// the horse having no jump one-shots at all, the seat ladder being one id with no flying or
// reclined rung, and every gait being replayed at the speed its author built it for whatever the
// unit was actually doing.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { encodeWvaAnimations } from "../tools/wvm.mjs";
import { decodeWvaAnimations } from "../dist/code/browser/Wvm.js";
import {
  MOUNT_GAIT_MAX_TIME_SCALE, MOUNT_GAIT_MIN_TIME_SCALE,
  chooseAnimation, mountGaitTimeScale, mountPose, mountPoseTransition, mountedRiderAnimations,
  needsSidecarAnimations, poseAnimation, resolveAnimation, resolveMountedRiderAnimation,
  unitTravelSpeed,
  addSkinnedClips, instantiateSkinned, skinnedClipsBoneSpan,
} from "../dist/code/browser/AnimatedModel.js";
import {
  ANIMATION_DATA_AVAILABLE, ANIMATION_FALLBACK, ANIMATION_IDS, BASE_ANIMATIONS,
} from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import {
  UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_STAND,
} from "../dist/code/world/CharacterProgressProtocol.js";

// Every assertion below is about ids AnimationData.dbc assigns, so without a locally generated
// table there is nothing to assert rather than something to fail.
const withAnimationData = {
  skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data",
};

const { Stand, Walk, Run, JumpStart, Jump, JumpEnd, Fall, Swim, Fly, Death, Dead, Mount } = ANIMATION_IDS;

function rider(overrides = {}) {
  return { dead: false, movementFlags: 0, spline: false, standState: UNIT_STAND_STATE_STAND, mounted: true, ...overrides };
}

/** RidingHorse, as measured: it carries all four airborne clips and both gaits. */
const HORSE = new Map([Stand, Walk, Run, JumpStart, Jump, JumpEnd, Fall, Swim, Death, Dead].map((id) => [id, {}]));
/** Gryphon, as measured: Stand, Walk, Run, Fly, Death — and not one of 37/38/39/40. */
const GRYPHON = new Map([Stand, Walk, Run, Fly, Death].map((id) => [id, {}]));

test("A2 a sitting or dead rider does not sit or kill the horse under it", withAnimationData, () => {
  // The defect, at the level that can show it. `#animateUnit` cleared `mounted` and passed the
  // rest of the rider's pose straight through, so both of these used to reach `chooseAnimation`
  // with the state that picks SitGround and Death.
  const seated = mountPose(rider({ standState: UNIT_STAND_STATE_SIT }), HORSE);
  assert.equal(seated.standState, UNIT_STAND_STATE_STAND);
  assert.equal(seated.mounted, false, "or the horse would look for a saddle of its own");
  assert.equal(chooseAnimation(HORSE, seated).animation, Stand);

  for (const dying of [rider({ dead: true }), rider({ standState: UNIT_STAND_STATE_DEAD })]) {
    const pose = mountPose(dying, HORSE);
    assert.equal(pose.dead, false);
    assert.equal(pose.standState, UNIT_STAND_STATE_STAND);
    assert.equal(chooseAnimation(HORSE, pose).animation, Stand,
      "a corpse in a saddle is a frame of the renderer's own making; the horse must not die with it");
  }

  // Travel is the half that does come through, whole.
  const running = mountPose(rider({ movementFlags: MOVEMENT_FLAGS.forward, standState: UNIT_STAND_STATE_SIT }), HORSE);
  assert.equal(chooseAnimation(HORSE, running).animation, Run);
  const walking = mountPose(rider({ movementFlags: MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.walking }), HORSE);
  assert.equal(chooseAnimation(HORSE, walking).animation, Walk, "walk/run selection is untouched");
  const swimming = mountPose(rider({ movementFlags: MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.forward }), HORSE);
  assert.equal(chooseAnimation(HORSE, swimming).animation, Swim);
});

test("A2 an airborne pose the rig cannot answer keeps the gait instead of dropping to Stand", withAnimationData, () => {
  const falling = rider({ movementFlags: MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.falling });

  // RidingHorse can answer it: the airborne flags stay and the arc loops.
  const horse = mountPose(falling, HORSE);
  assert.equal(horse.movementFlags & MOVEMENT_FLAGS.falling, MOVEMENT_FLAGS.falling);
  assert.equal(chooseAnimation(HORSE, horse).animation, Jump);

  // Gryphon cannot — measured: none of JumpStart/Jump/JumpEnd/Fall, and not even the SwimIdle that
  // Fall's own DBC fallback names. Without the fail-open it would resolve nothing, take
  // `chooseAnimation`'s last resort and stop flying in mid-air.
  assert.equal(resolveAnimation(GRYPHON, poseAnimation({ ...horse }).wanted), undefined);
  const gryphon = mountPose(falling, GRYPHON);
  assert.equal(gryphon.movementFlags & (MOVEMENT_FLAGS.falling | MOVEMENT_FLAGS.fallingFar), 0);
  assert.equal(chooseAnimation(GRYPHON, gryphon).animation, Run, "fail open onto the gait it was already in");

  // With no clip map at all — a rig still downloading — nothing is second-guessed.
  assert.equal(mountPose(falling).movementFlags, falling.movementFlags);
});

test("A2 the horse gets the takeoff and the landing the rider deliberately does not", withAnimationData, () => {
  const ground = mountPose(rider({ movementFlags: MOVEMENT_FLAGS.forward }), HORSE);
  const air = mountPose(rider({ movementFlags: MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.falling }), HORSE);

  assert.equal(mountPoseTransition(ground, air), JumpStart);
  assert.equal(mountPoseTransition(air, ground), JumpEnd);
  assert.equal(mountPoseTransition(air, air), undefined, "the arc itself is a loop, not a one-shot");
  assert.equal(mountPoseTransition(undefined, air), undefined, "a mount that appears mid-air has not jumped");

  // No stand-state one-shots: `mountPose` has already pinned the state to STAND, so the pair a
  // unit would answer with SitGroundDown/Up cannot arise at all.
  const seated = mountPose(rider({ standState: UNIT_STAND_STATE_SIT }), HORSE);
  assert.equal(mountPoseTransition(ground, seated), undefined);
  assert.equal(mountPoseTransition(seated, ground), undefined);

  // Water and flight are refused on either side: a flying mount is airborne for the whole flight
  // and its takeoff is not a jump.
  const water = mountPose(rider({ movementFlags: MOVEMENT_FLAGS.swimming }), HORSE);
  assert.equal(mountPoseTransition(ground, water), undefined);
  assert.equal(mountPoseTransition(water, ground), undefined);
  const flying = mountPose(rider({ movementFlags: MOVEMENT_FLAGS.flying }), HORSE);
  assert.equal(mountPoseTransition(ground, flying), undefined);
  assert.equal(mountPoseTransition(flying, ground), undefined);
  assert.equal(mountPoseTransition(ground, mountPose(rider({ flight: true }), HORSE)), undefined,
    "a taxi spline carries its flying bit outside the movement word");

  // Fail-open at the other end: a rig without the clip resolves nothing and keeps its gait. The
  // transition is chosen from the pose and refused by the rig, in that order.
  assert.equal(mountPoseTransition(mountPose(rider({ movementFlags: MOVEMENT_FLAGS.forward }), GRYPHON),
    mountPose(rider({ movementFlags: MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.falling }), GRYPHON)), undefined,
    "Gryphon's airborne pose is cleared before a takeoff can be asked for");
  assert.equal(resolveAnimation(GRYPHON, [JumpStart]), undefined, "and it has no takeoff clip either way");
});

test("A2 the rider's seat ladder names the flying and reclined poses, and stays inside the family", withAnimationData, () => {
  const flyMount = ANIMATION_IDS.FlyMount;
  const reclined = ANIMATION_IDS.ReclinedMount;
  const flyReclined = ANIMATION_IDS.FlyReclinedMount;
  const passenger = ANIMATION_IDS.ReclinedMountPassenger;
  const flyPassenger = ANIMATION_IDS.FlyReclinedMountPassenger;

  assert.deepEqual(mountedRiderAnimations({ movementFlags: 0 }), [Mount]);
  assert.deepEqual(mountedRiderAnimations({ movementFlags: MOVEMENT_FLAGS.flying }), [flyMount, Mount]);
  assert.deepEqual(mountedRiderAnimations({ movementFlags: 0, flight: true }), [flyMount, Mount],
    "a taxi spline's own flying bit counts too");
  assert.deepEqual(mountedRiderAnimations({ movementFlags: 0, mountSeat: "reclined" }), [reclined, Mount]);
  assert.deepEqual(mountedRiderAnimations({ movementFlags: MOVEMENT_FLAGS.flying, mountSeat: "reclined" }),
    [flyReclined, reclined, flyMount, Mount]);
  assert.deepEqual(mountedRiderAnimations({ movementFlags: 0, mountSeat: "reclinedPassenger" }),
    [passenger, reclined, Mount], "a passenger's pose has no reins in it, and the driver's does");
  assert.deepEqual(mountedRiderAnimations({ movementFlags: MOVEMENT_FLAGS.flying, mountSeat: "reclinedPassenger" }),
    [flyPassenger, passenger, flyReclined, reclined, Mount]);

  // Every ladder ends at 91 and none of them ends at Stand: the tail is what the sidecar is asked
  // for, and Stand travels inside every model — a Stand written here would resolve on the spot and
  // nothing would ever be fetched. That is the A1 defect, and it is pinned here too.
  for (const seat of [undefined, "reclined", "reclinedPassenger"]) {
    for (const movementFlags of [0, MOVEMENT_FLAGS.flying]) {
      const ladder = mountedRiderAnimations({ movementFlags, mountSeat: seat });
      assert.equal(ladder.at(-1), Mount, `${seat ?? "upright"} 0x${movementFlags.toString(16)}`);
      assert.ok(!ladder.includes(Stand));
    }
  }

  // The boundary. AnimationData sends FlyMount to FlyStand and on into FlyClose/FlyOpen — a flying
  // creature's idle, not a rider's seat — so the seat resolver refuses to leave the family while
  // the general one happily walks out of it.
  const flyStand = ANIMATION_FALLBACK[flyMount];
  assert.equal(typeof flyStand, "number", "the DBC chain really does lead out of the seat family");
  const wrongRig = new Set([flyStand, Stand]);
  assert.equal(resolveAnimation(wrongRig, [flyMount, Mount]), flyStand, "which is what the general resolver does");
  assert.equal(resolveMountedRiderAnimation(wrongRig, [flyMount, Mount]), undefined,
    "and what a seat request must never do");
  assert.equal(resolveMountedRiderAnimation(new Set([Mount, Stand]), [flyMount, Mount]), Mount);
  assert.equal(resolveMountedRiderAnimation(new Set([flyMount, Mount]), [flyMount, Mount]), flyMount);
});

test("A2 the whole seat ladder is still what the sidecar is asked for", withAnimationData, () => {
  // A freshly built template: the base ids that travel inside the artifact, everything the model
  // says it can play, and `merged` still false. Measured on all 22 playable rigs — every one of
  // them carries 91, 484 and 500, and not one carries 320, 485 or 501.
  const fresh = () => ({
    clips: new Map(BASE_ANIMATIONS.map((id) => [id, {}])),
    animations: new Set([...BASE_ANIMATIONS, Mount, ANIMATION_IDS.ReclinedMount,
      ANIMATION_IDS.ReclinedMountPassenger]),
    merged: false,
  });
  assert.ok(!BASE_ANIMATIONS.includes(Mount), "91 does not travel with the model");

  for (const pose of [
    rider(),
    rider({ movementFlags: MOVEMENT_FLAGS.flying }),
    rider({ mountSeat: "reclined" }),
    rider({ movementFlags: MOVEMENT_FLAGS.flying, mountSeat: "reclinedPassenger" }),
  ]) {
    const wanted = poseAnimation(pose).wanted;
    assert.equal(needsSidecarAnimations(fresh(), wanted, "mount"), true,
      `the seat ladder ${wanted.join(",")} has to reach the sidecar`);
  }

  // And the boundary decides the request as well as the drawing. A rig whose only answer is the
  // wrong side of the DBC chain must still be asked for the seat it really has, or the request
  // would be skipped and the pose promised by nothing.
  //
  // S2 widened the third argument from `mounted: boolean` to the family name, because the crouch
  // ladder needs a third boundary of its own; "mount" is what `true` used to mean here.
  const flyStandRig = {
    clips: new Map([[ANIMATION_FALLBACK[ANIMATION_IDS.FlyMount], {}]]),
    animations: new Set([ANIMATION_FALLBACK[ANIMATION_IDS.FlyMount], Mount]),
    merged: false,
  };
  const flying = poseAnimation(rider({ movementFlags: MOVEMENT_FLAGS.flying })).wanted;
  assert.equal(needsSidecarAnimations(flyStandRig, flying, "any"), false,
    "the general resolver thinks the rig can already answer");
  assert.equal(needsSidecarAnimations(flyStandRig, flying, "mount"), true,
    "the seat resolver knows it cannot, and asks");

  // Once the sidecar is in, nothing is asked for again.
  const merged = { ...fresh(), merged: true };
  assert.equal(needsSidecarAnimations(merged, poseAnimation(rider()).wanted, "mount"), false);
});

test("A2 the gait is replayed at the speed the unit is really travelling", withAnimationData, () => {
  // RidingHorse, measured: Run is authored for 6.9444 yards a second and Walk for 2.5. Base run in
  // 3.3.5a is 7.0, so an unmounted-speed rider is already at the authored rate and a +100% mount
  // covers twice the ground with the same stride.
  const runStride = 6.9444;
  assert.equal(mountGaitTimeScale(7.0, runStride), 1, "the stride's own speed is rate 1");
  assert.equal(mountGaitTimeScale(14.0, runStride), MOUNT_GAIT_MAX_TIME_SCALE,
    "and a +100% mount saturates the upper bound rather than blurring the legs");
  assert.equal(mountGaitTimeScale(11.2, runStride), MOUNT_GAIT_MAX_TIME_SCALE, "so does +60%");
  assert.equal(mountGaitTimeScale(1.0, runStride), MOUNT_GAIT_MIN_TIME_SCALE, "and a snared one the lower");
  assert.equal(mountGaitTimeScale(2.5, 2.5), 1, "walk against its own authored walk");

  // Quantised to twentieths, so the rate changes only when the speed really has and by a step the
  // eye cannot pick out. Deliberately not a lerp: a lerp moves by an amount that depends on how
  // long the frame was, and this client compares bones between runs.
  assert.equal(mountGaitTimeScale(7.5, runStride), 1.1);
  assert.equal(mountGaitTimeScale(7.51, runStride), 1.1, "a hair more speed is the same rate");
  assert.equal(mountGaitTimeScale(8.0, runStride), 1.15);
  for (const speed of [3, 5, 7, 9, 11, 13]) {
    const scale = mountGaitTimeScale(speed, runStride);
    assert.ok(Math.abs(scale / 0.05 - Math.round(scale / 0.05)) < 1e-9, `${speed} lands on a step`);
    assert.ok(scale >= MOUNT_GAIT_MIN_TIME_SCALE && scale <= MOUNT_GAIT_MAX_TIME_SCALE);
  }

  // Everything that is not a number is rate 1, which is what the renderer did for every clip
  // before this existed: no speed known, no authored stride, a stride authored at zero (40 of
  // RidingHorse's 43 sequences), a standing unit.
  assert.equal(mountGaitTimeScale(undefined, runStride), 1);
  assert.equal(mountGaitTimeScale(7, undefined), 1);
  assert.equal(mountGaitTimeScale(7, 0), 1);
  assert.equal(mountGaitTimeScale(0, runStride), 1);
  assert.equal(mountGaitTimeScale(Number.NaN, runStride), 1);
  assert.equal(mountGaitTimeScale(Number.POSITIVE_INFINITY, runStride), 1,
    "an infinity is not a speed the clamp should be asked to interpret");
  // Signed on the wire and a magnitude here: RidingHorse authors −2.5 on Walkbackwards.
  assert.equal(mountGaitTimeScale(2.5, -2.5), 1);
  assert.equal(mountGaitTimeScale(-2.5, 2.5), 1);
});

test("A2 the travelling speed is taken from the movement the unit is actually performing", withAnimationData, () => {
  const speeds = new Map([["walk", 2.5], ["run", 14], ["runBack", 4.5], ["swim", 4.7],
    ["swimBack", 2.5], ["flight", 20], ["flightBack", 4.7]]);

  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.forward }), speeds, 7), 14);
  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.walking }), speeds, 7), 2.5);
  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.backward }), speeds, 7), 4.5);
  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.forward }), speeds, 7), 4.7);
  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.backward }), speeds, 7), 2.5);
  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.flying }), speeds, 7), 20);
  assert.equal(unitTravelSpeed(rider({ movementFlags: 0, flight: true }), speeds, 7), 20);

  // A spline says it outright, and outranks every rate: it is the only thing that is true of a
  // creature nobody is driving, where the walking flag is absent by construction.
  assert.equal(unitTravelSpeed(rider({ speed: 3.2, movementFlags: MOVEMENT_FLAGS.forward }), speeds, 7), 3.2);

  // The create block's copy is the last word, and only for running.
  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.forward }), undefined, 7), 7);
  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.walking }), undefined, 7),
    undefined, "a walk rate nobody sent is not the run rate");
  assert.equal(unitTravelSpeed(rider(), undefined, undefined), undefined);
  assert.equal(unitTravelSpeed(rider({ movementFlags: MOVEMENT_FLAGS.forward }), new Map([["run", 0]]), undefined),
    undefined, "zero is not a speed");
});

test("A2 the clip extras table round-trips, and its absence is the old layout byte for byte", withAnimationData, () => {
  const channels = [{
    bone: 0, kind: 1,
    times: Uint32Array.from([0, 500]),
    values: Int16Array.from([0, 0, 0, 32767, 0, 0, 0, 32767]),
  }];
  // The three numbers, as RidingHorse authors them, plus the two cases that mean "nothing here".
  const withExtras = [
    { animationId: Walk, duration: 800, blendTime: 150, movingSpeed: 2.5, variationNext: -1, variationIndex: 0, channels },
    { animationId: Run, duration: 800, blendTime: 150, movingSpeed: 6.9444, variationNext: -1, variationIndex: 19, channels },
    { animationId: Stand, duration: 4000, blendTime: 150, movingSpeed: 0, variationNext: 15, variationIndex: 1, channels },
    { animationId: JumpStart, duration: 833, blendTime: 50, movingSpeed: 0, variationNext: -1, variationIndex: 15, channels },
  ];
  const plain = withExtras.map(({ movingSpeed, variationNext, variationIndex, ...clip }) => clip);

  const encoded = encodeWvaAnimations(1, withExtras);
  const decoded = new Map(decodeWvaAnimations(
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength), 1,
  ).map((clip) => [clip.animationId, clip]));

  // Yards a second on the wire and in the browser, and signed magnitudes are preserved exactly.
  assert.ok(Math.abs(decoded.get(Walk).movingSpeed - 2.5) < 1e-6);
  assert.ok(Math.abs(decoded.get(Run).movingSpeed - 6.9444) < 1e-4);
  assert.equal(decoded.get(Stand).movingSpeed, undefined,
    "a stride authored at zero is the absence of a speed, not the number zero");
  assert.equal(decoded.get(Stand).variationNext, 15, "and the follower it does author survives");
  assert.equal(decoded.get(Run).variationNext, undefined, "while −1 means nothing follows");
  assert.equal(decoded.get(JumpStart).variationIndex, 15);
  // Nothing the older half of the header carried moved.
  assert.equal(decoded.get(Walk).blendTime, 0.15);
  assert.equal(decoded.get(JumpStart).blendTime, 0.05);
  assert.equal(decoded.get(Run).duration, 0.8);
  assert.equal(decoded.get(Run).channels.length, 1);

  // Without the block: not one byte different from what A1 wrote, and every field simply absent.
  const bare = encodeWvaAnimations(1, plain);
  const clipBytes = 12 + 8 + 2 * 4 + 2 * 4 * 2;
  assert.equal(bare.length, 12 + 4 * clipBytes, "a clip list with nothing to add adds nothing");
  assert.equal(encoded.length, bare.length + 8 + 4 * 8, "and the table is its header plus one record a clip");
  const old = new Map(decodeWvaAnimations(
    bare.buffer.slice(bare.byteOffset, bare.byteOffset + bare.byteLength), 1,
  ).map((clip) => [clip.animationId, clip]));
  for (const clip of old.values()) {
    assert.equal(clip.movingSpeed, undefined);
    assert.equal(clip.variationNext, undefined);
    assert.equal(clip.variationIndex, undefined);
  }
  assert.equal(old.get(Walk).blendTime, 0.15, "which is exactly a pre-A2 artifact, still decoding");

  // A container whose trailing bytes are not the table is a container this reader does not
  // understand, and saying so beats posing a model with half a file.
  const corrupt = Uint8Array.from(encoded);
  corrupt[bare.length] = 0x57 ^ 0xff;
  assert.throws(() => decodeWvaAnimations(corrupt.buffer.slice(0, corrupt.byteLength), 1),
    /followed by an unknown block/);

  // The table is dense and positional, so a count that disagrees with the clips would pair a
  // stride with another clip's keyframes.
  const miscounted = Uint8Array.from(encoded);
  new DataView(miscounted.buffer).setUint16(bare.length + 6, 3, true);
  assert.throws(() => decodeWvaAnimations(miscounted.buffer.slice(0, miscounted.byteLength), 1),
    /extras count disagrees/);
});

// ── Slice M1: the rider's rig lives inside the mount's bones, and both name bones by index ──────
//
// The owner's report, verbatim: «вместо передних копыт у лошади используются ноги персонажа». It is
// not a merge of the wrong keyframes into the wrong template — the sidecar store keys every decoded
// set by `(path, bones)` (`animationKey`), and each of the four `client.animations(...)` call sites
// pairs a template with its own model path. It is a *binding* crossing two rigs: `#seatRider`
// parents the rider's whole skinned root inside one of the mount's bones, every rig names its bones
// `bone{index}` because the clips name their tracks that way, and three.js resolves a track's node
// by walking the mixer root's subtree by name and taking the first match.

/** A template with nothing in it but the rig, which is all `instantiateSkinned` reads. */
function stubTemplate(parents, pivots) {
  const count = parents.length;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("skinIndex", new THREE.Uint8BufferAttribute(new Uint8Array(count * 4), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  return {
    geometry,
    clips: new Map(),
    animations: new Set(),
    boneInverses: Array.from({ length: count }, () => new THREE.Matrix4()),
    parents: Int16Array.from(parents),
    pivots: Float32Array.from(pivots),
    flags: new Uint16Array(count),
    billboards: [],
    height: 1,
  };
}

/** One quarter-turn track on one bone, which is enough to see where the keyframes landed. */
function quarterTurnClip(bone) {
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  return new THREE.AnimationClip("gait", 1, [new THREE.QuaternionKeyframeTrack(
    `bone${bone}.quaternion`,
    new Float32Array([0, 1]),
    new Float32Array([0, 0, 0, 1, turn.x, turn.y, turn.z, turn.w]),
  )]);
}

test("M1 a mount's own clip stays on the mount's bones with a rider in the saddle", () => {
  // Mount: bone0 root, bone1 the saddle, bone2 a front leg (a later sibling of the saddle, so the
  // depth-first walk reaches the rider before it), bone3 the hoof under it.
  const mount = stubTemplate([-1, 0, 0, 2], [0, 0, 0, 0, 0, 1, 1, 0, 0, 2, 0, 0]);
  // Rider: four bones of its own, a different rig entirely, with the same four names.
  const rider = stubTemplate([-1, 0, 0, 2], [0, 0, 0, 0, 0, 1, 0, 0.2, 0, 0, 0.2, -1]);
  const horse = instantiateSkinned(mount, new THREE.MeshBasicMaterial());
  const character = instantiateSkinned(rider, new THREE.MeshBasicMaterial());

  // `#seatRider`: the rider hangs off the saddle bone, and the mount's gait is chosen afterwards.
  horse.skeleton.bones[1].add(character.root);
  const action = horse.mixer.clipAction(quarterTurnClip(2));
  action.play();
  horse.mixer.update(0.5);

  // Half a second into a one-second quarter turn is 45 degrees, and it belongs to the horse.
  const eighth = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
  // 1e-3 radians is 0.06 degrees: `Quaternion.angleTo` is `2*acos(dot)`, and acos next to 1 turns
  // the slerp's own 1e-9 into 2e-4. The distinction being drawn here is 45 degrees against 0.
  assert.ok(horse.skeleton.bones[2].quaternion.angleTo(eighth) < 1e-3,
    "the mount's own front leg is what its gait keys");
  assert.ok(character.skeleton.bones[2].quaternion.angleTo(new THREE.Quaternion()) < 1e-6,
    "and the rider's leg is untouched by it");
  assert.equal(THREE.PropertyBinding.findNode(horse.root, "bone2"), horse.skeleton.bones[2]);

  // The defect itself, kept as the thing the fix is against: a mixer root with no skeleton of its
  // own resolves `bone2` by walking its whole subtree, and the rider is in that subtree.
  const bare = new THREE.Group();
  bare.add(horse.skeleton.bones[0]);
  assert.equal(THREE.PropertyBinding.findNode(bare, "bone2"), character.skeleton.bones[2],
    "which is how the horse's hoof track reached the character's leg");
});

test("M1 a clip set wider than the rig is refused rather than reskinned", () => {
  const horse = stubTemplate([-1, 0, 0, 2], [0, 0, 0, 0, 0, 1, 1, 0, 0, 2, 0, 0]);
  const humanoid = [{
    animationId: Walk,
    duration: 1000,
    channels: [{ bone: 9, kind: 1, times: [0], values: [0, 0, 0, 32767] }],
  }];
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(addSkinnedClips(horse, humanoid), 0, "a ten-bone set does not fit a four-bone rig");
    assert.equal(addSkinnedClips(horse, humanoid), 0);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(horse.clips.size, 0, "and nothing of it is built");
  assert.equal(horse.animations.size, 0);
  assert.equal(warnings.length, 1, "loudly, and once per rig and span rather than once a frame");
  assert.match(warnings[0], /10 bones refused by a 4-bone rig/);

  // The same set at this rig's own width still merges, so a re-merge stays what it was.
  const fits = [{
    animationId: Walk,
    duration: 1000,
    channels: [{ bone: 3, kind: 1, times: [0], values: [0, 0, 0, 32767] }],
  }];
  assert.equal(addSkinnedClips(horse, fits), 1);
  assert.equal(addSkinnedClips(horse, fits), 0, "and the second pass adds nothing, as it always did");
  assert.equal(skinnedClipsBoneSpan(fits), 4);
  assert.equal(skinnedClipsBoneSpan([]), 0, "an empty set fits every rig");
});
