import { coerceSetting, settingDefinition, type SettingValues } from "./SettingsModel.js";
import { LIGHTING_QUALITY_COMPARISON } from "../LightingQuality.js"; // 05.10-7.20

/**
 * 05.10-7.20: the only `Config.wtf` keys the comparison profile reads. Graphics CVars of the
 * reference install's video options — never `accountName`, `realmList`, `realmName` or any other key
 * a real file carries beside them.
 */
export const COMPARISON_CONFIG_WTF_KEYS: readonly string[] = Object.freeze([
  "farclip", "environmentDetail", "groundEffectDist", "groundEffectDensity", "weatherDensity",
  "extShadowQuality", "projectedTextures", "textureFilteringMode", "specular",
]);

/**
 * 05.10-7.20: the owner's reference install (`Config.wtf` of the selected client, read 05.10 through the
 * allowlist above only). Owner decision 05.10: these are the comparison profile's values.
 */
export const COMPARISON_CONFIG_WTF: Readonly<Record<string, string>> = Object.freeze({
  farclip: "1277",
  environmentDetail: "1.5",
  groundEffectDist: "140",
  groundEffectDensity: "64",
  weatherDensity: "3",
  extShadowQuality: "5",
  projectedTextures: "1",
  textureFilteringMode: "5",
  specular: "1",
});

/**
 * 05.10-7.20: what each allowlisted key becomes here, so a value that maps to no setting is a recorded
 * decision rather than a silent drop.
 */
export const COMPARISON_CONFIG_WTF_MAPPING: Readonly<Record<string, string>> = Object.freeze({
  environmentDetail: "objectDistance = value × 100 (the same multiplier, FrameXmlSettingsCVar.ts)",
  groundEffectDist: "grassRadius, yards (both are «Ground Clutter Radius», FrameXmlSettingsCVar.ts)",
  extShadowQuality: "lightingQuality: > 0 → 3 «сравнение» (classic light + quality 1's shadow pass), 0 → 0",
  farclip: "no setting yet: the detail window by farclip is 7.08 slice B («Дальность рельефа»); until then the fixed 3×3 window and Light.dbc fog",
  weatherDensity: "identity: weather draws its full rate, which is the client's top level 3 (benilla reads 1.12's table as {0.1, 0.33, 0.66, 1.0}); no scale for 0–2 exists here",
  specular: "recorded, not applied: the terrainSpecular render switch stays off until Wow.exe's c[27] colour is read (7.16 Г); the comparison level already gives the term full strength",
  groundEffectDensity: "not mapped: doodads per chunk against grassDensity's multiplier over the table (FrameXmlSettingsCVar.ts); grassDensity stays 1",
  projectedTextures: "not mapped: the blob shadow under units with the shadow pass off is not implemented (7.20 step 3); the comparison level has the pass on",
  textureFilteringMode: "not mapped: no texture-filtering setting; the renderer's own anisotropy applies",
});

/** 05.10-7.20: `SET <key> "<value>"` lines whose key is allowlisted; names compare case-insensitively. */
export function readConfigWtfAllowlisted(text: string): Record<string, string> {
  const canonical = new Map(COMPARISON_CONFIG_WTF_KEYS.map((key) => [key.toLowerCase(), key]));
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*SET\s+(\S+)\s+"([^"]*)"\s*$/i.exec(line);
    if (!match) continue;
    const key = canonical.get(match[1]!.toLowerCase());
    if (key !== undefined) values[key] = match[2]!;
  }
  return values;
}

/** 05.10-7.20: the settings the allowlisted values drive (see `COMPARISON_CONFIG_WTF_MAPPING`). */
export function comparisonOverridesFromConfigValues(values: Readonly<Record<string, string>>): Partial<SettingValues> {
  const overrides: Partial<SettingValues> = {};
  const put = (id: string, value: number): void => {
    const definition = settingDefinition(id);
    if (!definition || !Number.isFinite(value)) return;
    overrides[id] = coerceSetting(definition, value);
  };
  const number = (key: string): number => {
    const text = values[key];
    return text === undefined || text.trim() === "" ? Number.NaN : Number(text);
  };
  put("objectDistance", number("environmentDetail") * 100);
  put("grassRadius", number("groundEffectDist"));
  const shadows = number("extShadowQuality");
  if (Number.isFinite(shadows)) put("lightingQuality", shadows > 0 ? LIGHTING_QUALITY_COMPARISON : 0);
  return overrides;
}

/** 05.10-7.20: a `Config.wtf` text straight to settings; nothing outside the allowlist is read. */
export function comparisonOverridesFromConfigWtf(text: string): Partial<SettingValues> {
  return comparisonOverridesFromConfigValues(readConfigWtfAllowlisted(text));
}

/**
 * A stable WebClient control image for side-by-side capture. This removes optional additions and
 * adaptive resolution, but it is not a claim that uncalibrated camera, light or grass settings
 * already match the original client. Keep those scene-specific values in capture metadata.
 */
export const COMPARISON_GRAPHICS_OVERRIDES: Readonly<SettingValues> = Object.freeze({
  renderScale: 100,
  autoQuality: false,
  // 05.10-7.20: the reference install runs extShadowQuality 5, so the comparison frame has shadows
  // (the earlier reading "shadowLevel=0" was the old key). Quality 1/2 add this renderer's own warm/
  // cool grade, so the profile takes level 3 «сравнение»: the classic frame plus quality 1's pass.
  // objectDistance 150 and grassRadius 140 are the same file's environmentDetail and groundEffectDist.
  ...comparisonOverridesFromConfigValues(COMPARISON_CONFIG_WTF),
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
