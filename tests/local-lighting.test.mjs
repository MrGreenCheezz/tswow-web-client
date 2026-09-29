import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import ts from "typescript";
import {
  LocalLightSelection, localLightFalloff, modelFixtureLights, sampleFixtureLight,
} from "../dist/code/browser/LocalLighting.js";
import { applyWorldLight, createWorldLightUniforms, setWorldLightDaylight } from "../dist/code/browser/WorldLighting.js";
import { lightingProfile } from "../dist/code/browser/LightingQuality.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const lampName = "World\\Generic\\Human\\Passive Doodads\\Lampposts\\DuskwoodLamppost.m2";
const constant = (value) => ({ interpolation: 0, globalSequence: -1, components: 1,
  tracks: [{ sequence: 0, times: new Uint32Array([0]), values: new Float32Array([value]) }] });
const ramp = (values) => ({ components: values.length, times: new Float32Array([0]), values: new Float32Array(values) });
function lampModel() {
  return {
    // A pole extending well below the ground and a glow card at z=3. Only glow geometry is a source.
    positions: new Float32Array([0, 0, -15, 0, 0, 5, 1, 0, 5, -1, 0, 2, 1, 0, 2, 1, 0, 4, -1, 0, 4]),
    indices: new Uint16Array([0, 1, 2, 3, 4, 5, 3, 5, 6]),
    submeshes: [{ indexStart: 0, indexCount: 3 }, { indexStart: 3, indexCount: 6 }],
    batches: [
      { submesh: 0, materialFlags: 0, blendMode: 0, textures: [0], colorIndex: 65535, textureWeight: 0 },
      { submesh: 1, materialFlags: 19, blendMode: 4, textures: [1], colorIndex: 65535, textureWeight: 0 },
    ],
    textures: [{ path: "Wood.blp" }, { path: "Glow32.blp" }],
    particleEmitters: [], colours: [], textureWeights: [constant(1)], globalSequences: new Uint32Array(),
  };
}
function sample() { return { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 }; }

test("fixture sources follow the existing glow, never the lamp post's bounding centre", () => {
  const model = lampModel();
  const lights = modelFixtureLights(model, lampName);
  assert.equal(lights.length, 1);
  assert.deepEqual(lights[0].position, [0, 0, 3]);
  assert.equal(modelFixtureLights(model, lampName), lights, "geometry inspection is cached");
  assert.equal(modelFixtureLights(model, "Creature\\Dragon\\Dragon.m2").length, 0);
  for (const suffix of ["_unlit", "_broken", "_nolight", "-off", "01off"]) {
    assert.equal(modelFixtureLights(model, `World\\Lamp${suffix}.m2`).length, 0, suffix);
  }
  const noGlow = lampModel();
  noGlow.batches.pop();
  assert.equal(modelFixtureLights(noGlow, lampName).length, 0, "a lamp name alone cannot invent a light");
});

test("lamp sampling applies placement/bone matrices, scale and authored visibility", () => {
  const model = lampModel();
  const fixture = modelFixtureLights(model, lampName)[0];
  const result = sample();
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(10, 20, 30),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
    new THREE.Vector3(0.5, 0.5, 0.5));
  assert.equal(sampleFixtureLight(fixture, model, matrix, 0, 1000, result), true);
  close(result.position.x, 10);
  close(result.position.y, 21.5);
  close(result.position.z, 30);
  close(result.radius, 4);
  assert.ok(result.intensity > 0.94 && result.intensity <= 1.1);
  assert.ok(result.colour.x > result.colour.y && result.colour.y > result.colour.z);
  model.textureWeights[0] = constant(0);
  assert.equal(sampleFixtureLight(fixture, model, matrix, 0, 1000, result), false);
});

test("blue lamps retain their colour and inactive particle flames cast no light", () => {
  const blue = lampModel();
  blue.textures[1].path = "BlueGlow.blp";
  const fixture = modelFixtureLights(blue, lampName)[0];
  assert.ok(fixture.colour[2] > fixture.colour[0]);

  const fire = lampModel();
  fire.batches = [];
  fire.textures[1].path = "FireFlame.blp";
  fire.particleEmitters = [{ texture: 1, bone: 0, position: [0, 0, 1],
    enabledIn: constant(1), emissionRate: constant(10), color: ramp([0.1, 1, 0.2]), opacity: ramp([1]) }];
  const flame = modelFixtureLights(fire, "World\\Campfire.m2")[0];
  const result = sample();
  assert.equal(sampleFixtureLight(flame, fire, new THREE.Matrix4(), 0, 0, result), true);
  assert.ok(result.colour.y > result.colour.x, "green authored fire is not repainted orange");
  fire.particleEmitters[0].enabledIn = constant(0);
  assert.equal(sampleFixtureLight(flame, fire, new THREE.Matrix4(), 0, 0, result), false);
  fire.particleEmitters[0].enabledIn = constant(1);
  fire.particleEmitters[0].emissionRate = constant(0);
  assert.equal(sampleFixtureLight(flame, fire, new THREE.Matrix4(), 0, 0, result), false);
});

test("nearest light selection is bounded, transforms into camera space and clears between maps", () => {
  const selection = new LocalLightSelection();
  const uniforms = createWorldLightUniforms();
  const camera = new THREE.Vector3();
  selection.begin(4);
  for (const x of [9, 2, 4, 100, 3, 1, 8]) {
    selection.add({ position: new THREE.Vector3(x, 2, 0), colour: new THREE.Vector3(1, 0.6, 0.3), radius: 8, intensity: 0.7 }, camera);
  }
  const positions = uniforms.wowLocalLightPosition.value;
  selection.write(uniforms, new THREE.Matrix4().makeTranslation(-10, 0, 0));
  assert.equal(uniforms.wowLocalLightCount.value, 4);
  assert.deepEqual(positions.slice(0, 4).map((p) => p.x), [-9, -8, -7, -6]);
  assert.deepEqual(positions.slice(0, 4).map((p) => p.w), [8, 8, 8, 8], "radius is not translated by the view matrix");
  selection.begin(0);
  selection.add({ ...sample(), radius: 8, intensity: 1 }, camera);
  selection.write(uniforms, new THREE.Matrix4());
  assert.equal(uniforms.wowLocalLightCount.value, 0);
  assert.equal(uniforms.wowLocalLightPosition.value, positions, "uniform storage survives toggling");
  assert.equal(lightingProfile(0).localLights, 0);
  assert.equal(lightingProfile(1).localLights, 4);
  assert.equal(lightingProfile(2, { shadowMaps: false, maxTextureSize: 0 }).localLights, 8);
});

test("local light has a soft finite radius in every production lit material", () => {
  assert.equal(localLightFalloff(0, 8), 1);
  assert.equal(localLightFalloff(8, 8), 0);
  assert.equal(localLightFalloff(100, 8), 0);
  assert.equal(localLightFalloff(1, 0), 0);
  close(localLightFalloff(4, 8), 0.5);
  assert.ok(localLightFalloff(7.99, 8) < 0.001, "the pool reaches zero smoothly instead of a visible hard circle");
  const uniforms = createWorldLightUniforms();
  for (const [material, source] of [[new THREE.MeshLambertMaterial(), THREE.ShaderLib.lambert],
    [new THREE.MeshStandardMaterial(), THREE.ShaderLib.standard]]) {
    applyWorldLight(material, uniforms, "surface");
    const shader = { uniforms: {}, vertexShader: source.vertexShader, fragmentShader: source.fragmentShader };
    material.onBeforeCompile(shader, {});
    assert.equal(shader.uniforms.wowLocalLightPosition, uniforms.wowLocalLightPosition);
    assert.equal(shader.uniforms.wowLocalLightColour, uniforms.wowLocalLightColour);
    assert.equal(shader.uniforms.wowLocalLightCount, uniforms.wowLocalLightCount);
    assert.match(shader.fragmentShader, /wowLamp\.xyz \+ vViewPosition/);
    assert.match(shader.fragmentShader, /wowLightIndex >= wowLocalLightCount/);
    material.dispose();
  }
});

test("lamp daylight weighting follows the true sun elevation continuously, not the night key", () => {
  const uniforms = createWorldLightUniforms();
  const daylight = uniforms.wowDaylight;
  assert.equal(setWorldLightDaylight(uniforms, -1), 0);
  assert.equal(setWorldLightDaylight(uniforms, -0.1), 0);
  const dusk = setWorldLightDaylight(uniforms, 0);
  assert.ok(dusk > 0 && dusk < 0.5);
  assert.equal(setWorldLightDaylight(uniforms, 1), 1);
  assert.equal(setWorldLightDaylight(uniforms, Number.NaN), 1);
  assert.equal(uniforms.wowDaylight, daylight);
});

test("production fixture pass keeps instanced offscreen lamps, skips interiors and culls before bone work", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("WorldRenderer3D.ts", source, ts.ScriptTarget.ES2022, true);
  const renderer = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "WorldRenderer3D");
  const method = renderer.members.find(node => node.name?.getText(parsed) === "#updateFixtureLights");
  const js = ts.transpileModule(`class Harness { ${method.getText(parsed).replaceAll("#", "")} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const Harness = Function("modelFixtureLights", "sampleFixtureLight", js + ";return Harness;")(
    modelFixtureLights, sampleFixtureLight);
  const harness = new Harness();
  const model = lampModel();
  const placement = new THREE.Group();
  placement.position.set(2, 0, 0);
  placement.visible = false;
  const matrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(placement.position);
  const retained = { node: placement, admitted: false, source: { name: lampName }, wvm: model, instanceMatrix: matrix };
  const farPlacement = new THREE.Group();
  farPlacement.position.set(1000, 0, 0);
  const expensive = new THREE.Group();
  expensive.updateWorldMatrix = () => { throw new Error("distant fixture propagated its pose"); };
  const far = { node: farPlacement, source: { name: lampName }, wvm: model, skinned: { root: expensive } };
  Object.assign(harness, {
    localLightSelection: new LocalLightSelection(), localLightSample: sample(), localLightMatrix: new THREE.Matrix4(),
    lightingProfile: lightingProfile(1), worldLight: createWorldLightUniforms(), camera: new THREE.PerspectiveCamera(),
    environment: new Map([[1, retained], [2, { ...retained, interior: true }], [3, far]]), gameObjects: new Map(),
  });
  harness.updateFixtureLights(1000);
  assert.equal(harness.worldLight.wowLocalLightCount.value, 1, "instancing and frustum hiding must not extinguish an outdoor lamp");
  close(harness.worldLight.wowLocalLightPosition.value[0].x, 2);
  close(harness.worldLight.wowLocalLightPosition.value[0].y, 3);
  harness.environment.clear();
  harness.updateFixtureLights(1100);
  assert.equal(harness.worldLight.wowLocalLightCount.value, 0, "unloaded lamps leave no stale light");

  const rigModel = lampModel();
  rigModel.boneIndices = new Uint8Array(7 * 4);
  rigModel.boneWeights = new Float32Array(7 * 4);
  for (let vertex = 3; vertex <= 6; vertex++) {
    rigModel.boneIndices[vertex * 4] = 4;
    rigModel.boneWeights[vertex * 4] = 1;
  }
  const rigPlacement = new THREE.Group();
  rigPlacement.position.x = 10;
  const rigRoot = new THREE.Group();
  rigRoot.rotation.x = -Math.PI / 2;
  rigPlacement.add(rigRoot);
  const lampBone = new THREE.Bone();
  lampBone.position.x = 2;
  rigRoot.add(lampBone);
  const bones = Array(5), inverses = Array(5);
  bones[4] = lampBone; inverses[4] = new THREE.Matrix4();
  harness.environment.set(5, { node: rigPlacement, source: { name: lampName }, wvm: rigModel,
    skinned: { root: rigRoot, mixer: { time: 0.25 }, skeleton: { bones } }, template: { boneInverses: inverses } });
  harness.updateFixtureLights(1150);
  close(harness.worldLight.wowLocalLightPosition.value[0].x, 12);
  close(harness.worldLight.wowLocalLightPosition.value[0].y, 3);
  harness.environment.clear();

  const objectNode = new THREE.Group();
  const visual = new THREE.Group();
  visual.rotation.x = -Math.PI / 2;
  objectNode.add(visual);
  harness.gameObjects.set(1n, { node: objectNode, visual, wvm: model, model: lampName });
  harness.updateFixtureLights(1200);
  assert.equal(harness.worldLight.wowLocalLightCount.value, 1);
  objectNode.visible = false;
  harness.updateFixtureLights(1300);
  assert.equal(harness.worldLight.wowLocalLightCount.value, 0, "hidden server objects cannot leave a light behind");
  objectNode.visible = true;
  harness.lightingProfile = lightingProfile(0);
  harness.updateFixtureLights(1400);
  assert.equal(harness.worldLight.wowLocalLightCount.value, 0);
});
