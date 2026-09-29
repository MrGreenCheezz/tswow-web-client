import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  ({ clientDirectory } = await import("../tools/paths.mjs"));
  clientDirectory = clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { clientArchives } = await import("../tools/mpq.mjs");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const decoder = new TextDecoder("utf-8");

function callLua(boot, name, args = [], results = 1) {
  const ref = boot.vm.globalFunction(name);
  assert.ok(ref, `${name} must be installed`);
  try { return boot.vm.call(ref, args, results); }
  finally { boot.vm.release(ref); }
}

test("stock MPQ settings initialize with available browser choices and inert native options", withClient, async () => {
  const chain = await clientArchives(clientDirectory);
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const bytes = await chain.read(path.replaceAll("/", "\\"));
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    locale: "ruRU",
    screen: () => ({ width: 1280, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    const settingsFailures = inventory.errors.filter(({ file }) =>
      /(?:audiooptionspanels|videooptionspanels|interfaceoptionspanels)\.lua$/i.test(file));
    assert.deepEqual(settingsFailures, [],
      `stock settings Lua must initialize: ${JSON.stringify(settingsFailures)}`);

    assert.deepEqual(callLua(boot, "GetScreenResolutions"), ["1280x768"],
      "the browser stage is the only display viewport");
    assert.deepEqual(callLua(boot, "GetCurrentResolution"), [1]);
    assert.deepEqual(callLua(boot, "GetRefreshRates"), [0],
      "zero is the stock unavailable sentinel that disables the refresh dropdown");
    assert.deepEqual(callLua(boot, "GetExistingLocales"), ["ruRU"]);
    assert.deepEqual(callLua(boot, "Sound_ChatSystem_GetNumInputDrivers"), [0]);
    assert.deepEqual(callLua(boot, "Sound_ChatSystem_GetNumOutputDrivers"), [0]);
    assert.deepEqual(callLua(boot, "VoiceIsDisabledByClient"), [true]);
    assert.deepEqual(callLua(boot, "GetCVar", ["VoiceChatMode"]), ["0"]);
    assert.deepEqual(callLua(boot, "GetCVar", ["BaseMip"]), ["0"]);
    assert.deepEqual(callLua(boot, "GetCVar", ["chatStyle"]), ["classic"]);
    assert.deepEqual(callLua(boot, "SetCVar", ["VoiceChatMode", "1"]), [false]);
    assert.deepEqual(callLua(boot, "SetCVar", ["chatStyle", "im"]), [false]);
    assert.deepEqual(callLua(boot, "GetCVar", ["chatStyle"]), ["classic"]);
    const selectTarget = boot.vm.execute(
      'InterfaceOptionsCombatPanelTOTDropDown:SetValue("2")',
      "@framexml-client-options-target-selection",
    );
    assert.equal(selectTarget.ok, true, selectTarget.error);
    assert.deepEqual(callLua(boot, "GetCVar", ["TARGETOFTARGETMODE"]), ["2"],
      "the stock supported dropdown writes its session CVar");
    assert.deepEqual(callLua(boot, "SetCVar", ["targetOfTargetMode", "3"]), [true]);
    assert.deepEqual(callLua(boot, "GetCVar", ["targetOfTargetMode"]), ["3"]);

    const probe = boot.vm.execute(`
      function __fxCountMultisampleFormats() return select("#", GetMultisampleFormats()) end
    `, "@framexml-client-options-probe");
    assert.equal(probe.ok, true, probe.error);
    assert.deepEqual(callLua(boot, "__fxCountMultisampleFormats"), [0],
      "the browser does not expose selectable GPU multisample formats");

    for (const name of [
      "AudioOptionsSoundPanelHardwareDropDownButton",
      "AudioOptionsVoicePanelInputDeviceDropDownButton",
      "AudioOptionsVoicePanelOutputDeviceDropDownButton",
      "AudioOptionsVoicePanelChatModeDropDownButton",
      "VideoOptionsResolutionPanelResolutionDropDownButton",
      "VideoOptionsResolutionPanelRefreshDropDownButton",
      "VideoOptionsResolutionPanelMultiSampleDropDownButton",
      "VideoOptionsEffectsPanelTextureResolution",
      "InterfaceOptionsSocialPanelChatStyleButton",
    ]) {
      const frame = boot.bridge.getFrame(name);
      assert.ok(frame, `${name} comes from stock XML`);
      assert.equal(frame.enabled, false, `${name} cannot apply an unavailable native operation`);
    }
  } finally {
    boot.close();
    chain.close();
  }
});

test("Web Audio exposes its one real default output route without fabricating devices", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class BrowserAudioContext {} });
  const boot = new FrameXmlBoot({
    provider: {
      read: async (path) => path.toLowerCase().endsWith("/probe.lua")
        ? "local _ = GetCVar('Sound_OutputDriverIndex'); local _ = SetCVar('Sound_OutputDriverIndex', '0')"
        : undefined,
    },
    subset: ["probe.lua"], exercise: false, locale: "enUS",
  });
  try {
    await boot.load();
    assert.deepEqual(callLua(boot, "Sound_GameSystem_GetNumOutputDrivers"), [1]);
    assert.deepEqual(callLua(boot, "Sound_GameSystem_GetOutputDriverNameByIndex", [0]),
      ["Browser default output"]);
    assert.deepEqual(callLua(boot, "GetCVar", ["Sound_OutputDriverIndex"]), ["0"]);
    assert.deepEqual(callLua(boot, "SetCVar", ["Sound_OutputDriverIndex", "1"]), [false]);
  } finally {
    boot.close();
    if (original) Object.defineProperty(globalThis, "AudioContext", original);
    else delete globalThis.AudioContext;
  }
});
