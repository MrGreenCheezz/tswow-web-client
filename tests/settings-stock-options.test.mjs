import assert from "node:assert/strict";
import test from "node:test";

// Settings.ts's side of the stock options frames: the audio switches the stock Sound panel writes,
// the route `/settings` and the native menu's «Настройки» ask first, and the presets the «WebClient»
// category shares with the native window's footer.

// Settings.ts reaches the page through its imports (Dom.ts resolves handles at import time); the
// same any-id document stub loot-all.test.mjs uses.
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, id: "", value: "", type: "",
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
      // What the native window's Panel (Widgets.ts) touches when it is built and shown.
      dispatchEvent() { return true; }, contains() { return false; }, toggleAttribute() {}, scrollIntoView() {},
      get ownerDocument() { return globalThis.document; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const settingsModule = await import("../dist/code/browser/ui/Settings.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");
const { enhancedGraphicsSettings } = await import("../dist/code/browser/ui/EnhancedGraphics.js");
const { comparisonGraphicsSettings } = await import("../dist/code/browser/ui/ComparisonProfile.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlOptionsController.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
usePanelHost({ viewport: document.body, attach() {} });
const {
  settingsStore, applySoundVolumes, applySettingsPreset, toggleSettingsWindow, settingsWindowOpen, closeSettingsWindow,
  openSettingsSection,
} = settingsModule;

function withSound(run) {
  const calls = new Map();
  const previous = game.sound;
  game.sound = { setVolume: (channel, value) => { calls.set(channel, value); } };
  try { run(calls); } finally { game.sound = previous; }
}

test("the audio switches silence their channel at its own slider, and ambience has its own slider", () => {
  withSound((calls) => {
    settingsStore.set({ ...defaultSettings(), volumeMusic: 40, volumeAmbience: 25 });
    applySoundVolumes();
    assert.equal(calls.get("master"), 0.7);
    assert.equal(calls.get("music"), 0.4);
    assert.equal(calls.get("ambience"), 0.25, "no longer the music slider's value");
    settingsStore.set({ ...settingsStore.value, soundEnabled: false, musicEnabled: false });
    applySoundVolumes();
    assert.equal(calls.get("master"), 0, "«Включить звук» off is silence");
    assert.equal(calls.get("music"), 0);
    assert.equal(calls.get("effects"), 1, "a channel left on keeps its level");
    settingsStore.set({ ...settingsStore.value, soundEnabled: true, soundEffectsEnabled: false, ambienceEnabled: false });
    applySoundVolumes();
    assert.equal(calls.get("master"), 0.7, "back on at the slider's own value");
    assert.equal(calls.get("effects"), 0);
    assert.equal(calls.get("ambience"), 0);
  });
  settingsStore.set(defaultSettings());
});

test("the presets are the native footer's own profiles, through the one store", () => {
  const start = { ...defaultSettings(), renderScale: 75, godRays: false };
  settingsStore.set(start);
  applySettingsPreset("enhanced");
  assert.deepEqual(settingsStore.value, enhancedGraphicsSettings(start));
  const enhanced = settingsStore.value;
  applySettingsPreset("comparison");
  assert.deepEqual(settingsStore.value, comparisonGraphicsSettings(enhanced));
  settingsStore.set(defaultSettings());
});

test("/settings and «Настройки» open the stock category once published; the settings route counts and closes it", () => {
  const calls = [];
  let open = false;
  const cleanup = controller.publishFrameXmlOptions({
    failed: false,
    isOpen: () => open,
    open: (window, fromMenu) => { calls.push(["open", window, fromMenu]); open = true; return true; },
    close: () => { calls.push(["close"]); const was = open; open = false; return was; },
    dispose: () => { open = false; },
  });
  try {
    toggleSettingsWindow();
    assert.deepEqual(calls, [["open", "webclient", false]]);
    assert.equal(settingsWindowOpen(), true, "Escape's window registry sees the stock frame");
    closeSettingsWindow();
    assert.deepEqual(calls.at(-1), ["close"]);
    assert.equal(settingsWindowOpen(), false);
    toggleSettingsWindow();
    toggleSettingsWindow();
    assert.deepEqual(calls.slice(-2), [["open", "webclient", false], ["close"]], "the same call toggles it shut");
  } finally {
    cleanup();
  }
});

test("/settings keeps the native window a failing stock show opened in its place", () => {
  // createLazyFrameXmlOptionsOwner.open() once loaded, when the show raises: fail() → onFailure →
  // openSettingsSection, and open() answers false.
  let failed = false;
  const cleanup = controller.publishFrameXmlOptions({
    get failed() { return failed; },
    isOpen: () => false,
    open: () => { failed = true; openSettingsSection("Игра"); return !failed; },
    close: () => false,
    dispose: () => {},
  });
  try {
    toggleSettingsWindow();
    assert.equal(settingsWindowOpen(), true, "the fallback stays up rather than being toggled shut");
    toggleSettingsWindow();
    assert.equal(settingsWindowOpen(), false, "the next /settings closes it");
    toggleSettingsWindow();
    assert.equal(settingsWindowOpen(), true, "…and, the route demoted, opens the native window");
  } finally {
    closeSettingsWindow();
    cleanup();
  }
});
