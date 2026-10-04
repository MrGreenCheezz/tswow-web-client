import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the mechanics the boot census listed as unanswered, reached through the stock Lua
// over the canned seam — each formerly neutral name resolves to the seam's binding, Constants.lua's
// class lists are filled, the target frame's threat glow shows, the keyring button appears, the
// quest log's «Отказаться» goes through StaticPopup to the seam, and the chat window flags round-trip.
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
const { CANNED_PLAYER_THREAT } = await import("../dist/code/browser/framexml/FrameXmlThreatCanned.js");
const decoder = new TextDecoder("utf-8");

/** Names the seam answers directly: `__fxNeutralImpl[name]` is the host binding itself. */
const SEAM_NAMES = [
  "UnitThreatSituation", "UnitDetailedThreatSituation", "GetThreatStatusColor", "HasKey",
  "SetAbandonQuest", "AbandonQuest", "GetAbandonQuestName", "GetAbandonQuestItems",
  "GetQuestTimers", "GetQuestIndexForTimer", "IsMacClient", "NoPlayTime", "PartialPlayTime", "UnitIsTalking",
  "GetArenaTeam", "GetPossessInfo", "IsPossessBarVisible", "SetChatWindowLocked",
  "SetChatWindowUninteractable", "SetChatWindowDocked", "SendAddonMessage", "GetBattlefieldWinner",
  "RequestBattlefieldPositions",
];
/** Names whose Lua half wraps the binding (the CVar read, the table fill). */
const WRAPPED_NAMES = ["IsThreatWarningEnabled", "FillLocalizedClassList", "RegisterStaticConstants"];

async function load(seam = new CannedWorldSeam()) {
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "mechanics-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

function errorsSince(boot, count) {
  return JSON.stringify(boot.errors.slice(count).map((error) => error.message));
}

test("every census name resolves to the seam, and the stock Lua reaches each answer without a raise", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const errors = boot.errorCount;
    for (const name of SEAM_NAMES) {
      assert.deepEqual(lua(boot, `return __fxNeutralImpl["${name}"] == rawget(_G, "__fxSeam_${name}")`), [true], name);
    }
    for (const name of WRAPPED_NAMES) {
      assert.deepEqual(lua(boot, `return type(__fxNeutralImpl["${name}"]) == "function"
        and __fxNeutralImpl["${name}"] ~= rawget(_G, "__fxSeam_${name}")`), [true], `${name} is wrapped in Lua`);
    }
    // Answered elsewhere already: the LFD prelude fills the queued-dungeon table, the boot answers
    // add-on metadata from the load-on-demand TOCs.
    assert.deepEqual(lua(boot, `local t = {} GetLFGQueuedList(t) return type(__fxNeutralImpl.GetLFGQueuedList), next(t)`, 2),
      ["function", undefined]);
    assert.deepEqual(lua(boot, `return type(GetAddOnMetadata), GetAddOnMetadata("Blizzard_TalentUI", "Title")`, 2),
      ["function", undefined], "a module not yet loaded has no TOC to answer from");

    // Constants.lua:91-92 filled both class lists at load.
    assert.deepEqual(lua(boot, `local n = 0
      for _ in pairs(LOCALIZED_CLASS_NAMES_MALE) do n = n + 1 end
      return n, LOCALIZED_CLASS_NAMES_MALE.WARRIOR, LOCALIZED_CLASS_NAMES_FEMALE.MAGE, LOCALIZED_CLASS_NAMES_MALE.DEATHKNIGHT`, 4),
    [10, "Воин", "Маг", "Рыцарь смерти"]);
    // 8.17: Constants.lua:475 hands STATIC_CONSTANTS over and, as Wow.exe 0x5ac320, gets the lag kinds back.
    assert.deepEqual(lua(boot, "local c = STATIC_CONSTANTS return c.Loot, c.AuctionHouse, c.Mail, c.Chat, c.Movement, c.Spell", 6),
      [1, 2, 3, 4, 5, 6]);

    // The threatWarning CVar: the client default, the options dropdown's write, and its default.
    assert.deepEqual(lua(boot, `return GetCVar("threatWarning"), GetCVarDefault("threatWarning"), IsThreatWarningEnabled()`, 3), ["3", "3", true]);
    assert.deepEqual(lua(boot, `SetCVar("threatWarning", "0") return IsThreatWarningEnabled()`), [false]);
    assert.deepEqual(lua(boot, `SetCVar("threatWarning", "2") return IsThreatWarningEnabled()`), [true], "the canned party counts as a group");
    lua(boot, `SetCVar("threatWarning", "3")`, 0);

    // The cheap honest answers, as the stock code reads them.
    assert.deepEqual(lua(boot, `return IsMacClient(), NoPlayTime(), PartialPlayTime(), UnitIsTalking(UnitName("player"))`, 4),
      [false, false, false, false]);
    assert.deepEqual(lua(boot, `return IsPossessBarVisible(), GetPossessInfo(1), GetArenaTeam(1), GetBattlefieldWinner()`, 4),
      [false, undefined, undefined, undefined]);
    assert.deepEqual(lua(boot, `return GetQuestTimers()`, 1), [90], "the canned quest's timer");
    assert.deepEqual(lua(boot, `return GetQuestIndexForTimer(1)`, 1), [1]);
    lua(boot, `RequestBattlefieldPositions() SendAddonMessage("TSWOW", "hello", "PARTY")`, 0);
    assert.equal(boot.errorCount, errors, errorsSince(boot, errors));
    void seam;
  } finally {
    boot.close();
  }
});

test("the target frame's threat glow follows the canned target's list through UnitFrame_UpdateThreatIndicator", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, `return TargetFrame.threatIndicator == TargetFrameFlash, TargetFrame.threatNumericIndicator == TargetFrameNumericalThreat`, 2),
      [true, true]);
    assert.deepEqual(lua(boot, `return UnitThreatSituation("player", "target")`), [undefined], "no target yet");
    seam.tick(10);
    seam.tick(10);
    assert.deepEqual(lua(boot, `return UnitExists("target"), UnitThreatSituation("player", "target")`, 2), [true, 3]);
    assert.deepEqual(lua(boot, `return UnitDetailedThreatSituation("player", "target")`, 5), [true, 3, 100, 100, CANNED_PLAYER_THREAT]);
    lua(boot, `UnitFrame_UpdateThreatIndicator(TargetFrame.threatIndicator, TargetFrame.threatNumericIndicator, "player")`, 0);
    assert.deepEqual(lua(boot, `local r, g, b = TargetFrameFlash:GetVertexColor()
      return TargetFrameFlash:IsShown() and 1 or 0, r, g, b, TargetFrameNumericalThreat:IsShown() and 1 or 0`, 5),
    [1, 1, 0, 0, 0], "red glow; the numeric badge waits for threatShowNumeric");
    lua(boot, `SetCVar("threatShowNumeric", "1")
      UnitFrame_UpdateThreatIndicator(TargetFrame.threatIndicator, TargetFrame.threatNumericIndicator, "player")`, 0);
    assert.deepEqual(lua(boot, `return TargetFrameNumericalThreat:IsShown() and 1 or 0, TargetFrameNumericalThreat.text:GetText()`, 2),
      [1, "100%"]);
    // The event the seam fires for a threat change repaints through the same handler.
    seam.threatWorld.threat.apply({
      guid: BigInt(seam.unitGuid("target")), highestGuid: BigInt(seam.unitGuid("party1")),
      entries: [{ guid: BigInt(seam.unitGuid("player")), threat: 4_000 }, { guid: BigInt(seam.unitGuid("party1")), threat: 10_000 }],
    });
    lua(boot, `TargetFrame:GetScript("OnEvent")(TargetFrame, "UNIT_THREAT_SITUATION_UPDATE", "player")`, 0);
    // The badge prints the third return, the *scaled* percent: 40% of the tank over the 110% melee
    // pull threshold (UnitFrame.lua:446-448).
    assert.deepEqual(lua(boot, `return TargetFrameFlash:IsShown() and 1 or 0, TargetFrameNumericalThreat.text:GetText()`, 2),
      [0, "36%"], "status 0 hides the glow; the badge reads 40% of the tank scaled by 110%");
    lua(boot, `SetCVar("threatWarning", "0")
      UnitFrame_UpdateThreatIndicator(TargetFrame.threatIndicator, TargetFrame.threatNumericIndicator, "player")`, 0);
    assert.deepEqual(lua(boot, `return TargetFrameNumericalThreat:IsShown() and 1 or 0`), [0], "warnings off hide the badge too");
    lua(boot, `SetCVar("threatWarning", "3") SetCVar("threatShowNumeric", "0")`, 0);
    assert.equal(boot.errorCount, errors, errorsSince(boot, errors));
  } finally {
    boot.close();
  }
});

test("a key in the keyring shows the stock KeyRingButton on BAG_UPDATE", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, `return HasKey(), KeyRingButton:IsShown() and 1 or 0`, 2), [false, 0]);
    assert.ok(seam.setContainerItem(-2, 1, { texture: "Interface\\Icons\\INV_Misc_Key_05", count: 1 }) > 0, "BAG_UPDATE(-2) reached a frame");
    assert.deepEqual(lua(boot, `return HasKey(), KeyRingButton:IsShown() and 1 or 0, GetCVar("showKeyring")`, 3), [true, 1, "1"]);
    assert.equal(boot.errorCount, errors, errorsSince(boot, errors));
  } finally {
    boot.close();
  }
});

test("«Отказаться» in the stock quest log confirms through StaticPopup and abandons the selected row", withClient, async () => {
  const { boot, seam } = await load();
  try {
    const errors = boot.errorCount;
    lua(boot, `ShowUIPanel(QuestLogFrame) QuestLog_SetSelection(1)`, 0);
    assert.deepEqual(lua(boot, `return GetQuestLogSelection(), GetAbandonQuestName(), QuestLogFrameAbandonButton:IsEnabled()`, 3),
      [1, "Проверка журнала заданий", 1]);
    boot.bridge.Click(boot.bridge.getFrame("QuestLogFrameAbandonButton"));
    assert.deepEqual(lua(boot, `return StaticPopup_Visible("ABANDON_QUEST") and 1 or 0, StaticPopup_Visible("ABANDON_QUEST_WITH_ITEMS") and 1 or 0`, 2),
      [1, 0], "no quest item is carried: the plain confirmation");
    assert.deepEqual(lua(boot, `return StaticPopup1Text:GetText()`), [
      lua(boot, `return format(ABANDON_QUEST_CONFIRM, "Проверка журнала заданий")`)[0],
    ]);
    lua(boot, "StaticPopup1Button1:Click()", 0);
    assert.deepEqual(seam.abandonedQuests, [{ slot: 0, questId: 9001 }]);
    assert.deepEqual(lua(boot, `return GetNumQuestLogEntries()`, 2), [0, 0]);
    assert.deepEqual(lua(boot, `return StaticPopup_Visible("ABANDON_QUEST") and 1 or 0, GetAbandonQuestName()`, 2), [0, undefined]);
    assert.equal(boot.errorCount, errors, errorsSince(boot, errors));
  } finally {
    boot.close();
  }
});

test("FCF_SetLocked and FCF_SetUninteractable round-trip through GetChatWindowInfo", withClient, async () => {
  const { boot } = await load();
  try {
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, `return select(8, GetChatWindowInfo(1))`), [true]);
    lua(boot, `FCF_SetLocked(ChatFrame1, nil)`, 0);
    assert.deepEqual(lua(boot, `local _, _, _, _, _, _, shown, locked, docked, uninteractable = GetChatWindowInfo(1)
      return shown, locked, docked, uninteractable`, 4), [true, false, true, false]);
    lua(boot, `FCF_SetLocked(ChatFrame1, 1) FCF_SetUninteractable(ChatFrame1, 1)`, 0);
    assert.deepEqual(lua(boot, `return select(8, GetChatWindowInfo(1))`, 3), [true, true, true]);
    lua(boot, `FCF_SetUninteractable(ChatFrame1, nil)`, 0);
    assert.deepEqual(lua(boot, `return select(10, GetChatWindowInfo(1))`), [false]);
    // FCF_SaveDock rewrites every docked frame's position; the combat log stays in slot 2.
    lua(boot, `FCF_SaveDock()`, 0);
    assert.deepEqual(lua(boot, `return select(9, GetChatWindowInfo(1)), select(9, GetChatWindowInfo(2))`, 2), [1, 2]);
    assert.equal(boot.errorCount, errors, errorsSince(boot, errors));
  } finally {
    boot.close();
  }
});
