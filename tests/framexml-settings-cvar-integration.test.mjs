import assert from "node:assert/strict";
import test from "node:test";

// This is deliberately an MPQ-backed integration seam.  It exercises the same stock CVar
// functions that the ordinary world mount exposes, while the expected values come from the one
// Settings model through FrameXmlSettingsCVar.  Until the mount wires that adapter into the host,
// this test is expected to stay red: the neutral CVar map is a separate state store.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { clientArchives } = await import("../tools/mpq.mjs");
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const {
  FRAMEXML_VERTICAL_TOC,
} = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  createFrameXmlSettingsCVar,
} = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");

const decoder = new TextDecoder("utf-8");
// OptionsPanelTemplates.lua is a real 3.3.5 entry whose static calls seed GetCVarDefault in the
// boot's measured C-API plan.  Keeping it after the ordinary vertical preserves a mounted-world
// load while making all four stock CVar globals observable in this integration test.
const CVAR_PROBE_TOC = Object.freeze([...FRAMEXML_VERTICAL_TOC, "OptionsPanelTemplates.lua"]);

async function mpqProvider(chain) {
  return {
    async read(path) {
      const data = await chain.read(path.replaceAll("/", "\\"));
      return data ? decoder.decode(data) : undefined;
    },
  };
}

function callLua(boot, name, args, results = 1) {
  const ref = boot.vm.globalFunction(name);
  assert.ok(ref, `${name} must be installed by FrameXML`);
  try {
    return boot.vm.call(ref, args, results);
  } finally {
    boot.vm.release(ref);
  }
}

function modelHost() {
  const values = defaultSettings();
  const writes = [];
  return {
    values,
    writes,
    getSettings: () => values,
    setSetting(id, value) {
      writes.push({ id, value });
      values[id] = value;
      return true;
    },
  };
}

test("ordinary MPQ FrameXML CVars share the Settings model", withClient, async () => {
  const chain = await clientArchives(clientDirectory);
  const host = modelHost();
  const settingsCVar = createFrameXmlSettingsCVar(host);
  const expectedHost = modelHost();
  const expectedCVar = createFrameXmlSettingsCVar(expectedHost);
  const boot = new FrameXmlBoot({
    provider: await mpqProvider(chain),
    subset: CVAR_PROBE_TOC,
    locale: "ruRU",
    screen: () => ({ width: 1024, height: 768 }),
    exercise: false,
    // The direct Boot path accepts the same adapter that the ordinary mount passes to LiveWorldSeam.
    // This keeps the test DOM-free while still exercising stock Lua CVar composition.
    seam: new CannedWorldSeam(undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, settingsCVar),
  });

  try {
    await boot.load();
    const globalsTouched = boot.vm.execute(`
      local _ = GetCVar
      local _ = GetCVarDefault
      local _ = GetCVarBool
      local _ = SetCVar
      function __frameXmlProbeSetCVar(name, value)
        local result = { SetCVar(name, value) }
        return #result, result[1]
      end
    `, "@framexml-settings-cvar-integration");
    assert.equal(globalsTouched.ok, true, globalsTouched.error);

    // These are the values a mounted stock API must expose from the browser's Settings model.
    const expectedInitial = {
      bubbles: settingsCVar.get("CHATBUBBLES"),
      showAllSpellRanks: settingsCVar.get("showallspellranks") === "1",
      masterDefault: settingsCVar.getDefault("sound_mastervolume"),
    };
    const actualInitial = {
      bubbles: callLua(boot, "GetCVar", ["CHATBUBBLES"])[0],
      showAllSpellRanks: callLua(boot, "GetCVarBool", ["showallspellranks"])[0],
      masterDefault: callLua(boot, "GetCVarDefault", ["Sound_MasterVolume"])[0],
    };

    const sfxSetResult = callLua(boot, "__frameXmlProbeSetCVar",
      ["Sound_SFXVolume", "0.75"], 2);
    const showAllSetResult = callLua(boot, "__frameXmlProbeSetCVar",
      ["SHOWALLSPELLRANKS", "1"], 2);
    const unsupportedSetResult = callLua(boot, "__frameXmlProbeSetCVar",
      ["groundEffectDensity", "0.25"], 2);
    expectedCVar.set("Sound_SFXVolume", "0.75");
    expectedCVar.set("SHOWALLSPELLRANKS", "1");

    const actual = {
      initial: actualInitial,
      afterSet: {
        sfx: callLua(boot, "GetCVar", ["sound_sfxvolume"])[0],
        showAllSpellRanks: callLua(boot, "GetCVarBool", ["ShowAllSpellRanks"])[0],
      },
      setResults: {
        sfx: sfxSetResult,
        showAllSpellRanks: showAllSetResult,
        unsupported: unsupportedSetResult,
      },
      writes: host.writes,
      unsupported: callLua(boot, "GetCVar", ["groundEffectDensity"])[0],
    };
    const expected = {
      initial: expectedInitial,
      afterSet: {
        sfx: expectedCVar.get("sound_sfxvolume"),
        showAllSpellRanks: expectedCVar.get("ShowAllSpellRanks") === "1",
      },
      setResults: {
        sfx: [0, undefined],
        showAllSpellRanks: [0, undefined],
        unsupported: [0, undefined],
      },
      writes: expectedHost.writes,
      unsupported: "0.25",
    };

    assert.equal(settingsCVar.set("groundEffectDensity", "0.25"), false,
      "unsupported CVars must not create a Settings entry");
    assert.deepEqual(actual, expected,
      "stock GetCVar/GetCVarDefault/GetCVarBool/SetCVar are not wired to FrameXmlSettingsCVar");
  } finally {
    boot.close();
    chain.close();
  }
});
