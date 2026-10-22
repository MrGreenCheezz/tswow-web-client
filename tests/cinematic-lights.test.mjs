// 22.10 (7.36): the cinematic fixture light — wide warm pools, the selection fade, the WMO street
// lamps and the halos — on the high profile only; quality 0 stays the client's frame.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  CINEMATIC_POOL_PEAK, CINEMATIC_POOL_REACH, cinematicPoolFalloff, cinematicPoolNightWeight, localLightSelectionFade,
} from "../dist/code/browser/CinematicLights.js";
import { LocalLightSelection, m2LightFalloff, modelFixtureLights } from "../dist/code/browser/LocalLighting.js";
import { applyWorldLight, createWorldLightUniforms, WORLD_LIGHT_BODY } from "../dist/code/browser/WorldLighting.js";
import { lightingProfile } from "../dist/code/browser/LightingQuality.js";
import { fixtureLightSource } from "../dist/code/browser/FixtureLightSources.js";
import { sampleWmoLight, wmoOutdoorLights } from "../dist/code/browser/WmoFixtureLights.js";
import { LightHalos, lightHaloProfile, lightHaloWeight } from "../dist/code/browser/LightHalos.js";

const close = (a, b, epsilon = 1e-6) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const sample = () => ({ position: new THREE.Vector3(), colour: new THREE.Vector3(1, 0.6, 0.3), radius: 8, intensity: 1 });

test("the pool is flat at the lamp, reaches several yards and ends without an edge", () => {
  close(cinematicPoolFalloff(0, 18), CINEMATIC_POOL_PEAK);
  close(cinematicPoolFalloff(9, 18), CINEMATIC_POOL_PEAK * 0.5625);
  assert.equal(cinematicPoolFalloff(18, 18), 0);
  assert.equal(cinematicPoolFalloff(40, 18), 0);
  assert.ok(cinematicPoolFalloff(17.9, 18) < 1e-4, "no visible ring at the reach");
  assert.equal(cinematicPoolFalloff(5, 18, 0), 0, "strength 0 is no pool");
  assert.equal(cinematicPoolFalloff(Number.NaN, 18), 0);
  // The client's curve keeps the hot spot; the pool carries the light past it.
  assert.ok(m2LightFalloff(0.5) > cinematicPoolFalloff(0.5, 20), "near the source the client's light is the larger");
  for (const yards of [6, 8, 10, 12]) {
    assert.ok(cinematicPoolFalloff(yards, 20) > 2 * m2LightFalloff(yards), `the pool carries the light at ${yards} yd`);
  }
  assert.ok(CINEMATIC_POOL_REACH >= 16, "a heuristic lamp's pool spreads well past its old 6-8 yd");
  close(cinematicPoolNightWeight(0), 1);
  assert.ok(cinematicPoolNightWeight(1) < 0.2, "mostly a night term");
});

test("only the high profile, the enhanced preset's, turns the cinematic light on", () => {
  assert.equal(lightingProfile(0).cinematicLights, 0, "control profile is the client's light");
  assert.equal(lightingProfile(1).cinematicLights, 0);
  assert.equal(lightingProfile(3).cinematicLights, 0, "comparison level");
  assert.equal(lightingProfile(2).cinematicLights, 1);
  assert.equal(lightingProfile(2, { shadowMaps: false, maxTextureSize: 0 }).cinematicLights, 1, "no shadow pass needed");
  assert.equal(lightingProfile(0).localLights, 0, "quality 0 never reaches the fixture loop");
  assert.equal(createWorldLightUniforms().wowLocalLightPool.value, 0, "the uniform starts off");
});

test("the pool is one uniform-gated branch of the shared program, bound to every lit material", async () => {
  assert.ok(WORLD_LIGHT_BODY.includes("if ( wowLocalLightPool > 0.0 ) {"), "strength 0 skips the pool");
  assert.ok(WORLD_LIGHT_BODY.includes("wowLampTerm = max( wowLampTerm, wowPool );"), "max(client, pool): the hot spot stays");
  assert.ok(WORLD_LIGHT_BODY.includes("( wowLocalLightPool > 0.0 ? wowPoolReach : wowLampReach )"),
    "without the pool the reach test is the 6.17 one");
  const uniforms = createWorldLightUniforms();
  const material = new THREE.MeshStandardMaterial();
  applyWorldLight(material, uniforms, "surface");
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, {});
  assert.equal(shader.uniforms.wowLocalLightPool, uniforms.wowLocalLightPool, "shared, so a quality change compiles nothing");
  assert.match(shader.fragmentShader, /uniform float wowLocalLightPool;/);
  const key = material.customProgramCacheKey();
  uniforms.wowLocalLightPool.value = 1;
  assert.equal(material.customProgramCacheKey(), key, "the strength is not part of the program key");
  material.dispose();
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /this\.#worldLight\.wowLocalLightPool\.value = next\.cinematicLights;/);
});

test("a selected light fades out before the nearest-N set drops it, so swaps are continuous", () => {
  close(localLightSelectionFade(10, 20), 1);
  assert.equal(localLightSelectionFade(20, 20), 0);
  assert.equal(localLightSelectionFade(25, 20), 0);
  const selection = new LocalLightSelection();
  const uniforms = createWorldLightUniforms();
  const camera = new THREE.Vector3();
  const weights = (bx) => {
    selection.begin(1);
    selection.add({ ...sample(), position: new THREE.Vector3(10, 0, 0) }, camera);
    selection.add({ ...sample(), position: new THREE.Vector3(bx, 0, 0) }, camera);
    selection.write(uniforms, new THREE.Matrix4());
    return { x: uniforms.wowLocalLightPosition.value[0].x, w: uniforms.wowLocalLightColour.value[0].w };
  };
  // B walks in towards the camera past A: the one slot changes hands where both weigh nothing.
  const before = weights(10.2);
  const after = weights(9.8);
  assert.equal(before.x, 10);
  close(after.x, 9.8);
  assert.ok(before.w < 0.01 && after.w < 0.01, `no pop at the swap: ${before.w}, ${after.w}`);
  assert.ok(weights(2).w > 0.99, "a clear winner is at full strength");
  // The last light in range fades out towards the 64-yard range instead of switching off.
  selection.begin(4);
  selection.add({ ...sample(), position: new THREE.Vector3(63.5, 0, 0) }, camera);
  selection.write(uniforms, new THREE.Matrix4());
  assert.ok(uniforms.wowLocalLightColour.value[0].w < 0.05);
  // A ranked-down WMO lamp gives its slot to a fixture that is in fact a little farther.
  selection.begin(1);
  selection.add({ ...sample(), position: new THREE.Vector3(10, 0, 0) }, camera, 1.5);
  selection.add({ ...sample(), position: new THREE.Vector3(12, 0, 0) }, camera);
  selection.write(uniforms, new THREE.Matrix4());
  assert.equal(uniforms.wowLocalLightPosition.value[0].x, 12);
});

test("a building's outdoor lamps join only in the cinematic profile; rooms never do", () => {
  const facade = { id: -(10047 * 1_000_000 + 1), interior: false };
  assert.equal(fixtureLightSource(facade), false);
  assert.equal(fixtureLightSource(facade, true), true);
  assert.equal(fixtureLightSource({ ...facade, interior: true }, true), false);
  assert.equal(fixtureLightSource({ ...facade, localLight: [1, 2, 3, 4] }, true), false);
  assert.equal(fixtureLightSource({ id: 5 }), true);
});

test("a WMO's lamps outside its rooms become fixtures; a room's lamp and an interior-only WMO's do not", () => {
  const light = (x, colour = [255, 187, 99], intensity = 0.17) => ({
    position: [x, 0, 0], colour, intensity, attenuationStart: 1, attenuationEnd: 4.9, attenuates: true });
  const room = { indoor: true, exterior: false, flags: 0, triangleCount: 10,
    bounds: { minX: -5, maxX: 5, minY: -5, maxY: 5, minZ: -5, maxZ: 5 } };
  const street = { indoor: false, exterior: true, flags: 8, triangleCount: 10,
    bounds: { minX: -50, maxX: 50, minY: -50, maxY: 50, minZ: -50, maxZ: 50 } };
  const city = { groups: [room, street], lights: [light(0), light(20), light(30, [0, 0, 0]), light(40, [255, 0, 0], 0)] };
  const outdoor = wmoOutdoorLights(city);
  assert.deepEqual(outdoor.map((l) => l.position[0]), [20], "the room's lamp, a black and a dark record stay out");
  assert.equal(wmoOutdoorLights(city), outdoor, "cached per model");
  assert.deepEqual(wmoOutdoorLights({ groups: [room], lights: [light(20)] }), [], "an interior-only WMO gives none");
  const result = { position: new THREE.Vector3(), colour: new THREE.Vector3(), radius: 0, intensity: 0 };
  assert.equal(sampleWmoLight(outdoor[0], 1, 2, 3, result), true);
  close(result.colour.x, 1);
  close(result.colour.z, 99 / 255);
  assert.equal(result.client, false);
  assert.equal(result.halo, false, "a record's place is only roughly its lamp's: no halo");
  assert.ok(result.radius >= 6 && result.radius <= 12);
});

test("halos: soft profile, night and distance weighted, one program, bounded instances", () => {
  assert.ok(lightHaloProfile(0) > 0.9);
  assert.equal(lightHaloProfile(1), 0);
  assert.ok(lightHaloProfile(0.95) < 0.01, "no edge");
  assert.ok(lightHaloWeight(0, 10) > 0.99);
  assert.ok(lightHaloWeight(1, 10) < 0.1, "by day a lantern hardly glows");
  assert.equal(lightHaloWeight(0, 64), 0);
  const halos = new LightHalos();
  const material = halos.mesh.material;
  const camera = new THREE.Vector3();
  halos.begin();
  for (let index = 0; index < 40; index++) {
    halos.add(new THREE.Vector3(index, 0, 0), new THREE.Vector3(1, 0.6, 0.3), 1, 0, camera);
  }
  halos.end();
  assert.ok(halos.mesh.count > 0 && halos.mesh.count <= halos.mesh.instanceMatrix.count, "bounded by the light budget");
  halos.begin();
  halos.add(new THREE.Vector3(100, 0, 0), new THREE.Vector3(1, 1, 1), 1, 0, camera);
  halos.end();
  assert.equal(halos.mesh.count, 0, "past the fade nothing is drawn");
  assert.equal(halos.mesh.material, material, "the same material: no program is built while playing");
  assert.equal(halos.mesh.visible, true, "kept visible at zero instances, so its program compiles at the first frame");
  halos.dispose();
});

test("a Stormwind street lamp's unlit glass pane is its light; an unlit opaque mesh elsewhere is not", () => {
  const lamp = (texture) => ({
    positions: new Float32Array([0, 0, 0, 0, 0, 4, 1, 0, 4, 0, 1, 4]),
    indices: new Uint16Array([0, 1, 2, 1, 2, 3]),
    submeshes: [{ indexStart: 0, indexCount: 3 }, { indexStart: 3, indexCount: 3 }],
    batches: [
      { submesh: 0, materialFlags: 0, blendMode: 0, textures: [0], colorIndex: 65535, textureWeight: 0 },
      { submesh: 1, materialFlags: 1, blendMode: 0, textures: [1], colorIndex: 65535, textureWeight: 0 },
    ],
    textures: [{ path: "World\Generic\Human\Passive Doodads\Lamps\StreetLamp.blp" }, { path: texture }],
    particleEmitters: [], colours: [], textureWeights: [], globalSequences: new Uint32Array(),
  });
  const name = "World\Generic\Human\Passive Doodads\Lamps\StormwindStreetLamp01.m2";
  const lights = modelFixtureLights(lamp("Dungeons\Textures\Doodads\StormwindLampGlass.blp"), name);
  assert.equal(lights.length, 1);
  close(lights[0].position[2], 4);
  assert.equal(modelFixtureLights(lamp("Dungeons\Textures\Doodads\StormwindWood.blp"), name).length, 0);
});
