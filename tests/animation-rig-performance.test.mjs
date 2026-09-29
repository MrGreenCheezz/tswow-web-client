import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  buildSkinnedTemplateFrom, instantiateSkinned,
} from '../dist/code/browser/AnimatedModel.js';

function makeTemplate(count = 96) {
  const parents = Int16Array.from({ length: count }, (_, index) => index === 0 ? -1 : (index - 1) >>> 1);
  const pivots = Float32Array.from({ length: count * 3 }, (_, index) => (index % 7) / 4);
  const channels = Array.from({ length: count }, (_, bone) => ({
    bone, kind: 0, times: Float32Array.from([0, 1]),
    values: Float32Array.from([0, 0, 0, bone / 96, 0, 0]),
  }));
  return buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents, pivots, flags: new Uint16Array(count),
    clips: [{ animationId: 0, duration: 1, channels }], animations: [0], globalChannels: [],
  }, 2);
}

test('new clips bind fixed rig bone names in linear work and keep each rig independent', () => {
  const count = 192, template = makeTemplate(count);
  const instance = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  let nameReads = 0;
  for (const bone of instance.skeleton.bones) {
    const name = bone.name;
    Object.defineProperty(bone, 'name', { get() { nameReads++; return name; } });
  }
  instance.mixer.clipAction(template.clips.get(0)).play();
  assert.ok(nameReads <= count * 3, `expected O(bones) binding reads, got ${nameReads}`);
  instance.mixer.update(0.5);
  for (let index = 0; index < count; index++) {
    const parent = template.parents[index];
    const rest = template.pivots[index * 3] - (parent >= 0 ? template.pivots[parent * 3] : 0);
    assert.ok(Math.abs(instance.skeleton.bones[index].position.x - rest - index / 192) < 1e-6);
  }
});

test('mount clips use their own indexed bones after the rider is parented into the rig', () => {
  const template = makeTemplate(32), material = new THREE.MeshBasicMaterial();
  const mount = instantiateSkinned(template, material), rider = instantiateSkinned(template, material);
  mount.skeleton.bones[0].add(rider.root);
  const riderBefore = rider.skeleton.bones.map(bone => bone.position.clone());
  mount.mixer.clipAction(template.clips.get(0)).play();
  mount.mixer.update(0.5);
  for (let index = 0; index < rider.skeleton.bones.length; index++) {
    assert.deepEqual(rider.skeleton.bones[index].position, riderBefore[index]);
    assert.equal(mount.skeleton.getBoneByName(`bone${index}`), mount.skeleton.bones[index]);
    assert.equal(rider.skeleton.getBoneByName(`bone${index}`), rider.skeleton.bones[index]);
  }
  mount.skeleton.bones[3].name = 'renamed';
  assert.equal(mount.skeleton.getBoneByName('bone3'), undefined);
  assert.equal(mount.skeleton.getBoneByName('renamed'), mount.skeleton.bones[3]);
});
