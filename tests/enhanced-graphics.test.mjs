import assert from "node:assert/strict";
import test from "node:test";
import { enhancedGraphicsSettings, ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { defaultSettings, parseSettings, serialiseSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { comparisonGraphicsSettings } from "../dist/code/browser/ui/ComparisonProfile.js";
import { LIGHTING_QUALITY_COMPARISON, lightingClassicLook } from "../dist/code/browser/LightingQuality.js";

test("enhanced lighting can be enabled and saved without resetting player preferences", () => {
  const current = { ...defaultSettings(), renderScale: 75, autoQuality: false, uiScale: 110,
    volumeMaster: 25, autoLoot: true, grassRadius: 40 };
  const enhanced = enhancedGraphicsSettings(current);
  for (const [id, value] of Object.entries(ENHANCED_GRAPHICS_OVERRIDES)) {
    assert.ok(settingDefinition(id), `${id} is a supported setting`);
    assert.equal(enhanced[id], value);
  }
  for (const id of ["renderScale", "autoQuality", "uiScale", "volumeMaster", "autoLoot", "grassRadius"]) {
    assert.equal(enhanced[id], current[id], `${id} stays personal`);
  }
  assert.equal(current.lightingQuality, 1, "the input settings are not mutated");
  assert.deepEqual(parseSettings(serialiseSettings(enhanced)), enhanced);
  assert.deepEqual(enhancedGraphicsSettings(enhanced), enhanced);
  const baseline = comparisonGraphicsSettings(enhanced);
  assert.equal(baseline.experimentalAerialHeightFog, false);
  assert.equal(baseline.godRays, false);
  // 05.10-7.20: the baseline is level 3 «сравнение» (the classic frame plus quality 1's shadow
  // pass, because the reference install runs extShadowQuality 5), not quality 0.
  assert.equal(LIGHTING_QUALITY_COMPARISON, 3);
  assert.equal(baseline.lightingQuality, LIGHTING_QUALITY_COMPARISON);
  assert.equal(lightingClassicLook(baseline.lightingQuality), true, "the baseline draws the classic look");
  assert.equal(baseline.volumeMaster, 25);
});
