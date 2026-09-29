import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock character window's title picker (PlayerTitleFrame), the 3.3.5 equipment
// manager (EquipmentManager.lua in the vertical, GearManagerDialog and its save popup, StaticPopup's
// confirmations) and the Skills tab's unlearn button, over the vertical corpus and the canned seam:
// the canned titles and set, CMSG_SET_TITLE / the three equipment-set packets / CMSG_UNLEARN_SKILL
// as the stand-in realm records them, and 0 new Lua errors throughout.
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
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { createFrameXmlSettingsCVar } = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");
const { CANNED_SET_GUID_BASE, CANNED_WORN_GUID_BASE } = await import("../dist/code/browser/framexml/FrameXmlEquipmentSetsCanned.js");
const decoder = new TextDecoder("utf-8");

async function load(settings = {}) {
  let values = { ...defaultSettings(), ...settings };
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { values = { ...values, [id]: value }; },
  });
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cvars);
  const reads = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        if (data) reads.push(path.replaceAll("\\", "/").toLowerCase());
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam, reads };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "character-tabs-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const newErrors = (boot, from) => JSON.stringify(boot.errors.slice(from).map((e) => `${e.file}:${e.line} ${e.message}`));
const frame = (boot, name) => {
  const found = boot.bridge.getFrame(name);
  assert.ok(found, `${name} exists`);
  return found;
};
const shown = (boot, name) => boot.bridge.isVisible(frame(boot, name));

test("EquipmentManager.lua is in the vertical and its unpacker reads the seam's packed locations", withClient, async () => {
  const { boot, reads } = await load();
  try {
    assert.ok(reads.includes("interface/framexml/equipmentmanager.lua"), "read from MPQ at its stock TOC position");
    assert.deepEqual(lua(boot, "return type(EquipmentManager_UnpackLocation), type(EquipmentManager_EquipSet), type(EQUIPMENTMANAGER_BAGSLOTS)", 3),
      ["function", "function", "table"]);
    // The canned set's main hand is in the backpack's third slot: the stock unpacker reads bag 0, slot 3.
    assert.deepEqual(lua(boot, `
      local locations = GetEquipmentSetLocations("Бой")
      local player, bank, bags, slot, bag = EquipmentManager_UnpackLocation(locations[16])
      local wornPlayer, _, wornBags, wornSlot = EquipmentManager_UnpackLocation(locations[1])
      local gone = EquipmentManager_UnpackLocation(locations[17])
      return player, bank, bags, slot, bag, wornPlayer, wornBags, wornSlot, gone, locations[19], locations[2]`, 11),
    [true, false, true, 3, 0, true, false, 1, false, 1, 0]);
    assert.deepEqual(lua(boot, "local ids = GetEquipmentSetItemIDs('Бой') return #ids, ids[1], ids[19], ids[17]", 4), [19, 13446, 1, 0],
      "nineteen entries for ipairs: the worn potion's id, the ignored tabard's 1, a gone piece's 0");
  } finally {
    boot.close();
  }
});

test("the title picker lists the known titles, wears one with CMSG_SET_TITLE and renames the sheet", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const errors = boot.errorCount;
    lua(boot, "ShowUIPanel(CharacterFrame)", 0);
    assert.equal(shown(boot, "CharacterFrame"), true);
    assert.equal(shown(boot, "PaperDollFrame"), true);
    assert.equal(shown(boot, "PlayerTitleFrame"), true, "three known titles: the picker's frame shows");
    assert.equal(frame(boot, "PlayerTitleFrameText").text, "Рядовой ", "GetTitleName(current) as stock sets it, placeholder removed");
    assert.equal(frame(boot, "CharacterNameText").text, "Рядовой Игрок", "UnitPVPName on the sheet's name line");
    assert.equal(shown(boot, "PlayerTitlePickerFrame"), false);
    lua(boot, "PlayerTitlePickerFrame_Toggle()", 0);
    assert.equal(shown(boot, "PlayerTitlePickerFrame"), true);
    // PlayerTitleSort: «Нет» keeps the top through its blank placeholder, then the byte order of the names.
    assert.deepEqual(lua(boot, `
      local titles = PlayerTitleFrame.titles
      return #titles, titles[1].name, titles[1].id, titles[2].name, titles[2].id, titles[3].name, titles[3].id, titles[4].name, titles[4].id`, 9),
    [4, "Нет", -1, ", защитник Наару", 36, "Разведчик", 15, "Рядовой", 1]);
    assert.deepEqual(lua(boot, `
      for _, button in ipairs(PlayerTitlePickerScrollFrame.buttons) do
        if button.titleId == 36 then PlayerTitleButton_OnClick(button) return button.text:GetText() end
      end`), [", защитник Наару"]);
    assert.deepEqual(seam.titleWorld.sent, [36], "CMSG_SET_TITLE with the mask");
    assert.equal(seam.titleWorld.chosen(), 36);
    assert.equal(shown(boot, "PlayerTitlePickerFrame"), false, "the pick closes the picker");
    assert.equal(frame(boot, "PlayerTitleFrameText").text, ", защитник Наару");
    // The realm's PLAYER_CHOSEN_TITLE edge: UNIT_NAME_UPDATE("player") renames the sheet and redraws the check.
    seam.titles.tick();
    assert.equal(frame(boot, "CharacterNameText").text, "Игрок, защитник Наару");
    assert.deepEqual(lua(boot, "return PlayerTitleFrame.selected, GetCurrentTitle()", 2), [36, 36]);
    // «Нет» takes it off with -1; the realm clears the field.
    lua(boot, "for _, button in ipairs(PlayerTitlePickerScrollFrame.buttons) do if button.titleId == -1 then PlayerTitleButton_OnClick(button) end end", 0);
    assert.deepEqual(seam.titleWorld.sent, [36, -1]);
    seam.titles.tick();
    assert.equal(frame(boot, "CharacterNameText").text, "Игрок");
    assert.deepEqual(lua(boot, "return GetCurrentTitle()"), [-1]);
    // A title earned later (SMSG_TITLE_EARNED) reaches the list through KNOWN_TITLES_UPDATE.
    seam.titleWorld.earn(38);
    seam.titles.tick();
    assert.deepEqual(lua(boot, "return #PlayerTitleFrame.titles, PlayerTitleFrame.titles[5].name", 2), [5, "из Расколотого Солнца"]);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    boot.close();
  }
});

test("with the equipmentManager CVar on, the gear manager opens, lists, wears, saves and deletes the canned set", withClient, async () => {
  const { boot, seam } = await load({ equipmentManager: true });
  const world = seam.equipmentSetWorld;
  try {
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, "return GetCVarBool('equipmentManager'), CanUseEquipmentSets()", 2), [true, true]);
    assert.equal(frame(boot, "GearManagerToggleButton").visible, true, "VARIABLES_LOADED showed the toggle (GearManagerDialog_OnEvent)");
    lua(boot, "ShowUIPanel(CharacterFrame)", 0);
    assert.equal(shown(boot, "GearManagerDialog"), false);
    lua(boot, "GearManagerToggleButton:Click()", 0);
    assert.equal(shown(boot, "GearManagerDialog"), true, "the toggle opens the dialog");
    assert.equal(frame(boot, "GearSetButton1Name").text, "Бой");
    assert.equal(frame(boot, "GearSetButton1Icon").texture, "Interface\\Icons\\INV_Sword_04");
    assert.equal(frame(boot, "GearSetButton2").enabled, false, "the nine empty slots are disabled");
    assert.equal(frame(boot, "GearManagerDialogEquipSet").enabled, false, "nothing selected yet");
    lua(boot, "GearSetButton1:Click()", 0);
    assert.equal(frame(boot, "GearManagerDialogEquipSet").enabled, true);
    assert.equal(frame(boot, "GearManagerDialogDeleteSet").enabled, true);
    lua(boot, "GearManagerDialogEquipSet:Click()", 0);
    assert.equal(world.sent.length, 1);
    assert.equal(world.sent[0][0], "use", "EquipmentManager_EquipSet → UseEquipmentSet → CMSG_EQUIPMENT_SET_USE");
    assert.deepEqual(world.sent[0][1][0], { guid: CANNED_WORN_GUID_BASE + 1n, bag: 255, slot: 0 });
    assert.deepEqual(world.sent[0][1][18], { guid: 1n, bag: 0, slot: 0 }, "the ignored tabard is the raw 1");
    // SMSG_EQUIPMENT_SET_USE_RESULT 0: EQUIPMENT_SWAP_FINISHED selects the set and marks its ignored slots on the doll.
    assert.equal(world.answerUse(true), true);
    assert.deepEqual(lua(boot, "return GearManagerDialog.selectedSetName, CharacterTabardSlot.ignored, EquipmentManagerIsSlotIgnoredForSave(19)", 3),
      ["Бой", true, true]);
    // The save popup, a new name and the first icon: GetEquipmentSetIconInfo(1) is the worn head piece's own picture (-1).
    lua(boot, "GearManagerDialogSaveSet:Click()", 0);
    assert.equal(shown(boot, "GearManagerDialogPopup"), true);
    assert.deepEqual(lua(boot, "return GearManagerDialogPopupEditBox:GetText()"), ["Бой"], "the selected set's name is offered for an overwrite");
    lua(boot, `
      GearManagerDialogPopupEditBox:SetText("Рейд")
      GearManagerDialogPopup.name = "Рейд"
      GearSetPopupButton_OnClick(GearManagerDialogPopupButton1)
      GearManagerDialogPopupOkay_Update()`, 0);
    assert.equal(frame(boot, "GearManagerDialogPopupOkay").enabled, true);
    assert.deepEqual(lua(boot, "return GetEquipmentSetIconInfo(1)", 2), ["Interface\\Icons\\INV_Potion_54", -1]);
    lua(boot, "GearManagerDialogPopupOkay:Click()", 0);
    assert.equal(world.sent.length, 2);
    const [, guid, index, name, icon, pieces] = world.sent[1];
    assert.deepEqual([guid, index, name, icon], [0n, 1, "Рейд", "Interface\\Icons\\INV_Potion_54"],
      "CMSG_EQUIPMENT_SET_SAVE: a new set under the free index with the worn picture");
    assert.equal(pieces[0], CANNED_WORN_GUID_BASE + 1n, "the worn potion");
    assert.equal(pieces[18], 1n, "the tabard the doll marked ignored");
    assert.equal(pieces[1], 0n);
    assert.equal(shown(boot, "GearManagerDialogPopup"), false);
    // The realm's list edge: EQUIPMENT_SETS_CHANGED redraws the dialog in name order.
    seam.equipmentSets.tick();
    assert.equal(frame(boot, "GearSetButton2Name").text, "Рейд");
    assert.equal(frame(boot, "GearSetButton2").enabled, true);
    lua(boot, "GearSetButton2:Click() GearManagerDialogDeleteSet:Click()", 0);
    assert.deepEqual(lua(boot, "local d = StaticPopup_FindVisible('CONFIRM_DELETE_EQUIPMENT_SET') return d and d:GetName(), d and d.data", 2),
      ["StaticPopup1", "Рейд"]);
    lua(boot, "StaticPopup1Button1:Click()", 0);
    assert.deepEqual(world.sent[2], ["delete", CANNED_SET_GUID_BASE + 1n], "CMSG_DELETEEQUIPMENT_SET with the guid SMSG_EQUIPMENT_SET_SAVED named");
    seam.equipmentSets.tick();
    assert.equal(frame(boot, "GearSetButton2Name").text, "");
    lua(boot, "GearManagerToggleButton:Click()", 0);
    assert.equal(shown(boot, "GearManagerDialog"), false, "the toggle closes it; OnHide clears the ignored slots");
    assert.deepEqual(lua(boot, "return EquipmentManagerIsSlotIgnoredForSave(19), CharacterTabardSlot.ignored", 2), [false, undefined]);
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    boot.close();
  }
});

test("with the CVar off the toggle stays hidden, as the client ships it", withClient, async () => {
  const { boot } = await load();
  try {
    assert.deepEqual(lua(boot, "return GetCVarBool('equipmentManager'), CanUseEquipmentSets()", 2), [false, false]);
    assert.equal(frame(boot, "GearManagerToggleButton").visible, false);
  } finally {
    boot.close();
  }
});

test("the Skills tab's unlearn button shows for a profession and AbandonSkill sends the confirmed row's skill", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const errors = boot.errorCount;
    lua(boot, "ShowUIPanel(CharacterFrame) SetSelectedSkill(2) SkillFrame_UpdateSkills()", 0);
    assert.equal(frame(boot, "SkillDetailStatusBarUnlearnButton").visible, true, "«Кузнечное дело» is a profession: isAbandonable");
    assert.deepEqual(lua(boot, "return SkillDetailStatusBarUnlearnButton.skillName, SkillDetailStatusBarUnlearnButton.index", 2),
      ["Кузнечное дело", 2]);
    lua(boot, "SetSelectedSkill(5) SkillFrame_UpdateSkills()", 0);
    assert.equal(frame(boot, "SkillDetailStatusBarUnlearnButton").visible, false, "«Первая помощь» cannot be unlearned in 3.3.5");
    lua(boot, "SetSelectedSkill(2) SkillFrame_UpdateSkills() SkillDetailStatusBarUnlearnButton:Click()", 0);
    assert.deepEqual(lua(boot, "local d = StaticPopup_FindVisible('UNLEARN_SKILL') return d and d:GetName(), d and d.data", 2), ["StaticPopup1", 2]);
    assert.deepEqual(seam.abandonedSkills, [], "nothing goes out before the confirmation");
    lua(boot, "StaticPopup1Button1:Click()", 0);
    assert.deepEqual(seam.abandonedSkills, [164], "CMSG_UNLEARN_SKILL with the SkillLine id");
    assert.equal(boot.errorCount, errors, newErrors(boot, errors));
  } finally {
    boot.close();
  }
});
