import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  applyBillboardBones, applyGlobalSequenceBones, applyStrafeYaw,
  buildSkinnedTemplateFrom, instantiateSkinned,
} from '../dist/code/browser/AnimatedModel.js';
import { UnitSceneGroup } from '../dist/code/browser/UnitSceneGroup.js';
import {
  BONE_SPHERICAL_BILLBOARD, BONE_CYLINDRICAL_BILLBOARD_X,
  BONE_CYLINDRICAL_BILLBOARD_Y, BONE_CYLINDRICAL_BILLBOARD_Z,
} from '../dist/code/browser/Wvm.js';

function template(flags) {
  return buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents: Int16Array.from([-1, 0, 1, 2, 2, 1, 5, 6]),
    pivots: Float32Array.from([0, 0, 1.8, 0, 0, 1.2, 0, 0, 1, 0, -.2, .5,
      0, .2, .5, 0, 0, 1.5, 0, 0, 1.6, 0, 0, 1.7]),
    flags: Uint16Array.from(flags), animations: [0],
    clips: [{ animationId: 0, duration: 1, channels: Array.from({ length: 8 }, (_, bone) => ({
      bone, kind: 1, times: Float32Array.from([0, 1]),
      values: Float32Array.from([0, 0, 0, 1, Math.sin(.1 + bone * .04), 0, 0, Math.cos(.1 + bone * .04)]),
    })) }],
    globalChannels: [{ bone: 4, kind: 0, globalSequence: 0, interpolation: 1,
      times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, .1, .2, .3]) }],
  }, 2);
}

function sceneFor(source, mounted) {
  const scene = new THREE.Scene(), outer = new THREE.Group(), unit = new UnitSceneGroup();
  scene.add(outer); outer.add(unit);
  outer.rotation.set(.1, .2, .3); outer.scale.set(1.1, .9, 1.2);
  const material = new THREE.MeshBasicMaterial();
  const mount = instantiateSkinned(source, material), rigs = [mount];
  unit.add(mount.root);
  if (mounted) {
    const rider = instantiateSkinned(source, material);
    mount.skeleton.bones[6].add(rider.root); rider.root.position.set(.1, .2, .3);
    rigs.push(rider);
  }
  const attachments = rigs.map(rig => {
    rig.mixer.clipAction(source.clips.get(0)).play();
    const item = new THREE.Object3D();
    item.position.set(.2, .3, .4); rig.skeleton.bones[7].add(item);
    return item;
  });
  return { scene, outer, unit, rigs, attachments };
}

function closeMatrix(a, b, message) {
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(a.elements[i] - b.elements[i]) < 1e-9, `${message}: ${i}`);
}

const flagsByName = {
  spherical: [0, 0, BONE_SPHERICAL_BILLBOARD, 0, 0, BONE_SPHERICAL_BILLBOARD, BONE_SPHERICAL_BILLBOARD, 0],
  cylindrical: [0, 0, BONE_CYLINDRICAL_BILLBOARD_X, BONE_CYLINDRICAL_BILLBOARD_Y, 0,
    BONE_CYLINDRICAL_BILLBOARD_Z, BONE_SPHERICAL_BILLBOARD, 0],
};

for (const [name, flags] of Object.entries(flagsByName)) for (const mounted of [false, true]) {
  for (const consumer of ['render', 'spell anchor', 'particle emitter']) {
    test(`deferred ${name} billboards preserve ${mounted ? 'mounted' : 'unit'} ${consumer} matrices`, () => {
      const source = template(flags), twins = [sceneFor(source, mounted), sceneFor(source, mounted)];
      const camera = new THREE.PerspectiveCamera(), sequences = Uint32Array.from([1000]);
      for (let frame = 0; frame < 120; frame++) {
        camera.position.set(Math.cos(frame * .04) * 6, 2 + Math.sin(frame * .02), Math.sin(frame * .04) * 6);
        camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
        const queried = [[], []];
        for (let side = 0; side < twins.length; side++) {
          const state = twins[side];
          state.unit.position.set(2 + Math.sin(frame * .1), 3, 4);
          state.outer.rotation.y = frame * .01;
          for (const item of state.attachments) item.rotation.z = frame * .03;
          for (const rig of state.rigs) {
            rig.mixer.update(1 / 60);
            applyGlobalSequenceBones(rig, source, sequences, frame * 1000 / 60);
            applyStrafeYaw(rig, { pelvis: 1, torso: [5] }, frame % 40 < 20 ? .3 : 0);
            applyBillboardBones(rig, source, camera, side === 0);
          }
          // World visuals query these before scene submission, including hidden retained units.
          state.unit.visible = false;
          for (const rig of state.rigs) {
            if (consumer === 'spell anchor') {
              const bone = rig.skeleton.bones[7];
              bone.updateWorldMatrix(true, false);
              queried[side].push(bone.matrixWorld.clone());
            } else if (consumer === 'particle emitter') {
              rig.root.updateWorldMatrix(true, true);
              queried[side].push(rig.skeleton.bones[4].matrixWorld.clone());
            }
          }
          state.unit.visible = true;
          state.scene.updateMatrixWorld();
          for (const rig of state.rigs) rig.skeleton.update();
        }
        for (let i = 0; i < queried[0].length; i++) closeMatrix(queried[0][i], queried[1][i], `query ${frame}/${i}`);
        for (let i = 0; i < twins[0].rigs.length; i++) {
          const a = twins[0].rigs[i], b = twins[1].rigs[i];
          for (let bone = 0; bone < a.skeleton.bones.length; bone++) {
            closeMatrix(a.skeleton.bones[bone].matrixWorld, b.skeleton.bones[bone].matrixWorld, `pose ${frame}/${i}/${bone}`);
          }
          assert.deepEqual(a.skeleton.boneMatrices, b.skeleton.boneMatrices, `palette ${frame}/${i}`);
          closeMatrix(twins[0].attachments[i].matrixWorld, twins[1].attachments[i].matrixWorld, `item ${frame}/${i}`);
        }
      }
    });
  }
}
