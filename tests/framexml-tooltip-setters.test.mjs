import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.12a–d: the GameTooltip setters glue/GlueTooltipExtras.ts adds, over a fixture corpus
// (no client needed): each draws the client's rows when the data is there and hides the tooltip when
// it is not; quest:, talent: and glyph: links; the shopping tooltips' SetHyperlinkCompareItem.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

const FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
ShoppingTooltip1 = CreateFrame("GameTooltip", "ShoppingTooltip1", UIParent)
ShoppingTooltip2 = CreateFrame("GameTooltip", "ShoppingTooltip2", UIParent)
SPELL_TIME_REMAINING_MIN = "Осталось: %d |4минута:минуты:минут;"
SPELL_TIME_REMAINING_SEC = "Осталось: %d |4секунда:секунды:секунд;"
TOOLTIP_TALENT_RANK = "Уровень %d/%d"
TOOLTIP_TALENT_NEXT_RANK = "Следующий уровень:"
TOOLTIP_TALENT_PREREQ = "Требуется %1$d |4очко:очка:очков; в таланте \\"%2$s\\""
TOOLTIP_TALENT_TIER_POINTS = "Требуется %1$d |4очко:очка:очков; в талантах категории \\"%2$s\\""
QUEST_TOOLTIP_ACTIVE = "Выполняется"
QUEST_TOOLTIP_REQUIREMENTS = "Требования:"
MAJOR_GLYPH = "Большой символ"
MINOR_GLYPH = "Малый символ"
GLYPH_INACTIVE = "Свободно"
GLYPH_LOCKED = "Заблокировано"
GLYPH_EMPTY_DESC = "Используйте символ."
GLYPH_SLOT_TOOLTIP3 = "Требуется 50-й уровень"
GLYPH_SLOT_REMOVE_TOOLTIP = "<Убрать символ>"
ITEMS_VARIABLE_QUANTITY = "%d |4предмет:предмета:предметов;"
ITEMS_EQUIPPED = "%d |4предмет экипирован:предмета экипировано:предметов экипировано;"
ITEMS_IN_INVENTORY = "%d |4предмет:предмета:предметов; в сумках"
ITEM_SLOTS_IGNORED = "%d |4ячейка пропущена:ячейки пропущены:ячейки пропущены;"
ITEM_MISSING = "%s отсутствует"
HEADSLOT = "Голова"
FEETSLOT = "Ступни"
CURRENTLY_EQUIPPED = "На персонаже"
function GetBuybackItemLink(i) if i == 1 then return "|cffffffff|Hitem:100|h[Секира]|h|r" end end
function GetMerchantItemCostItem(i, c) if i == 2 and c == 1 then return "tex", 3, "|Hitem:200|h[Эмблема]|h" end end
function GetLFGDungeonRewardLink(d, i) if d == 261 and i == 1 then return "|Hitem:100|h[Секира]|h" end end
Totems = {}
function GetTotemInfo(slot) local t = Totems[slot] if t then return true, t[1], t[2], t[3], "icon" end return false, "", 0, 0, "" end
Now = 100
function GetTime() return Now end
Sets = { ["Танк"] = { 0x100001, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0x100010, 0, 0, 0 } }
function GetEquipmentSetLocations(name) return Sets[name] end
function EquipmentManager_UnpackLocation(v) if v == 0x100010 then return true, false, true, 5, 1 end return true, false, false, 1, nil end
Glyphs = { [1] = { true, 1, 58000 }, [3] = { false, 2, nil }, [5] = { true, 2, nil } }
function GetGlyphSocketInfo(socket) local g = Glyphs[socket] if g then return g[1], g[2], g[3] end end
Items = { [300] = "INVTYPE_FINGER", [400] = "INVTYPE_WEAPON", [401] = "INVTYPE_WEAPON", [402] = "INVTYPE_2HWEAPON" }
function GetItemInfo(link)
  local id = tonumber(tostring(link):match("item:(%d+)"))
  if id and Items[id] then return "Предмет", link, 3, 1, 1, "", "", 1, Items[id] end
end
Worn = {}
function GetInventoryItemLink(unit, slot) return Worn[slot] end
function GetQuestLogSpecialItemInfo(i) if i == 4 then return "|Hitem:100|h[Секира]|h", "tex", 0 end end
`;

const ITEMS = new Map([
  [100, { title: "Секира", quality: 4, lines: [{ text: "Двуручное" }] }],
  [200, { title: "Эмблема", quality: 4 }],
  [301, { title: "Кольцо А", quality: 3 }], [302, { title: "Кольцо Б", quality: 3 }],
  [410, { title: "Меч", quality: 3 }], [411, { title: "Кинжал", quality: 3 }],
]);
const SPELLS = new Map([
  [100, { title: "Ярость 1", lines: [{ text: "+1 к ярости.", tone: "description" }] }],
  [101, { title: "Ярость 2", lines: [{ text: "+2 к ярости.", tone: "description" }] }],
  [58000, { title: "Символ огня", lines: [{ text: "Огонь сильнее.", tone: "description" }] }],
  [700, { title: "Награда", titleRight: "Уровень 1", lines: [{ text: "Учит награде.", tone: "description" }] }],
  [900, { title: "Предок", lines: [] }],
]);

async function boot(adapter = {}) {
  const booted = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.lua": FIXTURE,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.lua"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined, containerItem: () => undefined,
      item: (entry) => ITEMS.get(entry), spell: (id) => SPELLS.get(id),
      ...adapter,
    },
  });
  await booted.load();
  const run = (source, results = 0) => {
    const chunk = booted.vm.compileFunction(source, "@tooltip-setters", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return booted.vm.call(chunk, [], results); } finally { booted.vm.release(chunk); }
  };
  const rows = (tooltip = "GameTooltip") => {
    const out = [];
    const count = run(`return ${tooltip}:NumLines()`, 1)[0];
    for (let index = 1; index <= count; index++) {
      const left = booted.bridge.getFrame(`${tooltip}TextLeft${index}`);
      const right = booted.bridge.getFrame(`${tooltip}TextRight${index}`);
      out.push(right?.visible && right.text ? `${left?.text}|${right.text}` : left?.text);
    }
    return out;
  };
  const shown = (tooltip = "GameTooltip") => booted.bridge.getFrame(tooltip)?.visible === true;
  const colorOf = (index, tooltip = "GameTooltip") => {
    const c = booted.bridge.getFrame(`${tooltip}TextLeft${index}`)?.textColor;
    return c ? [c.r, c.g, c.b].map((v) => Math.round(v * 255)) : undefined;
  };
  return { boot: booted, run, rows, shown, colorOf };
}

test("link-shaped setters: buyback, merchant cost item, LFD reward, the quest special item; nothing known hides", async () => {
  const { boot: b, run, rows, shown } = await boot();
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    assert.deepEqual(run(`return GameTooltip:SetBuybackItem(1)`, 1), [undefined], "answers nothing");
    assert.deepEqual(rows(), ["Секира", "Двуручное"]);
    run(`GameTooltip:SetBuybackItem(2)`);
    assert.equal(shown(), false, "an empty buyback slot hides the tooltip");
    run(`GameTooltip:SetMerchantCostItem(2, 1)`);
    assert.deepEqual(rows(), ["Эмблема"]);
    run(`GameTooltip:SetMerchantCostItem(2)`);
    assert.equal(shown(), false);
    run(`GameTooltip:SetLFGDungeonReward(261, 1)`);
    assert.deepEqual(rows(), ["Секира", "Двуручное"]);
    run(`GameTooltip:SetQuestLogSpecialItem(4)`);
    assert.deepEqual(rows(), ["Секира", "Двуручное"]);
    run(`GameTooltip:SetQuestLogSpecialItem(5)`);
    assert.equal(shown(), false);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("SetTotem: the active totem's name and the time left; an empty slot hides", async () => {
  const { boot: b, run, rows, shown, colorOf } = await boot();
  try {
    run(`Totems[1] = { "Тотем элементалей огня", 40, 120 } GameTooltip:SetOwner(Owner) GameTooltip:SetTotem(1)`);
    assert.deepEqual(rows(), ["Тотем элементалей огня", "Осталось: 1 |4минута:минуты:минут;"]);
    assert.deepEqual(colorOf(1), [255, 210, 0], "the name in the client's gold (0x00ad2d2c)");
    run(`GameTooltip:SetTotem(2)`);
    assert.equal(shown(), false);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("SetEquipmentSet: the counts and the missing pieces, in the client's order and colours", async () => {
  const { boot: b, run, rows, shown, colorOf } = await boot();
  try {
    run(`GameTooltip:SetOwner(Owner) GameTooltip:SetEquipmentSet("Танк")`);
    assert.deepEqual(rows(), [
      "Танк|3 |4предмет:предмета:предметов;",
      "1 |4предмет экипирован:предмета экипировано:предметов экипировано;",
      "1 |4предмет:предмета:предметов; в сумках",
      "1 |4ячейка пропущена:ячейки пропущены:ячейки пропущены;",
      "Ступни отсутствует",
    ]);
    assert.deepEqual(colorOf(5), [255, 32, 32]);
    run(`GameTooltip:SetEquipmentSet("Нет такого")`);
    assert.equal(shown(), false);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("SetGlyph: a filled socket, an empty one and a locked one; a glyph: link without the remove hint", async () => {
  const { boot: b, run, rows, colorOf } = await boot({ glyph: (id) => id === 17 ? { spellId: 58000, major: false } : undefined });
  try {
    run(`GameTooltip:SetOwner(Owner) GameTooltip:SetGlyph(1)`);
    assert.deepEqual(rows(), ["Символ огня", "Большой символ", "Огонь сильнее.", "<Убрать символ>"]);
    assert.deepEqual(colorOf(2), [102, 187, 255]);
    run(`GameTooltip:SetGlyph(5)`);
    assert.deepEqual(rows(), ["Свободно", "Малый символ", "Используйте символ."]);
    run(`GameTooltip:SetGlyph(3)`);
    assert.deepEqual(rows(), ["Заблокировано", "Малый символ", "Требуется 50-й уровень"]);
    assert.deepEqual(run(`return GameTooltip:SetHyperlink("|cff66bbff|Hglyph:21:17|h[Символ огня]|h|r")`, 1), [true]);
    assert.deepEqual(rows(), ["Символ огня", "Малый символ", "Огонь сильнее."]);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("SetTalent and talent: links: rank line, requirements, current and next rank", async () => {
  const calls = [];
  const talent = (tab, index, inspect, pet, group) => {
    calls.push([tab, index, inspect, pet, group]);
    if (tab === 1 && index === 2) {
      return { ranks: [100, 101], rank: 1, requirements: [] };
    }
    if (tab === 1 && index === 3) {
      return { ranks: [100, 101], rank: 0, requirements: [{ kind: "tier", points: 5, tabName: "Оружие" }, { kind: "talent", rank: 2, name: "Предок" }] };
    }
    return undefined;
  };
  const { boot: b, run, rows, shown, colorOf } = await boot({
    talent, talentById: (id, rank) => id === 55 ? { ranks: [100, 101], rank: rank ?? 0 } : undefined,
  });
  try {
    run(`GameTooltip:SetOwner(Owner) GameTooltip:SetTalent(1, 2, nil, nil, 2)`);
    assert.deepEqual(calls.at(-1), [1, 2, false, false, 2]);
    assert.deepEqual(rows(), ["Ярость 1", "Уровень 1/2", "+1 к ярости.", " ", "Следующий уровень:", "+2 к ярости."]);
    assert.deepEqual(colorOf(3), [255, 210, 0]);
    run(`GameTooltip:SetTalent(1, 3)`);
    assert.deepEqual(rows(), ["Ярость 1", "Уровень 0/2",
      "Требуется 5 |4очко:очка:очков; в талантах категории \"Оружие\"",
      "Требуется 2 |4очко:очка:очков; в таланте \"Предок\"", "+1 к ярости."]);
    assert.deepEqual(colorOf(3), [255, 32, 32]);
    run(`GameTooltip:SetTalent(9, 9)`);
    assert.equal(shown(), false);
    run(`GameTooltip:SetHyperlink("|cff4e96f7|Htalent:55:1|h[Ярость]|h|r")`);
    assert.deepEqual(rows().slice(0, 2), ["Ярость 2", "Уровень 2/2"], "the link's 0-based rank index 1 is rank 2");
    run(`GameTooltip:SetHyperlink("talent:55:-1")`);
    assert.deepEqual(rows().slice(0, 2), ["Ярость 1", "Уровень 0/2"]);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("quest: links and the reward spells", async () => {
  const { boot: b, run, rows, shown, colorOf } = await boot({
    quest: (id) => id === 123 ? { title: "Волки", objectivesText: "Убейте волков.", active: true, requirements: ["Волк: 2/10"] } : undefined,
    questLogRewardSpell: () => 700,
    questRewardSpell: () => undefined,
  });
  try {
    run(`GameTooltip:SetOwner(Owner) GameTooltip:SetHyperlink("|cffffff00|Hquest:123:10|h[Волки]|h|r")`);
    assert.deepEqual(rows(), ["Волки", "Выполняется", " ", "Убейте волков.", " ", "Требования:", " - Волк: 2/10"]);
    assert.deepEqual(colorOf(2), [0, 255, 0]);
    run(`GameTooltip:SetHyperlink("quest:999:1")`);
    assert.equal(shown(), false);
    run(`GameTooltip:SetQuestLogRewardSpell()`);
    assert.equal(rows()[0], "Награда|Уровень 1");
    assert.deepEqual(run(`return GameTooltip:GetSpell()`, 3), ["Награда", "Уровень 1", 700]);
    run(`GameTooltip:SetQuestRewardSpell()`);
    assert.equal(shown(), false);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("SetHyperlinkCompareItem: rings in slot order, weapons by the hand rules, nothing to compare hides", async () => {
  const { boot: b, run, rows, shown } = await boot();
  try {
    run(`Worn[11] = "|Hitem:301|h[А]|h" Worn[12] = "|Hitem:302|h[Б]|h"`);
    assert.deepEqual(run(`return ShoppingTooltip1:SetHyperlinkCompareItem("|Hitem:300|h[x]|h", 1, false, GameTooltip)`, 1), [1]);
    assert.deepEqual(rows("ShoppingTooltip1"), ["На персонаже", "Кольцо А"]);
    assert.deepEqual(run(`return ShoppingTooltip2:SetHyperlinkCompareItem("item:300", 2)`, 1), [1]);
    assert.deepEqual(rows("ShoppingTooltip2"), ["На персонаже", "Кольцо Б"]);
    run(`Worn[11] = nil`);
    assert.deepEqual(run(`return ShoppingTooltip1:SetHyperlinkCompareItem("item:300", 1)`, 1), [1]);
    assert.deepEqual(rows("ShoppingTooltip1"), ["На персонаже", "Кольцо Б"], "the first *equipped* ring");
    assert.deepEqual(run(`return ShoppingTooltip2:SetHyperlinkCompareItem("item:300", 2)`, 1), [undefined]);
    assert.equal(shown("ShoppingTooltip2"), false);
    // Two different weapons: the first shopping tooltip is the off hand, the second the main hand.
    run(`Worn[16] = "|Hitem:410|h[М]|h" Worn[17] = "|Hitem:411|h[К]|h"`);
    run(`ShoppingTooltip1:SetHyperlinkCompareItem("item:400", 1)`);
    assert.deepEqual(rows("ShoppingTooltip1"), ["На персонаже", "Кинжал"]);
    run(`ShoppingTooltip2:SetHyperlinkCompareItem("item:400", 2)`);
    assert.deepEqual(rows("ShoppingTooltip2"), ["На персонаже", "Меч"]);
    // Review: two copies of one weapon are still two items (0x00631850 compares the objects, not links).
    run(`Worn[17] = Worn[16]`);
    assert.deepEqual(run(`return ShoppingTooltip2:SetHyperlinkCompareItem("item:400", 2)`, 1), [1], "identical pair: both tooltips");
    assert.deepEqual(rows("ShoppingTooltip2"), ["На персонаже", "Меч"]);
    run(`Worn[17] = nil`);
    assert.deepEqual(run(`return ShoppingTooltip2:SetHyperlinkCompareItem("item:402", 2)`, 1), [undefined], "one weapon: no second");
    assert.deepEqual(run(`return ShoppingTooltip1:SetHyperlinkCompareItem("item:402", 1)`, 1), [1]);
    assert.deepEqual(rows("ShoppingTooltip1"), ["На персонаже", "Меч"]);
    assert.deepEqual(run(`return ShoppingTooltip1:SetHyperlinkCompareItem("item:999", 1)`, 1), [undefined]);
    assert.deepEqual(run(`return ShoppingTooltip1:SetHyperlinkCompareItem("item:300", 3)`, 1), [undefined],
      "the third (merchant) shopping tooltip is not drawn");
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("the live adapter: talent ranks and unmet requirements, quests, reward spells, glyph rows", async () => {
  const { frameXmlTooltipExtrasAdapter } = await import("../dist/code/browser/framexml/FrameXmlTooltipExtrasAdapter.js");
  const cell = (index, id, tier, rank, prerequisites = []) => ({ index, id, tier, rank, prerequisites });
  const snapshot = {
    activeTalentGroup: 1,
    groups: [{ group: 1, tabs: [{ id: 161, name: "Оружие", pointsSpent: 3, talents: [
      cell(1, 10, 1, 2), cell(2, 11, 2, 0, [{ talentId: 10, requiredRank: 3, meetsPrereq: false }]),
    ] }] }],
  };
  const seam = {
    talentSnapshot: (pet) => pet ? undefined : snapshot,
    questLog: { indexOfQuest: (id) => id === 5 ? 2 : undefined, entryAt: (index) => index === 2 ? { questId: 5 } : undefined },
    questLogSelection: () => 2,
    questLogLeaderBoardCount: () => 1,
    questLogLeaderBoard: () => ["Волк: 1/3", "monster", false],
  };
  const world = {
    questTemplates: new Map([
      [5, { title: "Волки", objectivesText: "Убейте.", rewardDisplaySpell: 700, objectives: [] }],
      [6, { title: "Кабаны", objectivesText: "Тоже.", rewardDisplaySpell: 0, objectives: [{ text: "Кабан" }, { text: "" }] }],
    ]),
    questDialog: { kind: "reward", rewards: { displaySpell: 701 } },
    asked: [],
    queryQuest(id) { this.asked.push(id); },
  };
  const talentData = {
    talentsIn: (tab) => tab === 161 ? [{ id: 10, ranks: [100, 101, 102] }, { id: 11, ranks: [200] }] : [],
    glyph: (id) => id === 17 ? { spellId: 58000, flags: 1 } : id === 18 ? { spellId: 58001, flags: 0 } : undefined,
  };
  const adapter = frameXmlTooltipExtrasAdapter(seam, () => ({ world, talentData }),
    (id) => id === 100 ? { title: "Двойное оружие" } : undefined);
  assert.deepEqual(adapter.talent(1, 1, false, false, undefined), { ranks: [100, 101, 102], rank: 2, requirements: [] });
  assert.deepEqual(adapter.talent(1, 2, false, false, 1), {
    ranks: [200], rank: 0,
    requirements: [{ kind: "tier", points: 5, tabName: "Оружие" }, { kind: "talent", rank: 3, name: "Двойное оружие" }],
  });
  assert.equal(adapter.talent(1, 2, true, false, 1), undefined, "inspect has no snapshot");
  assert.equal(adapter.talent(1, 9, false, false, 1), undefined);
  assert.deepEqual(adapter.talentById(11, 1), { ranks: [200], rank: 1, requirements: [] }, "a link lists no requirements");
  assert.deepEqual(adapter.quest(5), { title: "Волки", objectivesText: "Убейте.", active: true, requirements: ["Волк: 1/3"] });
  assert.deepEqual(adapter.quest(6), { title: "Кабаны", objectivesText: "Тоже.", active: false, requirements: ["Кабан"] });
  assert.equal(adapter.quest(7), undefined);
  assert.deepEqual(world.asked, [7], "an uncached quest is asked for");
  assert.equal(adapter.questLogRewardSpell(), 700);
  assert.equal(adapter.questRewardSpell(), 701);
  world.questDialog = { kind: "list" };
  assert.equal(adapter.questRewardSpell(), undefined);
  assert.deepEqual(adapter.glyph(17), { spellId: 58000, major: false });
  assert.deepEqual(adapter.glyph(18), { spellId: 58001, major: true });
});
