import assert from "node:assert/strict";
import test from "node:test";
import { COMPARISON_GRAPHICS_OVERRIDES, comparisonGraphicsSettings } from
  "../dist/code/browser/ui/ComparisonProfile.js";
import { SETTING_DEFINITIONS, defaultSettings } from "../dist/code/browser/ui/SettingsModel.js";
import { lightingProfile } from "../dist/code/browser/LightingQuality.js";

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
  assert.equal(profile.lightingQuality, 0);
  assert.equal(profile.grassDensity, 1);
  assert.equal(lightingProfile(profile.lightingQuality).shadowMapSize, 0);
  assert.equal(lightingProfile(profile.lightingQuality).immersiveStrength, 0);
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
  assert.deepEqual(comparisonGraphicsSettings(profile), profile, "reapplying it is stable");
});
