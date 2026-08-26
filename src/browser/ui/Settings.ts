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
import { PER_CHARACTER_CONFIG_CACHE } from "../../world/SessionProtocol.js";
import { game } from "../game/Context.js";
import { setMinimapRotation } from "./Minimap.js";
import { setSpellbookRankFilter } from "./Spellbook.js";
import {
  SETTING_DEFINITIONS, SETTING_GROUPS, coerceSetting, defaultSettings, parseSettings,
  serialiseSettings, settingBoolean, settingDefinition, settingNumber,
  type SettingDefinition, type SettingValues,
} from "./SettingsModel.js";
import { Panel } from "./Widgets.js";

export const settingsStore = new AccountStore<SettingValues>({
  slot: PER_CHARACTER_CONFIG_CACHE,
  mirrorKey: "webclient.settings.v1",
  fallback: defaultSettings,
  parse: parseSettings,
  serialise: serialiseSettings,
});

let panel: Panel | undefined;

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
  return settingNumber(settingsStore.value, "cameraMaxDistance");
}

export function settingsWindowOpen(): boolean {
  return panel?.visible ?? false;
}

export function closeSettingsWindow(): void {
  panel?.hide();
}

export function toggleSettingsWindow(): void {
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
  document.documentElement.style.setProperty(
    "--chat-log-height", `${settingNumber(values, "chatLogHeight")}px`);
  setMinimapRotation(settingBoolean(values, "minimapRotate"));
  // The cheapest graphics option this client has. Fill rate is what a city costs most of, and the
  // splat shader is what it costs it in, so drawing at three quarters is three quarters of it.
  game.renderer?.setRenderScale(settingNumber(values, "renderScale") / 100);
  // A bounded unit-shadow pass plus a light-balance profile. Zero restores the exact renderer
  // baseline that pre-dates the option; capability fallback happens inside the renderer.
  game.renderer?.setLightingQuality(settingNumber(values, "lightingQuality"));
  // Static WMO rooms only. Old artifacts, open air and moving world objects retain their distance
  // selection even while this option is enabled.
  game.renderer?.setWmoOcclusion(settingBoolean(values, "wmoOcclusion"));
  // How far the ground cover reaches, and whether its density is read per detail cell. Pushed for
  // the same reason as the render scale: it is read deep inside a frame, and a copy kept anywhere
  // else is a copy that can be stale. Outside the world `game.groundCover` is undefined, which
  // takes the field down without a second switch.
  game.renderer?.setGroundCover(game.groundCover, settingNumber(values, "grassRadius"), settingBoolean(values, "grassDense"));
  // Lowering the ceiling has to move a camera that is already outside it, or the option does
  // nothing at all until the next notch of the wheel and reads as broken. Raising it does not pull
  // the camera out: where the player put it is still where the player put it.
  const maxDistance = settingNumber(values, "cameraMaxDistance");
  if (game.camera.distance > maxDistance) game.camera.distance = maxDistance;
  // The spellbook's own switch, pushed for the same reason as the render scale: the book is drawn
  // long before the account's blob lands, and the checkbox in its header has to follow the value
  // the server holds rather than the other way round.
  setSpellbookRankFilter(settingBoolean(values, "spellbookHideLowerRanks"));
  // Four of the switches decide whether an action bar row exists on screen at all.
  showActionBar();
  applySoundVolumes();
}

/**
 * The four sliders, pushed into whichever player is alive.
 *
 * Separate from `applySettings` because it is also called the moment a player is built: entering a
 * world happens long after the account's settings have landed, and a player that started at its
 * own defaults would be at the wrong volume until the next time something was changed.
 */
export function applySoundVolumes(): void {
  const sound = game.sound;
  if (!sound) return;
  const values = settingsStore.value;
  sound.setVolume("master", settingNumber(values, "volumeMaster") / 100);
  sound.setVolume("effects", settingNumber(values, "volumeEffects") / 100);
  sound.setVolume("music", settingNumber(values, "volumeMusic") / 100);
  sound.setVolume("ambience", settingNumber(values, "volumeMusic") / 100);
  sound.setVolume("interface", settingNumber(values, "volumeInterface") / 100);
}

function build(): Panel {
  const created = new Panel({ id: "settings-window", title: "Настройки", className: "settings-window" });
  return created;
}

function change(definition: SettingDefinition, value: unknown): void {
  const next = { ...settingsStore.value, [definition.id]: coerceSetting(definition, value) };
  settingsStore.set(next);
  applySettings();
  drawSettings();
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
  change(definition, !settingBoolean(settingsStore.value, id));
}

export function drawSettings(): void {
  if (!panel?.visible) return;
  const values = settingsStore.value;
  const rows: HTMLElement[] = [];

  for (const group of SETTING_GROUPS) {
    const inGroup = SETTING_DEFINITIONS.filter((definition) => definition.group === group && !definition.ownWindow);
    if (inGroup.length === 0) continue;
    const heading = document.createElement("h4");
    heading.textContent = group;
    rows.push(heading);
    for (const definition of inGroup) rows.push(settingRow(definition, values));
  }

  const note = document.createElement("p");
  note.className = "muted";
  // Said plainly, because "where did my settings go" is the question this answers.
  note.textContent = game.world
    ? "Настройки хранятся на сервере, у этого персонажа."
    : "Нет соединения — настройки пока только в этом браузере.";
  rows.push(note);

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Сбросить настройки";
  reset.addEventListener("click", () => {
    settingsStore.set(defaultSettings());
    applySettings();
    drawSettings();
  });
  rows.push(reset);
  panel.body.replaceChildren(...rows);
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
    input.checked = settingBoolean(values, definition.id);
    input.addEventListener("change", () => change(definition, input.checked));
    label.append(input, text);
  } else {
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(definition.min ?? 0);
    input.max = String(definition.max ?? 9999);
    input.step = String(definition.step ?? 1);
    input.value = String(settingNumber(values, definition.id));
    input.addEventListener("change", () => change(definition, Number(input.value)));
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
