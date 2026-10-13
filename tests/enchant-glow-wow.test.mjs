import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { noGlowTint } from "../dist/code/browser/WeaponGlow.js";
import { glowRigOnly, mountGlowBodies, poseGlowBodies } from "../dist/code/browser/WeaponGlowBody.js";

// 13.10 6.14: weapon enchant glows as Wow.exe 3.3.5a 12340 hangs them (read-only Ghidra).
// 0x004ea8f0 (ItemVisuals of an item model) loads slot i's ItemVisualEffects model and calls
// CM2Model::AttachToParent 0x00831630(itemModel, attachment i, 0, force 0): a parent whose attachment table
// gives 0xffff for i, without force, gets nothing — no fallback point and no tint. The effect model is a CM2Model
// like any other, animated by CM2Model::Animate 0x00828a00 together with its emitters.

const SPIN = {
  parents: new Int16Array([-1]), flags: new Uint16Array(1), pivots: new Float32Array(3), animations: [0], globalChannels: [],
  clips: [{ animationId: 0, duration: 1, variationIndex: 0,
    channels: [{ bone: 0, kind: 0, times: Float32Array.of(0, 1), values: Float32Array.of(0, 0, 0, 2, 0, 0) }] }],
};
const EMITTERS_ONLY = { indices: new Uint16Array(0), batches: [], particleEmitters: [{}], ribbonEmitters: [],
  globalSequences: new Uint32Array(0), skeleton: SPIN };

test("6.14 a gateway that sends the slots has no tint fallback; one that sends none keeps it", () => {
  assert.equal(noGlowTint({ slots: [null, null, null, null, "Spells\\Enchantments\\Sparkle_A.m2"] }), true);
  assert.equal(noGlowTint({ slots: [null, null, null, null, null] }), true, "slots that name nothing still decide");
  assert.equal(noGlowTint({}), false, "an old gateway: the tint is the only signal");
});

test("6.14 the renderer tints a blade only when the gateway sent no slots", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(item\.glow && !noGlowTint\(item\.glow\) && item\.glow\.intensity > 0\) \{/);
  assert.doesNotMatch(source, /item\.glow && glowPlacements\.length === 0 && item\.glow\.intensity > 0/,
    "a weapon without the attachments no longer gets a tint");
  assert.match(source, /if \(!glowHasMesh\(wvm\)\) return glowRigOnly\(wvm\);/, "emitter-only glows get their rig");
});

test("6.14 an emitter-only glow gets a rig and nothing to draw, and its bones play", () => {
  const body = glowRigOnly(EMITTERS_ONLY);
  assert.ok(body && body.skinned, "a rig");
  assert.equal(body.skinned.mesh.visible, false, "nothing drawn");
  assert.equal(body.object.quaternion.w, 1, "the weapon's model space: no M2→scene turn");
  const anchor = { path: "Spells\\Enchantments\\GreenGlow.m2", anchor: new THREE.Object3D(), wvm: EMITTERS_ONLY, body: undefined };
  assert.equal(mountGlowBodies([anchor], () => body), 1);
  poseGlowBodies([anchor], 0.5, 0, new THREE.PerspectiveCamera());
  const bone = body.skinned.skeleton.bones[0];
  assert.ok(Math.abs(bone.position.x - 1) < 1e-6, `Stand moves the bone the emitters sit on (x ${bone.position.x})`);
  assert.equal(glowRigOnly({ ...EMITTERS_ONLY, skeleton: undefined }), null, "no skeleton, no rig");
  assert.equal(glowRigOnly({ ...EMITTERS_ONLY, indices: new Uint16Array(3), batches: [{}] }), null, "a mesh gets a real body");
});
