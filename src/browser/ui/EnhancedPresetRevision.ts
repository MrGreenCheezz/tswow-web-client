/**
 * 25.10: options the «Улучшенная графика» preset gained after players had already pressed it.
 *
 * The blob keeps only what differs from the defaults (SettingsModel.ts `serialiseSettings`), so a
 * player who applied the preset before an option joined it keeps that option at its default — off,
 * when the default is Wow.exe's look. Each revision lists the preset keys whose default is not the
 * preset's value; a blob that reads as the enhanced profile and carries an older revision receives
 * them once on parse. Every blob written while it reads as the enhanced profile records the current
 * revision (SettingsModel.ts `serialiseSettings`), so a later opt-out is not undone.
 *
 * Import-free on purpose: SettingsModel.ts reads and writes it.
 */

export const ENHANCED_PRESET_REVISION_SETTING = "enhancedPresetRevision";

export const ENHANCED_PRESET_REVISIONS: readonly (Readonly<Record<string, boolean | number>>)[] = Object.freeze([
  Object.freeze({ experimentalLivingSpells: true }), // revision 1: 23.10 (6.27)
]);

export const ENHANCED_PRESET_REVISION = ENHANCED_PRESET_REVISIONS.length;

/**
 * The preset's own off-by-default switches as of revision 0. A blob with most of them on is a
 * player on the enhanced profile; the comparison profile and the defaults have them all off.
 */
export const ENHANCED_PROFILE_MARKERS: readonly string[] = Object.freeze([
  "experimentalAerialHeightFog", "experimentalAmbientMotes", "experimentalAmbientOcclusion",
  "experimentalCinematicBloom", "experimentalCinematicGrade", "experimentalLightning",
  "experimentalRainSplashes", "experimentalRainStreaks", "experimentalSceneryShadows",
  "experimentalSunScattering", "experimentalWeatherSounds", "experimentalWetSurfaces",
  "experimentalWindGusts", "godRays",
]);

/** Three quarters of the markers: a player who turned a few of them off is still on the profile. */
const MARKER_SHARE = 0.75;

export function readsAsEnhancedProfile(raw: Readonly<Record<string, unknown>>): boolean {
  let on = 0;
  for (const id of ENHANCED_PROFILE_MARKERS) if (raw[id] === true) on++;
  return on >= ENHANCED_PROFILE_MARKERS.length * MARKER_SHARE;
}

/**
 * Applies the revisions a stored blob has not seen yet, into `values` (already parsed and coerced
 * by the caller); returns whether anything changed. The revision itself is a key of the blob, not a
 * setting: the next write records it. A blob that is not the enhanced profile is left alone.
 */
export function migrateEnhancedPreset(
  raw: Readonly<Record<string, unknown>>,
  values: Record<string, boolean | number>,
): boolean {
  const stored = typeof raw[ENHANCED_PRESET_REVISION_SETTING] === "number"
    ? raw[ENHANCED_PRESET_REVISION_SETTING] as number : 0;
  if (stored >= ENHANCED_PRESET_REVISION || !readsAsEnhancedProfile(raw)) return false;
  for (const revision of ENHANCED_PRESET_REVISIONS.slice(Math.max(0, stored))) Object.assign(values, revision);
  return true;
}
