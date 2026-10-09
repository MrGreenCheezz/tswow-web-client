// 05.10-7.20: the «сравнение» lighting level — the classic, authored frame plus quality 1's shadow pass.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  LIGHTING_QUALITY_COMPARISON, lightingClassicLook, lightingProfile, normaliseLightingQuality,
} from "../dist/code/browser/LightingQuality.js";
import { terrainBakedShadowStrength, terrainSpecularStrength } from "../dist/code/browser/TerrainSplat.js";
import { horizonColourWanted } from "../dist/code/browser/Horizon.js";
import { HorizonMaterialSelector } from "../dist/code/browser/HorizonMaterial.js";
import { createWorldLightUniforms } from "../dist/code/browser/WorldLighting.js";
import { defaultSettings, parseSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";

const SHADOW_FIELDS = [
  "shadowMapSize", "shadowCasters", "shadowExtent", "shadowIntensity", "shadowRadius", "shadowCascades",
  "shadowDistance", "shadowFadeStart", "shadowFarMapSize", "shadowFarRefreshFrames",
];

test("7.20 comparison level: quality 1's shadow pass, quality 0's authored light", () => {
  assert.equal(LIGHTING_QUALITY_COMPARISON, 3);
  const capabilities = { shadowMaps: true, maxTextureSize: 16384 };
  const comparison = lightingProfile(3, capabilities);
  const balanced = lightingProfile(1, capabilities);
  const classic = lightingProfile(0, capabilities);
  assert.equal(comparison.quality, 3);
  for (const field of SHADOW_FIELDS) assert.equal(comparison[field], balanced[field], field);
  assert.deepEqual(comparison.shadowCascadeSplits, balanced.shadowCascadeSplits);
  assert.ok(comparison.shadowMapSize > 0, "the comparison frame has real-time shadows (extShadowQuality 5)");
  for (const field of ["exposure", "immersiveStrength", "localLights", "godRayStrength"]) {
    assert.equal(comparison[field], classic[field], `${field} is the classic value`);
  }
  assert.equal(comparison.immersiveStrength, 0, "no grade");
  assert.equal(comparison.localLights, 0, "no fixture pools");
  assert.equal(comparison.godRayStrength, 0, "no shafts");
});

test("7.20 comparison level degrades only its shadow pass", () => {
  const none = lightingProfile(3, { shadowMaps: false, maxTextureSize: 16384 });
  assert.equal(none.quality, 3);
  assert.equal(none.shadowMapSize, 0);
  assert.equal(none.shadowCascades, 0);
  assert.equal(none.immersiveStrength, 0);
  const small = lightingProfile(3, { shadowMaps: true, maxTextureSize: 512 });
  assert.equal(small.shadowMapSize, 512);
  assert.equal(small.shadowCasters, lightingProfile(1, { shadowMaps: true, maxTextureSize: 512 }).shadowCasters);
});

test("7.20 the classic look covers quality 0 and the comparison level only", () => {
  assert.equal(lightingClassicLook(0), true);
  assert.equal(lightingClassicLook(3), true);
  assert.equal(lightingClassicLook(1), false);
  assert.equal(lightingClassicLook(2), false);
  assert.equal(normaliseLightingQuality(3), 3);
  assert.equal(normaliseLightingQuality("3"), 3);
  assert.equal(normaliseLightingQuality(99), 3);
  assert.equal(normaliseLightingQuality(-1), 0);
  // Every classic-path feature follows the classic look.
  assert.equal(terrainBakedShadowStrength(3), 1, "MCSH at full strength");
  assert.equal(terrainBakedShadowStrength(1), 0);
  assert.equal(terrainSpecularStrength(3), 1, "specular strength; the render switch decides whether it is drawn");
  assert.equal(terrainSpecularStrength(2), 0);
  assert.equal(horizonColourWanted(3, true), true, "lit, coloured horizon");
  assert.equal(horizonColourWanted(3, false), false);
  assert.equal(horizonColourWanted(1, true), false);
});

test("7.20 the horizon selector draws the lit horizon on the comparison level", () => {
  const basic = new THREE.MeshBasicMaterial();
  const selector = new HorizonMaterialSelector(basic, createWorldLightUniforms());
  const texture = new THREE.Texture();
  assert.equal(selector.select(3, () => texture).name, "horizon-lit");
  assert.equal(selector.select(1, () => texture) === basic, true);
  selector.dispose();
  basic.dispose();
});

test("7.20 the renderer's classic branches read the classic look, not quality 0", async () => {
  const world = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.equal(world.includes("this.#lightingProfile.quality === 0"), false,
    "no renderer branch singles out quality 0 any more");
  const uses = world.split("lightingClassicLook(this.#lightingProfile.quality)").length - 1;
  assert.equal(uses, 3, "key light, cinematic override and visible sun");
  const cinematic = world.slice(world.indexOf("  #applyCinematicProfile(): void {"));
  assert.match(cinematic.slice(0, 400),
    /const profile = lightingClassicLook\(this\.#lightingProfile\.quality\) \? undefined : this\.#cinematicRequested;/,
    "the comparison level never takes the cinematic grade");
});

test("7.20 lighting quality setting offers the comparison level without changing the default", () => {
  const definition = settingDefinition("lightingQuality");
  assert.ok(definition);
  assert.equal(definition.min, 0);
  assert.equal(definition.max, 3);
  assert.equal(definition.fallback, 1);
  assert.match(definition.hint ?? "", /3 — сравнение/);
  assert.equal(defaultSettings().lightingQuality, 1);
  assert.equal(parseSettings('{"lightingQuality":3}')?.lightingQuality, 3);
  assert.equal(parseSettings('{"lightingQuality":2}')?.lightingQuality, 2, "a saved 2 stays 2");
});

// 05.10 review 7.20: the client's terrain fragment programs (Shaders/Pixel/arbfp1/terrain2.bls and
// terrain2_pcf.bls, read 05.10, .runtime/re-2026-10-05/7.20-review/probe-pcf.out.txt) fold the dynamic
// shadow into the baked one — lit = min(MCSH, faded PCF) — and apply it to the albedo only
// (0.3 · lit + 0.7) and the specular, never to the vertex-lit sun. Wherever the baked term is drawn
// (the classic look; with the shadow pass, level 3) the terrain does the same.
async function terrainProgram(shadows) {
  const { applyTerrainSplat } = await import("../dist/code/browser/TerrainSplat.js");
  const { applyWorldLight } = await import("../dist/code/browser/WorldLighting.js");
  const { preprocess, resolveIncludes } = await import("./glsl-static-check.mjs");
  const material = new THREE.MeshLambertMaterial();
  applyWorldLight(material, createWorldLightUniforms(), "terrain");
  applyTerrainSplat(material, {
    layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1), alpha: new THREE.Texture(), index: new THREE.Texture(),
  });
  const lib = THREE.ShaderLib.lambert;
  const shader = { uniforms: {}, defines: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
  material.onBeforeCompile(shader, {});
  const defines = { USE_FOG: "", NUM_DIR_LIGHTS: "1", NUM_DIR_LIGHT_SHADOWS: shadows ? "3" : "0" };
  if (shadows) defines.USE_SHADOWMAP = "";
  const prefix = "uniform mat4 viewMatrix; uniform vec3 cameraPosition; uniform bool isOrthographic; uniform bool receiveShadow;\n";
  return preprocess(resolveIncludes(prefix + shader.fragmentShader), defines);
}

test("05.10 review 7.20: with the baked term on, terrain takes min(MCSH, dynamic) on the albedo, not the sun", async () => {
  const lines = await terrainProgram(true);
  const text = lines.join("\n");
  const start = text.indexOf("if ( splatBakedShadow > 0.0 ) {");
  assert.ok(start > 0, "the classic-look fold is in the shadowed terrain program");
  const block = text.slice(start, text.indexOf("}", start) + 1);
  assert.ok(text.indexOf("wowShadow = mix( 1.0, wowShadow, smoothstep( 0.05, 0.25, abs( wowDot ) ) );") < start,
    "after the cascades and the slope fade");
  assert.ok(start < text.indexOf("vec3 wowAuthoredLight ="), "before the sun term reads the shadow");
  assert.match(block, /float splatDynamicLit = clamp\( 1\.0 - \( 1\.0 - wowShadow \) \/ max\( directionalLightShadows\[ 0 \]\.shadowIntensity, 0\.0001 \), 0\.0, 1\.0 \);/,
    "the dynamic term at full strength (the client's PCF has no intensity)");
  assert.match(block, /float splatShadowLit = min\( splatBakedLit, splatDynamicLit \);/);
  assert.match(block, /diffuseColor\.rgb \*= \( 0\.7 \+ 0\.3 \* splatShadowLit \) \/ \( 0\.7 \+ 0\.3 \* splatBakedLit \);/);
  assert.match(block, /splatBakedLit = splatShadowLit;/, "the specular takes the same lit");
  assert.match(block, /wowShadow = 1\.0;/, "the sun term is not shadowed on top");
  // Typed as GLSL ES 3.00 against what is declared before it.
  const { declarations, typeCheck } = await import("./glsl-static-check.mjs");
  const variables = declarations(text.slice(0, start));
  variables.set("diffuseColor", "vec4");
  const typed = typeCheck(block.split("\n").slice(1, -1), variables, (expression) => /\[/.test(expression));
  assert.deepEqual(typed.problems, []);
  assert.ok(typed.checked >= 4, `only ${typed.checked} statements typed`);
});

test("05.10 review 7.20: without a shadow map the terrain program has no fold", async () => {
  const text = (await terrainProgram(false)).join("\n");
  assert.equal(text.includes("splatDynamicLit"), false);
  assert.ok(text.includes("diffuseColor.rgb *= 0.7 + 0.3 * splatBakedLit;"), "the baked term as before");
});
