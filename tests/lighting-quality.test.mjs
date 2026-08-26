import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  lightingProfile, normaliseLightingQuality, shadowMaterialEligible, unitCastsEnhancedShadow,
} from "../dist/code/browser/LightingQuality.js";
import {
  defaultSettings, parseSettings, settingDefinition,
} from "../dist/code/browser/ui/SettingsModel.js";

test("lighting quality zero preserves the renderer baseline exactly", () => {
  const profile = lightingProfile(0, { shadowMaps: true, maxTextureSize: 16384 });
  assert.equal(profile.quality, 0);
  // Not the pre-option 1.05 any more: that number was chosen against ACES, and ACES is gone.
  // The curve every profile now shares is asserted in tests/tone-mapping.test.mjs.
  assert.equal(profile.exposure, 1);
  assert.equal(profile.shadowMapSize, 0);
  assert.equal(profile.shadowCasters, 0);
});

test("balanced and high profiles change bounded shadow work, never authored light balance", () => {
  const balanced = lightingProfile(1, { shadowMaps: true, maxTextureSize: 4096 });
  const high = lightingProfile(2, { shadowMaps: true, maxTextureSize: 4096 });
  assert.equal(balanced.shadowMapSize, 512);
  assert.equal(balanced.shadowCasters, 12);
  assert.equal(high.shadowMapSize, 1024);
  assert.equal(high.shadowCasters, 24);
  assert.equal(balanced.exposure, 1);
  assert.equal(high.exposure, 1);
  assert.equal("ambientIntensity" in balanced, false);
  assert.equal("sunIntensity" in balanced, false);
  assert.equal("groundBounce" in balanced, false);

  assert.equal(unitCastsEnhancedShadow(0, 0, balanced), true);
  assert.equal(unitCastsEnhancedShadow(11, 32, balanced), true);
  assert.equal(unitCastsEnhancedShadow(12, 10, balanced), false);
  assert.equal(unitCastsEnhancedShadow(0, 32.01, balanced), false);
  assert.equal(unitCastsEnhancedShadow(-1, 10, balanced), false);
  assert.equal(unitCastsEnhancedShadow(1.5, 10, balanced), false);
});

test("unsupported or small contexts keep enhanced light and gracefully drop shadow resolution", () => {
  const unavailable = lightingProfile(2, { shadowMaps: false, maxTextureSize: 16384 });
  assert.equal(unavailable.quality, 2);
  assert.equal(unavailable.exposure, 1);
  assert.equal(unavailable.shadowMapSize, 0);
  assert.equal(unavailable.shadowCasters, 0);

  const small = lightingProfile(2, { shadowMaps: true, maxTextureSize: 512 });
  assert.equal(small.shadowMapSize, 512, "high quality uses the largest supported bounded map");
  assert.equal(small.shadowCasters, 12, "a 512-limited context also gets the balanced draw budget");
  const tooSmall = lightingProfile(1, { shadowMaps: true, maxTextureSize: 511 });
  assert.equal(tooSmall.shadowMapSize, 0);
  const malformed = lightingProfile(2, { shadowMaps: true, maxTextureSize: Number.NaN });
  assert.equal(malformed.shadowMapSize, 0, "unknown capabilities fail closed");
});

test("quality coercion is stable for account and hand-edited values", () => {
  assert.equal(normaliseLightingQuality(-20), 0);
  assert.equal(normaliseLightingQuality(0.6), 1);
  assert.equal(normaliseLightingQuality("2"), 2);
  assert.equal(normaliseLightingQuality(99), 2);
  assert.equal(normaliseLightingQuality(Number.NaN), 1);
});

test("the shadow material gate excludes unlit, blended, transparent and depthless batches", () => {
  const opaqueLit = { lit: true, transparent: false, normalBlending: true, depthWrite: true };
  assert.equal(shadowMaterialEligible(opaqueLit), true);
  assert.equal(shadowMaterialEligible({ ...opaqueLit, lit: false }), false);
  assert.equal(shadowMaterialEligible({ ...opaqueLit, transparent: true }), false);
  assert.equal(shadowMaterialEligible({ ...opaqueLit, normalBlending: false }), false);
  assert.equal(shadowMaterialEligible({ ...opaqueLit, depthWrite: false }), false);
});

test("lighting quality is an account setting with off, balanced and high values", () => {
  const definition = settingDefinition("lightingQuality");
  assert.ok(definition);
  assert.equal(definition.fallback, 1);
  assert.equal(definition.min, 0);
  assert.equal(definition.max, 2);
  assert.equal(defaultSettings().lightingQuality, 1);
  assert.equal(parseSettings('{"lightingQuality":0}')?.lightingQuality, 0);
  assert.equal(parseSettings('{"lightingQuality":99}')?.lightingQuality, 2);
});

test("world integration confines shadow flags to ranked units and terrain receivers", async () => {
  const [world, settings] = await Promise.all([
    readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /setLightingQuality\(settingNumber\(values, "lightingQuality"\)\)/);
  assert.match(world, /unitCastsEnhancedShadow\(rank,[\s\S]*Math\.hypot\([\s\S]*this\.#lightingProfile\)/);
  assert.match(world, /unit\.node\.traverse/);
  assert.match(world, /terrain\.mesh\.receiveShadow = shadows/);
  const policy = world.slice(world.indexOf("#applyUnitShadow"), world.indexOf("setRenderScale", world.indexOf("#applyUnitShadow")));
  assert.doesNotMatch(policy, /material\.(transparent|alphaTest|opacity|map|blending)\s*=(?!=)/,
    "the policy reads material traits but never rewrites authored texture/alpha state");
});
