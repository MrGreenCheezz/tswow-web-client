import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildSkinnedTemplateFrom, instantiateSkinned } from '../dist/code/browser/AnimatedModel.js';

function makeRig() {
  const count = 48;
  const template = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.from({ length: count }, (_, i) => i === 0 ? -1 : (i - 1) >>> 1),
    pivots: Float32Array.from({ length: count * 3 }, (_, i) => (i % 13 - 6) * .2),
    flags: new Uint16Array(count), animations: [0], globalChannels: [],
    clips: [{ animationId: 0, duration: 1, channels: Array.from({ length: count }, (_, bone) => ({
      bone, kind: 1, times: Float32Array.from([0, 1]),
      values: Float32Array.from([0, 0, 0, 1, Math.sin(bone * .01), 0, 0, Math.cos(bone * .01)]),
    })) }],
  }, 2);
  const rig = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  rig.mixer.clipAction(template.clips.get(0)).play();
  return rig;
}

function referencePalette(rig) {
  THREE.Skeleton.prototype.update.call(rig.skeleton);
  return rig.skeleton.boneMatrices.slice();
}

test('M2 pivot palettes avoid general 4x4 products for every bone', () => {
  const rig = makeRig();
  rig.root.updateMatrixWorld(true);
  const multiply = THREE.Matrix4.prototype.multiplyMatrices;
  let products = 0;
  THREE.Matrix4.prototype.multiplyMatrices = function (...args) {
    products++;
    return multiply.apply(this, args);
  };
  try { rig.skeleton.update(); }
  finally { THREE.Matrix4.prototype.multiplyMatrices = multiply; }
  assert.equal(products, 0, 'translation-only inverse binds require only the translated final column');
});

test('moving, rotated, nonuniformly scaled and reparented rigs retain reference palettes and GPU uploads', () => {
  const rig = makeRig(), scene = new THREE.Scene(), outer = new THREE.Group();
  scene.add(outer); outer.add(rig.root);
  rig.skeleton.computeBoneTexture();
  for (let frame = 0; frame < 90; frame++) {
    outer.position.set(frame * .3, -frame * .05, 3);
    outer.rotation.set(frame * .01, frame * -.02, frame * .03);
    outer.scale.set(1 + frame * .01, .7, 1.3);
    rig.root.position.set(.5, -.3, frame * .02);
    rig.mixer.update(1 / 120);
    if (frame === 30) scene.attach(rig.root);
    if (frame === 60) outer.attach(rig.root);
    scene.updateMatrixWorld(true);
    const expected = referencePalette(rig);
    const version = rig.skeleton.boneTexture.version;
    rig.skeleton.update();
    assert.deepEqual(rig.skeleton.boneMatrices, expected, `palette at frame ${frame}`);
    assert.equal(rig.skeleton.boneTexture.version, version + 1);
    assert.equal(rig.skeleton.boneTexture.image.data, rig.skeleton.boneMatrices);
  }
});

test('edited inverse binds and recalculated bind poses still use the full matrix contract', () => {
  const rig = makeRig();
  rig.root.position.set(4, -3, 2);
  rig.mixer.update(.3);
  rig.root.updateMatrixWorld(true);
  rig.skeleton.boneInverses[3].makeRotationY(.6);
  rig.skeleton.boneInverses[7].makeScale(.7, 1.2, .9);
  rig.skeleton.boneInverses[9].elements[3] = .1;
  rig.skeleton.boneInverses[11] = new THREE.Matrix4().makeTranslation(5, -6, 7);
  let expected = referencePalette(rig);
  rig.skeleton.update();
  assert.deepEqual(rig.skeleton.boneMatrices, expected);
  rig.skeleton.calculateInverses();
  rig.mixer.update(.2);
  rig.root.updateMatrixWorld(true);
  expected = referencePalette(rig);
  rig.skeleton.update();
  assert.deepEqual(rig.skeleton.boneMatrices, expected);
});
