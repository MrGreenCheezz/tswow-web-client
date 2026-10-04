import assert from "node:assert/strict";
import test from "node:test";

const {
  createFrameXmlSettingsCVar,
  FRAME_XML_SETTINGS_CVARS,
  FRAME_XML_WEBCLIENT_CVARS,
} = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings, SETTING_DEFINITIONS } = await import("../dist/code/browser/ui/SettingsModel.js");

function fakeSettings() {
  let values = defaultSettings();
  const writes = [];
  const adapter = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => {
      writes.push({ id, value });
      values = { ...values, [id]: value };
    },
  });
  return { adapter, writes, values: () => values };
}

test("the supported table is only the settings the browser currently consumes", () => {
  assert.deepEqual(
    FRAME_XML_SETTINGS_CVARS.map(({ cvar, setting }) => [cvar, setting]),
    [
      ["bottomLeftActionBar", "actionBarBottomLeft"],
      ["bottomRightActionBar", "actionBarBottomRight"],
      ["rightActionBar", "actionBarRight"],
      ["rightTwoActionBar", "actionBarRight2"],
      ["rotateMinimap", "minimapRotate"],
      ["ShowAllSpellRanks", "spellbookHideLowerRanks"],
      ["chatBubbles", "chatBubbles"],
      ["enableCombatText", "floatingCombatText"],
      ["nameplateShowEnemies", "plateEnemies"],
      ["nameplateShowFriends", "plateFriends"],
      ["ffxGlow", "fullscreenGlow"],
      ["autoLootDefault", "autoLoot"],
      ["lootUnderMouse", "lootUnderMouse"],
      // The stock Combat panel's STOP_AUTO_ATTACK, read by WorldClient.selectTarget (5.05).
      ["stopAutoAttackOnTargetChange", "stopAutoAttackOnTargetChange"],
      // L18 5.05: the stock Combat panel's «Ближний/дальний бой», read by the autoRangedCombat controller.
      ["autoRangedCombat", "autoRangedCombat"],
      // The stock Controls panel's BLOCK_TRADES, read by WorldClient on a trade offer (5.25).
      ["blockTrades", "blockTrades"],
      // The stock Features panel's equipment-manager switch, persisted so GearManagerToggleButton
      // survives a reload (FrameXmlEquipmentSets.ts); an ownWindow setting, drawn by that panel alone.
      ["equipmentManager", "equipmentManager"],
      ["Sound_MasterVolume", "volumeMaster"],
      ["Sound_SFXVolume", "volumeEffects"],
      ["Sound_MusicVolume", "volumeMusic"],
      ["Sound_AmbienceVolume", "volumeAmbience"],
      ["Sound_EnableAllSound", "soundEnabled"],
      ["Sound_EnableSFX", "soundEffectsEnabled"],
      ["Sound_EnableMusic", "musicEnabled"],
      ["Sound_EnableAmbience", "ambienceEnabled"],
      ["groundEffectDist", "grassRadius"],
      ["environmentDetail", "objectDistance"],
      ["uiscale", "uiScale"],
      // 5.14: the stock Camera, Mouse and Controls panels.
      ["cameraDistanceMaxFactor", "cameraDistancePercent"],
      ["cameraSmoothStyle", "cameraSmoothStyle"],
      ["cameraYawSmoothSpeed", "cameraYawSmoothSpeed"],
      ["mouseSpeed", "mouseSpeedPercent"],
      ["cameraYawMoveSpeed", "mouseLookSpeed"],
      ["mouseInvertPitch", "mouseInvertPitch"],
      ["deselectOnClick", "deselectOnClick"],
      // L8 5.14: the Camera panel's WATER_COLLISION (game/CameraWater.ts).
      ["cameraWaterCollision", "cameraWaterCollision"],
    ],
  );
});

test("5.14 the camera and mouse CVars are the original's numbers and write through the settings", () => {
  const { adapter, writes, values } = fakeSettings();
  assert.equal(adapter.getDefault("cameraDistanceMaxFactor"), "1");
  assert.deepEqual(adapter.range("cameraDistanceMaxFactor"), [1, 2], "the stock slider's own 1–2");
  assert.equal(adapter.set("cameraDistanceMaxFactor", "1.5"), true);
  assert.equal(values().cameraDistancePercent, 150);
  assert.equal(adapter.get("cameraDistanceMaxFactor"), "1.5");
  assert.equal(adapter.getDefault("cameraSmoothStyle"), "4", "«Только при движении» by default");
  assert.equal(adapter.set("cameraSmoothStyle", "2"), true);
  assert.equal(adapter.get("cameraSmoothStyle"), "2");
  assert.equal(adapter.getDefault("cameraYawSmoothSpeed"), "180");
  assert.deepEqual(adapter.range("cameraYawSmoothSpeed"), [90, 270]);
  assert.equal(adapter.getDefault("mouseSpeed"), "1");
  assert.deepEqual(adapter.range("mouseSpeed"), [0.5, 1.5]);
  adapter.set("mouseSpeed", "0.75");
  assert.equal(values().mouseSpeedPercent, 75);
  assert.equal(adapter.getDefault("cameraYawMoveSpeed"), "180");
  assert.equal(adapter.getDefault("mouseInvertPitch"), "0");
  assert.equal(adapter.getDefault("deselectOnClick"), "1", "the stock StickyTargeting box inverts it itself");
  adapter.set("deselectOnClick", "0");
  assert.equal(values().deselectOnClick, false);
  assert.equal(writes.length, 4);
});

test("environmentDetail is the object distance as the stock 0.5-1.5 multiplier", () => {
  const { adapter, values } = fakeSettings();
  assert.equal(adapter.get("environmentDetail"), "1");
  assert.equal(adapter.getDefault("environmentDetail"), "1");
  assert.deepEqual(adapter.range("environmentDetail"), [0.5, 1.5], "exactly the stock slider's range");
  assert.equal(adapter.set("environmentDetail", "1.5"), true);
  assert.equal(values().objectDistance, 150);
  assert.equal(adapter.set("environmentDetail", "0.25"), true);
  assert.equal(values().objectDistance, 50, "clamped to the slider's floor");
});

test("every other browser setting is a webclient_ CVar, once, and the spellbook's own switch is not", () => {
  const stock = new Set(FRAME_XML_SETTINGS_CVARS.map((row) => row.setting));
  const expected = SETTING_DEFINITIONS.filter((definition) => !definition.ownWindow && !stock.has(definition.id));
  assert.deepEqual(FRAME_XML_WEBCLIENT_CVARS.map((row) => [row.cvar, row.setting]),
    expected.map((definition) => [`webclient_${definition.id}`, definition.id]));
  assert.equal(FRAME_XML_WEBCLIENT_CVARS.some((row) => row.setting === "spellbookHideLowerRanks"), false);
  const { adapter, writes, values } = fakeSettings();
  assert.equal(adapter.get("WEBCLIENT_RENDERSCALE"), "100", "case-insensitive, the model's own unit");
  assert.equal(adapter.set("webclient_renderScale", "70"), true);
  assert.equal(values().renderScale, 70);
  assert.deepEqual(adapter.range("webclient_renderScale"), [50, 100]);
  assert.equal(adapter.range("webclient_showFps"), undefined, "a switch has no range");
  assert.equal(adapter.set("webclient_showFps", "1"), true);
  assert.equal(values().showFps, true);
  assert.deepEqual(writes, [{ id: "renderScale", value: 70 }, { id: "showFps", value: true }]);
});

test("the two mode switches have no default, and switching the interface off waits for the calling Lua", async () => {
  const { adapter, writes, values } = fakeSettings();
  assert.equal(adapter.getDefault("webclient_originalFrameXml"), undefined, "«По умолчанию» leaves the interface alone");
  assert.equal(adapter.getDefault("webclient_tswowAddons"), undefined);
  assert.equal(adapter.get("webclient_originalFrameXml"), "0");
  assert.equal(adapter.set("webclient_originalFrameXml", "1"), true);
  assert.deepEqual(writes, [], "the write that unmounts this VM is not made inside its Okay handler");
  await Promise.resolve();
  assert.deepEqual(writes, [{ id: "originalFrameXml", value: true }]);
  assert.equal(values().originalFrameXml, true);
  assert.equal(adapter.getDefault("webclient_showFps"), "0", "an ordinary switch keeps its default");
});

test("the audio switches and ambience are their own settings; grass radius is yards, interface size a fraction", () => {
  const { adapter, writes, values } = fakeSettings();
  assert.equal(adapter.get("Sound_EnableAllSound"), "1");
  assert.equal(adapter.set("Sound_EnableMusic", "0"), true);
  assert.equal(values().musicEnabled, false);
  assert.equal(adapter.getDefault("Sound_AmbienceVolume"), "0.6");
  assert.equal(adapter.set("Sound_AmbienceVolume", "0.35"), true);
  assert.equal(values().volumeAmbience, 35);
  assert.equal(values().volumeMusic, 60, "ambience no longer moves music");
  assert.deepEqual(adapter.range("Sound_AmbienceVolume"), [0, 1]);
  assert.equal(adapter.get("groundEffectDist"), "80");
  assert.deepEqual(adapter.range("groundEffectDist"), [0, 180], "the browser's radius, not the client's 70-140");
  assert.equal(adapter.set("groundEffectDist", 120), true);
  assert.equal(values().grassRadius, 120);
  assert.equal(adapter.get("uiscale"), "1");
  assert.deepEqual(adapter.range("uiscale"), [0.75, 1.25]);
  assert.equal(adapter.set("uiScale", "0.9"), true);
  assert.equal(values().uiScale, 90);
  assert.equal(adapter.get("UISCALE"), "0.9");
  assert.equal(adapter.range("rotateMinimap"), undefined);
  assert.deepEqual(writes.map(({ id, value }) => [id, value]), [
    ["musicEnabled", false], ["volumeAmbience", 35], ["grassRadius", 120], ["uiScale", 90],
  ]);
});

test("boolean CVars use 0/1, are case-insensitive by name, and invert spell-rank visibility", () => {
  const { adapter, writes, values } = fakeSettings();

  assert.equal(adapter.get("CHATBUBBLES"), "1");
  assert.equal(adapter.set("chatbubbles", "0"), true);
  assert.equal(values().chatBubbles, false);
  assert.equal(adapter.get("chatBubbles"), "0");
  // GetCVarBool treats any non-empty value other than exactly "0" as on.
  assert.equal(adapter.set("ffxGlow", "false"), true);
  assert.equal(values().fullscreenGlow, true);

  assert.equal(adapter.getDefault("ShowAllSpellRanks"), "0");
  assert.equal(adapter.set("ShowAllSpellRanks", "1"), true);
  assert.equal(values().spellbookHideLowerRanks, false);
  assert.equal(adapter.get("showallspellranks"), "1");
  assert.deepEqual(writes.slice(0, 3), [
    { id: "chatBubbles", value: false },
    { id: "fullscreenGlow", value: true },
    { id: "spellbookHideLowerRanks", value: false },
  ]);
});

test("stock volume fractions cross the model's percentage conversion and clamp", () => {
  const { adapter, writes, values } = fakeSettings();

  assert.equal(adapter.getDefault("Sound_MasterVolume"), "0.7");
  assert.equal(adapter.set("Sound_SFXVolume", "0.75"), true);
  assert.equal(values().volumeEffects, 75);
  assert.equal(adapter.get("sound_sfxvolume"), "0.75");
  assert.equal(adapter.set("Sound_MusicVolume", 2), true);
  assert.equal(values().volumeMusic, 100);
  assert.equal(adapter.get("Sound_MusicVolume"), "1");
  assert.equal(adapter.set("Sound_MasterVolume", "-1"), true);
  assert.equal(values().volumeMaster, 0);
  assert.equal(adapter.get("Sound_MasterVolume"), "0");
  assert.equal(adapter.set("Sound_SFXVolume", "not-a-number"), true);
  assert.equal(values().volumeEffects, 100, "invalid input follows the setting fallback");
  assert.deepEqual(writes.map(({ id, value }) => [id, value]), [
    ["volumeEffects", 75],
    ["volumeMusic", 100],
    ["volumeMaster", 0],
    ["volumeEffects", 100],
  ]);
});

test("action bars and world switches write through the supplied persistence/application callback", () => {
  const { adapter, writes, values } = fakeSettings();

  for (const cvar of ["bottomLeftActionBar", "bottomRightActionBar", "rightActionBar", "rightTwoActionBar"])
    assert.equal(adapter.set(cvar, true), true);
  assert.equal(adapter.set("rotateMinimap", false), true);
  assert.equal(adapter.set("nameplateShowEnemies", "0"), true);
  assert.equal(adapter.set("nameplateShowFriends", "1"), true);
  assert.deepEqual(writes.map(({ id, value }) => [id, value]), [
    ["actionBarBottomLeft", true],
    ["actionBarBottomRight", true],
    ["actionBarRight", true],
    ["actionBarRight2", true],
    ["minimapRotate", false],
    ["plateEnemies", false],
    ["plateFriends", true],
  ]);
  assert.equal(adapter.get("rightTwoActionBar"), "1");
  assert.equal(values().plateEnemies, false);
});

test("unsupported CVars never create state or call the host", () => {
  const { adapter, writes } = fakeSettings();

  for (const name of [
    "Sound_InterfaceVolume", "showTimestamps", "cameraPitchSmoothSpeed", "groundEffectDensity",
    "useUiScale", "gxResolution", "EnableVoiceChat", "webclient_", "webclient_spellbookHideLowerRanks", "",
  ]) {
    assert.equal(adapter.get(name), undefined, name);
    assert.equal(adapter.getDefault(name), undefined, name);
    assert.equal(adapter.set(name, "1"), false, name);
    assert.equal(adapter.range(name), undefined, name);
  }
  assert.deepEqual(writes, []);
});

test("the loot CVars are the native loot switches: autoLootDefault is «Автоподбор добычи», lootUnderMouse its own row", () => {
  const { adapter, writes, values } = fakeSettings();

  // InterfaceOptionsFrame.lua:322-323: both default to "0".
  assert.equal(adapter.getDefault("autoLootDefault"), "0");
  assert.equal(adapter.getDefault("lootUnderMouse"), "0");
  assert.equal(adapter.get("lootundermouse"), "0");
  // LootFrame.lua:168 compares GetCVar("lootUnderMouse") with "1".
  assert.equal(adapter.set("lootUnderMouse", "1"), true);
  assert.equal(values().lootUnderMouse, true);
  assert.equal(adapter.get("lootUnderMouse"), "1");
  assert.equal(adapter.set("AUTOLOOTDEFAULT", 1), true);
  assert.equal(values().autoLoot, true, "the switch FrameXmlLootHost reads");
  assert.equal(adapter.get("autoLootDefault"), "1");
  assert.deepEqual(writes, [{ id: "lootUnderMouse", value: true }, { id: "autoLoot", value: true }]);
});
