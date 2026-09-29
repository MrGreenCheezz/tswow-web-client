/**
 * Subsections of a settings group that has grown too long to read as one list.
 *
 * Presentation only: ids, groups, defaults and stored values stay SettingsModel.ts's, and nothing
 * here is written to the account blob. Both views draw from this one table — the native settings
 * window (Settings.ts) and the stock «WebClient» options panels (FrameXmlOptions.ts) — so the two
 * name and order the same sections.
 *
 * DOM-free, like the model.
 */

import type { SettingGroup } from "./SettingsModel.js";

export interface SettingSection {
  readonly title: string;
  /** Setting ids in the order the section shows them. */
  readonly ids: readonly string[];
}

/**
 * «Эффекты» holds some thirty switches. The sections follow what a player looks for: the light and
 * the air, the water, shadows and relief, and the weather with its wind and sounds.
 */
export const SETTING_SECTIONS: Readonly<Partial<Record<SettingGroup, readonly SettingSection[]>>> = Object.freeze({
  "Эффекты": Object.freeze([
    Object.freeze({
      title: "Свет и атмосфера",
      // Each strength slider follows what it scales: the shaft one its own leaf, the cinematic one
      // the four leaves — bloom, grade, scattering, sun shafts.
      ids: Object.freeze([
        "fullscreenGlow", "experimentalCinematicBloom", "experimentalCinematicGrade", "experimentalSunScattering",
        "godRays", "godRayStrength", "cinematicStrength", "experimentalAerialHeightFog", "experimentalLowSunRimLight",
        "experimentalFantasyGlow",
      ]),
    }),
    Object.freeze({
      title: "Вода",
      ids: Object.freeze([
        "experimentalWaterFresnel", "experimentalWaterSkyReflection", "experimentalWaterMicroWaves",
        "experimentalWaterSunSparkle", "experimentalWaterSunGlitter", "experimentalWaterFoam", "underwaterOverlay",
      ]),
    }),
    Object.freeze({
      title: "Тени и рельеф",
      ids: Object.freeze([
        "experimentalSceneryShadows", "experimentalAmbientOcclusion", "experimentalTerrainMicroNormals",
      ]),
    }),
    Object.freeze({
      title: "Погода и ветер",
      ids: Object.freeze([
        "experimentalVegetationWind", "experimentalWindGusts", "experimentalRainStreaks", "experimentalRainSplashes",
        "experimentalWetSurfaces", "experimentalLightning", "experimentalAmbientMotes", "experimentalWeatherSounds",
      ]),
    }),
  ]),
});

/** Where a sectioned group's settings that no section names are drawn, so a new one is never lost. */
export const OTHER_SETTINGS_SECTION = "Прочее";

export interface SettingSectionBlock<T> {
  /** Undefined for a group that has no sections: its settings are one untitled list. */
  readonly title: string | undefined;
  readonly items: readonly T[];
}

/**
 * Splits one group's items (definitions in the window, controls in the stock panel) into its
 * sections: sections in table order, each in its own id order, empty ones dropped, and whatever no
 * section names last under {@link OTHER_SETTINGS_SECTION} in the order it came.
 */
export function sectionSettings<T>(
  group: SettingGroup,
  items: readonly T[],
  idOf: (item: T) => string,
): SettingSectionBlock<T>[] {
  const sections = SETTING_SECTIONS[group];
  if (!sections) return items.length > 0 ? [{ title: undefined, items: [...items] }] : [];
  const byId = new Map(items.map((item) => [idOf(item), item] as const));
  const placed = new Set<string>();
  const blocks: SettingSectionBlock<T>[] = [];
  for (const section of sections) {
    const found: T[] = [];
    for (const id of section.ids) {
      const item = byId.get(id);
      if (item === undefined || placed.has(id)) continue;
      placed.add(id);
      found.push(item);
    }
    if (found.length > 0) blocks.push({ title: section.title, items: found });
  }
  const rest = items.filter((item) => !placed.has(idOf(item)));
  if (rest.length > 0) blocks.push({ title: OTHER_SETTINGS_SECTION, items: rest });
  return blocks;
}
