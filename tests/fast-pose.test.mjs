import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  buildSkinnedTemplateFrom, instantiateSkinned, applyGlobalSequenceBones, applyBillboardBones,
  fastPoseProgramFor, skinDemandFor, writeGlobalSequenceLocals,
} from '../dist/code/browser/AnimatedModel.js';
import { FastPoseState } from '../dist/code/browser/FastPose.js';
import {
  BONE_SPHERICAL_BILLBOARD, BONE_CYLINDRICAL_BILLBOARD_Y,
} from '../dist/code/browser/Wvm.js';

const BONES = 64;
const parents = Int16Array.from({ length: BONES }, (_, bone) => bone === 0 ? -1 : (bone - 1) >>> 1);
const pivots = Float32Array.from({ length: BONES * 3 }, (_, index) => ((index * 7) % 11) * .1);
const flags = new Uint16Array(BONES);
flags[21] = BONE_SPHERICAL_BILLBOARD;
flags[22] = BONE_CYLINDRICAL_BILLBOARD_Y;

function rotationChannel(bone, duration, phase) {
  const times = Float32Array.from([0, duration / 3, duration]);
  const values = new Float32Array(12);
  for (let key = 0; key < 3; key++) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      Math.sin(phase + bone * .3 + key) * .6, Math.cos(phase + bone * .2 + key) * .5, (key - 1) * .2 * (bone % 3)));
    q.toArray(values, key * 4);
  }
  return { bone, kind: 1, times, values };
}
function vectorChannel(bone, kind, duration, scale) {
  return { bone, kind, times: Float32Array.from([0, duration]),
    values: kind === 2 ? Float32Array.from([1, 1, 1, 1 + scale, 1 - scale, 1]) : Float32Array.from([0, 0, 0, scale, -scale, scale * 2]) };
}
function clip(animationId, duration, phase, extra = []) {
  return { animationId, duration, channels: [
    ...Array.from({ length: BONES }, (_, bone) => rotationChannel(bone, duration, phase)), ...extra,
  ] };
}

function template() {
  // Drawn vertices weighted to a few bones (two of them billboards); 40..63 draw nothing.
  const drawn = [3, 9, 20, 21, 22, 35];
  const vertices = 60;
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(vertices * 3), skinIndex = new Uint16Array(vertices * 4), skinWeight = new Float32Array(vertices * 4);
  for (let vertex = 0; vertex < vertices; vertex++) {
    position.set([Math.sin(vertex), vertex * .03, Math.cos(vertex)], vertex * 3);
    skinIndex.set([drawn[vertex % drawn.length], drawn[(vertex + 1) % drawn.length], 0, 0], vertex * 4);
    skinWeight.set([.75, .25, 0, 0], vertex * 4);
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex(Array.from({ length: vertices }, (_, vertex) => vertex));
  geometry.addGroup(0, vertices, 0);
  return buildSkinnedTemplateFrom(geometry, {
    parents, pivots, flags, animations: [0, 1, 2],
    clips: [
      clip(0, 1, 0, [vectorChannel(4, 0, 1, .2)]),
      clip(1, .7, 1.3, [vectorChannel(9, 0, .7, .1), vectorChannel(10, 2, .7, .15)]),
      clip(2, .5, 2.1, [vectorChannel(3, 2, .5, .25)]),
    ],
    // Bone 9 also carries a clip position track: the global sequence has to win over it.
    globalChannels: [{ bone: 9, kind: 0, globalSequence: 0, interpolation: 1,
      times: Float32Array.from([0, .5]), values: Float32Array.from([0, 0, 0, .05, .1, -.05]) }],
  }, 2);
}

function rig(shared) {
  const scene = new THREE.Scene(), unit = new THREE.Group();
  scene.add(unit);
  const instance = instantiateSkinned(shared, new THREE.MeshBasicMaterial());
  unit.add(instance.root);
  const sword = new THREE.Group();
  instance.skeleton.bones[13].add(sword); // an attachment point outside the drawn set
  return { scene, unit, instance, sword };
}

const ATTACHMENTS = [13, 45];

test('a flat pose matches the mixer through crossfades, one-shots, time scales, globals and billboards', () => {
  const shared = template();
  const cpu = rig(shared), fast = rig(shared);
  const program = fastPoseProgramFor(shared, ATTACHMENTS);
  const palette = [...skinDemandFor(shared).palette];
  assert.ok(program.order.length < BONES, 'bones nobody draws or reads are left out');
  assert.equal(program.evaluated[13], 1);
  assert.equal(program.evaluated[50], 0);
  const camera = new THREE.PerspectiveCamera(50, 1, .1, 100);
  const clips = [0, 1, 2].map((id) => shared.clips.get(id));
  const globals = Uint32Array.from([500]);
  const script = (state, frame) => {
    const { mixer } = state.instance;
    if (frame === 0) mixer.clipAction(clips[0]).play();
    if (frame === 15) mixer.clipAction(clips[0]).crossFadeTo(mixer.clipAction(clips[1]).reset().play(), .3, false);
    if (frame === 40) mixer.clipAction(clips[1]).setEffectiveTimeScale(1.6);
    if (frame === 55) {
      const once = mixer.clipAction(clips[2]);
      once.reset(); once.setLoop(THREE.LoopOnce, 1); once.clampWhenFinished = true; once.fadeIn(.2); once.play();
    }
    // Long faded out: stopping it deactivates the bone 4 position binding only clip 0 drives, and
    // Three restores that bone's original position.
    if (frame === 70) mixer.clipAction(clips[0]).stop();
    if (frame === 90) mixer.clipAction(clips[1]).fadeOut(.25);
    // From here the only thing playing is the clamped one-shot: constant values every frame, the
    // case where PropertyMixer.apply skips writing a bone that did not change. Stopping it at full
    // weight deactivates the bone 3 scale binding only it drives: Three restores that scale.
    if (frame === 130) mixer.clipAction(clips[2]).stop();
  };
  let now = 0;
  for (let frame = 0; frame < 140; frame++) {
    const dt = 1 / 60 + (frame % 7) * .002;
    now += dt * 1000;
    camera.position.set(Math.cos(frame * .05) * 6, 2 + Math.sin(frame * .03), Math.sin(frame * .05) * 6);
    camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
    for (const state of [cpu, fast]) {
      state.unit.position.set(Math.sin(frame * .04), 0, frame * .01);
      state.unit.rotation.y = frame * .02;
      script(state, frame);
    }
    cpu.instance.mixer.update(dt);
    applyGlobalSequenceBones(cpu.instance, shared, globals, now);
    applyBillboardBones(cpu.instance, shared, camera, false);
    // Frames 100..103 take Three's path on the flat rig too, and something besides the mixer
    // writes a bone property no clip drives there (as the strafe turn does): back on the flat pose,
    // that value has to be read again.
    const threePath = frame >= 100 && frame < 104;
    if (threePath) {
      for (const state of [cpu, fast]) state.instance.skeleton.bones[6].position.set(.1, -.05, .2);
      fast.instance.skeleton.setFastPoseActive(false, fast.instance.mixer);
      fast.instance.mixer.update(dt);
      applyGlobalSequenceBones(fast.instance, shared, globals, now);
      applyBillboardBones(fast.instance, shared, camera, false);
    } else {
      const flat = fast.instance.skeleton.fastPose(program);
      flat.advance(fast.instance.mixer, dt);
      writeGlobalSequenceLocals(shared, globals, now, flat);
      flat.compose(fast.instance.root, camera);
      fast.instance.skeleton.setFastPoseActive(true, fast.instance.mixer);
    }
    for (const state of [cpu, fast]) { state.scene.updateMatrixWorld(); state.instance.skeleton.update(); }
    for (const bone of palette) {
      for (let element = 0; element < 16; element++) {
        const a = cpu.instance.skeleton.boneMatrices[bone * 16 + element], b = fast.instance.skeleton.boneMatrices[bone * 16 + element];
        assert.ok(Math.abs(a - b) < 2e-5, `frame ${frame} bone ${bone}[${element}]: ${a} vs ${b}`);
      }
    }
    for (let element = 0; element < 16; element++) {
      assert.ok(Math.abs(cpu.sword.matrixWorld.elements[element] - fast.sword.matrixWorld.elements[element]) < 2e-5,
        `frame ${frame} attachment[${element}]`);
    }
    // An explicit read of an attachment bone, the way a spell anchor asks for one.
    const cpuBone = cpu.instance.skeleton.bones[45], fastBone = fast.instance.skeleton.bones[45];
    cpuBone.updateWorldMatrix(true, false); fastBone.updateWorldMatrix(true, false);
    for (let element = 0; element < 16; element++) {
      assert.ok(Math.abs(cpuBone.matrixWorld.elements[element] - fastBone.matrixWorld.elements[element]) < 2e-5,
        `frame ${frame} explicit read[${element}]`);
    }
    if (!threePath) assert.equal(fast.instance.skeleton.takeFullPoseRequest(), false, `frame ${frame}: nothing read outside the program`);
  }
  // Back to the ordinary mixer: every bound bone object must carry the same values again.
  fast.instance.skeleton.setFastPoseActive(false, fast.instance.mixer);
  for (let frame = 0; frame < 5; frame++) {
    for (const state of [cpu, fast]) {
      state.instance.mixer.update(1 / 60);
      state.scene.updateMatrixWorld(); state.instance.skeleton.update();
    }
    for (let bone = 0; bone < BONES; bone++) {
      if (bone === 9 || bone === 21 || bone === 22) continue; // global and billboard bones are rewritten after the mixer
      const a = cpu.instance.skeleton.bones[bone], b = fast.instance.skeleton.bones[bone];
      assert.deepEqual(b.quaternion.toArray(), a.quaternion.toArray(), `bone ${bone} quaternion after leaving the flat pose`);
      assert.deepEqual(b.position.toArray(), a.position.toArray(), `bone ${bone} position`);
      assert.deepEqual(b.scale.toArray(), a.scale.toArray(), `bone ${bone} scale`);
    }
  }
});

test('a bone outside the program asks for a full pose instead of answering stale', () => {
  const shared = template();
  const state = rig(shared);
  const program = fastPoseProgramFor(shared, ATTACHMENTS);
  state.instance.mixer.clipAction(shared.clips.get(0)).play();
  const flat = state.instance.skeleton.fastPose(program);
  flat.advance(state.instance.mixer, 1 / 60);
  flat.compose(state.instance.root, undefined);
  state.instance.skeleton.setFastPoseActive(true, state.instance.mixer);
  state.scene.updateMatrixWorld();
  assert.equal(state.instance.skeleton.takeFullPoseRequest(), false);
  state.instance.skeleton.bones[50].updateWorldMatrix(true, false);
  assert.equal(state.instance.skeleton.takeFullPoseRequest(), true);
  // A walk down from the root through bone-only branches is not a read.
  state.instance.root.updateWorldMatrix(true, true);
  assert.equal(state.instance.skeleton.takeFullPoseRequest(), false);
  assert.equal(FastPoseState.supports(state.instance.mixer), true);
  state.instance.mixer.clipAction(shared.clips.get(1)).setEffectiveWeight(1).play().blendMode = THREE.AdditiveAnimationBlendMode;
  assert.equal(FastPoseState.supports(state.instance.mixer), false, 'additive layers keep the ordinary mixer');
});
