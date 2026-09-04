import assert from "node:assert/strict";
import test from "node:test";

const {
  createFrameXmlSettingsCVar,
  FRAME_XML_SETTINGS_CVARS,
} = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");

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
      ["Sound_MasterVolume", "volumeMaster"],
      ["Sound_SFXVolume", "volumeEffects"],
      ["Sound_MusicVolume", "volumeMusic"],
    ],
  );
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
    "Sound_AmbienceVolume", "Sound_InterfaceVolume", "showTimestamps", "cameraDistanceMaxFactor",
    "gxResolution", "EnableVoiceChat", "",
  ]) {
    assert.equal(adapter.get(name), undefined, name);
    assert.equal(adapter.getDefault(name), undefined, name);
    assert.equal(adapter.set(name, "1"), false, name);
  }
  assert.deepEqual(writes, []);
});
