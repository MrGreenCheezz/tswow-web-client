import { SETTING_GROUPS, type SettingGroup } from "./SettingsModel.js";

export const SETTINGS_NARROW_MEDIA = "(max-width: 560px)";

const UI_OWNED_TAB_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
  " ", "Space", "Spacebar", "Enter", "Tab",
]);

export interface SettingsNavigation {
  readonly active: SettingGroup;
  readonly activeTabId: string;
  readonly query: string;
  /** One selected group normally; every group while the global search has text. */
  readonly groups: readonly SettingGroup[];
  select(group: SettingGroup, focus?: boolean): void;
  dispose(): void;
}

/**
 * Owns the settings category rail and its keyboard boundary.
 *
 * The game listens for keys above the panel layer, so the rail must keep the keys it consumes from
 * reaching game bindings. Escape is deliberately absent: the window registry still owns it.
 */
export function wireSettingsNavigation(
  tabs: HTMLElement,
  search: HTMLInputElement,
  onChange: () => void,
  media: MediaQueryList = window.matchMedia(SETTINGS_NARROW_MEDIA),
): SettingsNavigation {
  const buttons = new Map<SettingGroup, HTMLButtonElement>();
  let active: SettingGroup = SETTING_GROUPS[0];

  const syncTabs = (): void => {
    for (const [group, button] of buttons) {
      const selected = group === active;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  };
  const syncOrientation = (): void => {
    tabs.setAttribute("aria-orientation", media.matches ? "horizontal" : "vertical");
  };

  const navigation: SettingsNavigation = {
    get active() { return active; },
    get activeTabId() { return buttons.get(active)?.id ?? ""; },
    get query() { return search.value; },
    get groups() { return search.value.trim() ? SETTING_GROUPS : [active]; },
    select(group, focus = false) {
      active = group;
      search.value = "";
      syncTabs();
      onChange();
      if (focus) buttons.get(group)?.focus();
    },
    dispose() {
      media.removeEventListener("change", syncOrientation);
    },
  };

  for (const [index, group] of SETTING_GROUPS.entries()) {
    const button = tabs.ownerDocument.createElement("button");
    button.type = "button";
    button.id = `settings-group-${index}`;
    button.className = "settings-group-tab";
    button.textContent = group;
    button.dataset["settingsGroup"] = group;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "settings-options");
    button.addEventListener("click", () => navigation.select(group));
    button.addEventListener("keydown", (event) => {
      if (!UI_OWNED_TAB_KEYS.has(event.key)) return;
      event.stopPropagation();

      let next: number | undefined;
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        next = (index - 1 + SETTING_GROUPS.length) % SETTING_GROUPS.length;
      } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        next = (index + 1) % SETTING_GROUPS.length;
      } else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = SETTING_GROUPS.length - 1;
      // Space/Enter retain native button activation and Tab retains native focus traversal.
      if (next === undefined) return;
      event.preventDefault();
      navigation.select(SETTING_GROUPS[next] as SettingGroup, true);
    });
    buttons.set(group, button);
    tabs.append(button);
  }

  search.addEventListener("input", onChange);
  media.addEventListener("change", syncOrientation);
  syncTabs();
  syncOrientation();
  return navigation;
}
