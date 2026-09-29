import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
  WORLD_LIGHT_BODY, WORLD_LIGHT_TARGET, applyLightHeadroom, applyWorldLight,
  cloneMaterialForPortrait, createWorldLightUniforms, setWorldLightImmersiveStrength,
  setWorldLightUniforms, worldLightFactor,
} from "../dist/code/browser/WorldLighting.js";
import { applyTerrainSplat } from "../dist/code/browser/TerrainSplat.js";
import { toneShoulder } from "../dist/code/browser/LightingQuality.js";

const close = (actual, expected, epsilon = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
};

test("headroom scales ambient and diffuse together and only when their sum clips", () => {
  const ambient = { r: 0.663, g: 0.878, b: 1 };
  const diffuse = { r: 0.510, g: 0.282, b: 0.490 };
  const result = applyLightHeadroom(ambient, diffuse);
  const before = {
    r: ambient.r + diffuse.r,
    g: ambient.g + diffuse.g,
    b: ambient.b + diffuse.b,
  };
  const after = {
    r: result.ambient.r + result.diffuse.r,
    g: result.ambient.g + result.diffuse.g,
    b: result.ambient.b + result.diffuse.b,
  };
  close(Math.max(after.r, after.g, after.b), 1);
  close(after.r / after.g, before.r / before.g);
  close(result.diffuse.g / result.ambient.g, diffuse.g / ambient.g);

  const inside = applyLightHeadroom({ r: 0.2, g: 0.3, b: 0.4 }, { r: 0.3, g: 0.2, b: 0.1 });
  assert.deepEqual(inside, {
    ambient: { r: 0.2, g: 0.3, b: 0.4 },
    diffuse: { r: 0.3, g: 0.2, b: 0.1 },
  });
});

test("the CPU oracle distinguishes terrain, ordinary surfaces and two-sided foliage", () => {
  const ambient = { r: 0.1, g: 0.1, b: 0.1 };
  const diffuse = { r: 0.4, g: 0.3, b: 0.2 };
  assert.deepEqual(
    worldLightFactor(ambient, diffuse, -1, 1, 0, "terrain"),
    worldLightFactor(ambient, diffuse, 1, 1, 0, "terrain"),
    "terrain uses the reference abs(N.L)",
  );
  close(worldLightFactor(ambient, diffuse, 0, 1, 0, "terrain").r, 0.1 + 0.4 * 0.2);
  close(worldLightFactor(ambient, diffuse, -1, 1, 0, "surface").r, 0.1);
  close(worldLightFactor(ambient, diffuse, 1, 1, 0, "surface").r, 0.5);
  close(worldLightFactor(ambient, diffuse, -1, 1, 0, "foliage").r, 0.5);
  close(worldLightFactor(ambient, diffuse, 1, 0, 0, "surface").r, 0.1);
});

test("procedural night fallback is tinted before headroom while authored bands pass zero", () => {
  const night = worldLightFactor(
    { r: 0.3, g: 0.2, b: 0.1 },
    { r: 0.4, g: 0.3, b: 0.2 },
    1, 1, 1, "terrain",
  );
  close(night.r, 0.17);
  close(night.g, 0.12);
  close(night.b, 0.17);
});

test("Stormwind noon stays within five bytes of the independent 120-channel display-space oracle", () => {
  // Light row 77 / LightParams 79 at (-8833, 628, 94), noon, read from this dataset:
  // ambient rgb(104,130,154), diffuse rgb(255,136,0). Their peak sum is 359/255 = 1.407843.
  const ambient = { r: 104 / 255, g: 130 / 255, b: 154 / 255 };
  const diffuse = { r: 1, g: 136 / 255, b: 0 };
  const channels = ["r", "g", "b"];
  const albedos = [32, 64, 96, 128];
  const normals = [-1, -0.75, -0.5, -0.25, 0, 0.2, 0.4, 0.6, 0.8, 1];
  const clamp = (value) => Math.max(0, Math.min(1, value));
  const srgbToLinear = (value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
  const linearToSrgb = (value) => value <= 0.0031308
    ? 12.92 * value
    : 1.055 * value ** (1 / 2.4) - 0.055;
  const byte = (linear) => Math.round(clamp(linearToSrgb(toneShoulder(linear))) * 255);

  // Independent from applyLightHeadroom/worldLightFactor: calculate the measured row's one common
  // scale directly, then compare display-space multiplication with the shader's pow(2.2) bridge.
  const peak = Math.max(...channels.map((channel) => ambient[channel] + diffuse[channel]));
  const scale = 1 / peak;
  close(peak, 359 / 255);
  const errors = [];
  const unheadedErrors = [];
  for (const albedoByte of albedos) {
    for (const ndotl of normals) {
      const factor = worldLightFactor(ambient, diffuse, ndotl, 1, 0, "terrain");
      const nl = Math.max(Math.abs(ndotl), 0.2);
      for (const channel of channels) {
        const referenceFactor = (ambient[channel] + diffuse[channel] * nl) * scale;
        const expected = byte(srgbToLinear(clamp(albedoByte / 255 * referenceFactor)));
        const actual = byte(srgbToLinear(albedoByte / 255) * Math.max(factor[channel], 0) ** 2.2);
        const unheaded = byte(srgbToLinear(albedoByte / 255)
          * Math.max(ambient[channel] + diffuse[channel] * nl, 0) ** 2.2);
        errors.push(Math.abs(actual - expected));
        unheadedErrors.push(Math.abs(unheaded - expected));
      }
    }
  }
  assert.equal(errors.length, 120);
  const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
  const unheadedMean = unheadedErrors.reduce((sum, error) => sum + error, 0) / unheadedErrors.length;
  assert.ok(mean <= 5, `mean channel error ${mean.toFixed(3)} bytes`);
  assert.ok(unheadedMean > 16, `headroom mutation was not detected: ${unheadedMean.toFixed(3)}`);
});

test("Light.dbc multipliers remain numeric uniforms rather than being sRGB-decoded", () => {
  const uniforms = createWorldLightUniforms();
  setWorldLightUniforms(uniforms, { r: 0.5, g: 0.25, b: 0.1 }, { r: 0, g: 0, b: 0 });
  close(uniforms.wowAmbient.value.r, 0.5);
  close(uniforms.wowAmbient.value.g, 0.25);
  assert.ok(Math.abs(uniforms.wowAmbient.value.r - 0.214) > 0.2,
    "0.5 must not become the linear decode of an sRGB colour");
});

test("immersive lighting is one reversible bounded uniform in the existing world shader", () => {
  const uniforms = createWorldLightUniforms();
  assert.equal(uniforms.wowImmersiveStrength.value, 0);
  assert.equal(setWorldLightImmersiveStrength(uniforms, 0.65), 0.65);
  assert.equal(uniforms.wowImmersiveStrength.value, 0.65);
  assert.equal(setWorldLightImmersiveStrength(uniforms, 20), 1);
  assert.equal(setWorldLightImmersiveStrength(uniforms, -20), 0);
  assert.match(WORLD_LIGHT_BODY, /wowImmersiveStrength/);
  assert.match(WORLD_LIGHT_BODY, /wowSoftFill/);
  assert.match(WORLD_LIGHT_BODY, /wowWarmKey/);
  assert.match(WORLD_LIGHT_BODY, /wowRim/);
  assert.match(WORLD_LIGHT_BODY, /if \( wowImmersiveStrength > 0\.0001 \)/,
    "quality zero skips the optional rim/fill/key arithmetic instead of only mixing it away");
});

test("the shared GLSL owns one light and shadow integration with per-surface modes", () => {
  assert.match(WORLD_LIGHT_BODY, /WOW_LIGHT_TERRAIN/);
  assert.match(WORLD_LIGHT_BODY, /WOW_LIGHT_FOLIAGE/);
  assert.match(WORLD_LIGHT_BODY, /max\( wowDot, 0\.0 \)/);
  assert.match(WORLD_LIGHT_BODY, /getShadow\(/);
  assert.match(WORLD_LIGHT_BODY, /if \( receiveShadow \)/);
  assert.match(WORLD_LIGHT_BODY, /pow\( wowLight, vec3\( 2\.2 \) \)/);
});

test("applyWorldLight preserves an existing hook and key and removes three's BRDF block", () => {
  const material = new THREE.MeshStandardMaterial();
  let previousRan = false;
  material.onBeforeCompile = (shader) => {
    previousRan = true;
    shader.uniforms.previous = { value: 7 };
  };
  material.customProgramCacheKey = () => "previous-key";
  const uniforms = createWorldLightUniforms();
  applyWorldLight(material, uniforms, "surface");

  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  assert.equal(previousRan, true);
  assert.equal(shader.uniforms.previous.value, 7);
  assert.equal(shader.uniforms.wowAmbient, uniforms.wowAmbient);
  assert.equal(shader.uniforms.wowImmersiveStrength, uniforms.wowImmersiveStrength);
  assert.equal(shader.fragmentShader.includes(WORLD_LIGHT_TARGET), false);
  assert.equal(shader.fragmentShader.includes("#include <lights_fragment_begin>"), false);
  assert.equal((shader.fragmentShader.match(/getShadow\(/g) ?? []).length, 1,
    "the stock lookup is removed before the authored lookup is inserted");
  assert.equal(material.customProgramCacheKey(), "previous-key|world-light-r185-v5:surface");
});

test("portrait clone removes only the world wrapper and keeps the pre-world hook and key", () => {
  const map = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map });
  let previousRuns = 0;
  const previousCompile = (shader) => {
    previousRuns++;
    shader.fragmentShader += "\n// authored portrait chain";
  };
  material.onBeforeCompile = previousCompile;
  material.customProgramCacheKey = () => "previous-key";
  applyWorldLight(material, createWorldLightUniforms(), "surface");

  const clone = cloneMaterialForPortrait(material);
  assert.notEqual(clone, material);
  assert.equal(clone.map, map, "portrait shares the already-loaded texture");
  assert.equal(clone.onBeforeCompile, previousCompile, "only the outer world hook is removed");
  assert.equal(clone.customProgramCacheKey(), "previous-key");
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  clone.onBeforeCompile(shader, {});
  assert.equal(previousRuns, 1);
  assert.match(shader.fragmentShader, /authored portrait chain/);
  assert.doesNotMatch(shader.fragmentShader, /wowAuthoredLight/);
  clone.dispose();
  material.dispose();
  map.dispose();
});

test("portrait clone preserves a non-world custom hook and cache key", () => {
  const material = new THREE.MeshBasicMaterial();
  let previousRuns = 0;
  const previousCompile = (shader) => {
    previousRuns++;
    shader.fragmentShader += "\n// non-world portrait chain";
  };
  material.onBeforeCompile = previousCompile;
  material.customProgramCacheKey = () => "non-world-key";

  const clone = cloneMaterialForPortrait(material);
  assert.equal(clone.onBeforeCompile, previousCompile);
  assert.equal(clone.customProgramCacheKey(), "non-world-key");
  clone.onBeforeCompile({ uniforms: {}, vertexShader: "", fragmentShader: "" }, {});
  assert.equal(previousRuns, 1);
  clone.dispose();
  material.dispose();
});

test("terrain and surface programs cannot share a cache key or lighting branch", () => {
  const uniforms = createWorldLightUniforms();
  const terrain = new THREE.MeshLambertMaterial();
  const surface = new THREE.MeshStandardMaterial();
  applyWorldLight(terrain, uniforms, "terrain");
  applyWorldLight(surface, uniforms, "surface");
  const terrainShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  terrain.onBeforeCompile(terrainShader, {});
  assert.match(terrainShader.fragmentShader, /#define WOW_LIGHT_TERRAIN/);
  assert.doesNotMatch(terrainShader.fragmentShader, /#define WOW_LIGHT_FOLIAGE/);
  assert.notEqual(terrain.customProgramCacheKey(), surface.customProgramCacheKey());
});

test("one binding is idempotent and conflicting world-light modes fail loudly", () => {
  const material = new THREE.MeshStandardMaterial();
  const uniforms = createWorldLightUniforms();
  applyWorldLight(material, uniforms, "surface");
  const hook = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  applyWorldLight(material, uniforms, "surface");
  assert.equal(material.onBeforeCompile, hook);
  assert.equal(material.customProgramCacheKey(), key);
  assert.throws(() => applyWorldLight(material, uniforms, "terrain"), /conflicting/);
  assert.throws(() => applyWorldLight(material, createWorldLightUniforms(), "surface"), /conflicting/);
});

test("a missing or duplicated three.js light block cannot silently compile the wrong shader", () => {
  const uniforms = createWorldLightUniforms();
  const missing = new THREE.MeshStandardMaterial();
  applyWorldLight(missing, uniforms, "surface");
  assert.throws(() => missing.onBeforeCompile({ uniforms: {}, vertexShader: "", fragmentShader: "void main(){}" }, {}),
    /expected one.*found 0/);

  const duplicate = new THREE.MeshStandardMaterial();
  applyWorldLight(duplicate, uniforms, "surface");
  assert.throws(() => duplicate.onBeforeCompile({
    uniforms: {},
    vertexShader: "",
    fragmentShader: `${WORLD_LIGHT_TARGET}\n${WORLD_LIGHT_TARGET}`,
  }, {}), /expected one.*found 2/);
});

test("the terrain mode survives the splat hook that arrives after the base material", () => {
  const material = new THREE.MeshLambertMaterial();
  const uniforms = createWorldLightUniforms();
  applyWorldLight(material, uniforms, "terrain");
  applyTerrainSplat(material, {
    layers: new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1),
    alpha: new THREE.Texture(),
    index: new THREE.Texture(),
  });
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  material.onBeforeCompile(shader, {});
  assert.match(shader.fragmentShader, /#define WOW_LIGHT_TERRAIN/);
  assert.match(shader.fragmentShader, /uniform sampler2DArray splatLayers/);
  assert.equal(shader.fragmentShader.includes("#include <lights_fragment_begin>"), false);
  assert.equal(material.customProgramCacheKey(), "world-light-r185-v5:terrain|terrain-splat");
});

test("renderer material policy hooks every lit world path and leaves authored flat paths alone", async () => {
  const [world, models] = await Promise.all([
    readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ModelBuild.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(world, /new THREE\.HemisphereLight/);
  assert.doesNotMatch(world, /^\s*readonly #ambient\s*=/m);
  assert.doesNotMatch(world, /^\s*#applyGroundBounce\(\): void/m);
  assert.match(world, /#sun = new THREE\.DirectionalLight\(0xffffff, 0\)/);
  assert.match(world, /#horizonMaterial = new THREE\.MeshBasicMaterial/);
  assert.match(world, /#fallbackLiquidMaterials = new Map<LiquidClass/);
  assert.match(world, /buildTerrainMaterial[\s\S]*applyWorldLight\(material, worldLight, "terrain"\)/);
  assert.match(world, /this\.#wmoMaterial, this\.#m2Material, this\.#stoneMaterial,[\s\S]*applyWorldLight\(material, this\.#worldLight, "surface"\)/);
  assert.match(world, /value instanceof THREE\.MeshStandardMaterial[\s\S]*applyWorldLight\(value, this\.#worldLight, "surface"\)/);
  assert.match(world, /new THREE\.MeshStandardMaterial\(\{ color: tint[\s\S]*applyWorldLight\(material, this\.#worldLight, "surface"\)/);
  assert.match(models,
    /material instanceof THREE\.MeshStandardMaterial && options\.worldLight[\s\S]*applyWorldLight\(material, options\.worldLight, "surface"\)/);
  assert.match(models, /const material = unlit\s*\? new THREE\.MeshBasicMaterial\(\)\s*:\s*new THREE\.MeshStandardMaterial/);
});
