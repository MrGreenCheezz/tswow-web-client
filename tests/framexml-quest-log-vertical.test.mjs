import assert from "node:assert/strict";
import test, { after } from "node:test";

// Plan item 3.13a/b over the stock QuestLogFrame from the client's MPQs: the log draws the zone
// headers the quest log model builds (FrameXmlQuestLog.ts), a click on a header collapses it through
// CollapseQuestHeader and the QUEST_LOG_UPDATE it fires, the daily counter shows, and the Lua half of
// GetQuestsCompleted fills the table it is given. The canned seam stands in for the world; 3.13 (04.10,
// L6): its quests name their zones, so the canned seam itself builds the client's headers.
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
after(() => chain?.close());

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "quest-log-vertical", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("stock QuestLogFrame: headers drawn, a header click collapses, daily count, GetQuestsCompleted", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  chain ??= await clientArchives(clientDirectory);
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  // The canned player is level 60; zones 12 and 40 are CANNED_QUEST_ZONE_NAMES.
  const quests = [
    { questId: 101, zone: 12, level: 60, title: "Волки" },
    { questId: 102, zone: 40, level: 62, title: "Бандиты", daily: true },
    { questId: 104, zone: 12, level: 58, title: "Кабаны" },
  ];
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, quests);
  const daily = new Array(25).fill(0);
  daily[0] = 102;
  seam.cannedDailyQuests = daily;
  seam.cannedCompletedQuests = [7, 9];
  assert.ok(seam.questLog, "a zone on a canned quest brings the header model");

  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1024, height: 768 }),
  });
  await boot.load();
  const errors = boot.errorCount;
  try {
    lua(boot, "ShowUIPanel(QuestLogFrame) QuestLog_Update()", 0);
    const titles = () => lua(boot, `local out = {}
      for i = 1, 5 do local b = QuestLogScrollFrame.buttons[i]
        out[#out + 1] = b:IsShown() and ((b.isHeader and "#" or "") .. (b:GetText() or "")) or "-" end
      return table.concat(out, "|")`)[0];
    // [Западный Край] Бандиты [Элвиннский лес] Кабаны Волки
    assert.equal(titles(), "#Западный Край|  Бандиты|#Элвиннский лес|  Кабаны|  Волки");
    assert.deepEqual(lua(boot, "return QuestLogScrollFrame.buttons[1]:GetNormalTexture():GetTexture()"),
      ["Interface\\Buttons\\UI-MinusButton-Up"]);
    // The stock header click: QuestLogTitleButton_OnClick → QuestLog_SetSelection → CollapseQuestHeader.
    lua(boot, "QuestLogTitleButton_OnClick(QuestLogScrollFrame.buttons[1], 'LeftButton')", 0);
    assert.equal(titles(), "#Западный Край|#Элвиннский лес|  Кабаны|  Волки|-");
    assert.deepEqual(lua(boot, "return QuestLogScrollFrame.buttons[1]:GetNormalTexture():GetTexture()"),
      ["Interface\\Buttons\\UI-PlusButton-Up"]);
    lua(boot, "QuestLogTitleButton_OnClick(QuestLogScrollFrame.buttons[1], 'LeftButton')", 0);
    assert.equal(titles(), "#Западный Край|  Бандиты|#Элвиннский лес|  Кабаны|  Волки");
    // «(Ежедневное)» on the daily quest's tag and the daily counter (QuestLogFrame.lua:445-465, 520-526).
    assert.match(lua(boot, "return QuestLogScrollFrame.buttons[2].tag:GetText()")[0] ?? "", /\(.+\)/);
    assert.deepEqual(lua(boot, "return QuestLogDailyQuestCount:IsShown() and 1 or 0, GetDailyQuestsCompleted(), GetMaxDailyQuests()", 3),
      [1, 1, 25]);
    assert.deepEqual(lua(boot, "local t = { keep = 1 } local r = GetQuestsCompleted(t) return r == t, t[7], t[9], t.keep", 4),
      [true, true, true, 1]);
    assert.deepEqual(lua(boot, "return GetQuestLink(2)"), ["|cffffff00|Hquest:102:62|h[Бандиты]|h|r"]);
    // The rest of the canned log follows the displayed rows: a header holds no quest.
    assert.deepEqual(lua(boot, "return GetNumQuestLogEntries()", 2), [5, 3]);
    assert.deepEqual(lua(boot, "return select(5, GetQuestLogTitle(1)), select(9, GetQuestLogTitle(4))", 2), [true, 104]);
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close?.();
  }
});
