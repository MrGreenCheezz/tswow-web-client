import assert from "node:assert/strict";
import test from "node:test";
import { enhancedGraphicsSettings, ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { defaultSettings, parseSettings, serialiseSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { comparisonGraphicsSettings } from "../dist/code/browser/ui/ComparisonProfile.js";
import { LIGHTING_QUALITY_COMPARISON, lightingClassicLook } from "../dist/code/browser/LightingQuality.js";

test("enhanced lighting can be enabled and saved without resetting player preferences", () => {
  const current = { ...defaultSettings(), renderScale: 75, autoQuality: false, uiScale: 110,
    volumeMaster: 25, autoLoot: true, grassRadius: 40, lightingQuality: 1 };
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

test("25.10: a blob saved on the enhanced preset before an addition receives it once", async () => {
  const { ENHANCED_PRESET_REVISION, ENHANCED_PRESET_REVISIONS, ENHANCED_PRESET_REVISION_SETTING } =
    await import("../dist/code/browser/ui/EnhancedPresetRevision.js");
  for (const revision of ENHANCED_PRESET_REVISIONS) {
    for (const [id, value] of Object.entries(revision)) {
      assert.equal(ENHANCED_GRAPHICS_OVERRIDES[id], value, `${id} is the preset's own value`);
      assert.notEqual(settingDefinition(id).fallback, value, `${id} differs from its default, or it needs no migration`);
    }
  }
  const pressedBefore = { ...enhancedGraphicsSettings(defaultSettings()), experimentalLivingSpells: false,
    experimentalWindGusts: false };
  const stored = JSON.parse(serialiseSettings(pressedBefore));
  assert.equal(stored[ENHANCED_PRESET_REVISION_SETTING], ENHANCED_PRESET_REVISION, "a blob written now records the revision");
  delete stored[ENHANCED_PRESET_REVISION_SETTING]; // as the blobs written before 25.10
  const migrated = parseSettings(JSON.stringify(stored));
  assert.equal(migrated.experimentalLivingSpells, true, "the addition arrives");
  assert.equal(migrated.experimentalWindGusts, false, "a deliberate opt-out of an older preset key stays");
  assert.equal(JSON.parse(serialiseSettings(migrated))[ENHANCED_PRESET_REVISION_SETTING], ENHANCED_PRESET_REVISION);
  const optedOut = parseSettings(serialiseSettings({ ...migrated, experimentalLivingSpells: false }));
  assert.equal(optedOut.experimentalLivingSpells, false, "turning it off after the migration sticks");
  assert.equal(parseSettings(JSON.stringify({ lightingQuality: 1 })).experimentalLivingSpells, false,
    "a blob that is not the enhanced profile is left alone");
  const baseline = comparisonGraphicsSettings(enhancedGraphicsSettings(defaultSettings()));
  assert.equal(parseSettings(serialiseSettings(baseline)).experimentalLivingSpells, false, "the comparison profile stays");
  assert.equal(JSON.parse(serialiseSettings(baseline))[ENHANCED_PRESET_REVISION_SETTING], undefined,
    "the comparison profile does not read as enhanced");
});
