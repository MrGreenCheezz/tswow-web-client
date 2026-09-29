import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock Video/Audio/Interface options chain, loaded late into the booted vertical by
// FrameXmlOptionsOwner.ts, over the canned world with a settings model behind its CVars.
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

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH, FRAMEXML_OPTIONS_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { createFrameXmlSettingsCVar } = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");
const { enhancedGraphicsSettings } = await import("../dist/code/browser/ui/EnhancedGraphics.js");
const { comparisonGraphicsSettings } = await import("../dist/code/browser/ui/ComparisonProfile.js");
const {
  loadFrameXmlOptionsChain, frameXmlOptionsGate, createLazyFrameXmlOptionsOwner, installFrameXmlOptionsActionBars,
} = await import("../dist/code/browser/framexml/FrameXmlOptionsOwner.js");
const {
  FRAMEXML_OPTIONS_UNAVAILABLE, FRAMEXML_OPTIONS_SESSION_NOTE, FRAMEXML_OPTIONS_NATIVE_CHAT_NOTE,
} = await import("../dist/code/browser/framexml/FrameXmlOptions.js");
const controller = await import("../dist/code/browser/framexml/FrameXmlOptionsController.js");
const { installFrameXmlGameMenuButtons } = await import("../dist/code/browser/framexml/FrameXmlGameMenuOwner.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();

async function load({ settings = {}, hide = [] } = {}) {
  let values = { ...defaultSettings(), ...settings };
  const writes = [];
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { writes.push([id, value]); values = { ...values, [id]: value }; },
  });
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cvars);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        if (hide.includes(normalize(path))) return undefined;
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  // What the world mount does around the load: the presentation uvar set before the exercise
  // (beforeExercise) and the stock clock (loadFrameXmlStockClock), whose «Часы» switch the Display
  // panel's first PLAYER_ENTERING_WORLD reaches.
  boot.vm.setGlobal("WORLD_PVP_OBJECTIVES_DISPLAY", "1");
  const clock = await boot.loadAddon("Blizzard_TimeManager");
  assert.equal(clock.ok, true, clock.message);
  // Count the client's load-error dialog (UIParentLoadAddOn → message): a late load must not raise one.
  const messages = [];
  boot.vm.registerGlobal("message", (args) => { messages.push(String(args[0])); return []; });
  // Settings.applySettingsPreset: the whole profile in one write.
  const preset = (kind) => {
    writes.push(["preset", kind]);
    values = kind === "enhanced" ? enhancedGraphicsSettings(values) : comparisonGraphicsSettings(values);
  };
  return { boot, seam, cvars, writes, values: () => values, preset, inventory, messages };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "options-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** A renderer stand-in whose element tree mirrors the frame tree, as FrameXmlDomRenderer's does. */
function treeRenderer() {
  const elements = new Map();
  const added = [];
  const elementFor = (frame) => {
    if (!frame) return null;
    if (!elements.has(frame)) {
      const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
      elements.set(frame, { get parentElement() { return elementFor(frame.parent); }, getAttribute: (name) => attributes.get(name) ?? null });
    }
    return elements.get(frame);
  };
  return { elementFor, addRoots: (roots) => { added.push(...roots); }, sync() {}, added };
}

const host = (log = []) => ({ preset: (kind) => { log.push(kind); }, storageNote: () => "note", log });

let shared;
const loaded = () => shared ??= (async () => {
  const context = await load({ settings: { actionBarBottomLeft: true } });
  const errors = context.boot.errorCount;
  const diagnostics = context.boot.bridge.diagnostics.length;
  const framesBefore = context.boot.bridge.frames.length;
  // Every emission is one renderer pass in the world mount (FrameXmlDomRenderer subscribes sync).
  let emissions = 0;
  const unsubscribe = context.boot.bridge.subscribe(() => { emissions += 1; });
  // Whether the native chat dock is on screen: the world mount's stock chat hides it when it passes.
  const chat = { native: false };
  const result = await loadFrameXmlOptionsChain(context.boot,
    { preset: context.preset, storageNote: () => "note", nativeChat: () => chat.native });
  unsubscribe();
  return { ...context, result, errors, diagnostics, framesBefore, emissions, chat };
})();
after(async () => { if (shared) (await shared).boot.close(); });

test("the chain's own files sit at stock TOC 37-45 around the vertical's OptionsPanelTemplates.xml", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  const at = toc.indexOf("sound.lua");
  assert.deepEqual(toc.slice(at, at + 9), ["sound.lua", "optionsframetemplates.xml", "optionspaneltemplates.xml",
    "videooptionsframe.xml", "videooptionspanels.xml", "audiooptionsframe.xml", "audiooptionspanels.xml",
    "interfaceoptionsframe.xml", "interfaceoptionspanels.xml"]);
  assert.deepEqual(toc.slice(at, at + 9).filter((entry) => entry !== "optionspaneltemplates.xml"),
    FRAMEXML_OPTIONS_TOC.map((entry) => entry.toLowerCase()));
});

test("loaded late: 17 files, no Lua error or diagnostic, nothing written, the stock categories in the Game tab", withClient, async () => {
  const { boot, result, errors, diagnostics, writes, framesBefore, messages, emissions } = await loaded();
  assert.equal(result.ok, true, result.message);
  // One render transaction per TOC entry and one for the category and first events: measured with
  // GlueLoader's unbatched walk, 1,096 renderer passes of ~22,000 frames each on the first open.
  assert.ok(emissions <= FRAMEXML_OPTIONS_TOC.length + 1, `${emissions} mutation notifications`);
  assert.deepEqual({ files: result.files, bytes: result.bytes, widgets: result.widgets },
    { files: 17, bytes: 410017, widgets: boot.bridge.frames.length - framesBefore });
  assert.equal(boot.errorCount, errors);
  assert.equal(boot.bridge.diagnostics.length, diagnostics);
  assert.deepEqual(writes, [], "opening the options changes no setting");
  assert.deepEqual(messages, [], "no «Ошибка загрузки» dialog (Blizzard_CombatText, Blizzard_TimeManager)");
  assert.equal(result.disabled, FRAMEXML_OPTIONS_UNAVAILABLE.size, "every unavailable control exists and is greyed");
  const [categories, addOns, secure, window] = lua(boot, `
    InterfaceOptionsFrame:Show()
    local names = {}
    for _, button in ipairs(InterfaceOptionsFrameCategories.buttons) do
      if button:IsShown() and button.element then names[#names + 1] = button.element.name end
    end
    InterfaceOptionsFrame:Hide()
    return table.concat(names, "|"), #INTERFACEOPTIONS_ADDONCATEGORIES, issecure() and 1 or 0, __fxWebClientOptionsSecure == nil and 1 or 0
  `, 4);
  // issecure() true only for the chain's own code: with the VM's false every stock panel was an
  // «AddOns» entry sorted by name and the Game tab was empty.
  assert.equal(categories, "Управление|Бой|Графика|Задачи|TInterface\\OptionsFrame\\UI-OptionsFrame-NewFeatureIcon:0:0:0:-1|t"
    + "|Общение|Панели команд|Имена|Текст боя|Текст индикаторов|Рамки портретов|Эффекты и ауры|Камера|Мышь"
    + "|Особые возможности|Помощь|WebClient");
  assert.equal(addOns, 0);
  assert.equal(secure, 0, "the secure window closed with the load");
  assert.equal(window, 1);
  assert.deepEqual(lua(boot, "return WORLD_PVP_OBJECTIVES_DISPLAY, GetCVar('displayWorldPVPObjectives'), UIDropDownMenu_GetSelectedValue(InterfaceOptionsDisplayPanelWorldPVPObjectiveDisplay)", 3),
    ["1", "1", "1"], "a uvar the host set keeps its value through InterfaceOptionsFrame_OnLoad");
  const renderer = treeRenderer();
  const frames = frameXmlOptionsGate(boot, renderer);
  assert.ok(frames, "the gate passes");
  assert.deepEqual([frames.video.name, frames.audio.name, frames.interface.name],
    ["VideoOptionsFrame", "AudioOptionsFrame", "InterfaceOptionsFrame"]);
  assert.equal(boot.errorCount, errors, "the gate's probe raised nothing");
});

test("the audio panel is the browser's sound: sliders and switches read the settings, write live, and Cancel reverts", withClient, async () => {
  const { boot, writes, values } = await loaded();
  const from = writes.length;
  assert.deepEqual(lua(boot, `ShowUIPanel(AudioOptionsFrame)
    return AudioOptionsSoundPanelMasterVolume:GetValue(), AudioOptionsSoundPanelMusicVolume:GetValue(),
      AudioOptionsSoundPanelAmbienceVolume:GetValue(), AudioOptionsSoundPanelEnableSound:GetChecked() and 1 or 0,
      AudioOptionsSoundPanelMasterVolume:IsEnabled(), AudioOptionsSoundPanelReverb:IsEnabled()`, 6),
  [0.7, 0.6, 0.6, 1, 1, 0]);
  const master = boot.bridge.getFrame("AudioOptionsSoundPanelMasterVolume");
  boot.bridge.SetValue(master, 0.36, true);
  lua(boot, "AudioOptionsSoundPanelEnableSound:Click()", 0);
  assert.deepEqual(writes.slice(from), [["volumeMaster", 40], ["soundEnabled", false]], "a drag snaps to the stock 0.1 step");
  // «Звуковые эффекты» enables its three children as it switches back on (BlizzardOptionsPanel_
  // SetupDependentControl); the two the browser cannot honour stay grey.
  lua(boot, "AudioOptionsSoundPanelSoundEffects:Click() AudioOptionsSoundPanelSoundEffects:Click()", 0);
  assert.deepEqual(writes.slice(from + 2), [["soundEffectsEnabled", false], ["soundEffectsEnabled", true]]);
  assert.deepEqual(lua(boot, "return AudioOptionsSoundPanelErrorSpeech:IsEnabled(), AudioOptionsSoundPanelEmoteSounds:IsEnabled(), AudioOptionsSoundPanelErrorSpeech.tooltipRequirement", 3),
    [0, 0, "Браузерный клиент этого не поддерживает."]);
  lua(boot, "AudioOptionsFrameCancel:Click()", 0);
  assert.equal(values().volumeMaster, 70);
  assert.equal(values().soundEnabled, true);
  assert.equal(boot.bridge.getFrame("AudioOptionsFrame").visible, false);
});

test("the video panel writes on Okay: glow, grass radius in yards, interface size; the rest is greyed with a reason", withClient, async () => {
  const { boot, writes, values, cvars } = await loaded();
  // Radius 70 and no glow are the «Низкое» preset's own values, and the unavailable sliders rest at
  // their minimums — that preset too, but for TextureResolution (1 from BaseMip 0). The browser has no
  // quality levels, and the stock detection agrees: «Вручную» (6), never a preset it could apply.
  cvars.set("groundEffectDist", 70);
  cvars.set("ffxGlow", "0");
  assert.deepEqual(lua(boot, `ShowUIPanel(VideoOptionsFrame)
    return VideoOptionsEffectsPanelQualitySlider:GetValue(), VideoOptionsEffectsPanel.videoQuality`, 2), [6, 6]);
  lua(boot, "VideoOptionsFrameCancel:Click()", 0);
  cvars.set("groundEffectDist", 80);
  cvars.set("ffxGlow", "1");
  const from = writes.length;
  assert.deepEqual(lua(boot, `ShowUIPanel(VideoOptionsFrame)
    local radius, scale = VideoOptionsEffectsPanelClutterRadius, VideoOptionsResolutionPanelUIScaleSlider
    local rmin, rmax = radius:GetMinMaxValues()
    local smin, smax = scale:GetMinMaxValues()
    return radius:GetValue(), rmin, rmax, scale:GetValue(), smin, smax,
      VideoOptionsResolutionPanelUseUIScale:GetChecked() and 1 or 0, VideoOptionsResolutionPanelUseUIScale:IsEnabled(),
      VideoOptionsEffectsPanelQualitySlider:GetValue(), VideoOptionsEffectsPanelQualitySlider:IsEnabled(),
      VideoOptionsEffectsPanelShadowQuality:IsEnabled(), VideoOptionsResolutionPanelVSync.tooltipRequirement`, 12),
  [80, 0, 180, 1, 0.75, 1.25, 1, 0, 6, 0, 0, "Экраном, разрешением и частотой кадров управляет браузер."]);
  boot.bridge.SetValue(boot.bridge.getFrame("VideoOptionsEffectsPanelClutterRadius"), 121, true);
  boot.bridge.SetValue(boot.bridge.getFrame("VideoOptionsResolutionPanelUIScaleSlider"), 0.9, true);
  lua(boot, "VideoOptionsEffectsPanelFullScreenGlow:Click()", 0);
  assert.deepEqual(writes.slice(from), [], "the Video frame applies on Okay, as the client does");
  lua(boot, "VideoOptionsFrameOkay:Click()", 0);
  assert.deepEqual(writes.slice(from).sort(), [["fullscreenGlow", false], ["grassRadius", 120], ["uiScale", 90]]);
  assert.equal(values().grassRadius, 120);
  assert.equal(boot.bridge.getFrame("VideoOptionsFrame").visible, false);
});

test("the video «По умолчанию» resets the grass radius, the glow and the interface size when confirmed", withClient, async () => {
  const { boot, writes, values, cvars } = await loaded();
  cvars.set("groundEffectDist", 150);
  cvars.set("ffxGlow", "0");
  cvars.set("uiscale", 1.1);
  const from = writes.length;
  assert.deepEqual(lua(boot, `ShowUIPanel(VideoOptionsFrame)
    return VideoOptionsEffectsPanelClutterRadius:GetValue(), VideoOptionsEffectsPanelFullScreenGlow:GetChecked() and 1 or 0`, 2), [150, 0]);
  lua(boot, "VideoOptionsFrameDefaults:Click()", 0);
  assert.deepEqual(writes.slice(from), [], "nothing before the confirmation");
  // VideoOptionsEffectsPanel_Default resets its panel through RestoreVideoEffectsDefaults alone.
  assert.deepEqual(lua(boot, `local name = StaticPopup_Visible("CONFIRM_RESET_VIDEO_SETTINGS")
    if name then _G[name .. "Button1"]:Click() end
    return name and 1 or 0, VideoOptionsEffectsPanelClutterRadius:GetValue(), VideoOptionsEffectsPanelFullScreenGlow:GetChecked() and 1 or 0,
      VideoOptionsResolutionPanelUIScaleSlider:GetValue()`, 4), [1, 80, 1, 1]);
  assert.deepEqual(writes.slice(from).sort(), [["fullscreenGlow", true], ["grassRadius", 80], ["uiScale", 100]]);
  lua(boot, "VideoOptionsFrameOkay:Click()", 0);
  assert.equal(writes.length, from + 3, "«Окей» has nothing left to write");
  assert.deepEqual([values().grassRadius, values().fullscreenGlow, values().uiScale], [80, true, 100]);
  assert.equal(boot.bridge.getFrame("VideoOptionsFrame").visible, false);
});

test("the interface panels: bars switch the stock multibars at once, FCT keeps its details grey, Cancel reverts", withClient, async () => {
  const { boot, writes, values, messages } = await loaded();
  const from = writes.length;
  assert.deepEqual(lua(boot, `ShowUIPanel(InterfaceOptionsFrame) InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsActionBarsPanel)
    return InterfaceOptionsActionBarsPanelBottomLeft:GetChecked() and 1 or 0, InterfaceOptionsActionBarsPanelBottomRight:GetChecked() and 1 or 0,
      InterfaceOptionsActionBarsPanelLockActionBars.tooltipRequirement`, 3), [1, 0, FRAMEXML_OPTIONS_SESSION_NOTE]);
  lua(boot, "InterfaceOptionsActionBarsPanelBottomRight:Click()", 0);
  assert.deepEqual(writes.slice(from), [["actionBarBottomRight", true]]);
  assert.deepEqual(lua(boot, "return SHOW_MULTI_ACTIONBAR_2, MultiBarBottomRight:IsShown() and 1 or 0", 2), ["1", 1]);
  lua(boot, `InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsCombatTextPanel)
    InterfaceOptionsCombatTextPanelEnableFCT:Click() InterfaceOptionsCombatTextPanelEnableFCT:Click()`, 0);
  assert.deepEqual(writes.slice(from + 1), [["floatingCombatText", false], ["floatingCombatText", true]]);
  assert.deepEqual(lua(boot, "return InterfaceOptionsCombatTextPanelDodgeParryMiss:IsEnabled(), InterfaceOptionsCombatTextPanelDodgeParryMiss.tooltipRequirement", 2),
    [0, "Всплывающий текст боя браузерного клиента включается только целиком."], "a dependency cannot re-enable it");
  assert.deepEqual(messages, [], "switching FCT on did not try to load Blizzard_CombatText");
  lua(boot, "InterfaceOptionsFrameCancel:Click()", 0);
  assert.equal(values().actionBarBottomRight, false);
  assert.deepEqual(lua(boot, "return MultiBarBottomRight:IsShown() and 1 or 0, InterfaceOptionsFrame:IsShown() and 1 or 0", 2), [0, 0]);
});

test("the WebClient category: every control a live stock control, Cancel reverts, Defaults leaves the interface on", withClient, async () => {
  const { boot, writes, values } = await loaded();
  const from = writes.length;
  const [panel, graphics] = lua(boot, `ShowUIPanel(InterfaceOptionsFrame)
    InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsWebClientGraphicsPanel)
    local out = {}
    for _, control in ipairs(InterfaceOptionsWebClientGraphicsPanel.controls) do
      out[#out + 1] = _G[control:GetName() .. "Text"]:GetText()
    end
    return InterfaceOptionsFramePanelContainer.displayedPanel:GetName(), table.concat(out, "|")`, 2);
  assert.equal(panel, "InterfaceOptionsWebClientGraphicsPanel");
  assert.equal(graphics, "Масштаб отрисовки, %: 100|Автокачество графики|Качество освещения: 1|Скрывать невидимые помещения"
    + "|Чёткость текстур персонажей|Густая трава|Густота травы: 2");
  assert.deepEqual(lua(boot, `local names = {}
    for _, button in ipairs(InterfaceOptionsFrameCategories.buttons) do
      if button:IsShown() and button.element and button.element.parent == "WebClient" then names[#names + 1] = button.element.name end
    end
    return table.concat(names, "|")`), ["Игра|Графика|Эффекты|Интерфейс|Чат"], "opening a section expands the category, in the window's order");
  boot.bridge.SetValue(boot.bridge.getFrame("InterfaceOptionsWebClientGraphicsPanel1"), 72, true);
  lua(boot, "InterfaceOptionsWebClientGraphicsPanel2:Click()", 0);
  assert.deepEqual(writes.slice(from), [["renderScale", 70], ["autoQuality", false]], "live, snapped to the setting's step");
  assert.deepEqual(lua(boot, "return InterfaceOptionsWebClientGraphicsPanel1Text:GetText()"), ["Масштаб отрисовки, %: 70"]);
  lua(boot, "InterfaceOptionsFrameCancel:Click()", 0);
  assert.equal(values().renderScale, 100);
  assert.equal(values().autoQuality, true);
  lua(boot, `ShowUIPanel(InterfaceOptionsFrame) InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsWebClientInterfacePanel)
    InterfaceOptionsWebClientInterfacePanel1:Click() InterfaceOptionsWebClientInterfacePanel3:Click()`, 0);
  await Promise.resolve();
  assert.equal(values().originalFrameXml, true, "the interface switch lands after the Lua call");
  assert.equal(values().showFps, true);
  lua(boot, "InterfaceOptionsFrame_SetAllToDefaults()", 0);
  await Promise.resolve();
  assert.equal(values().showFps, false, "Defaults resets the category");
  assert.equal(values().originalFrameXml, true, "…but not the interface it is drawn in");
  lua(boot, "InterfaceOptionsFrameOkay:Click()", 0);
});

test("the WebClient «Эффекты» panel is one column under its subsections, scrolled inside the frame", withClient, async () => {
  const { boot, writes } = await loaded();
  const from = writes.length;
  const [count, inChild, columns, fits, headings, graphicsScroll, wheel, childHeight] = lua(boot, `ShowUIPanel(InterfaceOptionsFrame)
    InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsWebClientEffectsPanel)
    local panel = InterfaceOptionsWebClientEffectsPanel
    local scroll = InterfaceOptionsWebClientEffectsPanelScroll
    local child = scroll and scroll:GetScrollChild()
    local inChild, xs, seen, lowest = 0, {}, {}, 0
    for _, control in ipairs(panel.controls) do
      if child and control:GetParent() == child then inChild = inChild + 1 end
      local _, _, _, x, y = control:GetPoint(1)
      if not seen[x] then seen[x] = true xs[#xs + 1] = x end
      lowest = math.max(lowest, -y + control:GetHeight())
    end
    table.sort(xs)
    local headings = {}
    for index = 1, 8 do
      local heading = _G[panel:GetName() .. "Heading" .. index]
      if heading then headings[#headings + 1] = heading:GetText() end
    end
    InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsWebClientGraphicsPanel)
    local graphicsScroll = InterfaceOptionsWebClientGraphicsPanelScroll ~= nil
    InterfaceOptionsFrameCancel:Click()
    return #panel.controls, inChild, table.concat(xs, ","), child and lowest <= child:GetHeight() and 1 or 0,
      table.concat(headings, "|"), graphicsScroll and 1 or 0, scroll and scroll:GetScript("OnMouseWheel") and 1 or 0,
      child and child:GetHeight() or 0`, 8);
  assert.equal(inChild, count, "every Effects control lives in the scroll child, clipped by the frame");
  assert.equal(columns, "16,22", "one column: checks at 16, sliders at 22 — no second column past the frame's edge");
  assert.equal(fits, 1, `the scroll child (${childHeight}) holds the lowest control`);
  assert.equal(headings, "Свет и атмосфера|Вода|Тени и рельеф|Погода и ветер");
  assert.equal(graphicsScroll, 0, "a panel that fits keeps its plain layout");
  assert.equal(wheel, 1, "the stock scroll template's OnMouseWheel scrolls it");
  assert.deepEqual(writes.slice(from), [], "opening and cancelling writes nothing");
});

const WEBCLIENT_CONTROL = `local function webclientControl(cvar)
  for _, panel in ipairs(InterfaceOptionsWebClientPanel.webclientPanels) do
    for _, control in ipairs(panel.controls) do if control.cvar == cvar then return control end end
  end
end`;

test("a preset is an edit: «Отмена» takes it back with the edits before it, «Окей» keeps it", withClient, async () => {
  const { boot, writes, values, cvars } = await loaded();
  cvars.set("ffxGlow", "0");
  const start = values();
  lua(boot, `ShowUIPanel(InterfaceOptionsFrame) InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsActionBarsPanel)
    InterfaceOptionsActionBarsPanelBottomRight:Click()
    InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsWebClientGraphicsPanel)`, 0);
  boot.bridge.SetValue(boot.bridge.getFrame("InterfaceOptionsWebClientGraphicsPanel1"), 70, true);
  const from = writes.length;
  lua(boot, "InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsWebClientPanel) InterfaceOptionsWebClientPanelEnhanced:Click()", 0);
  assert.deepEqual(writes.slice(from), [["preset", "enhanced"]], "the profile lands as one write");
  assert.deepEqual(values(), { ...enhancedGraphicsSettings(start), actionBarBottomRight: true, renderScale: 70 });
  assert.deepEqual(lua(boot, `${WEBCLIENT_CONTROL}
    local rays, light = webclientControl("webclient_godRays"), webclientControl("webclient_lightingQuality")
    return rays:GetChecked() and 1 or 0, light:GetValue(), InterfaceOptionsWebClientGraphicsPanel1:GetValue()`, 3),
  [1, 2, 70], "the controls it moved show it; the edit before it stays");
  // The fullscreen glow is the Video frame's control: the category's own cancel puts it back.
  lua(boot, "InterfaceOptionsFrameCancel:Click()", 0);
  assert.deepEqual(values(), start, "the preset and the unsaved edits before it, all reverted");
  assert.equal(boot.bridge.getFrame("InterfaceOptionsFrame").visible, false);

  lua(boot, "ShowUIPanel(InterfaceOptionsFrame) InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsWebClientPanel) InterfaceOptionsWebClientPanelComparison:Click() InterfaceOptionsFrameOkay:Click()", 0);
  assert.deepEqual(values(), comparisonGraphicsSettings(start));
  lua(boot, "ShowUIPanel(InterfaceOptionsFrame) InterfaceOptionsFrameCancel:Click()", 0);
  assert.deepEqual(values(), comparisonGraphicsSettings(start), "a kept preset is the next open's baseline");
});

test("the WebClient «Чат» settings are greyed with the reason while the stock chat has replaced the native dock", withClient, async () => {
  const { boot, writes, values, chat } = await loaded();
  const open = () => lua(boot, `ShowUIPanel(InterfaceOptionsFrame) InterfaceOptionsFrame_OpenToCategory(InterfaceOptionsWebClientChatPanel)
    local enabled, reasons = 0, 0
    for _, control in ipairs(InterfaceOptionsWebClientChatPanel.controls) do
      if control:IsEnabled() == 1 then enabled = enabled + 1 end
      if control.tooltipRequirement == ${JSON.stringify(FRAMEXML_OPTIONS_NATIVE_CHAT_NOTE)} then reasons = reasons + 1 end
    end
    return #InterfaceOptionsWebClientChatPanel.controls, enabled, reasons, InterfaceOptionsWebClientChatPanelSubText:GetText()`, 4);
  chat.native = false;
  const from = writes.length;
  assert.deepEqual(open(), [7, 0, 7, FRAMEXML_OPTIONS_NATIVE_CHAT_NOTE]);
  lua(boot, "InterfaceOptionsWebClientChatPanel2:Click() InterfaceOptionsFrameCancel:Click()", 0);
  assert.deepEqual(writes.slice(from), [], "a greyed control writes nothing");
  // The stock chat failed its gate: the native dock is back, and so are its settings.
  chat.native = true;
  assert.deepEqual(open(), [7, 7, 0, "Настройки WebClient. Подсказка у каждой — что именно она меняет."]);
  lua(boot, "InterfaceOptionsWebClientChatPanel2:Click()", 0);
  assert.deepEqual(writes.slice(from), [["chatTimestamps", true]]);
  lua(boot, "InterfaceOptionsFrameCancel:Click()", 0);
  assert.equal(values().chatTimestamps, false);
  chat.native = false;
});

test("the lazy owner loads on the menu's first click, returns to the menu on Escape, and the route falls back when unpublished", withClient, async () => {
  const context = await load({ settings: { actionBarBottomLeft: true } });
  const { boot, cvars } = context;
  try {
    // The extra bars follow the settings from the mount on, whether or not the options ever open.
    const renderer = treeRenderer();
    let listener;
    const stopBars = installFrameXmlOptionsActionBars(boot, (next) => { listener = next; return () => { listener = undefined; }; });
    assert.deepEqual(lua(boot, "return SHOW_MULTI_ACTIONBAR_1, MultiBarBottomLeft:IsShown() and 1 or 0, SHOW_MULTI_ACTIONBAR_2", 3), ["1", 1, undefined]);
    cvars.set("rightActionBar", "1");
    listener();
    assert.deepEqual(lua(boot, "return SHOW_MULTI_ACTIONBAR_3, MultiBarRight:IsShown() and 1 or 0", 2), ["1", 1]);
    stopBars();
    assert.equal(listener, undefined);

    const native = [];
    const actions = Object.fromEntries(["video", "sound", "interface", "keybindings", "macros", "diagnostics", "resetLayout", "toggle"]
      .map((name) => [name, () => native.push(name)]));
    assert.equal(installFrameXmlGameMenuButtons(boot, actions), true);
    const failures = [];
    const owner = createLazyFrameXmlOptionsOwner(boot, renderer, { host: host(), onFailure: (wanted) => failures.push(wanted) });
    const unpublish = controller.publishFrameXmlOptions(owner);
    const errors = boot.errorCount;
    lua(boot, "ShowUIPanel(GameMenuFrame) GameMenuButtonOptions:Click()", 0);
    assert.equal(owner.isOpen(), true, "the open waits for the load");
    await owner.settled;
    assert.deepEqual(native, [], "the stock frame, not the native settings window");
    assert.deepEqual(lua(boot, "return VideoOptionsFrame:IsShown() and 1 or 0, VideoOptionsFrame.lastFrame == GameMenuFrame and 1 or 0, GameMenuFrame:IsShown() and 1 or 0", 3), [1, 1, 0]);
    assert.ok(renderer.added.some((frame) => frame.name === "VideoOptionsFrame"), "the parentless frames reach the renderer");
    lua(boot, "ToggleGameMenu()", 0);
    assert.deepEqual(lua(boot, "return VideoOptionsFrame:IsShown() and 1 or 0, GameMenuFrame:IsShown() and 1 or 0", 2), [0, 1],
      "Escape cancels and returns to the menu (OptionsFrame_OnHide's lastFrame)");
    lua(boot, "GameMenuButtonUIOptions:Click()", 0);
    assert.equal(controller.frameXmlOptionsOpen(), true);
    assert.equal(controller.closeFrameXmlOptions(), true);
    assert.deepEqual(lua(boot, "return InterfaceOptionsFrame:IsShown() and 1 or 0, GameMenuFrame:IsShown() and 1 or 0", 2), [0, 1]);
    lua(boot, "HideUIPanel(GameMenuFrame)", 0);
    assert.equal(controller.toggleFrameXmlOptions("webclient"), true);
    assert.deepEqual(lua(boot, "return InterfaceOptionsFramePanelContainer.displayedPanel:GetName(), GameMenuFrame:IsShown() and 1 or 0", 2),
      ["InterfaceOptionsWebClientPanel", 0], "/settings opens the category, with no menu to return to");
    assert.equal(controller.toggleFrameXmlOptions("webclient"), true);
    assert.equal(boot.bridge.getFrame("InterfaceOptionsFrame").visible, false);
    assert.equal(boot.errorCount, errors);
    assert.deepEqual(failures, []);
    unpublish();
    lua(boot, "ShowUIPanel(GameMenuFrame) GameMenuButtonSoundOptions:Click()", 0);
    assert.deepEqual(native, ["sound"], "unpublished, the adapter opens the native section");
  } finally {
    boot.close();
  }
});

test("a chain that cannot load demotes the route and opens the native window the player asked for", withClient, async () => {
  const { boot } = await load({ hide: ["interface/framexml/interfaceoptionspanels.xml"] });
  try {
    const failures = [];
    const owner = createLazyFrameXmlOptionsOwner(boot, treeRenderer(), { host: host(), onFailure: (wanted) => failures.push(wanted) });
    const unpublish = controller.publishFrameXmlOptions(owner);
    assert.equal(controller.openFrameXmlOptions("audio"), true);
    await owner.settled;
    assert.deepEqual(failures, ["audio"]);
    assert.equal(owner.result.ok, false);
    assert.match(owner.result.message, /interfaceoptionspanels\.xml/);
    assert.equal(controller.frameXmlOptionsPublished(), false);
    assert.equal(controller.openFrameXmlOptions("video"), false, "the native window from now on");
    assert.equal(boot.bridge.getFrame("VideoOptionsFrame")?.name, undefined, "nothing ran: the scan refused first");
    unpublish();
  } finally {
    boot.close();
  }
});
