// 6.17 (05.10-A7a-F2): a model that declares `M2Light` records is lit by them, not by the file-name
// heuristic; one that declares none keeps the heuristic exactly.

import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { modelFixtureLights, sampleFixtureLight } from "../dist/code/browser/LocalLighting.js";
import { resetRenderSwitches, setRenderSwitches } from "../dist/code/browser/RenderSwitches.js";

const constant = (components, ...values) => ({ interpolation: 0, globalSequence: -1, components,
  tracks: [{ sequence: 0, times: new Uint32Array([0]), values: new Float32Array(values) }] });
const none = (components) => ({ interpolation: 0, globalSequence: -1, components, tracks: [] });

function light(overrides = {}) {
  return {
    type: 1, bone: -1, position: [0, 0, 4],
    ambientColor: none(3), ambientIntensity: none(1),
    diffuseColor: constant(3, 1, 0.5, 0.25), diffuseIntensity: constant(1, 1.5),
    attenuationStart: constant(1, 1), attenuationEnd: constant(1, 6), visibility: constant(1, 1),
    ...overrides,
  };
}

function model(lights) {
  return {
    positions: new Float32Array(0), indices: new Uint16Array(0), submeshes: [], batches: [], textures: [],
    particleEmitters: [], colours: [], textureWeights: [], globalSequences: new Uint32Array(0), lights,
  };
}

const sample = () => ({ position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 });

test("6.17 the switch is off by default: a declared light changes nothing until frames accept it", () => {
  resetRenderSwitches();
  const withLight = model([light()]);
  assert.equal(modelFixtureLights(withLight, "Creature\\Anything.m2").length, 0, "the heuristic, which finds no lamp here");
  setRenderSwitches({ m2Lights: true });
  try {
    assert.equal(modelFixtureLights(withLight, "Creature\\Anything.m2").length, 1, "and the switch takes effect on a cached model");
  } finally {
    resetRenderSwitches();
  }
});

test("6.17 a declared point light is a fixture whatever the model is called", (t) => {
  setRenderSwitches({ m2Lights: true });
  t.after(resetRenderSwitches);
  const withLight = model([light(), light({ type: 0 })]);
  const fixtures = modelFixtureLights(withLight, "World\\Generic\\Human\\Passive Doodads\\Towers\\HumanGuardTower.m2");
  assert.equal(fixtures.length, 1, "the point light, and not the directional one");
  assert.equal(fixtures[0].light, withLight.lights[0]);
  assert.equal(fixtures[0].radius, 6, "reach is attenuation end");
  assert.equal(modelFixtureLights(withLight, "Creature\\Anything.m2")[0]?.light, withLight.lights[0],
    "no name gate for a light the file declares");
});

test("6.17 sampling reads the light's own colour, intensity, reach and visibility", (t) => {
  setRenderSwitches({ m2Lights: true });
  t.after(resetRenderSwitches);
  const withLight = model([light()]);
  const [fixture] = modelFixtureLights(withLight, "World\\Lamp.m2");
  const result = sample();
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(10, 0, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
  assert.equal(sampleFixtureLight(fixture, withLight, matrix, 0, 1000, result), true);
  assert.deepEqual([result.position.x, result.position.y, result.position.z], [10, 0, 4]);
  assert.deepEqual([result.colour.x, result.colour.y, result.colour.z], [1, 0.5, 0.25]);
  assert.equal(result.intensity, 1.5, "no synthetic flicker on a light the file animates itself");
  assert.equal(result.radius, 6);
  const dark = model([light({ visibility: constant(1, 0) })]);
  assert.equal(sampleFixtureLight(modelFixtureLights(dark, "World\\Lamp.m2")[0], dark, matrix, 0, 1000, sample()), false,
    "visibility 0 puts it out");
});

test("6.17 a model with no declared lights keeps the name heuristic", (t) => {
  setRenderSwitches({ m2Lights: true });
  t.after(resetRenderSwitches);
  const plain = model(undefined);
  assert.equal(modelFixtureLights(plain, "World\\Generic\\Human\\Passive Doodads\\Lampposts\\DuskwoodLamppost.m2").length, 0,
    "no glow card, no light — the heuristic as before");
  const empty = model([]);
  assert.equal(modelFixtureLights(empty, "World\\Lamp.m2").length, 0);
});
