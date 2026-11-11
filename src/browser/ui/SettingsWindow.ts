/**
 * The settings window: a list of every option, over the store and apply path in `Settings.ts`.
 */

import {
  SETTING_DEFINITIONS, resetSettingValues, settingBoolean, settingMatchesQuery, settingNumber,
  type SettingDefinition, type SettingGroup, type SettingValues,
} from "./SettingsModel.js";
import { wireSettingsNavigation, type SettingsNavigation } from "./SettingsNavigation.js";
import { sectionSettings } from "./SettingsSections.js";
import {
  applySettings, applySettingsPreset, changeSetting, settingsStorageNote, settingsStore, watchSettingsApplied,
} from "./Settings.js";
import { setTip, Panel } from "./Widgets.js";
import {
  closeFrameXmlOptions, frameXmlOptionsOpen, toggleFrameXmlOptions,
} from "../framexml/FrameXmlOptionsController.js";

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
    settingsStore.set(resetSettingValues(settingsStore.value)); // 4.16 (11.11): the move's mark stays
    applySettings();
  });
  const footer = document.createElement("footer");
  footer.className = "settings-footer";
  footer.append(settingsNote, enhanced, comparison, reset);
  created.body.append(shell, footer);
  return created;
}

/**
 * A row's own control changed: its value is what the player just wrote there, and the list stays as
 * it is around the focus, so this one apply does not redraw.
 */
let rowChanging = false;

function change(definition: SettingDefinition, value: unknown): boolean | number {
  rowChanging = true;
  try {
    return changeSetting(definition, value);
  } finally {
    rowChanging = false;
  }
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
      input.checked = change(definition, input.checked) === true;
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
      input.value = String(change(definition, Number(input.value)));
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

// Every apply reaches the window, wherever it came from: a stock options panel, a key, the account's
// copy landing. Only a visible window draws anything.
watchSettingsApplied(() => {
  if (!rowChanging) drawSettings();
});
