import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildSkinnedTemplateFrom, instantiateSkinned } from '../dist/code/browser/AnimatedModel.js';

function template() {
  return buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.from([-1, 0, 1]),
    pivots: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]),
    flags: new Uint16Array(3),
    clips: [{ animationId: 0, duration: 1, channels: [{
      bone: 1, kind: 0, times: Float32Array.from([0, 1]),
      values: Float32Array.from([0, 0, 0, 0, 1, 0]),
    }] }],
    animations: [0], globalChannels: [],
  }, 2);
}

function paletteOf(instance) {
  return Array.from(instance.skeleton.boneMatrices.subarray(0, instance.skeleton.bones.length * 16));
}

test('frozen pose reuses stationary palette, follows ancestor motion, and resumes animation', () => {
  const rig = template();
  assert.ok(rig);
  const scene = new THREE.Scene();
  const parents = [new THREE.Group(), new THREE.Group()];
  const [reference, optimized] = parents.map((parent) => {
    const instance = instantiateSkinned(rig, new THREE.MeshBasicMaterial());
    parent.add(instance.root);
    scene.add(parent);
    instance.mixer.clipAction(rig.clips.get(0)).play();
    return instance;
  });

  // Freeze immediately after a mixer tick, before Three's scene traversal has composed the bone.
  reference.mixer.update(.25);
  optimized.mixer.update(.25);
  optimized.skeleton.setPoseFrozen(true);
  scene.updateMatrixWorld(true);
  reference.skeleton.update();
  optimized.skeleton.update();
  assert.deepEqual(paletteOf(optimized), paletteOf(reference));

  optimized.skeleton.computeBoneTexture();
  const texture = optimized.skeleton.boneTexture;
  optimized.skeleton.update();
  const cachedVersion = texture.version;
  optimized.skeleton.setPoseFrozen(true);
  assert.equal(optimized.skeleton.bones[0].frozenMatrixBranch, true);
  scene.updateMatrixWorld(true);
  optimized.skeleton.update();
  assert.equal(texture.version, cachedVersion, 'stationary frozen pose avoids palette upload');
  assert.deepEqual(paletteOf(optimized), paletteOf(reference));

  // The root's local transform is untouched; motion arrives through an ancestor (as on a mount).
  for (const parent of parents) {
    parent.position.set(3, 2, -4);
    parent.rotation.y = .4;
  }
  optimized.skeleton.setPoseFrozen(true);
  scene.updateMatrixWorld(true);
  reference.skeleton.update();
  optimized.skeleton.update();
  assert.ok(texture.version > cachedVersion, 'ancestor motion refreshes palette');
  assert.deepEqual(paletteOf(optimized), paletteOf(reference));

  optimized.skeleton.setPoseFrozen(false);
  reference.mixer.update(.25);
  optimized.mixer.update(.25);
  scene.updateMatrixWorld(true);
  reference.skeleton.update();
  optimized.skeleton.update();
  assert.deepEqual(paletteOf(optimized), paletteOf(reference));
  assert.equal(optimized.skeleton.bones[1].matrixAutoUpdate, true);
  assert.equal(optimized.skeleton.bones[1].matrixWorldAutoUpdate, true);
});

test('frozen branches skip bone traversal but retain attachment paths and late root motion', () => {
  const rig = template();
  const scene = new THREE.Scene();
  const optimized = instantiateSkinned(rig, new THREE.MeshBasicMaterial());
  const reference = instantiateSkinned(rig, new THREE.MeshBasicMaterial());
  scene.add(optimized.root, reference.root);
  scene.updateMatrixWorld(true);
  optimized.skeleton.update();
  reference.skeleton.update();
  optimized.skeleton.setPoseFrozen(true);
  scene.updateMatrixWorld(true);
  optimized.skeleton.update();
  optimized.skeleton.setPoseFrozen(true);

  const bone = optimized.skeleton.bones[1];
  const original = bone.updateMatrixWorld.bind(bone);
  let visits = 0;
  bone.updateMatrixWorld = (...args) => { visits++; return original(...args); };
  scene.updateMatrixWorld(true);
  assert.equal(visits, 0, 'bone-only subtree is omitted from scene matrix traversal');

  const gear = new THREE.Object3D();
  gear.position.set(0, 1, 0);
  optimized.skeleton.bones[2].add(gear);
  assert.equal(optimized.skeleton.bones[0].visible, true);
  scene.updateMatrixWorld(true);
  assert.ok(visits > 0, 'new attachment reopens its bone path');
  const gearPosition = new THREE.Vector3().setFromMatrixPosition(gear.matrixWorld);
  assert.ok(gearPosition.length() > 0);
  gear.removeFromParent();

  // Explicit attachment/emitter queries use updateWorldMatrix, even on a frozen branch.
  optimized.root.position.x = 2;
  reference.root.position.x = 2;
  optimized.root.updateWorldMatrix(true, true);
  reference.root.updateWorldMatrix(true, true);
  assert.deepEqual(optimized.skeleton.bones[2].matrixWorld.elements,
    reference.skeleton.bones[2].matrixWorld.elements);

  // Deliberately move after the frozen decision. Skeleton.update must restore propagation.
  optimized.root.position.x = 4;
  reference.root.position.x = 4;
  scene.updateMatrixWorld(true);
  optimized.skeleton.update();
  reference.skeleton.update();
  assert.deepEqual(paletteOf(optimized), paletteOf(reference));
});

test('a single skipped frame immediately reuses the palette after a rendered mixer tick', () => {
  const rig = template();
  const scene = new THREE.Scene();
  const instance = instantiateSkinned(rig, new THREE.MeshBasicMaterial());
  scene.add(instance.root);
  instance.mixer.clipAction(rig.clips.get(0)).play();
  instance.skeleton.computeBoneTexture();
  const texture = instance.skeleton.boneTexture;
  for (let cycle = 0; cycle < 3; cycle++) {
    instance.skeleton.setPoseFrozen(false);
    instance.mixer.update(.1);
    scene.updateMatrixWorld(true);
    instance.skeleton.update();
    const version = texture.version;
    instance.skeleton.setPoseFrozen(true);
    assert.equal(instance.skeleton.bones[0].frozenMatrixBranch, true);
    scene.updateMatrixWorld(true);
    instance.skeleton.update();
    assert.equal(texture.version, version, `one skipped frame after full tick ${cycle}`);
  }
});
