// 25.10 (6.27 indoors): the lamps (living spells, fixtures) on the surfaces that do not take the world
// light — a WMO room's inside (MeshBasic × MOCV) and a room doodad lit by its MODD colour — and the
// world light's own lamps while the room light replaces the sky's (no daylight, no shared ceiling).
// The faithful levels must keep their programs and keys exactly: the term is compiled in only while
// lamps light anything (`indoorLampsWanted`).
// What this does NOT prove: that a driver links the programs — the lookdev stills do (bench/lookdev.mjs).

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "three";

import {
  INDOOR_LAMPS_KEY, applyIndoorLampsToRoom, indoorLampsDrawing, indoorLampsWanted, setIndoorLampsEnabled,
} from "../dist/code/browser/IndoorLamps.js";
import { CINEMATIC_POOL_GLSL } from "../dist/code/browser/CinematicLights.js";
import { LIGHT_LAMPS_GLSL, LIGHT_POOL_LAMP_GLSL } from "../dist/code/browser/LightPoolGlsl.js";
import { lightingProfile } from "../dist/code/browser/LightingQuality.js";
import { createModelPlacementLocalLightMaterials } from "../dist/code/browser/ModelPlacementTint.js";
import {
  WORLD_LIGHT_BODY, WORLD_LIGHT_PARS, createWorldLightUniforms, setWorldLightIndoor, setWorldLightUniforms,
} from "../dist/code/browser/WorldLighting.js";
import { applyWmoInteriorFog } from "../dist/code/browser/WorldRenderer3D.js";

const ROOM_FOG = { colour: { value: new THREE.Color() }, near: { value: 0 }, far: { value: 1 } };

function compile(material, lib) {
  const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  return shader;
}

function room(uniforms) {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true });
  applyWmoInteriorFog(material, ROOM_FOG);
  const before = material.customProgramCacheKey();
  applyIndoorLampsToRoom(material, uniforms);
  return { material, before };
}

test("only the enhanced levels with a lamp budget compile the term", () => {
  const shadows = { shadowMaps: true, maxTextureSize: 16384 };
  assert.equal(indoorLampsWanted(lightingProfile(0, shadows)), false, "classic");
  assert.equal(indoorLampsWanted(lightingProfile(3, shadows)), false, "the comparison level");
  assert.equal(indoorLampsWanted(lightingProfile(1, shadows)), true);
  assert.equal(indoorLampsWanted(lightingProfile(2, shadows)), true);
});

test("a room run's program and key are untouched while lamps are off", () => {
  const uniforms = createWorldLightUniforms();
  const { material, before } = room(uniforms);
  const plain = new THREE.MeshBasicMaterial({ vertexColors: true });
  applyWmoInteriorFog(plain, ROOM_FOG);
  assert.equal(material.customProgramCacheKey(), before);
  const off = compile(material, THREE.ShaderLib.basic);
  const reference = compile(plain, THREE.ShaderLib.basic);
  assert.equal(off.fragmentShader, reference.fragmentShader);
  assert.equal(off.vertexShader, reference.vertexShader);
  assert.equal(indoorLampsDrawing(material), false);
});

test("a room run takes the forward lamps over its MOCV once lamps are on, and gives them back", () => {
  const uniforms = createWorldLightUniforms();
  const { material, before } = room(uniforms);
  const version = material.version;
  assert.equal(setIndoorLampsEnabled(uniforms, true), 1);
  assert.ok(material.version > version, "re-keyed once");
  assert.equal(material.customProgramCacheKey(), `${before}|${INDOOR_LAMPS_KEY}`);
  const on = compile(material, THREE.ShaderLib.basic);
  assert.ok(on.fragmentShader.includes(LIGHT_LAMPS_GLSL) && on.fragmentShader.includes(LIGHT_POOL_LAMP_GLSL));
  assert.ok(on.fragmentShader.includes(WORLD_LIGHT_PARS));
  assert.match(on.fragmentShader, /vec3 wowLampAlbedo = diffuseColor\.rgb;\n#include <color_fragment>/, "albedo before the MOCV");
  assert.match(on.fragmentShader,
    /vec3 outgoingLight = reflectedLight\.indirectDiffuse;[\s\S]*lightLamps\( wowLampNormal, vWowLampView \)[\s\S]*outgoingLight \+= wowLampAlbedo \* lightLampsOver\( wowRoomBase, wowRoomLamps \);[\s\S]*#include <opaque_fragment>/);
  assert.match(on.fragmentShader, /wowRoomBase = pow\( max\( vColor\.rgb, vec3\( 0\.0 \) \), vec3\( 1\.0 \/ 2\.2 \) \)/);
  assert.match(on.vertexShader, /#include <project_vertex>\s+vWowLampView = - mvPosition\.xyz;/);
  assert.match(on.vertexShader, /vWowLampNormal = normalMatrix \* wowLampObjectNormal;/);
  for (const name of ["wowLocalLightCount", "wowLocalLightPosition", "wowLocalLightColour", "wowLocalLightPool",
    "wowImmersiveStrength", "wowDaylight", "wowLampIndoor", "wowAmbient", "wowHighSunKey"]) {
    assert.equal(on.uniforms[name], uniforms[name], name);
  }
  // The room's fog still runs after the lamps.
  assert.ok(on.fragmentShader.indexOf("outgoingLight += wowLampAlbedo") < on.fragmentShader.indexOf("wowWmoFogFactor"));
  assert.equal(indoorLampsDrawing(material), true);
  assert.equal(setIndoorLampsEnabled(uniforms, false), 1);
  assert.equal(material.customProgramCacheKey(), before);
  assert.ok(!compile(material, THREE.ShaderLib.basic).fragmentShader.includes("lightLamps"));
  material.dispose();
  assert.equal(setIndoorLampsEnabled(uniforms, true), 0, "a disposed material is no longer tracked");
});

test("the lamp loop on rooms is the forward fixture body, cinematic pool included", () => {
  assert.ok(LIGHT_POOL_LAMP_GLSL.includes(CINEMATIC_POOL_GLSL));
  assert.match(LIGHT_LAMPS_GLSL, /lightPoolLamp\( wowLocalLightPosition\[ wowLightIndex \], wowLampColour\.rgb \* wowLampColour\.w,/);
  assert.match(LIGHT_LAMPS_GLSL, /if \( wowImmersiveStrength <= 0\.0001 \|\| wowLocalLightCount <= 0 \) return wowLamps;/);
});

test("a room doodad takes the lamps over its MODD light only when bound and on", () => {
  const uniforms = createWorldLightUniforms();
  const source = new THREE.MeshStandardMaterial();
  const [lit] = createModelPlacementLocalLightMaterials([source], [180, 120, 90, 255], uniforms);
  const [plain] = createModelPlacementLocalLightMaterials([source], [180, 120, 90, 255]);
  assert.equal(lit.customProgramCacheKey(), plain.customProgramCacheKey());
  assert.equal(compile(lit, THREE.ShaderLib.standard).fragmentShader, compile(plain, THREE.ShaderLib.standard).fragmentShader);
  setIndoorLampsEnabled(uniforms, true);
  assert.equal(lit.customProgramCacheKey(), `${plain.customProgramCacheKey()}|${INDOOR_LAMPS_KEY}`);
  const on = compile(lit, THREE.ShaderLib.standard);
  assert.match(on.fragmentShader,
    /reflectedLight\.directDiffuse = diffuseColor\.rgb \* pow\( modelPlacementAuthoredLight, vec3\( 2\.2 \) \);\s+\/\/ 25\.10[^\n]*\n\s+reflectedLight\.directDiffuse \+= diffuseColor\.rgb\s+\* lightLampsOver\( modelPlacementAuthoredLight, lightLamps\( normalize\( normal \), vViewPosition \) \);/);
  assert.equal(on.uniforms.wowLocalLightPosition, uniforms.wowLocalLightPosition);
  assert.ok(!compile(plain, THREE.ShaderLib.standard).fragmentShader.includes("lightLamps"));
});

test("in a sunless room lamps weigh no daylight and are not clipped by the room's ceiling", () => {
  const uniforms = createWorldLightUniforms();
  setWorldLightUniforms(uniforms, { r: 0.5, g: 0.5, b: 0.5 }, { r: 0.5, g: 0.5, b: 0.5 });
  assert.equal(uniforms.wowLampIndoor.value, 0);
  setWorldLightIndoor(uniforms, [0.4, 0.3, 0.2], [0, 1, 0]);
  assert.equal(uniforms.wowLampIndoor.value, 1);
  setWorldLightUniforms(uniforms, { r: 0.5, g: 0.5, b: 0.5 }, { r: 0.5, g: 0.5, b: 0.5 });
  assert.equal(uniforms.wowLampIndoor.value, 0, "the next sky sample takes it back");
  assert.match(WORLD_LIGHT_BODY, /float wowLampDaylight = wowDaylight \* \( 1\.0 - wowLampIndoor \);/);
  assert.match(WORLD_LIGHT_BODY, /\* \( 0\.35 \+ 0\.65 \* \( 1\.0 - wowLampDaylight \) \)/);
  assert.ok(!/\( 1\.0 - wowDaylight \)/.test(WORLD_LIGHT_BODY), "no lamp term reads the sky's daylight directly");
  assert.match(CINEMATIC_POOL_GLSL, /\( 1\.0 - wowLampDaylight \)/);
  assert.match(WORLD_LIGHT_BODY, /wowLampLight \+= wowLampColour\.rgb \* wowLampTint/);
  assert.match(LIGHT_POOL_LAMP_GLSL, /float wowLampDaylight = wowDaylight \* \( 1\.0 - wowLampIndoor \);/);
});

test("the renderer binds rooms and doodads to the world light and follows the lighting level", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /if \(interior && run\.blendMode <= 1\) applyIndoorLampsToRoom\(value, this\.#worldLight\);/);
  // Before the relief, which wraps whatever hooks it finds.
  assert.ok(source.indexOf("applyIndoorLampsToRoom(value, this.#worldLight)") < source.indexOf("trackWmoReliefMaterial(value, url, relief)"));
  assert.match(source, /setIndoorLampsEnabled\(this\.#worldLight, indoorLampsWanted\(next\)\);/);
  assert.equal(source.split("createModelPlacementLocalLightMaterials(built.materials, ").length - 1, 2);
  assert.equal((source.match(/createModelPlacementLocalLightMaterials\(built\.materials, [^)]*this\.#worldLight\)/g) ?? []).length, 2);
  assert.match(source, /createInstancedModelPlacementLocalLightMaterials\(built\.materials, this\.#worldLight\)/);
});
