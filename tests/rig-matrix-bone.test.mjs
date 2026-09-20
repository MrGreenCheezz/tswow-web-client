import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RigMatrixBone } from '../dist/code/browser/RigMatrixBone.js';

function compare(a, b) {
  for (const name of ['matrix', 'matrixWorld']) {
    assert.deepEqual(a[name].elements.map(x => x || 0), b[name].elements.map(x => x || 0), name);
  }
  assert.equal(a.matrixWorldNeedsUpdate, b.matrixWorldNeedsUpdate);
  assert.equal(a.children.length, b.children.length);
  for (let i = 0; i < a.children.length; i++) compare(a.children[i], b.children[i]);
}

test('managed bone hierarchy is numerically identical to Three with animated TRS, mirrored scale and attachments', () => {
  const roots = [new THREE.Group(), new THREE.Group()];
  const lists = roots.map((root, side) => {
    const bones = [];
    for (let i = 0; i < 48; i++) {
      const bone = side ? new RigMatrixBone() : new THREE.Bone();
      (i ? bones[Math.floor((i - 1) / 3)] : root).add(bone);
      if (i % 7 === 0) bone.add(new THREE.Group());
      bones.push(bone);
    }
    return bones;
  });
  for (let frame = 0; frame < 90; frame++) {
    for (let side = 0; side < 2; side++) {
      roots[side].position.set(Math.sin(frame), frame / 9, -100);
      roots[side].rotation.set(.2, frame * .01, -.3);
      lists[side].forEach((bone, i) => {
        bone.position.set(Math.sin(frame * .1 + i), i * .02, Math.cos(frame * .03 - i));
        bone.rotation.set(frame * .002 + i, i * .12, -frame * .004);
        bone.scale.set(i % 2 ? -1.3 : 1, .7, 2);
      });
      roots[side].updateMatrixWorld(frame % 2 === 0);
    }
    compare(...roots);
  }
});

for (const mode of ['pivot', 'manual-local', 'manual-world', 'projective-parent', 'ancestor-update', 'invalid']) {
  test(`managed bone preserves Three fallback: ${mode}`, () => {
    const roots = [new THREE.Group(), new THREE.Group()];
    roots.forEach((root, i) => {
      const bone = i ? new RigMatrixBone() : new THREE.Bone();
      const child = new THREE.Group(); root.add(bone); bone.add(child);
      bone.position.set(2, 3, 4); bone.rotation.set(.1, .2, .3); child.position.set(7, -1, 4);
      if (mode === 'pivot') bone.pivot = new THREE.Vector3(1, 2, 3);
      if (mode === 'manual-local') { bone.matrixAutoUpdate = false; bone.matrix.makeRotationX(.4); }
      if (mode === 'manual-world') { bone.matrixWorldAutoUpdate = false; bone.matrixWorld.makeTranslation(9, 8, 7); }
      if (mode === 'projective-parent') { root.matrixAutoUpdate = false; root.matrix.elements[3] = .01; }
      if (mode === 'invalid') bone.position.x = Infinity;
      root.updateMatrixWorld();
      if (mode === 'ancestor-update') { bone.position.y = 8; child.updateWorldMatrix(true, false); }
    });
    compare(...roots);
  });
}
