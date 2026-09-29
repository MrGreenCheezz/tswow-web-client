import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildSkinnedTemplateFrom, instantiateSkinned } from '../dist/code/browser/AnimatedModel.js';
import {
  stepUnitAnimationClock, unitAnimationCadenceMs,
} from '../dist/code/browser/WorldRenderer3D.js';

function clock(phase = 0) {
  return { pendingSeconds: 0, nextStepAtMs: undefined, previousNowMs: undefined, intervalMs: 0, phase };
}

test('animation LOD keeps every unit inside 45 yards, and every important one, at full cadence', () => {
  assert.equal(unitAnimationCadenceMs(0, false), 0);
  assert.equal(unitAnimationCadenceMs(16, false), 0);
  assert.equal(unitAnimationCadenceMs(44.99, false), 0);
  assert.equal(unitAnimationCadenceMs(45, false), 1000 / 30);
  assert.equal(unitAnimationCadenceMs(89.99, false), 1000 / 30);
  assert.equal(unitAnimationCadenceMs(90, false), 1000 / 20);
  assert.equal(unitAnimationCadenceMs(200, false), 1000 / 20);
  assert.equal(unitAnimationCadenceMs(200, true), 0);
});

test('staggered clocks spread work and flush all skipped time when a unit becomes important', () => {
  const early = clock(0);
  const late = clock(0.9);
  assert.equal(stepUnitAnimationClock(early, 0, 0.016, 50), 0.016);
  assert.equal(stepUnitAnimationClock(late, 0, 0.016, 50), 0.016);
  assert.equal(stepUnitAnimationClock(early, 30, 0.03, 50), 0.03);
  assert.equal(stepUnitAnimationClock(late, 30, 0.03, 50), undefined);
  assert.equal(stepUnitAnimationClock(late, 45, 0.015, 0), 0.045);
  assert.equal(stepUnitAnimationClock(late, 60, 0.015, 0), 0.015);
  assert.equal(late.pendingSeconds, 0);
});

test('an offscreen rig takes a fresh pose when it returns after a long hidden gap', () => {
  const hidden = clock(0.5);
  assert.equal(stepUnitAnimationClock(hidden, 0, 1 / 60, 50), 1 / 60);
  // The renderer does not call the visible LOD clock while the rig is outside the frustum.
  // Re-entry must be due immediately, with no multi-second mixer jump from hidden frames.
  assert.equal(stepUnitAnimationClock(hidden, 1020, 1 / 60, 50), 1 / 60);
  assert.ok(hidden.nextStepAtMs > 1020);
});

test('a throttled real rig reaches the same clip phase after accumulated time is flushed', () => {
  const parents = Int16Array.of(-1, 0);
  const pivots = new Float32Array(6);
  const template = buildSkinnedTemplateFrom(new THREE.BufferGeometry(), {
    parents, pivots, flags: new Uint16Array(2),
    clips: [{ animationId: 0, duration: 1, channels: [{
      bone: 1, kind: 0,
      times: Float32Array.of(0, 1),
      values: Float32Array.of(0, 0, 0, 1, 0, 0),
    }] }],
    animations: [0], globalChannels: [],
  }, 2);
  const continuous = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  const throttled = instantiateSkinned(template, new THREE.MeshBasicMaterial());
  const clip = template.clips.get(0);
  continuous.mixer.clipAction(clip).play();
  throttled.mixer.clipAction(clip).play();
  const lod = clock(0.35);
  let skipped = 0;
  for (let frame = 0; frame < 120; frame++) {
    const nowMs = frame * 1000 / 60;
    const elapsed = 1 / 60;
    continuous.mixer.update(elapsed);
    const step = stepUnitAnimationClock(lod, nowMs, elapsed, 50);
    if (step === undefined) skipped++;
    else throttled.mixer.update(step);
  }
  assert.ok(skipped > 40, `expected meaningful skipped work, got ${skipped}`);
  const flush = stepUnitAnimationClock(lod, 2000, 0, 0);
  throttled.mixer.update(flush);
  assert.ok(Math.abs(continuous.skeleton.bones[1].position.x - throttled.skeleton.bones[1].position.x) < 1e-5);
  assert.ok(Math.abs(continuous.mixer.time - throttled.mixer.time) < 1e-5);
});
