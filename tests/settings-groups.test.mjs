import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SETTING_DEFINITIONS, SETTING_GROUPS, settingMatchesQuery,
} from "../dist/code/browser/ui/SettingsModel.js";
import {
  SETTINGS_NARROW_MEDIA, wireSettingsNavigation,
} from "../dist/code/browser/ui/SettingsNavigation.js";
import {
  OTHER_SETTINGS_SECTION, SETTING_SECTIONS, sectionSettings,
} from "../dist/code/browser/ui/SettingsSections.js";

const settingsSource = new URL("../src/browser/ui/Settings.ts", import.meta.url);
const styleSource = new URL("../src/browser/style.css", import.meta.url);

function navigationFixture() {
  const document = {
    activeElement: undefined,
    createElement(tag) {
      const attributes = new Map();
      const classes = new Set();
      const listeners = new Map();
      const node = {
        tagName: tag.toUpperCase(), ownerDocument: document, parentNode: undefined,
        children: [], dataset: {}, className: "", id: "", type: "", textContent: "",
        value: "", tabIndex: 0,
        classList: {
          toggle(name, force) {
            const active = force === undefined ? !classes.has(name) : force;
            if (active) classes.add(name); else classes.delete(name);
            return active;
          },
          contains(name) { return classes.has(name); },
        },
        append(...children) {
          for (const child of children) child.parentNode = node;
          node.children.push(...children);
        },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        addEventListener(name, handler) {
          const handlers = listeners.get(name) ?? [];
          handlers.push(handler);
          listeners.set(name, handlers);
        },
        focus() { document.activeElement = node; },
        dispatch(type, key = "") {
          const event = {
            type, key, target: node, currentTarget: node,
            defaultPrevented: false, propagationStopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
          };
          for (let current = node; current && !event.propagationStopped; current = current.parentNode) {
            event.currentTarget = current;
            for (const handler of listenersFor(current, type)) handler(event);
          }
          return event;
        },
        _listeners: listeners,
      };
      return node;
    },
  };
  const listenersFor = (node, type) => node._listeners.get(type) ?? [];
  const mediaListeners = new Set();
  const media = {
    matches: false,
    addEventListener(name, handler) { if (name === "change") mediaListeners.add(handler); },
    removeEventListener(name, handler) { if (name === "change") mediaListeners.delete(handler); },
    setMatches(matches) {
      this.matches = matches;
      for (const handler of mediaListeners) handler({ matches });
    },
    listenerCount() { return mediaListeners.size; },
  };
  return { document, media };
}

test("client settings are distributed across small, named groups", () => {
  assert.deepEqual(SETTING_GROUPS, ["Игра", "Графика", "Эффекты", "Интерфейс", "Звук", "Чат"]);
  assert.equal(new Set(SETTING_DEFINITIONS.map((definition) => definition.id)).size, SETTING_DEFINITIONS.length,
    "each option has one control and one source of default values");
  const visible = SETTING_DEFINITIONS.filter((definition) => !definition.ownWindow);
  for (const group of SETTING_GROUPS) {
    assert.ok(visible.some((definition) => definition.group === group), `${group} must not be empty`);
  }
  assert.equal(visible.some((definition) => definition.group === "Мир"), false,
    "the old catch-all world group must not survive");
  assert.equal(SETTING_DEFINITIONS.find((definition) => definition.id === "renderScale")?.group, "Графика");
  assert.equal(SETTING_DEFINITIONS.find((definition) => definition.id === "godRays")?.group, "Эффекты");
  assert.equal(SETTING_DEFINITIONS.find((definition) => definition.id === "cameraDistancePercent")?.group, "Игра");
});

test("settings search uses player-facing labels and hints", () => {
  const volume = SETTING_DEFINITIONS.find((definition) => definition.id === "volumeMaster");
  const glow = SETTING_DEFINITIONS.find((definition) => definition.id === "fullscreenGlow");
  assert.ok(volume && glow);
  assert.equal(settingMatchesQuery(volume, "  ГРОМКОСТЬ "), true, "search is trimmed and case-insensitive");
  assert.equal(settingMatchesQuery(glow, "ярких участков"), true, "hints are searchable too");
  assert.equal(settingMatchesQuery(volume, "volumeMaster"), false,
    "internal ids are not taught to players by the search UI");
});

test("the wired category rail owns game keys, focus, orientation, and cross-group search", () => {
  const fixture = navigationFixture();
  const outer = fixture.document.createElement("div");
  const tabs = fixture.document.createElement("nav");
  const search = fixture.document.createElement("input");
  outer.append(tabs);
  let changes = 0;
  let navigation;
  navigation = wireSettingsNavigation(tabs, search, () => { changes += 1; }, fixture.media);
  const buttons = tabs.children;

  assert.equal(buttons.length, SETTING_GROUPS.length, "the real wire function builds every tab");
  assert.equal(SETTINGS_NARROW_MEDIA, "(max-width: 560px)");
  assert.equal(navigation.active, "Игра");
  assert.equal(buttons[0].getAttribute("role"), "tab");
  assert.equal(buttons[0].getAttribute("aria-controls"), "settings-options");
  assert.equal(buttons[0].getAttribute("aria-selected"), "true");
  assert.equal(buttons[0].tabIndex, 0);
  assert.equal(buttons[1].tabIndex, -1);
  assert.equal(tabs.getAttribute("aria-orientation"), "vertical");

  let leakedKeydowns = 0;
  outer.addEventListener("keydown", () => { leakedKeydowns += 1; });
  const arrow = buttons[0].dispatch("keydown", "ArrowRight");
  assert.equal(navigation.active, "Графика");
  assert.equal(fixture.document.activeElement, buttons[1], "arrow navigation moves real focus");
  assert.equal(arrow.defaultPrevented, true);
  assert.equal(leakedKeydowns, 0, "an owned arrow cannot reach global game bindings");

  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "Home", "End", " ", "Space", "Spacebar", "Enter", "Tab"]) {
    const event = buttons[1].dispatch("keydown", key);
    assert.equal(event.propagationStopped, true, `${key || "Space"} must stay inside the rail`);
    assert.equal(leakedKeydowns, 0, `${key || "Space"} must not reach the outer game listener`);
    if ([" ", "Space", "Spacebar", "Enter", "Tab"].includes(key)) {
      assert.equal(event.defaultPrevented, false, `${key} keeps native button/focus behaviour`);
    }
  }
  const escape = buttons[1].dispatch("keydown", "Escape");
  assert.equal(escape.propagationStopped, false, "Escape remains owned by global window closing");
  assert.equal(leakedKeydowns, 1);

  search.value = "громкость";
  search.dispatch("input");
  assert.ok(changes > 0, "the attached input handler requests a redraw");
  assert.deepEqual(navigation.groups, SETTING_GROUPS, "search opens every category to matching");
  const matches = navigation.groups.flatMap((group) => SETTING_DEFINITIONS.filter((definition) =>
    definition.group === group && settingMatchesQuery(definition, navigation.query)));
  assert.ok(matches.some((definition) => definition.id === "volumeMaster"),
    "a search started outside Sound still finds its setting");

  buttons[2].dispatch("click");
  assert.equal(navigation.active, "Эффекты");
  assert.equal(navigation.query, "", "choosing a category leaves global search");
  assert.deepEqual(navigation.groups, ["Эффекты"]);

  fixture.media.setMatches(true);
  assert.equal(tabs.getAttribute("aria-orientation"), "horizontal");
  navigation.dispose();
  assert.equal(fixture.media.listenerCount(), 0);
});

test("the settings window uses the tested navigator and keeps control focus stable", async () => {
  const source = await readFile(settingsSource, "utf8");
  assert.match(source, /settingsTabs\.setAttribute\("role", "tablist"\)/);
  assert.match(source, /wireSettingsNavigation\(settingsTabs, settingsSearch, drawSettings\)/,
    "the production panel must use the behaviour exercised above");
  assert.match(source, /settingsSearch\.type = "search"/);
  assert.match(source, /for \(const group of settingsNavigation\.groups\)/,
    "production rendering consumes the navigator's tested cross-group view");
  assert.match(source, /settingsList\.contains\(document\.activeElement\)/,
    "external redraws remember the focused setting");
  assert.match(source, /change\(definition, input\.checked, false\)/,
    "changing a checkbox must not replace the focused control");
});

test("the category rail follows the existing WoW window palette and remains usable on narrow screens", async () => {
  const css = await readFile(styleSource, "utf8");
  assert.match(css, /\.settings-shell\s*\{[^}]*grid-template-columns:\s*140px minmax\(0, 1fr\)/s);
  assert.match(css, /\.settings-group-tab\.is-active\s*\{[^}]*#ffe59a/s);
  assert.match(css, /\.settings-group-tab:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*\.settings-groups\s*\{[^}]*flex-direction:\s*row/s);
});

test("«Эффекты» is split into named subsections that cover every one of its settings exactly once", () => {
  const sections = SETTING_SECTIONS["Эффекты"];
  assert.deepEqual(sections.map((section) => section.title),
    ["Свет и атмосфера", "Вода", "Тени и рельеф", "Погода и ветер"]);
  const listed = sections.flatMap((section) => section.ids);
  assert.equal(new Set(listed).size, listed.length, "no setting is listed under two subsections");
  for (const id of listed) {
    assert.equal(SETTING_DEFINITIONS.find((definition) => definition.id === id)?.group, "Эффекты",
      `${id} is an existing «Эффекты» setting`);
  }
  const effects = SETTING_DEFINITIONS.filter((definition) => definition.group === "Эффекты" && !definition.ownWindow);
  const blocks = sectionSettings("Эффекты", effects, (definition) => definition.id);
  assert.equal(blocks.some((block) => block.title === OTHER_SETTINGS_SECTION), false,
    `every «Эффекты» setting is placed; add a new one to a section in SettingsSections.ts: ${
      blocks.find((block) => block.title === OTHER_SETTINGS_SECTION)?.items.map((definition) => definition.id).join(", ")}`);
  assert.equal(blocks.flatMap((block) => block.items).length, effects.length, "sectioning neither drops nor repeats a row");
  assert.equal(sections.find((section) => section.title === "Вода").ids.includes("experimentalWaterSkyReflection"), true);
  assert.equal(sections.find((section) => section.title === "Погода и ветер").ids.includes("experimentalWeatherSounds"), true);
  const light = sections.find((section) => section.title === "Свет и атмосфера").ids;
  assert.equal(light[light.indexOf("godRays") + 1], "godRayStrength", "the shaft slider sits right under its leaf");
});

test("sectioning keeps a group without sections as one list and never hides an unlisted setting", () => {
  const graphics = SETTING_DEFINITIONS.filter((definition) => definition.group === "Графика");
  assert.deepEqual(sectionSettings("Графика", graphics, (definition) => definition.id),
    [{ title: undefined, items: graphics }], "an unsectioned group is drawn exactly as before");
  assert.deepEqual(sectionSettings("Графика", [], (definition) => definition.id), []);
  const items = [{ id: "experimentalNewThing" }, { id: "experimentalWaterFoam" }, { id: "godRays" }];
  assert.deepEqual(sectionSettings("Эффекты", items, (item) => item.id), [
    { title: "Свет и атмосфера", items: [items[2]] },
    { title: "Вода", items: [items[1]] },
    { title: OTHER_SETTINGS_SECTION, items: [items[0]] },
  ], "section order, empty sections dropped, the unlisted one last rather than lost");
  // A search that matches one row of a section still shows that row under its title.
  const glow = SETTING_DEFINITIONS.filter((definition) => definition.group === "Эффекты" && settingMatchesQuery(definition, "ярких участков"));
  assert.deepEqual(sectionSettings("Эффекты", glow, (definition) => definition.id).map((block) => block.title), ["Свет и атмосфера"]);
});

test("the settings list is the window's one scroller: per-tab position, wheel contained, keyboard owned", async () => {
  const source = await readFile(settingsSource, "utf8");
  assert.match(source, /sectionSettings\(group, inGroup, \(definition\) => definition\.id\)/,
    "the window draws the shared subsections");
  assert.match(source, /settingsList\.tabIndex = 0/, "a click on a hint gives the list the keyboard");
  assert.match(source, /scrollByView\.set\(shownView, list\.scrollTop\)/, "the scroll position is remembered per view");
  assert.match(source, /settingsList\.scrollTop = scrollByView\.get\(view\) \?\? 0/, "…and put back on redraw");
  assert.match(source, /focus\(\{ preventScroll: true \}\)/, "refocusing a control after a redraw does not jump the list");
  const css = await readFile(styleSource, "utf8");
  const list = css.match(/\.settings-options\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /min-height:\s*0/, "the list shrinks to the window rather than pushing it past the viewport");
  assert.match(list, /overscroll-behavior:\s*contain/, "a wheel at the list's end scrolls nothing behind it");
  assert.match(css, /\.settings-window\s*\{[^}]*height:\s*min\(560px, calc\(100vh - 120px\)\)/s);
  assert.match(css, /\.settings-section-title\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /\.setting-label > span\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s,
    "a long Russian label wraps instead of pushing its control out of the row");
});

// DEC-A 3.11 (04.10, owner decision 4): the client's assistAttack — the stock Combat panel's ASSIST_ATTACK
// («Автоматическая помощь», GlobalStrings.lua; tooltip OPTION_TOOLTIP_ASSIST_ATTACK) — is a «Игра» switch,
// off by default: Wow.exe registers the CVar beside autoRangedCombat with "0" (default string at 0x009e14a0,
// pointer 0x00bd0918). Native ASSISTTARGET and the stock AssistUnit read it.
test("DEC-A 3.11: assistAttack is the stock «Автоматическая помощь», a «Игра» switch, off by default", () => {
  const definition = SETTING_DEFINITIONS.find((entry) => entry.id === "assistAttack");
  assert.ok(definition, "the setting exists");
  assert.equal(definition.group, "Игра");
  assert.equal(definition.kind, "boolean");
  assert.equal(definition.fallback, false, "Wow.exe's default \"0\"");
  assert.equal(definition.label, "Автоматическая помощь", "ASSIST_ATTACK in ruRU GlobalStrings.lua");
  assert.equal(definition.ownWindow, undefined, "drawn in the settings window, not by its own owner");
  assert.equal(settingMatchesQuery(definition, "помощь"), true);
});
