import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  applyBillboardBones, applyGlobalSequenceBones, applyStrafeYaw,
  buildSkinnedTemplateFrom, instantiateSkinned,
} from '../dist/code/browser/AnimatedModel.js';
import {
  BONE_SPHERICAL_BILLBOARD, BONE_CYLINDRICAL_BILLBOARD_X,
  BONE_CYLINDRICAL_BILLBOARD_Y, BONE_CYLINDRICAL_BILLBOARD_Z,
} from '../dist/code/browser/Wvm.js';

// Reference algorithm before the ancestor-path optimization. Keep both full subtree passes:
// the regression compares the pose and immediate matrix contract, including nested billboards.
function referenceBillboards(instance, template, camera) {
  if (template.billboards.length === 0) return;
  instance.root.updateWorldMatrix(true, true);
  const view = camera.matrixWorld.elements;
  const right = new THREE.Vector3(view[0], view[1], view[2]).normalize();
  const up = new THREE.Vector3(view[4], view[5], view[6]).normalize();
  const axisX = new THREE.Vector3(), axisY = new THREE.Vector3(), axisZ = new THREE.Vector3();
  const pinnedAxis = new THREE.Vector3(), basis = new THREE.Matrix4();
  const world = new THREE.Quaternion(), parentRotation = new THREE.Quaternion();
  for (const index of template.billboards) {
    const bone = instance.skeleton.bones[index];
    if (!bone) continue;
    const flags = template.flags[index] ?? 0;
    axisY.copy(up); axisZ.copy(right).negate(); axisX.crossVectors(axisY, axisZ);
    if (axisX.lengthSq() < 1e-8) continue;
    axisX.normalize(); axisY.crossVectors(axisZ, axisX).normalize();
    if ((flags & BONE_SPHERICAL_BILLBOARD) === 0) {
      const pinned = (flags & BONE_CYLINDRICAL_BILLBOARD_X) !== 0 ? 0
        : (flags & BONE_CYLINDRICAL_BILLBOARD_Y) !== 0 ? 1 : 2;
      pinnedAxis.setFromMatrixColumn(bone.matrixWorld, pinned).normalize();
      const columns = [axisX, axisY, axisZ], next = columns[(pinned + 1) % 3];
      next.addScaledVector(pinnedAxis, -next.dot(pinnedAxis));
      if (next.lengthSq() < 1e-8) continue;
      next.normalize(); columns[(pinned + 2) % 3].crossVectors(pinnedAxis, next);
      columns[pinned].copy(pinnedAxis);
    }
    basis.makeBasis(axisX, axisY, axisZ); world.setFromRotationMatrix(basis);
    if (bone.parent) {
      bone.parent.getWorldQuaternion(parentRotation);
      bone.quaternion.copy(parentRotation.invert()).multiply(world);
    } else bone.quaternion.copy(world);
  }
  instance.root.updateWorldMatrix(false, true);
}

function makeTemplate(flags) {
  const parents = Int16Array.from([-1, 0, 1, 2, 2, 1, 5, 6]);
  const pivots = Float32Array.from([
    0, 0, 1.8, 0, 0, 1.2, 0, 0, 1, 0, -.2, .5,
    0, .2, .5, 0, 0, 1.5, 0, 0, 1.6, 0, 0, 1.7,
  ]);
  const channels = Array.from({ length: 8 }, (_, bone) => ({
    bone, kind: 1, times: Float32Array.from([0, 1]),
    values: Float32Array.from([0, 0, 0, 1, Math.sin(.1 + bone * .04), 0, 0, Math.cos(.1 + bone * .04)]),
  }));
  return buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents, pivots, flags: Uint16Array.from(flags),
    clips: [{ animationId: 0, duration: 1, channels }], animations: [0],
    globalChannels: [{ bone: 4, kind: 0, globalSequence: 0, interpolation: 1,
      times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, .1, .2, .3]) }],
  }, 2);
}

const material = new THREE.MeshBasicMaterial();
function makeScene(template, mounted) {
  const scene = new THREE.Scene(), outer = new THREE.Group(), unit = new THREE.Group();
  scene.add(outer); outer.add(unit);
  outer.rotation.set(.1, .2, .3); outer.scale.set(1.1, .9, 1.2); unit.position.set(2, 3, 4);
  const mount = instantiateSkinned(template, material);
  const rider = mounted ? instantiateSkinned(template, material) : undefined;
  unit.add(mount.root);
  if (rider) { mount.skeleton.bones[6].add(rider.root); rider.root.position.set(.1, .2, .3); }
  const rigs = rider ? [mount, rider] : [mount];
  for (const rig of rigs) rig.mixer.clipAction(template.clips.get(0)).play();
  return { scene, outer, unit, rigs };
}

const billboardCases = [
  { name: 'nested spherical billboards', flags: [0, 0, BONE_SPHERICAL_BILLBOARD, 0, 0,
    BONE_SPHERICAL_BILLBOARD, BONE_SPHERICAL_BILLBOARD, 0] },
  { name: 'nested cylindrical X/Y/Z and spherical billboards', flags: [0, 0,
    BONE_CYLINDRICAL_BILLBOARD_X, BONE_CYLINDRICAL_BILLBOARD_Y, 0,
    BONE_CYLINDRICAL_BILLBOARD_Z, BONE_SPHERICAL_BILLBOARD, 0] },
];
for (const mounted of [false, true]) for (const { name, flags } of billboardCases) {
  test(`${mounted ? 'mounted rider' : 'unit'} preserves all world matrices with ${name}`, () => {
    const template = makeTemplate(flags), twins = [makeScene(template, mounted), makeScene(template, mounted)];
    const camera = new THREE.PerspectiveCamera(), globalSequences = Uint32Array.from([1000]);
    for (let frame = 0; frame < 120; frame++) {
      camera.position.set(Math.cos(frame * .04) * 6, 2 + Math.sin(frame * .02), Math.sin(frame * .04) * 6);
      camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
      for (let side = 0; side < 2; side++) {
        const state = twins[side];
        state.unit.position.x = 2 + Math.sin(frame * .1); state.outer.rotation.y = frame * .01;
        for (const rig of state.rigs) {
          rig.mixer.update(1 / 60);
          applyGlobalSequenceBones(rig, template, globalSequences, frame * 1000 / 60);
          applyStrafeYaw(rig, { pelvis: 1, torso: [5] }, frame % 40 < 20 ? .3 : 0);
          (side ? applyBillboardBones : referenceBillboards)(rig, template, camera);
          rig.skeleton.update();
        }
      }
      for (let index = 0; index < twins[0].rigs.length; index++) {
        const a = twins[0].rigs[index], b = twins[1].rigs[index];
        for (let bone = 0; bone < a.skeleton.bones.length; bone++) {
          for (let component = 0; component < 16; component++) {
            assert.ok(Math.abs(a.skeleton.bones[bone].matrixWorld.elements[component]
              - b.skeleton.bones[bone].matrixWorld.elements[component]) < 1e-9,
            `world matrix frame ${frame}, rig ${index}, bone ${bone}, element ${component}`);
          }
        }
        for (let component = 0; component < a.skeleton.boneMatrices.length; component++) {
          assert.ok(Math.abs(a.skeleton.boneMatrices[component] - b.skeleton.boneMatrices[component]) < 1e-6,
            `palette frame ${frame}, rig ${index}, element ${component}`);
        }
      }
    }
  });
}

test('billboard preparation avoids unrelated attachment subtrees while the final pass keeps their matrices current', () => {
  const template = makeTemplate([0, 0, BONE_SPHERICAL_BILLBOARD, 0, 0, 0, 0, 0]);
  const rig = instantiateSkinned(template, material), camera = new THREE.PerspectiveCamera();
  const attachment = new THREE.Group(), detail = new THREE.Object3D();
  rig.skeleton.bones[5].add(attachment); attachment.add(detail);
  detail.position.set(2, 3, 4);
  let visits = 0;
  const update = detail.updateWorldMatrix;
  detail.updateWorldMatrix = function (...args) { visits++; return update.apply(this, args); };
  camera.position.set(4, 5, 6); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  referenceBillboards(rig, template, camera);
  assert.equal(visits, 2, 'reference walks unrelated attachments during both passes');
  visits = 0;
  attachment.rotation.y = .5;
  applyBillboardBones(rig, template, camera);
  assert.equal(visits, 1, 'unrelated attachment only participates in the required final pass');
  const worldAfterBillboards = detail.matrixWorld.clone();
  rig.root.updateWorldMatrix(true, true);
  assert.deepEqual(detail.matrixWorld, worldAfterBillboards, 'all attachment matrices were already current');
});
