import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { FrameXmlBoot } from "../dist/code/browser/framexml/FrameXmlBoot.js";
import { discoverFrameXmlAddonEntrypoints } from "../dist/code/browser/framexml/FrameXmlAddonEntrypoints.js";
import { defaultSettings, parseSettings } from "../dist/code/browser/ui/SettingsModel.js";

function bootFor(files, library = [], includeActiveTsAddons = true) {
  return new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": [
        "GlobalStrings.lua",
        ...(library.length ? ["## tsaddon-begin-lib", ...library, "## tsaddon-end-lib"] : []),
        "## tsaddon-begin: author-new-module",
        "TSAddons/author-new-module/addon/addon.xml",
        "## tsaddon-end: author-new-module",
      ].join("\n"),
      "interface/framexml/globalstrings.lua": `
        ADDON_MISSING = 'missing'
        SlashCmdList = { STOCK = function() end }; SLASH_STOCK1 = '/stock'
        GameMenuFrame = CreateFrame('Frame', 'GameMenuFrame')
      `,
      ...files,
    }),
    subset: ["GlobalStrings.lua"],
    includeActiveTsAddons,
    exercise: false,
  });
}

const root = "interface/framexml/tsaddons/author-new-module/addon/";

test("disabled TSWoW addons execute neither the shared library nor module scripts and can be enabled again", async () => {
  assert.equal(defaultSettings().tswowAddons, false);
  assert.equal(parseSettings('{"showFps":true}').tswowAddons, false,
    "a pre-existing settings blob starts with addons disabled");
  const files = {
    "interface/framexml/tsaddons/lib/probe.lua": "AddonLibraryStarted = true",
    [root + "addon.xml"]: '<Ui><Script file="addon.lua"/></Ui>',
    [root + "addon.lua"]: `
      AddonModuleStarted = true
      CreateFrame("Frame", "AddonProbeFrame")
      SLASH_ADDONPROBE1 = "/addonprobe"
      SlashCmdList.ADDONPROBE = function() end
    `,
  };
  for (const enabled of [false, true]) {
    const boot = bootFor(files, ["TSAddons/lib/probe.lua"], enabled);
    let entrypoints;
    try {
      await boot.load();
      assert.equal(boot.vm.getGlobal("AddonLibraryStarted") === true, enabled);
      assert.equal(boot.vm.getGlobal("AddonModuleStarted") === true, enabled);
      assert.equal(boot.bridge.getFrame("AddonProbeFrame") !== undefined, enabled);
      assert.equal(boot.isAddonLoaded("author-new-module"), enabled);
      entrypoints = discoverFrameXmlAddonEntrypoints(boot);
      assert.equal(entrypoints.commands.some(command => command.name === "addonprobe"), enabled);
      assert.deepEqual(boot.errors, []);
    } finally { entrypoints?.close(); boot.close(); }
  }
});

test("a slash command publishes one completed UI mutation instead of repainting every setter", async () => {
  const boot = bootFor({
    [root + "addon.xml"]: '<Ui><Script file="addon.lua"/></Ui>',
    [root + "addon.lua"]: `
      SLASH_LAZYMODULE1 = "/lazymodule"
      SlashCmdList.LAZYMODULE = function()
        local panel = CreateFrame("Frame", "LazyModulePanel")
        panel:SetSize(360, 240)
        for i = 1, 20 do
          local button = CreateFrame("Button", "LazyModuleButton" .. i, panel)
          button:SetSize(100, 20)
          button:SetPoint("TOPLEFT", panel, "TOPLEFT", 5, -i * 20)
          button:SetText("Row " .. i)
        end
      end
    `,
  });
  let entrypoints;
  try {
    await boot.load();
    entrypoints = discoverFrameXmlAddonEntrypoints(boot);
    const observed = [];
    const unsubscribe = boot.bridge.subscribe(() => {
      const panel = boot.bridge.getFrame("LazyModulePanel");
      observed.push(panel?.children.filter(frame => frame.type === "Button").length);
    });
    entrypoints.commands[0].run("");
    unsubscribe();
    assert.deepEqual(observed, [20], "the renderer must only see the fully constructed panel");
    assert.deepEqual(boot.errors, []);
  } finally { entrypoints?.close(); boot.close(); }
});

test("a new TSWoW module is discovered without a name whitelist and finishes before reporting loaded", async () => {
  const boot = bootFor({
    [root + "addon.xml"]: '<Ui><Script file="addon.lua"/></Ui>',
    [root + "addon.lua"]: `
      LoadedWhileExecuting = IsAddOnLoaded("author-new-module")
      local button = CreateFrame("Button", "NewModuleButton")
      button:SetSize(80, 24)
      button:SetScript("OnClick", function() NewModuleClicks = (NewModuleClicks or 0) + 1 end)
      button:RegisterEvent("PLAYER_ENTERING_WORLD")
      button:SetScript("OnEvent", function() NewModuleEntered = true end)
      SLASH_NEWMODULE1 = "/newmodule"
      SLASH_NEWMODULE2 = "/новый"
      SlashCmdList.NEWMODULE = function(rest) NewModuleArgument = rest; button:Click() end
      local menu = CreateFrame("Button", "NewModuleMenu", GameMenuFrame)
      menu:SetText("Module action")
      menu:SetScript("OnClick", function() NewModuleMenuClicked = true end)
    `,
  });
  try {
    await boot.load();
    assert.equal(boot.vm.getGlobal("LoadedWhileExecuting"), false);
    assert.equal(boot.isAddonLoaded("AUTHOR-NEW-MODULE"), true);
    assert.equal(boot.tsAddonResults[0].ok, true);
    assert.deepEqual(boot.tsAddonResults[0].loaded, [root + "addon.xml", root + "addon.lua"]);
    boot.pump.fire("PLAYER_ENTERING_WORLD");
    const clicked = boot.vm.execute("NewModuleButton:Click()", "@contract-click");
    assert.equal(clicked.ok, true, clicked.error);
    assert.equal(boot.vm.getGlobal("NewModuleEntered"), true);
    assert.equal(boot.vm.getGlobal("NewModuleClicks"), 1);
    const entrypoints = discoverFrameXmlAddonEntrypoints(boot);
    try {
      assert.deepEqual(entrypoints.commands.map((command) => command.name).sort(), ["newmodule", "новый"]);
      const command = entrypoints.commands.find((command) => command.name === "новый");
      command.run('quoted "argument"; error("must stay text")');
      assert.equal(boot.vm.getGlobal("NewModuleArgument"), 'quoted "argument"; error("must stay text")');
      assert.equal(boot.vm.getGlobal("NewModuleClicks"), 2);
      assert.equal(entrypoints.menuButtons[0].label, "Module action");
      entrypoints.menuButtons[0].run();
      assert.equal(boot.vm.getGlobal("NewModuleMenuClicked"), true);
      entrypoints.close();
      command.run("closed");
      assert.equal(boot.vm.getGlobal("NewModuleClicks"), 2);
    } finally { entrypoints.close(); }
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
/** tools/mpq.mjs clientArchives answers one chain per process: closed once, after every test. */
const openedChains = new Set();
after(() => { for (const chain of openedChains) chain.close(); });

test("a module in the generated block raises its own stock dialog and error line over the native HUD", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { normalizeGluePath } = await import("../dist/code/browser/glue/GlueLoader.js");
  const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FrameXmlTsAddonPresentation, markFrameXmlNativeHud } = await import("../dist/code/browser/framexml/FrameXmlTsAddonPresentation.js");
  const { mountFrameXmlAddonsOnlySurfaces } = await import("../dist/code/browser/framexml/FrameXmlAddonsOnlyMessages.js");
  const chain = await clientArchives(clientDirectory);
  openedChains.add(chain);
  const decoder = new TextDecoder("utf-8");
  const module = "interface/framexml/tsaddons/contract-dialogs/addon/";
  // The winning TOC names one generated block; the subset provider appends it to the vertical.
  const overlay = new Map([
    [normalizeGluePath(FRAMEXML_TOC_PATH), [
      "## tsaddon-begin: contract-dialogs",
      "TSAddons/contract-dialogs/addon/addon.lua",
      "## tsaddon-end: contract-dialogs",
    ].join("\n")],
    // retail-talents' reset and survival's warning, in the shapes TSTL emits for them.
    [module + "addon.lua", `
      StaticPopupDialogs["CONTRACT_RESET_TREE"] = {
        text = "Сбросить ветку %s? Все вложенные очки вернутся.", button1 = "Да", button2 = "Нет",
        OnAccept = function() ContractResets = (ContractResets or 0) + 1 end,
        timeout = 0, whileDead = true, hideOnEscape = true,
      }
      local reset = CreateFrame("Button", "ContractResetButton", UIParent)
      reset:SetSize(150, 24)
      reset:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
      reset:SetScript("OnClick", function() StaticPopup_Show("CONTRACT_RESET_TREE", "Огонь") end)
      SLASH_CONTRACTWARN1 = "/contractwarn"
      SlashCmdList.CONTRACTWARN = function(text) UIErrorsFrame:AddMessage(text, 1, 0.25, 0.15, 1, false) end
    `],
  ]);
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalizeGluePath(path);
        if (overlay.has(key)) return overlay.get(key);
        const bytes = await chain.read(path);
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, includeActiveTsAddons: true, seam, exercise: true,
    screen: () => ({ width: 1365, height: 768 }),
  });
  markFrameXmlNativeHud(boot);
  let entrypoints;
  let surfaces;
  try {
    await boot.load();
    assert.equal(boot.isAddonLoaded("contract-dialogs"), true);
    assert.deepEqual(boot.tsAddonResults.map((result) => [result.module, result.ok]), [["contract-dialogs", true]]);
    const presentation = new FrameXmlTsAddonPresentation(boot);
    surfaces = mountFrameXmlAddonsOnlySurfaces(boot, seam, {});
    const reset = boot.bridge.getFrame("ContractResetButton");
    assert.equal(boot.tsAddonOwner(reset), "contract-dialogs");
    assert.equal(presentation.includes(reset), true, "the module's own button is painted");
    assert.equal(boot.bridge.Click(reset, "LeftButton", false) !== false, true);
    const dialog = boot.bridge.getFrame("StaticPopup1");
    assert.equal(dialog.visible, true, "StaticPopup_Show from the module opened StaticPopup1");
    assert.equal(presentation.includes(dialog), true, "and it is painted over the native HUD");
    assert.equal(boot.bridge.getFrame("StaticPopup1Text").text, "Сбросить ветку Огонь? Все вложенные очки вернутся.");
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("StaticPopup1Button1"), "LeftButton", false) !== false, true);
    assert.equal(boot.vm.getGlobal("ContractResets"), 1, "«Да» answered the module");
    assert.equal(dialog.visible, false);
    entrypoints = discoverFrameXmlAddonEntrypoints(boot);
    const warn = entrypoints.commands.find((command) => command.name === "contractwarn");
    assert.ok(warn !== undefined, "the module's slash command is an entry point");
    const errorsFrame = boot.bridge.getFrame("UIErrorsFrame");
    const before = boot.bridge.GetNumMessages(errorsFrame);
    warn.run("Жажда начинает ослаблять вас!");
    assert.equal(boot.bridge.GetNumMessages(errorsFrame), before + 1);
    assert.equal(boot.bridge.GetMessageInfo(errorsFrame, before + 1)[0], "Жажда начинает ослаблять вас!");
    assert.equal(presentation.includes(errorsFrame), true, "UIErrorsFrame is painted over the native HUD");
    assert.deepEqual({ ...surfaces.counts() }, { popups: 1, errors: 1, serverQuestions: "native" });
    assert.deepEqual(boot.errors, []);
  } finally {
    surfaces?.dispose();
    entrypoints?.close();
    boot.close();
  }
});

for (const [name, files, library] of [
  ["missing nested Lua", { [root + "addon.xml"]: '<Ui><Script file="missing.lua"/></Ui>' }],
  ["failing Lua", {
    [root + "addon.xml"]: '<Ui><Script file="addon.lua"/></Ui>',
    [root + "addon.lua"]: 'error("module failed")',
  }],
  ["handled OnLoad error", {
    [root + "addon.xml"]: '<Ui><Script>seterrorhandler(function() end)</Script><Frame name="Broken"><Scripts><OnLoad>error("handled failure")</OnLoad></Scripts></Frame></Ui>',
  }],
  ["missing shared TSWoW library", { [root + "addon.xml"]: '<Ui><Frame name="Partial"/></Ui>' }, ["RequireStub.lua"]],
]) {
  test(`a TSWoW marker does not hide ${name}`, async () => {
    const boot = bootFor(files, library);
    try {
      await boot.load();
      assert.equal(boot.isAddonLoaded("author-new-module"), false);
      assert.equal(boot.tsAddonResults[0].ok, false);
      assert.ok(boot.tsAddonResults[0].errors.length > 0);
      assert.equal((await boot.loadAddon("author-new-module")).ok, false);
    } finally { boot.close(); }
  });
}
