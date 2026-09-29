import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import * as THREE from 'three';
import {
  buildSkinnedTemplateFrom, instantiateSkinned, applyGlobalSequenceBones, applyBillboardBones,
  fastPoseProgramFor, skinDemandFor, writeGlobalSequenceLocals,
} from '../dist/code/browser/AnimatedModel.js';
import { PoseEngine, SharedPose, pagePoseEngine } from '../dist/code/browser/PoseEngine.js';
import { BONE_SPHERICAL_BILLBOARD, BONE_CYLINDRICAL_BILLBOARD_Y } from '../dist/code/browser/Wvm.js';

// The same synthetic rig as fast-pose.test.mjs: 64 bones in a binary tree, two billboards, a global
// sequence over a clip track, drawn geometry weighted to a few bones.
const BONES = 64;
const parents = Int16Array.from({ length: BONES }, (_, bone) => bone === 0 ? -1 : (bone - 1) >>> 1);
const pivots = Float32Array.from({ length: BONES * 3 }, (_, index) => ((index * 7) % 11) * .1);
const flags = new Uint16Array(BONES);
flags[21] = BONE_SPHERICAL_BILLBOARD;
flags[22] = BONE_CYLINDRICAL_BILLBOARD_Y;
const ATTACHMENTS = [13, 45];
const GLOBALS = Uint32Array.from([500]);

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
function clip(animationId, duration, phase, extra = [], bones = Array.from({ length: BONES }, (_, bone) => bone)) {
  return { animationId, duration, channels: [...bones.map((bone) => rotationChannel(bone, duration, phase)), ...extra] };
}

function template(clips) {
  const drawn = [3, 9, 20, 21, 22, 35, 47];
  const vertices = 70;
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
    parents, pivots, flags, animations: clips.map((entry) => entry.animationId), clips,
    globalChannels: [{ bone: 9, kind: 0, globalSequence: 0, interpolation: 1,
      times: Float32Array.from([0, .5]), values: Float32Array.from([0, 0, 0, .05, .1, -.05]) }],
  }, 2);
}

const standardClips = () => [
  clip(0, 1, 0, [vectorChannel(4, 0, 1, .2)]),
  clip(1, .7, 1.3, [vectorChannel(9, 0, .7, .1), vectorChannel(10, 2, .7, .15)]),
  clip(2, .5, 2.1, [vectorChannel(3, 2, .5, .25)]),
];

function rig(shared) {
  const scene = new THREE.Scene(), unit = new THREE.Group();
  scene.add(unit);
  const instance = instantiateSkinned(shared, new THREE.MeshBasicMaterial());
  unit.add(instance.root);
  const sword = new THREE.Group();
  instance.skeleton.bones[13].add(sword);
  return { scene, unit, instance, sword };
}

/** One flat step the way WorldRenderer3D takes it: the worker's pose when it can, else this thread's. */
function flatStep(state, tpl, program, engine, dt, now, camera) {
  const { skeleton, mixer, root } = state.instance;
  const flat = (engine && skeleton.sharedPose(program, engine, mixer, tpl, GLOBALS)) || skeleton.fastPose(program);
  flat.advance(mixer, dt);
  if (flat instanceof SharedPose) flat.globalSequences(tpl, GLOBALS, now);
  else writeGlobalSequenceLocals(tpl, GLOBALS, now, flat);
  flat.compose(root, camera);
  skeleton.setFastPoseActive(true, mixer);
  return flat;
}

function threeStep(state, tpl, dt, now, camera) {
  const { skeleton, mixer } = state.instance;
  skeleton.setFastPoseActive(false, mixer);
  mixer.update(dt);
  applyGlobalSequenceBones(state.instance, tpl, GLOBALS, now);
  applyBillboardBones(state.instance, tpl, camera, false);
}

/** Every float of both palettes, bit for bit (Object.is: a signed zero counts). */
function samePalette(a, b, label) {
  assert.equal(a.length, b.length, `${label}: palette length`);
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) assert.fail(`${label}: palette[${index}] ${a[index]} vs ${b[index]}`);
  }
}
function sameMatrix(a, b, label) {
  for (let element = 0; element < 16; element++) {
    if (!Object.is(a.elements[element], b.elements[element])) assert.fail(`${label}[${element}]: ${a.elements[element]} vs ${b.elements[element]}`);
  }
}

function spawnNodeWorker(sab, index, fail) {
  const worker = new Worker(new URL('./fixtures/pose-engine-worker.mjs', import.meta.url), { workerData: { sab, index } });
  worker.on('error', (error) => fail(String(error)));
  return { terminate: () => { void worker.terminate(); } };
}

async function engineWithWorkers(count, options = {}) {
  const engine = PoseEngine.create({ workers: count, spawn: spawnNodeWorker, arenaBytes: 16 << 20, ...options });
  const deadline = Date.now() + 20000;
  while (engine.workersReady < count) {
    if (Date.now() > deadline) throw new Error('pose workers did not start');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return engine;
}

function camera(frame) {
  const view = new THREE.PerspectiveCamera(50, 1, .1, 100);
  view.position.set(Math.cos(frame * .05) * 6, 2 + Math.sin(frame * .03), Math.sin(frame * .05) * 6);
  view.lookAt(0, 1, 0);
  view.updateMatrixWorld(true);
  return view;
}

// The fast-pose test's script: crossfade, time scale, a LoopOnce fading in, stop, fadeOut, stop.
function script(state, clips, frame) {
  const { mixer } = state.instance;
  if (frame === 0) mixer.clipAction(clips[0]).play();
  if (frame === 15) mixer.clipAction(clips[0]).crossFadeTo(mixer.clipAction(clips[1]).reset().play(), .3, false);
  if (frame === 40) mixer.clipAction(clips[1]).setEffectiveTimeScale(1.6);
  if (frame === 55) {
    const once = mixer.clipAction(clips[2]);
    once.reset(); once.setLoop(THREE.LoopOnce, 1); once.clampWhenFinished = true; once.fadeIn(.2); once.play();
  }
  if (frame === 70) mixer.clipAction(clips[0]).stop();
  if (frame === 90) mixer.clipAction(clips[1]).fadeOut(.25);
  if (frame === 130) mixer.clipAction(clips[2]).stop();
}

test('the worker pose reproduces the flat pose bit for bit, and the mixer within its tolerance', () => {
  const tpl = template(standardClips());
  const clips = [0, 1, 2].map((id) => tpl.clips.get(id));
  const program = fastPoseProgramFor(tpl, ATTACHMENTS);
  const palette = [...skinDemandFor(tpl).palette];
  // No worker thread: every job is computed by the calling thread, through the same code.
  const engine = PoseEngine.create({ workers: 0, arenaBytes: 8 << 20 });
  const cpu = rig(tpl), fast = rig(tpl), shared = rig(tpl);
  let now = 0;
  for (let frame = 0; frame < 140; frame++) {
    const dt = 1 / 60 + (frame % 7) * .002;
    now += dt * 1000;
    const view = camera(frame);
    for (const state of [cpu, fast, shared]) {
      state.unit.position.set(Math.sin(frame * .04), 0, frame * .01);
      state.unit.rotation.y = frame * .02;
      script(state, clips, frame);
    }
    cpu.instance.mixer.update(dt);
    applyGlobalSequenceBones(cpu.instance, tpl, GLOBALS, now);
    applyBillboardBones(cpu.instance, tpl, view, false);
    const threePath = frame >= 100 && frame < 104;
    if (threePath) {
      for (const state of [cpu, fast, shared]) state.instance.skeleton.bones[6].position.set(.1, -.05, .2);
      threeStep(fast, tpl, dt, now, view);
      threeStep(shared, tpl, dt, now, view);
    } else {
      const flat = flatStep(fast, tpl, program, undefined, dt, now, view);
      assert.ok(!(flat instanceof SharedPose));
      const worker = flatStep(shared, tpl, program, engine, dt, now, view);
      assert.ok(worker instanceof SharedPose, `frame ${frame}: the worker's pose is used`);
    }
    // The palette lives in the engine's arena once the rig has a bone texture; the other rig gets
    // an ordinary one at the same moment.
    if (frame === 0) { fast.instance.skeleton.computeBoneTexture(); shared.instance.skeleton.computeBoneTexture(); }
    // Now and then a unit moves after it was posed: the palette the step wrote is for the old root
    // and must not be taken.
    if (frame % 11 === 5) for (const state of [cpu, fast, shared]) state.unit.position.x += .25;
    for (const state of [cpu, fast, shared]) { state.scene.updateMatrixWorld(); state.instance.skeleton.update(); }
    samePalette(shared.instance.skeleton.boneMatrices, fast.instance.skeleton.boneMatrices, `frame ${frame}`);
    for (const bone of palette) {
      for (let element = 0; element < 16; element++) {
        const a = cpu.instance.skeleton.boneMatrices[bone * 16 + element], b = shared.instance.skeleton.boneMatrices[bone * 16 + element];
        assert.ok(Math.abs(a - b) < 2e-5, `frame ${frame} bone ${bone}[${element}]: ${a} vs ${b}`);
      }
    }
    sameMatrix(shared.sword.matrixWorld, fast.sword.matrixWorld, `frame ${frame} attachment`);
    const fastBone = fast.instance.skeleton.bones[45], sharedBone = shared.instance.skeleton.bones[45];
    fastBone.updateWorldMatrix(true, false); sharedBone.updateWorldMatrix(true, false);
    sameMatrix(sharedBone.matrixWorld, fastBone.matrixWorld, `frame ${frame} explicit read`);
    if (!threePath) assert.equal(shared.instance.skeleton.takeFullPoseRequest(), false, `frame ${frame}: nothing read outside the program`);
    engine.endFrame();
  }
  assert.equal(engine.stats.jobs, 136);
  assert.equal(engine.stats.stolen, 136, 'with no worker the page computes every job');
  // Back to the ordinary mixer: the bone objects carry the same values as the mixer's own rig.
  shared.instance.skeleton.setFastPoseActive(false, shared.instance.mixer);
  for (let frame = 0; frame < 5; frame++) {
    for (const state of [cpu, shared]) {
      state.instance.mixer.update(1 / 60);
      state.scene.updateMatrixWorld(); state.instance.skeleton.update();
    }
    for (let bone = 0; bone < BONES; bone++) {
      if (bone === 9 || bone === 21 || bone === 22) continue;
      const a = cpu.instance.skeleton.bones[bone], b = shared.instance.skeleton.bones[bone];
      assert.deepEqual(b.quaternion.toArray(), a.quaternion.toArray(), `bone ${bone} quaternion after leaving the worker pose`);
      assert.deepEqual(b.position.toArray(), a.position.toArray(), `bone ${bone} position`);
      assert.deepEqual(b.scale.toArray(), a.scale.toArray(), `bone ${bone} scale`);
    }
  }
  engine.dispose();
});

/** A crowd: rig i plays its own staggered script, so the worker sees crossfades and one-shots mid-flight. */
function crowdScript(state, clips, frame, index) {
  const { mixer } = state.instance;
  const shift = index * 3;
  if (frame === 0) {
    const first = mixer.clipAction(clips[index % 3]);
    first.setEffectiveTimeScale(.7 + (index % 5) * .15);
    first.play();
  }
  if (frame === 20 + shift) mixer.clipAction(clips[index % 3]).crossFadeTo(mixer.clipAction(clips[(index + 1) % 3]).reset().play(), .25, false);
  if (frame === 70 + shift) {
    const once = mixer.clipAction(clips[2]);
    once.reset(); once.setLoop(THREE.LoopOnce, 1); once.clampWhenFinished = index % 2 === 0; once.fadeIn(.15); once.play();
  }
  if (frame === 110 + shift) mixer.clipAction(clips[index % 3]).stop();
  if (frame === 140 + shift) mixer.clipAction(clips[(index + 1) % 3]).fadeOut(.2);
  if (frame === 190 + shift) mixer.stopAllAction();
  if (frame === 195 + shift) mixer.clipAction(clips[(index + 2) % 3]).reset().play();
}

async function crowdAgainstFlat(t, workers, options, frames = 240) {
  const tpl = template(standardClips());
  const clips = [0, 1, 2].map((id) => tpl.clips.get(id));
  const program = fastPoseProgramFor(tpl, ATTACHMENTS);
  const engine = await engineWithWorkers(workers, options);
  const count = 12;
  const reference = Array.from({ length: count }, () => rig(tpl));
  const pooled = Array.from({ length: count }, () => rig(tpl));
  let seed = 12340;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  let now = 0;
  try {
    for (let frame = 0; frame < frames; frame++) {
      const dt = 1 / 60 + (frame % 5) * .003;
      now += dt * 1000;
      const view = camera(frame);
      for (let index = 0; index < count; index++) {
        for (const state of [reference[index], pooled[index]]) {
          state.unit.position.set(index * .7 + Math.sin(frame * .03 + index), 0, frame * .01);
          state.unit.rotation.y = frame * .02 + index;
          crowdScript(state, clips, frame, index);
        }
        flatStep(reference[index], tpl, program, undefined, dt, now, view);
        const flat = flatStep(pooled[index], tpl, program, engine, dt, now, view);
        assert.ok(flat instanceof SharedPose);
      }
      if (frame === 0) {
        for (const state of [...reference, ...pooled]) state.instance.skeleton.computeBoneTexture();
      }
      // Readers arrive in any order, as the scene pass and the effects would: an explicit bone read
      // first for some rigs, the palette first for others.
      const order = Array.from({ length: count }, (_, index) => index).sort(() => random() - .5);
      for (const index of order) {
        const a = reference[index], b = pooled[index];
        if (random() < .3) {
          a.instance.skeleton.bones[45].updateWorldMatrix(true, false);
          b.instance.skeleton.bones[45].updateWorldMatrix(true, false);
          sameMatrix(b.instance.skeleton.bones[45].matrixWorld, a.instance.skeleton.bones[45].matrixWorld, `frame ${frame} rig ${index} read`);
        }
        for (const state of [a, b]) { state.scene.updateMatrixWorld(); state.instance.skeleton.update(); }
        samePalette(b.instance.skeleton.boneMatrices, a.instance.skeleton.boneMatrices, `frame ${frame} rig ${index}`);
        sameMatrix(b.sword.matrixWorld, a.sword.matrixWorld, `frame ${frame} rig ${index} attachment`);
      }
      engine.endFrame();
    }
    const stats = engine.stats;
    t.diagnostic(`jobs ${stats.jobs}: worker ${stats.worker}, stolen ${stats.stolen}, overridden ${stats.overridden}; wait ${stats.waitMs.toFixed(2)} ms, page ${stats.mainMs.toFixed(2)} ms`);
    assert.equal(stats.jobs, frames * count);
    assert.equal(stats.worker + stats.stolen + stats.overridden, stats.jobs, 'every job was made final exactly once');
    assert.equal(engine.failure, undefined);
    return stats;
  } finally {
    engine.dispose();
  }
}

test('worker threads pose a crowd bit for bit, whoever reaches each job first', async (t) => {
  const stats = await crowdAgainstFlat(t, 2, {});
  assert.ok(stats.worker > 0, 'the workers computed jobs');
});

test('a worker overtaken mid-job leaves the page result intact', async (t) => {
  // A zero budget: the page takes over any job it finds in a worker's hands.
  await crowdAgainstFlat(t, 1, { spinBudgetMs: 0 }, 160);
});

test('switching between the worker pose and the main-thread flat pose continues the same pose', () => {
  const tpl = template(standardClips());
  const clips = [0, 1, 2].map((id) => tpl.clips.get(id));
  const program = fastPoseProgramFor(tpl, ATTACHMENTS);
  const engine = PoseEngine.create({ workers: 0, arenaBytes: 8 << 20 });
  const fast = rig(tpl), mixed = rig(tpl);
  let now = 0;
  for (let frame = 0; frame < 140; frame++) {
    const dt = 1 / 60;
    now += dt * 1000;
    const view = camera(frame);
    for (const state of [fast, mixed]) { state.unit.rotation.y = frame * .03; script(state, clips, frame); }
    flatStep(fast, tpl, program, undefined, dt, now, view);
    // Seven frames on the worker pose, seven on this thread's, as a unit mounting and dismounting.
    flatStep(mixed, tpl, program, Math.floor(frame / 7) % 2 === 0 ? engine : undefined, dt, now, view);
    for (const state of [fast, mixed]) { state.scene.updateMatrixWorld(); state.instance.skeleton.update(); }
    samePalette(mixed.instance.skeleton.boneMatrices, fast.instance.skeleton.boneMatrices, `frame ${frame}`);
    engine.endFrame();
  }
  engine.dispose();
});

test('an active binding no action drives stays within float32 epsilon of the mixer', (t) => {
  // Clip 0 rotates the lower half of the tree, clip 3 the upper half; clip 3 fades out and is left
  // active and disabled, so its rotation bindings are applied with weight 0.
  const lower = Array.from({ length: 32 }, (_, bone) => bone);
  const upper = Array.from({ length: 32 }, (_, bone) => bone + 32);
  const tpl = template([clip(0, 1, 0, [], lower), clip(3, .8, .7, [], upper)]);
  const program = fastPoseProgramFor(tpl, ATTACHMENTS);
  const engine = PoseEngine.create({ workers: 0, arenaBytes: 8 << 20 });
  const fast = rig(tpl), shared = rig(tpl);
  let worst = 0, differing = 0;
  for (let frame = 0; frame < 90; frame++) {
    const view = camera(frame);
    for (const state of [fast, shared]) {
      const { mixer } = state.instance;
      if (frame === 0) { mixer.clipAction(tpl.clips.get(0)).play(); mixer.clipAction(tpl.clips.get(3)).play(); }
      if (frame === 20) mixer.clipAction(tpl.clips.get(3)).fadeOut(.2);
    }
    flatStep(fast, tpl, program, undefined, 1 / 60, frame * 16, view);
    flatStep(shared, tpl, program, engine, 1 / 60, frame * 16, view);
    for (const state of [fast, shared]) { state.scene.updateMatrixWorld(); state.instance.skeleton.update(); }
    const a = fast.instance.skeleton.boneMatrices, b = shared.instance.skeleton.boneMatrices;
    for (let index = 0; index < a.length; index++) {
      if (a[index] === b[index]) continue;
      differing++;
      worst = Math.max(worst, Math.abs(a[index] - b[index]) / Math.max(1, Math.abs(a[index])));
    }
    engine.endFrame();
  }
  t.diagnostic(`${differing} palette floats differ over 90 frames, worst relative difference ${worst}`);
  assert.ok(worst <= 2 * 2 ** -23, `relative difference ${worst} beyond float32 epsilon (${differing} floats differ)`);
  engine.dispose();
});

test('clips the worker cannot evaluate keep the rig on the main-thread flat pose', () => {
  const tpl = template(standardClips());
  const program = fastPoseProgramFor(tpl, ATTACHMENTS);
  const engine = PoseEngine.create({ workers: 0, arenaBytes: 8 << 20 });
  const state = rig(tpl);
  const stepped = tpl.clips.get(1).clone();
  stepped.tracks[0].setInterpolation(THREE.InterpolateDiscrete);
  state.instance.mixer.clipAction(stepped).play();
  assert.equal(state.instance.skeleton.sharedPose(program, engine, state.instance.mixer, tpl, GLOBALS), undefined);
  engine.dispose();
});

test('without cross-origin isolation there is no pose worker', () => {
  assert.equal(globalThis.crossOriginIsolated, undefined);
  assert.equal(pagePoseEngine(), undefined);
});
