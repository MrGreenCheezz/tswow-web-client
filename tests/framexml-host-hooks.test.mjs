import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.27 (04.10, L5b): WebClient's own hooks on stock frames are the host's
// (FrameXmlHostHooks.ts, FrameXmlRuntime `HookScript`), not Lua's. A Lua HookScript lives in the
// script's slot (Wow.exe 0x0049edb0, closure 0x00817050), so an add-on's SetScript on the same
// script — Wow.exe semantics, GlueScriptRefs.ts — dropped ours: the popup counter and the dialog
// layer, the StaticPopup text measure, DressUpFrame's wake, the auction «Максимум» revalidation, the
// options' reason tooltips. Each is checked once as it was, then after an add-on's SetScript.
// Over a fixture of the frames each installer looks for; frames never go to assert.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { withFrameXmlHostHooks } = await import("../dist/code/browser/framexml/FrameXmlHostHooks.js");
const { installFrameXmlPopupsAdapters } = await import("../dist/code/browser/framexml/FrameXmlPopupsOwner.js");
const { mountFrameXmlAddonsOnlySurfaces, watchFrameXmlDialogLayer } = await import("../dist/code/browser/framexml/FrameXmlAddonsOnlyMessages.js");
const { FrameXmlDressUpModels, installFrameXmlDressUp } = await import("../dist/code/browser/framexml/FrameXmlDressUp.js");
const { installFrameXmlAuctionAdapters } = await import("../dist/code/browser/framexml/FrameXmlAuctionOwner.js");
const { frameXmlOptionsAdoptSource } = await import("../dist/code/browser/framexml/FrameXmlOptions.js");

const FIXTURE = String.raw`
STATICPOPUP_NUMDIALOGS = 2
RESIZED = 0
function StaticPopup_Resize(dialog, which) RESIZED = RESIZED + 1 end
for index = 1, 2 do
  local dialog = CreateFrame("Frame", "StaticPopup" .. index, UIParent)
  local text = dialog:CreateFontString("StaticPopup" .. index .. "Text")
  text:SetHeight(12)
  dialog:Hide()
end
CreateFrame("Frame", "ReadyCheckFrame", UIParent):Hide()
DressUpFrame = CreateFrame("Frame", "DressUpFrame", UIParent)
DressUpModel = CreateFrame("DressUpModel", "DressUpModel", DressUpFrame)
DressUpFrame:Hide()
VALIDATED = 0
CreateFrame("Frame", "AuctionFrameAuctions", UIParent)
function AuctionFrameAuctions_OnEvent() end
function AuctionsFrameAuctions_ValidateAuction() VALIDATED = VALIDATED + 1 end
function UpdateMaximumButtons() end
function UpdateDeposit() end
function PriceDropDown_OnClick() end
AuctionsItemButton = {}
CreateFrame("Button", "AuctionsStackSizeMaxButton", UIParent)
CreateFrame("Button", "AuctionsNumStacksMaxButton", UIParent)
CreateFrame("Frame", "AuctionProgressBar", UIParent)
TIPS, HIDDEN = 0, 0
GameTooltip = { SetOwner = function() end, SetText = function() end, AddLine = function() end,
  Show = function() TIPS = TIPS + 1 end, Hide = function() HIDDEN = HIDDEN + 1 end }
function UIDropDownMenu_DisableDropDown() end
CreateFrame("Frame", "VideoOptionsResolutionPanelResolutionDropDown", UIParent)
CreateFrame("Button", "VideoOptionsResolutionPanelResolutionDropDownButton", UIParent)
`;

async function boot() {
  const instance = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Hooks.lua",
      "interface/framexml/hooks.lua": FIXTURE,
    }),
    exercise: false,
  });
  await instance.load();
  return instance;
}

function lua51(instance, source) {
  const result = instance.vm.execute(source, "@an-addon");
  assert.equal(result.ok, true, result.error);
}

function global(instance, name) {
  return instance.vm.getGlobal(name);
}

test("the add-ons-only popup counter counts a shown dialog after an add-on's SetScript on its OnShow", async () => {
  const instance = await boot();
  let raises = 0;
  const surfaces = mountFrameXmlAddonsOnlySurfaces(instance, {}, { raise() { raises += 1; } });
  try {
    lua51(instance, "StaticPopup1:Show() StaticPopup1:Hide()");
    assert.equal(surfaces.counts().popups, 1);
    lua51(instance, 'StaticPopup1:SetScript("OnShow", function() end) StaticPopup1:Show()');
    assert.equal(surfaces.counts().popups, 2);
    assert.equal(raises, 2);
    assert.deepEqual(instance.errors, []);
  } finally {
    surfaces.dispose();
    instance.close();
  }
});

test("the dialog layer rises and falls with ReadyCheckFrame after an add-on's SetScript, and GetScript stays the add-on's", async () => {
  const instance = await boot();
  const layer = { raised: 0, lowered: 0, raise() { this.raised += 1; }, lower() { this.lowered += 1; } };
  const release = watchFrameXmlDialogLayer(instance, layer);
  try {
    lua51(instance, "READY_SLOT = ReadyCheckFrame:GetScript('OnShow') == nil ReadyCheckFrame:Show() ReadyCheckFrame:Hide()");
    assert.equal(global(instance, "READY_SLOT"), true, "the host's hook is not in the frame's slot");
    assert.deepEqual([layer.raised, layer.lowered], [1, 1]);
    lua51(instance, `
      ReadyCheckFrame:SetScript("OnShow", function() end)
      ReadyCheckFrame:SetScript("OnHide", function() end)
      ReadyCheckFrame:Show() ReadyCheckFrame:Hide()
    `);
    assert.deepEqual([layer.raised, layer.lowered], [2, 2]);
  } finally {
    release();
    instance.close();
  }
});

test("the StaticPopup text measure still resizes a dialog whose OnShow and OnUpdate an add-on set", async () => {
  const instance = await boot();
  try {
    installFrameXmlPopupsAdapters(instance);
    const dialog = instance.bridge.getFrame("StaticPopup1");
    lua51(instance, 'StaticPopup1.which = "TEST" StaticPopup1:Show()');
    instance.bridge.fireScript(dialog, "OnUpdate", 0.02);
    assert.equal(global(instance, "RESIZED"), 1, "the first measure resizes");
    lua51(instance, `
      StaticPopup1:Hide()
      StaticPopup1:SetScript("OnShow", function() end)
      StaticPopup1:SetScript("OnUpdate", function() end)
      StaticPopup1:Show()
    `);
    instance.bridge.fireScript(dialog, "OnUpdate", 0.02);
    assert.equal(global(instance, "RESIZED"), 2, "OnShow forgot the height and OnUpdate measured again");
    assert.deepEqual(instance.errors, []);
  } finally {
    instance.close();
  }
});

test("DressUpFrame's OnShow still wakes the stage after an add-on's SetScript", async () => {
  const instance = await boot();
  try {
    let changes = 0;
    const models = new FrameXmlDressUpModels({ look: () => undefined, item: () => undefined });
    assert.equal(installFrameXmlDressUp(instance, models, () => { changes += 1; }), true);
    lua51(instance, "DressUpFrame:Show() DressUpFrame:Hide()");
    assert.equal(changes, 1);
    lua51(instance, 'DressUpFrame:SetScript("OnShow", function() end) DressUpFrame:Show()');
    assert.equal(changes, 2);
  } finally {
    instance.close();
  }
});

test("the auction «Максимум» buttons still revalidate after an add-on's SetScript on their OnClick", async () => {
  const instance = await boot();
  try {
    assert.equal(installFrameXmlAuctionAdapters(instance), true);
    lua51(instance, "AuctionsStackSizeMaxButton:Click() AuctionsNumStacksMaxButton:Click()");
    assert.equal(global(instance, "VALIDATED"), 2);
    lua51(instance, `
      AuctionsStackSizeMaxButton:SetScript("OnClick", function() end)
      AuctionsNumStacksMaxButton:SetScript("OnClick", function() end)
      AuctionsStackSizeMaxButton:Click() AuctionsNumStacksMaxButton:Click()
    `);
    assert.equal(global(instance, "VALIDATED"), 4);
    assert.deepEqual(instance.errors, []);
  } finally {
    instance.close();
  }
});

test("an unavailable option still explains itself on hover after an add-on's SetScript on OnEnter/OnLeave", async () => {
  const instance = await boot();
  try {
    const adopt = instance.vm.compileFunction(frameXmlOptionsAdoptSource(), "webclient/options-adopt", []);
    assert.ok(adopt);
    try {
      withFrameXmlHostHooks(instance, () => instance.vm.call(adopt, [], 1));
    } finally {
      instance.vm.release(adopt);
    }
    const names = ["VideoOptionsResolutionPanelResolutionDropDown", "VideoOptionsResolutionPanelResolutionDropDownButton"];
    const hover = () => {
      for (const name of names) {
        const frame = instance.bridge.getFrame(name);
        instance.bridge.fireScript(frame, "OnEnter", false);
        instance.bridge.fireScript(frame, "OnLeave", false);
      }
    };
    hover();
    assert.deepEqual([global(instance, "TIPS"), global(instance, "HIDDEN")], [2, 2]);
    lua51(instance, names.map((name) => `${name}:SetScript("OnEnter", function() end) ${name}:SetScript("OnLeave", function() end)`).join("\n"));
    hover();
    assert.deepEqual([global(instance, "TIPS"), global(instance, "HIDDEN")], [4, 4]);
    assert.deepEqual(instance.errors, []);
  } finally {
    instance.close();
  }
});

test("a hook made through the binding runs with the legacy globals and reports its error, as a Lua hook did", async () => {
  const instance = await boot();
  try {
    const hooked = withFrameXmlHostHooks(instance, () => {
      const fn = instance.vm.compileFunction(`
        return __webclientHostHook(ReadyCheckFrame, "OnShow", function(self) SEEN = this == self and self:GetName() end),
          __webclientHostHook({}, "OnShow", function() end),
          __webclientHostHook(ReadyCheckFrame, "OnHide", function() error("hook failed") end),
          __webclientHostHook(ReadyCheckFrame, " ", function() end),
          __webclientHostHook(ReadyCheckFrame, "OnShow", {})
      `, "webclient/host-hook-probe", []);
      try { return instance.vm.call(fn, [], 5); } finally { instance.vm.release(fn); }
    });
    assert.deepEqual(hooked, [true, false, true, false, false]);
    assert.equal(global(instance, "__webclientHostHook"), undefined, "the binding is gone after the install");
    lua51(instance, "ReadyCheckFrame:Show() ReadyCheckFrame:Hide()");
    assert.equal(global(instance, "SEEN"), "ReadyCheckFrame");
    assert.equal(instance.vm.errors.some((message) => message.includes("hook failed")), true);
  } finally {
    instance.close();
  }
});

// L5b-review: what a Lua hook was given, a host hook is given — OnEvent's event in `event` and the
// arguments after it, OnClick's button; a throwing install still takes the binding away; a hook
// that outlives its VM stays silent.
test("a host hook gets the script's arguments, the binding goes on a throw, and a closed VM is left alone", async () => {
  const instance = await boot();
  try {
    withFrameXmlHostHooks(instance, () => {
      const fn = instance.vm.compileFunction(`
        local listener = CreateFrame("Frame", "HookedListener", UIParent)
        listener:RegisterEvent("HOOKED_EVENT")
        __webclientHostHook(listener, "OnEvent", function(self, name, first, second)
          EVENT_SEEN = table.concat({ tostring(name), tostring(first), tostring(second), tostring(event), tostring(arg1) }, " ")
        end)
        __webclientHostHook(AuctionsStackSizeMaxButton, "OnClick", function(self, button, down)
          CLICK_SEEN = tostring(button) .. " " .. tostring(down) .. " " .. tostring(arg1)
        end)
      `, "webclient/host-hook-arguments", []);
      try { instance.vm.call(fn, [], 0); } finally { instance.vm.release(fn); }
    });
    instance.bridge.fireScript(instance.bridge.getFrame("HookedListener"), "OnEvent", "HOOKED_EVENT", "a", 2);
    assert.equal(global(instance, "EVENT_SEEN"), "HOOKED_EVENT a 2 HOOKED_EVENT a");
    lua51(instance, 'AuctionsStackSizeMaxButton:Click("RightButton")');
    assert.equal(global(instance, "CLICK_SEEN"), "RightButton false RightButton");
    assert.throws(() => withFrameXmlHostHooks(instance, () => { throw new Error("install failed"); }), /install failed/);
    assert.equal(global(instance, "__webclientHostHook"), undefined, "the binding is gone after a throwing install");
    const ready = instance.bridge.getFrame("ReadyCheckFrame");
    withFrameXmlHostHooks(instance, () => {
      const fn = instance.vm.compileFunction('__webclientHostHook(ReadyCheckFrame, "OnShow", function() end)', "webclient/late-hook", []);
      try { instance.vm.call(fn, [], 0); } finally { instance.vm.release(fn); }
    });
    const diagnostics = instance.bridge.diagnostics.length;
    instance.vm.close();
    instance.bridge.fireScript(ready, "OnShow");
    assert.equal(instance.bridge.diagnostics.length, diagnostics, "no hook reached the closed VM");
  } finally {
    instance.close();
  }
});
