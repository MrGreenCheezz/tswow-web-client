import assert from "node:assert/strict";
import test, { after, before } from "node:test";

// 05.10 review of plan item 3.21: the stock quest dialog over the real SetAlphaGradient. The detail
// text types itself in (QuestInfo.lua:3-16, :482-491) and Accept waits for it, so every way the
// fade can run must end with Accept enabled; and the «Мгновенное отображение полного текста»
// option (InterfaceOptionsPanels.xml:939-944, uvar QUEST_FADING_DISABLE over CVar questFadingDisable)
// must be readable, or the stock panel sets the uvar to nil at PLAYER_ENTERING_WORLD.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const decoder = new TextDecoder("utf-8");
let chain;
let boot;

before(async () => {
  if (!clientDirectory) return;
  const { clientArchives } = await import("../tools/mpq.mjs");
  chain = await clientArchives(clientDirectory);
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(),
    screen: () => ({ width: 1024, height: 768 }),
  });
  await boot.load();
});
after(() => { boot?.close?.(); chain?.close(); });

function lua(code, results = 1) {
  const fn = boot.vm.compileFunction(code, "quest-fading-review", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const acceptEnabled = () => (lua("return QuestFrameAcceptButton:IsEnabled()")[0] ? 1 : 0);
const fading = () => lua("return QuestInfoFadingFrame.fading")[0];

/** Opens the detail panel on `text` through the stock OnShow, as QUEST_DETAIL does. */
function openDetail(text, fadingDisable = "0") {
  lua(`QUEST_FADING_DISABLE = ${JSON.stringify(fadingDisable)}
    GetQuestText = function() return ${JSON.stringify(text)} end
    -- The canned world has no QUEST_DETAIL dialog; the live one answers this from the packet.
    GetSuggestedGroupNum = function() return 0 end
    QuestFrame:Show()
    QuestFrameDetailPanel:Hide()
    QuestFrameDetailPanel:Show()`, 0);
}

/** Runs runtime ticks of `dt` seconds until Accept is enabled; the count, or -1 after `limit`. */
function ticksUntilAccept(dt, limit) {
  for (let tick = 1; tick <= limit; tick += 1) {
    boot.bridge.tick(dt);
    if (acceptEnabled() === 1) return tick;
  }
  return -1;
}

test("the detail panel fades the text in through the runtime's own OnUpdate and Accept always comes back", withClient, () => {
  const texts = [
    "Слово",
    "Много   пробелов\n\nи |nпереводов строк   ",
    "|cffff0000Красный|r текст и |Hitem:6948:0:0:0:0:0:0:0|h[Камень]|h ссылка.",
    "x".repeat(2000),
  ];
  for (const text of texts) {
    openDetail(text);
    assert.equal(lua("return QuestInfoDescriptionText:IsVisible() and QuestInfoFadingFrame:IsVisible()")[0], true);
    assert.equal(acceptEnabled(), 0, "Accept waits while the text types itself in");
    // 70 glyphs a second at 60 FPS: 2000 glyphs take under 30 s, i.e. ~1720 ticks.
    const ticks = ticksUntilAccept(1 / 60, 2000);
    assert.ok(ticks > 0, `Accept enabled for ${JSON.stringify(text.slice(0, 20))}`);
    assert.equal(fading(), undefined);
    // With QUEST_FADING_DISABLE "0" the objectives and rewards (QuestInfoFadingFrame's children) then
    // fade in through UIParent's UIFrameFadeIn over QUESTINFO_FADE_IN (0.5 s): they must arrive.
    for (let tick = 0; tick < 40; tick += 1) boot.bridge.tick(1 / 60);
    assert.equal(lua("return QuestInfoFadingFrame:GetAlpha()")[0], 1, "the rest of the dialog is shown");
  }
  // The canned world has no quest giver behind QUEST_TEMPLATE_DETAIL2 (rewards, group size): only
  // errors of the fade itself count here.
  const fadeErrors = boot.errors.filter((e) => (e.file === "interface/framexml/questinfo.lua" && e.line <= 17)
    || /SetAlphaGradient/.test(String(e.message)));
  assert.deepEqual(fadeErrors.map((e) => e.message), []);
});

test("the greeting, progress and reward panels' fade-in (QUEST_FADING_DISABLE «0») reaches full alpha", withClient, () => {
  // QuestFrame.lua:80-83, :141-144, :204-207 — SetAlpha(0) then UIFrameFadeIn(child, QUESTINFO_FADE_IN).
  for (const child of ["QuestRewardScrollChildFrame", "QuestProgressScrollChildFrame", "QuestGreetingScrollChildFrame"]) {
    lua(`QuestFrame:Show() ${child}:SetAlpha(0) UIFrameFadeIn(${child}, QUESTINFO_FADE_IN)`, 0);
    for (let tick = 0; tick < 40; tick += 1) boot.bridge.tick(1 / 60);
    assert.equal(lua(`return ${child}:GetAlpha()`)[0], 1, child);
  }
  lua("QuestFrame:Hide()", 0);
});

test("a huge elapsed (low FPS, a stall) ends the fade in one tick", withClient, () => {
  openDetail("Долгий текст задания, который печатается сам.");
  assert.equal(ticksUntilAccept(30, 1), 1);
});

test("text replaced mid-fade and the panel hidden mid-fade still end with Accept enabled", withClient, () => {
  openDetail("Первый текст задания.");
  boot.bridge.tick(0.05);
  assert.equal(acceptEnabled(), 0);
  lua(`QuestInfoDescriptionText:SetText("Совсем другой и гораздо более длинный текст задания.")`, 0);
  assert.ok(ticksUntilAccept(1 / 60, 400) > 0, "a new text mid-fade");
  openDetail("Текст, который закроют на середине.");
  boot.bridge.tick(0.05);
  lua("QuestFrame:Hide()", 0);
  boot.bridge.tick(10); // no OnUpdate while hidden
  assert.equal(fading(), 1, "a hidden fading frame runs no OnUpdate (as the client)");
  openDetail("Тот же диалог открыт снова.");
  assert.ok(ticksUntilAccept(1 / 60, 400) > 0, "reopening restarts the fade");
});

test("QUEST_FADING_DISABLE «1» shows the whole text at once: Accept on the first tick", withClient, () => {
  openDetail("Короткий текст задания.", "1");
  assert.equal(ticksUntilAccept(1 / 60, 1), 1);
});

test("the instant-quest-text option reads its CVar: stock default «0», and a write round-trips", withClient, () => {
  assert.equal(lua("return GetCVar('questFadingDisable')")[0], "0");
  assert.equal(lua("return GetCVarDefault('questFadingDisable')")[0], "0");
  // BlizzardOptionsPanel_SetupControl (OptionsPanelTemplates.lua:373-383) sets the check box's uvar to
  // GetCVar(cvar) at PLAYER_ENTERING_WORLD and its SetValue writes both; this vertical boot has no
  // options panels, so the two writes are made as that code makes them.
  lua('QUEST_FADING_DISABLE = GetCVar("questFadingDisable")', 0);
  assert.equal(lua("return QUEST_FADING_DISABLE")[0], "0", "the uvar is the CVar's value, not nil");
  assert.deepEqual(lua('return SetCVar("questFadingDisable", "1"), GetCVar("questFadingDisable")', 2), [true, "1"]);
  lua('QUEST_FADING_DISABLE = GetCVar("questFadingDisable")', 0);
  openDetail("Текст после включения опции.", lua("return QUEST_FADING_DISABLE")[0]);
  assert.equal(ticksUntilAccept(1 / 60, 1), 1, "the option on: the whole text at once");
  lua('SetCVar("questFadingDisable", "0") QUEST_FADING_DISABLE = "0"', 0);
  lua("QuestFrame:Hide()", 0);
});
