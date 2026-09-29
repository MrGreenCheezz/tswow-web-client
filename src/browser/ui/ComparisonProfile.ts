import { coerceSetting, settingDefinition, type SettingValues } from "./SettingsModel.js";

/**
 * A stable WebClient control image for side-by-side capture. This removes optional additions and
 * adaptive resolution, but it is not a claim that uncalibrated camera, light or grass settings
 * already match the original client. Keep those scene-specific values in capture metadata.
 */
export const COMPARISON_GRAPHICS_OVERRIDES: Readonly<SettingValues> = Object.freeze({
  renderScale: 100,
  autoQuality: false,
  // The selected original client's Config.wtf has shadowLevel=0. More importantly, quality 1/2
  // adds this renderer's own shadow pass and warm/cool grade, so neither is a neutral comparison.
  lightingQuality: 0,
  characterAtlasAnisotropy: false,
  experimentalAerialHeightFog: false,
  experimentalTerrainMicroNormals: false,
  experimentalWaterFresnel: false,
  experimentalWaterMicroWaves: false,
  experimentalWaterSunSparkle: false,
  experimentalWaterFoam: false,
  experimentalVegetationWind: false,
  experimentalFantasyGlow: false,
  experimentalCinematicGrade: false,
  experimentalCinematicBloom: false,
  experimentalSunScattering: false,
  experimentalAmbientOcclusion: false,
  experimentalLowSunRimLight: false,
  experimentalWaterSunGlitter: false,
  experimentalSceneryShadows: false,
  experimentalWaterSkyReflection: false,
  // Neutral: every leaf it scales is off above, so this only pins the slider to its default.
  cinematicStrength: 100,
  experimentalWindGusts: false,
  experimentalRainStreaks: false,
  experimentalRainSplashes: false,
  experimentalWetSurfaces: false,
  experimentalLightning: false,
  experimentalAmbientMotes: false,
  experimentalWeatherSounds: false,
  godRays: false,
  // Neutral: the leaf is off above, so this only pins the shaft slider to its default.
  godRayStrength: 100,
  grassDensity: 1,
});

/** Preserve player controls, sound and UI scale while preparing a repeatable graphics baseline. */
export function comparisonGraphicsSettings(current: SettingValues): SettingValues {
  const values = { ...current };
  for (const [id, value] of Object.entries(COMPARISON_GRAPHICS_OVERRIDES)) {
    const definition = settingDefinition(id);
    if (!definition) throw new Error(`Unknown comparison setting: ${id}`);
    values[id] = coerceSetting(definition, value);
  }
  return values;
}
