// Slice S2: how a unit the server marks as stealthed, invisible or a ghost is drawn and posed.
//
// Four mechanisms, three of which nothing in this client had at all: the visibility byte was never
// read, no unit had an opacity, and the crouch clips were generated and never asked for. The
// fourth — the aura fallback — exists because the byte is not always sent for the viewer's own
// character, so the layering between the two is what the pins below are really about.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  PLAYER_FLAGS_GHOST, UNIT_GHOST_OPACITY, UNIT_INVISIBILITY_OPACITY, UNIT_STEALTH_OPACITY,
  UNIT_VIS_FLAG_CREEP, isPlayerGhost, isUnitCreeping, unit as unitFields, unitAppearance,
} from "../dist/code/world/Fields.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { applyBlendMode, fadeMaterial, cloneMaterialFaded } from "../dist/code/browser/ModelBuild.js";
import {
  borrowFadedMaterials, returnBorrowedMaterials,
} from "../dist/code/browser/WorldRenderer3D.js";
import {
  chooseAnimation, mountPose, needsSidecarAnimations, poseAnimation, poseAnimationFamily,
  resolveAnimation, resolveStealthAnimation, stealthGroundAnimations,
} from "../dist/code/browser/AnimatedModel.js";
import { ANIMATION_DATA_AVAILABLE, ANIMATION_IDS } from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";
import {
  UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_STAND,
} from "../dist/code/world/CharacterProgressProtocol.js";

const withAnimationData = {
  skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data",
};

function object(fields = {}) {
  const map = new Map();
  for (const [name, value] of Object.entries(fields)) map.set(UPDATE_FIELDS[name].offset, value >>> 0);
  return { guid: 1n, fields: map };
}

test("UNIT_FIELD_BYTES_1 byte 2 is the visibility byte, and CREEP is the stealth presentation bit", () => {
  // Byte 0 is the stand state and byte 3 the animation tier; the byte between them is the one this
  // client never read. Packed so that a reader off by one byte in either direction fails.
  const packed = 0x0a_02_00_01;
  const unit = object({ UNIT_FIELD_BYTES_1: packed });
  assert.equal(unitFields.standState(unit), 0x01);
  assert.equal(unitFields.visFlags(unit), 0x02);
  assert.equal(unitFields.animationTier(unit), 0x0a);
  assert.equal(UNIT_VIS_FLAG_CREEP, 0x02);
  assert.equal(isUnitCreeping(unit), true);

  // The other bits of the same byte are somebody else's business and must not read as stealth.
  assert.equal(isUnitCreeping(object({ UNIT_FIELD_BYTES_1: 0x00_fd_00_00 })), false);
  assert.equal(isUnitCreeping(object({ UNIT_FIELD_BYTES_1: 0x00_03_00_00 })), true);
  // A field the server has not sent at all is not stealth either.
  assert.equal(unitFields.visFlags(object()), undefined);
  assert.equal(isUnitCreeping(object()), false);
});

test("PLAYER_FLAGS ghost is read for other players and is absent on anything without the field", () => {
  assert.equal(PLAYER_FLAGS_GHOST, 0x10);
  assert.equal(isPlayerGhost(object({ PLAYER_FLAGS: PLAYER_FLAGS_GHOST })), true);
  // The bit next door is RESTING. A creature has no PLAYER_FLAGS slot at all.
  assert.equal(isPlayerGhost(object({ PLAYER_FLAGS: 0x20 })), false);
  assert.equal(isPlayerGhost(object()), false);
});

test("the appearance layers CREEP over the aura fallback over ghost", () => {
  // CREEP alone: the server's own presentation flag, which is the whole answer when it arrives.
  assert.deepEqual(unitAppearance({ creep: true }), { opacity: UNIT_STEALTH_OPACITY, stealth: true });
  // Aura alone: the fallback for a build that has not written the byte yet, or ever.
  assert.deepEqual(unitAppearance({ stealthAura: true }), { opacity: UNIT_STEALTH_OPACITY, stealth: true });
  // Both: the same answer, which is what makes the fallback safe to layer under the byte.
  assert.deepEqual(unitAppearance({ creep: true, stealthAura: true }),
    { opacity: UNIT_STEALTH_OPACITY, stealth: true });
  // Neither: exactly as authored, and not "nearly one".
  assert.deepEqual(unitAppearance({}), { opacity: 1, stealth: false });
  assert.deepEqual(unitAppearance({ creep: false, stealthAura: false, ghost: false }),
    { opacity: 1, stealth: false });

  // Invisibility fades without crouching — a potion does not change how anybody walks.
  assert.deepEqual(unitAppearance({ invisibilityAura: true }),
    { opacity: UNIT_INVISIBILITY_OPACITY, stealth: false });
  // Ghost is the weakest reading, and it is a different number: 0.5 rather than 0.35.
  assert.deepEqual(unitAppearance({ ghost: true }), { opacity: UNIT_GHOST_OPACITY, stealth: false });
  assert.equal(UNIT_GHOST_OPACITY, 0.5);
  assert.equal(UNIT_STEALTH_OPACITY, 0.35);
  // A stealthed ghost is not a state the game has; if one arrives, the warning wins.
  assert.deepEqual(unitAppearance({ creep: true, ghost: true }),
    { opacity: UNIT_STEALTH_OPACITY, stealth: true });
  assert.deepEqual(unitAppearance({ invisibilityAura: true, ghost: true }),
    { opacity: UNIT_INVISIBILITY_OPACITY, stealth: false });
});

/** The three families HumanMale actually ships: measured, 43 opaque, 17 alpha-key and 1 additive. */
function familyMaterial(blendMode) {
  const material = new THREE.MeshBasicMaterial();
  applyBlendMode(material, blendMode);
  return material;
}

test("fading honours what each blend mode does with alpha", () => {
  // Opaque (43 of HumanMale's 61 drawable batches): alpha is ignored until `transparent` is on.
  const opaque = familyMaterial(0);
  assert.equal(opaque.transparent, false);
  fadeMaterial(opaque, 0.35);
  assert.equal(opaque.transparent, true);
  assert.equal(opaque.opacity, 0.35);

  // Alpha-key (17 of them: hair, fringes, cloth). The threshold has to come down with the alpha or
  // the test discards every fragment and the character loses its hair instead of fading.
  const key = familyMaterial(1);
  assert.equal(key.alphaTest, 224 / 255);
  fadeMaterial(key, 0.35);
  assert.equal(key.transparent, true);
  assert.ok(Math.abs(key.alphaTest - (224 / 255) * 0.35) < 1e-9,
    `alpha test scaled with the alpha, got ${key.alphaTest}`);
  // The identical cut-out: a texel that passed at full strength still passes at 0.35.
  const texel = 0.95;
  assert.equal(texel > 224 / 255, texel * 0.35 > key.alphaTest);

  // Additive SrcAlpha/One (HumanMale's one, the death-knight eye glow): alpha already scales the
  // contribution, so the colour must not be faded a second time.
  const add = familyMaterial(4);
  const addColour = add.color.clone();
  fadeMaterial(add, 0.35);
  assert.equal(add.opacity, 0.35);
  assert.deepEqual(add.color.toArray(), addColour.toArray());

  // Additive One/One ignores alpha entirely, so the colour is the only thing that can fade it.
  const noAlphaAdd = familyMaterial(3);
  fadeMaterial(noAlphaAdd, 0.5);
  assert.deepEqual(noAlphaAdd.color.toArray(), [0.5, 0.5, 0.5]);

  // Mod and mod2x multiply what is already in the frame; no per-material number fades that, and
  // pretending otherwise would tint rather than fade. Left exactly as authored.
  for (const blendMode of [5, 6]) {
    const modulated = familyMaterial(blendMode);
    const before = { opacity: modulated.opacity, colour: modulated.color.toArray() };
    fadeMaterial(modulated, 0.35);
    assert.equal(modulated.opacity, before.opacity);
    assert.deepEqual(modulated.color.toArray(), before.colour);
  }
});

test("a faded copy keeps the shader chain three.js drops on clone", () => {
  const material = new THREE.MeshBasicMaterial();
  applyBlendMode(material, 0);
  const hook = () => {};
  material.onBeforeCompile = hook;
  material.customProgramCacheKey = () => "wvm-layer2-1|wvm-fog-4";
  const clone = cloneMaterialFaded(material, 0.35);
  assert.equal(clone.onBeforeCompile, hook,
    "an M2 material can carry a second-layer, fog and world-light chain; Material.copy drops it");
  assert.equal(clone.customProgramCacheKey(), "wvm-layer2-1|wvm-fog-4");
  assert.notEqual(clone, material);
  assert.equal(material.opacity, 1, "the shared original is untouched");
  assert.equal(clone.opacity, 0.35);
});

test("a unit borrows faded materials and gives the shared arrays back by identity", () => {
  // A build's material array is shared by every unit of that appearance, which is exactly why the
  // fade cannot be written into it.
  const shared = [familyMaterial(0), familyMaterial(1)];
  const body = new THREE.Mesh(new THREE.BufferGeometry(), shared);
  const weapon = new THREE.Mesh(new THREE.BufferGeometry(), familyMaterial(0));

  const borrows = borrowFadedMaterials([body, weapon], UNIT_STEALTH_OPACITY);
  assert.equal(borrows.length, 2);
  assert.notEqual(body.material, shared);
  assert.equal(body.material.length, 2);
  assert.equal(body.material[0].opacity, UNIT_STEALTH_OPACITY);
  assert.equal(shared[0].opacity, 1, "the shared array is untouched, so the street stays opaque");
  // A single-material mesh stays single: an array over geometry with no groups draws nothing.
  assert.ok(!Array.isArray(weapon.material));
  assert.equal(weapon.material.opacity, UNIT_STEALTH_OPACITY);

  const clones = borrows.flatMap((borrow) => borrow.clones);
  returnBorrowedMaterials(borrows);
  assert.equal(body.material, shared, "the exact array back, not an equal one");
  assert.equal(shared[1].alphaTest, 224 / 255, "and its alpha test never moved");
  for (const clone of clones) assert.equal(clone.version >= 0, true);
});

test("re-borrowing a mesh that is already faded would compound, so the caller must return first", () => {
  // The guard is in `#applyUnitOpacity`, which returns early while the wanted value is the applied
  // one and releases before every re-application. This pins the reason that guard exists: a second
  // borrow over an unreturned first squares the fade and loses the shared array.
  const shared = [familyMaterial(0)];
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), shared);
  const first = borrowFadedMaterials([mesh], 0.35);
  const second = borrowFadedMaterials([mesh], 0.35);
  assert.ok(Math.abs(mesh.material[0].opacity - 0.35 * 0.35) < 1e-9);
  assert.notEqual(second[0].shared, shared);
  returnBorrowedMaterials(second);
  returnBorrowedMaterials(first);
  assert.equal(mesh.material, shared, "returning in reverse order still restores the original");
});

function pose(overrides = {}) {
  return {
    dead: false, movementFlags: 0, spline: false, standState: UNIT_STAND_STATE_STAND, ...overrides,
  };
}

test("a stealthed unit stands, walks and runs crouched, and falls through to the ordinary gait", withAnimationData, () => {
  const { Stand, Walk, Run, Walkbackwards, ShuffleLeft, RunLeft } = ANIMATION_IDS;
  const StealthStand = ANIMATION_IDS["StealthStand"];
  const StealthWalk = ANIMATION_IDS["StealthWalk"];
  const StealthRun = ANIMATION_IDS["StealthRun"];
  assert.deepEqual([StealthStand, StealthWalk, StealthRun], [120, 119, 223]);

  assert.deepEqual(poseAnimation(pose({ stealth: true })).wanted, [StealthStand, Stand]);
  assert.deepEqual(poseAnimation(pose()).wanted, [Stand]);

  const running = pose({ stealth: true, movementFlags: MOVEMENT_FLAGS.forward, speed: 7 });
  assert.deepEqual(poseAnimation(running).wanted, [StealthRun, StealthWalk, Run, Walk]);
  const walking = pose({ stealth: true, movementFlags: MOVEMENT_FLAGS.forward, speed: 2.5 });
  assert.deepEqual(poseAnimation(walking).wanted, [StealthWalk, StealthRun, Walk, Run]);

  // There is no StealthWalkBackwards and no crouched strafe in AnimationData, so those ladders ask
  // for the crouched walk and keep the ordinary answer for that direction behind it.
  assert.deepEqual(
    poseAnimation(pose({ stealth: true, movementFlags: MOVEMENT_FLAGS.backward })).wanted,
    [StealthWalk, Walkbackwards, Walk]);
  assert.deepEqual(
    poseAnimation(pose({ stealth: true, movementFlags: MOVEMENT_FLAGS.strafeLeft, speed: 2.5 })).wanted,
    [StealthWalk, ShuffleLeft, RunLeft]);

  // Ground only. Swimming, flying and the airborne arc keep their own ladders — measured, no rig
  // this client ships carries any of 348/349/452.
  const swimming = pose({ stealth: true, movementFlags: MOVEMENT_FLAGS.swimming });
  assert.ok(!poseAnimation(swimming).wanted.includes(StealthWalk));
  const falling = pose({ stealth: true, movementFlags: MOVEMENT_FLAGS.falling });
  assert.ok(!poseAnimation(falling).wanted.includes(StealthWalk));
  // And sitting is sitting: the crouch is a standing pose.
  const seated = pose({ stealth: true, standState: UNIT_STAND_STATE_SIT });
  assert.ok(!poseAnimation(seated).wanted.includes(StealthStand));
  // A mounted rogue is a rider, and `mountPose` takes the crouch off the animal underneath.
  assert.equal(mountPose(pose({ stealth: true, mounted: true })).stealth, false);
});

test("a crouch request stays in its family until the rig's own crouch rows are exhausted", withAnimationData, () => {
  const { Walk, Run, Walkbackwards, Stand } = ANIMATION_IDS;
  const StealthWalk = ANIMATION_IDS["StealthWalk"];
  const StealthRun = ANIMATION_IDS["StealthRun"];
  // HumanMale as built before its sidecar lands: the 21 base clips, no crouch among them.
  const base = new Map([Stand, Walk, Run, Walkbackwards].map((id) => [id, {}]));
  // AnimationData sends StealthWalk straight to Walk, so the ordinary resolver answers the crouch
  // with the ordinary gait — which is right for drawing and fatal for fetching.
  assert.equal(resolveAnimation(base, [StealthWalk]), Walk);
  assert.equal(resolveStealthAnimation(base, [StealthWalk]), undefined);
  // Behind the family the tail is answered normally, and in its own order: a stealthed unit walking
  // backwards on a rig with no crouch still walks backwards rather than forwards.
  assert.equal(resolveStealthAnimation(base, [StealthWalk, Walkbackwards, Walk]), Walkbackwards);
  // A rig that carries one crouch row uses it rather than falling past it.
  const withWalk = new Map([...base, [StealthWalk, {}]]);
  assert.equal(resolveStealthAnimation(withWalk, [StealthRun, StealthWalk, Run, Walk]), StealthWalk);
  // And the DBC chain inside the family still applies: StealthRun -> StealthWalk.
  assert.equal(resolveStealthAnimation(withWalk, [StealthRun]), StealthWalk);

  assert.equal(poseAnimationFamily({ stealth: true }), "stealth");
  assert.equal(poseAnimationFamily({ mounted: true, stealth: true }), "mount");
  assert.equal(poseAnimationFamily({}), "any");
});

test("the crouch is fetched from the sidecar, and a rig without one asks for nothing", withAnimationData, () => {
  const { Stand, Walk, Run } = ANIMATION_IDS;
  const StealthWalk = ANIMATION_IDS["StealthWalk"];
  const StealthRun = ANIMATION_IDS["StealthRun"];
  const wanted = [StealthWalk, StealthRun, Walk, Run];

  // HumanMale: 199 declared animations, 21 built, the crouch among the 182 held back.
  const human = {
    clips: new Map([Stand, Walk, Run].map((id) => [id, {}])),
    animations: new Set([Stand, Walk, Run, StealthWalk, StealthRun]),
    merged: false,
  };
  assert.equal(needsSidecarAnimations(human, wanted, "stealth"), true);
  // The whole point of the family: the same list asked the ordinary way resolves to Walk against
  // the base clips and the sidecar is never requested — the defect A1 wrote down, in a new place.
  assert.equal(needsSidecarAnimations(human, wanted, "any"), false);

  // Once the sidecar is merged there is nothing left to ask for.
  assert.equal(needsSidecarAnimations({ ...human, merged: true }, wanted, "stealth"), false);
  human.clips.set(StealthWalk, {});
  assert.equal(needsSidecarAnimations(human, wanted, "stealth"), false);

  // DruidCat, measured: 50 animations and not one of the six crouch rows. It must ask for nothing
  // rather than pull a 9.8 MB sidecar for a pose it does not have.
  const cat = {
    clips: new Map([Stand, Walk, Run].map((id) => [id, {}])),
    animations: new Set([Stand, Walk, Run]),
    merged: false,
  };
  assert.equal(needsSidecarAnimations(cat, wanted, "stealth"), false);
  // And it still draws: `chooseAnimation` resolves the tail of the same ladder.
  assert.deepEqual(
    chooseAnimation(cat.clips, pose({ stealth: true, movementFlags: MOVEMENT_FLAGS.forward, speed: 7 })),
    { animation: Run, loop: true });
});
