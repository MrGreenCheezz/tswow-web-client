import assert from "node:assert/strict";
import test from "node:test";

// 9.10/3.26 on a synthetic corpus, no real module needed: a stock UIParent.lua whose entry points are
// remembered right after it ran (FrameXmlStockEntryPoints.ts) and a TSAddon block that may replace
// them. N follows an add-on's ToggleTalentFrame whatever the module and its window are called; the
// glyph entry points stay on the stock path unless an add-on replaced them itself.

// FrameXmlWorldMount (createFrameXmlTalentOwners) imports the normal UI module graph; give it a harmless
// DOM while it evaluates. The renderer below draws into its own layout document.
const style = { setProperty() {}, removeProperty() {} };
const classList = { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } };
const domNode = () => new Proxy({
  style, classList, dataset: {}, children: [], hidden: false, value: "", textContent: "",
  querySelector: () => domNode(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
  append() {}, appendChild() {}, replaceChildren() {}, remove() {}, setAttribute() {}, getAttribute: () => null,
  removeAttribute() {}, getContext: () => ({ setTransform() {}, clearRect() {} }),
}, { get(target, property) {
  if (property in target) return target[property];
  if (property === "ownerDocument") return globalThis.document;
  if (property === "parentNode" || property === "parentElement" || property === "nextSibling") return null;
  if (property === "clientWidth" || property === "clientHeight") return 1024;
  if (property === "getBoundingClientRect") return () => ({ left: 0, top: 0, width: 0, height: 0 });
  if (property === "focus" || property === "blur" || property === "click") return () => {};
  return undefined;
} });
const documentNode = domNode();
globalThis.document = {
  head: documentNode, body: documentNode, documentElement: documentNode, createElement: () => domNode(),
  getElementById: () => domNode(), querySelector: () => domNode(), querySelectorAll: () => [],
};
globalThis.window = {
  innerWidth: 1024, innerHeight: 768, devicePixelRatio: 1, location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { layoutDocument, layoutHost } = await import("./fixtures/framexml-layout-document.mjs");
const { createPatchedFrameXmlTalentOwner } = await import("../dist/code/browser/framexml/FrameXmlAddonTalentOwner.js");
const { frameXmlEntryPointReplaced, frameXmlDefinesStockEntryPoints } = await import(
  "../dist/code/browser/framexml/FrameXmlStockEntryPoints.js");
const { createFrameXmlTalentOwners } = await import("../dist/code/browser/framexml/FrameXmlWorldMount.js");
const {
  publishFrameXmlTalent, toggleFrameXmlTalent, closeFrameXmlTalent, frameXmlTalentOpen,
} = await import("../dist/code/browser/framexml/FrameXmlTalentController.js");

/** The four UIParent.lua functions these paths touch, as stock as a fixture needs them. */
const STOCK_UIPARENT = `
  SHOW_INSCRIPTION_LEVEL = 15
  function GlyphFrame_LoadUI() end
  function ToggleTalentFrame() StockTalentToggles = (StockTalentToggles or 0) + 1 end
  function ToggleGlyphFrame() StockGlyphToggles = (StockGlyphToggles or 0) + 1 end
  function OpenGlyphFrame() StockGlyphOpens = (StockGlyphOpens or 0) + 1 end
`;

/**
 * A module's own talent window under `frameName`, built on its first toggle as a lazy add-on does,
 * with a helper frame it makes on the way: unanchored, so it is not a window and must not be learned.
 */
function talentWindowAddon(frameName) {
  return `
    local window
    function ToggleTalentFrame()
      if not window then
        window = CreateFrame("Frame", "${frameName}", UIParent)
        window:SetWidth(400)
        window:SetHeight(300)
        window:SetPoint("CENTER", UIParent, "CENTER")
        local close = CreateFrame("Button", "${frameName}Close", window)
        close:SetWidth(20)
        close:SetHeight(20)
        close:SetPoint("TOPRIGHT")
        close:SetScript("OnClick", function() window:Hide() end)
        window:Hide()
        AddonHelper = CreateFrame("Frame", nil, UIParent)
        AddonHelper:SetScript("OnUpdate", function() end)
      end
      if window:IsShown() then window:Hide() else window:Show() end
    end
  `;
}

async function mountFixture({ module = "talent-patch-alpha", addonLua } = {}) {
  const directory = `interface/framexml/tsaddons/${module}/addon/`;
  const files = {
    "interface/framexml/framexml.toc": [
      "UIParent.xml",
      ...(addonLua === undefined ? [] : [
        `## tsaddon-begin: ${module}`, `TSAddons/${module}/addon/addon.xml`, `## tsaddon-end: ${module}`,
      ]),
    ].join("\n"),
    "interface/framexml/uiparent.xml":
      '<Ui><Frame name="UIParent" setAllPoints="true"/><Script file="UIParent.lua"/></Ui>',
    "interface/framexml/uiparent.lua": STOCK_UIPARENT,
  };
  if (addonLua !== undefined) {
    files[`${directory}addon.xml`] = '<Ui><Script file="addon.lua"/></Ui>';
    files[`${directory}addon.lua`] = addonLua;
  }
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider(files),
    subset: ["UIParent.xml"],
    includeActiveTsAddons: true,
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  await boot.load();
  // The world mount's renderer options: a window an add-on parents to UIParent is drawn in it, an
  // unanchored root is not (FrameXmlWorldMount.ts).
  const renderer = new FrameXmlDomRenderer(layoutHost(layoutDocument(), 1024, 768), {
    bridge: boot.bridge, createdRootParent: "UIParent", includeCreatedRoots: false, unanchoredRootsUndrawn: true,
  });
  renderer.mount(boot.roots);
  const loads = [];
  const loadAddon = boot.loadAddon.bind(boot);
  boot.loadAddon = (name) => { loads.push(name); return loadAddon(name); };
  return {
    boot, renderer, loads,
    lua(source, results = 0) {
      const fn = boot.vm.compileFunction(source, "addon-talent-test", []);
      assert.ok(fn, source);
      try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
    },
    close() { renderer.destroy(); boot.close(); },
  };
}

const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

test("only FrameXML's own UIParent.lua holds the stock entry points", () => {
  assert.equal(frameXmlDefinesStockEntryPoints("interface/framexml/uiparent.lua"), true);
  assert.equal(frameXmlDefinesStockEntryPoints("Interface\\FrameXML\\UIParent.lua"), true);
  assert.equal(frameXmlDefinesStockEntryPoints("interface/framexml/tsaddons/some-module/uiparent.lua"), false,
    "a module file of that name would capture the module's functions as stock");
});

test("an add-on's ToggleTalentFrame owns N and its window, under any module or frame name", async () => {
  for (const [module, frameName] of [["talent-patch-alpha", "AlphaTalentWindow"], ["zz-another-module", "Whatever_Frame9"]]) {
    const h = await mountFixture({ module, addonLua: talentWindowAddon(frameName) });
    let nativeOpen = true;
    let failures = 0;
    let cleanup;
    try {
      assert.equal(h.boot.isModuleLoaded(module), true); // 3.46: the host's record, not IsAddOnLoaded
      assert.equal(frameXmlEntryPointReplaced(h.boot, "ToggleTalentFrame"), true, "the add-on's function, by identity");
      assert.equal(frameXmlEntryPointReplaced(h.boot, "ToggleGlyphFrame"), false);
      assert.equal(frameXmlEntryPointReplaced(h.boot, "OpenGlyphFrame"), false);
      const owner = createPatchedFrameXmlTalentOwner(h.boot, h.renderer,
        () => { nativeOpen = false; }, () => { failures += 1; });
      assert.ok(owner, `${module}: an add-on's toggle gives N an add-on owner`);
      cleanup = publishFrameXmlTalent(owner);

      assert.equal(toggleFrameXmlTalent(), true);
      const window = h.boot.bridge.getFrame(frameName);
      assert.equal(window?.visible, true, `${frameName} is shown by the add-on's own toggle`);
      assert.equal(frameXmlTalentOpen(), true, "the shown window is learned without its name");
      assert.equal(nativeOpen, false, "the native window closes before the add-on's opens");
      assert.equal(toggleFrameXmlTalent(), true, "a second N");
      assert.equal(window.visible, false);
      assert.equal(frameXmlTalentOpen(), false);
      assert.equal(h.lua("return AddonHelper:IsShown() and 1 or 0", 1)[0], 1,
        "the unanchored helper the toggle created is not the window: N never hides it");

      assert.equal(toggleFrameXmlTalent(), true);
      assert.equal(window.visible, true);
      assert.equal(closeFrameXmlTalent(), true, "Escape");
      assert.equal(window.visible, false);

      // The add-on's own close button: N's owner follows the window, not the always-shown helper.
      assert.equal(toggleFrameXmlTalent(), true);
      h.lua(`${frameName}Close:Click()`);
      assert.equal(window.visible, false);
      assert.equal(frameXmlTalentOpen(), false, "the unanchored helper frame is not the window");

      assert.equal(failures, 0);
      assert.equal(h.boot.vm.getGlobal("StockTalentToggles"), undefined, "UIParent's toggle never ran");
      assert.deepEqual(h.boot.errors, []);
      assert.deepEqual(h.loads, [], "no Blizzard_TalentUI load for an add-on's N");
    } finally {
      cleanup?.();
      h.close();
    }
  }
});

test("N closes the add-on's window it opened by its own means, as the add-on's toggle does", async () => {
  const h = await mountFixture({ addonLua: talentWindowAddon("OwnMeansWindow") });
  let failures = 0;
  const owner = createPatchedFrameXmlTalentOwner(h.boot, h.renderer, undefined, () => { failures += 1; });
  const cleanup = publishFrameXmlTalent(owner);
  try {
    h.lua("ToggleTalentFrame()");
    const window = h.boot.bridge.getFrame("OwnMeansWindow");
    assert.equal(window.visible, true, "opened by the add-on (its button or command), not by N");
    assert.equal(toggleFrameXmlTalent(), true, "N runs the add-on's toggle, which closes it");
    assert.equal(window.visible, false);
    assert.equal(failures, 0, "closing is not a failure");
    assert.equal(toggleFrameXmlTalent(), true);
    assert.equal(window.visible, true);
    assert.equal(frameXmlTalentOpen(), true);
  } finally {
    cleanup();
    h.close();
  }
});

test("a toggle that shows nothing is demoted to the native window on the same press", async () => {
  const h = await mountFixture({ addonLua: "function ToggleTalentFrame() AddonToggleRan = true end" });
  let failures = 0;
  const owner = createPatchedFrameXmlTalentOwner(h.boot, h.renderer, undefined, () => { failures += 1; });
  assert.ok(owner);
  const cleanup = publishFrameXmlTalent(owner);
  try {
    assert.equal(toggleFrameXmlTalent(), false, "the caller opens the native window from this press");
    assert.equal(h.boot.vm.getGlobal("AddonToggleRan"), true);
    assert.equal(failures, 1);
    assert.equal(toggleFrameXmlTalent(), false, "the demoted owner is gone");
  } finally {
    cleanup();
    h.close();
  }
});

test("without a replacement — no add-on, unrelated globals, a post-hook — N keeps the stock owner", async () => {
  const cases = [
    ["no add-on", undefined, false],
    ["unrelated globals", `
      function ToggleSomethingElse() end
      ToggleTalentFrameButton = CreateFrame("Button", "ToggleTalentFrameButton", UIParent)
      AddonTalentState = { open = false }
    `, false],
    ["a post-hook", `hooksecurefunc("ToggleTalentFrame", function() AddonHookRan = true end)`, false],
    ["a replacement hooked again", `
      ToggleTalentFrame = function() end
      hooksecurefunc("ToggleTalentFrame", function() end)
    `, true],
  ];
  for (const [label, addonLua, replaced] of cases) {
    const h = await mountFixture({ addonLua });
    try {
      assert.deepEqual(h.boot.errors, [], label);
      assert.equal(frameXmlEntryPointReplaced(h.boot, "ToggleTalentFrame"), replaced, label);
      const owner = createPatchedFrameXmlTalentOwner(h.boot, h.renderer);
      assert.equal(owner !== undefined, replaced, label);
      owner?.dispose?.();
    } finally {
      h.close();
    }
  }
});

function glyphSeam() {
  const glyphs = { owned: false, onCatalog: undefined, cancelTargeting() {}, prepare: async () => {} };
  return { glyphs, talentSnapshot: () => ({ activeTalentGroup: 1 }), learnTalent() {} };
}

test("beside an add-on's N the stock glyph key still goes to a stock talent frame of its own", async () => {
  const h = await mountFixture({ addonLua: talentWindowAddon("GlyphSideWindow") });
  const glyphFailures = [];
  const owners = createFrameXmlTalentOwners(glyphSeam(), h.boot, h.renderer, {
    onGlyphFailure: (reason) => glyphFailures.push(reason),
  });
  const cleanup = publishFrameXmlTalent(owners.talent);
  try {
    assert.ok(owners.glyphTalent, "the glyph entry points are still UIParent's");
    assert.notEqual(owners.glyphTalent, owners.talent);
    // UIParent's level check reads the player's level; this fixture has no world seam.
    h.lua("UnitLevel = function() return 80 end");
    h.lua("ToggleGlyphFrame()");
    await settle();
    assert.equal(h.boot.vm.getGlobal("StockGlyphToggles"), undefined, "the host's stock path took the key");
    assert.deepEqual(h.loads, ["Blizzard_TalentUI"], "the stock talent frame loads for the glyph tab");
    assert.equal(h.boot.bridge.getFrame("GlyphSideWindow"), undefined, "N's add-on window is not what opened");
    assert.equal(frameXmlEntryPointReplaced(h.boot, "ToggleTalentFrame"), true, "N stays the add-on's");
    // The fixture has neither Blizzard add-on: the glyph tab and its talent frame give up and hand the
    // entry points back to UIParent, as a failed stock owner does.
    assert.ok(glyphFailures.length > 0);
    assert.equal(frameXmlEntryPointReplaced(h.boot, "ToggleGlyphFrame"), false);

    assert.equal(toggleFrameXmlTalent(), true, "N still opens the add-on's window");
    assert.equal(h.boot.bridge.getFrame("GlyphSideWindow")?.visible, true);
  } finally {
    cleanup();
    owners.glyphTalent?.dispose?.();
    h.close();
  }
});

test("a glyph entry point an add-on replaced is left as the add-on set it", async () => {
  const replaceToggle = `
    function ToggleGlyphFrame() AddonGlyphToggles = (AddonGlyphToggles or 0) + 1 end
    AddonGlyphToggle = ToggleGlyphFrame
  `;
  const replaceOpen = `
    function OpenGlyphFrame() end
    AddonGlyphOpen = OpenGlyphFrame
  `;
  // Only ToggleGlyphFrame: USE_GLYPH's OpenGlyphFrame still takes the stock path.
  let h = await mountFixture({ addonLua: talentWindowAddon("ReplacedGlyphWindow") + replaceToggle });
  let owners = createFrameXmlTalentOwners(glyphSeam(), h.boot, h.renderer);
  try {
    assert.ok(owners.glyphTalent);
    const [same, openHooked] = h.lua(`return rawequal(ToggleGlyphFrame, AddonGlyphToggle) and 1 or 0,
      OpenGlyphFrame ~= nil and 1 or 0`, 2);
    assert.equal(same, 1, "the add-on's ToggleGlyphFrame is not hooked over");
    assert.equal(openHooked, 1);
    assert.equal(frameXmlEntryPointReplaced(h.boot, "OpenGlyphFrame"), true, "the host hooked the stock one");
    h.lua("ToggleGlyphFrame()");
    await settle();
    assert.equal(h.boot.vm.getGlobal("AddonGlyphToggles"), 1);
    assert.deepEqual(h.loads, [], "the add-on's glyph key loads nothing stock");
  } finally {
    owners.talent.dispose?.();
    owners.glyphTalent?.dispose?.();
    h.close();
  }
  // Both: nothing stock is left for the glyph tab beside the add-on's N.
  h = await mountFixture({ addonLua: talentWindowAddon("ReplacedGlyphWindow") + replaceToggle + replaceOpen });
  owners = createFrameXmlTalentOwners(glyphSeam(), h.boot, h.renderer);
  try {
    assert.equal(owners.glyphTalent, undefined);
    const [toggle, open] = h.lua(`return rawequal(ToggleGlyphFrame, AddonGlyphToggle) and 1 or 0,
      rawequal(OpenGlyphFrame, AddonGlyphOpen) and 1 or 0`, 2);
    assert.deepEqual([toggle, open], [1, 1]);
  } finally {
    owners.talent.dispose?.();
    h.close();
  }
});

test("with no add-on the stock owner keeps N and hosts the glyph tab, as before", async () => {
  const h = await mountFixture();
  const owners = createFrameXmlTalentOwners(glyphSeam(), h.boot, h.renderer);
  const cleanup = publishFrameXmlTalent(owners.talent);
  try {
    assert.equal(owners.glyphTalent, undefined);
    assert.equal(frameXmlEntryPointReplaced(h.boot, "ToggleGlyphFrame"), true, "the glyph tab hooked UIParent's");
    h.lua("UnitLevel = function() return 80 end");
    h.lua("ToggleGlyphFrame()");
    await settle();
    assert.deepEqual(h.loads, ["Blizzard_TalentUI"], "the glyph key opens N's own stock owner");
    assert.equal(h.boot.vm.getGlobal("StockTalentToggles"), undefined);
  } finally {
    cleanup();
    h.close();
  }
});
