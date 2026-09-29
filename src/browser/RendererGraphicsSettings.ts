import type { GroundCoverClient } from "./GroundCover.js";
import type { WorldRenderer3D } from "./WorldRenderer3D.js";
import { settingBoolean, settingNumber, type SettingValues } from "./ui/SettingsModel.js";

/**
 * Every account setting the world renderer draws with, pushed to it in one call: the renderer half
 * of `ui/Settings.ts`'s `applySettings`, for the bench (`bench/run.mjs --settings <file>`), so a
 * measured scene draws exactly what a player's graphics options draw — the owner's enhanced preset
 * turns on scenery shadows, ambient occlusion, wet surfaces and a dozen other passes the bench's
 * own graphics block never did. `applySettings` keeps its own copy of these calls (its tests read
 * them there); `tests/renderer-graphics-settings.test.mjs` keeps the two lists equal. Nothing here
 * touches the page, which is what lets the bench import it.
 */
export function applyRendererGraphicsSettings(
  renderer: WorldRenderer3D,
  values: SettingValues,
  groundCover: GroundCoverClient | undefined,
): void {
  // The cheapest graphics option this client has. Fill rate is what a city costs most of, and the
  // splat shader is what it costs it in, so drawing at three quarters is three quarters of it.
  renderer.setRenderScale(settingNumber(values, "renderScale") / 100);
  // A bounded unit-shadow pass plus a light-balance profile. Zero restores the exact renderer
  // baseline that pre-dates the option; capability fallback happens inside the renderer.
  renderer.setLightingQuality(settingNumber(values, "lightingQuality"));
  // Static WMO rooms only. Old artifacts, open air and moving world objects retain their distance
  // selection even while this option is enabled.
  renderer.setWmoOcclusion(settingBoolean(values, "wmoOcclusion"));
  // R1 A/B candidate only: the renderer's default remains anisotropy 1, and this setting can roll
  // its cached character atlases back to that baseline without changing their ownership.
  renderer.setCharacterAtlasAnisotropy(settingBoolean(values, "characterAtlasAnisotropy"));
  // Independently reversible atmosphere, terrain and water effects. The enhanced preset enables
  // aerial fog; the comparison profile disables every optional leaf for repeatable captures.
  renderer.setExperimentalShaderProfile?.({
    aerialHeightFog: settingBoolean(values, "experimentalAerialHeightFog"),
    terrainMicroNormals: settingBoolean(values, "experimentalTerrainMicroNormals"),
    waterFresnel: settingBoolean(values, "experimentalWaterFresnel"),
    waterMicroWaves: settingBoolean(values, "experimentalWaterMicroWaves"),
    waterSunSparkle: settingBoolean(values, "experimentalWaterSunSparkle"),
    waterFoam: settingBoolean(values, "experimentalWaterFoam"),
    vegetationWind: settingBoolean(values, "experimentalVegetationWind"),
    fantasyGlow: settingBoolean(values, "experimentalFantasyGlow"),
  });
  // P3 underwater screen effect. Its own switch rather than a seventh experimental leaf: this one
  // is the original client's own view from under the water, and OFF is the pre-P3 frame exactly —
  // the overlay scene is never submitted, so the draw-call count does not move either.
  renderer.setUnderwaterOverlay?.(settingBoolean(values, "underwaterOverlay"));
  // The classic glow and solar rays are independent leaves sharing one offscreen scene path. Each
  // switch controls only its own effect; the direct pre-P4 path is selected only when both are OFF.
  renderer.setFullscreenGlow?.(settingBoolean(values, "fullscreenGlow"));
  renderer.setGodRays?.(settingBoolean(values, "godRays"));
  // The shaft multiplier over the quality ceiling, on both shaft paths; a percentage on the account.
  renderer.setGodRayStrength?.(settingNumber(values, "godRayStrength") / 100);
  // Cinematic leaves of the enhanced preset (CinematicPost.ts); all off is the pre-existing frame.
  renderer.setCinematicProfile?.({
    grade: settingBoolean(values, "experimentalCinematicGrade"),
    bloom: settingBoolean(values, "experimentalCinematicBloom"),
    sunScattering: settingBoolean(values, "experimentalSunScattering"),
    ambientOcclusion: settingBoolean(values, "experimentalAmbientOcclusion"),
    rimLight: settingBoolean(values, "experimentalLowSunRimLight"),
    waterSunGlitter: settingBoolean(values, "experimentalWaterSunGlitter"),
    sceneryShadows: settingBoolean(values, "experimentalSceneryShadows"),
    waterSkyReflection: settingBoolean(values, "experimentalWaterSkyReflection"),
  });
  // One slider over grade, bloom, scattering and sun shafts; a percentage on the account.
  renderer.setCinematicStrength?.(settingNumber(values, "cinematicStrength") / 100);
  // Wind, weather and ambient life (AtmosphereEffects.ts); all off creates nothing.
  renderer.setAtmosphereEffects?.({
    windGusts: settingBoolean(values, "experimentalWindGusts"),
    rainStreaks: settingBoolean(values, "experimentalRainStreaks"),
    rainSplashes: settingBoolean(values, "experimentalRainSplashes"),
    wetSurfaces: settingBoolean(values, "experimentalWetSurfaces"),
    lightning: settingBoolean(values, "experimentalLightning"),
    ambientMotes: settingBoolean(values, "experimentalAmbientMotes"),
    weatherSounds: settingBoolean(values, "experimentalWeatherSounds"),
  });
  // The stock «Детализация ландшафта» multiplier over every M2 scenery leash; a percentage here.
  renderer.setEnvironmentDetail?.(settingNumber(values, "objectDistance") / 100);
  // How far the ground cover reaches, and whether its density is read per detail cell. Pushed for
  // the same reason as the render scale: it is read deep inside a frame, and a copy kept anywhere
  // else is a copy that can be stale. Outside the world the client is undefined, which takes the
  // field down without a second switch.
  renderer.setGroundCover(groundCover, settingNumber(values, "grassRadius"), settingBoolean(values, "grassDense"),
    settingNumber(values, "grassDensity"));
}
