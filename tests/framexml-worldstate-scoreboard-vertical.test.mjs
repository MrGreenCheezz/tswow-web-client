// Plan items 3.14 (a, c), 1.06, 1.08 (IsInInstance "pvp"), 1.09 and 3.15 over the real stock
// FrameXML of the client MPQ, on the canned seam: WorldStateScoreFrame fills from the scoreboard model,
// its tabs filter, its leave button leaves; entering a battleground with IsInInstance "pvp" reaches no
// Blizzard_BattlefieldMinimap error; PlayerFrame shows the PvP timer; PVPFrame's team opens its roster
// and the invitation popup reaches the seam.
import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { installFrameXmlBattlefieldMinimapRefusal } =
  await import("../dist/code/browser/framexml/FrameXmlBattlefieldMinimap.js");
const { PLAYER_FLAGS_PVP_TIMER } = await import("../dist/code/world/Fields.js");

const decoder = new TextDecoder("utf-8");

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "scoreboard-vertical", []);
  assert.ok(fn, `the probe compiles: ${code}`);
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

function row(guid, killingBlows, objectives) {
  return {
    guid, killingBlows, honorableKills: killingBlows * 2, deaths: 1, bonusHonor: 10 * killingBlows, teamId: 2,
    damageDone: 100 * killingBlows, healingDone: 5, objectives,
  };
}

test("stock WorldStateScoreFrame, the battlefield minimap refusal, the PvP timer and the arena roster", {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    exercise: true,
    screen: () => ({ width: 1024, height: 768 }),
    beforeExercise: (loaded) => { installFrameXmlBattlefieldMinimapRefusal(loaded); },
  });
  try {
    await boot.load();
    const errors = boot.errorCount;
    const newErrors = () => JSON.stringify(boot.errors.slice(errors));
    const world = seam.pvpWorld;

    // ---- 3.14a / 1.06: the final scoreboard of a Warsong Gulch match -----------------------------
    const names = [
      [1n, "Альяна", 1, 1], [2n, "Бранн", 3, 2], [3n, "Велен", 11, 5],
      [4n, "Гаррош", 2, 1], [5n, "Дрек", 8, 3], [6n, "Ексон", 5, 9],
    ];
    for (const [guid, name, race, classId] of names) world.setName(guid, name, race, classId);
    world.setRunningBattlefield(489, false);
    world.setScoreboard({
      arena: false, teams: [], ended: true, winner: 1,
      scores: [row(1n, 3, [1, 0]), row(2n, 6, [0, 2]), row(3n, 1, [0, 0]), row(4n, 5, [2, 1]), row(5n, 2, [0, 0]), row(6n, 4, [1, 1])],
    });
    assert.deepEqual(lua(boot, "return WorldStateScoreFrame:IsShown()"), [true],
      "UPDATE_BATTLEFIELD_SCORE with a winner shows the frame (WorldStateFrame.xml:1551-1555)");
    assert.deepEqual(lua(boot, "return WorldStateScoreButton1NameText:GetText()"), ["Бранн"], "sorted by killing blows");
    for (let index = 1; index <= 6; index++) {
      assert.deepEqual(lua(boot, `return WorldStateScoreButton${index}:IsShown()`), [true], `row ${index} shown`);
    }
    assert.deepEqual(lua(boot, "return WorldStateScoreButton7:IsShown()"), [false]);
    assert.deepEqual(lua(boot, "return WorldStateScoreColumn1Text:GetText(), WorldStateScoreColumn2:IsShown(), WorldStateScoreColumn3:IsShown()", 3),
      ["Захваты флага", true, false]);
    assert.deepEqual(lua(boot, "return WorldStateScoreButton1Column2Text:GetText()"), [lua(boot, "return format(FLAG_COUNT_TEMPLATE, 2)")[0]]);
    assert.deepEqual(lua(boot, "return WorldStateScoreFrameLeaveButton:IsShown()"), [true]);
    assert.equal(boot.errorCount, errors, `no Lua error from the scoreboard: ${newErrors()}`);

    // The Horde tab (tab 3 → faction 0): three rows.
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("WorldStateScoreFrameTab3")), true);
    assert.deepEqual(lua(boot, "return GetNumBattlefieldScores()"), [3]);
    assert.deepEqual(lua(boot, "return WorldStateScoreButton1NameText:GetText(), WorldStateScoreButton4:IsShown()", 2), ["Гаррош", false]);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("WorldStateScoreFrameTab1")), true);
    assert.deepEqual(lua(boot, "return GetNumBattlefieldScores()"), [6]);

    assert.equal(boot.bridge.Click(boot.bridge.getFrame("WorldStateScoreFrameLeaveButton")), true);
    assert.equal(world.leftBattlefield, 1, "the leave button reaches LeaveBattlefield");
    assert.equal(boot.errorCount, errors, `no Lua error from the tabs or the leave button: ${newErrors()}`);

    // ---- 3.14c with 1.08: entering a battleground, IsInInstance "pvp" ------------------------------
    world.instanceType = 3;
    assert.deepEqual(lua(boot, "return IsInInstance()", 2), [1, "pvp"]);
    assert.deepEqual(lua(boot, "return GetCVar('showBattlefieldMinimap')"), ["1"]);
    // WorldStateAlwaysUpFrame's PLAYER_ENTERING_WORLD (WorldStateFrame.lua:103-106 → :359-373), and the
    // world map dropdown's path; the whole-UI event would also replay unrelated bar animations here.
    // message() writes only into a hidden BasicScriptErrors (BasicControls.xml); the vertical's own
    // CombatLog load failure may already be on it.
    lua(boot, "BasicScriptErrors:Hide()", 0);
    lua(boot, "WorldStateAlwaysUpFrame_OnEvent(WorldStateAlwaysUpFrame, 'PLAYER_ENTERING_WORLD')", 0);
    lua(boot, "WorldStateFrame_ToggleBattlefieldMinimap(); ToggleBattlefieldMinimap()", 0);
    assert.equal(boot.errorCount, errors, `no «Blizzard_BattlefieldMinimap» error on entering: ${newErrors()}`);
    const [dialogText] = lua(boot, "return rawget(_G, 'BasicScriptErrors') and BasicScriptErrors:IsShown() and BasicScriptErrorsText:GetText() or ''");
    assert.ok(!String(dialogText).includes("Blizzard_BattlefieldMinimap"), `no UIParentLoadAddOn message(): ${dialogText}`);
    assert.deepEqual(lua(boot, "return rawget(_G, 'BattlefieldMinimap') == nil, WorldStateFrame_CanShowBattlefieldMinimap()", 2), [true, false]);
    assert.deepEqual(lua(boot, "return GetCVar('showBattlefieldMinimap')"), ["1"], "the player's setting is left alone");
    world.instanceType = 0;

    // ---- 1.09: the PvP timer over the portrait ------------------------------------------------------
    world.setPlayerFlags(PLAYER_FLAGS_PVP_TIMER);
    seam.pvpFlag.flagsChanged();
    boot.bridge.dispatchEvent("PLAYER_FLAGS_CHANGED", "player");
    const [timerShown, timeLeft] = lua(boot, "return PlayerPVPTimerText:IsShown(), PlayerPVPTimerText.timeLeft", 2);
    assert.equal(timerShown, true);
    // A fresh five-minute deadline plus the client's 1000, less the milliseconds the boot clock moved.
    assert.ok(timeLeft > 290_000 && timeLeft <= 301_000, `timeLeft ${timeLeft}`);
    world.setPlayerFlags(0);
    seam.pvpFlag.flagsChanged();
    boot.bridge.dispatchEvent("PLAYER_FLAGS_CHANGED", "player");
    assert.deepEqual(lua(boot, "return PlayerPVPTimerText:IsShown()"), [false]);

    // ---- 1.08 / 1.09: the player portrait menu's difficulty and PvP rows ---------------------------
    const submenu = (value) => {
      // The row's arrow opens its level (UIDropDownMenuTemplates.xml:150).
      lua(boot, `CloseDropDownMenus()
        ToggleDropDownMenu(1, nil, PlayerFrameDropDown, "PlayerFrame", 106, 27)
        for index = 1, (DropDownList1.numButtons or 0) do
          local row = _G["DropDownList1Button" .. index]
          if row.value == "${value}" then ToggleDropDownMenu(2, row.value, nil, nil, nil, nil, row.menuList, row) end
        end`, 0);
      const [text] = lua(boot, `local out = {}
        for index = 1, (DropDownList2.numButtons or 0) do
          local button = _G["DropDownList2Button" .. index]
          out[#out + 1] = tostring(button.value) .. ":" .. (button.checked and "x" or "-")
        end
        return table.concat(out, ",")`);
      return String(text).split(",");
    };
    const clickRow = (value) => lua(boot, `for index = 1, (DropDownList2.numButtons or 0) do
        local button = _G["DropDownList2Button" .. index]
        -- The row's own handler: the canned party greys these rows for a non-leader (UnitPopup.lua:318-321).
        if button.value == "${value}" then UnitPopup_OnClick(button) return 1 end
      end
      return 0`)[0];
    // UnitPopup.lua:699-702: below level 65 on normal the row is not offered at all (canned level 60).
    assert.deepEqual(submenu("DUNGEON_DIFFICULTY"), [""], "no difficulty row for a level-60 player on normal");
    world.dungeonDifficulty = 1;
    const heroic = submenu("DUNGEON_DIFFICULTY");
    assert.ok(heroic.includes("DUNGEON_DIFFICULTY2:x") && heroic.includes("DUNGEON_DIFFICULTY1:-"), heroic.join(","));
    assert.equal(clickRow("DUNGEON_DIFFICULTY1"), 1);
    assert.deepEqual(world.difficultyCalls, [{ difficulty: 0, raid: false }], "SetDungeonDifficulty(1) sends the 0-based word");
    world.setPlayerFlags(0x200);
    const pvpRows = submenu("PVP_FLAG");
    assert.ok(pvpRows.includes("PVP_ENABLE:x") && pvpRows.includes("PVP_DISABLE:-"), pvpRows.join(","));
    assert.equal(clickRow("PVP_DISABLE"), 1);
    assert.deepEqual(world.pvpCalls, [false], "SetPVP(nil) switches the flag off");
    world.setPlayerFlags(0);
    lua(boot, "CloseDropDownMenus()", 0);
    assert.equal(boot.errorCount, errors, `no Lua error from the portrait menu: ${newErrors()}`);

    // ---- 3.15: PVPFrame's team 1 opens its roster; the invitation popup reaches the seam -----------
    world.setArenaTeam(1, {
      info: { teamId: 12, name: "Стражи", type: 2, backgroundColor: 0xff112233, emblemStyle: 1, emblemColor: 0xff445566, borderStyle: 2, borderColor: 0xff778899 },
      stats: { teamId: 12, rating: 1550, weekGames: 10, weekWins: 6, seasonGames: 40, seasonWins: 22, rank: 7 },
      captain: true,
    });
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("PVPTeam1")), true);
    assert.deepEqual(world.rosterRequests, [12], "PVPTeam_OnClick asks for the roster by the slot's team id");
    world.setArenaRoster({
      teamId: 12, type: 2,
      members: [
        { guid: 0x42n, online: true, name: "Тест", captain: true, level: 80, classId: 1, weekGames: 10, weekWins: 6, seasonGames: 40, seasonWins: 22, personalRating: 1560 },
        { guid: 0x43n, online: false, name: "Друг", captain: false, level: 79, classId: 5, weekGames: 8, weekWins: 5, seasonGames: 30, seasonWins: 15, personalRating: 1490 },
      ],
    });
    assert.deepEqual(lua(boot, "return PVPTeamDetails:IsShown(), PVPTeamDetailsButton1NameText:GetText(), PVPTeamDetailsButton2NameText:GetText(), PVPTeamDetailsButton3:IsShown()", 4),
      [true, "Друг", "Тест", false], "the roster sorted by name, two rows");
    lua(boot, "local dialog = StaticPopup_Show('ADD_TEAMMEMBER'); dialog.editBox:SetText('Гость'); StaticPopup_OnClick(dialog, 1)", 0);
    assert.deepEqual(world.arenaCommands, [{ command: "invite", teamId: 12, name: "Гость" }]);
    assert.equal(boot.errorCount, errors, `no Lua error from the roster: ${newErrors()}`);
  } finally {
    boot.close();
    chain.close();
  }
});
