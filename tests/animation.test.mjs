import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { animationFileSuffix, m2Animations, parseM2Skeleton } from "../tools/m2.mjs";
import { encodeWvaAnimations } from "../tools/wvm.mjs";
import { BASE_ANIMATION_NAMES, baseAnimationIds, loadAnimationCatalog } from "../tools/animations.mjs";
import { decodeWvaAnimations } from "../dist/code/browser/Wvm.js";
import {
  actionAnimation, addSkinnedClips, animationBlend, animationFadeWindow, animationTransition, chooseAnimation, pendingActionExpired,
  pendingActionFate, poseAnimation,
  isTerminalUnitPose, needsSidecarAnimations, poseTransition, readyAnimation, resolveActionAnimation,
  resolveAnimation, resolveSpellVisualAnimation,
  shouldCrossFadeAnimation, shouldStopPreviousAnimation, SHOOT_METADATA_WAIT, weaponPose,
  locomotionBoneMask, locomotionOverlayClip, mountSpecialAnimation, isUnitFlying,
  shouldPromoteActionToLocomotionOverlay,
} from "../dist/code/browser/AnimatedModel.js";
import {
  UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SIT_LOW_CHAIR,
} from "../dist/code/world/CharacterProgressProtocol.js";
import {
  ANIMATION_DATA_AVAILABLE, ANIMATION_FALLBACK, ANIMATION_IDS, BASE_ANIMATIONS, EMOTE_ANIMATIONS,
} from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

let archives;
let catalog;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
  catalog = await loadAnimationCatalog();
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };
const withAnimationData = {
  skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data",
};

const HUMAN_MALE = "Character/Human/Male/HumanMale";
const PLAYABLE_RIGS = [
  "Character/Human/Male/HumanMale", "Character/Human/Female/HumanFemale",
  "Character/NightElf/Male/NightElfMale", "Character/NightElf/Female/NightElfFemale",
  "Character/Orc/Male/OrcMale", "Character/Orc/Female/OrcFemale",
  "Character/Dwarf/Male/DwarfMale", "Character/Dwarf/Female/DwarfFemale",
  "Character/Tauren/Male/TaurenMale", "Character/Tauren/Female/TaurenFemale",
  "Character/Troll/Male/TrollMale", "Character/Troll/Female/TrollFemale",
  "Character/Gnome/Male/GnomeMale", "Character/Gnome/Female/GnomeFemale",
  "Character/BloodElf/Male/BloodElfMale", "Character/BloodElf/Female/BloodElfFemale",
  "Character/Draenei/Male/DraeneiMale", "Character/Draenei/Female/DraeneiFemale",
  // Some client extracts omit the Undead pair; keeping the canonical paths here makes the
  // audit cover them automatically when the archives include them.
  "Character/Scourge/Male/ScourgeMale", "Character/Scourge/Female/ScourgeFemale",
];

/** The model, and the contents of every `.anim` beside it. */
async function loadAnimations(base) {
  const m2 = await archives.read(`${base}.m2`);
  if (!m2) return undefined;
  const animations = m2Animations(m2);
  const files = new Map();
  for (const animation of animations) {
    if (!animation.external || files.has(animation.external)) continue;
    files.set(animation.external, await archives.read(`${base}${animation.external}.anim`));
  }
  return { m2, animations, files };
}

/** Build the same bone hierarchy/clip shape that AnimatedModel hands to THREE's mixer. */
function threeClip(source, skeleton, animationId) {
  const tracks = [];
  for (const channel of source.channels) {
    const name = `bone${channel.bone}`;
    const times = Float32Array.from(channel.times, (time) => time / 1000);
    if (channel.kind === 1) {
      const values = new Float32Array(channel.values.length);
      for (let index = 0; index < channel.values.length; index++) {
        const raw = channel.values[index];
        values[index] = (raw < 0 ? raw + 32768 : raw - 32767) / 32767;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values));
      continue;
    }
    if (channel.kind === 2) {
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, channel.values));
      continue;
    }
    const parent = skeleton.parents[channel.bone];
    const rest = [0, 1, 2].map((axis) =>
      skeleton.pivots[channel.bone * 3 + axis]
      - (parent >= 0 ? skeleton.pivots[parent * 3 + axis] : 0));
    const values = new Float32Array(channel.values.length);
    for (let key = 0; key < times.length; key++) {
      for (let axis = 0; axis < 3; axis++) {
        values[key * 3 + axis] = rest[axis] + channel.values[key * 3 + axis];
      }
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, values));
  }
  return new THREE.AnimationClip(`test-${animationId}`, source.duration / 1000, tracks);
}

function threeRig(parents, pivots) {
  const root = new THREE.Group();
  const bones = [];
  for (let index = 0; index < parents.length; index++) {
    const bone = new THREE.Bone();
    bone.name = `bone${index}`;
    const parent = parents[index];
    const pivot = pivots.slice(index * 3, index * 3 + 3);
    if (parent >= 0) {
      bone.position.set(
        pivot[0] - pivots[parent * 3],
        pivot[1] - pivots[parent * 3 + 1],
        pivot[2] - pivots[parent * 3 + 2],
      );
      bones[parent].add(bone);
    } else {
      bone.position.set(...pivot);
      root.add(bone);
    }
    bones.push(bone);
  }
  return { root, bones, mixer: new THREE.AnimationMixer(root) };
}

/** A unit doing nothing, which every case varies one thing from. */
function standing(overrides = {}) {
  return { dead: false, movementFlags: 0, spline: false, standState: 0, ...overrides };
}

test.after(() => archives?.close());

test("the names the client plays are the ones AnimationData.dbc assigns", withClient, () => {
  // The point of the generated table: before it, seven of the eighteen constants in the browser
  // named a different pose than the constant did, and nothing could tell.
  assert.equal(ANIMATION_IDS.Walkbackwards, catalog.idByName.get("Walkbackwards"));
  assert.equal(ANIMATION_IDS.Fall, catalog.idByName.get("Fall"));
  assert.equal(ANIMATION_IDS.SwimIdle, catalog.idByName.get("SwimIdle"));
  assert.equal(ANIMATION_IDS.Loot, catalog.idByName.get("Loot"));
  assert.equal(ANIMATION_IDS.EmoteTalk, catalog.idByName.get("EmoteTalk"));
  assert.equal(ANIMATION_IDS.SitGround, catalog.idByName.get("SitGround"));
  assert.equal(ANIMATION_IDS.ReadyUnarmed, catalog.idByName.get("ReadyUnarmed"));

  // Every name the exporter ships by has to exist in the table it is read from.
  for (const name of BASE_ANIMATION_NAMES) {
    assert.ok(catalog.idByName.has(name), `${name} is not in AnimationData.dbc`);
  }
  assert.deepEqual([...baseAnimationIds(catalog)].sort((a, b) => a - b), [...BASE_ANIMATIONS]);
});

test("animation blends cross-fade continuous poses and preserve one-shot timing", () => {
  assert.deepEqual(animationBlend(true, true), { duration: 0.18, warp: false },
    "loop cross-fades must not warp clip time; malformed/HD duration ratios otherwise freeze or speed up live poses");
  assert.deepEqual(animationBlend(true, false), { duration: 0.12, warp: false });
  assert.deepEqual(animationBlend(false, true), { duration: 0.12, warp: false });
  assert.deepEqual(animationBlend(false, false), { duration: 0.12, warp: false });
});

test("locomotion overlays filter bilateral lower-body branches instead of freezing the legs", () => {
  // A compact humanoid-like rig: the lower branches drop from the hip and separate laterally,
  // while the upper branch stays high. This is the only skeleton information WVM exposes without
  // names, and it is enough to keep a moving cast from taking over the legs.
  const parents = Int16Array.from([-1, 0, 1, 1, 2, 3]);
  const pivots = Float32Array.from([
    0, 0, 1.0,
    0, 0, 0.9,
    0, -0.2, 0.5,
    0, 0.2, 0.5,
    0, -0.2, 0.1,
    0, 0.2, 0.1,
  ]);
  const mask = locomotionBoneMask(parents, pivots);
  assert.deepEqual([...mask], [1, 1, 1, 1, 1, 1], "both leg branches and their ancestors stay on gait");

  const clip = new THREE.AnimationClip("cast", 0.8, [
    new THREE.QuaternionKeyframeTrack("bone1.quaternion", [0, 0.8], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.QuaternionKeyframeTrack("bone4.quaternion", [0, 0.8], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  const overlay = locomotionOverlayClip(clip, mask);
  assert.deepEqual(overlay.tracks.map((track) => track.name), [],
    "a clip that only keys the lower body becomes a harmless upper-body overlay");
  assert.equal(overlay.duration, clip.duration);
});

test("a moving instant cast leaves the locomotion action driving the legs", () => {
  const parents = [-1, 0, 1, 1, 2, 3];
  const bones = [];
  parents.forEach((parent, index) => {
    const bone = new THREE.Bone();
    bone.name = `bone${index}`;
    if (parent >= 0) bones[parent].add(bone);
    bones.push(bone);
  });
  const mixer = new THREE.AnimationMixer(bones[0]);
  const run = new THREE.AnimationClip("run", 0.8, [
    new THREE.QuaternionKeyframeTrack("bone4.quaternion", [0, 0.4, 0.8], [
      0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, 0, 0, 1,
    ]),
  ]);
  const cast = new THREE.AnimationClip("instant-cast", 0.8, [
    new THREE.QuaternionKeyframeTrack("bone0.quaternion", [0, 0.8], [
      0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2,
    ]),
    new THREE.QuaternionKeyframeTrack("bone4.quaternion", [0, 0.8], [
      0, 0, 0, 1, 0, 0, 0, 1,
    ]),
  ]);
  const mask = locomotionBoneMask(Int16Array.from(parents), Float32Array.from([
    0, 0, 1.0, 0, 0, 0.9, 0, -0.2, 0.5, 0, 0.2, 0.5, 0, -0.2, 0.1, 0, 0.2, 0.1,
  ]));
  const gait = mixer.clipAction(run).setLoop(THREE.LoopRepeat, Infinity).play();
  const overlay = mixer.clipAction(locomotionOverlayClip(cast, mask))
    .setLoop(THREE.LoopOnce, 1).play();
  mixer.update(0.2);
  const legAtStart = bones[4].quaternion.y;
  mixer.update(0.2);
  const legDuringCast = bones[4].quaternion.y;
  assert.notEqual(legAtStart, legDuringCast, "base gait keeps advancing a leg during the cast");
  assert.equal(overlay.isRunning(), true, "the instant cast remains active on its upper layer");
  gait.stop();
});

test("a real character keeps every moving gait under a cast overlay", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded, "HumanMale should be in the client");
  const wanted = new Set([
    ANIMATION_IDS.Run, ANIMATION_IDS.Walkbackwards,
    ANIMATION_IDS.ShuffleLeft, ANIMATION_IDS.ShuffleRight,
    ANIMATION_IDS.RunLeft, ANIMATION_IDS.RunRight,
    ANIMATION_IDS.SpellCastOmni,
  ]);
  const source = parseM2Skeleton(loaded.m2, { wanted, animations: loaded.files });
  assert.ok(source, "HumanMale should expose locomotion and SpellCastOmni clips");
  const parents = Int16Array.from(source.bones.map((bone) => bone.parent));
  const pivots = Float32Array.from(source.bones.flatMap((bone) => bone.pivot));
  const mask = locomotionBoneMask(parents, pivots);
  const lower = [...mask].flatMap((value, bone) => value ? [bone] : []);
  assert.ok(lower.length > 0, "the real rig should expose lower-body bones");

  const castSource = source.clips.find((clip) => clip.animationId === ANIMATION_IDS.SpellCastOmni);
  assert.ok(castSource, "HumanMale should expose SpellCastOmni");
  assert.ok(castSource.channels.some((channel) => channel.bone === 1 && channel.kind === 0),
    "the regression fixture must include HumanMale's keyed root/pelvis translation");
  // Bone numbering belongs to the model generation: HD HumanMale's first spine track is bone3,
  // while the stock rig uses that number for the common leg ancestor. The invariant is that some
  // authored cast branch remains above the model-derived lower-body boundary.
  assert.ok(castSource.channels.some((channel) => mask[channel.bone] === 0),
    "the cast must still have an upper-body branch after the lower-body boundary");
  const cast = threeClip(castSource, { parents, pivots }, ANIMATION_IDS.SpellCastOmni);
  const overlay = locomotionOverlayClip(cast, mask);
  assert.ok(overlay.tracks.length > 0, "the cast should retain upper-body tracks");
  assert.equal(overlay.tracks.some((track) => {
    const match = /^bone(\d+)\./.exec(track.name);
    return match !== null && mask[Number(match[1])] === 1;
  }), false, "the filtered cast must not key any lower-body ancestor");

  const clipById = new Map(source.clips.map((clip) => [clip.animationId, clip]));
  const directions = [
    MOVEMENT_FLAGS.forward, MOVEMENT_FLAGS.backward,
    MOVEMENT_FLAGS.strafeLeft, MOVEMENT_FLAGS.strafeRight,
  ];
  for (const flags of directions) {
    const chosen = chooseAnimation(clipById, standing({ movementFlags: flags }));
    assert.ok(chosen, `HumanMale should expose a gait for flags 0x${flags.toString(16)}`);
    const animationId = chosen.animation;
    const gaitSource = clipById.get(animationId);
    assert.ok(gaitSource, `HumanMale should expose gait clip ${animationId}`);
    assert.equal(poseAnimation({ ...standing({ movementFlags: flags }), spline: false }).wanted[0],
      flags === MOVEMENT_FLAGS.forward ? ANIMATION_IDS.Run
        : flags === MOVEMENT_FLAGS.backward ? ANIMATION_IDS.Walkbackwards
          : flags === MOVEMENT_FLAGS.strafeLeft ? ANIMATION_IDS.RunLeft : ANIMATION_IDS.RunRight,
      `moving flags 0x${flags.toString(16)} should request the authored gait before fallback`);
    const gait = threeClip(gaitSource, { parents, pivots }, animationId);
    const pose = (withCast) => {
      const rig = threeRig(parents, pivots);
      rig.mixer.clipAction(gait).setLoop(THREE.LoopRepeat, Infinity).play();
      if (withCast) rig.mixer.clipAction(overlay).setLoop(THREE.LoopOnce, 1).play();
      rig.mixer.update(0.3);
      rig.root.updateWorldMatrix(true, true);
      return lower.map((bone) => rig.bones[bone].getWorldPosition(new THREE.Vector3()).toArray());
    };
    const basePose = pose(false);
    const castPose = pose(true);
    assert.deepEqual(castPose, basePose,
      `cast must not move lower-body world positions for flags 0x${flags.toString(16)}`);
  }

  // Every ancestor of a lower-body branch is part of the layer boundary. If a cast keys one of
  // those ancestors, its translation/rotation moves the legs even when the thigh tracks were
  // removed. This catches the real HumanMale bone1 translation that the old mask left exposed.
  for (const bone of lower) {
    for (let ancestor = parents[bone]; ancestor >= 0; ancestor = parents[ancestor]) {
      assert.equal(mask[ancestor], 1,
        `bone${ancestor} is an ancestor of lower-body bone${bone} and must stay on locomotion`);
    }
  }
});

test("an idle-to-move transition promotes a still-running one-shot to the upper layer", () => {
  assert.equal(shouldPromoteActionToLocomotionOverlay(true, false, "cast", THREE.LoopOnce), true);
  assert.equal(shouldPromoteActionToLocomotionOverlay(false, false, "cast", THREE.LoopOnce), false,
    "an idle cast still owns the body until movement actually starts");
  assert.equal(shouldPromoteActionToLocomotionOverlay(true, true, "cast", THREE.LoopOnce), false,
    "an existing locomotion overlay must not be promoted twice");
  assert.equal(shouldPromoteActionToLocomotionOverlay(true, false, "cast", THREE.LoopRepeat), false,
    "held actions are not converted while their action record remains authoritative");
  assert.equal(shouldPromoteActionToLocomotionOverlay(true, false, undefined, THREE.LoopOnce), false,
    "pose-only clips have no semantic one-shot owner to transfer");
});

test("mount special resolves to the generated ground/flying mount sequences", () => {
  assert.equal(mountSpecialAnimation(false), ANIMATION_IDS.MountSpecial);
  assert.equal(mountSpecialAnimation(true), ANIMATION_IDS.FlyMountSpecial);
  assert.notEqual(mountSpecialAnimation(false), ANIMATION_IDS.Mount,
    "the mount trick must not replace the persistent gait");
});

test("mount special flight reads the movement flag even without a spline", () => {
  assert.equal(mountSpecialAnimation(isUnitFlying(MOVEMENT_FLAGS.flying)), ANIMATION_IDS.FlyMountSpecial,
    "a standing/hovering flying mount uses the flying special");
  assert.equal(mountSpecialAnimation(isUnitFlying(0)), ANIMATION_IDS.MountSpecial,
    "a ground mount keeps the ground special");
  assert.equal(mountSpecialAnimation(isUnitFlying(0, true)), ANIMATION_IDS.FlyMountSpecial,
    "a flying spline remains supported when its movement word is empty");
});

test("locomotion overlay fades instead of stopping at the blend boundary", () => {
  assert.deepEqual(animationFadeWindow(0.8), { start: 0.68, end: 0.8 });
  assert.deepEqual(animationFadeWindow(0.8, true), { start: 0.8, end: 0.92 });

  const root = new THREE.Bone();
  root.name = "bone0";
  const leg = new THREE.Bone();
  leg.name = "bone1";
  root.add(leg);
  const mixer = new THREE.AnimationMixer(root);
  const gait = mixer.clipAction(new THREE.AnimationClip("gait", 0.8, [
    new THREE.QuaternionKeyframeTrack("bone1.quaternion", [0, 0.8], [
      0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2,
    ]),
  ])).setLoop(THREE.LoopRepeat, Infinity).play();
  const cast = mixer.clipAction(new THREE.AnimationClip("cast", 0.8, [
    new THREE.QuaternionKeyframeTrack("bone0.quaternion", [0, 0.8], [
      0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2,
    ]),
  ])).setLoop(THREE.LoopOnce, 1);
  cast.clampWhenFinished = true;
  cast.play();
  mixer.update(0.68);
  cast.fadeOut(0.12);
  assert.equal(cast.isRunning(), true, "the overlay remains live when its fade window starts");
  const legAtFadeStart = leg.quaternion.y;
  assert.ok(Math.abs(gait.getEffectiveWeight() - 1) < 1e-6,
    "the base gait stays at full weight when the overlay starts fading");
  mixer.update(0.06);
  assert.ok(cast.getEffectiveWeight() > 0 && cast.getEffectiveWeight() < 1,
    "the overlay weight is blended, not snapped");
  assert.ok(Math.abs(gait.getEffectiveWeight() - 1) < 1e-6,
    "the gait is not faded in from zero by the upper-body transition");
  assert.notEqual(leg.quaternion.y, legAtFadeStart, "the leg continues through the fade window");
  mixer.update(0.06);
  assert.ok(gait.getEffectiveWeight() > 0.9, "locomotion owns the layer after the fade window");
  gait.stop();
});

test("the playable-rig audit keeps a small lower-body mask and upper cast tracks", withClient, async () => {
  const audited = [];
  const wanted = new Set([
    ANIMATION_IDS.SpellCastOmni, ANIMATION_IDS.SpellCast, ANIMATION_IDS.AttackUnarmed,
  ]);
  for (const base of PLAYABLE_RIGS) {
    const loaded = await loadAnimations(base);
    if (!loaded) continue;
    const skeleton = parseM2Skeleton(loaded.m2, { wanted, animations: loaded.files });
    assert.ok(skeleton, `${base} should expose one audited action clip`);
    const parents = Int16Array.from(skeleton.bones.map((bone) => bone.parent));
    const pivots = Float32Array.from(skeleton.bones.flatMap((bone) => bone.pivot));
    const mask = locomotionBoneMask(parents, pivots);
    const masked = mask.reduce((sum, value) => sum + value, 0);
    assert.ok(masked > 0, `${base} should have lower-body bones`);
    assert.ok(masked < parents.length * 0.35,
      `${base} lower-body mask should not capture the whole skeleton (${masked}/${parents.length})`);

    const source = skeleton.clips.find((clip) =>
      clip.channels.some((channel) => mask[channel.bone] === 1)
      && clip.channels.some((channel) => mask[channel.bone] !== 1));
    assert.ok(source, `${base} should have an action with lower and upper tracks`);
    const tracks = source.channels.map((channel) => new THREE.NumberKeyframeTrack(
      `bone${channel.bone}.audit`, [0, Math.max(0.001, source.duration / 1000)], [0, 1]));
    const upper = locomotionOverlayClip(
      new THREE.AnimationClip(`audit-${base}`, source.duration / 1000, tracks), mask);
    assert.ok(upper.tracks.length > 0, `${base} cast overlay should retain upper tracks`);
    assert.equal(upper.tracks.some((track) => {
      const bone = Number(/^bone(\d+)/.exec(track.name)?.[1]);
      return mask[bone] === 1;
    }), false, `${base} cast overlay should remove lower tracks`);
    audited.push({ base, bones: parents.length, masked, tracks: source.channels.length });
  }
  assert.ok(audited.length >= 18, `expected the 18 playable rigs in this client, got ${audited.length}`);
});

test("the shipped set is locomotion, and combat is what is held back", () => {
  const base = new Set(BASE_ANIMATIONS);
  for (const name of ["Stand", "Run", "Walkbackwards", "Swim", "SwimIdle", "Fall", "Jump", "Death"]) {
    assert.ok(base.has(ANIMATION_IDS[name]), `${name} should travel with the model`);
  }
  for (const name of ["AttackUnarmed", "Attack2H", "SpellCastOmni", "Loot", "EmoteDance", "SitGround"]) {
    assert.ok(!base.has(ANIMATION_IDS[name]), `${name} should be fetched only when something plays it`);
  }
});

test("an external animation is read from its own file, not from the model", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded, "HumanMale should be in the client");
  const bow = loaded.animations.find((animation) => animation.animationId === ANIMATION_IDS.EmoteBow);
  assert.ok(bow, "HumanMale should have EmoteBow");
  assert.equal(bow.external, animationFileSuffix(ANIMATION_IDS.EmoteBow, 0),
    "EmoteBow keeps its keyframes in a .anim");
  assert.ok(loaded.files.get(bow.external), "and that file should be in the archives");

  const wanted = new Set([ANIMATION_IDS.EmoteBow]);
  const withFile = parseM2Skeleton(loaded.m2, { wanted, animations: loaded.files });
  assert.equal(withFile.clips.length, 1);
  assert.ok(withFile.clips[0].channels.length > 20, "the clip should carry most of the rig");

  // The trap this replaces. The offsets an external sequence holds are addresses in its .anim,
  // and every one of them also lands inside the 1.5 MiB .m2 — so a bounds check alone accepts
  // them and publishes noise. Reading the same tracks out of the model shows what that is worth.
  const wrong = parseM2Skeleton(loaded.m2, { wanted, animations: new Map([[bow.external, loaded.m2]]) });
  const unit = (clip) => {
    let good = 0;
    let total = 0;
    for (const channel of clip.channels) {
      if (channel.kind !== 1) continue;
      for (let key = 0; key < channel.times.length; key++) {
        total++;
        let sum = 0;
        for (let part = 0; part < 4; part++) {
          const raw = channel.values[key * 4 + part];
          const value = (raw < 0 ? raw + 32768 : raw - 32767) / 32767;
          sum += value * value;
        }
        if (Math.abs(Math.sqrt(sum) - 1) < 0.02) good++;
      }
    }
    return { good, total };
  };
  const right = unit(withFile.clips[0]);
  assert.equal(right.good, right.total, "read from the .anim, every rotation key is a unit quaternion");
  const noise = unit(wrong.clips[0]);
  assert.ok(noise.good < noise.total * 0.1,
    `read from the .m2, ${noise.good} of ${noise.total} keys look like rotations — expected almost none`);

  // And with no file at all the clip is skipped rather than invented.
  const without = parseM2Skeleton(loaded.m2, { wanted, animations: new Map() });
  assert.equal(without, undefined);
});

test("an alias animation borrows the sequence that owns the keyframes", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded);
  // EmoteUseStanding has no data of its own: it points at EmoteUseStandingNoSheathe, which points
  // at UseStandingLoop. Two hops, and the file for the last one is the file to open.
  const alias = loaded.animations.find((animation) => animation.animationId === ANIMATION_IDS.EmoteUseStanding);
  assert.ok(alias, "EmoteUseStanding should still be listed");
  assert.equal(alias.external, animationFileSuffix(ANIMATION_IDS.UseStandingLoop, 0),
    "and it should read the file of the sequence it aliases");
  const skeleton = parseM2Skeleton(loaded.m2, { wanted: new Set([alias.animationId]), animations: loaded.files });
  assert.equal(skeleton.clips.length, 1);
  assert.equal(skeleton.clips[0].animationId, ANIMATION_IDS.EmoteUseStanding);
});

test("every animation a character carries reaches the browser, in one file or the other", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded);
  const skeleton = parseM2Skeleton(loaded.m2, { animations: loaded.files });
  assert.equal(skeleton.missingAnimations, 0, "no animation should be left without data");
  const shipped = new Set(BASE_ANIMATIONS);
  const base = skeleton.clips.filter((clip) => shipped.has(clip.animationId));
  const rest = skeleton.clips.filter((clip) => !shipped.has(clip.animationId));
  assert.ok(base.length >= 15, `HumanMale should ship its locomotion, got ${base.length} clips`);
  assert.ok(rest.length >= 100, `and hold back the rest, got ${rest.length} clips`);
  // The swim set is the criterion of this slice, and all five of its poses are in the base file.
  for (const name of ["Swim", "SwimIdle", "SwimLeft", "SwimRight", "SwimBackwards"]) {
    assert.ok(base.some((clip) => clip.animationId === ANIMATION_IDS[name]), `${name} should ship with the model`);
  }
});

test("held-back animations survive the round trip and become playable clips", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded);
  const skeleton = parseM2Skeleton(loaded.m2, {
    wanted: new Set([ANIMATION_IDS.AttackUnarmed, ANIMATION_IDS.Loot]),
    animations: loaded.files,
  });
  const encoded = encodeWvaAnimations(skeleton.bones.length, skeleton.clips);
  const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  const decoded = decodeWvaAnimations(buffer, skeleton.bones.length);
  assert.deepEqual(decoded.map((clip) => clip.animationId).sort((a, b) => a - b),
    [ANIMATION_IDS.AttackUnarmed, ANIMATION_IDS.Loot].sort((a, b) => a - b));
  assert.ok(decoded[0].duration > 0);

  // Pairing a block with the wrong rig would pose bones that mean something else there.
  assert.throws(() => decodeWvaAnimations(buffer, skeleton.bones.length + 1), /rigged for/);

  // Built into a template, they are simply more poses the model can strike.
  const template = {
    clips: new Map(),
    animations: new Set(),
    parents: Int16Array.from(skeleton.bones.map((bone) => bone.parent)),
    pivots: Float32Array.from(skeleton.bones.flatMap((bone) => bone.pivot)),
  };
  assert.equal(addSkinnedClips(template, decoded), decoded.length);
  assert.ok(template.clips.has(ANIMATION_IDS.Loot));
  assert.equal(addSkinnedClips(template, decoded), 0, "and they are not built twice");
});

test("a swimming character swims", () => {
  const { Swim, SwimIdle, SwimLeft, SwimBackwards, Run, Stand } = ANIMATION_IDS;
  const swimming = MOVEMENT_FLAGS.swimming;
  const swimmer = new Map([[Stand, {}], [Run, {}], [Swim, {}], [SwimIdle, {}], [SwimLeft, {}], [SwimBackwards, {}]]);

  // The criterion of this slice: pressing forward in water is not a run.
  const forward = chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.forward }));
  assert.equal(forward.animation, Swim);
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming })).animation, SwimIdle,
    "treading water is its own pose, not standing");
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.backward })).animation, SwimBackwards);
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.strafeLeft })).animation, SwimLeft);
  // Diving is going somewhere, even with no key held: without this the idle plays all the way down.
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.descending })).animation, Swim);
  // Entering the water sets falling and swimming in the same word; the water wins.
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.falling })).animation, SwimIdle);

  // A model that cannot swim keeps moving the way it can, rather than gliding across the lake in
  // its standing pose. The table itself says Swim gives way to Walk; a model with neither ends on
  // the ground pose the preference list carries as its last entry.
  const walker = new Map([[Stand, {}], [Run, {}]]);
  assert.equal(chooseAnimation(walker, standing({ movementFlags: swimming | MOVEMENT_FLAGS.forward })).animation, Run);
  assert.equal(chooseAnimation(new Map([[Stand, {}], [ANIMATION_IDS.Walk, {}]]),
    standing({ movementFlags: swimming | MOVEMENT_FLAGS.forward })).animation, ANIMATION_IDS.Walk,
    "and the table's own chain answers before the last resort does");
});

test("a flying spline selects flight poses even when MovementInfo has no flying bit", () => {
  const { Fly, Hover, Run, Stand } = ANIMATION_IDS;
  const clips = new Map([[Fly, {}], [Hover, {}], [Run, {}], [Stand, {}]]);
  const flight = standing({ spline: true, flight: true, movementFlags: MOVEMENT_FLAGS.forward });
  assert.equal(poseAnimation(flight).wanted[0], Fly);
  assert.equal(chooseAnimation(clips, flight).animation, Fly);
  assert.equal(chooseAnimation(clips, standing({ spline: true, flight: true })).animation, Fly,
    "an active flight spline is moving even when its movement flags are empty");
  // Permission to fly is not the same as actively flying; ordinary spline movement keeps its
  // ground pose until the spline itself carries FLAG_FLYING.
  assert.equal(chooseAnimation(clips, standing({ spline: true, movementFlags: MOVEMENT_FLAGS.canFly })).animation, Run);
});

test("death and corpse poses are terminal, while respawn can choose a live pose", () => {
  const { Death, Dead, Stand } = ANIMATION_IDS;
  const corpse = standing({ dead: true });
  assert.equal(isTerminalUnitPose(corpse), true);
  assert.equal(isTerminalUnitPose(standing({ standState: UNIT_STAND_STATE_DEAD })), true);
  assert.equal(isTerminalUnitPose(standing()), false);
  assert.equal(poseAnimation(corpse).loop, true, "the authored Dead pose is already terminal");
  assert.equal(chooseAnimation(new Map([[Death, {}], [Stand, {}]]), corpse).loop, false);
  assert.equal(chooseAnimation(new Map([[Dead, {}], [Stand, {}]]), corpse).loop, true);
  assert.equal(chooseAnimation(new Map([[Dead, {}], [Stand, {}]]), standing()).animation, Stand);
  assert.equal(chooseAnimation(new Map([[Death, {}], [Stand, {}]]),
    standing({ standState: UNIT_STAND_STATE_DEAD })).loop, false,
    "the replicated dead stand state also clamps fallback Death");
  assert.equal(poseAnimation(standing({ standState: UNIT_STAND_STATE_DEAD })).loop, true,
    "the replicated dead stand state also holds its terminal pose");
});

test("the ground poses follow the direction the unit is going", () => {
  const { Stand, Walk, Run, Walkbackwards, ShuffleLeft, RunRight, Jump, Fall, SitGround } = ANIMATION_IDS;
  const clips = new Map([[Stand, {}], [Walk, {}], [Run, {}], [Walkbackwards, {}], [ShuffleLeft, {}],
    [RunRight, {}], [Jump, {}], [Fall, {}], [SitGround, {}]]);
  const at = (flags, extra = {}) => chooseAnimation(clips, standing({ movementFlags: flags, ...extra })).animation;

  assert.equal(at(0), Stand);
  assert.equal(at(MOVEMENT_FLAGS.forward), Run);
  assert.equal(at(MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.walking), Walk);
  assert.equal(at(MOVEMENT_FLAGS.backward), Walkbackwards, "there is no run-backwards in this build");
  assert.equal(at(MOVEMENT_FLAGS.strafeRight), RunRight);
  assert.equal(at(MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.walking), ShuffleLeft);
  // A diagonal is a run forward, as it is in the original client.
  assert.equal(at(MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.strafeLeft), Run);
  // Turning on the spot is not going anywhere.
  assert.equal(at(MOVEMENT_FLAGS.turnLeft), Stand);
  assert.equal(at(MOVEMENT_FLAGS.falling), Jump);
  assert.equal(at(0, { standState: UNIT_STAND_STATE_SIT }), SitGround);
  // The chair heights sit one place later in the enum than they look like they should, and a list
  // written from memory drew a character on a low chair standing up.
  assert.equal(chooseAnimation(new Map([[Stand, {}], [ANIMATION_IDS.SitChairLow, {}]]),
    standing({ standState: UNIT_STAND_STATE_SIT_LOW_CHAIR })).animation, ANIMATION_IDS.SitChairLow);
  // A creature walking a server-side spline carries no flags at all and still has to move.
  assert.equal(chooseAnimation(clips, standing({ spline: true })).animation, Run);
});

test("a jump is three animations and one flag, so the takeoff and the landing are transitions", () => {
  const ground = standing();
  const air = standing({ movementFlags: MOVEMENT_FLAGS.falling });
  assert.equal(poseTransition(ground, air), ANIMATION_IDS.JumpStart);
  assert.equal(poseTransition(air, ground), ANIMATION_IDS.JumpEnd);
  assert.equal(poseTransition(air, air), undefined);
  assert.equal(poseTransition(undefined, air), undefined, "a unit that appears mid-air has not jumped");
  // Falling into water and swimming out of it are not jumps.
  const water = standing({ movementFlags: MOVEMENT_FLAGS.swimming });
  assert.equal(poseTransition(air, water), undefined);
  assert.equal(poseTransition(water, ground), undefined);
  // Sitting down and standing up have their own one-shots.
  assert.equal(poseTransition(ground, standing({ standState: UNIT_STAND_STATE_SIT })), ANIMATION_IDS.SitGroundDown);
  assert.equal(poseTransition(standing({ standState: UNIT_STAND_STATE_SIT }), ground), ANIMATION_IDS.SitGroundUp);
  // The airborne pose itself loops: an arc lasts as long as the fall does.
  assert.equal(poseAnimation(air).loop, true);
});

test("П2 a rider holds the mount pose whatever the mount is doing, and holds it before the fall", () => {
  const { Mount, Stand, Jump, Run, Swim, Fly } = ANIMATION_IDS;

  // Every flag the mount can be carrying, and the answer is the same one each time: the horse
  // swims and flies and jumps, the character sits. Measured over this build's twenty playable
  // models — all twenty carry 91, none carries 94 MountSpecial or 320 FlyMount — so 91 and then
  // Stand is the whole of the list a player has.
  const flags = [
    0,
    MOVEMENT_FLAGS.forward,
    MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.walking,
    MOVEMENT_FLAGS.backward,
    MOVEMENT_FLAGS.strafeLeft,
    MOVEMENT_FLAGS.swimming,
    MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.descending,
    MOVEMENT_FLAGS.flying,
    MOVEMENT_FLAGS.falling,
    MOVEMENT_FLAGS.fallingFar,
    MOVEMENT_FLAGS.hover,
  ];
  for (const movementFlags of flags) {
    const pose = standing({ mounted: true, movementFlags });
    assert.deepEqual(poseAnimation(pose).wanted, [Mount], `flags 0x${movementFlags.toString(16)}`);
    assert.equal(poseAnimation(pose).loop, true, "a seat is a stance, and a stance repeats");
  }
  // A spline is the taxi case, and it carries the flags of neither.
  assert.deepEqual(poseAnimation(standing({ mounted: true, spline: true, flight: true })).wanted, [Mount]);

  // The branch stands *before* the falling one, and this is the assertion that says so: moved
  // after it, a rider going over a rise reads Jump and the character leaps out of the saddle.
  const clips = new Map([[Mount, {}], [Stand, {}], [Jump, {}], [Run, {}], [Swim, {}], [Fly, {}]]);
  assert.equal(chooseAnimation(clips, standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.falling })).animation,
    Mount, "a falling rider is a rider");
  assert.equal(chooseAnimation(clips, standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.swimming })).animation, Mount);
  assert.equal(chooseAnimation(clips, standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.flying })).animation, Mount);
  // And it stands after `dead`, which outranks it. A corpse in a saddle should not arrive at all —
  // the mount is an aura, and `AuraEffect::HandleAuraMounted` (`SpellAuraEffects.cpp:2624`) calls
  // `Dismount()` on removal, which zeroes the field — but the order says which wins if one does.
  assert.equal(poseAnimation(standing({ mounted: true, dead: true })).wanted[0], ANIMATION_IDS.Dead);

  // Getting on and off has no clip in this build — none of the eight "mount" names in
  // `AnimationData.dbc` is a one-shot mounting — and neither does anything that happens up there.
  const ground = standing();
  const seated = standing({ mounted: true });
  assert.equal(poseTransition(ground, seated), undefined);
  assert.equal(poseTransition(seated, ground), undefined);
  assert.equal(poseTransition(seated, standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.falling })), undefined,
    "and a horse going over a rise does not throw its rider into a JumpStart");
  // The unmounted cases are untouched by that guard.
  assert.equal(poseTransition(ground, standing({ movementFlags: MOVEMENT_FLAGS.falling })), ANIMATION_IDS.JumpStart);
});

test("П2 the seated pose is fetched, not resolved away by a Stand written behind it", () => {
  const { Mount, Stand, Run } = ANIMATION_IDS;
  // What a unit holds the frame it is bound: the 21 base ids that travel inside the artifact, the
  // model's own list of everything it can play, and `merged` still false. That is not a rare state
  // — `#unitKey` appends an appearance digest, so entering the world and every change of armour
  // builds a fresh template — and 91 is in the second list and not the first, because
  // `tools/generate-visual-model.mjs` puts everything outside `BASE_ANIMATION_NAMES` in the sidecar.
  const fresh = () => ({
    clips: new Map(BASE_ANIMATIONS.map((id) => [id, {}])),
    animations: new Set([...BASE_ANIMATIONS, Mount, ANIMATION_IDS.SitGround]),
    merged: false,
  });
  assert.ok(!BASE_ANIMATIONS.includes(Mount), "91 does not travel with the model");
  assert.equal(ANIMATION_FALLBACK[Mount], undefined, "and AnimationData.dbc gives it no substitute");

  // The defect, at the only level that can see it. With Stand written behind it the list resolves
  // against clips that are already built, `#requestAnimations` returns on its first guard, and the
  // rider holds Stand in the saddle until some unrelated emote happens to pull the sidecar in.
  // `chooseAnimation` cannot show this: it is handed a clip map with 91 already in it.
  assert.equal(resolveAnimation(fresh().clips, [Mount, Stand]), Stand);
  assert.equal(needsSidecarAnimations(fresh(), [Mount, Stand]), false,
    "a list whose tail every model carries can never reach the sidecar");

  const wanted = poseAnimation(standing({ mounted: true })).wanted;
  assert.deepEqual(wanted, [Mount]);
  assert.equal(needsSidecarAnimations(fresh(), wanted), true, "so the mounted pose has to ask for 91 itself");
  // Which is exactly how the sitting poses have always behaved — `[SitGround, SitGroundDown]`
  // resolves to neither on a fresh template, and that is why they were never seen to fail.
  assert.equal(needsSidecarAnimations(fresh(),
    poseAnimation(standing({ standState: UNIT_STAND_STATE_SIT })).wanted), true);

  // And what is drawn while the fetch is in flight is unchanged: the rider stands, by
  // `chooseAnimation`'s own last resort rather than by the list.
  assert.equal(chooseAnimation(fresh().clips, standing({ mounted: true })).animation, Stand);
  const seated = fresh();
  seated.clips.set(Mount, {});
  assert.equal(chooseAnimation(seated.clips, standing({ mounted: true })).animation, Mount,
    "and once the sidecar is in, 91");
  assert.equal(needsSidecarAnimations(seated, wanted), false, "with nothing left to ask for");

  // The two guards the first one must not swallow: a model that does not claim the pose never asks
  // — a stand-in creature would otherwise fetch a set it has not got — and one fetch per model.
  assert.equal(needsSidecarAnimations({ clips: new Map([[Stand, {}]]), animations: new Set([Stand, Run]), merged: false },
    wanted), false);
  assert.equal(needsSidecarAnimations({ ...fresh(), merged: true }, wanted), false);
});

test("a completed one-shot is not used as a stale blend source", () => {
  assert.equal(animationTransition(true, true), "crossfade");
  assert.equal(animationTransition(false, true), "stop");
  assert.equal(animationTransition(true, false), "none");
  assert.equal(shouldCrossFadeAnimation(true, true), true, "a live previous pose still blends");
  assert.equal(shouldCrossFadeAnimation(false, true), false, "a clamped reaction must not snap back");
  assert.equal(shouldCrossFadeAnimation(true, false), false, "the same clip never needs a blend");
  assert.equal(shouldStopPreviousAnimation(true, true), false, "a live pose remains the blend source");
  assert.equal(shouldStopPreviousAnimation(false, true), true, "a clamped pose is removed from the mixer");
  assert.equal(shouldStopPreviousAnimation(true, false), false, "the same clip is not stopped");
});

test("a missing pose walks the table's own chain of visual equivalents", () => {
  const { AttackUnarmed, Attack1H, Attack2H, Attack2HL, Stand } = ANIMATION_IDS;
  // Attack2HL gives way to Attack2H, then Attack1H, then AttackUnarmed — three hops of data.
  assert.equal(ANIMATION_FALLBACK[Attack2HL], Attack2H);
  assert.equal(ANIMATION_FALLBACK[Attack2H], Attack1H);
  assert.equal(ANIMATION_FALLBACK[Attack1H], AttackUnarmed);
  assert.equal(resolveAnimation(new Set([AttackUnarmed, Stand]), [Attack2HL]), AttackUnarmed);
  assert.equal(resolveAnimation(new Set([Stand]), [Attack2HL]), undefined, "and it stops when nothing matches");
  // The preference list is tried in order before any chain is walked: a strafe is answered by the
  // sideways pose the model has, not by whatever its first choice happens to fall back to.
  assert.equal(resolveAnimation(new Set([ANIMATION_IDS.ShuffleLeft, ANIMATION_IDS.Run]),
    [ANIMATION_IDS.RunLeft, ANIMATION_IDS.ShuffleLeft]), ANIMATION_IDS.ShuffleLeft);
});

test("the swing a unit makes is the weapon it is visibly holding", () => {
  const mainHand = (inventoryType) => [{ slot: 15, inventoryType }];
  assert.equal(weaponPose(undefined), "unarmed");
  assert.equal(weaponPose([]), "unarmed");
  assert.equal(weaponPose(mainHand(13)), "oneHand", "INVTYPE_WEAPON");
  assert.equal(weaponPose(mainHand(21)), "oneHand", "INVTYPE_WEAPONMAINHAND");
  assert.equal(weaponPose(mainHand(17)), "twoHand", "INVTYPE_2HWEAPON");
  assert.equal(weaponPose([{ slot: 17, inventoryType: 15 }]), "bow");
  assert.equal(weaponPose([{ slot: 17, inventoryType: 26 }]), "gun", "INVTYPE_RANGEDRIGHT");
  assert.equal(weaponPose([{ slot: 17, inventoryType: 26, subClass: 19 }]), "wand",
    "ItemSubClass.Wand overrides the shared ranged-right inventory type");
  assert.equal(weaponPose([{ slot: 17, inventoryType: 25 }]), "thrown");
  // A hunter carries both. What is in the hands decides the melee swing.
  assert.equal(weaponPose([{ slot: 17, inventoryType: 15 }, { slot: 15, inventoryType: 13 }]), "oneHand");
  assert.equal(weaponPose([{ slot: 17, inventoryType: 15 }, { slot: 15, inventoryType: 13 }], "ranged"), "bow",
    "a shot is selected from the ranged slot even while a melee weapon is equipped");
  // A shield is not a weapon and does not change the swing.
  assert.equal(weaponPose([{ slot: 16, inventoryType: 14 }]), "unarmed");

  assert.deepEqual(actionAnimation("attack", "twoHand"),
    [ANIMATION_IDS.Attack2H, ANIMATION_IDS.Attack1H, ANIMATION_IDS.AttackUnarmed]);
  assert.deepEqual(actionAnimation("attack", "unarmed"), [ANIMATION_IDS.AttackUnarmed]);
  assert.deepEqual(actionAnimation("shoot", "bow"),
    [ANIMATION_IDS.FireBow, ANIMATION_IDS.AttackBow],
    "a bow releases its projectile instead of making the generic bow attack");
  assert.deepEqual(actionAnimation("shoot", "gun"),
    [ANIMATION_IDS.AttackRifle, ANIMATION_IDS.FireBow, ANIMATION_IDS.AttackBow]);
  assert.deepEqual(actionAnimation("shoot", "wand"),
    [ANIMATION_IDS.SpellCastDirected, ANIMATION_IDS.SpellCastOmni, ANIMATION_IDS.SpellCast]);
  assert.deepEqual(readyAnimation("bow"), [ANIMATION_IDS.ReadyBow, ANIMATION_IDS.ReadyUnarmed]);
  // A model with only the unarmed swing still swings: every list ends where the chain does.
  assert.equal(resolveAnimation(new Set([ANIMATION_IDS.AttackUnarmed]), actionAnimation("attack", "gun")),
    ANIMATION_IDS.AttackUnarmed);
  assert.equal(resolveAnimation(new Set([ANIMATION_IDS.SpellCastOmni]), actionAnimation("cast", "unarmed")),
    ANIMATION_IDS.SpellCastOmni);
  assert.equal(resolveActionAnimation(new Set([ANIMATION_IDS.AttackUnarmed]), "shoot", "bow"), undefined,
    "a missing ranged clip must never become a melee punch");
  assert.equal(resolveActionAnimation(new Set([ANIMATION_IDS.AttackUnarmed]), "shoot", "wand"), undefined,
    "a missing wand release must stay pose-silent rather than become a melee punch");
  assert.equal(resolveActionAnimation(new Set([ANIMATION_IDS.SpellCastDirected]), "shoot", "wand"),
    ANIMATION_IDS.SpellCastDirected);
  assert.equal(resolveSpellVisualAnimation(new Set([ANIMATION_IDS.AttackUnarmed]), [ANIMATION_IDS.SpellCastOmni]),
    undefined, "a missing authored cast clip must never cross into the melee fallback family");
  assert.equal(resolveSpellVisualAnimation(new Set([ANIMATION_IDS.SpellCast]), [ANIMATION_IDS.SpellCastOmni]),
    ANIMATION_IDS.SpellCast, "semantically equivalent spell fallbacks remain available");
});

test("a shoot waits for late appearance metadata only inside its bounded window", () => {
  assert.ok(SHOOT_METADATA_WAIT > 900 && SHOOT_METADATA_WAIT <= 1_500,
    "appearance gets a small extension after the sidecar wait, not an open-ended replay window");
  assert.equal(pendingActionFate({
    hasClip: false, promised: false, metadataPending: true, now: 1_000,
    waitUntil: 1_000 + SHOOT_METADATA_WAIT,
  }), "wait");
  assert.equal(pendingActionFate({
    hasClip: false, promised: false, metadataPending: true, now: 1_000 + SHOOT_METADATA_WAIT,
    waitUntil: 1_000 + SHOOT_METADATA_WAIT,
  }), "drop", "a late event is not replayed after the bounded window");
  assert.equal(pendingActionExpired("shoot", false, 1_000 + SHOOT_METADATA_WAIT - 1, 1_000 + SHOOT_METADATA_WAIT),
    false, "a release inside the window remains eligible");
  assert.equal(pendingActionExpired("shoot", false, 1_000 + SHOOT_METADATA_WAIT, 1_000 + SHOOT_METADATA_WAIT),
    true, "a late clip cannot revive an expired one-shot");
  assert.equal(pendingActionExpired("shoot", true, 9_000, 1_000), false,
    "only the one-shot path expires; a held action owns its own hold deadline");
});

test("an emote names its pose through Emotes.dbc, and states are the ones that hold", withAnimationData, () => {
  // ONESHOT_WAVE and STATE_DANCE, which is the difference between waving once and dancing until
  // you move. The ids are the server's; the poses come from the table, not from this test.
  const wave = EMOTE_ANIMATIONS[3];
  assert.equal(wave.animation, ANIMATION_IDS.EmoteWave);
  assert.equal(wave.state, false);
  const dance = EMOTE_ANIMATIONS[10];
  assert.equal(dance.animation, ANIMATION_IDS.EmoteDance);
  assert.equal(dance.state, true);
  // STATE_SIT names Stand, because sitting is the unit's stand state and not an animation; rows
  // like that are dropped rather than played, which would stand a sitting character up.
  assert.equal(EMOTE_ANIMATIONS[13], undefined);
  assert.equal(EMOTE_ANIMATIONS[0], undefined, "ONESHOT_NONE is nothing at all");
});

test("a unit ambling along a spline walks, and one covering ground runs", () => {
  // TrinityCore never sets the walking flag for a unit on a server-side spline — `MoveSplineFlag`
  // has no walk bit, so `SMSG_MONSTER_MOVE` cannot report one — while `RandomMovementGenerator`
  // defaults every wandering NPC to walking. Judging by the flag alone therefore ran every
  // creature in every town. The spline's own length over its own duration is the answer.
  const base = { dead: false, movementFlags: 0, spline: true, standState: 0 };
  const walk = poseAnimation({ ...base, speed: 2.5 });
  const run = poseAnimation({ ...base, speed: 7 });
  assert.equal(walk.wanted[0], ANIMATION_IDS.Walk, "2.5 yd/s is the default walk speed");
  assert.equal(run.wanted[0], ANIMATION_IDS.Run, "7 yd/s is the default run speed");
  // Either way the other clip stays as the fallback: not every model has both.
  assert.equal(walk.wanted[1], ANIMATION_IDS.Run);
  assert.equal(run.wanted[1], ANIMATION_IDS.Walk);
});

test("without a measured speed the walking flag still decides", () => {
  // A player's own movement carries the flag and no spline, and that path is unchanged.
  const forward = MOVEMENT_FLAGS.forward;
  const running = poseAnimation({ dead: false, movementFlags: forward, spline: false, standState: 0 });
  const walking = poseAnimation({ dead: false, movementFlags: forward | 0x100, spline: false, standState: 0 });
  assert.equal(running.wanted[0], ANIMATION_IDS.Run);
  assert.equal(walking.wanted[0], ANIMATION_IDS.Walk);
  // A speed of zero is "not known", not "standing still": standing is decided before this.
  const unknown = poseAnimation({ dead: false, movementFlags: forward | 0x100, spline: false, standState: 0, speed: 0 });
  assert.equal(unknown.wanted[0], ANIMATION_IDS.Walk);
});
