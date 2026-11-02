/**
 * The client's options: the store, and the one place that applies what it says.
 *
 * There was no settings window and no notion of a client option at all. Three preferences existed
 * and each kept itself in `localStorage` under its own key; everything else was a constant.
 *
 * `apply()` is the whole point: every option here reaches something on screen the moment it
 * changes, and the same function runs when the server's copy of the blob lands. Nothing polls.
 */

import { AccountStore } from "../AccountStore.js";
import { refreshActionSlots } from "./ActionSlots.js";
import { setAutoQualityCeiling } from "../AutoQuality.js";
import { PER_CHARACTER_CONFIG_CACHE } from "../../world/SessionProtocol.js";
import { game } from "../game/Context.js";
import {
  cameraCeilingYards, coerceSetting, defaultSettings, parseSettings,
  serialiseSettings, settingBoolean, settingDefinition, settingNumber,
  type SettingDefinition, type SettingValues,
} from "./SettingsModel.js";
import { comparisonGraphicsSettings } from "./ComparisonProfile.js";
import { enhancedGraphicsSettings } from "./EnhancedGraphics.js";
import { setFpsCounterVisible } from "./FpsCounter.js";
import { frameLimitOverride, setFrameLimit } from "../FrameLimit.js"; // 25.10

export const settingsStore = new AccountStore<SettingValues>({
  slot: PER_CHARACTER_CONFIG_CACHE,
  mirrorKey: "webclient.settings.v1",
  fallback: defaultSettings,
  parse: parseSettings,
  serialise: serialiseSettings,
});

const appliedListeners = new Set<() => void>();

/** World-scoped consumers unsubscribe on exit, before another character's settings arrive. */
export function watchSettingsApplied(listener: () => void): () => void {
  appliedListeners.add(listener);
  return () => { appliedListeners.delete(listener); };
}

export function settings(): SettingValues {
  return settingsStore.value;
}

export function settingOn(id: string): boolean {
  return settingBoolean(settingsStore.value, id);
}

/**
 * How far the wheel is allowed to let the camera out, in yards.
 *
 * Read at every notch rather than pushed into the camera when it changes: the wheel is the only
 * thing that consults it, and a copy kept anywhere else is a copy that can be stale. `applySettings`
 * still has to pull an already-zoomed-out camera back in, because lowering the ceiling has to be
 * visible without touching the wheel.
 */
export function cameraMaxDistance(): number {
  return cameraCeilingYards(settingsStore.value);
}

/**
 * Puts every option into effect.
 *
 * Called on every change and once when the account's copy arrives, so the two can never disagree.
 * Options whose owner is not built yet — there are none today — would be read where they are used
 * rather than pushed from here.
 */
export function applySettings(): void {
  const values = settingsStore.value;
  setFpsCounterVisible(settingBoolean(values, "showFps"));
  setFrameLimit(frameLimitOverride(globalThis.location?.search ?? "") ?? settingNumber(values, "frameLimit")); // 25.10
  const uiScale = settingNumber(values, "uiScale");
  // A unitless factor for the HUD and game-window layer. The world canvases intentionally do not
  // consume it: changing interface size must not lower the scene's render resolution.
  document.documentElement.style.setProperty("--ui-scale", String(uiScale / 100));
  document.documentElement.dataset["uiScale"] = String(uiScale);
  document.documentElement.style.setProperty(
    "--chat-log-height", `${settingNumber(values, "chatLogHeight")}px`);
  // The cheapest graphics option this client has. Fill rate is what a city costs most of, and the
  // splat shader is what it costs it in, so drawing at three quarters is three quarters of it.
  // The value is also the auto-quality ceiling: the governor may only go down from here.
  const renderScale = settingNumber(values, "renderScale");
  game.renderer?.setRenderScale(renderScale / 100);
  setAutoQualityCeiling(renderScale);
  // A bounded unit-shadow pass plus a light-balance profile. Zero restores the exact renderer
  // baseline that pre-dates the option; capability fallback happens inside the renderer.
  game.renderer?.setLightingQuality(settingNumber(values, "lightingQuality"));
  // Static WMO rooms only. Old artifacts, open air and moving world objects retain their distance
  // selection even while this option is enabled.
  game.renderer?.setWmoOcclusion(settingBoolean(values, "wmoOcclusion"));
  // R1 A/B candidate only: the renderer's default remains anisotropy 1, and this setting can roll
  // its cached character atlases back to that baseline without changing their ownership.
  game.renderer?.setCharacterAtlasAnisotropy(settingBoolean(values, "characterAtlasAnisotropy"));
  // Independently reversible atmosphere, terrain and water effects. The enhanced preset enables
  // aerial fog; the comparison profile disables every optional leaf for repeatable captures.
  game.renderer?.setExperimentalShaderProfile?.({
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
  game.renderer?.setUnderwaterOverlay?.(settingBoolean(values, "underwaterOverlay"));
  // 22.10 (7.47): «Объём земли», its own leaf; the renderer draws it on the enhanced levels only.
  game.renderer?.setTerrainRelief?.(settingBoolean(values, "experimentalTerrainRelief"));
  // 25.10 (7.47): «Нейросетевой объём», the ground's maps from the gateway's neural set (TerrainReliefNeural.ts).
  game.renderer?.setNeuralRelief?.(settingBoolean(values, "experimentalNeuralRelief"));
  // 22.10 (7.47 stage 2): «Объём зданий», its own leaf; enhanced levels only.
  game.renderer?.setWmoRelief?.(settingBoolean(values, "experimentalWmoRelief"));
  // 23.10 (7.47 stage 3): «Объём предметов», its own leaf; enhanced levels only.
  game.renderer?.setM2Relief?.(settingBoolean(values, "experimentalModelRelief"));
  // 24.10 (7.47): «Сила объёма», a multiplier over all three; a percentage on the account.
  game.renderer?.setReliefStrength?.(settingNumber(values, "reliefStrength") / 100);
  // 23.10 (6.27): «Живые эффекты заклинаний», its own leaf (SpellParticleLook.ts, SpellLights.ts).
  game.renderer?.setLivingSpells?.(settingBoolean(values, "experimentalLivingSpells"));
  // 26.10 (6.27, test): «Плотные эффекты заклинаний» (SpellDensity.ts).
  game.renderer?.setSpellDensity?.(settingBoolean(values, "experimentalSpellDensity"));
  // 26.10 (6.27, test): «Шлейфы снарядов» (MissileTrails.ts).
  game.renderer?.setMissileTrails?.(settingBoolean(values, "experimentalMissileTrails"));
  // 26.10: «Лучи над добычей» (LootBeams.ts).
  game.renderer?.setLootBeams?.(settingBoolean(values, "experimentalLootBeams"));
  // 23.10 (7.48): «Чёткие текстуры эффектов» (HdEffectTextures.ts).
  game.renderer?.setHdEffectTextures?.(settingBoolean(values, "experimentalSharpEffectTextures"));
  // 23.10 (7.48 step 2): «Чёткие текстуры мира» (HdWorldTextures.ts).
  game.renderer?.setHdWorldTextures?.(settingBoolean(values, "experimentalSharpWorldTextures"));
  // The classic glow and solar rays are independent leaves sharing one offscreen scene path. Each
  // switch controls only its own effect; the direct pre-P4 path is selected only when both are OFF.
  game.renderer?.setFullscreenGlow?.(settingBoolean(values, "fullscreenGlow"));
  game.renderer?.setGodRays?.(settingBoolean(values, "godRays"));
  // The shaft multiplier over the quality ceiling, on both shaft paths; a percentage on the account.
  game.renderer?.setGodRayStrength?.(settingNumber(values, "godRayStrength") / 100);
  // Cinematic leaves of the enhanced preset (CinematicPost.ts); all off is the pre-existing frame.
  game.renderer?.setCinematicProfile?.({
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
  game.renderer?.setCinematicStrength?.(settingNumber(values, "cinematicStrength") / 100);
  // Wind, weather and ambient life (AtmosphereEffects.ts); all off creates nothing.
  game.renderer?.setAtmosphereEffects?.({
    windGusts: settingBoolean(values, "experimentalWindGusts"),
    rainStreaks: settingBoolean(values, "experimentalRainStreaks"),
    rainSplashes: settingBoolean(values, "experimentalRainSplashes"),
    wetSurfaces: settingBoolean(values, "experimentalWetSurfaces"),
    lightning: settingBoolean(values, "experimentalLightning"),
    ambientMotes: settingBoolean(values, "experimentalAmbientMotes"),
    weatherSounds: settingBoolean(values, "experimentalWeatherSounds"),
  });
  // The stock «Детализация ландшафта» multiplier over every M2 scenery leash; a percentage here.
  game.renderer?.setEnvironmentDetail?.(settingNumber(values, "objectDistance") / 100);
  // How far the ground cover reaches, and whether its density is read per detail cell. Pushed for
  // the same reason as the render scale: it is read deep inside a frame, and a copy kept anywhere
  // else is a copy that can be stale. Outside the world `game.groundCover` is undefined, which
  // takes the field down without a second switch.
  game.renderer?.setGroundCover(game.groundCover, settingNumber(values, "grassRadius"), settingBoolean(values, "grassDense"), settingNumber(values, "grassDensity"));
  // Lowering the ceiling has to move a camera that is already outside it, or the option does
  // nothing at all until the next notch of the wheel and reads as broken. Raising it does not pull
  // the camera out: where the player put it is still where the player put it.
  const maxDistance = cameraCeilingYards(values);
  if (game.camera.distance > maxDistance) game.camera.distance = maxDistance;
  // Four of the switches decide whether an action bar row exists on screen at all.
  refreshActionSlots();
  applySoundVolumes();
  for (const listener of appliedListeners) listener();
}

/**
 * The sliders and their switches, pushed into whichever player is alive.
 *
 * Separate from `applySettings` because it is also called the moment a player is built: entering a
 * world happens long after the account's settings have landed, and a player that started at its
 * own defaults would be at the wrong volume until the next time something was changed.
 */
export function applySoundVolumes(): void {
  const sound = game.sound;
  if (!sound) return;
  const values = settingsStore.value;
  // A switched-off channel is silent at its own slider's value, so switching it back on restores it.
  const level = (enabled: string, volume: string): number =>
    settingBoolean(values, enabled) ? settingNumber(values, volume) / 100 : 0;
  sound.setVolume("master", level("soundEnabled", "volumeMaster"));
  sound.setVolume("effects", level("soundEffectsEnabled", "volumeEffects"));
  sound.setVolume("music", level("musicEnabled", "volumeMusic"));
  sound.setVolume("ambience", level("ambienceEnabled", "volumeAmbience"));
  sound.setVolume("interface", settingNumber(values, "volumeInterface") / 100);
}

/**
 * One of the two graphics profiles, through the same store and apply path: the footer of the HTML
 * window and the stock «WebClient» category's buttons (FrameXmlOptions.ts).
 */
export function applySettingsPreset(kind: "enhanced" | "comparison"): void {
  const values = settingsStore.value;
  settingsStore.set(kind === "enhanced" ? enhancedGraphicsSettings(values) : comparisonGraphicsSettings(values));
  applySettings();
}

/** Where the settings are kept, said plainly: the question «where did my settings go» answered. */
export function settingsStorageNote(): string {
  return game.world
    ? "Настройки хранятся на сервере, у этого персонажа."
    : "Нет соединения — настройки пока только в этом браузере.";
}

/** One declared setting through the store and apply path; the value as it was coerced. */
export function changeSetting(definition: SettingDefinition, value: unknown): boolean | number {
  const coerced = coerceSetting(definition, value);
  const next = { ...settingsStore.value, [definition.id]: coerced };
  settingsStore.set(next);
  applySettings();
  return coerced;
}

/**
 * Changes one declared setting through the same account-store and apply path as the window.
 *
 * FrameXML's options panels use this (FrameXmlSettingsCVar.ts) instead of reaching into `settingsStore`: a typo or
 * an option this client does not own is rejected, and a valid write cannot create a second state
 * map that survives only until the next account-data update.
 */
export function setSetting(id: string, value: unknown): boolean {
  const definition = settingDefinition(id);
  if (!definition) return false;
  changeSetting(definition, value);
  return true;
}

/**
 * Flips one switch from outside the window.
 *
 * The plate switches have a key on them, and a key press must go through the same path a click on
 * the checkbox does — the value is written to the account's blob, not to a module-level flag, and
 * the window redraws if it happens to be open.
 */
export function toggleSetting(id: string): void {
  const definition = settingDefinition(id);
  if (!definition || definition.kind !== "boolean") return;
  setSetting(id, !settingBoolean(settingsStore.value, id));
}
