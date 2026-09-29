import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the world mount's achievement wiring (FrameXmlAchievementMount.ts) over the production
// vertical and the canned achievements — the stock AchievementMicroButton's adapter click reaching
// the published owner, the button following HasCompletedAnyAchievement with its stock tooltip back,
// stock's own ToggleAchievementFrame routed to the owner, Escape, a press refused while the gateway has
// no catalog (and the next one opening once it has), and the disabled, silent button again when the
// add-on cannot load.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

function fakeNode() {
  const attributes = new Map();
  return {
    children: [], style: {}, dataset: {}, hidden: false, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append() {}, replaceChildren() {}, remove() {}, setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; }, removeAttribute(name) { attributes.delete(name); },
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; }, getContext() { return {}; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? fakeNode() : null; },
  };
}
globalThis.document ??= {
  head: fakeNode(), body: fakeNode(), createElement: fakeNode, getElementById: fakeNode, querySelectorAll() { return []; },
};
globalThis.window ??= {
  innerWidth: 1024, innerHeight: 768, location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
};
globalThis.location ??= globalThis.window.location;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { mountFrameXmlAchievement } = await import("../dist/code/browser/framexml/FrameXmlAchievementMount.js");
const {
  toggleFrameXmlAchievement, frameXmlAchievementPublished, frameXmlAchievementOpen, closeFrameXmlAchievement,
} = await import("../dist/code/browser/framexml/FrameXmlAchievementController.js");
const { installFrameXmlMicroButtonAdapters } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const { closeGameWindows } = await import("../dist/code/browser/ui/Windows.js");
const decoder = new TextDecoder("utf-8");

async function load({ catalog = true, missingAddon = false } = {}) {
  const seam = new CannedWorldSeam();
  // Without a catalog the gateway answers 404 until `gateway.serving` is set (the owner restarted it).
  const gateway = { serving: catalog };
  if (!catalog) {
    const canned = seam.achievement.catalogSource;
    seam.achievement.catalogSource = {
      failure: "achievement catalog gateway returned 404",
      load: () => gateway.serving ? canned.load() : Promise.resolve(undefined),
    };
  }
  let adapters;
  const noop = () => {};
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        if (missingAddon && path.replaceAll("\\", "/").toLowerCase().startsWith("interface/addons/blizzard_achievementui/")) return undefined;
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
    // The mount's beforeExercise: the row's adapters, the Achievement button on the published owner.
    beforeExercise: (loaded) => {
      adapters = installFrameXmlMicroButtonAdapters(loaded, {
        character: noop, spellbook: noop, talent: noop, quest: noop, socials: noop, pvp: noop, lfd: noop,
        gameMenu: noop, help: noop, achievement: () => toggleFrameXmlAchievement(),
      });
    },
  });
  await boot.load();
  assert.ok(adapters, "the row adapters installed");
  const elements = new Map();
  const renderer = {
    elementFor(frame) {
      if (!frame) return null;
      if (!elements.has(frame)) {
        const element = fakeNode();
        element.setAttribute("data-framexml-name", frame.name);
        element.setAttribute("data-framexml-type", frame.type);
        elements.set(frame, element);
      }
      return elements.get(frame);
    },
    addRoots() {}, sync() {},
  };
  return { boot, seam, renderer, gateway };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "achievement-mount-test", []);
  assert.ok(fn);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** Until the press has been answered: the window loaded, or a refusal or failure in the error frame. */
async function answered(boot, errors, before) {
  for (let round = 0; round < 50 && !boot.bridge.getFrame("AchievementFrame") && errors.length === before; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settled(seam, boot) {
  for (let round = 0; round < 50 && !boot.bridge.getFrame("AchievementFrame") && seam.achievement.available; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("published, the micro button is the stock one again and opens the stock window", withClient, async () => {
  const { boot, seam, renderer } = await load();
  const button = boot.bridge.getFrame("AchievementMicroButton");
  const talent = boot.bridge.getFrame("TalentMicroButton");
  assert.equal(button.enabled, false, "the row adapter's disabled button, before any owner");
  const errors = [];
  const cleanup = mountFrameXmlAchievement(seam, boot, renderer, {
    gatewayOrigin: "http://127.0.0.1:8090", microButtons: true, uiError: (text) => errors.push(text),
  });
  try {
    assert.equal(frameXmlAchievementPublished(), true);
    assert.equal(button.enabled, true, "HasCompletedAnyAchievement: the canned character has seven");
    assert.equal(boot.bridge.GetScript(button, "OnEnter"), boot.bridge.GetScript(talent, "OnEnter"),
      "the MainMenuBarMicroButton template's tooltip handler, as every button of the row");
    assert.equal(renderer.elementFor(button).getAttribute("aria-label"), "Достижения");
    assert.equal(renderer.elementFor(button).getAttribute("title"), null);
    assert.equal(boot.bridge.getFrame("AchievementFrame")?.name, undefined, "nothing loaded by publishing");
    // The row adapter's OnClick → toggleFrameXmlAchievement → the lazy load → the stock toggle.
    boot.bridge.fireScript(button, "OnClick", "LeftButton", false);
    await settled(seam, boot);
    assert.equal(lua(boot, "return AchievementFrame:IsShown() and 1 or 0")[0], 1);
    assert.equal(frameXmlAchievementOpen(), true);
    // Escape's native pass (Controls.ts → closeGameWindows) closes every registered escapable window.
    closeGameWindows();
    assert.equal(lua(boot, "return AchievementFrame:IsShown() and 1 or 0")[0], 0, "Escape closed the stock window");
    // Stock's own entry point, routed: ToggleAchievementFrame(true) opens the Statistics tab.
    lua(boot, "ToggleAchievementFrame(true)", 0);
    assert.deepEqual(lua(boot, "return AchievementFrame:IsShown() and 1 or 0, AchievementFrame.selectedTab", 2), [1, 2]);
    assert.equal(closeFrameXmlAchievement(), true);
    assert.equal(lua(boot, "return AchievementFrame:IsShown() and 1 or 0")[0], 0);
    lua(boot, "ToggleAchievementFrame(true)", 0);
    assert.deepEqual(errors, []);
    assert.equal(boot.errorCount, 0, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    cleanup();
    assert.equal(frameXmlAchievementPublished(), false);
    assert.equal(lua(boot, "return AchievementFrame:IsShown() and 1 or 0")[0], 0, "the cleanup closed it");
    boot.close();
  }
});

test("without the catalog a press is refused and says so; the next one, once the gateway serves it, opens", withClient, async () => {
  const { boot, seam, renderer, gateway } = await load({ catalog: false });
  const button = boot.bridge.getFrame("AchievementMicroButton");
  const talent = boot.bridge.getFrame("TalentMicroButton");
  const errors = [];
  const cleanup = mountFrameXmlAchievement(seam, boot, renderer, {
    gatewayOrigin: "http://127.0.0.1:8090", microButtons: true, uiError: (text) => errors.push(text),
  });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(button.enabled, true, "the owner is published; the catalog is only asked for on the first press");
    boot.bridge.fireScript(button, "OnClick", "LeftButton", false);
    await answered(boot, errors, 0);
    assert.deepEqual(errors, ["Достижения сейчас недоступны."]);
    assert.match(warnings[0], /achievement catalog: achievement catalog gateway returned 404/);
    assert.equal(boot.bridge.getFrame("AchievementFrame")?.name, undefined, "nothing was loaded");
    assert.equal(button.enabled, true, "a refusal is not a failure: the button stays the stock one");
    assert.equal(boot.bridge.GetScript(button, "OnEnter"), boot.bridge.GetScript(talent, "OnEnter"));
    assert.equal(renderer.elementFor(button).getAttribute("title"), null);
    // The owner restarts the gateway; the next press loads and opens the stock window.
    gateway.serving = true;
    boot.bridge.fireScript(button, "OnClick", "LeftButton", false);
    await settled(seam, boot);
    assert.equal(lua(boot, "return AchievementFrame:IsShown() and 1 or 0")[0], 1);
    assert.deepEqual(errors, ["Достижения сейчас недоступны."]);
  } finally {
    console.warn = warn;
    cleanup();
    boot.close();
  }
});

test("an add-on that cannot load fails once, says so, and the button goes back to disabled and silent", withClient, async () => {
  const { boot, seam, renderer } = await load({ missingAddon: true });
  const button = boot.bridge.getFrame("AchievementMicroButton");
  const errors = [];
  const cleanup = mountFrameXmlAchievement(seam, boot, renderer, {
    gatewayOrigin: "http://127.0.0.1:8090", microButtons: true, uiError: (text) => errors.push(text),
  });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(button.enabled, true);
    boot.bridge.fireScript(button, "OnClick", "LeftButton", false);
    await answered(boot, errors, 0);
    assert.deepEqual(errors, ["Достижения сейчас недоступны."]);
    assert.match(warnings[0], /Blizzard_AchievementUI/);
    assert.equal(button.enabled, false);
    assert.equal(renderer.elementFor(button).getAttribute("title"), "Достижения недоступны в этой сборке");
    assert.notEqual(boot.bridge.GetScript(button, "OnEnter"), boot.bridge.GetScript(boot.bridge.getFrame("TalentMicroButton"), "OnEnter"),
      "no min-level tooltip for a window that cannot open");
    assert.equal(toggleFrameXmlAchievement(), false);
  } finally {
    console.warn = warn;
    cleanup();
    boot.close();
  }
});

test("a row that failed its gate is left alone", withClient, async () => {
  const { boot, seam, renderer } = await load();
  const button = boot.bridge.getFrame("AchievementMicroButton");
  const cleanup = mountFrameXmlAchievement(seam, boot, renderer, { gatewayOrigin: "http://127.0.0.1:8090", microButtons: false });
  try {
    assert.equal(button.enabled, false, "the hidden row's button is not touched");
    assert.equal(frameXmlAchievementPublished(), true, "the window is still reachable through stock's own entry points");
  } finally {
    cleanup();
    boot.close();
  }
});
