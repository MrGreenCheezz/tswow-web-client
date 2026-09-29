import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed on purpose: the defect was the host bypassing retail CharacterFrame.lua's own
// ToggleCharacter/CharacterFrame_ShowSubFrame, so the proof has to run that retail Lua and its
// PanelTemplates tab state, not a fixture that repeats their names.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

// The controller imports Portraits.js for its model gate; that module only needs an inert DOM.
const inertNode = () => ({
  hidden: true, dataset: {}, style: { setProperty() {}, removeProperty() {} }, children: [],
  className: "", width: 0, height: 0, value: "",
  classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
  append() {}, insertBefore() {}, remove() {}, replaceChildren() {},
  setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
  querySelector(selector) { return selector === 'button[type="submit"]' ? inertNode() : undefined; },
  querySelectorAll() { return []; },
});
globalThis.document = {
  head: inertNode(), body: inertNode(),
  getElementById: inertNode,
  createElement: inertNode,
  querySelectorAll() { return []; },
};
globalThis.window = {
  devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
  location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {},
};
globalThis.location = { protocol: "http:", hostname: "localhost" };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const {
  closeFrameXmlCharacter,
  createFrameXmlCharacterOwner,
  frameXmlCharacterOpen,
  frameXmlPlayerClassToken,
  publishFrameXmlCharacter,
  toggleFrameXmlCharacter,
  toggleFrameXmlCharacterTab,
} = await import("../dist/code/browser/framexml/FrameXmlCharacterController.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");

const decoder = new TextDecoder("utf-8");
// clientArchives() caches one chain per client directory, so it is closed once, after every boot.
let chain;
after(() => chain?.close?.());

async function bootVertical(seam = new CannedWorldSeam()) {
  const { clientArchives } = await import("../tools/mpq.mjs");
  chain ??= await clientArchives(clientDirectory);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS,
    screen: () => ({ width: 1024, height: 768 }),
  });
  await boot.load();
  return { boot };
}

/** «CF|PaperDoll|Reputation|Skill|selectedTab», read from stock Lua rather than bridge flags. */
function characterState(boot) {
  const probe = boot.vm.execute(`__characterOwnerState = string.format("%s|%s|%s|%s|%s",
    tostring(CharacterFrame:IsShown()), tostring(PaperDollFrame:IsShown()),
    tostring(ReputationFrame:IsShown()), tostring(SkillFrame:IsShown()),
    tostring(PanelTemplates_GetSelectedTab(CharacterFrame)))`, "@character-owner:state");
  assert.equal(probe.ok, true, probe.error);
  return boot.vm.getGlobal("__characterOwnerState");
}

/** A real click; the selected tab is disabled by PanelTemplates_SelectTab and refuses it. */
function clickTab(boot, index) {
  const tab = boot.bridge.getFrame(`CharacterFrameTab${index}`);
  assert.ok(tab, `CharacterFrameTab${index} exists`);
  return boot.bridge.Click(tab, "LeftButton", false);
}

test("host character owner reopens on the paper doll after another tab was selected", withClient, async () => {
  const { boot } = await bootVertical();
  let release;
  try {
    const character = boot.bridge.getFrame("CharacterFrame");
    assert.ok(character, "stock CharacterFrame is loaded");
    let failures = 0;
    release = publishFrameXmlCharacter(createFrameXmlCharacterOwner(boot, character, () => { failures += 1; }));
    const errorsBefore = boot.errorCount;

    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(characterState(boot), "true|true|false|false|1", "C opens the paper doll on tab 1");
    assert.equal(clickTab(boot, 3), true);
    assert.equal(characterState(boot), "true|false|true|false|3", "the stock tab switches to reputation");
    // Stock C is ToggleCharacter("PaperDollFrame"): from another page it switches, it does not close.
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(characterState(boot), "true|true|false|false|1", "C on reputation returns to the paper doll");
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(frameXmlCharacterOpen(), false, "C on the paper doll closes the frame");
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(clickTab(boot, 3), true);
    // A host close (Escape, the X button) while another tab is selected, then C again.
    assert.equal(closeFrameXmlCharacter(), true);
    assert.equal(frameXmlCharacterOpen(), false);
    assert.equal(toggleFrameXmlCharacter(), true);
    // Measured before the fix: "true|true|true|false|3" — both pages on screen, tab 3 still
    // selected (and so disabled), and the next «Персонаж» click closed the frame.
    assert.equal(characterState(boot), "true|true|false|false|1",
      "reopening shows only the paper doll with tab 1 selected");
    assert.equal(clickTab(boot, 1), false, "the selected «Персонаж» tab is disabled, as in stock");
    assert.equal(characterState(boot), "true|true|false|false|1",
      "clicking the already selected «Персонаж» tab keeps the frame open");
    assert.equal(clickTab(boot, 3), true, "«Репутация» is enabled again after the reopen");
    assert.equal(characterState(boot), "true|false|true|false|3");
    assert.equal(clickTab(boot, 1), true);
    assert.equal(characterState(boot), "true|true|false|false|1");

    // Native routes for the other pages follow stock ToggleCharacter: open, switch, close.
    assert.equal(toggleFrameXmlCharacterTab("SkillFrame"), true);
    assert.equal(characterState(boot), "true|false|false|true|4", "J/skills switches to SkillFrame");
    assert.equal(toggleFrameXmlCharacterTab("SkillFrame"), true);
    assert.equal(frameXmlCharacterOpen(), false, "the same page again closes the frame");
    assert.equal(toggleFrameXmlCharacterTab("ReputationFrame"), true);
    assert.equal(characterState(boot), "true|false|true|false|3", "reputation opens on tab 3");
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(characterState(boot), "true|true|false|false|1");
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(frameXmlCharacterOpen(), false);
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(characterState(boot), "true|true|false|false|1");

    assert.equal(failures, 0, "no owner demotion");
    assert.equal(boot.errorCount, errorsBefore, "the stock toggle path raises no Lua error");
  } finally {
    release?.();
    boot.close();
  }
});

test("character tab routing falls back when no stock owner is published", () => {
  assert.equal(toggleFrameXmlCharacterTab("ReputationFrame"), false);
  const release = publishFrameXmlCharacter({ isOpen: () => false, show() {}, hide() {} });
  try {
    assert.equal(toggleFrameXmlCharacterTab("SkillFrame"), false,
      "an owner without showTab keeps the native route");
  } finally {
    release();
  }
});

/** «UIParent|fullscreen panel», from stock UIParent.lua. */
function panelState(boot) {
  const probe = boot.vm.execute(`__characterPanelState = string.format("%s|%s",
    tostring(UIParent:IsShown()), tostring(GetUIPanel("fullscreen") and GetUIPanel("fullscreen"):GetName()))`,
  "@character-owner:panels");
  assert.equal(probe.ok, true, probe.error);
  return boot.vm.getGlobal("__characterPanelState");
}

test("C and J over a fullscreen panel follow stock ShowUIPanelFailed and keep the owner", withClient, async () => {
  const { boot } = await bootVertical();
  let release;
  try {
    const character = boot.bridge.getFrame("CharacterFrame");
    let failures = 0;
    release = publishFrameXmlCharacter(createFrameXmlCharacterOwner(boot, character, () => { failures += 1; }));
    const errorsBefore = boot.errorCount;
    // The fullscreen world map in miniature: stock ShowUIPanel of an area "full" panel runs
    // CloseAllWindows and SetUIPanel("fullscreen"), which hides UIParent (UIParent.lua:1372, 1532).
    const opened = boot.vm.execute(`
      UIPanelWindows["WebClientFullscreenProbe"] = { area = "full", pushable = 0, whileDead = 1 }
      CreateFrame("Frame", "WebClientFullscreenProbe"):Hide()
      ShowUIPanel(WebClientFullscreenProbe)`, "@character-owner:fullscreen");
    assert.equal(opened.ok, true, opened.error);
    assert.equal(panelState(boot), "false|WebClientFullscreenProbe");

    // Measured before the fix: the host's own Show left the frame invisible under the hidden
    // UIParent, the visibility post-check threw and the owner was demoted for the whole mount.
    assert.equal(toggleFrameXmlCharacter(), true, "C is handled by the stock owner");
    assert.equal(toggleFrameXmlCharacterTab("SkillFrame"), true, "so is J");
    assert.equal(characterState(boot).split("|")[0], "false", "stock refuses the left panel: nothing opens");
    assert.equal(failures, 0, "a stock refusal does not demote the owner");

    const closed = boot.vm.execute("HideUIPanel(WebClientFullscreenProbe)", "@character-owner:fullscreen-close");
    assert.equal(closed.ok, true, closed.error);
    assert.equal(panelState(boot), "true|nil");
    assert.equal(toggleFrameXmlCharacter(), true, "the owner is still published after the panel closes");
    assert.equal(characterState(boot), "true|true|false|false|1");
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(frameXmlCharacterOpen(), false);

    // UIParent hidden without a fullscreen panel: ShowUIPanel accepts and the frame is shown but
    // not visible. The owner judges by the shown flags, as ToggleCharacter does, and keeps working.
    assert.equal(boot.vm.execute("UIParent:Hide()", "@character-owner:hide-ui").ok, true);
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(characterState(boot), "true|true|false|false|1");
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(characterState(boot).split("|")[0], "false", "C on the shown paper doll closes it");
    assert.equal(boot.vm.execute("UIParent:Show()", "@character-owner:show-ui").ok, true);

    assert.equal(failures, 0, "no owner demotion");
    assert.equal(boot.errorCount, errorsBefore, "no Lua error on any refused or accepted path");
  } finally {
    release?.();
    boot.close();
  }
});

test("the class token is checked when the frame opens, not once at publication", withClient, async () => {
  const seam = new CannedWorldSeam();
  const { boot } = await bootVertical(seam);
  let release;
  try {
    // The live mount may publish before the player's own object lands (its wait times out after
    // 5 s); until then LiveWorldSeam answers neither UnitExists("player") nor UnitClass("player").
    let playerKnown = false;
    let classKnown = false;
    const unitExists = seam.unitExists.bind(seam);
    const unitClass = seam.unitClass.bind(seam);
    seam.unitExists = (unit) => (unit === "player" && !playerKnown ? false : unitExists(unit));
    seam.unitClass = (unit) => (unit === "player" && !classKnown ? undefined : unitClass(unit));
    const character = boot.bridge.getFrame("CharacterFrame");
    let failures = 0;
    release = publishFrameXmlCharacter(createFrameXmlCharacterOwner(boot, character, () => { failures += 1; }));
    const errorsBefore = boot.errorCount;

    assert.equal(toggleFrameXmlCharacter(), true, "C before the player exists is handled");
    assert.equal(characterState(boot).split("|")[0], "false", "…and draws nothing yet");
    assert.equal(failures, 0, "the owner stays published for the player who is still arriving");

    playerKnown = true;
    classKnown = true;
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(characterState(boot), "true|true|false|false|1", "the next C opens the stock paper doll");
    assert.equal(toggleFrameXmlCharacter(), true);
    assert.equal(frameXmlCharacterOpen(), false);

    // A player whose class has no file token (a TSWoW class the dataset does not name): the stock
    // stat rows would strupper(nil), so the owner demotes and the caller opens the native sheet.
    classKnown = false;
    assert.equal(toggleFrameXmlCharacter(), false, "the press falls through to the native route");
    assert.equal(failures, 1, "the owner is demoted");
    assert.equal(characterState(boot).split("|")[0], "false");
    assert.equal(toggleFrameXmlCharacter(), false, "no stock owner remains published");
    assert.equal(boot.errorCount, errorsBefore, "no strupper(nil) error reached the paper doll");
  } finally {
    release?.();
    boot.close();
  }
});

test("frameXmlPlayerClassToken answers only a real class file token", () => {
  const vm = new GlueLuaVm();
  try {
    assert.equal(frameXmlPlayerClassToken(vm), undefined, "no UnitClass binding: no token");
    vm.execute(`UnitClass = function(unit) if unit == "player" then return "Герой", "HERO", 13 end end`, "@t");
    assert.equal(frameXmlPlayerClassToken(vm), "HERO");
    // A TSWoW custom class outside the compiled token table used to answer nil here.
    vm.execute(`UnitClass = function() return "Герой", nil end`, "@t");
    assert.equal(frameXmlPlayerClassToken(vm), undefined);
    vm.execute(`UnitClass = function() return nil end`, "@t");
    assert.equal(frameXmlPlayerClassToken(vm), undefined);
    vm.execute(`UnitClass = function() return "", "" end`, "@t");
    assert.equal(frameXmlPlayerClassToken(vm), undefined);
  } finally {
    vm.close();
  }
});

test("native C and J shortcuts open the stock CharacterFrame pages when it is published", async () => {
  const { openCharacterWindow } = await import("../dist/code/browser/ui/Windows.js");
  const pages = [];
  const release = publishFrameXmlCharacter({
    isOpen: () => true,
    show() { pages.push("show"); },
    hide() { pages.push("hide"); },
    showTab(subFrame) { pages.push(subFrame); },
  });
  try {
    openCharacterWindow("skills");
    openCharacterWindow("sheet");
    assert.deepEqual(pages, ["SkillFrame", "PaperDollFrame"],
      "skills (J) → tab 4; sheet (C) → ToggleCharacter(\"PaperDollFrame\"), even while the frame is open");
  } finally {
    release();
  }
});
