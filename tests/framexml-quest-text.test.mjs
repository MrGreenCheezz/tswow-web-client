import assert from "node:assert/strict";
import test from "node:test";

const { frameXmlQuestText } = await import("../dist/code/browser/framexml/FrameXmlQuestText.js");
const { frameXmlQuestGiverRead } = await import("../dist/code/browser/framexml/FrameXmlQuestGiverAdapter.js");

// 3.53: Wow.exe's quest text parser (QuestTextParser.cpp, 0x00579590 / 0x00578f20 / 0x00576cd0),
// which every quest window text goes through before Lua sees it.

const him = { name: "Таурон", className: "Воин", raceName: "Таурен", female: false };
const her = { ...him, name: "Лира", className: "Жрица", raceName: "Ночная эльфийка", female: true };

test("$N, $B, $C and $R read for the player, case-insensitively", () => {
  assert.equal(frameXmlQuestText("Приветствую, $N.$B$BСлышишь зов, $c?", him),
    "Приветствую, Таурон.\n\nСлышишь зов, Воин?");
  assert.equal(frameXmlQuestText("$n, $R $C", him), "Таурон, Таурен Воин");
  // `_strlwr` in the C locale lowers ASCII only: an enUS name is lowered, a ruRU one keeps its capital.
  assert.equal(frameXmlQuestText("a $c and a $r", { ...him, className: "Warrior", raceName: "Tauren" }),
    "a warrior and a tauren");
  assert.equal(frameXmlQuestText("$r", her), "Ночная эльфийка");
});

test("$G picks the reader's form; spaces trimmed, a third part only selects", () => {
  assert.equal(frameXmlQuestText("Спасибо, $gдобрый сэр:миледи;!", him), "Спасибо, добрый сэр!");
  assert.equal(frameXmlQuestText("Спасибо, $gдобрый сэр:миледи;!", her), "Спасибо, миледи!");
  assert.equal(frameXmlQuestText("$g lad : lass ;", him), "lad");
  assert.equal(frameXmlQuestText("$g lad : lass ;", her), "lass");
  assert.equal(frameXmlQuestText("ты $Gготов:готова:C; к бою", her), "ты готова к бою");
  assert.equal(frameXmlQuestText("ты $Gготов:готова:C; к бою", him), "ты готов к бою");
  assert.equal(frameXmlQuestText("$tсэр:мадам;", her), "мадам");
});

test("unknown markers and missing facts stay as written; malformed $G eats one character", () => {
  assert.equal(frameXmlQuestText("цена $x и $", him), "цена $x и $");
  assert.equal(frameXmlQuestText("$N!", { ...him, name: undefined }), "$N!");
  assert.equal(frameXmlQuestText("$5b", him), "\n", "digits after the $ are skipped");
  assert.equal(frameXmlQuestText("$Gabc", him), "bc");
  assert.equal(frameXmlQuestText("без маркеров", him), "без маркеров");
});

test("the giver's pages are parsed and the title is not", () => {
  const world = {
    questList: undefined,
    questDialog: {
      kind: "details", guid: 0x700n, informGuid: 0n, questId: 42,
      title: "Дело для $N", details: "Здравствуй, $N.$BЕсть дело.", objectives: "Принеси $gему:ей; меч.",
      autoLaunched: false, flags: 0, suggestedPlayers: 0, rewards: {
        choices: [], items: [], money: 0, requiredMoney: 0, xpDifficulty: 100,
        honor: 0, displaySpell: 0, spell: 0, titleId: 0, talents: 0, arenaPoints: 0,
      },
    },
  };
  const context = { rewardMetadata: { item: () => undefined }, formatText: (text) => frameXmlQuestText(text, her) };
  const read = (name) => frameXmlQuestGiverRead(name, [], world, context);
  assert.deepEqual(read("GetQuestText"), ["Здравствуй, Лира.\nЕсть дело."]);
  assert.deepEqual(read("GetObjectiveText"), ["Принеси ей меч."]);
  assert.deepEqual(read("GetTitleText"), ["Дело для $N"], "Wow.exe keeps the title as sent");
  world.questDialog = { ...world.questDialog, kind: "reward", text: "Молодец, $c!", choices: [], items: [] };
  assert.deepEqual(read("GetRewardText"), ["Молодец, Жрица!"]);
  world.questDialog = undefined;
  world.questList = { guid: 0x700n, greeting: "Привет, $N.", emoteDelay: 0, emote: 0, quests: [] };
  assert.deepEqual(read("GetGreetingText"), ["Привет, Лира."]);
});
