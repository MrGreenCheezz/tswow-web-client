/**
 * The settings window, and the one place that applies what it says.
 *
 * There was no settings window and no notion of a client option at all. Three preferences existed
 * and each kept itself in `localStorage` under its own key; everything else was a constant.
 *
 * `apply()` is the whole point: every option here reaches something on screen the moment it
 * changes, and the same function runs when the server's copy of the blob lands. Nothing polls.
 */

import { AccountStore } from "../AccountStore.js";
import { showActionBar } from "./ActionBar.js";
import { setAutoQualityCeiling } from "../AutoQuality.js";
import { PER_CHARACTER_CONFIG_CACHE } from "../../world/SessionProtocol.js";
import { game } from "../game/Context.js";
import { setMinimapRotation } from "./Minimap.js";
import { setSpellbookRankFilter } from "./Spellbook.js";
import {
  SETTING_DEFINITIONS, cameraCeilingYards, coerceSetting, defaultSettings, parseSettings,
  serialiseSettings, settingBoolean, settingDefinition, settingMatchesQuery, settingNumber,
  type SettingDefinition, type SettingGroup, type SettingValues,
} from "./SettingsModel.js";
import { wireSettingsNavigation, type SettingsNavigation } from "./SettingsNavigation.js";
import { sectionSettings } from "./SettingsSections.js";
import { comparisonGraphicsSettings } from "./ComparisonProfile.js";
import { enhancedGraphicsSettings } from "./EnhancedGraphics.js";
import { setTip, Panel } from "./Widgets.js";
import { setFpsCounterVisible } from "./FpsCounter.js";
import {
  closeFrameXmlOptions, frameXmlOptionsOpen, toggleFrameXmlOptions,
} from "../framexml/FrameXmlOptionsController.js";

export const settingsStore = new AccountStore<SettingValues>({
  slot: PER_CHARACTER_CONFIG_CACHE,
  mirrorKey: "webclient.settings.v1",
  fallback: defaultSettings,
  parse: parseSettings,
  serialise: serialiseSettings,
});

let panel: Panel | undefined;
let settingsList: HTMLElement | undefined;
let settingsNote: HTMLElement | undefined;
let settingsNavigation: SettingsNavigation | undefined;
/**
 * Where the list was left, per tab (and one slot for search results): «Эффекты» is long enough to
 * scroll, and switching to «Звук» and back must not throw the player to its top.
 */
const SEARCH_VIEW = "\u0000search";
const scrollByView = new Map<string, number>();
let shownView: string | undefined;
let shownQuery = "";
/**
 * Keys the focused list consumes for its own scrolling. The game's bindings listen on the window
 * (Controls.ts), so without this an arrow key scrolled the list and walked the character at once.
 */
const LIST_SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"]);
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

/** The native window, or a stock options frame while the FrameXML interface owns the route. */
export function settingsWindowOpen(): boolean {
  return (panel?.visible ?? false) || frameXmlOptionsOpen();
}

export function closeSettingsWindow(): void {
  panel?.hide();
  closeFrameXmlOptions();
}

/**
 * Open the native window on one section: the fallback of the stock GameMenuFrame's «Изображение»,
 * «Звук» and «Интерфейс» while their Video/Audio/InterfaceOptionsFrame are not published or failed
 * to load (FrameXmlOptionsOwner.ts).
 */
export function openSettingsSection(group: SettingGroup): void {
  panel ??= build();
  if (!panel.visible) panel.show();
  // `select` clears the search and redraws through drawSettings, now that the panel is visible.
  if (settingsNavigation) settingsNavigation.select(group);
  else drawSettings();
}

/**
 * `/settings` and the native menu's «Настройки»: the stock InterfaceOptionsFrame on its «WebClient»
 * category once the FrameXML interface has published it, which carries every setting of this window.
 */
export function toggleSettingsWindow(): void {
  const wasOpen = panel?.visible ?? false;
  if (!wasOpen) {
    if (toggleFrameXmlOptions("webclient")) return;
    // A stock frame whose show failed has opened this window in its place (the owner's onFailure →
    // openSettingsSection) and answered false: that window is the answer, not one to toggle shut.
    if (panel?.visible) return;
  }
  panel ??= build();
  if (panel.visible) {
    panel.hide();
    return;
  }
  panel.show();
  drawSettings();
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
  const uiScale = settingNumber(values, "uiScale");
  // A unitless factor for the HUD and game-window layer. The world canvases intentionally do not
  // consume it: changing interface size must not lower the scene's render resolution.
  document.documentElement.style.setProperty("--ui-scale", String(uiScale / 100));
  document.documentElement.dataset["uiScale"] = String(uiScale);
  document.documentElement.style.setProperty(
    "--chat-log-height", `${settingNumber(values, "chatLogHeight")}px`);
  setMinimapRotation(settingBoolean(values, "minimapRotate"));
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
  // The spellbook's own switch, pushed for the same reason as the render scale: the book is drawn
  // long before the account's blob lands, and the checkbox in its header has to follow the value
  // the server holds rather than the other way round.
  setSpellbookRankFilter(settingBoolean(values, "spellbookHideLowerRanks"));
  // Four of the switches decide whether an action bar row exists on screen at all.
  showActionBar();
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

function build(): Panel {
  const created = new Panel({ id: "settings-window", title: "Настройки", className: "settings-window" });

  const settingsTabs = document.createElement("nav");
  settingsTabs.className = "settings-groups";
  settingsTabs.setAttribute("role", "tablist");
  settingsTabs.setAttribute("aria-label", "Разделы настроек");

  const search = document.createElement("label");
  search.className = "settings-search";
  const searchLabel = document.createElement("span");
  searchLabel.textContent = "Поиск";
  const settingsSearch = document.createElement("input");
  settingsSearch.type = "search";
  settingsSearch.autocomplete = "off";
  settingsSearch.placeholder = "По всем разделам";
  search.append(searchLabel, settingsSearch);
  settingsNavigation = wireSettingsNavigation(settingsTabs, settingsSearch, drawSettings);

  settingsList = document.createElement("section");
  settingsList.id = "settings-options";
  settingsList.className = "settings-options";
  settingsList.setAttribute("role", "tabpanel");
  // Focusable, so a click on a hint or the Tab key gives the list the keyboard for scrolling.
  settingsList.tabIndex = 0;
  const list = settingsList;
  list.addEventListener("keydown", (event) => {
    if (event.target !== list || !LIST_SCROLL_KEYS.has(event.key)) return;
    event.stopPropagation();
  });
  list.addEventListener("scroll", () => {
    if (shownView !== undefined) scrollByView.set(shownView, list.scrollTop);
  }, { passive: true });

  const content = document.createElement("div");
  content.className = "settings-content";
  content.append(search, settingsList);

  const shell = document.createElement("div");
  shell.className = "settings-shell";
  shell.append(settingsTabs, content);

  settingsNote = document.createElement("p");
  settingsNote.className = "muted settings-storage-note";
  const enhanced = document.createElement("button");
  enhanced.type = "button";
  enhanced.textContent = "Улучшенная графика";
  setTip(enhanced, "Мягкие тени, атмосферная дымка, солнечные лучи и эффекты воды. Масштаб отрисовки сохранится.");
  enhanced.addEventListener("click", () => { applySettingsPreset("enhanced"); });
  const comparison = document.createElement("button");
  comparison.type = "button";
  comparison.textContent = "Контрольный профиль графики";
  // 05.10-7.20: the profile now carries the reference install's Config.wtf values (ComparisonProfile.ts).
  setTip(comparison, "Как оригинал владельца: освещение «сравнение» (исходный свет и тени), объекты 150%, трава 140 ярдов, масштаб 100%, без автокачества и дополнительных эффектов; остальные настройки сохранены.");
  comparison.addEventListener("click", () => { applySettingsPreset("comparison"); });
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Сбросить настройки";
  reset.addEventListener("click", () => {
    settingsStore.set(defaultSettings());
    clearFrameXmlUrlOverride();
    applySettings();
    drawSettings();
  });
  const footer = document.createElement("footer");
  footer.className = "settings-footer";
  footer.append(settingsNote, enhanced, comparison, reset);
  created.body.append(shell, footer);
  return created;
}

/**
 * One of the two graphics profiles, through the same store and apply path: the footer of this
 * window and the stock «WebClient» category's buttons (FrameXmlOptions.ts).
 */
export function applySettingsPreset(kind: "enhanced" | "comparison"): void {
  const values = settingsStore.value;
  settingsStore.set(kind === "enhanced" ? enhancedGraphicsSettings(values) : comparisonGraphicsSettings(values));
  applySettings();
  drawSettings();
}

/** Where the settings are kept, said plainly: the question «where did my settings go» answered. */
export function settingsStorageNote(): string {
  return game.world
    ? "Настройки хранятся на сервере, у этого персонажа."
    : "Нет соединения — настройки пока только в этом браузере.";
}

function clearFrameXmlUrlOverride(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("framexml")) return;
  url.searchParams.delete("framexml");
  window.history.replaceState(window.history.state, "", url);
}

function change(definition: SettingDefinition, value: unknown, redraw = true): boolean | number {
  const coerced = coerceSetting(definition, value);
  const next = { ...settingsStore.value, [definition.id]: coerced };
  settingsStore.set(next);
  if (definition.id === "originalFrameXml") {
    // A user choice supersedes an earlier diagnostic URL override without reconnecting.
    clearFrameXmlUrlOverride();
  }
  applySettings();
  if (redraw) drawSettings();
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
  change(definition, value);
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

export function drawSettings(): void {
  if (!panel?.visible || !settingsNavigation || !settingsList || !settingsNote) return;
  const values = settingsStore.value;
  const rows: HTMLElement[] = [];
  const query = settingsNavigation.query;
  const searched = query.trim().length > 0;

  if (searched) {
    settingsList.removeAttribute("aria-labelledby");
    settingsList.setAttribute("aria-label", "Результаты поиска настроек");
  } else {
    settingsList.removeAttribute("aria-label");
    settingsList.setAttribute("aria-labelledby", settingsNavigation.activeTabId);
  }

  for (const group of settingsNavigation.groups) {
    const inGroup = SETTING_DEFINITIONS.filter((definition) =>
      definition.group === group && !definition.ownWindow && settingMatchesQuery(definition, query));
    if (inGroup.length === 0) continue;
    const heading = document.createElement("h4");
    heading.className = "settings-group-title";
    heading.textContent = group;
    rows.push(heading);
    // A long group (SettingsSections.ts) is drawn under its subsection titles; the rest stay one list.
    for (const block of sectionSettings(group, inGroup, (definition) => definition.id)) {
      if (block.title !== undefined) {
        const title = document.createElement("h5");
        title.className = "settings-section-title";
        title.textContent = block.title;
        rows.push(title);
      }
      for (const definition of block.items) rows.push(settingRow(definition, values));
    }
  }

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted settings-empty";
    empty.textContent = "Ничего не найдено. Попробуйте другое слово.";
    rows.push(empty);
  }

  const focusedId = settingsList.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset["settingId"]
    : undefined;
  // Each tab keeps its own scroll position; a new search query starts its results at the top.
  const view = searched ? SEARCH_VIEW : settingsNavigation.active;
  if (searched && query !== shownQuery) scrollByView.set(SEARCH_VIEW, 0);
  shownView = view;
  shownQuery = searched ? query : "";
  settingsList.replaceChildren(...rows);
  if (focusedId) {
    settingsList.querySelector<HTMLElement>(`[data-setting-id="${focusedId}"]`)?.focus({ preventScroll: true });
  }
  settingsList.scrollTop = scrollByView.get(view) ?? 0;

  settingsNote.textContent = settingsStorageNote();
}

function settingRow(definition: SettingDefinition, values: SettingValues): HTMLElement {
  const row = document.createElement("div");
  row.className = "setting-row";
  const label = document.createElement("label");
  label.className = "setting-label";
  const text = document.createElement("span");
  text.textContent = definition.label;

  if (definition.kind === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset["settingId"] = definition.id;
    input.checked = settingBoolean(values, definition.id);
    input.addEventListener("change", () => {
      input.checked = change(definition, input.checked, false) === true;
    });
    label.append(input, text);
  } else {
    const input = document.createElement("input");
    input.type = "number";
    input.dataset["settingId"] = definition.id;
    input.min = String(definition.min ?? 0);
    input.max = String(definition.max ?? 9999);
    input.step = String(definition.step ?? 1);
    input.value = String(settingNumber(values, definition.id));
    input.addEventListener("change", () => {
      input.value = String(change(definition, Number(input.value), false));
    });
    label.append(text, input);
  }
  row.append(label);
  if (definition.hint) {
    const hint = document.createElement("p");
    hint.className = "muted setting-hint";
    hint.textContent = definition.hint;
    row.append(hint);
  }
  return row;
}
