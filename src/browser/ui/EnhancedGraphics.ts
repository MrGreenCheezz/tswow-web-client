import { coerceSetting, settingDefinition, type SettingValues } from "./SettingsModel.js";

/** A coherent outdoor preset; gameplay, sound, UI scale and adaptive resolution stay personal. */
export const ENHANCED_GRAPHICS_OVERRIDES: Readonly<SettingValues> = Object.freeze({
  lightingQuality: 2,
  experimentalAerialHeightFog: true,
  experimentalTerrainMicroNormals: true,
  experimentalTerrainRelief: true, // 22.10 (7.47)
  experimentalWmoRelief: true, // 22.10 (7.47 stage 2)
  experimentalModelRelief: true, // 23.10 (7.47 stage 3)
  experimentalWaterFresnel: true,
  experimentalWaterMicroWaves: true,
  experimentalWaterSunSparkle: true,
  experimentalWaterFoam: true,
  experimentalVegetationWind: true,
  experimentalFantasyGlow: true,
  experimentalLivingSpells: true, // 23.10 (6.27)
  fullscreenGlow: true,
  godRays: true,
  experimentalCinematicGrade: true,
  experimentalCinematicBloom: true,
  experimentalSunScattering: true,
  experimentalAmbientOcclusion: true,
  experimentalLowSunRimLight: true,
  experimentalWaterSunGlitter: true,
  experimentalSceneryShadows: true,
  experimentalWaterSkyReflection: true,
  cinematicStrength: 100,
  experimentalWindGusts: true,
  experimentalRainStreaks: true,
  experimentalRainSplashes: true,
  experimentalWetSurfaces: true,
  experimentalLightning: true,
  experimentalAmbientMotes: true,
  experimentalWeatherSounds: true,
});

export function enhancedGraphicsSettings(current: SettingValues): SettingValues {
  const values = { ...current };
  for (const [id, value] of Object.entries(ENHANCED_GRAPHICS_OVERRIDES)) {
    const definition = settingDefinition(id);
    if (!definition) throw new Error(`Unknown graphics setting: ${id}`);
    values[id] = coerceSetting(definition, value);
  }
  return values;
}
