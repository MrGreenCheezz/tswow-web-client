import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPARISON_CONFIG_WTF, COMPARISON_CONFIG_WTF_KEYS, COMPARISON_CONFIG_WTF_MAPPING, COMPARISON_GRAPHICS_OVERRIDES,
  comparisonGraphicsSettings, comparisonOverridesFromConfigValues, comparisonOverridesFromConfigWtf, readConfigWtfAllowlisted,
} from "../dist/code/browser/ui/ComparisonProfile.js";
import { SETTING_DEFINITIONS, defaultSettings } from "../dist/code/browser/ui/SettingsModel.js";
import { lightingProfile } from "../dist/code/browser/LightingQuality.js";
import { renderSwitches } from "../dist/code/browser/RenderSwitches.js";

test("comparison profile fixes optional graphics without resetting player preferences", () => {
  const original = {
    ...defaultSettings(),
    renderScale: 65,
    autoQuality: true,
    lightingQuality: 2,
    grassDensity: 4,
    volumeMaster: 35,
    uiScale: 115,
    cameraDistancePercent: 200,
    chatTimestamps: true,
    tswowAddons: true,
  };
  const profile = comparisonGraphicsSettings(original);
  assert.equal(profile.renderScale, 100);
  assert.equal(profile.autoQuality, false);
  // 05.10-7.20: the «сравнение» level — classic light with quality 1's shadow pass.
  assert.equal(profile.lightingQuality, 3);
  assert.equal(profile.objectDistance, 150);
  assert.equal(profile.grassRadius, 140);
  assert.equal(profile.grassDensity, 1);
  assert.ok(lightingProfile(profile.lightingQuality).shadowMapSize > 0, "extShadowQuality 5: shadows in the frame");
  assert.equal(lightingProfile(profile.lightingQuality).immersiveStrength, 0, "no grade");
  assert.equal(profile.experimentalCinematicGrade, false);
  assert.equal(profile.godRays, false);
  assert.equal(profile.godRayStrength, 100, "the shaft slider is pinned neutral beside its leaf, which is off");
  for (const [id, value] of Object.entries(COMPARISON_GRAPHICS_OVERRIDES)) {
    assert.ok(SETTING_DEFINITIONS.some((definition) => definition.id === id), `${id} is a real setting`);
    assert.equal(profile[id], value, id);
  }
  for (const id of ["volumeMaster", "uiScale", "cameraDistancePercent", "chatTimestamps", "tswowAddons"]) {
    assert.equal(profile[id], original[id], `${id} remains the player's choice`);
  }
  assert.equal(original.renderScale, 65, "preparing a profile does not mutate the saved source object");
  assert.equal(original.lightingQuality, 2, "the saved lighting level is untouched until the profile is applied");
  assert.deepEqual(comparisonGraphicsSettings(profile), profile, "reapplying it is stable");
});

// 05.10-7.20: ten lines like the owner's file, with the identity-bearing keys a real one also has.
const FIXTURE = [
  'SET accountName "SecretAccount"',
  'SET realmList "secret.example"',
  'SET realmName "SecretRealm"',
  'SET farclip "1277"',
  'SET environmentDetail "1.5"',
  'SET groundEffectDist "140"',
  'SET groundEffectDensity "64"',
  'SET weatherDensity "3"',
  'SET extShadowQuality "5"',
  'SET specular "1"',
].join("\r\n");

test("7.20 Config.wtf reader keeps the allowlist only and never the account identity", () => {
  const values = readConfigWtfAllowlisted(FIXTURE);
  assert.deepEqual(values, {
    farclip: "1277", environmentDetail: "1.5", groundEffectDist: "140", groundEffectDensity: "64",
    weatherDensity: "3", extShadowQuality: "5", specular: "1",
  });
  const text = JSON.stringify(values);
  for (const secret of ["SecretAccount", "secret.example", "SecretRealm", "accountName", "realmList", "realmName"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(COMPARISON_CONFIG_WTF_KEYS.includes("accountName"), false);
  assert.deepEqual(readConfigWtfAllowlisted('set FARCLIP "777"\nSET farclip 5\nnoise'), { farclip: "777" },
    "names are case-insensitive like the client's CVars; unquoted lines are not the file's format");
});

test("7.20 Config.wtf values map to settings faithfully", () => {
  assert.deepEqual(comparisonOverridesFromConfigWtf(FIXTURE), {
    objectDistance: 150, grassRadius: 140, lightingQuality: 3,
  });
  assert.deepEqual(comparisonOverridesFromConfigValues({ extShadowQuality: "0" }), { lightingQuality: 0 },
    "no shadow quality: the plain classic level");
  assert.deepEqual(comparisonOverridesFromConfigValues({ environmentDetail: "9", groundEffectDist: "x" }), {
    objectDistance: 150,
  }, "values pass coerceSetting; garbage is dropped");
  assert.deepEqual(comparisonOverridesFromConfigValues(COMPARISON_CONFIG_WTF),
    Object.fromEntries(Object.keys(comparisonOverridesFromConfigValues(COMPARISON_CONFIG_WTF))
      .map((id) => [id, COMPARISON_GRAPHICS_OVERRIDES[id]])),
    "the profile carries the owner's file");
  assert.equal(COMPARISON_CONFIG_WTF.farclip, "1277");
  assert.equal(COMPARISON_CONFIG_WTF.weatherDensity, "3");
  assert.equal(COMPARISON_CONFIG_WTF.specular, "1");
  for (const key of COMPARISON_CONFIG_WTF_KEYS) {
    assert.ok(COMPARISON_CONFIG_WTF_MAPPING[key], `${key} has a recorded mapping`);
  }
  assert.match(COMPARISON_CONFIG_WTF_MAPPING.farclip, /7\.08/);
  assert.match(COMPARISON_CONFIG_WTF_MAPPING.specular, /terrainSpecular/);
  assert.equal(renderSwitches.terrainSpecular, false, "specular 1 is recorded, the switch is not silently enabled");
});
