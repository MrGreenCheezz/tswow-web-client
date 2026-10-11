import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import {
  GLUE_MAX_POINT_LIGHTS, applyGlueBackdropPointLight, clampGlueLighting, glueBackdropPointLights,
} from "../dist/code/browser/glue/GlueBackdropLights.js";
import { M2_TO_SCENE } from "../dist/code/browser/AnimatedModel.js";

/**
 * 12.10 — a glue model's point lights light its scene and the figure in it; the race light sets
 * replace only its directional lights (GlueParent.lua's SetLighting). UI_NightElf's records, as the
 * gateway serves them (measured 12.10).
 */

const constant = (...values) => ({
  interpolation: 0, globalSequence: -1, components: values.length,
  tracks: [{ sequence: 0, times: Uint32Array.of(0), values: Float32Array.from(values) }],
});

function light(type, position, colour, intensity, end = 5.556, visibility = 1) {
  return {
    type, bone: 0, position,
    ambientColor: constant(1, 1, 1), ambientIntensity: constant(0),
    diffuseColor: constant(...colour), diffuseIntensity: constant(intensity),
    attenuationStart: constant(2.222), attenuationEnd: constant(end), visibility: constant(visibility),
  };
}

const NIGHT_ELF = {
  globalSequences: new Uint32Array(0),
  lights: [
    light(1, [-23.08, -5.45, 1.64], [0.322, 0.58, 0.541], 13),
    light(1, [1.13, -1.41, 5.59], [0.769, 0.875, 1], 2.5),
    // The directional record RaceLights.NIGHTELF duplicates: 0.2 x (0.451, 0.451, 0.851).
    light(0, [-89.11, -1.41, 86.76], [1, 1, 1], 0),
    light(1, [0.79, 0.98, 3.19], [0.769, 0.875, 1], 0.7),
  ],
};

test("the night elf backdrop's three point lights are read, its directional record is not", () => {
  const points = glueBackdropPointLights(NIGHT_ELF, 0, 0);
  assert.equal(points.length, 3);
  assert.deepEqual(points.map((point) => point.position), [NIGHT_ELF.lights[0].position, NIGHT_ELF.lights[1].position, NIGHT_ELF.lights[3].position]);
  const moon = points[1];
  assert.ok(Math.abs(moon.b - 2.5) < 1e-6 && Math.abs(moon.r - 0.769 * 2.5) < 1e-5, "colour times intensity");
  assert.ok(Math.abs(moon.radius - 5.556) < 1e-6, "the attenuation end is the radius");
});

test("a directional record is the race set's to replace, never a point (UI_Human's keys)", () => {
  const human = {
    globalSequences: new Uint32Array(0),
    lights: [light(0, [-258.41, -203.82, 0.34], [0.949, 0.8, 0.541], 1.1), light(0, [-241.16, 9.71, 0.34], [0.306, 0.537, 0.671], 0.65)],
  };
  assert.deepEqual(glueBackdropPointLights(human, 0, 0), []);
});

test("an invisible, unlit or radius-less point casts nothing, and at most four are kept", () => {
  const model = {
    globalSequences: new Uint32Array(0),
    lights: [
      light(1, [0, 0, 0], [1, 1, 1], 1, 5, 0),
      light(1, [0, 0, 0], [1, 1, 1], 0),
      light(1, [0, 0, 0], [1, 1, 1], 1, 0),
      ...Array.from({ length: 6 }, () => light(1, [1, 2, 3], [1, 1, 1], 1)),
    ],
  };
  assert.equal(glueBackdropPointLights(model, 0, 0).length, GLUE_MAX_POINT_LIGHTS);
  assert.equal(GLUE_MAX_POINT_LIGHTS, 4);
});

test("a point light sits at its record in the model root's frame, scaled with it", () => {
  const root = new THREE.Object3D();
  root.quaternion.copy(M2_TO_SCENE);
  root.scale.setScalar(2);
  root.updateWorldMatrix(true, false);
  const target = new THREE.PointLight(0xffffff, 0, 1, 0);
  const [moon] = glueBackdropPointLights({ globalSequences: new Uint32Array(0), lights: [NIGHT_ELF.lights[1]] }, 0, 0);
  applyGlueBackdropPointLight(target, moon, root, 2, Math.PI);
  // M2 is Z-up: (x, y, z) lands at (x, z, -y) in the Y-up scene, times the root's scale.
  assert.ok(target.position.distanceTo(new THREE.Vector3(2.26, 11.18, 2.82)) < 1e-4, target.position.toArray().join(","));
  assert.ok(Math.abs(target.distance - 11.112) < 1e-3);
  assert.ok(Math.abs(target.intensity - 2.5 * Math.PI) < 1e-5);
  assert.ok(Math.abs(target.color.b - 1) < 1e-6 && Math.abs(target.color.r - 0.769) < 1e-5);
  applyGlueBackdropPointLight(target, undefined, root, 2, Math.PI);
  assert.equal(target.intensity, 0, "an unused light is switched off, never removed");
});

test("the stage gives every view the points and applies them after the race set", () => {
  const source = readFileSync(new URL("../src/browser/glue/GlueModelStage.ts", import.meta.url), "utf8");
  assert.match(source, /for \(let index = 0; index < GLUE_MAX_POINT_LIGHTS; index \+= 1\) \{\s+const point = new THREE\.PointLight\(0xffffff, 0, 1, 0\);\s+scene\.add\(point\);/);
  assert.match(source, /const points = view\.wvm \? glueBackdropPointLights\(view\.wvm, view\.animationMs, nowMs\) : \[\];/);
  assert.match(source, /applyGlueBackdropPointLight\(point, points\[index\], root, root\?\.scale\.x \?\? 1, GLUE_LIGHT_INTENSITY_SCALE\);/);
});

test("a glue surface's light sum is clamped to 1, chained after the material's own steps", () => {
  const material = new THREE.MeshStandardMaterial();
  const calls = [];
  material.onBeforeCompile = (shader) => { calls.push("model"); shader.fragmentShader += " // model-step"; };
  material.customProgramCacheKey = () => "model-key";
  clampGlueLighting(material);
  clampGlueLighting(material);
  const shader = {
    vertexShader: "",
    fragmentShader: "vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;",
    uniforms: {},
  };
  material.onBeforeCompile(shader, undefined);
  assert.deepEqual(calls, ["model"], "the model's own step still runs, once");
  assert.match(shader.fragmentShader, /vec3 outgoingLight = min\( totalDiffuse, diffuseColor\.rgb \) \+ totalSpecular \+ totalEmissiveRadiance;/);
  assert.match(shader.fragmentShader, /model-step/);
  assert.equal(material.customProgramCacheKey(), "model-key|glue-light-clamp-v1", "its own program, applied once");
  // An unlit batch (MeshBasicMaterial) has no light sum to clamp.
  const basic = new THREE.MeshBasicMaterial();
  const before = basic.onBeforeCompile;
  clampGlueLighting(basic);
  assert.equal(basic.onBeforeCompile, before);
});

test("both glue builds clamp what they built: the backdrop, the figure and its worn items", () => {
  const stage = readFileSync(new URL("../src/browser/glue/GlueModelStage.ts", import.meta.url), "utf8");
  assert.match(stage, /view\.built = built;\s+for \(const material of built\.materials\) clampGlueLighting\(material\);/);
  const scene = readFileSync(new URL("../src/browser/glue/GlueCharacterScene.ts", import.meta.url), "utf8");
  assert.equal(scene.match(/for \(const material of built\.materials\) clampGlueLighting\(material\);/g)?.length, 2);
});

