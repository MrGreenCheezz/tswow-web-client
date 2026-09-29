import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  WORLD_AERIAL_FOG_BODY, aerialFogFactor, aerialWarmthForSunElevation,
  applyHorizonAerialFog, applyWorldLight, createWorldLightUniforms, setWorldLightAerialFog,
} from "../dist/code/browser/WorldLighting.js";

test("aerial height fog respects the authored near and far joins", () => {
  for (const height of [-250, -20, 0, 20, 250]) {
    assert.equal(aerialFogFactor(0, height, 1), 0);
    assert.equal(aerialFogFactor(1, height, 1), 1);
    assert.equal(aerialFogFactor(0.5, height, 0), 0.5);
  }
  assert.ok(aerialFogFactor(0.5, 120, 1) > 0.5,
    "a valley below the camera gains atmospheric depth");
  assert.ok(aerialFogFactor(0.5, -200, 1) < 0.5,
    "high ground stays readable through the same distance fog");
  assert.ok(aerialFogFactor(0.5, 120, 1) < 0.65,
    "the bounded height term cannot wash out the middle distance");
  assert.match(WORLD_AERIAL_FOG_BODY, /fogFactor \* \( 1\.0 - fogFactor \)/,
    "the shader's height term also vanishes at the near and far joins");
});

test("low daylight warms haze while sunset and night fade continuously", () => {
  assert.equal(aerialWarmthForSunElevation(-1), 0);
  assert.equal(aerialWarmthForSunElevation(Number.NaN), 0);
  assert.ok(aerialWarmthForSunElevation(0.1) > aerialWarmthForSunElevation(1));
  assert.ok(aerialWarmthForSunElevation(0.1) > 0.7);
  assert.ok(aerialWarmthForSunElevation(1) > 0);

  const uniforms = createWorldLightUniforms();
  const strength = uniforms.wowAerialStrength;
  const warmth = uniforms.wowAerialWarmth;
  setWorldLightAerialFog(uniforms, true, 0.1);
  assert.equal(uniforms.wowAerialStrength, strength);
  assert.equal(uniforms.wowAerialWarmth, warmth);
  assert.equal(strength.value, 1);
  assert.ok(warmth.value > 0.7);
  setWorldLightAerialFog(uniforms, false, 0.1);
  assert.equal(strength.value, 0);
  assert.equal(warmth.value, 0);
});

test("production lit and horizon materials share a reversible aerial fog program", () => {
  const uniforms = createWorldLightUniforms();
  const terrain = new THREE.MeshLambertMaterial({ fog: true });
  const horizon = new THREE.MeshBasicMaterial({ fog: true });
  applyWorldLight(terrain, uniforms, "terrain");
  applyHorizonAerialFog(horizon, uniforms);
  const terrainShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  const horizonShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
  };
  terrain.onBeforeCompile(terrainShader, {});
  horizon.onBeforeCompile(horizonShader, {});
  for (const shader of [terrainShader, horizonShader]) {
    assert.equal(shader.uniforms.wowAerialStrength, uniforms.wowAerialStrength);
    assert.equal(shader.uniforms.wowAerialWarmth, uniforms.wowAerialWarmth);
    assert.equal(shader.uniforms.wowSunDirection, uniforms.wowSunDirection);
    assert.match(shader.vertexShader, /-dot\( viewMatrix\[ 1 \]\.xyz, mvPosition\.xyz \)/);
    assert.match(shader.fragmentShader, /wowAerialFogFactor/);
    assert.match(shader.fragmentShader, /wowSunFacing/);
    assert.doesNotMatch(shader.fragmentShader, /#include <fog_fragment>/);
    assert.equal((shader.fragmentShader.match(/uniform vec3 wowSunDirection;/g) ?? []).length, 1,
      "each shader program declares the sun vector exactly once");
  }
  assert.match(terrainShader.fragmentShader, /WOW_LIGHT_TERRAIN/);
  assert.doesNotMatch(horizonShader.fragmentShader, /wowAuthoredLight/);
  applyHorizonAerialFog(horizon, uniforms);
  assert.throws(() => applyHorizonAerialFog(horizon, createWorldLightUniforms()), /conflicting/);
  terrain.dispose();
  horizon.dispose();
});
