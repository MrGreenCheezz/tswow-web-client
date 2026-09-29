import assert from "node:assert/strict";
import test from "node:test";
import { enhancedGraphicsSettings, ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { defaultSettings, parseSettings, serialiseSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { comparisonGraphicsSettings } from "../dist/code/browser/ui/ComparisonProfile.js";

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
  assert.equal(baseline.lightingQuality, 0);
  assert.equal(baseline.volumeMaster, 25);
});
