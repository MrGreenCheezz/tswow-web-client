import assert from "node:assert/strict";
import test from "node:test";

const {
  CannedWorldSeam,
  CANNED_REWARD_QUEST,
  CANNED_REQUIRED_MONEY_QUEST,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

test("Canned quest reward seam exposes exact item/spell/money contracts", () => {
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.GetNumQuestLogRewards, "function");
  assert.equal(typeof FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardInfo, "function");
  assert.equal(CANNED_REWARD_QUEST.rewardDisplaySpell?.spellId, 133);
  assert.equal(CANNED_REWARD_QUEST.rewardSpellCast, 689);
  assert.notEqual(CANNED_REWARD_QUEST.rewardDisplaySpell?.spellId, CANNED_REWARD_QUEST.rewardSpellCast);
  const seam = new CannedWorldSeam([], undefined, undefined, undefined, [
    CANNED_REWARD_QUEST,
    CANNED_REQUIRED_MONEY_QUEST,
  ]);
  seam.selectQuestLogEntry(1);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNumQuestLogRewards(seam, []), [1]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetNumQuestLogChoices(seam, []), [2]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardInfo(seam, [1]), [
    "Сильное зелье маны", "Interface\\Icons\\INV_Potion_54", 2, 1, true,
  ]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogChoiceInfo(seam, [1]), [
    "Льняной материал", "Interface\\Icons\\INV_Fabric_Linen_01", 5, 0, true,
  ]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogChoiceInfo(seam, [2]), [
    "Зелёный краситель", "Interface\\Icons\\INV_Potion_21", 1, 1, true,
  ]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardSpell(seam, []), [
    "Interface\\Icons\\Spell_Fire_FlameBolt", "Огненный шар", false, false,
  ]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardMoney(seam, []), [2345]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardHonor(seam, []), [12]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardArenaPoints(seam, []), [0]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardTalents(seam, []), [2]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardXP(seam, []), [0]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardTitle(seam, []), []);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRequiredMoney(seam, []), [0]);

  seam.selectQuestLogEntry(2);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRewardMoney(seam, []), [0]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetQuestLogRequiredMoney(seam, []), [125]);
});

test("Live quest leaderboard reads sparse progress from the original server slot", () => {
  const selfGuid = 0x10n;
  const base = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const self = { guid: selfGuid, typeId: 4, fields: new Map([
    [base, 9901],
    [base + 3, 7], // objectives 2 and 3; the third slot has seven kills
  ]) };
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self]]) },
    questTemplates: new Map([[9901, {
      questId: 9901,
      objectives: [{ slot: 2, entry: 299, count: 10, gameObject: false, itemDrop: 0, text: "Третий слот" }],
      itemObjectives: [],
    }]]),
  };
  const seam = new LiveWorldSeam({ world: () => world, store: () => undefined });
  // Log line 1 is the quest's zone header (FrameXmlQuestLog.ts), the quest is line 2.
  assert.deepEqual(seam.questLogLeaderBoard(1, 2), ["Третий слот: 7/10", "monster", false]);
});

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}

test("Live reward metadata is prefetched outside getters and repaints once when it arrives", () => {
  const selfGuid = 0x10n;
  const questOffset = UPDATE_FIELDS.PLAYER_QUEST_LOG_1_1.offset;
  const fields = new Map([[questOffset, 9901], [questOffset + 1, 0]]);
  const self = { guid: selfGuid, typeId: 4, fields };
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self]]) },
    questTemplates: new Map([[
      9901,
      {
        questId: 9901,
        level: 60,
        minLevel: 0,
        sortId: 0,
        type: 0,
        suggestedPlayers: 0,
        nextQuest: 0,
        rewardMoney: 2345,
        requiredMoney: 0,
        rewardBonusMoney: 0,
        rewardDisplaySpell: 133,
        rewardSpellCast: 689,
        rewardSpell: 689,
        rewardHonor: 0,
        startItem: 0,
        flags: 0,
        rewardTitleId: 0,
        requiredPlayerKills: 0,
        rewardTalents: 0,
        rewardItems: [{ itemId: 13446, count: 2 }],
        rewardChoiceItems: [],
        poi: { map: 0, x: 0, y: 0, priority: 0 },
        title: "Награда",
        objectivesText: "",
        details: "",
        areaDescription: "",
        completedText: "",
        objectives: [],
        itemObjectives: [],
      },
    ]]),
    itemTemplates: new Map(),
    knownSpells: [],
    actionButtons: [],
    casts: new Map(),
    events: new FakeEvents(),
    cooldownRemaining: () => 0,
  };
  let itemReady = false;
  let spellReady = false;
  let finishPrefetch;
  const fired = [];
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: (id) => spellReady && id === 133
      ? { id, name: "Огненный шар", rank: "Уровень 1", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt" }
      : undefined,
    itemInfo: (id) => itemReady && id === 13446
      ? { name: "Сильное зелье маны", texture: "Interface\\Icons\\INV_Potion_54", quality: 1, isUsable: true }
      : undefined,
    prefetchQuestMetadata: (items, spells, onChanged) => {
      assert.deepEqual(items, [13446]);
      assert.deepEqual(spells, [133]);
      finishPrefetch = onChanged;
    },
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
  });
  const pump = { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => 10 };
  seam.attach(pump);
  // Log line 1 is the quest's zone header (FrameXmlQuestLog.ts), the quest is line 2.
  seam.selectQuestLogEntry(2);
  fired.length = 0;
  assert.equal(seam.questLogRewardInfo(1), undefined, "unresolved item metadata remains nil");
  assert.equal(seam.questLogRewardSpell(), undefined, "unresolved spell metadata remains nil");
  itemReady = true;
  spellReady = true;
  finishPrefetch();
  assert.deepEqual(fired, [["QUEST_LOG_UPDATE"]], "metadata arrival repaints the quest log once");
  finishPrefetch();
  assert.deepEqual(fired, [["QUEST_LOG_UPDATE"]], "duplicate cache callbacks stay deduplicated");
  assert.deepEqual(seam.questLogRewardInfo(1), [
    "Сильное зелье маны", "Interface\\Icons\\INV_Potion_54", 2, 1, true,
  ]);
  assert.deepEqual(seam.questLogRewardSpell(), [
    "Interface\\Icons\\Spell_Fire_FlameBolt", "Огненный шар", undefined, false,
  ]);
  seam.detach();
});

test("MPQ QuestInfo renders cached fixed/choice items, spell and money rewards", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const decoder = new TextDecoder("utf-8");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const seam = new CannedWorldSeam([], undefined, undefined, undefined, [
    CANNED_REWARD_QUEST,
    CANNED_REQUIRED_MONEY_QUEST,
  ]);
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
    exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    const inventory = await boot.load();
    assert.equal(inventory.lua.failed, 0, "stock QuestInfo Lua executes with reward seam answers");
    const root = boot.bridge.getFrame("QuestLogFrame");
    assert.ok(root);
    assert.equal(boot.bridge.Show(root), true);
    const row = boot.bridge.getFrame("QuestLogScrollFrameButton1");
    assert.ok(row);
    assert.equal(boot.bridge.Click(row, "LeftButton", false), true);
    assert.equal(seam.questLogSelection(), 1);

    const choiceOne = boot.bridge.getFrame("QuestInfoItem1Name");
    const choiceTwo = boot.bridge.getFrame("QuestInfoItem2Name");
    const spell = boot.bridge.getFrame("QuestInfoItem3Name");
    const fixed = boot.bridge.getFrame("QuestInfoItem4Name");
    assert.equal(choiceOne?.text, "Льняной материал");
    assert.equal(choiceTwo?.text, "Зелёный краситель");
    assert.equal(spell?.text, "Огненный шар");
    assert.equal(fixed?.text, "Сильное зелье маны");
    assert.equal(boot.bridge.getFrame("QuestInfoItem4IconTexture")?.texture, "Interface\\Icons\\INV_Potion_54");
    assert.equal(boot.bridge.getFrame("QuestInfoItem3IconTexture")?.texture, "Interface\\Icons\\Spell_Fire_FlameBolt");
    assert.equal(boot.bridge.getFrame("QuestInfoItem4Count")?.text, "2", "fixed reward count reaches SetItemButtonCount");
    assert.equal(boot.bridge.getFrame("QuestInfoHonorFrame")?.visible, true);
    assert.equal(boot.bridge.getFrame("QuestInfoTalentFrame")?.visible, true);
    assert.equal(boot.bridge.getFrame("QuestInfoMoneyFrame")?.visible, true);

    const secondRow = boot.bridge.getFrame("QuestLogScrollFrameButton2");
    assert.ok(secondRow);
    assert.equal(boot.bridge.Click(secondRow, "LeftButton", false), true);
    assert.equal(seam.questLogSelection(), 2);
    assert.equal(boot.bridge.getFrame("QuestInfoRequiredMoneyFrame")?.visible, true);
    assert.equal(boot.bridge.getFrame("QuestInfoRewardsFrame")?.visible, false);
  } finally {
    boot.close();
    chain.close();
  }
});
