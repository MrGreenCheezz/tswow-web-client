import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { PARTICLE_ALPHA_KEY_REFERENCE, PARTICLE_ALPHA_REFERENCE, particleDepthState } from "../dist/code/browser/ParticleDepth.js";
import { buildModelEffects, updateModelEffects } from "../dist/code/browser/ParticleRender.js";

// 15.11 (6.15): depth write, alpha test and blending of a particle emitter by its blending type, as Wow.exe's model load
// (0x00833c80: material bit 4 kept for blends 0 and 1), draw (0x008214e0: M2 flag 0x10 without it; 0x0081fe90: alpha
// reference 0 / 224/255 × model alpha / 1/255) and the stand's recordings (F:\WowOracle\runs\fx6-f-*.tsv) set them.

const NONE = new Uint32Array(0);
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

test("15.11: opaque and alpha-key emitters write depth unblended; alpha key is gated at 224/255; the rest blend at 1/255", () => {
  assert.deepEqual(particleDepthState(0), { depthWrite: true, alphaTest: 0, blended: false });
  // Recorded: fx6-f-mgiant-1 #821 (TUMBLINGROCK.BLP), fx6-f-roots-1 #821 (PARTROCK.BLP): blend off, ALPHAREF 224, z write.
  assert.deepEqual(particleDepthState(1), { depthWrite: true, alphaTest: 224 / 255, blended: false });
  for (const blend of [2, 3, 4, 5, 6]) {
    assert.deepEqual(particleDepthState(blend), { depthWrite: false, alphaTest: PARTICLE_ALPHA_REFERENCE, blended: true }, `blend ${blend}`);
  }
  assert.equal(PARTICLE_ALPHA_KEY_REFERENCE, 224 / 255);
});

test("15.11: a fading model's alpha-key particles blend, keep depth write, and their reference scales with the alpha", () => {
  // Recorded: fx6-f-roots-1 #911, the despawned giant's rocks at model alpha 0.777034: blended, ALPHAREF 174, z write.
  const fading = particleDepthState(1, 0.777034);
  assert.equal(fading.blended, true);
  assert.equal(fading.depthWrite, true);
  assert.equal(Math.floor(fading.alphaTest * 255), 174);
  // The other blends do not move with it.
  assert.deepEqual(particleDepthState(4, 0.5), { depthWrite: false, alphaTest: PARTICLE_ALPHA_REFERENCE, blended: true });
  // Never zero: that would be another three.js program in the middle of a fade.
  assert.ok(particleDepthState(1, 0).alphaTest > 0);
});

test("15.11: the built emitter's material carries it", () => {
  for (const [blendType, depthWrite, alphaTest, transparent] of [
    [0, true, 0, false], [1, true, 224 / 255, false], [2, false, 1 / 255, true], [4, false, 1 / 255, true],
  ]) {
    const effects = buildModelEffects({
      globalSequences: NONE, ribbonEmitters: [], particleEmitters: [emitter({ blendType })],
      textures: [{ type: 0, path: "spells\\depth.blp" }],
    }, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
    const material = effects.emitters[0].material;
    assert.equal(material.depthWrite, depthWrite, `blend ${blendType}`);
    assert.equal(material.alphaTest, alphaTest, `blend ${blendType}`);
    assert.equal(material.transparent, transparent, `blend ${blendType}`);
    if (!transparent) assert.equal(material.blending, THREE.NoBlending, `blend ${blendType}`);
  }
});

test("15.11: a fading unit's alpha-key emitter moves its gate and blend with the unit's alpha, frame by frame", () => {
  const IDENTITY = new THREE.Matrix4().elements;
  const VIEW = { rightX: 1, rightY: 0, rightZ: 0, upX: 0, upY: 1, upZ: 0 };
  const track = (value) => ({ interpolation: 0, globalSequence: -1, components: 1,
    tracks: [{ sequence: 0, times: Uint32Array.of(0), values: Float32Array.of(value) }] });
  const build = (blendType) => buildModelEffects({
    globalSequences: NONE, ribbonEmitters: [], textures: [{ type: 0, path: "spells\\fade.blp" }],
    particleEmitters: [emitter({ blendType, emissionRate: track(50), lifespan: track(10) })],
  }, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
  const step = (effects, modelAlpha) => updateModelEffects(effects,
    0.1, { matrixFor: () => IDENTITY, animationMs: 0, worldMs: 0, modelAlpha }, VIEW);

  const keyed = build(1);
  const material = keyed.emitters[0].material;
  step(keyed, 0.777034);
  // The vertex alpha already carries 0.777 (6.11); a fixed 224/255 would cut every particle. Wow.exe: ALPHAREF 174, blended.
  assert.equal(Math.floor(material.alphaTest * 255), 174);
  assert.equal(material.transparent, true);
  assert.equal(material.blending, THREE.NormalBlending);
  assert.equal(material.depthWrite, true);
  step(keyed, 1);
  assert.equal(material.alphaTest, 224 / 255, "back at full alpha");
  assert.equal(material.transparent, false);
  assert.equal(material.blending, THREE.NoBlending);

  // An additive emitter keeps its own blend and gate whatever the alpha.
  const additive = build(4);
  const blending = additive.emitters[0].material.blending;
  step(additive, 0.5);
  assert.equal(additive.emitters[0].material.blending, blending);
  assert.equal(additive.emitters[0].material.alphaTest, 1 / 255);
});
