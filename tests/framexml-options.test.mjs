import assert from "node:assert/strict";
import test from "node:test";

// The options lane's pure parts: the C API the settings model answers, the classification of the
// stock controls, the «WebClient» category's contents, and the route the menus ask first.
const {
  createFrameXmlOptionsModel, FRAMEXML_OPTIONS_BINDINGS, FRAMEXML_OPTIONS_UNAVAILABLE, FRAMEXML_OPTIONS_SESSION_ONLY,
  FRAMEXML_OPTIONS_FIXED_ON, frameXmlOptionsWebClientGroups, frameXmlOptionsCategorySource,
} = await import("../dist/code/browser/framexml/FrameXmlOptions.js");
const {
  createFrameXmlSettingsCVar, FRAME_XML_SETTINGS_CVARS, FRAME_XML_WEBCLIENT_CVARS,
} = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings, SETTING_DEFINITIONS } = await import("../dist/code/browser/ui/SettingsModel.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlOptionsController.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_OPTIONS_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

function settingsModel(overrides = {}) {
  let values = { ...defaultSettings(), ...overrides };
  const writes = [];
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { writes.push([id, value]); values = { ...values, [id]: value }; },
  });
  return { cvars, writes, values: () => values, model: createFrameXmlOptionsModel(cvars) };
}

test("the options C API names are seam bindings and answer nil without a settings model", () => {
  for (const name of ["GetCVarMin", "GetCVarMax", "GetActionBarToggles", "SetActionBarToggles", "RestoreVideoEffectsDefaults"]) {
    assert.ok(FRAMEXML_SEAM_NAMES.includes(name), name);
    assert.equal(FRAMEXML_SEAM_BINDINGS[name], FRAMEXML_OPTIONS_BINDINGS[name], `${name} is the options lane's binding`);
    assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS[name]({}, ["uiscale", 1, 1, 1, 1]), [], `${name} without a model`);
  }
});

test("GetCVarMin/GetCVarMax answer a mapped numeric CVar's clamp and nothing for the rest", () => {
  const { model } = settingsModel();
  const seam = { options: model };
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetCVarMin(seam, ["groundEffectDist"]), [0]);
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetCVarMax(seam, ["groundEffectDist"]), [180]);
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetCVarMin(seam, ["UISCALE"]), [0.75]);
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetCVarMax(seam, ["webclient_grassDensity"]), [4]);
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetCVarMin(seam, ["farclip"]), [], "the panel table's range stays");
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetCVarMin(seam, ["chatBubbles"]), [], "a switch has no range");
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetCVarMin(seam, [undefined]), []);
});

test("GetActionBarToggles reads the four bar settings; SetActionBarToggles writes only what changed, C-truthily", () => {
  const { model, writes, values } = settingsModel({ actionBarBottomLeft: true, actionBarRight: true });
  const seam = { options: model };
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.GetActionBarToggles(seam, []), [true, false, true, false]);
  // InterfaceOptions_UpdateMultiActionBars sends "1" or nil, plus ALWAYS_SHOW_MULTIBARS fifth.
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.SetActionBarToggles(seam, ["1", "1", undefined, undefined, "1"]), []);
  assert.deepEqual(writes, [["actionBarBottomRight", true], ["actionBarRight", false]]);
  FRAMEXML_OPTIONS_BINDINGS.SetActionBarToggles(seam, ["0", false, 0, null]);
  assert.deepEqual(writes.slice(2), [["actionBarBottomLeft", false], ["actionBarBottomRight", false]],
    "\"0\", false, 0 and nil are all off");
  assert.equal(values().actionBarRight2, false);
});

test("RestoreVideoEffectsDefaults puts the Effects panel's mapped CVars back to their defaults, writing only what differs", () => {
  const { model, writes, values } = settingsModel({ grassRadius: 150, fullscreenGlow: false, renderScale: 70 });
  const seam = { options: model };
  assert.deepEqual(FRAMEXML_OPTIONS_BINDINGS.RestoreVideoEffectsDefaults(seam, []), []);
  assert.deepEqual(writes, [["grassRadius", 80], ["fullscreenGlow", true]], "the grass radius and the glow; nothing outside the panel");
  assert.equal(values().renderScale, 70);
  FRAMEXML_OPTIONS_BINDINGS.RestoreVideoEffectsDefaults(seam, []);
  assert.equal(writes.length, 2, "already at the defaults: no write");
});

test("the options chain is stock TOC 37-45 minus the template the vertical already carries, and not in the vertical", () => {
  assert.deepEqual(FRAMEXML_OPTIONS_TOC, ["Sound.lua", "OptionsFrameTemplates.xml", "VideoOptionsFrame.xml",
    "VideoOptionsPanels.xml", "AudioOptionsFrame.xml", "AudioOptionsPanels.xml", "InterfaceOptionsFrame.xml",
    "InterfaceOptionsPanels.xml"]);
  const vertical = new Set(FRAMEXML_VERTICAL_TOC.map((entry) => entry.toLowerCase()));
  for (const entry of FRAMEXML_OPTIONS_TOC) assert.equal(vertical.has(entry.toLowerCase()), false, `${entry} loads late`);
  assert.ok(vertical.has("optionspaneltemplates.xml"));
});

test("a stock control is unavailable, session-only or fixed — never two of them", () => {
  const unavailable = new Set(FRAMEXML_OPTIONS_UNAVAILABLE.keys());
  for (const name of FRAMEXML_OPTIONS_SESSION_ONLY) assert.equal(unavailable.has(name), false, name);
  for (const name of FRAMEXML_OPTIONS_FIXED_ON.keys()) {
    assert.equal(unavailable.has(name), false, name);
    assert.equal(FRAMEXML_OPTIONS_SESSION_ONLY.includes(name), false, name);
  }
  assert.equal(new Set(FRAMEXML_OPTIONS_SESSION_ONLY).size, FRAMEXML_OPTIONS_SESSION_ONLY.length);
  for (const [name, reason] of FRAMEXML_OPTIONS_UNAVAILABLE) {
    assert.match(name, /^(?:Video|Audio|Interface)Options/, name);
    assert.ok(reason.length > 10, `${name} says why`);
  }
  // «WebClient → Игра» holds the camera's one browser setting; no reason sends a mouse control there.
  const game = frameXmlOptionsWebClientGroups().find((group) => group.key === "Game");
  assert.deepEqual(game.controls.map((control) => control.setting), ["cameraMaxDistance"]);
  for (const [name, reason] of FRAMEXML_OPTIONS_UNAVAILABLE) {
    if (reason.includes("WebClient → Игра")) assert.match(name, /^InterfaceOptionsCameraPanel/, name);
  }
  assert.equal(FRAMEXML_OPTIONS_UNAVAILABLE.get("InterfaceOptionsMousePanelInvertMouse"), "Браузерный клиент этого не поддерживает.");
  // The mapped controls stay usable.
  for (const name of ["VideoOptionsEffectsPanelFullScreenGlow", "VideoOptionsEffectsPanelClutterRadius",
    "VideoOptionsResolutionPanelUIScaleSlider", "AudioOptionsSoundPanelEnableSound", "AudioOptionsSoundPanelAmbienceVolume",
    "InterfaceOptionsControlsPanelLootAtMouse", "InterfaceOptionsActionBarsPanelBottomLeft",
    "InterfaceOptionsNamesPanelUnitNameplatesEnemies", "InterfaceOptionsCombatTextPanelEnableFCT"]) {
    assert.equal(unavailable.has(name), false, name);
  }
});

test("the WebClient category carries every browser setting without a stock control, in the window's groups", () => {
  const groups = frameXmlOptionsWebClientGroups();
  const carried = groups.flatMap((group) => group.controls.map((control) => control.setting));
  assert.deepEqual([...carried].sort(), FRAME_XML_WEBCLIENT_CVARS.map((row) => row.setting).sort());
  const stock = new Set(FRAME_XML_SETTINGS_CVARS.map((row) => row.setting));
  for (const definition of SETTING_DEFINITIONS) {
    const where = definition.ownWindow ? "own" : stock.has(definition.id) ? "stock" : carried.includes(definition.id) ? "webclient" : "lost";
    assert.notEqual(where, "lost", `${definition.id} has a home`);
  }
  assert.deepEqual(groups.map((group) => group.key), ["Game", "Graphics", "Effects", "Interface", "Chat"]);
  // The chat group alone configures the native dock (ChatDock.ts, #chat-log), which the stock chat hides.
  assert.deepEqual(groups.filter((group) => group.nativeChatOnly).map((group) => group.key), ["Chat"]);
  const graphics = groups.find((group) => group.key === "Graphics");
  assert.deepEqual(graphics.controls.find((control) => control.setting === "renderScale"),
    { cvar: "webclient_renderScale", setting: "renderScale", kind: "slider", text: "Масштаб отрисовки, %",
      tooltip: SETTING_DEFINITIONS.find((definition) => definition.id === "renderScale").hint, min: 50, max: 100, step: 5 });
  const source = frameXmlOptionsCategorySource(groups);
  assert.match(source, /InterfaceOptions_AddCategory\(root\)/);
  assert.match(source, /for group = #groups, 1, -1 do/, "children are inserted after their parent, so last first");
});

test("the WebClient «Эффекты» panel carries the settings window's subsections and a panel that overflows scrolls", () => {
  const groups = frameXmlOptionsWebClientGroups();
  const effects = groups.find((group) => group.key === "Effects");
  const titles = effects.controls.map((control) => control.section);
  assert.ok(titles.every((title) => typeof title === "string"), "every Effects control sits under a subsection");
  const order = titles.filter((title, index) => title !== titles[index - 1]);
  assert.deepEqual(order, ["Свет и атмосфера", "Вода", "Тени и рельеф", "Погода и ветер"],
    "each subsection's controls are contiguous, in the window's order");
  // The stock «Полноэкранное свечение» (ffxGlow) stays on the Video frame and leads nothing here.
  assert.equal(effects.controls.some((control) => control.setting === "fullscreenGlow"), false);
  for (const group of groups.filter((candidate) => candidate.key !== "Effects")) {
    assert.ok(group.controls.every((control) => control.section === undefined), `${group.key} stays one flat list`);
  }
  const source = frameXmlOptionsCategorySource(groups);
  assert.match(source, /section = "Погода и ветер"/);
  assert.match(source, /CreateFrame\("ScrollFrame", panel:GetName\(\) \.\. "Scroll", panel, "UIPanelScrollFrameTemplate"\)/);
  assert.doesNotMatch(source, /x, y = 216, top/, "no second column that runs on below the frame");
  assert.equal(source.match(/\blocal host\b/g)?.length, 1,
    "the layout never shadows `host` (__fxWebClientOptions), which the «Чат» panel's refresh calls");
});

test("the route answers false until published, opens and toggles through the owner, and stops after a failure", () => {
  const calls = [];
  let open = false;
  let failed = false;
  const owner = {
    get failed() { return failed; },
    isOpen: () => open,
    open: (window, fromMenu) => { calls.push(["open", window, fromMenu]); open = true; return true; },
    close: () => { calls.push(["close"]); const was = open; open = false; return was; },
    dispose: () => { calls.push(["dispose"]); open = false; },
  };
  assert.equal(controller.openFrameXmlOptions("video"), false);
  assert.equal(controller.toggleFrameXmlOptions("webclient"), false);
  assert.equal(controller.frameXmlOptionsOpen(), false);
  const cleanup = controller.publishFrameXmlOptions(owner);
  assert.equal(controller.frameXmlOptionsPublished(), true);
  assert.equal(controller.openFrameXmlOptions("video", true), true);
  assert.equal(controller.frameXmlOptionsOpen(), true);
  assert.equal(controller.toggleFrameXmlOptions("webclient"), true, "an open frame toggles shut");
  assert.equal(controller.toggleFrameXmlOptions("webclient"), true);
  assert.equal(controller.closeFrameXmlOptions(), true);
  assert.deepEqual(calls, [["open", "video", true], ["close"], ["open", "webclient", false], ["close"]]);
  failed = true;
  assert.equal(controller.openFrameXmlOptions("audio"), false, "a failed owner hands the route back");
  assert.equal(controller.frameXmlOptionsPublished(), false);
  cleanup();
  cleanup();
  assert.deepEqual(calls.at(-1), ["dispose"]);
  assert.equal(calls.filter((call) => call[0] === "dispose").length, 1, "cleanup is idempotent");
  assert.equal(controller.closeFrameXmlOptions(), false);
});

test("a second publication replaces the first, whose late cleanup cannot unpublish the new owner", () => {
  const make = (tag, log) => ({ failed: false, isOpen: () => false, open: () => { log.push(tag); return true; }, close: () => false, dispose: () => { log.push(`dispose ${tag}`); } });
  const log = [];
  const first = controller.publishFrameXmlOptions(make("a", log));
  const second = controller.publishFrameXmlOptions(make("b", log));
  first();
  assert.equal(controller.openFrameXmlOptions("video"), true);
  assert.deepEqual(log, ["dispose a", "b"]);
  second();
  assert.equal(controller.openFrameXmlOptions("video"), false);
});
