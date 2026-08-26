import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { TRACK_KINDS, encodeVisualModel } from "../tools/m2-visual.mjs";
import { decodeVisualModel } from "../dist/code/browser/Terrain.js";
import {
  MOVEMENT_FLAG_TRANSLATING, MOVEMENT_FLAG_WALKING, buildSkinnedTemplate, chooseAnimation,
  instantiateSkinned, isUnitMoving,
} from "../dist/code/browser/AnimatedModel.js";
import { ANIMATION_IDS } from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

/** A unit doing nothing, which every case below varies one thing from. */
function standing(overrides = {}) {
  return { dead: false, movementFlags: 0, spline: false, standState: 0, ...overrides };
}

/** A two-bone model: bone 1 hangs one unit above bone 0 and swings a quarter turn. */
function sampleModel() {
  const compress = (value) => Math.round(value >= 0 ? value * 32767 + 32767 : value * 32767 - 32768);
  const halfTurn = Math.SQRT1_2;
  return {
    mesh: {
      vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1],
      uvs: [0, 0, 1, 0, 0, 1],
      indices: [0, 1, 2],
      groups: [{ start: 0, count: 3, material: 0 }],
    },
    textures: ["/visual/texture/sample.png"],
    skeleton: {
      bones: [
        { parent: -1, flags: 0, pivot: [0, 0, 0] },
        { parent: 0, flags: 0, pivot: [0, 0, 1] },
      ],
      skinIndices: Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      skinWeights: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]),
      clips: [{
        animationId: ANIMATION_IDS.Walk,
        duration: 1000,
        channels: [{
          bone: 1,
          kind: TRACK_KINDS.rotation,
          interpolation: 1,
          times: Uint32Array.from([0, 1000]),
          // Identity, then a quarter turn about the model's own up axis.
          values: Int16Array.from([compress(0), compress(0), compress(0), compress(1),
            compress(0), compress(0), compress(halfTurn), compress(halfTurn)]),
        }],
      }],
    },
  };
}

function encoded() {
  const sample = sampleModel();
  const buffer = encodeVisualModel(sample.mesh, sample.textures, sample.skeleton);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test("a skinned model survives the round trip through the WVM3 container", () => {
  const model = decodeVisualModel(encoded(), "http://gateway.local");
  assert.deepEqual(model.vertices, [0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(model.textureUrls, ["http://gateway.local/visual/texture/sample.png"]);
  assert.ok(model.skeleton);
  assert.deepEqual([...model.skeleton.parents], [-1, 0]);
  assert.deepEqual([...model.skeleton.pivots], [0, 0, 0, 0, 0, 1]);
  // Weights arrive as bytes and come back normalised for the GPU.
  assert.deepEqual([...model.skeleton.skinWeights.slice(0, 4)], [1, 0, 0, 0]);
  assert.equal(model.skeleton.clips.length, 1);
  const clip = model.skeleton.clips[0];
  assert.equal(clip.animationId, ANIMATION_IDS.Walk);
  assert.equal(clip.duration, 1);
  assert.deepEqual([...clip.channels[0].times], [0, 1]);
  // int16 rotation keys decompress back to unit quaternions.
  const last = clip.channels[0].values.slice(4);
  assert.ok(Math.abs(Math.hypot(...last) - 1) < 1e-3);
  assert.ok(Math.abs(last[3] - Math.SQRT1_2) < 1e-3);
});

test("the rest pose of a skinned instance reproduces the untouched mesh", () => {
  const template = buildSkinnedTemplate(decodeVisualModel(encoded(), ""));
  assert.ok(template);
  const instance = instantiateSkinned(template, new THREE.MeshStandardMaterial());
  instance.root.updateMatrixWorld(true);
  instance.skeleton.update();

  // three keeps the skinning matrices in the mesh's own frame (AttachedBindMode), so bone matrix
  // times its inverse has to come out as the identity before anything is animated.
  const toMeshSpace = new THREE.Matrix4().copy(instance.mesh.matrixWorld).invert();
  const product = new THREE.Matrix4();
  const identity = new THREE.Matrix4();
  for (let bone = 0; bone < instance.skeleton.bones.length; bone++) {
    product.multiplyMatrices(toMeshSpace, instance.skeleton.bones[bone].matrixWorld)
      .multiply(instance.skeleton.boneInverses[bone]);
    for (let cell = 0; cell < 16; cell++) {
      assert.ok(Math.abs(product.elements[cell] - identity.elements[cell]) < 1e-6,
        `bone ${bone} is not at rest at element ${cell}`);
    }
  }
});

test("playing an animation actually moves the bone it targets", () => {
  const template = buildSkinnedTemplate(decodeVisualModel(encoded(), ""));
  const instance = instantiateSkinned(template, new THREE.MeshStandardMaterial());
  const chosen = chooseAnimation(template.clips, standing({ movementFlags: MOVEMENT_FLAGS.forward }));
  assert.equal(chosen.animation, ANIMATION_IDS.Walk, "a running unit with only a walk clip has to walk");
  assert.equal(chosen.loop, true, "a stride repeats");
  instance.mixer.clipAction(template.clips.get(chosen.animation)).play();

  instance.root.updateMatrixWorld(true);
  const before = instance.skeleton.bones[1].quaternion.clone();
  instance.mixer.update(0.5);
  instance.root.updateMatrixWorld(true);
  const after = instance.skeleton.bones[1].quaternion;
  assert.ok(before.angleTo(after) > 0.1, "half way through the clip the bone must have turned");
  // The animated bone keeps its rest offset, since M2 translation is relative to the pivot.
  assert.deepEqual(instance.skeleton.bones[1].position.toArray(), [0, 0, 1]);
});

test("a dead unit falls back to the death clip when no corpse pose was exported", () => {
  const { Stand, Death, Dead, Walk, Attack1H } = ANIMATION_IDS;
  const clips = new Map([[Stand, {}], [Death, {}], [Walk, {}]]);
  const dying = chooseAnimation(clips, standing({ dead: true }));
  assert.equal(dying.animation, Death);
  // Looping a death has the body die over and over; without a corpse pose it is clamped instead.
  assert.equal(dying.loop, false);
  assert.equal(chooseAnimation(clips, standing()).animation, Stand);
  assert.equal(chooseAnimation(clips, standing({ movementFlags: MOVEMENT_FLAGS.forward })).animation, Walk,
    "run falls back to walk when absent");

  const withCorpse = new Map([[Stand, {}], [ANIMATION_IDS.Run, {}], [Dead, {}]]);
  const corpse = chooseAnimation(withCorpse, standing({ dead: true }));
  assert.equal(corpse.animation, Dead);
  assert.equal(corpse.loop, true, "lying there is a pose, and it holds");

  // A model with nothing suitable still has to name a clip, or it freezes on the previous pose.
  assert.equal(chooseAnimation(new Map([[Attack1H, {}]]), standing()).animation, Attack1H);
  assert.equal(chooseAnimation(new Map(), standing()), undefined);
});

test("movement is read from the server flags, not from the smoothing between packets", () => {
  // Standing still: the interpolation may still be running out, and used to read as running.
  assert.equal(isUnitMoving(0, false), false);
  assert.equal(isUnitMoving(0, true), true, "a unit following a spline path is moving");
  assert.equal(isUnitMoving(MOVEMENT_FLAG_TRANSLATING & 1, false), true, "walking forward");
  assert.equal(isUnitMoving(0x2, false), true, "walking backward");
  assert.equal(isUnitMoving(0x8, false), true, "strafing");
  // Turning on the spot is not movement, and neither is the walk bit on its own.
  assert.equal(isUnitMoving(0x10, false), false, "turning left");
  assert.equal(isUnitMoving(0x20, false), false, "turning right");
  assert.equal(isUnitMoving(MOVEMENT_FLAG_WALKING, false), false);
  assert.equal(isUnitMoving(MOVEMENT_FLAG_WALKING | 0x1, false), true);
});
