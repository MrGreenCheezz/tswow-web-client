import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  lightingProfile, normaliseLightingQuality, shadowMaterialEligible,
  stabiliseDirectionalShadowCenter, unitCastsEnhancedShadow,
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

test("lighting quality enables a bounded single-shader immersive grade without depending on shadows", () => {
  const off = lightingProfile(0, { shadowMaps: true, maxTextureSize: 4096 });
  const balanced = lightingProfile(1, { shadowMaps: true, maxTextureSize: 4096 });
  const highWithoutShadows = lightingProfile(2, { shadowMaps: false, maxTextureSize: 0 });
  assert.equal(off.immersiveStrength, 0);
  assert.equal(balanced.immersiveStrength, 0.65);
  assert.equal(highWithoutShadows.immersiveStrength, 1,
    "the ALU-only light grade must survive capability fallback independently of the shadow pass");
});

test("directional shadow centre snaps only in the light plane", () => {
  const direction = { x: 0, y: 1, z: 1 };
  const first = stabiliseDirectionalShadowCenter(
    { x: 10.031, y: 20.017, z: 30.009 }, direction, 32, 512);
  const alongLight = stabiliseDirectionalShadowCenter(
    { x: 10.031, y: 25.017, z: 35.009 }, direction, 32, 512);
  assert.ok(Math.abs(first.x - alongLight.x) < 1e-9);
  assert.ok(Math.abs((alongLight.y - first.y) - 5) < 1e-9);
  assert.ok(Math.abs((alongLight.z - first.z) - 5) < 1e-9);

  const nearby = stabiliseDirectionalShadowCenter(
    { x: 10.041, y: 20.017, z: 30.009 }, direction, 32, 512);
  assert.ok(Math.abs(first.x - nearby.x) < 1e-9);
  assert.ok(Math.abs(first.y - nearby.y) < 1e-9);
  assert.ok(Math.abs(first.z - nearby.z) < 1e-9);
  assert.deepEqual(
    stabiliseDirectionalShadowCenter({ x: 1, y: 2, z: 3 }, direction, 0, 512),
    { x: 1, y: 2, z: 3 },
  );
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

test("character atlas anisotropy is an opt-in account experiment", async () => {
  const definition = settingDefinition("characterAtlasAnisotropy");
  assert.ok(definition);
  assert.equal(definition.group, "Мир");
  assert.equal(definition.kind, "boolean");
  assert.equal(definition.fallback, false);
  assert.match(definition.hint ?? "", /A\/B/i);
  assert.equal(defaultSettings().characterAtlasAnisotropy, false);
  assert.equal(parseSettings('{"characterAtlasAnisotropy":false}')?.characterAtlasAnisotropy, false);
  assert.equal(parseSettings('{"characterAtlasAnisotropy":true}')?.characterAtlasAnisotropy, true);

  const settings = await readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8");
  assert.match(settings, /setCharacterAtlasAnisotropy\(settingBoolean\(values, "characterAtlasAnisotropy"\)\)/);
});

test("world integration confines shadow flags to ranked units and terrain receivers", async () => {
  const [world, settings] = await Promise.all([
    readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/browser/ui/Settings.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /setLightingQuality\(settingNumber\(values, "lightingQuality"\)\)/);
  const updateStart = world.indexOf("  #updateUnits(");
  const updateEnd = world.indexOf("  #wmoGroupBorrowers(", updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart, "unit admission method is findable");
  const updateUnits = world.slice(updateStart, updateEnd);
  const candidatePush = updateUnits.indexOf("candidates.push({");
  const admissionCallText = "const admission = selectUnitAdmission(candidates, UNIT_BUDGET);";
  const admissionCall = updateUnits.indexOf(admissionCallText, candidatePush);
  const admittedLoopText = "for (const [rank, { value: object, distance }] of admission.admitted.entries())";
  const admittedLoop = updateUnits.indexOf(admittedLoopText, admissionCall);
  const shadowCallText = "unitCastsEnhancedShadow(rank, distance, this.#lightingProfile)";
  const shadowCall = updateUnits.indexOf(shadowCallText, admittedLoop);
  const distanceText = "const distance = Math.hypot(object.position.x - player.x, object.position.y - player.y);";
  const distanceRead = updateUnits.indexOf(distanceText);
  assert.ok(distanceRead >= 0 && candidatePush > distanceRead && admissionCall > candidatePush
    && admittedLoop > admissionCall && shadowCall > admittedLoop,
    "unit candidates flow through admission to the ranked shadow call");
  assert.equal(updateUnits.slice(admissionCall, admissionCall + admissionCallText.length), admissionCallText);
  assert.equal(updateUnits.slice(admittedLoop, admittedLoop + admittedLoopText.length), admittedLoopText);
  assert.equal(updateUnits.slice(shadowCall, shadowCall + shadowCallText.length), shadowCallText);
  assert.match(updateUnits.slice(distanceRead, admissionCall),
    /const distance = Math\.hypot\(object\.position\.x - player\.x, object\.position\.y - player\.y\);[\s\S]*candidates\.push\(\{[\s\S]*distance: Number\.isFinite\(distance\) \? distance : Number\.MAX_VALUE,/,
    "the candidate retains the finite distance derived from the unit/player positions");
  assert.match(world, /unit\.node\.traverse/);
  assert.match(world, /terrain\.mesh\.receiveShadow = shadows/);
  const policy = world.slice(world.indexOf("#applyUnitShadow"), world.indexOf("setRenderScale", world.indexOf("#applyUnitShadow")));
  assert.doesNotMatch(policy, /material\.(transparent|alphaTest|opacity|map|blending)\s*=(?!=)/,
    "the policy reads material traits but never rewrites authored texture/alpha state");
});
