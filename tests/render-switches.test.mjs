// 6.16д and 6.15 twinkle (05.10-A7a-F1): behaviours behind render switches until frames decide.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { renderSwitches, setRenderSwitches, resetRenderSwitches } from '../dist/code/browser/RenderSwitches.js';
import { TWINKLE_NOISE, twinkleNoise, twinklePhase, twinkleSize } from '../dist/code/browser/ParticleTwinkle.js';
import { applyBlendMode } from '../dist/code/browser/ModelBuild.js';
import { BLEND_ALPHA, BLEND_ALPHA_KEY, BLEND_OPAQUE } from '../dist/code/browser/Wvm.js';
import {
  createParticleSystem, particleAppearance, resetParticleSystem, stepParticles,
} from '../dist/code/browser/Particles.js';

test('defaults are the frame this client already drew', () => {
  resetRenderSwitches();
  assert.equal(renderSwitches.m2AlphaDepthWrite, true);
  assert.equal(renderSwitches.particleTwinkle, false);
  setRenderSwitches({ particleTwinkle: true, m2AlphaDepthWrite: 'no', bogus: true });
  assert.equal(renderSwitches.particleTwinkle, true);
  assert.equal(renderSwitches.m2AlphaDepthWrite, true, 'a non-boolean is ignored');
  assert.equal('bogus' in renderSwitches, false);
  resetRenderSwitches();
  assert.equal(renderSwitches.particleTwinkle, false);
});

test('6.16д: m2AlphaDepthWrite off turns the write off for BLEND_ALPHA only', () => {
  const material = () => { const m = new THREE.MeshStandardMaterial(); m.depthWrite = true; return m; };
  try {
    const kept = material();
    applyBlendMode(kept, BLEND_ALPHA);
    assert.equal(kept.depthWrite, true, 'switch on: as before');
    setRenderSwitches({ m2AlphaDepthWrite: false });
    const alpha = material();
    applyBlendMode(alpha, BLEND_ALPHA);
    assert.equal(alpha.depthWrite, false);
    assert.equal(alpha.transparent, true);
    for (const mode of [BLEND_OPAQUE, BLEND_ALPHA_KEY]) {
      const other = material();
      applyBlendMode(other, mode);
      assert.equal(other.depthWrite, true, `blend ${mode} keeps its write`);
    }
  } finally {
    resetRenderSwitches();
  }
});

const emitter = (min, max, percent = 1, speed = 30) => ({
  twinkleSpeed: speed, twinklePercent: percent, twinkleScaleMin: min, twinkleScaleMax: max,
});

test('6.15 twinkle: the noise table, its index and the phase hash', () => {
  assert.equal(TWINKLE_NOISE.length, 128);
  assert.ok(TWINKLE_NOISE.every((v) => v >= 0 && v < 1));
  const mean = TWINKLE_NOISE.reduce((a, b) => a + b, 0) / 128;
  assert.ok(mean > 0.4 && mean < 0.6, `uniform-ish, mean ${mean}`);
  // floor(clamp(speed · age, 0, 255)) + phase, wrapped to 128.
  assert.equal(twinkleNoise(10, 0.55, 3), TWINKLE_NOISE[8]);
  assert.equal(twinkleNoise(10, 100, 0), TWINKLE_NOISE[255 & 0x7f], 'the step is clamped at 255');
  assert.equal(twinkleNoise(10, -1, 5), TWINKLE_NOISE[5]);
  const phases = new Set(Array.from({ length: 64 }, (_, i) => twinklePhase(i + 1)));
  assert.ok(phases.size > 32, 'consecutive spawns land on different phases');
  assert.ok([...phases].every((p) => p >= 0 && p < 128));
});

test('6.15 twinkle: size multiplier and percent gate, only behind the switch', () => {
  try {
    resetRenderSwitches();
    assert.equal(twinkleSize(emitter(0, 1, 0.2), 0.5, 7), 1, 'switch off: ramp size');
    setRenderSwitches({ particleTwinkle: true });
    // A degenerate range burns steady at ramp size — the {0,0} kobold candle.
    assert.equal(twinkleSize(emitter(0, 0), 0.5, 7), 1);
    assert.equal(twinkleSize(emitter(1, 1), 0.5, 7), 1);
    const noise = twinkleNoise(30, 0.5, 7);
    assert.ok(Math.abs(twinkleSize(emitter(0.5, 1.5), 0.5, 7) - (0.5 + noise)) < 1e-6);
    // The gate: a sample above a partial percent draws nothing that frame.
    let hidden = 0;
    for (let phase = 0; phase < 128; phase++) if (twinkleSize(emitter(1, 1, 0.25), 0, phase) === 0) hidden++;
    assert.ok(hidden > 70 && hidden < 120, `about three quarters hidden at 0.25, got ${hidden}/128`);
  } finally {
    resetRenderSwitches();
  }
});

/** The particles.test.mjs blank emitter, as a campfire with a 0.5..1.5 twinkle. */
function campfire() {
  const ramp = (components, values) => ({ components, times: Float32Array.from([0, 1]), values: Float32Array.from(values) });
  const flat = (value) => ({ interpolation: 0, globalSequence: -1, components: 1,
    tracks: [{ sequence: 0, times: Uint32Array.from([0]), values: Float32Array.from([value]) }] });
  const blank = {
    id: 1, flags: 0, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4, emitterType: 1,
    particleType: 0, headTail: 0, particleColorIndex: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0, emissionRateVary: 0, scaleVary: [0, 0],
    tailLength: 0, twinkleSpeed: 30, twinklePercent: 1, twinkleScaleMin: 0.5, twinkleScaleMax: 1.5,
    burstMultiplier: 0, drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0, followSpeed2: 0,
    followScale2: 0, splinePoints: new Float32Array(0),
  };
  for (const name of ["emissionSpeed", "speedVariation", "verticalRange", "horizontalRange",
    "gravity", "emissionAreaLength", "emissionAreaWidth", "zSource", "enabledIn"]) {
    blank[name] = { interpolation: 0, globalSequence: -1, components: 1, tracks: [] };
  }
  blank.lifespan = flat(5);
  blank.emissionRate = flat(20);
  blank.color = ramp(3, [1, 1, 1, 1, 1, 1]);
  blank.opacity = ramp(1, [1, 1]);
  blank.scale = ramp(2, [2, 2, 2, 2]);
  blank.headCell = ramp(1, [0, 0]);
  blank.tailCell = ramp(1, [0, 0]);
  return blank;
}

test('6.15 twinkle reaches particleAppearance through the particle\'s phase', () => {
  const frame = { matrix: new THREE.Matrix4().elements, animationMs: 0, worldMs: 0 };
  const system = createParticleSystem(campfire(), new Uint32Array(0), 1234);
  stepParticles(system, 0.5, frame);
  assert.ok(system.particles.length > 1);
  const out = {};
  try {
    resetRenderSwitches();
    const plain = system.particles.map((p) => particleAppearance(system.emitter, p, out).width);
    assert.ok(plain.every((w) => Math.abs(w - 2) < 1e-6), 'off: ramp size');
    setRenderSwitches({ particleTwinkle: true });
    const twinkled = system.particles.map((p) => particleAppearance(system.emitter, p, out).width);
    assert.ok(twinkled.every((w) => w >= 1 - 1e-6 && w <= 3 + 1e-6), 'within ramp × [0.5, 1.5]');
    assert.ok(new Set(twinkled.map((w) => w.toFixed(4))).size > 1, 'particles do not all flicker in step');
    const phases = system.particles.map((p) => p.phase);
    resetParticleSystem(system, 1234);
    stepParticles(system, 0.5, frame);
    assert.deepEqual(system.particles.map((p) => p.phase), phases, 'a replay epoch reproduces the phases');
  } finally {
    resetRenderSwitches();
  }
});
