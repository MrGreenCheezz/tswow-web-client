import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { animationFileSuffix, m2Animations, parseM2Skeleton } from "../tools/m2.mjs";
import { encodeWvaAnimations, encodeWvm9 } from "../tools/wvm.mjs";
import { readGlobalSequences, readRibbonEmitters } from "../tools/m2-particles.mjs";
import { BASE_ANIMATION_NAMES, baseAnimationIds, loadAnimationCatalog } from "../tools/animations.mjs";
import { decodeWvaAnimations, decodeWvm9 } from "../dist/code/browser/Wvm.js";
import {
  createQuadBuffers, createRibbonSystem, stepRibbon, writeRibbonStrip,
} from "../dist/code/browser/Particles.js";
import {
  actionAnimation, addSkinnedClips, animationBlend, animationFadeWindow, animationTransition, chooseAnimation,
  clipBlendTime, pendingActionExpired,
  pendingActionFate, poseAnimation,
  isTerminalUnitPose, needsSidecarAnimations, poseTransition, readyAnimation, resolveActionAnimation,
  resolveAnimation, resolveSpellVisualAnimation,
  shouldCrossFadeAnimation, shouldFadeOutPreviousAnimation, shouldStopPreviousAnimation, SHOOT_METADATA_WAIT,
  spellVisualAnimationCandidates, weaponPose,
  locomotionBoneMask, locomotionOverlayClip, mountSpecialAnimation, isUnitFlying,
  commitLocomotion, isLocomotionGait, LOCOMOTION_COMMIT_WINDOW,
  locomotionAuthoredSpeed, unitGaitTimeScale, UNIT_GAIT_MIN_TIME_SCALE, UNIT_GAIT_MAX_TIME_SCALE,
  measuredTravelSpeed, STRIDE_SNAP_YARDS,
  spawnFadeFactor, SPAWN_FADE_WINDOW_MS,
  stealthGroundAnimations,
  applyGlobalSequenceBones, applyStrafeYaw, buildSkinnedTemplateFrom, instantiateSkinned,
  resolveStrafeYawBones, stepStrafeYaw, strafeYawBonesFor,
  strafeYawTarget, STRAFE_YAW_DIAGONAL, STRAFE_YAW_PURE, STRAFE_YAW_RATE,
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

test("global-sequence-only paladin hand effects keep the rig that animates their ribbons", withClient, async () => {
  const model = await archives.read("Spells\\Holy_Precast_Med_Hand.m2");
  assert.ok(model, "the Holy Light hand flourish should exist in the stock client");

  const skeleton = parseM2Skeleton(model);
  assert.ok(skeleton,
    "a model whose bones run only on global sequences is still rigged; dropping it freezes the hand rings into flat cards");
  assert.equal(skeleton.bones.length, 16);
  assert.equal(skeleton.clips.length, 0,
    "this fixture deliberately has no animation-local channels, which is the old false-static case");
  assert.equal(skeleton.globalChannels.length, 13);
  assert.ok(skeleton.globalChannels.some((channel) => channel.bone === 10 && channel.kind === 0));
  assert.ok(skeleton.globalChannels.some((channel) => channel.bone === 11 && channel.kind === 0));
  assert.ok(skeleton.globalChannels.some((channel) => channel.bone === 12 && channel.kind === 0),
    "the three moving parents are what pull the three authored hand ribbons through depth");

  const globalsAt = model.readUInt32LE(0x18);
  const globalSequences = readGlobalSequences(model, {
    count: model.readUInt32LE(0x14), offset: globalsAt,
  });
  const ribbons = readRibbonEmitters(model, {
    count: model.readUInt32LE(0x120), offset: model.readUInt32LE(0x124),
  });
  assert.equal(ribbons.length, 3);
  const artifact = encodeWvm9({
    positions: new Float32Array([0, 0, 0]),
    normals: new Float32Array([0, 0, 1]),
    uv0: new Float32Array([0, 0]),
    uv1: new Float32Array([0, 0]),
    boneIndices: new Uint8Array(4),
    boneWeights: new Uint8Array(4),
    indices: new Uint16Array(0),
    submeshes: [], batches: [], textures: [],
    bounds: { min: [0, 0, 0], max: [0, 0, 0], radius: 0 },
  }, skeleton, [0], { globalSequences, particleEmitters: [], ribbonEmitters: ribbons });
  const decoded = decodeWvm9(artifact.buffer.slice(
    artifact.byteOffset, artifact.byteOffset + artifact.byteLength));
  assert.equal(decoded.skeleton.globalChannels.length, skeleton.globalChannels.length,
    "WVG1 must carry every global bone channel through the published artifact");

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint8BufferAttribute([0, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([0, 0, 0, 0], 4));
  const template = buildSkinnedTemplateFrom(geometry, decoded.skeleton, 1);
  assert.ok(template);
  const instance = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  applyGlobalSequenceBones(instance, template, decoded.globalSequences, 0);
  const before = instance.skeleton.bones[10].position.clone();
  applyGlobalSequenceBones(instance, template, decoded.globalSequences, 180);
  assert.ok(instance.skeleton.bones[10].position.distanceTo(before) > 1e-4,
    "the global clock must move the ribbon parent instead of leaving the hand card static");

  // Exercise the actual downstream consumer too: each authored ribbon samples its posed bone,
  // retains the previous positions, and must produce a strip with real area rather than three
  // copies collapsed onto the additive hand card.
  const trail = createRibbonSystem(decoded.ribbonEmitters[0], decoded.globalSequences);
  for (let frame = 1; frame <= 18; frame++) {
    const worldMs = frame * 20;
    applyGlobalSequenceBones(instance, template, decoded.globalSequences, worldMs);
    instance.root.updateMatrixWorld(true);
    const bone = instance.skeleton.bones[trail.ribbon.bone];
    assert.ok(bone);
    stepRibbon(trail, 0.02, { matrix: bone.matrixWorld.elements, animationMs: 0, worldMs });
  }
  const strip = createQuadBuffers(64);
  assert.ok(writeRibbonStrip(trail, strip) > 0, "the real Holy Light ribbon emits a strip");
  const a = new THREE.Vector3(strip.positions[0], strip.positions[1], strip.positions[2]);
  const b = new THREE.Vector3(strip.positions[3], strip.positions[4], strip.positions[5]);
  const c = new THREE.Vector3(strip.positions[6], strip.positions[7], strip.positions[8]);
  assert.ok(new THREE.Triangle(a, b, c).getArea() > 1e-6,
    "the first rendered ribbon quad has non-zero area after the global pose moves its bone");
});

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
  // Without an authored number the two constants are still the answer, and that is the case every
  // clip took before A1: a legacy VMap clip, an artifact from before the clip header carried a
  // blend time, and the 26 HumanMale sequences whose blend time is a real zero.
  assert.deepEqual(animationBlend(true, true), { duration: 0.18, warp: false },
    "loop cross-fades must not warp clip time; malformed/HD duration ratios otherwise freeze or speed up live poses");
  assert.deepEqual(animationBlend(true, false), { duration: 0.12, warp: false });
  assert.deepEqual(animationBlend(false, true), { duration: 0.12, warp: false });
  assert.deepEqual(animationBlend(false, false), { duration: 0.12, warp: false });

  // With one, the file wins in both directions — these are measured values, not invented ones:
  // 0.150 is what 210 of HumanMale's 241 sequences carry, 0.300 is NightElfFemale's Stand, 0.050
  // is one of Wolf's and Horse's. The old code answered all three with 0.18 or 0.12.
  assert.deepEqual(animationBlend(true, true, 0.15), { duration: 0.15, warp: false });
  assert.deepEqual(animationBlend(true, true, 0.3), { duration: 0.3, warp: false },
    "a longer authored blend is honoured, not clamped down to the loop constant");
  assert.deepEqual(animationBlend(false, false, 0.05), { duration: 0.05, warp: false },
    "and a shorter one is not padded up to the action constant");
  assert.equal(animationBlend(true, true, 0).duration, 0.18, "zero is the absence of a number");
  assert.equal(animationBlend(true, true, undefined).duration, 0.18);
  assert.equal(animationBlend(true, true, Number.NaN).duration, 0.18, "and so is a broken one");
  // The file is trusted, not obeyed. 0.005 is below anything this client authors (the shortest is
  // 10 ms, on one NightElfFemale sequence) and 4 s would hold two poses at once for a whole clip.
  assert.equal(animationBlend(true, true, 0.005).duration, 0.18, "an implausibly short blend is not a blend");
  assert.equal(animationBlend(true, true, 4).duration, 0.5, "and a runaway one is capped");
});

test("a clip carries the blend window its own sequence authored", () => {
  // The mixer hands out actions, not artifacts, so the number has to travel on the clip itself —
  // by the time a transition is chosen the WVM block it was decoded from is gone.
  const times = Float32Array.from([0, 1]);
  const values = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1]);
  const channel = (bone) => ({ bone, kind: 1, times, values });
  const template = {
    clips: new Map(),
    animations: new Set(),
    merged: false,
    parents: Int16Array.from([-1, 0]),
    pivots: Float32Array.from([0, 0, 0, 0, 0, -1]),
    // Bone 1 is the leg branch a moving cast leaves to the gait, so its overlay is a rebuilt clip
    // rather than the same object — which is the case that can lose the number.
    locomotionBones: Uint8Array.from([0, 1]),
    overlayClips: new Map(),
  };
  addSkinnedClips(template, [
    { animationId: ANIMATION_IDS.Stand, duration: 2.667, blendTime: 0.15, channels: [channel(0), channel(1)] },
    { animationId: ANIMATION_IDS.Run, duration: 0.667, channels: [channel(0), channel(1)] },
  ]);

  assert.equal(clipBlendTime(template.clips.get(ANIMATION_IDS.Stand)), 0.15);
  assert.equal(clipBlendTime(template.clips.get(ANIMATION_IDS.Run)), undefined,
    "a clip whose artifact carried no blend time says so rather than claiming zero");
  assert.equal(clipBlendTime(undefined), undefined);
  // The overlay a moving cast actually plays is a rebuilt clip; losing the number there would put
  // every mid-run cast back on the constant while the standing one used the file's answer.
  const overlay = template.overlayClips.get(ANIMATION_IDS.Stand);
  assert.notEqual(overlay, template.clips.get(ANIMATION_IDS.Stand), "the overlay really is a rebuilt clip");
  assert.equal(clipBlendTime(overlay), 0.15);
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
  assert.equal(without?.clips.length ?? 0, 0);
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

test("the blend window rides the clip header's reserved slot into the browser", () => {
  // The whole point of A1's format choice: the field went into two bytes the encoder was already
  // writing as zero, so this round trip is the only thing that can say it really travels. A
  // synthetic rig rather than the client's, because the mechanism is the header and not the data.
  const channels = [{ bone: 0, kind: 1, times: Uint32Array.from([0, 500]), values: Int16Array.from([0, 0, 0, 32767, 0, 0, 0, 32767]) }];
  const clips = [
    { animationId: ANIMATION_IDS.Stand, duration: 2667, blendTime: 150, channels },
    { animationId: ANIMATION_IDS.SpellCastOmni, duration: 1000, blendTime: 300, channels },
    // Three ways of saying "this sequence has no blend time", all of which have to read back the
    // same as the artifacts written before the slot meant anything.
    { animationId: ANIMATION_IDS.Run, duration: 667, blendTime: 0, channels },
    { animationId: ANIMATION_IDS.Walk, duration: 1000, channels },
    // And the guard on the slot's width: 16 bits is 65535 ms, and a module could author anything.
    { animationId: ANIMATION_IDS.Death, duration: 2000, blendTime: 999_999, channels },
  ];
  const encoded = encodeWvaAnimations(1, clips);
  const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  const decoded = new Map(decodeWvaAnimations(buffer, 1).map((clip) => [clip.animationId, clip]));

  assert.equal(decoded.get(ANIMATION_IDS.Stand).blendTime, 0.15, "milliseconds on the wire, seconds in the browser");
  assert.equal(decoded.get(ANIMATION_IDS.SpellCastOmni).blendTime, 0.3);
  assert.equal(decoded.get(ANIMATION_IDS.Run).blendTime, undefined);
  assert.equal(decoded.get(ANIMATION_IDS.Walk).blendTime, undefined);
  assert.equal(decoded.get(ANIMATION_IDS.Death).blendTime, 65.535, "clamped to the slot rather than wrapping round it");
  // Nothing else about the clip moved: the reserved slot was the only thing spent.
  assert.equal(decoded.get(ANIMATION_IDS.Stand).duration, 2.667);
  assert.equal(decoded.get(ANIMATION_IDS.Stand).channels.length, 1);
  assert.equal(encoded.length, 12 + 5 * (12 + 8 + 2 * 4 + 2 * 4 * 2),
    "and the block is exactly the header plus five clips of one channel each");
});

test("HumanMale's own blend times reach the decoder unchanged", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded);
  const skeleton = parseM2Skeleton(loaded.m2, {
    wanted: new Set([ANIMATION_IDS.Stand, ANIMATION_IDS.Run, ANIMATION_IDS.SpellCastOmni]),
    animations: loaded.files,
  });
  const encoded = encodeWvaAnimations(skeleton.bones.length, skeleton.clips);
  const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  const decoded = new Map(decodeWvaAnimations(buffer, skeleton.bones.length).map((clip) => [clip.animationId, clip]));
  // Measured on this client, not chosen: HumanMale authors 150 ms on 210 of its 241 sequences,
  // and these three are among them. If a rig ever ships a different number the assertion is the
  // place that finds out.
  for (const name of ["Stand", "Run", "SpellCastOmni"]) {
    assert.equal(decoded.get(ANIMATION_IDS[name]).blendTime, 0.15, `${name} enters over its authored window`);
  }
});

test("a spell kit naming a pose no playable rig has is promoted rather than dropped", () => {
  const {
    SpellPrecast, SpellCast, SpellCastArea, ReadySpellDirected, ReadySpellOmni,
    SpellCastDirected, SpellCastOmni, ChannelCastDirected, ChannelCastOmni, Stand,
  } = ANIMATION_IDS;
  // The measurement this table exists for: HumanMale carries none of 31/32/33 and all of
  // 51/52/53/54/124/125. AnimationData's own chain runs downhill — 33 to 32, 32 to 31, 31 to
  // nothing — so every kit naming one of the three used to resolve to nothing on every character
  // in the game, and the caster stood still while the effect played.
  const playable = new Set([ReadySpellDirected, ReadySpellOmni, SpellCastDirected, SpellCastOmni,
    ChannelCastDirected, ChannelCastOmni, Stand]);
  assert.equal(ANIMATION_FALLBACK[SpellCastArea], SpellCast, "the DBC chain really does go downhill");
  assert.equal(ANIMATION_FALLBACK[SpellPrecast], undefined, "and it ends at 31");

  assert.equal(resolveSpellVisualAnimation(playable, [SpellCast]), SpellCastOmni);
  assert.equal(resolveSpellVisualAnimation(playable, [SpellCastArea]), SpellCastOmni);
  assert.equal(resolveSpellVisualAnimation(playable, [SpellPrecast]), ReadySpellOmni,
    "a precast becomes the rig's own ready pose, not its cast");
  // A rig with only the directed half takes it: the promotion is filtered through what the
  // template carries, exactly like the chain it follows.
  assert.equal(resolveSpellVisualAnimation(new Set([SpellCastDirected, Stand]), [SpellCast]), SpellCastDirected);
  assert.equal(resolveSpellVisualAnimation(new Set([ReadySpellDirected, Stand]), [SpellPrecast]), ReadySpellDirected);
  // And a rig with neither still says no. Promotion is a longer search, not a licence to invent.
  assert.equal(resolveSpellVisualAnimation(new Set([Stand]), [SpellCast]), undefined);
  assert.equal(resolveSpellVisualAnimation(new Set([Stand]), [SpellPrecast]), undefined);

  // Nothing that already resolved is moved off its answer: the promotion is consulted only after
  // the whole DBC walk has failed, so a creature keeps the pose its kit actually names.
  const creature = new Set([SpellPrecast, SpellCast, Stand]);
  assert.equal(resolveSpellVisualAnimation(creature, [SpellCast]), SpellCast);
  assert.equal(resolveSpellVisualAnimation(creature, [SpellCastArea]), SpellCast, "by the DBC chain, not by promotion");
  assert.equal(resolveSpellVisualAnimation(playable, [ChannelCastOmni]), ChannelCastOmni);
  assert.equal(resolveSpellVisualAnimation(new Set([ChannelCastOmni, Stand]), [ChannelCastDirected]), ChannelCastOmni);

  // Anim id 0 keeps the path it has always taken: 327 kits name it, it is not a spell-family row,
  // and it goes through the general resolver to Stand.
  assert.equal(resolveSpellVisualAnimation(playable, [Stand]), Stand);
  assert.equal(Stand, 0, "which is the id the kits carry");

  // The other half: a promoted pose that is only in the sidecar has to be *asked* for, or the
  // resolution would be promised and never fetched. `needsSidecarAnimations` walks the request
  // list, and the raw kit list cannot reach 52 from 31 — the DBC chain runs the other way.
  const cold = { clips: new Map([[Stand, {}]]), animations: new Set([Stand, ReadySpellOmni, SpellCastOmni]), merged: false };
  assert.deepEqual(spellVisualAnimationCandidates([SpellPrecast]), [SpellPrecast, ReadySpellOmni, ReadySpellDirected]);
  assert.equal(needsSidecarAnimations(cold, [SpellPrecast]), false, "the raw kit list can never reach the pose");
  assert.equal(needsSidecarAnimations(cold, spellVisualAnimationCandidates([SpellPrecast])), true,
    "and the promoted list is what makes the fetch happen");
  // A model that claims none of it still asks for nothing.
  assert.equal(needsSidecarAnimations({ clips: new Map([[Stand, {}]]), animations: new Set([Stand]), merged: false },
    spellVisualAnimationCandidates([SpellPrecast])), false);
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

/**
 * HumanMale's base clips as the live chain ships them (patch-W, measured 2026-09-28): every base
 * id but Dead, RunLeft/RunRight and Fly. 19 of the 20 playable models have no Fly; OrcMale has.
 */
function humanMaleBaseClips() {
  const {
    Stand, Death, Walk, Run, ShuffleLeft, ShuffleRight, Walkbackwards, JumpStart, Jump, JumpEnd, Fall,
    SwimIdle, Swim, SwimLeft, SwimRight, SwimBackwards, Hover,
  } = ANIMATION_IDS;
  return new Map([
    Stand, Death, Walk, Run, ShuffleLeft, ShuffleRight, Walkbackwards, JumpStart, Jump, JumpEnd, Fall,
    SwimIdle, Swim, SwimLeft, SwimRight, SwimBackwards, Hover,
  ].map((id) => [id, {}]));
}

/** Levitate's word (spell 1706: auras 105 feather fall, 106 hover, 104 water walk). */
const LEVITATE_FLAGS = MOVEMENT_FLAGS.hover | MOVEMENT_FLAGS.fallingSlow | MOVEMENT_FLAGS.waterWalking;

test("a levitating player walks and runs on its ground clips instead of swimming", withAnimationData, () => {
  // Gundrak, 2026-09-28: a priest bot's Levitate put HOVER on the owner's word for 91 s and the
  // character swam wherever it went. The flying-tier ladder asks for Fly first, and AnimationData
  // walks Fly (135) to Swim (42) before the next rung is ever tried — the trap is still in the
  // table, which is why the unit's tier, not its hover bit, decides.
  const { Fly, Swim, Run, Walk, Walkbackwards, ShuffleLeft, ShuffleRight, Stand } = ANIMATION_IDS;
  const clips = humanMaleBaseClips();
  assert.equal(ANIMATION_FALLBACK[Fly], Swim);
  assert.equal(resolveAnimation(clips, [Fly, Run]), Swim, "what the flying ladder draws on this rig");

  const F = MOVEMENT_FLAGS;
  // A player stays on the ground tier through a levitation (`Unit::SetHover` never moves it), and a
  // unit whose tier nobody read is taken the same way.
  for (const animationTier of [undefined, 0]) {
    const on = (flags) => chooseAnimation(clips, standing({ movementFlags: LEVITATE_FLAGS | flags, animationTier })).animation;
    assert.equal(on(F.forward), Run, `tier ${animationTier}: running in the air is running`);
    assert.equal(on(F.forward | F.walking), Walk);
    assert.equal(on(F.backward), Walkbackwards);
    assert.equal(on(F.strafeLeft), ShuffleLeft);
    assert.equal(on(F.strafeRight), ShuffleRight);
    assert.equal(on(0), Stand, "and standing in the air is standing");
  }
  // Gravity switched off without flight is the same case.
  assert.equal(chooseAnimation(clips, standing({ movementFlags: F.disableGravity | F.forward })).animation, Run);
});

test("the hover and fly tiers keep the flying ladder, and the flying bit keeps its own", withAnimationData, () => {
  const { Fly, Hover, Swim, Run, Walk, Stand } = ANIMATION_IDS;
  const F = MOVEMENT_FLAGS;
  // A creature the core put on the hover (2) or fly (3) tier — `Creature::SetHover` and
  // `SetDisableGravity` do — "plays flying tier animations" in the core's own words.
  for (const animationTier of [2, 3]) {
    assert.deepEqual(poseAnimation(standing({ movementFlags: F.hover | F.forward, animationTier })).wanted, [Fly, Run]);
    assert.deepEqual(poseAnimation(standing({ movementFlags: F.hover, animationTier })).wanted, [Hover, Stand]);
    assert.deepEqual(poseAnimation(standing({ movementFlags: F.disableGravity | F.forward, animationTier })).wanted,
      [Fly, Run]);
  }
  const flier = new Map([[Fly, {}], [Hover, {}], [Run, {}], [Stand, {}]]);
  assert.equal(chooseAnimation(flier, standing({ movementFlags: F.hover | F.forward, animationTier: 3 })).animation, Fly);
  // The tier only speaks for a unit that hovers: with nothing hovering it is ground locomotion.
  assert.deepEqual(poseAnimation(standing({ movementFlags: F.forward, animationTier: 3 })).wanted, [Run, Walk]);
  // Flight is not a tier question. The flying bit keeps its ladder whatever the tier says, Swim
  // included: the table's own Fly→Swim fallback is the look of a body flying without a mount.
  for (const animationTier of [undefined, 0, 3]) {
    assert.deepEqual(poseAnimation(standing({ movementFlags: F.flying | F.forward, animationTier })).wanted, [Fly, Swim, Run]);
    assert.deepEqual(poseAnimation(standing({ movementFlags: F.flying, animationTier })).wanted, [Hover, Fly, Stand]);
  }
  assert.equal(chooseAnimation(humanMaleBaseClips(), standing({ movementFlags: F.flying | F.forward })).animation, Swim);
});

test("the client's HumanMale has no Fly clip, and levitating on its real clips runs", {
  skip: !archives ? "no 3.3.5a client on this machine"
    : !ANIMATION_DATA_AVAILABLE ? "no locally generated animation data" : false,
}, async () => {
  const m2 = await archives.read(`${HUMAN_MALE}.m2`);
  assert.ok(m2, "HumanMale.m2 should exist in the client");
  const ids = new Set(m2Animations(m2).map((animation) => animation.animationId));
  assert.equal(ids.has(ANIMATION_IDS.Fly), false, "the rung the flying ladder asks for first");
  assert.equal(ids.has(ANIMATION_IDS.Swim), true, "and the one Fly falls back to");
  // What a freshly built template carries: the base ids this model has, the rest is sidecar.
  const clips = new Map(BASE_ANIMATIONS.filter((id) => ids.has(id)).map((id) => [id, {}]));
  assert.equal(chooseAnimation(clips, standing({ movementFlags: LEVITATE_FLAGS | MOVEMENT_FLAGS.forward })).animation,
    ANIMATION_IDS.Run);
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

test("STRAFE the eight directions and the four diagonals each have one stable answer", () => {
  const { Stand, Walk, Run, Walkbackwards, ShuffleLeft, ShuffleRight } = ANIMATION_IDS;
  // The clip map a real playable rig has: measured over HumanMale, HumanFemale, OrcMale, OrcFemale,
  // NightElfFemale, TaurenMale, GnomeFemale and DruidCat in F:/CircleClean, every one carries
  // ShuffleLeft/ShuffleRight and not one carries RunLeft/RunRight. So the run/walk inversion in the
  // strafe ladders is a preference no shipped rig can express, and both arms land on the shuffle.
  const rig = new Map([[Stand, {}], [Walk, {}], [Run, {}], [Walkbackwards, {}],
    [ShuffleLeft, {}], [ShuffleRight, {}]]);
  const F = MOVEMENT_FLAGS.forward, B = MOVEMENT_FLAGS.backward;
  const L = MOVEMENT_FLAGS.strafeLeft, R = MOVEMENT_FLAGS.strafeRight;
  const at = (flags, extra = {}) => chooseAnimation(rig, standing({ movementFlags: flags, ...extra })).animation;

  // The eight compass points a keyboard can produce, running.
  assert.equal(at(0), Stand, "no direction key is not a direction");
  assert.equal(at(F), Run);
  assert.equal(at(B), Walkbackwards, "there is no run-backwards in this build");
  assert.equal(at(L), ShuffleLeft);
  assert.equal(at(R), ShuffleRight);
  // The four diagonals. Forward wins over a strafe and backward wins over both, which is the
  // reference client's `anyStrafeLeft = strafeLeft && !strafeRight && !movingBackward` written the
  // other way round (locomotion_fsm.cpp:185-186).
  assert.equal(at(F | L), Run, "a forward diagonal is a run forward, as in the original client");
  assert.equal(at(F | R), Run);
  assert.equal(at(B | L), Walkbackwards, "backwards outranks a strafe on both sides");
  assert.equal(at(B | R), Walkbackwards);
  // Two strafes cancel into the forward answer rather than picking a side — the same as the
  // reference, and unreachable from this client's own input, where `strafeAxis()` cancels them.
  assert.equal(at(L | R), Run);
  assert.equal(at(F | L | R), Run);

  // Walking mode changes the tempo of the answer and never the direction of it.
  assert.equal(at(F | MOVEMENT_FLAGS.walking), Walk);
  assert.equal(at(L | MOVEMENT_FLAGS.walking), ShuffleLeft);
  assert.equal(at(R | MOVEMENT_FLAGS.walking), ShuffleRight);
  assert.equal(at(F | L | MOVEMENT_FLAGS.walking), Walk);

  // Every one of the twelve answers is stable under repetition: the pick is a pure function of the
  // flags word, so a diagonal held for a second cannot alternate between two clips.
  for (const flags of [F, B, L, R, F | L, F | R, B | L, B | R, L | R]) {
    const first = poseAnimation(standing({ movementFlags: flags })).wanted;
    for (let repeat = 0; repeat < 4; repeat++) {
      assert.deepEqual(poseAnimation(standing({ movementFlags: flags })).wanted, first,
        `flags 0x${flags.toString(16)} must answer the same every frame`);
    }
  }

  // Water keeps its own strafe arm, and it is the reference's: there the diagonal *is* a strafe,
  // because `LocomotionFSM`'s SWIM state is the one place it branches on `anyStrafeLeft`.
  const swimming = MOVEMENT_FLAGS.swimming;
  assert.equal(poseAnimation(standing({ movementFlags: swimming | L })).wanted[0], ANIMATION_IDS.SwimLeft);
  assert.equal(poseAnimation(standing({ movementFlags: swimming | F | L })).wanted[0], ANIMATION_IDS.SwimLeft);
  assert.equal(poseAnimation(standing({ movementFlags: swimming | B | L })).wanted[0],
    ANIMATION_IDS.SwimBackwards, "backwards outranks a strafe in the water too");
});

test("a sidestep a rig does not carry falls back to walking, never to standing still", () => {
  const { Run, Walk, Stand, ShuffleLeft, ShuffleRight, RunLeft, RunRight } = ANIMATION_IDS;
  // Neither shuffle nor run-sideways has a Fallback row in AnimationData, so the wanted list
  // itself must carry the ordinary gait: a rig without the sidestep steps instead of gliding.
  assert.deepEqual(
    poseAnimation(standing({ movementFlags: MOVEMENT_FLAGS.strafeLeft })).wanted,
    [RunLeft, ShuffleLeft, Run, Walk]);
  assert.deepEqual(
    poseAnimation(standing({ movementFlags: MOVEMENT_FLAGS.strafeRight })).wanted,
    [RunRight, ShuffleRight, Run, Walk]);
  assert.deepEqual(
    poseAnimation(standing({ movementFlags: MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.walking })).wanted,
    [ShuffleLeft, RunLeft, Walk]);
  // The resolver proves the point end to end: with only Walk available the strafe still moves.
  assert.equal(resolveAnimation(new Set([Walk, Stand]), [ShuffleLeft, RunLeft, Run, Walk]), Walk);
  assert.equal(resolveAnimation(new Set([Stand]), [ShuffleLeft, RunLeft, Run, Walk]), undefined,
    "no gait in the list means no gait answered; the Stand last resort belongs to chooseAnimation");
  // Concealed strafes keep their crouch first and inherit the same walking tail.
  const creep = stealthGroundAnimations({ walking: true, backward: false, left: true, right: false, forward: false });
  assert.equal(creep[0], ANIMATION_IDS.StealthWalk);
  assert.ok(creep.includes(Walk), "a sneaking rig without the sidestep creeps forward, not sideways still");
});

test("a unit stride replays at measured travel speed, borrowing Walk/Run when the gait names none", () => {  const { Walk, Run, ShuffleLeft } = ANIMATION_IDS;
  const clip = (movingSpeed) => ({ userData: { movingSpeed } });
  const clips = new Map([
    [Run, clip(7)],
    [Walk, clip(2.5)],
    [ShuffleLeft, clip(0)],
  ]);
  // The shuffle is authored standstill: at a run it borrows the run tempo, at a walk the walk's.
  assert.equal(locomotionAuthoredSpeed(clips, ShuffleLeft, 7), 7);
  assert.equal(locomotionAuthoredSpeed(clips, ShuffleLeft, 2), 2.5);
  assert.equal(locomotionAuthoredSpeed(clips, Run, 7), 7, "a gait with its own number keeps it");
  assert.equal(locomotionAuthoredSpeed(new Map(), ShuffleLeft, 7), undefined,
    "neither the gait nor the fallback names a speed: play the authored rate");
  // Wider than the mount window: walk 2.5 against run 7 in both directions.
  assert.equal(unitGaitTimeScale(7, 7), 1);
  assert.equal(unitGaitTimeScale(14, 7), UNIT_GAIT_MAX_TIME_SCALE);
  assert.equal(unitGaitTimeScale(2.5, 7), UNIT_GAIT_MIN_TIME_SCALE,
    "a walk speed against a run stride saturates the lower bound");
  assert.equal(unitGaitTimeScale(undefined, 7), 1);
  assert.equal(unitGaitTimeScale(7, undefined), 1);
  assert.equal(unitGaitTimeScale(7, 0), 1);
  assert.equal(unitGaitTimeScale(0, 7), 1);
});

test("a fresh unit eases in instead of popping, and only on its first appearance", () => {  assert.equal(SPAWN_FADE_WINDOW_MS, 400);
  assert.equal(spawnFadeFactor(undefined, 1000), 1, "no stamp (or no layout clock) reads full opacity");
  assert.equal(spawnFadeFactor(1000, 1000), 0, "the first frame starts from nothing");
  assert.equal(spawnFadeFactor(1000, 1200), 0.5);
  assert.equal(spawnFadeFactor(1000, 1400), 1);
  assert.equal(spawnFadeFactor(1000, 99999), 1, "settled units never re-fade");
  assert.equal(spawnFadeFactor(1000, 999), 0, "a clock running backwards cannot unpaint");
});

test("stride tempo divides yards by mixer seconds, never milliseconds", () => {
  // The regression: `elapsed` arrives in the seconds `mixer.update` runs on, and dividing it once
  // more read a 7 yd/s run as 437 yd/s — every gait saturated its upper bound and sprinted.
  assert.equal(measuredTravelSpeed(7 * 0.016, 0.016), 7);
  assert.equal(measuredTravelSpeed(0, 0.016), 0);
  assert.equal(measuredTravelSpeed(7, 0), undefined, "a stalled clock measures nothing");
  assert.equal(measuredTravelSpeed(-1, 0.016), undefined);
  assert.equal(measuredTravelSpeed(Number.NaN, 0.016), undefined);
  assert.equal(measuredTravelSpeed(STRIDE_SNAP_YARDS + 1, 1), undefined, "teleports are not strides");
  assert.equal(measuredTravelSpeed(STRIDE_SNAP_YARDS, 1), STRIDE_SNAP_YARDS);
});

test("the renderer measures stride tempo and replays looping gaits at it", async () => {  const { readFile } = await import("node:fs/promises");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /unit\.strideSpeed = this\.#strideSpeed\(unit, unit\.node\.position, elapsed\)/,
    "every posed frame measures the drawn node's travel before anything poses");
  assert.match(renderer, /this\.#applyUnitGait\(unit, gait, chosen\.loop\)/,
    "both base-pose paths replay the committed gait at the measured tempo");
  assert.match(renderer, /isLocomotionGait\(animation\)/,
    "one-shots keep authored timing: only travelling gaits are retimed");
  assert.match(renderer, /unit\.admittedAt === undefined\) unit\.admittedAt = now/,
    "the spawn fade starts at first visibility, not at record creation");
  // 05.10 suite-fix: since 05.10-A7a-H (6.11а) the appearance opacity is first multiplied by the
  // display's CreatureModelAlpha into `displayOpacity`; the fade still multiplies, never replaces.
  assert.match(renderer, /const displayOpacity = appearance\.opacity \* creatureDisplayAlpha\(metadata\)/,
    "the display alpha multiplies the appearance opacity rather than replacing it");
  assert.match(renderer, /displayOpacity \* spawnFadeFactor\(unit\.admittedAt, now\)/,
    "ghosts and spirits keep their own translucency under the fade");
});

test("STRAFE a gait owns the mixer for its own blend before another gait may replace it", () => {
  const { Stand, Run, Walk, ShuffleLeft, ShuffleRight, Walkbackwards, Swim, Jump, Dead, Mount } = ANIMATION_IDS;
  assert.equal(LOCOMOTION_COMMIT_WINDOW, 150,
    "the window is the 150 ms blendTime every playable rig authors on Walk/Run/ShuffleLeft/ShuffleRight");

  // What the window covers, and what it must never touch.
  for (const gait of [Walk, Run, Walkbackwards, ShuffleLeft, ShuffleRight, Swim,
    ANIMATION_IDS.SwimLeft, ANIMATION_IDS.SwimRight, ANIMATION_IDS.SwimBackwards,
    ANIMATION_IDS.RunLeft, ANIMATION_IDS.RunRight, ANIMATION_IDS.StealthWalk, ANIMATION_IDS.StealthRun]) {
    assert.equal(isLocomotionGait(gait), true, `${gait} is a travelling gait`);
  }
  for (const held of [Stand, Jump, Dead, Mount, ANIMATION_IDS.SwimIdle, ANIMATION_IDS.Hover,
    ANIMATION_IDS.SitGround, ANIMATION_IDS.Fall, undefined]) {
    assert.equal(isLocomotionGait(held), false, `${held} is a stance, not a stride`);
  }

  // Starting to move is never delayed: the window opens on the frame the stride starts.
  const start = commitLocomotion(Stand, Run, 0, 800);
  assert.deepEqual(start, { animation: Run, committedUntil: 800 + LOCOMOTION_COMMIT_WINDOW });
  // Its own window then covers the stride that has just begun, so W-then-Q inside a sixth of a
  // second is one blend rather than two overlapping ones.
  assert.equal(commitLocomotion(Run, ShuffleLeft, start.committedUntil, 900).animation, Run);

  // The tap the owner reports. A character that has been running for a while presses a strafe key
  // at t=1000 and lets go at t=1075 — inside the cross-fade the strafe started — and the run has to
  // wait rather than snap the shuffle back to full weight, which is what three.js's fixed-start
  // `fadeOut` does to a half-blended action.
  const strafe = commitLocomotion(Run, ShuffleLeft, start.committedUntil, 1000);
  assert.deepEqual(strafe, { animation: ShuffleLeft, committedUntil: 1150 },
    "a strafe pressed out of a settled run answers on the same frame; it is never laggy");
  const tap = commitLocomotion(ShuffleLeft, Run, strafe.committedUntil, 1075);
  assert.deepEqual(tap, { animation: ShuffleLeft, committedUntil: 1150 },
    "a second change inside the blend holds the stride it is already blending into");
  // The deadline is not pushed out by being asked again, so the hold is bounded by one window and
  // the pose pass — which runs every frame — takes the pending answer the moment it closes.
  assert.deepEqual(commitLocomotion(ShuffleLeft, Run, tap.committedUntil, 1149).animation, ShuffleLeft);
  assert.deepEqual(commitLocomotion(ShuffleLeft, Run, tap.committedUntil, 1150),
    { animation: Run, committedUntil: 1300 }, "the window closes and the pending gait takes over");

  // Asking for what is already playing is not a change and does not move the deadline.
  assert.deepEqual(commitLocomotion(ShuffleLeft, ShuffleLeft, 1150, 1100),
    { animation: ShuffleLeft, committedUntil: 1150 });

  // Nothing but gait-to-gait is ever held. Stopping, jumping, dying and mounting answer on the
  // frame they are asked, and each closes the window so no stale deadline survives.
  for (const pose of [Stand, Jump, Dead, Mount, ANIMATION_IDS.SitGround]) {
    assert.deepEqual(commitLocomotion(Run, pose, 1150, 1010), { animation: pose, committedUntil: 0 },
      `a stride must never delay ${pose}`);
  }
  // ...and leaving one of those for a stride is immediate as well, window or no window.
  assert.deepEqual(commitLocomotion(Jump, ShuffleLeft, 1150, 1010),
    { animation: ShuffleLeft, committedUntil: 1160 }, "a landing hands straight over to the stride");
  assert.deepEqual(commitLocomotion(undefined, Run, 0, 500),
    { animation: Run, committedUntil: 650 }, "a model with nothing playing yet simply starts");
});

test("STRAFE a strafe tap blends one way and then the other, instead of lurching back", () => {
  const { Run, ShuffleLeft } = ANIMATION_IDS;
  // The defect, measured on a real mixer rather than argued. `#playAnimation`'s locomotion change
  // is reproduced exactly: reset, weight 1, play, `crossFadeFrom(previous, 0.15)`.
  const drive = (withWindow) => {
    const root = new THREE.Object3D();
    const bone = new THREE.Bone();
    bone.name = "bone0";
    root.add(bone);
    const mixer = new THREE.AnimationMixer(root);
    const clipFor = (name, value) => new THREE.AnimationClip(name, 1, [
      new THREE.VectorKeyframeTrack("bone0.position", [0, 1], [0, 0, 0, 0, value, 0]),
    ]);
    const clips = new Map([[Run, clipFor("Run", 1)], [ShuffleLeft, clipFor("ShuffleLeft", 2)]]);
    let action;
    let animationId = -1;
    let committedUntil = 0;
    const want = (animation, now) => {
      const commit = commitLocomotion(action ? animationId : undefined, animation,
        withWindow ? committedUntil : 0, now);
      committedUntil = commit.committedUntil;
      if (commit.animation === animationId && action) return;
      const previous = action;
      const next = mixer.clipAction(clips.get(commit.animation));
      next.reset();
      next.setEffectiveTimeScale(1);
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.setEffectiveWeight(1);
      next.play();
      if (previous && previous !== next) next.crossFadeFrom(previous, 0.15, false);
      action = next;
      animationId = commit.animation;
    };

    // A settled run, a strafe held for 75 ms, then the key released and the run asked for on every
    // frame after it — which is what the per-frame pose pass does.
    want(Run, 0);
    mixer.update(0.5);
    want(ShuffleLeft, 500);
    const share = [];
    for (let t = 500; t <= 800; t += 25) {
      if (t >= 575) want(Run, t);
      mixer.update(0.025);
      const shuffle = mixer.clipAction(clips.get(ShuffleLeft)).getEffectiveWeight();
      const run = mixer.clipAction(clips.get(Run)).getEffectiveWeight();
      const total = shuffle + run;
      share.push(total > 0 ? shuffle / total : 0);
    }
    return share;
  };

  // The biggest one-frame move the pose makes. A 150 ms blend sampled every 25 ms moves 1/6 of the
  // way each frame, and nothing about a hand-off should ever move it faster than that.
  const fastestStep = (share) => share
    .slice(1)
    .reduce((most, value, index) => Math.max(most, Math.abs(value - share[index])), 0);

  const without = drive(false);
  const with_ = drive(true);
  const step = 25 / 150;
  // Measured, and this is the owner's report in numbers. Without the window the sidestep is at
  // 0.500 and rising on the frame the key is released, and the next 25 ms take it to 0.833: three.js
  // schedules `fadeOut` from a *fixed* weight of 1 rather than from the 0.5 the action actually has,
  // so releasing the key drives the pose deeper into the clip it is abandoning, at twice the blend's
  // own rate, before it turns round. With the window every frame moves exactly one blend step.
  assert.ok(Math.abs(fastestStep(without) - 2 * step) < 1e-3,
    `the unguarded release moves the pose ${fastestStep(without).toFixed(3)} in one frame`);
  assert.ok(Math.abs(fastestStep(with_) - step) < 1e-3,
    `the guarded one never moves it more than a blend step: ${fastestStep(with_).toFixed(3)}`);
  // And the strafe is actually reached rather than abandoned half-blended, which is the other half
  // of what a tap should look like.
  assert.ok(Math.max(...with_) > 0.99, "the sidestep the key asked for is fully reached");
  assert.ok(Math.max(...without) < 0.9, "the unguarded tap never gets there");
  // No sample may rise after the peak has been passed: the same statement the eye makes.
  const peak = with_.indexOf(Math.max(...with_));
  for (let index = peak + 1; index < with_.length; index++) {
    assert.ok(with_[index] <= with_[index - 1] + 1e-6,
      `the pose must not move back toward the sidestep at sample ${index}`);
  }
});

test("STRAFE the strafe clips a player really has, and the window each one is entered over",
  withClient, async () => {
    // The measurement the commit window and the strafe ladders are built on, taken from the rig
    // rather than asserted. `movingSpeed` is 0 on every sidestep in this client, which is why a
    // strafe is played at its authored rate and never gait-scaled.
    const rigs = ["Character/Human/Male/HumanMale", "Character/Orc/Male/OrcMale",
      "Character/Tauren/Male/TaurenMale", "Character/Gnome/Female/GnomeFemale"];
    let checked = 0;
    for (const base of rigs) {
      const m2 = await archives.read(`${base}.m2`);
      if (!m2) continue;
      checked++;
      const byId = new Map(m2Animations(m2).map((entry) => [entry.animationId, entry]));
      for (const id of [ANIMATION_IDS.ShuffleLeft, ANIMATION_IDS.ShuffleRight]) {
        const sequence = byId.get(id);
        assert.ok(sequence, `${base} should carry the authored sidestep ${id}`);
        assert.equal(sequence.blendTime, LOCOMOTION_COMMIT_WINDOW,
          `${base} enters ${id} over ${LOCOMOTION_COMMIT_WINDOW} ms`);
        assert.equal(sequence.movingSpeed, 0, `${base}'s sidestep ${id} authors no stride speed`);
      }
      for (const id of [ANIMATION_IDS.RunLeft, ANIMATION_IDS.RunRight]) {
        assert.equal(byId.has(id), false,
          `${base} must not carry ${id}: no playable rig in this client does`);
      }
      // The far edge of the same window: leaving a strafe is entering Run, and Run authors its own.
      const run = byId.get(ANIMATION_IDS.Run);
      assert.ok(run, `${base} should carry Run`);
      assert.equal(run.blendTime, LOCOMOTION_COMMIT_WINDOW, `${base} enters Run over the same window`);
    }
    assert.ok(checked > 0, "at least one playable rig should be readable from the client");
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
    // Since A2 the list is a ladder rather than a single id, and the flying rung is added when the
    // movement word says the mount is in the air. Every rung is still a seat, and every one of the
    // 22 playable rigs still answers with 91: none of them carries 320.
    const expected = movementFlags === MOVEMENT_FLAGS.flying ? [ANIMATION_IDS.FlyMount, Mount] : [Mount];
    assert.deepEqual(poseAnimation(pose).wanted, expected, `flags 0x${movementFlags.toString(16)}`);
    assert.equal(poseAnimation(pose).loop, true, "a seat is a stance, and a stance repeats");
  }
  // Hover asks the unit's tier since the Gundrak swim of 2026-09-28; a rider does not get that far,
  // because the seat is decided first — a hovering rider on the fly tier still sits.
  assert.deepEqual(
    poseAnimation(standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.hover, animationTier: 3 })).wanted, [Mount]);
  // A spline is the taxi case, and it carries the flags of neither. Since A2 the flying rung is
  // asked for first — `[FlyMount, Mount]` — and this is the one honest change to what a rider is
  // offered: measured over the 22 playable rigs, not one carries 320, so every one of them still
  // resolves to 91 and draws exactly what it drew before. See the A2 ladder tests for why the rung
  // is written down anyway.
  assert.deepEqual(poseAnimation(standing({ mounted: true, spline: true, flight: true })).wanted,
    [ANIMATION_IDS.FlyMount, Mount]);

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

test("a completed one-shot is faded out rather than cut out of the mixer", () => {
  // The truth table changed in A1, and only in the middle row. A finished one-shot is still not a
  // cross-fade *source* — `crossFadeFrom` couples the two actions' clocks and a stopped action has
  // no clock — but that was never a reason to `stop()` it. Every completed one-shot here is
  // LoopOnce + clampWhenFinished, so it holds its last authored frame at weight 1, and stopping it
  // dropped that frame to nothing on the same tick the next pose appeared at weight 1: one frame
  // of snap after every cast, landing and reaction. "fade" keeps it and ramps it down instead.
  assert.equal(animationTransition(true, true), "crossfade");
  assert.equal(animationTransition(false, true), "fade");
  assert.equal(animationTransition(true, false), "none");
  assert.equal(shouldCrossFadeAnimation(true, true), true, "a live previous pose still blends");
  assert.equal(shouldCrossFadeAnimation(false, true), false, "a clamped pose is still not a crossfade source");
  assert.equal(shouldCrossFadeAnimation(true, false), false, "the same clip never needs a blend");
  assert.equal(shouldFadeOutPreviousAnimation(false, true), true, "it leaves over the blend window instead");
  assert.equal(shouldFadeOutPreviousAnimation(true, true), false, "a live pose is handed over by cross-fade");
  assert.equal(shouldFadeOutPreviousAnimation(true, false), false, "the same clip is not faded out from itself");
  // No transition asks for a hard stop any more. The paths that really want a pose gone without a
  // trace — an instance being torn down — call stop() directly and never consult the policy.
  for (const running of [true, false]) {
    for (const different of [true, false]) {
      assert.equal(shouldStopPreviousAnimation(running, different), false);
    }
  }
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

// ── Slice M1: the legs into the direction of travel ─────────────────────────────────────────────
//
// The owner's report: «ноги должны направлять в сторону движения; сейчас анимация бежит вперёд, а
// персонаж движется под углом». The reference client puts the *model* on the travel heading and
// counter-rotates the SpineLow key bone by `facingYaw - travelYaw` (`renderer.cpp:1613-1653`,
// `character_renderer.cpp:2332-2336`); here the model keeps the server's orientation, which the name
// plate and the camera pivot read, and the lower body is turned instead. Same legs, same torso.

/** A compact humanoid: root, pelvis, two legs with a shin each — the mask test's rig. */
const YAW_RIG = {
  parents: Int16Array.from([-1, 0, 1, 1, 2, 3]),
  pivots: Float32Array.from([
    0, 0, 1.0,
    0, 0, 0.9,
    0, -0.2, 0.5,
    0, 0.2, 0.5,
    0, -0.2, 0.1,
    0, 0.2, 0.1,
  ]),
};

/** The same rig with the spine hung *under* the pelvis, which no shipped rig does. */
const YAW_RIG_SPINE_UNDER_PELVIS = {
  parents: Int16Array.from([-1, 0, 1, 1, 2, 3, 1]),
  pivots: Float32Array.from([
    0, 0, 1.0,
    0, 0, 0.9,
    0, -0.2, 0.5,
    0, 0.2, 0.5,
    0, -0.2, 0.1,
    0, 0.2, 0.1,
    0, 0, 1.4,
  ]),
};

function yawInstance(rig) {
  const count = rig.parents.length;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("skinIndex", new THREE.Uint8BufferAttribute(new Uint8Array(count * 4), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
  return instantiateSkinned({
    geometry,
    clips: new Map(),
    animations: new Set(),
    boneInverses: Array.from({ length: count }, () => new THREE.Matrix4()),
    parents: rig.parents,
    pivots: rig.pivots,
    flags: new Uint16Array(count),
    billboards: [],
    height: 1,
  }, new THREE.MeshBasicMaterial());
}

/** Where a bone sits in the model's own space, which is what the yaw is defined in. */
function modelPosition(instance, bone) {
  instance.root.updateWorldMatrix(true, true);
  const at = new THREE.Vector3();
  instance.skeleton.bones[bone].getWorldPosition(at);
  return instance.root.worldToLocal(at);
}

test("M1 the strafe yaw target is the reference client's travel heading, row for row", () => {
  const moving = (flags, animation) => strafeYawTarget(standing({ movementFlags: flags }), animation);
  const F = MOVEMENT_FLAGS;
  assert.equal(moving(F.forward), 0, "travel is the facing");
  assert.equal(moving(0), 0);
  assert.equal(moving(F.backward), 0);
  // The diagonal, which is the case the owner is looking at: `travelYaw_` is the atan2 of a forward
  // plus a lateral unit contribution (`camera_controller.cpp:2555-2562`), so 45 degrees.
  assert.equal(moving(F.forward | F.strafeLeft), STRAFE_YAW_DIAGONAL);
  assert.equal(moving(F.forward | F.strafeRight), -STRAFE_YAW_DIAGONAL);
  // A pure strafe on a rig with no sidestep clip is the whole quarter, which is what the reference
  // gets for every strafe because it resolves none.
  assert.equal(moving(F.strafeLeft), STRAFE_YAW_PURE);
  assert.equal(moving(F.strafeRight), -STRAFE_YAW_PURE);
  // Both keys cancel, exactly as the movement vector does.
  assert.equal(moving(F.strafeLeft | F.strafeRight), 0);
  assert.equal(moving(F.forward | F.strafeLeft | F.strafeRight), 0);
  // `activeStrafe` is `(left || right) && !movingBackward` (`renderer.cpp:1611-1612`).
  assert.equal(moving(F.backward | F.strafeLeft), 0);
  assert.equal(moving(F.backward | F.strafeRight), 0);

  // Ground locomotion only.
  assert.equal(moving(F.swimming | F.strafeLeft), 0);
  assert.equal(moving(F.flying | F.strafeLeft), 0);
  // Hover and gravity-off are ground locomotion unless the core put the unit on its hover or fly
  // tier (`hoversOnFlightTier`): a levitating player strafes on its ground clips, so its legs turn
  // like anyone's. They used to be excluded wholesale, which was the Gundrak swim of 2026-09-28.
  assert.equal(moving(F.hover | F.strafeLeft), STRAFE_YAW_PURE);
  assert.equal(moving(F.disableGravity | F.strafeLeft), STRAFE_YAW_PURE);
  for (const animationTier of [2, 3]) {
    assert.equal(strafeYawTarget(standing({ movementFlags: F.hover | F.strafeLeft, animationTier })), 0);
    assert.equal(strafeYawTarget(standing({ movementFlags: F.disableGravity | F.strafeLeft, animationTier })), 0);
  }
  assert.equal(moving(F.falling | F.strafeLeft), 0);
  assert.equal(strafeYawTarget(standing({ movementFlags: F.forward | F.strafeLeft, dead: true })), 0);
  assert.equal(
    strafeYawTarget(standing({ movementFlags: F.forward | F.strafeLeft, mounted: true })), 0,
    "a rider's legs belong to the saddle, and the mount keeps the server's own facing");
});

test("M1 an authored sidestep answers a pure strafe instead of the yaw", withAnimationData, () => {
  const F = MOVEMENT_FLAGS;
  const pure = standing({ movementFlags: F.strafeLeft });
  assert.equal(strafeYawTarget(pure, ANIMATION_IDS.ShuffleLeft), 0,
    "the shuffle already faces that way; turning the legs again would overshoot by a quarter");
  assert.equal(strafeYawTarget(pure, ANIMATION_IDS.RunLeft), 0);
  assert.equal(strafeYawTarget(pure, ANIMATION_IDS.Run), STRAFE_YAW_PURE,
    "and a rig that fell back to the forward gait needs the whole turn");
  // The diagonal is unaffected: it is answered by Walk/Run on every rig and the clip cannot help.
  assert.equal(
    strafeYawTarget(standing({ movementFlags: F.forward | F.strafeLeft }), ANIMATION_IDS.Run),
    STRAFE_YAW_DIAGONAL);
});

test("M1 the turn is bounded, so a key change never snaps the legs", () => {
  // A quarter turn inside one commit window, which is the authored blend of every gait.
  assert.ok(Math.abs(STRAFE_YAW_RATE - STRAFE_YAW_PURE / (LOCOMOTION_COMMIT_WINDOW / 1000)) < 1e-9);
  const frame = 1 / 60;
  const perFrame = STRAFE_YAW_RATE * frame;
  assert.ok(perFrame < STRAFE_YAW_DIAGONAL,
    "one frame is never the whole diagonal, or the bound would not be a bound");

  let yaw = 0;
  let frames = 0;
  while (yaw !== STRAFE_YAW_DIAGONAL && frames < 1000) {
    const next = stepStrafeYaw(yaw, STRAFE_YAW_DIAGONAL, frame);
    assert.ok(next - yaw <= perFrame + 1e-9, "and no single step exceeds the rate");
    yaw = next;
    frames++;
  }
  assert.equal(yaw, STRAFE_YAW_DIAGONAL);
  // 45 degrees in half a commit window, at 60 Hz.
  assert.equal(frames, Math.ceil((STRAFE_YAW_DIAGONAL / STRAFE_YAW_RATE) / frame));

  // Releasing the key unwinds at the same rate rather than dropping the legs back.
  const released = stepStrafeYaw(STRAFE_YAW_DIAGONAL, 0, frame);
  assert.ok(released > 0 && released < STRAFE_YAW_DIAGONAL);
  assert.equal(stepStrafeYaw(STRAFE_YAW_DIAGONAL, 0, 10), 0, "a long enough step still lands exactly");
  // A frame that is not a frame — a tab that was hidden for a minute — turns a quarter second's
  // worth and no more, so nothing integrates a whole stall in one step.
  const stalled = stepStrafeYaw(-STRAFE_YAW_PURE, STRAFE_YAW_PURE, 60);
  assert.ok(Math.abs(stalled - (-STRAFE_YAW_PURE + STRAFE_YAW_RATE * 0.25)) < 1e-9,
    `a stalled frame is capped, got ${stalled}`);
  assert.equal(stepStrafeYaw(stalled, STRAFE_YAW_PURE, 60), STRAFE_YAW_PURE,
    "and the one after it lands");
  assert.equal(stepStrafeYaw(0, STRAFE_YAW_PURE, 0), 0, "and a zero-length frame turns nothing");
  assert.equal(stepStrafeYaw(Number.NaN, STRAFE_YAW_DIAGONAL, frame), STRAFE_YAW_DIAGONAL,
    "a unit with nothing stored yet starts where it belongs");
});

test("M1 the yaw bones are resolved from the rig, and fail open when it cannot answer", () => {
  const found = resolveStrafeYawBones(YAW_RIG.parents, YAW_RIG.pivots);
  assert.deepEqual({ pelvis: found.pelvis, torso: [...found.torso] }, { pelvis: 1, torso: [] },
    "the bone both legs hang from, and no torso under it — the shape of all twenty playable rigs");

  const underneath = resolveStrafeYawBones(
    YAW_RIG_SPINE_UNDER_PELVIS.parents, YAW_RIG_SPINE_UNDER_PELVIS.pivots);
  assert.deepEqual([...underneath.torso], [6],
    "a rig that does put the spine under the pelvis has it turned back");

  // No bilateral pair at all: a chain, which is most creature rigs.
  assert.equal(resolveStrafeYawBones(
    Int16Array.from([-1, 0, 1]), Float32Array.from([0, 0, 1, 0, 0, 0.6, 0, 0, 0.2])), undefined);
  // The pelvis is the root: turning it is turning the model, which the server's orientation owns.
  const rootPelvis = {
    parents: Int16Array.from([-1, 0, 0, 1, 2]),
    pivots: Float32Array.from([0, 0, 0.9, 0, -0.2, 0.5, 0, 0.2, 0.5, 0, -0.2, 0.1, 0, 0.2, 0.1]),
  };
  assert.equal(resolveStrafeYawBones(rootPelvis.parents, rootPelvis.pivots), undefined);
  // A pelvis off the body's own axis — a quadruped's hind hip is the real case.
  const offAxisPivots = Float32Array.from(YAW_RIG.pivots);
  offAxisPivots[3] = 0.5;
  assert.equal(resolveStrafeYawBones(YAW_RIG.parents, offAxisPivots), undefined);
  // And a torso branch that is off it, which the counter-rotation could not put back.
  const offAxisTorso = Float32Array.from(YAW_RIG_SPINE_UNDER_PELVIS.pivots);
  offAxisTorso[18] = 0.5;
  assert.equal(
    resolveStrafeYawBones(YAW_RIG_SPINE_UNDER_PELVIS.parents, offAxisTorso), undefined);

  // Resolved once and remembered, because it is a property of the rig and not of the unit.
  const template = { parents: YAW_RIG.parents, pivots: YAW_RIG.pivots };
  assert.equal(strafeYawBonesFor(template).pelvis, 1);
  assert.equal(strafeYawBonesFor(template), template.strafeYawBones);
  const none = { parents: Int16Array.from([-1]), pivots: Float32Array.from([0, 0, 0]) };
  assert.equal(strafeYawBonesFor(none), undefined);
  assert.equal(none.strafeYawBones, null, "and a rig that cannot answer is asked exactly once");
});

test("M1 the yaw turns the legs about the body's axis and leaves the torso alone", () => {
  const bones = resolveStrafeYawBones(
    YAW_RIG_SPINE_UNDER_PELVIS.parents, YAW_RIG_SPINE_UNDER_PELVIS.pivots);
  const instance = yawInstance(YAW_RIG_SPINE_UNDER_PELVIS);
  const footBefore = modelPosition(instance, 4);
  const spineBefore = modelPosition(instance, 6);

  applyStrafeYaw(instance, bones, Math.PI / 2);
  const foot = modelPosition(instance, 4);
  const spine = modelPosition(instance, 6);
  // M2 space is Z-up and faces +X, so a positive turn takes the foot at −Y round to +X.
  assert.ok(Math.abs(foot.x - 0.2) < 1e-6 && Math.abs(foot.y) < 1e-6 && Math.abs(foot.z - 0.1) < 1e-6,
    `the foot swings a quarter about the pelvis axis, got ${foot.toArray().join(",")}`);
  assert.ok(spine.distanceTo(spineBefore) < 1e-6, "and the torso does not move at all");
  assert.ok(footBefore.distanceTo(foot) > 0.1);

  // Zero is a no-op, so a unit that is not strafing pays nothing and is not nudged.
  const still = yawInstance(YAW_RIG_SPINE_UNDER_PELVIS);
  const rest = modelPosition(still, 4);
  applyStrafeYaw(still, bones, 0);
  assert.ok(modelPosition(still, 4).distanceTo(rest) < 1e-9);
});

test("M1 the yaw is a model-space turn even when the mixer has already posed the parents", () => {
  // The bone's local quaternion is relative to its parent, and the parent is being animated — so
  // the axis has to be carried into the parent's frame before it is applied. This is that.
  const bones = resolveStrafeYawBones(YAW_RIG.parents, YAW_RIG.pivots);
  const instance = yawInstance(YAW_RIG);
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.4);
  instance.skeleton.bones[0].quaternion.copy(tilt);
  const pelvisAt = modelPosition(instance, bones.pelvis);
  const before = modelPosition(instance, 4).sub(pelvisAt);

  const radians = Math.PI / 3;
  applyStrafeYaw(instance, bones, radians);
  const after = modelPosition(instance, 4).sub(modelPosition(instance, bones.pelvis));
  const expected = before.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), radians);
  assert.ok(after.distanceTo(expected) < 1e-6,
    `expected ${expected.toArray().join(",")}, got ${after.toArray().join(",")}`);
});

test("M1 the yaw is re-derived each frame, so an unkeyed pelvis cannot spin", () => {
  // The mixer writes a bone's quaternion only while a clip keys it, and nothing writes one at all
  // until a model has its first clip. A pass that premultiplied blindly would turn an already
  // turned bone again on every frame.
  const bones = resolveStrafeYawBones(
    YAW_RIG_SPINE_UNDER_PELVIS.parents, YAW_RIG_SPINE_UNDER_PELVIS.pivots);
  const instance = yawInstance(YAW_RIG_SPINE_UNDER_PELVIS);
  const rest = modelPosition(instance, 4);

  applyStrafeYaw(instance, bones, Math.PI / 4);
  const once = modelPosition(instance, 4);
  for (let frame = 0; frame < 30; frame++) applyStrafeYaw(instance, bones, Math.PI / 4);
  assert.ok(modelPosition(instance, 4).distanceTo(once) < 1e-9,
    "thirty frames of the same turn are one turn");

  // A different angle is measured from the clip's pose, not from the last turn.
  applyStrafeYaw(instance, bones, Math.PI / 2);
  const quarter = modelPosition(instance, 4);
  assert.ok(Math.abs(quarter.x - 0.2) < 1e-6 && Math.abs(quarter.y) < 1e-6);

  // And releasing the key puts the clip's own pose back rather than leaving the legs turned.
  applyStrafeYaw(instance, bones, 0);
  assert.ok(modelPosition(instance, 4).distanceTo(rest) < 1e-9, "zero is a full release");
  applyStrafeYaw(instance, bones, 0);
  assert.ok(modelPosition(instance, 4).distanceTo(rest) < 1e-9);

  // What the mixer does write is honoured: a fresh pose under the same turn moves with it.
  const posed = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
  applyStrafeYaw(instance, bones, Math.PI / 4);
  instance.skeleton.bones[bones.pelvis].quaternion.copy(posed);
  applyStrafeYaw(instance, bones, Math.PI / 4);
  const chained = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4).multiply(posed);
  assert.ok(instance.skeleton.bones[bones.pelvis].quaternion.angleTo(chained) < 1e-3,
    "the turn composes with the clip the mixer just wrote, and not with itself");
});
