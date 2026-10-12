// 12.10-6.17: a model's own M2 point light reaches the world with Wow.exe's falloff, not a pool the
// size of the file's attenuation end.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  LocalLightSelection, M2_LIGHT_REACH, m2LightFalloff, modelFixtureLights, sampleFixtureLight,
} from "../dist/code/browser/LocalLighting.js";
import {
  M2_LIGHT_ATTENUATION, M2_LIGHT_FALLOFF_CAP, WORLD_LIGHT_BODY, createWorldLightUniforms,
} from "../dist/code/browser/WorldLighting.js";
import { resetRenderSwitches, setRenderSwitches } from "../dist/code/browser/RenderSwitches.js";

const close = (actual, expected, epsilon = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

const constant = (components, ...values) => ({ interpolation: 0, globalSequence: -1, components,
  tracks: [{ sequence: 0, times: new Uint32Array([0]), values: new Float32Array(values) }] });
const none = (components) => ({ interpolation: 0, globalSequence: -1, components, tracks: [] });
const model = (lights, extra = {}) => ({
  positions: new Float32Array(0), indices: new Uint16Array(0), submeshes: [], batches: [], textures: [],
  particleEmitters: [], colours: [], textureWeights: [], globalSequences: new Uint32Array(0), lights, ...extra,
});
const towerLight = {
  type: 1, bone: -1, position: [0, 0, 12],
  ambientColor: none(3), ambientIntensity: none(1),
  diffuseColor: constant(3, 1, 0.86, 0.5), diffuseIntensity: constant(1, 1),
  // humanguardtower.m2's lanterns: the file's end is 1.89 yards, which is not what the client uses.
  attenuationStart: constant(1, 0.5), attenuationEnd: constant(1, 1.89), visibility: constant(1, 1),
};
const sample = () => ({ position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 });

test("the client's M2 light curve: 1 / (0 + 0.7 d + 0.03 d^2), capped at the source, windowed at the reach", () => {
  assert.deepEqual([...M2_LIGHT_ATTENUATION], [0, 0.7, 0.03], "CM2Light 0x834a40: +0x54 0, +0x58 0.7, +0x5c 0.03");
  close(m2LightFalloff(1), 1 / 0.73);
  close(m2LightFalloff(4), 1 / (2.8 + 0.48));
  close(m2LightFalloff(10), 1 / (7 + 3));
  close(m2LightFalloff(0), M2_LIGHT_FALLOFF_CAP, 0);
  // Inside three quarters of the reach the window does not touch the curve.
  close(m2LightFalloff(0.75 * M2_LIGHT_REACH), 1 / (0.7 * 15 + 0.03 * 225));
  assert.equal(m2LightFalloff(M2_LIGHT_REACH), 0, "nothing past the reach");
  assert.equal(m2LightFalloff(Number.NaN), 0);
  // A tower lantern still lights the ground twelve yards below it, and its own wall strongly.
  assert.ok(m2LightFalloff(12) > 0.07, `${m2LightFalloff(12)} at 12 yd`);
  assert.ok(m2LightFalloff(2) > 0.6, `${m2LightFalloff(2)} at 2 yd`);
});

test("a declared light samples as a client light out to the client's reach; a heuristic one resets the flag", (t) => {
  setRenderSwitches({ m2Lights: true });
  t.after(resetRenderSwitches);
  const tower = model([towerLight]);
  const [fixture] = modelFixtureLights(tower, "World\\Generic\\Human\\Passive Doodads\\Towers\\HumanGuardTower.m2");
  const result = sample();
  const scaled = new THREE.Matrix4().makeScale(1.5, 1.5, 1.5);
  assert.equal(sampleFixtureLight(fixture, tower, scaled, 0, 1000, result), true);
  assert.equal(result.client, true);
  close(result.radius, Math.min(24, M2_LIGHT_REACH * 1.5));
  assert.ok(result.radius > 1.89 * 1.5 * 5, "far past the file's attenuation end");
  // The same sample object, next a heuristic lamp (no M2Light): the flag must not leak into it.
  const lamp = { position: [0, 0, 1], bone: -1, radius: 8, intensity: 1.1, colour: [1, 0.56, 0.2] };
  assert.equal(sampleFixtureLight(lamp, model(undefined), new THREE.Matrix4(), 0, 1000, result), true);
  assert.equal(result.client, false);
  assert.equal(result.radius, 8, "the heuristic keeps its own pool");
});

test("the selection hands a client light to the shader as a negative reach, and the shader reads it", () => {
  const selection = new LocalLightSelection();
  selection.begin(4);
  const camera = new THREE.Vector3();
  selection.add({ ...sample(), position: new THREE.Vector3(1, 0, 0), radius: 20, intensity: 1, client: true }, camera);
  selection.add({ ...sample(), position: new THREE.Vector3(2, 0, 0), radius: 8, intensity: 1 }, camera);
  const uniforms = createWorldLightUniforms();
  assert.equal(selection.write(uniforms, new THREE.Matrix4()), 2);
  assert.deepEqual(uniforms.wowLocalLightPosition.value.slice(0, 2).map((p) => p.w), [-20, 8]);
  assert.ok(WORLD_LIGHT_BODY.includes("float wowLampReach = abs( wowLamp.w );"));
  assert.ok(WORLD_LIGHT_BODY.includes("if ( wowLamp.w < 0.0 ) {"));
  assert.ok(WORLD_LIGHT_BODY.includes("0.700 * wowLampDistance"), "the client's linear term");
  assert.ok(WORLD_LIGHT_BODY.includes("0.030 * wowLampDistance * wowLampDistance"), "and its quadratic one");
  assert.ok(WORLD_LIGHT_BODY.includes("max( wowLampFacing, 0.0 ) * wowClientFalloff"), "the client's own N.L, no wrap");
  // The heuristic pool keeps its own soft radius and day/night weighting.
  assert.ok(WORLD_LIGHT_BODY.includes("1.0 - smoothstep( 0.0, wowLampReach, wowLampDistance )"));
});
