import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock unit menus (UnitPopup.lua) over the canned seam, through the real corpus.
// Before these bindings «Обмен» and «Дуэль» were grey for everybody (`not HasFullControl()` on the
// stub's nil, UnitPopup.lua:1048, :1092), «Выбрать целью» and the raid's «Главный танк»/«Главный
// помощник» never showed (`not issecure()`, :593, :752, :758), and SET_FOCUS, RAID_PROMOTE,
// RAID_MAINTANK and RAID_DEMOTE reached the stub floor and sent nothing.
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

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CANNED_INSPECT_TARGET } = await import("../dist/code/browser/framexml/FrameXmlInspectCanned.js");
const decoder = new TextDecoder("utf-8");

/** The canned raid (FrameXmlFriendsCanned.ts `groupList(true)`): wire order, then the player 0x42. */
const RAID = Object.freeze({ alpha: 0x501n, beta: 0x502n, gamma: 0x503n, delta: 0x504n });

function run(boot, code) {
  const ran = boot.vm.execute(code, "@unitpopup-vertical");
  assert.equal(ran.ok, true, ran.error);
}

/** `value:enabled` for every row of the open first-level menu, primitives only. */
function rows(boot) {
  run(boot, `
    local out = {}
    if DropDownList1:IsShown() then
      for index = 1, (DropDownList1.numButtons or 0) do
        local button = _G["DropDownList1Button" .. index]
        out[#out + 1] = tostring(button.value) .. ":" .. (button:IsEnabled() == 1 and "on" or "off")
      end
    end
    __unitpopup_rows = table.concat(out, ",")
  `);
  const text = boot.vm.getGlobal("__unitpopup_rows");
  return text ? String(text).split(",") : [];
}

/** Click the first-level row whose value is `value`; false when the menu has no such row. */
function click(boot, value) {
  run(boot, `
    __unitpopup_clicked = 0
    for index = 1, (DropDownList1.numButtons or 0) do
      local button = _G["DropDownList1Button" .. index]
      if button.value == "${value}" then button:Click("LeftButton") __unitpopup_clicked = 1 break end
    end
  `);
  return boot.vm.getGlobal("__unitpopup_clicked") === 1;
}

/**
 * Blizzard_RaidUI's raid row menu: RaidGroupButton_ShowMenu puts the row's `raid<id>` unit, name
 * and id on FriendsDropDown (Blizzard_RaidUI.lua:592-601) and RaidFrameDropDown_Initialize passes
 * them to UnitPopup_ShowMenu (:660-662).
 */
function openRaidMenu(boot, name, index) {
  run(boot, `
    HideDropDownMenu(1)
    FriendsDropDown.name = "${name}"
    FriendsDropDown.id = ${index}
    FriendsDropDown.unit = "raid${index}"
    FriendsDropDown.initialize = function(self)
      UnitPopup_ShowMenu(UIDROPDOWNMENU_OPEN_MENU, "RAID", self.unit, self.name, self.id)
    end
    FriendsDropDown.displayMode = "MENU"
    ToggleDropDownMenu(1, nil, FriendsDropDown, "cursor")
    UnitPopup_OnUpdate(0)
  `);
}

/**
 * The canned seam, with the raid rows' names behind their `raid<i>` tokens: the canned social raid
 * in wire order, then the player (FrameXmlRaid.ts), as the live seam resolves `raidN`.
 */
class RaidCannedSeam extends CannedWorldSeam {
  unitName(unit) {
    const group = this.socialWorld.group;
    const match = /^raid(\d+)$/.exec(String(unit).toLowerCase());
    if (match && group && (group.groupType & 0x02) !== 0) {
      const index = Number(match[1]);
      return index === group.members.length + 1 ? super.unitName("player") : group.members[index - 1]?.name;
    }
    return super.unitName(unit);
  }
}

test("the unit menus: control, the secure entry and the group, focus commands", withClient, async () => {
  const seam = new RaidCannedSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1920, height: 1080 }),
  });
  try {
    await boot.load();
    const errors = boot.errorCount;
    for (const name of ["HasFullControl", "FocusUnit", "ClearFocus", "PromoteToAssistant", "SetPartyAssignment",
      "ClearPartyAssignment", "GetPartyAssignment"]) {
      run(boot, `__unitpopup_seam = type(rawget(_G, "__fxSeam_${name}")) == "function"
        and __fxNeutralImpl["${name}"] == rawget(_G, "__fxSeam_${name}")`);
      assert.equal(boot.vm.getGlobal("__unitpopup_seam"), true, `${name} reaches the seam, not the stub floor`);
    }

    // 1.05: the friendly player's menu (TargetFrameDropDown_Initialize → "PLAYER"), UnitPopup_OnUpdate
    // as UIParent's OnUpdate runs it each frame.
    seam.setTarget(CANNED_INSPECT_TARGET);
    const targetMenu = () => {
      run(boot, `CloseDropDownMenus() ToggleDropDownMenu(1, nil, TargetFrameDropDown, "TargetFrame", 120, 10) UnitPopup_OnUpdate(0)`);
      return rows(boot);
    };
    let shown = targetMenu();
    assert.ok(shown.includes("TRADE:on"), `«Обмен» is live in control: ${shown}`);
    assert.ok(shown.includes("DUEL:on"), `«Дуэль» too: ${shown}`);
    // UIParent's handler closes every window through IsOptionFrameOpen (UIParent.lua:2205), which
    // dereferences InterfaceOptionsFrame. The options chain loads lazily (FRAMEXML_OPTIONS_TOC); until
    // then the boot's own hidden stand-in answers «not open» — no mount, no bag gate here.
    run(boot, "__unitpopup_options = InterfaceOptionsFrame and not InterfaceOptionsFrame:IsShown() and 1 or 0");
    assert.equal(boot.vm.getGlobal("__unitpopup_options"), 1, "a hidden InterfaceOptionsFrame stand-in exists at boot");
    assert.equal(boot.bridge.getFrame("InterfaceOptionsFrame"), undefined, "not the options chain's named frame");
    assert.ok(seam.setControlLost(true) >= 2, "PLAYER_CONTROL_LOST reaches UIParent and PetActionBarFrame");
    run(boot, "__unitpopup_out = UIParent.isOutOfControl");
    assert.equal(boot.vm.getGlobal("__unitpopup_out"), 1, "UIParent.lua:800-819 took the edge");
    shown = targetMenu();
    assert.ok(shown.includes("TRADE:off") && shown.includes("DUEL:off"), `under a fear both grey out: ${shown}`);
    seam.setControlLost(false);
    run(boot, "__unitpopup_out = UIParent.isOutOfControl");
    assert.equal(boot.vm.getGlobal("__unitpopup_out") ?? undefined, undefined, "PLAYER_CONTROL_GAINED cleared it (:822-835)");
    shown = targetMenu();
    assert.ok(shown.includes("TRADE:on") && shown.includes("DUEL:on"), `and come back: ${shown}`);

    // 1.10: SET_FOCUS on that menu, then the focus frame's own CLEAR_FOCUS.
    assert.equal(click(boot, "SET_FOCUS"), true);
    assert.deepEqual(seam.focusChanges, ["0xf130000000000101"], "FocusUnit(\"target\"): the target's guid");
    run(boot, `CloseDropDownMenus() ToggleDropDownMenu(1, nil, FocusFrameDropDown, "FocusFrame", 120, 10)`);
    assert.equal(click(boot, "CLEAR_FOCUS"), true, `the focus menu: ${rows(boot)}`);
    assert.deepEqual(seam.focusChanges, ["0xf130000000000101", undefined]);

    // 3.20: «Выбрать целью» exists only inside the secure entry; outside it issecure() is nil.
    run(boot, `CloseDropDownMenus() FriendsFrame_ShowDropdown("Альфа", 1) UnitPopup_OnUpdate(0)`);
    shown = rows(boot);
    assert.ok(shown.includes("TARGET:on"), `the friend menu offers TARGET: ${shown}`);
    run(boot, "CloseDropDownMenus() __unitpopup_secure = issecure() == nil");
    assert.equal(boot.vm.getGlobal("__unitpopup_secure"), true, "nothing outside the entry is secure");

    // 3.20 + 1.10: the raid menu of a leader — main tank/assist show, the clicks send the packets.
    seam.socialWorld.groupList(true);
    seam.setPartyLeader(true);
    openRaidMenu(boot, "Гамма", 3);
    shown = rows(boot);
    assert.ok(shown.includes("RAID_MAINTANK:on") && shown.includes("RAID_MAINASSIST:on"), `the leader's raid menu: ${shown}`);
    assert.equal(click(boot, "RAID_MAINTANK"), true);
    openRaidMenu(boot, "Гамма", 3);
    assert.equal(click(boot, "RAID_PROMOTE"), true);
    // Бета is the canned main tank (flag 0x02): no «Главный танк» again, «Разжаловать» clears it.
    openRaidMenu(boot, "Бета", 2);
    shown = rows(boot);
    assert.ok(!shown.includes("RAID_MAINTANK:on") && shown.includes("RAID_DEMOTE:on"), `the main tank's row: ${shown}`);
    assert.equal(click(boot, "RAID_DEMOTE"), true);
    assert.deepEqual(seam.assignments, [
      { assignment: 0, apply: true, guid: RAID.gamma },
      { assignment: 0, apply: false, guid: RAID.beta },
    ], "MSG_PARTY_ASSIGNMENT: set on Гамма, cleared on Бета (UnitPopup.lua:1335-1346)");
    assert.deepEqual(seam.assistantCalls, [{ guid: RAID.gamma, apply: true }], "CMSG_GROUP_ASSISTANT_LEADER");
    assert.deepEqual(boot.errors.slice(errors).map((error) => error.message), []);
  } finally {
    boot.close();
  }
});
