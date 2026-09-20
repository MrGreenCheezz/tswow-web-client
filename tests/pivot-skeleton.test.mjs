import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PivotSkeleton } from '../dist/code/browser/PivotSkeleton.js';

function same(actual, expected) {
  assert.deepEqual(Array.from(actual, v => v === 0 ? 0 : v), Array.from(expected, v => v === 0 ? 0 : v));
}

test('pivot palette matches Three for animated hierarchies, scale and mirrored transforms', () => {
  const root = new THREE.Group();
  const bones = Array.from({ length: 48 }, (_, i) => {
    const bone = new THREE.Bone(); bone.name = `bone${i}`; return bone;
  });
  bones.forEach((bone, i) => (i ? bones[Math.floor((i - 1) / 3)] : root).add(bone));
  const inverses = bones.map((_, i) => new THREE.Matrix4().makeTranslation(i * .13, i * -.3, i * .04));
  const fast = new PivotSkeleton(bones, inverses), reference = new THREE.Skeleton(bones, inverses);
  for (let frame = 0; frame < 120; frame++) {
    root.position.set(frame * .1, 2, -3); root.rotation.set(.2, frame * .01, -.7);
    bones.forEach((bone, i) => {
      bone.position.set(Math.sin(frame * .03 + i), i * .1, Math.cos(frame * .02 - i));
      bone.rotation.set(frame * .007 + i, i * .03, -frame * .02);
      bone.scale.set(i % 2 ? -.9 : 1.1, 1 + i * .002, .97);
    });
    root.updateMatrixWorld(true); fast.update(); reference.update();
    same(fast.boneMatrices, reference.boneMatrices);
  }
});

test('mutated general inverse, projective world and non-finite values retain Three arithmetic', () => {
  const bone = new THREE.Bone();
  const inverse = new THREE.Matrix4().makeTranslation(1, 2, 3);
  const fast = new PivotSkeleton([bone], [inverse]), reference = new THREE.Skeleton([bone], [inverse]);
  for (const mutate of [
    () => bone.matrixWorld.set(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, .1, .2, .3, .4),
    () => inverse.makeRotationY(.4),
    () => { inverse.makeTranslation(3, 2, 1); bone.matrixWorld.elements[3] = Infinity; },
    () => { bone.matrixWorld.identity(); inverse.elements[12] = NaN; },
  ]) {
    mutate(); fast.update(); reference.update(); same(fast.boneMatrices, reference.boneMatrices);
  }
});

test('texture allocation, missing bones and replacement inverses remain observable', () => {
  const bones = [new THREE.Bone(), undefined];
  const inverses = [new THREE.Matrix4(), new THREE.Matrix4().makeTranslation(-1, 2, -3)];
  const fast = new PivotSkeleton(bones, inverses), reference = new THREE.Skeleton(bones, inverses);
  fast.computeBoneTexture(); reference.computeBoneTexture();
  const version = fast.boneTexture.version;
  fast.boneInverses = reference.boneInverses = inverses.map(m => m.clone().scale(new THREE.Vector3(2, 3, 4)));
  fast.update(); reference.update();
  same(fast.boneMatrices, reference.boneMatrices);
  assert.equal(fast.boneTexture.version, version + 1);
  assert.equal(fast.boneTexture.image.data, fast.boneMatrices);
  fast.dispose(); reference.dispose();
});
