// 5.37 / 3.27 (15.11, lane cvar7): before the account's config slots answer (and offline), the neutral CVar map answers
// what Wow.exe answers on a first start with no stored line — every CVar it registers (framexml/WowCVarRegistry.ts) with
// its registered default; the seeds of before that disagreed with it (displayWorldPVPObjectives "2",
// showBattlefieldMinimap "1", lootUnderMouse "0", the camera styles "0") are gone. The registry now has 0x005fd910's
// run-time camera names and the three registrations of 0x004047e0, and GetCVarDefault of a settings-backed CVar is
// Wow.exe's registered string.
import assert from "node:assert/strict";
import test from "node:test";

const { FRAMEXML_NEUTRAL_PRELUDE } = await import("../dist/code/browser/framexml/FrameXmlNeutralApi.js");
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { WOW_CVAR_REGISTRY, wowCVar, wowCVarSlot, wowCVarStartValue } = await import("../dist/code/browser/framexml/WowCVarRegistry.js");
const { createFrameXmlSettingsCVar, FRAME_XML_WEBCLIENT_CVARS } = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");

function neutral(locale = "ruRU") {
  const vm = new GlueLuaVm();
  vm.setGlobal("__fxNeutralImpl", {});
  vm.setGlobal("__fxAddonModules", []);
  vm.setGlobal("__fxLocale", locale);
  const loaded = vm.execute(FRAMEXML_NEUTRAL_PRELUDE, "@cvar-seed:neutral");
  assert.equal(loaded.ok, true, loaded.error);
  const lua = (expression) => {
    const run = vm.execute(`__answer = ${expression}`, "@cvar-seed:probe");
    assert.equal(run.ok, true, run.error);
    return vm.getGlobal("__answer");
  };
  return { vm, lua };
}

/**
 * The only seeds that are not the registered default, each for a stated reason: this client's own observation
 * (no Real ID conversations; the classic chat edit box, chat being outside the plan), a default Wow.exe computes
 * (timeMgrUseMilitaryTime), the locale, which the boot answers, and the two stat panels, whose "" reads as the choice
 * PaperDollFrame_OnEvent(VARIABLES_LOADED) makes for the class (the stored value stays ""), and useUiScale "1": the
 * interface size always applies here (FrameXmlOptions.ts FRAMEXML_OPTIONS_FIXED_ON).
 */
const NOT_REGISTERED_DEFAULT = new Set([
  "chatstyle", "conversationmode", "timemgrusemilitarytime", "locale", "playerstatleftdropdown", "playerstatrightdropdown",
  "useuiscale",
]);

test("every CVar Wow.exe registers answers its registered default before anything is stored", () => {
  const { vm, lua } = neutral();
  try {
    const differing = [];
    for (const [key, row] of WOW_CVAR_REGISTRY) {
      if (row.defaultValue === undefined || NOT_REGISTERED_DEFAULT.has(key)) continue;
      const value = lua(`__fxNeutralImpl.GetCVar(${JSON.stringify(row.name)})`);
      if (value !== row.defaultValue) differing.push(`${row.name}: ${value} != ${row.defaultValue}`);
    }
    assert.deepEqual(differing, []);
    // The three disagreements the census of 15.11 settled, named, and what the stock Lua reads from them.
    assert.equal(lua(`__fxNeutralImpl.GetCVar("displayWorldPVPObjectives")`), "1", "0x0051de13: always shown, not «dynamic»");
    assert.equal(lua(`__fxNeutralImpl.GetCVar("showBattlefieldMinimap")`), "0", "0x0051ee41: «Никогда»");
    assert.equal(lua(`__fxNeutralImpl.GetCVar("lootUnderMouse")`), "1", "0x0051db1b");
    assert.equal(lua(`__fxNeutralImpl.GetCVar("cameraSmoothTrackingStyle")`), "4", "0x00ad1c2c → \"4\"");
    // Sliders of the stock options read these; they were nil (3.27): farclip, the voice volumes, toastDuration, and
    // textureFilteringMode, which only the byte scan found (0x0040484f).
    assert.equal(lua(`__fxNeutralImpl.GetCVar("farclip")`), "350");
    assert.equal(lua(`__fxNeutralImpl.GetCVar("ChatSoundVolume")`), "0.4");
    assert.equal(lua(`__fxNeutralImpl.GetCVar("toastDuration")`), "4");
    assert.equal(lua(`__fxNeutralImpl.GetCVar("textureFilteringMode")`), "1");
    // A name Wow.exe does not register stays nil.
    assert.equal(lua(`__fxNeutralImpl.GetCVar("noSuchCVarAnywhere")`), undefined);
    assert.equal(lua(`__fxNeutralImpl.GetCVar("TerrainMip")`), undefined, "the panel's label, not a CVar");
  } finally {
    vm.close();
  }
});

test("a computed default is still a value: Wow.exe's on a typical machine, by locale; webclient_ CVars start at their setting", () => {
  for (const [locale, violence, interact] of [["ruRU", "2", "0"], ["koKR", "1", "1"]]) {
    const { vm, lua } = neutral(locale);
    try {
      const missing = [];
      for (const [key, row] of WOW_CVAR_REGISTRY) {
        if (lua(`__fxNeutralImpl.GetCVar(${JSON.stringify(row.name)})`) === undefined) missing.push(key);
      }
      assert.deepEqual(missing, [], `every registration answers (${locale})`);
      assert.equal(lua(`__fxNeutralImpl.GetCVar("mouseSpeed")`), "1.0", "0x00401b60: %1.1f of the system speed");
      assert.equal(lua(`__fxNeutralImpl.GetCVar("violenceLevel")`), violence, "0x00af4e14 by locale");
      assert.equal(lua(`__fxNeutralImpl.GetCVar("autoInteract")`), interact);
      assert.equal(lua(`__fxNeutralImpl.GetCVar("ffxGlow")`), "1");
      assert.equal(lua(`__fxNeutralImpl.GetCVar("serviceTypeFilter")`), "3");
      // The «WebClient» category's sliders with no settings host behind the bridge.
      for (const row of FRAME_XML_WEBCLIENT_CVARS) {
        assert.notEqual(lua(`__fxNeutralImpl.GetCVar(${JSON.stringify(row.cvar)})`), undefined, row.cvar);
      }
    } finally {
      vm.close();
    }
  }
  // The login screens read the same start values (GlueApi.ts).
  assert.equal(wowCVarStartValue("farclip"), "350");
  assert.equal(wowCVarStartValue("MOUSESPEED", "ruRU"), "1.0");
  assert.equal(wowCVarStartValue("gxWindow", "zhCN"), "1");
  assert.equal(wowCVarStartValue("noSuchCVarAnywhere"), undefined);
});

test("GetGamma and GetTerrainMip answer 1 minus gamma's float and shadowLevel's integer (0x0054ea60, 0x0054eb10)", () => {
  const { vm, lua } = neutral();
  try {
    assert.equal(lua(`__fxNeutralImpl.GetGamma()`), 0, "gamma \"1.0\"");
    assert.equal(lua(`__fxNeutralImpl.GetTerrainMip()`), 0, "shadowLevel \"1\"");
    lua(`__fxNeutralImpl.SetCVar("gamma", "0.75")`);
    lua(`__fxNeutralImpl.SetCVar("shadowLevel", "0")`);
    assert.equal(lua(`__fxNeutralImpl.GetGamma()`), 0.25);
    assert.equal(lua(`__fxNeutralImpl.GetTerrainMip()`), 1);
  } finally {
    vm.close();
  }
});

test("the registry has 0x005fd910's run-time camera names and 0x004047e0's three registrations", () => {
  // 435 names of the 436 rows (realmName twice), 3 found by the byte scan, 274 built by 0x005fd910's loops.
  assert.equal(WOW_CVAR_REGISTRY.size, 435 + 3 + 274);
  const row = (name) => {
    const registration = wowCVar(name);
    return registration && [registration.name, registration.flags, registration.defaultValue, registration.registrar];
  };
  // The views: flags 0x50 (the account's slot 0, and 0x40); defaults at 0x00ad1ba8.
  assert.deepEqual(row("cameradistanceb"), ["cameraDistanceB", 0x50, "5.55", 0x005fd910]);
  assert.deepEqual(row("cameraPitchBarber Shop"), ["cameraPitchBarber Shop", 0x50, "10.0", 0x005fd910]);
  assert.deepEqual(row("cameraYaw"), ["cameraYaw", 0x50, "0.0", 0x005fd910]);
  assert.equal(wowCVarSlot("cameraDistanceD"), 0);
  // The follow's tables (0x00ad1c30, 0x00ad1d48) and the terrain tilt's (0x00ad1df8): flags 0x10.
  assert.deepEqual(row("cameraSmoothSmartTrackDelay"), ["cameraSmoothSmartTrackDelay", 0x10, "0.4", 0x005fd910]);
  assert.deepEqual(row("cameraSmoothSplineIdleFactor"), ["cameraSmoothSplineIdleFactor", 0x10, "4.0", 0x005fd910]);
  assert.deepEqual(row("cameraSmoothViewDataAlwaysPitchFactor"), ["cameraSmoothViewDataAlwaysPitchFactor", 0x10, "1.0", 0x005fd910]);
  assert.deepEqual(row("cameraTerrainTiltSmartFallFactor"), ["cameraTerrainTiltSmartFallFactor", 0x10, "0.75", 0x005fd910]);
  assert.deepEqual(row("cameraTerrainTiltNeverTurnFactor"), ["cameraTerrainTiltNeverTurnFactor", 0x10, "-1.0", 0x005fd910]);
  // The defaults read through a pointer.
  assert.equal(wowCVar("cameraView")?.defaultValue, "2");
  assert.equal(wowCVar("cameraViewBlendStyle")?.defaultValue, "1");
  assert.equal(wowCVar("cameraSavedDistance")?.defaultValue, "5.55");
  assert.equal(wowCVar("cameraSavedPitch")?.defaultValue, "10.0");
  // 0x004047e0.
  assert.deepEqual(row("textureFilteringMode"), ["textureFilteringMode", 0x1, "1", 0x004047e0]);
  assert.deepEqual(row("UIFaster"), ["UIFaster", 0x0, "3", 0x004047e0]);
  assert.deepEqual(row("textureCacheSize"), ["textureCacheSize", 0x1, "32", 0x004047e0]);
  assert.equal(wowCVarSlot("textureFilteringMode"), undefined, "flag 1: Config.wtf");
});

test("GetCVarDefault of a settings-backed CVar is Wow.exe's registered string; this client's own rows keep theirs", () => {
  let values = defaultSettings();
  const adapter = createFrameXmlSettingsCVar({ getSettings: () => values, setSetting: (id, value) => { values = { ...values, [id]: value }; } });
  // Slot CVars: the same value a slot with no line gives.
  assert.equal(adapter.getDefault("lootUnderMouse"), "1");
  assert.equal(adapter.getDefault("ShowAllSpellRanks"), "1");
  assert.equal(adapter.getDefault("nameplateShowEnemies"), "0");
  // Machine CVars: the registered string, while this client still starts at its own value.
  assert.equal(adapter.getDefault("Sound_MusicVolume"), "0.4");
  assert.equal(adapter.get("Sound_MusicVolume"), "0.6");
  assert.equal(adapter.getDefault("groundEffectDist"), "70.0");
  // No registered default: the settings model's.
  assert.equal(adapter.getDefault("mouseSpeed"), "1", "computed in Wow.exe");
  assert.equal(adapter.getDefault("ffxGlow"), "1", "computed in Wow.exe");
  assert.equal(adapter.getDefault("bottomLeftActionBar"), "0", "not a CVar of Wow.exe");
  assert.equal(adapter.getDefault("webclient_showFps"), "0");
  // The registered text goes back through the setting unchanged in value.
  assert.equal(adapter.set("Sound_MusicVolume", adapter.getDefault("Sound_MusicVolume")), true);
  assert.equal(values.volumeMusic, 40);
});
