import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { PARTICLE_ALPHA_KEY_REFERENCE, PARTICLE_ALPHA_REFERENCE, particleDepthState } from "../dist/code/browser/ParticleDepth.js";
import { buildModelEffects } from "../dist/code/browser/ParticleRender.js";

// 15.11 (6.15): depth write and alpha test of a particle emitter by its blending type, as Wow.exe's model load
// (0x00833c80: material bit 4 kept for blends 0 and 1) and draw (0x008214e0: M2 flag 0x10 without it; 0x0081fe90: alpha
// reference 0 / 224/255 / 1/255) set them.

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

test("15.11: an opaque emitter writes depth, the blended ones do not and are gated at 1/255; alpha key waits", () => {
  assert.deepEqual(particleDepthState(0), { depthWrite: true, alphaTest: 0 });
  // Alpha key: depth write with a gate of 224/255 × draw item +0xc in Wow.exe. The factor is not known for particles,
  // and depth write without the gate would cut holes behind transparent texels, so neither is applied yet.
  assert.deepEqual(particleDepthState(1), { depthWrite: false, alphaTest: 0 });
  for (const blend of [2, 3, 4, 5, 6]) {
    assert.deepEqual(particleDepthState(blend), { depthWrite: false, alphaTest: PARTICLE_ALPHA_REFERENCE }, `blend ${blend}`);
  }
  assert.equal(PARTICLE_ALPHA_KEY_REFERENCE, 224 / 255);
});

test("15.11: the built emitter's material carries it", () => {
  for (const [blendType, depthWrite, alphaTest] of [[0, true, 0], [1, false, 0], [2, false, 1 / 255], [4, false, 1 / 255]]) {
    const effects = buildModelEffects({
      globalSequences: NONE, ribbonEmitters: [], particleEmitters: [emitter({ blendType })],
      textures: [{ type: 0, path: "spells\\depth.blp" }],
    }, { baseUrl: "http://gateway", loadTexture: () => new THREE.Texture() });
    const material = effects.emitters[0].material;
    assert.equal(material.depthWrite, depthWrite, `blend ${blendType}`);
    assert.equal(material.alphaTest, alphaTest, `blend ${blendType}`);
  }
});
