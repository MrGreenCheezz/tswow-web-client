import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  PARTICLE_FLAG_FOLLOW,
  createParticleSystem, createQuadBuffers, particleDensity, particleSubsteps, setParticleDensity,
  stepParticles, writeParticleQuads,
} from "../dist/code/browser/Particles.js";
import { createRibbonSystem, stepRibbon } from "../dist/code/browser/RibbonEmitter.js";
import { MODEL_ALPHA_DRAWN, buildModelEffects, updateModelEffects } from "../dist/code/browser/ParticleRender.js";

// 11.11 (6.15, 6.11): how Wow.exe 3.3.5a 12340 advances an emitter in time, thins it, and fades it with its model —
// CParticleEmitter2::Update 0x0097eb10, InternalUpdate 0x0097acb0, EmitNewParticles 0x0097d8c0, the particleDensity
// callback 0x0078d860 → 0x00980f70, CM2Model::AnimateParticleST 0x008309c0 (m_alphaScale), InterpolateAllTracks
// 0x00979e90, the ribbon's SetAlpha in CM2Model::Animate 0x00828a00 (.runtime/re-2026-11-11/fx4/).

const IDENTITY = new THREE.Matrix4().elements;
const VIEW = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
const NONE = new Uint32Array(0);

function track(values, times = [0]) {
  return { interpolation: 0, globalSequence: -1, components: 1,
    tracks: [{ sequence: 0, times: Uint32Array.from(times), values: Float32Array.from(values) }] };
}
const emptyTrack = (components = 1) => ({ interpolation: 0, globalSequence: -1, components, tracks: [] });
const emptyRamp = (components = 1) => ({ components, times: new Float32Array(0), values: new Float32Array(0) });

function emitter(overrides = {}) {
  const blank = {
    id: 1, flags: 0, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4, emitterType: 1,
    particleType: 0, headTail: 0, particleColorIndex: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0, emissionRateVary: 0, scaleVary: [0, 0],
    tailLength: 0, twinkleSpeed: 0, twinklePercent: 1, twinkleScaleMin: 1, twinkleScaleMax: 1,
    burstMultiplier: 0, drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0, followSpeed2: 0,
    followScale2: 0, splinePoints: new Float32Array(0),
  };
  for (const name of ["emissionSpeed", "speedVariation", "verticalRange", "horizontalRange", "gravity",
    "lifespan", "emissionRate", "emissionAreaLength", "emissionAreaWidth", "zSource", "enabledIn"]) blank[name] = emptyTrack();
  blank.color = emptyRamp(3); blank.opacity = emptyRamp(); blank.scale = emptyRamp(2);
  blank.headCell = emptyRamp(); blank.tailCell = emptyRamp();
  return { ...blank, ...overrides };
}

function ribbon(overrides = {}) {
  const blank = {
    id: 1, bone: 0, position: [0, 0, 0], textures: Uint16Array.of(0), materials: [{ blendMode: 2, flags: 0 }],
    edgesPerSecond: 10, edgeLifetime: 1, gravity: 0, textureRows: 1, textureColumns: 1,
    priorityPlane: 0, ribbonColorIndex: 0, textureTransformLookupIndex: 0,
  };
  for (const name of ["color", "alpha", "heightAbove", "heightBelow", "textureSlot", "visibility"]) {
    blank[name] = emptyTrack(name === "color" ? 3 : 1);
  }
  return { ...blank, ...overrides };
}

const frame = (extra = {}) => ({ matrix: IDENTITY, animationMs: 0, worldMs: 0, ...extra });

/** One live particle of a long life, born in a first zero-age burst and then left alone (no further emission). */
function oneParticle(overrides = {}) {
  const system = createParticleSystem(emitter({ emissionRate: track([0]), lifespan: track([100]), ...overrides }), NONE, 5);
  system.particles.push({
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bx: 0, by: 0, bz: 0, age: 1, life: 100, spin: 0, spinRate: 0,
    scaleX: 1, scaleY: 1, cellOffset: 0, phase: 0,
  });
  return system;
}

/* --- 6.15 b: the 0.1 s step ------------------------------------------------------------------ */

test("6.15 a frame splits as InternalUpdate 0x0097acb0 splits it: 0.1 s steps, FISTP(steps − 0.5), then the rest", () => {
  const rest = [0];
  assert.equal(particleSubsteps(0.05, 10, rest), 0);
  assert.equal(rest[0], 0.05, "up to 0.1 s is one step");
  assert.equal(particleSubsteps(0.1, 10, rest), 0);
  assert.equal(rest[0], 0.1);
  assert.equal(particleSubsteps(0.45, 10, rest), 4, "four whole steps: FISTP(3.5) = 4");
  assert.ok(Math.abs(rest[0] - 0.05) < 1e-9, "then 0.05");
  assert.equal(particleSubsteps(0.35, 10, rest), 2, "three whole steps: FISTP(2.5) = 2 — an odd count loses one");
  assert.ok(Math.abs(rest[0] - 0.05) < 1e-9);
  assert.equal(particleSubsteps(0.45, 0.25, rest), 2, "no more steps than floor(lifespan · 10): min(4, 2) → FISTP(1.5)");
  assert.equal(particleSubsteps(0.45, 0.05, rest), 0, "a lifespan under 0.1 s: only the rest");
  assert.equal(particleSubsteps(-1, 10, rest), 0);
  assert.equal(rest[0], 0, "a negative frame steps nothing");
});

test("6.15 a long frame is caught up, not cut to 0.1 s", () => {
  const even = oneParticle();
  stepParticles(even, 0.45, frame());
  assert.ok(Math.abs(even.particles[0].age - 1.45) < 1e-9, `aged ${even.particles[0].age - 1} s of 0.45`);
  const odd = oneParticle();
  stepParticles(odd, 0.35, frame());
  assert.ok(Math.abs(odd.particles[0].age - 1.25) < 1e-9, `aged ${odd.particles[0].age - 1} s: 2 × 0.1 + 0.05`);
  const short = oneParticle({ lifespan: track([0.25]) });
  stepParticles(short, 2, frame());
  assert.ok(Math.abs(short.particles[0].age - 1.2) < 1e-9, "a 0.25 s lifespan caps a 2 s frame at FISTP(1.5) · 0.1 + 0");
  const quick = oneParticle();
  stepParticles(quick, 1 / 60, frame());
  assert.ok(Math.abs(quick.particles[0].age - 1 - 1 / 60) < 1e-9, "an ordinary frame is one step");
});

test("6.15 a long frame's follow is measured over the whole frame and shared between its steps", () => {
  // speed 0 → nothing carried, speed 10 → all of it: the carried share is speed / 10 (SetFollowParams 0x00978dd0).
  const follow = { flags: PARTICLE_FLAG_FOLLOW, followSpeed1: 0, followScale1: 0, followSpeed2: 10, followScale2: 1 };
  const system = oneParticle(follow);
  stepParticles(system, 0.05, frame());
  const moved = new THREE.Matrix4().makeTranslation(1, 0, 0).elements;
  stepParticles(system, 0.45, frame({ matrix: moved }));
  // One yard in 0.45 s: speed 2.22, so 0.222 of the move, spread over the five steps (m_burstOffset / (count + 1)).
  assert.ok(Math.abs(system.particles[0].x - 1 / 0.45 / 10) < 1e-9, `carried ${system.particles[0].x}`);
});

/* --- 6.15 c: density and distance ----------------------------------------------------------- */

test("6.15 particleDensity scales every emitter's rate, clamped as 0x00980f70 clamps it", () => {
  try {
    setParticleDensity(2);
    assert.equal(particleDensity(), 1);
    setParticleDensity(-0.5);
    assert.equal(particleDensity(), 0);
    setParticleDensity(Number.NaN);
    assert.equal(particleDensity(), 0);
    const spawned = (density) => {
      setParticleDensity(density);
      const system = createParticleSystem(emitter({ emissionRate: track([20]), lifespan: track([100]) }), NONE, 9);
      for (let step = 0; step < 50; step++) stepParticles(system, 0.1, frame());
      return system.particles.length;
    };
    assert.equal(spawned(1), 100, "20 a second for 5 s");
    assert.equal(spawned(0.5), 50, "half at «Плотность частиц» 0.5");
    assert.equal(spawned(0.1), 10, "a tenth at the slider's floor");
  } finally {
    setParticleDensity(1);
  }
});

test("6.15 the distance thinning takes the varied rate, not the rate alone (0x0097d8c0)", () => {
  // rate 1, vary 1 at 200 yd (thinning 0.25): Wow.exe's mean is (1 + U[−1, 1]) · 0.25 = 0.25 a second; adding the
  // vary after the thinning gave max(0, 0.25 + U[−1, 1]) — 0.39 a second.
  const system = createParticleSystem(emitter({ emissionRate: track([1]), emissionRateVary: 1, lifespan: track([1e4]) }), NONE, 3);
  for (let step = 0; step < 4000; step++) stepParticles(system, 0.1, frame({ viewX: 200, viewY: 0, viewZ: 0 }));
  const perSecond = system.particles.length / 400;
  assert.ok(perSecond > 0.2 && perSecond < 0.3, `${perSecond} a second`);
});

/* --- 6.11: the model's fade -------------------------------------------------------------------- */

test("6.11 the model's alpha multiplies each particle's vertex alpha, after the ramp-only skip", () => {
  const system = oneParticle({ opacity: { components: 1, times: Float32Array.of(0), values: Float32Array.of(0.8) } });
  system.modelAlpha = 0.25;
  const buffers = createQuadBuffers(4);
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1);
  for (let corner = 0; corner < 4; corner++) assert.ok(Math.abs(buffers.colors[corner * 4 + 3] - 0.2) < 1e-6, "0.8 × 0.25");
  system.modelAlpha = 0.001;
  assert.equal(writeParticleQuads(system, VIEW, buffers), 1, "a nearly faded model's particle is still written");
});

function unitEffects(blendType) {
  const model = {
    globalSequences: NONE, ribbonEmitters: [],
    particleEmitters: [emitter({ blendType, emissionRate: track([50]), lifespan: track([10]) })],
    textures: [{ type: 0, path: "spells\\fade.blp" }],
  };
  return buildModelEffects(model, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
}

test("6.11 a fading unit's emitters keep their material and blend; the fade is in the vertices", () => {
  for (const blendType of [2, 3, 4]) {
    const effects = unitEffects(blendType);
    const material = effects.emitters[0].material;
    updateModelEffects(effects, 0.1, { matrixFor: () => IDENTITY, animationMs: 0, worldMs: 0, modelAlpha: 0.35 }, VIEW,
      { particleLight: { r: 0.4, g: 0.5, b: 0.6 } });
    assert.equal(material.opacity, 1, `blend ${blendType}: the material is not faded`);
    const colors = effects.emitters[0].geometry.getAttribute("color").array;
    assert.ok(Math.abs(colors[3] - 0.35) < 1e-6, `blend ${blendType}: vertex alpha 0.35`);
    assert.ok(Math.abs(colors[0] - 1) < 1e-6, `blend ${blendType}: the colour is not darkened`);
    assert.ok(Math.abs(material.color.g - 0.5) < 1e-6, `blend ${blendType}: a lit particle keeps the scene's light`);
  }
});

test("6.11 under 0.0001 model alpha nothing is drawn, but the emitters keep running", () => {
  const effects = unitEffects(4);
  const drawn = effects.emitters[0];
  updateModelEffects(effects, 0.1, { matrixFor: () => IDENTITY, animationMs: 0, worldMs: 0, modelAlpha: MODEL_ALPHA_DRAWN / 2 }, VIEW);
  assert.equal(drawn.mesh.visible, false);
  assert.ok(drawn.particles.particles.length > 0, "the simulation ran (AnimateParticleST runs whatever the alpha)");
  updateModelEffects(effects, 0.1, { matrixFor: () => IDENTITY, animationMs: 100, worldMs: 100, modelAlpha: 1 }, VIEW);
  assert.equal(drawn.mesh.visible, true, "and they show again at once");
});

test("6.11 a ribbon lays its new edges with track alpha × the model's alpha (SetAlpha 0x0097fba0)", () => {
  const system = createRibbonSystem(ribbon({ alpha: track([0.8]) }), NONE);
  stepRibbon(system, 0.1, frame({ modelAlpha: 0.5 }));
  stepRibbon(system, 0.1, frame({ matrix: new THREE.Matrix4().makeTranslation(1, 0, 0).elements, modelAlpha: 0.5 }));
  assert.ok(system.edges.length > 0);
  for (const edge of system.edges) assert.ok(Math.abs(edge.alpha - 0.4) < 1e-6, `${edge.alpha}`);
  assert.ok(Math.abs(system.head.alpha - 0.4) < 1e-6);
});
