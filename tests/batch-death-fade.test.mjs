// 6.16а (05.10-A7a-F1): a batch's opacity under the played Death sequence, worn per unit.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  deathFadeBatches, deathBatchOpacity, wearDeathFade, updateDeathFade, releaseDeathFade, syncDeathFade,
  heldTrackValue,
} from '../dist/code/browser/BatchDeathFade.js';
import { addSkinnedClips } from '../dist/code/browser/AnimatedModel.js';

const STAND = 0, DEATH = 7;

function track(subs, { interpolation = 1, globalSequence = -1 } = {}) {
  return {
    interpolation, globalSequence, components: 1,
    tracks: subs.map(([sequence, times, values]) => ({ sequence, times: new Uint32Array(times), values: new Float32Array(values) })),
  };
}

/** A body (opaque, untouched), an elemental flame (alpha 1 → 0 over Death) and an eye glow (weight dips, returns). */
function fixture() {
  const body = new THREE.MeshStandardMaterial();
  const flame = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1 });
  const glow = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1 });
  const materials = [body, flame, glow];
  const globals = new Uint32Array(0);
  const animatedBatches = [
    { material: flame, globalSequences: globals, tinted: true,
      colour: { rgb: track([]), alpha: track([[STAND, [0], [1]], [DEATH, [0, 1000, 2000], [1, 0.5, 0]]]) } },
    { material: glow, globalSequences: globals, tinted: true,
      weight: track([[STAND, [0, 2667], [1, 0.97]], [DEATH, [0, 267, 433, 2000], [1, 0, 1, 1]]]) },
  ];
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), materials);
  return { materials, animatedBatches, built: { materials, animatedBatches }, mesh, body, flame, glow };
}

test('only batches with keys under the Death sequence are faded', () => {
  const { built, flame, glow } = fixture();
  const picked = deathFadeBatches(built, DEATH);
  assert.deepEqual(picked.map((b) => b.index), [1, 2]);
  assert.equal(picked[0].entry.material === flame, true);
  assert.equal(picked[1].entry.material === glow, true);
  assert.equal(deathFadeBatches(built, 99).length, 0, 'a sequence nobody keyed fades nothing');
  assert.equal(deathFadeBatches(built, DEATH) === picked, true, 'the answer is cached per build and sequence');
});

test('opacity is read on the Death sub-track at the clip time and held after the last key', () => {
  const { animatedBatches } = fixture();
  const [flame, glow] = animatedBatches;
  assert.equal(deathBatchOpacity(flame, DEATH, 0, 0), 1);
  assert.equal(deathBatchOpacity(flame, DEATH, 1000, 0), 0.5);
  assert.ok(Math.abs(deathBatchOpacity(flame, DEATH, 1500, 0) - 0.25) < 1e-6);
  // A corpse lies long after the clip clamped: the last key holds rather than wrapping to 1.
  assert.equal(deathBatchOpacity(flame, DEATH, 2000, 0), 0);
  assert.equal(deathBatchOpacity(flame, DEATH, 60_000, 0), 0);
  // The eye glow blinks and comes back, as the file says.
  assert.equal(deathBatchOpacity(glow, DEATH, 267, 0), 0);
  assert.equal(deathBatchOpacity(glow, DEATH, 5000, 0), 1);
});

test('a step track holds its key until the next one', () => {
  const stepped = track([[DEATH, [0, 1000], [1, 0]]], { interpolation: 0 });
  assert.equal(heldTrackValue(stepped, DEATH, 999, 0, new Uint32Array(0), 1), 1);
  assert.equal(heldTrackValue(stepped, DEATH, 1000, 0, new Uint32Array(0), 1), 0);
  assert.equal(heldTrackValue(stepped, 3, 500, 0, new Uint32Array(0), 0.25), 0.25, 'no sub-track: the fallback');
});

test('wearing swaps private copies in for the fading batches only and gives the shared array back', () => {
  const { built, mesh, materials, body, flame } = fixture();
  const state = wearDeathFade(mesh, built, DEATH);
  assert.ok(state);
  const worn = mesh.material;
  assert.notEqual(worn === materials, true);
  assert.equal(worn[0] === body, true, 'a batch with nothing under Death keeps the shared material');
  assert.notEqual(worn[1] === flame, true);
  updateDeathFade(state, 1000, 0);
  assert.equal(worn[1].opacity, 0.5);
  assert.equal(flame.opacity, 1, 'the shared material other units draw with is untouched');
  updateDeathFade(state, 2000, 0);
  assert.equal(worn[1].visible, false, 'faded out: not drawn at all');
  let disposed = 0;
  worn[1].addEventListener('dispose', () => disposed++);
  releaseDeathFade(state);
  assert.equal(mesh.material === materials, true);
  assert.equal(disposed, 1);
});

test('syncDeathFade wears on Death, waits under a spawn fade, and releases on respawn', () => {
  const { built, mesh, materials } = fixture();
  const clip = new THREE.AnimationClip('animation-1', 2, []);
  clip.userData.variationIndex = DEATH;
  const action = { time: 1, getClip: () => clip };
  const unit = { built, skinned: { mesh } };
  // Alive: nothing happens.
  assert.equal(syncDeathFade(unit, undefined, 0), false);
  assert.equal(mesh.material === materials, true);
  // A spawn/stealth fade has borrowed the meshes: wait for it to give them back.
  unit.opacityBorrows = [{}];
  assert.equal(syncDeathFade(unit, action, 0), false);
  assert.equal(unit.deathFade, undefined);
  delete unit.opacityBorrows;
  assert.equal(syncDeathFade(unit, action, 0), true);
  assert.equal(mesh.material[1].opacity, 0.5);
  action.time = 2;
  assert.equal(syncDeathFade(unit, action, 0), false);
  assert.equal(mesh.material[1].opacity, 0);
  // Respawned: the live pose takes the shared array back.
  assert.equal(syncDeathFade(unit, undefined, 0), true);
  assert.equal(mesh.material === materials, true);
  assert.equal(unit.deathFade, undefined);
});

test('a built clip carries its sequence-table slot for the batch tracks', () => {
  const template = { parents: Int16Array.from([-1]), pivots: new Float32Array(3), clips: new Map(), animations: new Set() };
  const channels = [{ bone: 0, kind: 1, times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1]) }];
  addSkinnedClips(template, [
    { animationId: 1, duration: 2, variationIndex: DEATH, channels },
    { animationId: 0, duration: 1, channels },
  ]);
  assert.equal(template.clips.get(1).userData.variationIndex, DEATH);
  assert.equal('variationIndex' in template.clips.get(0).userData, false, 'an old artifact carries none');
});

test('a clip without a sequence slot, or a body rebuilt under the fade, never leaves copies behind', () => {
  const { built, mesh, materials } = fixture();
  const bare = { time: 1, getClip: () => new THREE.AnimationClip('animation-1', 2, []) };
  const unit = { built, skinned: { mesh } };
  assert.equal(syncDeathFade(unit, bare, 0), false, 'an artifact without variationIndex fades nothing');
  const clip = new THREE.AnimationClip('animation-1', 2, []);
  clip.userData.variationIndex = DEATH;
  syncDeathFade(unit, { time: 1, getClip: () => clip }, 0);
  const copies = mesh.material;
  // The look changed: a new mesh with the new build's shared array.
  const other = fixture();
  unit.built = other.built;
  unit.skinned = { mesh: other.mesh };
  let disposed = 0;
  copies[1].addEventListener('dispose', () => disposed++);
  syncDeathFade(unit, { time: 1, getClip: () => clip }, 0);
  assert.equal(disposed >= 1, true, 'the old copies are disposed');
  assert.equal(other.mesh.material[1] === other.flame, false, 'the new body is faded in turn');
  assert.equal(mesh.material === copies, true, 'a mesh that is no longer the unit\'s is not written to');
  void materials;
});

// 05.10 review (A7a-F1): the shared material every other unit of the display draws with must come
// out of a whole death — wear, every frame of the fade, release — exactly as it went in.
test('review: a death never writes a program-relevant field of the shared material', () => {
  const { built, mesh, materials } = fixture();
  const cutout = new THREE.MeshStandardMaterial({ alphaTest: 224 / 255 });
  cutout.color.setRGB(0.5, 0.25, 1);
  materials.push(cutout);
  built.animatedBatches.push({ material: cutout, globalSequences: new Uint32Array(0), tinted: true,
    colour: { rgb: track([]), alpha: track([[DEATH, [0, 500], [1, 0]]]) } });
  const before = materials.map((m) => [m.opacity, m.transparent, m.alphaTest, m.visible, m.depthWrite, m.version, m.color.getHex()]);
  const clip = new THREE.AnimationClip('animation-1', 2, []);
  clip.userData.variationIndex = DEATH;
  const action = { time: 0, getClip: () => clip };
  const unit = { built: { materials, animatedBatches: built.animatedBatches }, skinned: { mesh } };
  for (const time of [0, 0.25, 0.5, 1, 2, 30]) {
    action.time = time;
    syncDeathFade(unit, action, time * 1000);
  }
  assert.equal(mesh.material[3] === cutout, false, 'the cut-out keyed under Death wears a copy');
  assert.equal(mesh.material[3].visible, false);
  syncDeathFade(unit, undefined, 0);
  assert.equal(mesh.material === materials, true);
  assert.deepEqual(materials.map((m) => [m.opacity, m.transparent, m.alphaTest, m.visible, m.depthWrite, m.version, m.color.getHex()]), before);
});

// 05.10 review: a resurrection under a spawn/stealth borrow keeps the copies until the borrow is
// given back, then releases them — never a frame where the copies are disposed under a borrow.
test('review: resurrected under a borrow, the fade waits for the borrow and then lets go', () => {
  const { built, mesh, materials } = fixture();
  const clip = new THREE.AnimationClip('animation-1', 2, []);
  clip.userData.variationIndex = DEATH;
  const unit = { built, skinned: { mesh } };
  syncDeathFade(unit, { time: 2, getClip: () => clip }, 0);
  const worn = mesh.material;
  let disposed = 0;
  worn[1].addEventListener('dispose', () => disposed++);
  unit.opacityBorrows = [{}];
  assert.equal(syncDeathFade(unit, undefined, 0), false);
  assert.equal(disposed, 0, 'a borrow may be holding the worn array as its shared one');
  assert.equal(unit.deathFade !== undefined, true);
  delete unit.opacityBorrows;
  assert.equal(syncDeathFade(unit, undefined, 0), true);
  assert.equal(disposed, 1);
  assert.equal(mesh.material === materials, true);
});
