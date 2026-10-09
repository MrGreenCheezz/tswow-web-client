import assert from "node:assert/strict";
import test from "node:test";

// Lane L4, 04.10 — Wow.exe 3.3.5a 12340 read 2026-10-04 (.runtime/re-2026-10-04/l4-tooltips/):
// * 3.12: the shopping tooltips' stat difference against the anchor and the merchant's third tooltip
//   (0x00631850), TOOLTIP_TALENT_LEARN (0x00622800), the inspected player's talents (0x0062f740 with
//   the inspect flag), requirements only for an unlearned talent (0x00626e20), `$N` in a quest link's
//   objectives (0x00622960 → 0x00579590);
// * 2.10: no sell price under the refund line, nor on the draw that asked for the record (0x006277f0);
// * 5.22: the ITEM_DURATION_* line of a timed item (0x006277f0 → 0x0061a9e0, 0x007070b0).
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { frameXmlTooltipExtrasAdapter } = await import("../dist/code/browser/framexml/FrameXmlTooltipExtrasAdapter.js");
const { FrameXmlRefundModel } = await import("../dist/code/browser/framexml/FrameXmlRefund.js");
const { tooltipContentWithoutPrice } = await import("../dist/code/browser/glue/GlueTooltipPrice.js");
const { itemDurationParts, itemDurationSeconds } = await import("../dist/code/browser/ui/ItemDurationText.js");
const { itemTooltipContent } = await import("../dist/code/browser/ui/ItemTooltip.js");
const { vendorRefundCostText, vendorRefundRows, vendorRefundTimeText } = await import("../dist/code/browser/ui/VendorRefundRows.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
ShoppingTooltip1 = CreateFrame("GameTooltip", "ShoppingTooltip1", UIParent)
ShoppingTooltip3 = CreateFrame("GameTooltip", "ShoppingTooltip3", UIParent)
CURRENTLY_EQUIPPED = "На персонаже"
ITEM_DELTA_DESCRIPTION = "Если вы замените этот предмет:"
ITEM_MOD_STAMINA_SHORT = "к выносливости"
TOOLTIP_TALENT_RANK = "Уровень %d/%d"
TOOLTIP_TALENT_NEXT_RANK = "Следующий уровень:"
TOOLTIP_TALENT_LEARN = "Нажмите, чтобы изучить."
REFUND_TIME_REMAINING = "Можно вернуть: %s"
INT_SPELL_DURATION_MIN = "%d мин."
Items = { [500] = "INVTYPE_HEAD", [501] = "INVTYPE_HEAD", [600] = "INVTYPE_HEAD" }
function GetItemInfo(link)
  local id = tonumber(tostring(link):match("item:(%d+)"))
  if id and Items[id] then return "Предмет", link, 3, 1, 1, "", "", 1, Items[id] end
end
Worn = { [1] = "|Hitem:501|h[Шлем]|h" }
function GetInventoryItemLink(unit, slot) return Worn[slot] end
function GetContainerItemLink(bag, slot) return "|Hitem:500|h[Новый шлем]|h" end
function GetContainerItemCooldown() return 0, 0, 0 end
Money = nil
GameTooltip:SetScript("OnTooltipAddMoney", function(self, cost) Money = cost end)
`;

const STAT = (stamina) => ({
  found: true, scalingStatValue: 0, stats: [{ type: 7, value: stamina }], resistances: [0, 0, 0, 0, 0, 0, 0], block: 0,
  damage: [{ min: 0, max: 0 }, { min: 0, max: 0 }], delay: 0, sockets: [{ color: 0 }, { color: 0 }, { color: 0 }],
});
const ITEMS = new Map([
  [500, { title: "Новый шлем", quality: 3, lines: [{ text: "Голова" }, { text: "Цена продажи: 1з", money: { copper: 10000, label: "Цена продажи:" } }] }],
  [501, { title: "Шлем", quality: 3, lines: [{ text: "Голова" }, { text: "Цена продажи: 5м", money: { copper: 5, label: "Цена продажи:" } }] }],
  [600, { title: "Наследный шлем", quality: 7, lines: [{ text: "Голова" }, { text: "Цена продажи: 5м", money: { copper: 5, label: "Цена продажи:" } }] }],
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
      inventoryItem: () => undefined,
      containerItem: () => ITEMS.get(500),
      item: (entry) => ITEMS.get(entry),
      spell: () => undefined,
      ...adapter,
    },
  });
  await booted.load();
  const run = (source, results = 0) => {
    const chunk = booted.vm.compileFunction(source, "@tooltip-l4", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return booted.vm.call(chunk, [], results); } finally { booted.vm.release(chunk); }
  };
  const rows = (tooltip = "GameTooltip") => {
    const out = [];
    const count = run(`return ${tooltip}:NumLines()`, 1)[0];
    for (let index = 1; index <= count; index++) out.push(booted.bridge.getFrame(`${tooltip}TextLeft${index}`)?.text);
    return out;
  };
  return { boot: booted, run, rows };
}

test("3.12: the shopping tooltip adds the stat difference against the anchor's item", async () => {
  const stats = new Map([[500, STAT(30)], [501, STAT(42)], [600, { ...STAT(0), scalingStatValue: 1 }]]);
  const { boot: b, run, rows } = await boot({ itemStats: (entry) => stats.get(entry) });
  try {
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetBagItem(0, 1)`);
    assert.deepEqual(run(`return ShoppingTooltip1:SetHyperlinkCompareItem("item:500", 1, nil, GameTooltip)`, 1), [1]);
    assert.deepEqual(rows("ShoppingTooltip1"), ["На персонаже", "Шлем", "Голова", " ", "Если вы замените этот предмет:",
      "|cffff2020-12|r к выносливости"], "no sell price: ShoppingTooltipTemplate has no OnTooltipAddMoney");
    // Without the anchor (or with a frame that is not a GameTooltip): the equipped item alone.
    run(`ShoppingTooltip1:SetHyperlinkCompareItem("item:500", 1)`);
    assert.deepEqual(rows("ShoppingTooltip1"), ["На персонаже", "Шлем", "Голова"]);
    run(`ShoppingTooltip1:SetHyperlinkCompareItem("item:500", 1, nil, Owner)`);
    assert.deepEqual(rows("ShoppingTooltip1"), ["На персонаже", "Шлем", "Голова"]);
    // The equipped record not cached: no difference (0x00631590 answers 0).
    stats.delete(501);
    run(`ShoppingTooltip1:SetHyperlinkCompareItem("item:500", 1, nil, GameTooltip)`);
    assert.deepEqual(rows("ShoppingTooltip1"), ["На персонаже", "Шлем", "Голова"]);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("3.12: the third shopping tooltip — a scaling item at an open merchant, without shift", async () => {
  const stats = new Map([[500, STAT(30)], [600, { ...STAT(0), scalingStatValue: 1 }]]);
  let merchant = true;
  const { boot: b, run, rows } = await boot({ itemStats: (entry) => stats.get(entry), merchantOpen: () => merchant });
  try {
    assert.deepEqual(run(`return ShoppingTooltip3:SetHyperlinkCompareItem("|Hitem:600|h[x]|h", 3, nil, GameTooltip)`, 1), [1]);
    assert.deepEqual(rows("ShoppingTooltip3"), ["Наследный шлем", "Голова"], "the item itself, no header, no difference");
    assert.deepEqual(run(`return ShoppingTooltip3:SetHyperlinkCompareItem("item:600", 3, 1, GameTooltip)`, 1), [undefined], "shift");
    assert.deepEqual(run(`return ShoppingTooltip3:SetHyperlinkCompareItem("item:500", 3)`, 1), [undefined], "no ScalingStatValue");
    merchant = false;
    assert.deepEqual(run(`return ShoppingTooltip3:SetHyperlinkCompareItem("item:600", 3)`, 1), [undefined], "no merchant");
    assert.deepEqual(run(`return ShoppingTooltip3:SetHyperlinkCompareItem("item:600", 4)`, 1), [undefined], "no fourth");
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("3.12: TOOLTIP_TALENT_LEARN closes a learnable talent's tooltip, green", async () => {
  const { boot: b, run, rows } = await boot({
    talent: (tab, index) => tab === 1 ? { ranks: [100, 101], rank: index - 1, learnable: index === 1 } : undefined,
    spell: (id) => ({ title: `Ярость ${id - 99}`, lines: [{ text: "Описание.", tone: "description" }] }),
  });
  try {
    run(`GameTooltip:SetOwner(Owner) GameTooltip:SetTalent(1, 1)`);
    assert.deepEqual(rows(), ["Ярость 1", "Уровень 0/2", "Описание.", "Нажмите, чтобы изучить."]);
    const color = b.bridge.getFrame("GameTooltipTextLeft4")?.textColor;
    assert.deepEqual([color.r, color.g, color.b], [0, 1, 0]);
    run(`GameTooltip:SetTalent(1, 2)`);
    assert.equal(rows().at(-1), "Описание.", "not learnable: no hint");
    run(`GameTooltip:SetTalent(1, 1, nil, nil, nil, true)`);
    assert.equal(rows().at(-1), "Описание.", "isPreview: 0x00622800 takes the preview branch, no TOOLTIP_TALENT_LEARN");
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

const cell = (index, id, tier, rank, prerequisites = []) => ({ index, id, tier, rank, prerequisites });
const talentData = {
  talentsIn: (tab) => tab === 161 ? [{ id: 10, ranks: [100, 101, 102] }, { id: 11, ranks: [200] }, { id: 12, ranks: [300, 301] }] : [],
  glyph: () => undefined,
};

test("3.12: the adapter — inspected trees, requirements only unlearned, the learn conditions", () => {
  const snapshot = (pointsSpent, unspentPoints, rankOf11 = 0) => ({
    activeTalentGroup: 1, unspentPoints,
    groups: [
      { group: 1, tabs: [{ id: 161, name: "Оружие", pointsSpent, talents: [
        cell(1, 10, 1, 1), cell(2, 11, 2, rankOf11, [{ talentId: 10, requiredRank: 3, meetsPrereq: rankOf11 > 0 }]),
        cell(3, 12, 3, 1, [{ talentId: 10, requiredRank: 3, meetsPrereq: false }]),
      ] }] },
      { group: 2, tabs: [{ id: 161, name: "Оружие", pointsSpent: 0, talents: [cell(1, 10, 1, 0)] }] },
    ],
  });
  let own = snapshot(3, 5);
  let inspected = snapshot(9, 0, 1);
  const seam = {
    talentSnapshot: (pet) => pet ? undefined : own,
    inspect: { talentSnapshot: () => inspected },
  };
  const adapter = frameXmlTooltipExtrasAdapter(seam, () => ({ talentData }),
    (id) => id === 100 ? { title: "Двойное оружие" } : undefined);
  assert.deepEqual(adapter.talent(1, 1, false, false, undefined), { ranks: [100, 101, 102], rank: 1, requirements: [], learnable: true },
    "own active group, free points, below the last rank");
  assert.deepEqual(adapter.talent(1, 2, false, false, undefined), {
    ranks: [200], rank: 0, requirements: [{ kind: "tier", points: 5, tabName: "Оружие" }, { kind: "talent", rank: 3, name: "Двойное оружие" }],
  }, "unmet requirements: no hint");
  assert.equal(adapter.talent(1, 1, false, false, 2)?.learnable, undefined, "the other group is not the active one");
  own = snapshot(3, 0);
  assert.equal(adapter.talent(1, 1, false, false, undefined)?.learnable, undefined, "no free points");
  // The inspected trees: its ranks, its own (met) requirements, never the hint.
  assert.deepEqual(adapter.talent(1, 2, true, false, undefined), { ranks: [200], rank: 1, requirements: [] });
  inspected = snapshot(2, 4, 0);
  assert.deepEqual(adapter.talent(1, 2, true, false, undefined)?.requirements,
    [{ kind: "tier", points: 5, tabName: "Оружие" }, { kind: "talent", rank: 3, name: "Двойное оружие" }],
    "the inspected player's unmet ones (0x006224f0 on the inspected rank source)");
  assert.equal(adapter.talent(1, 2, true, false, undefined)?.learnable, undefined);
  inspected = undefined;
  assert.equal(adapter.talent(1, 1, true, false, undefined), undefined, "no inspection");
  // A learned rank (1 of 2) lists no requirement even where the snapshot reads one unmet: 0x00626e20
  // calls 0x006224f0 only for a talent with no current rank.
  own = snapshot(0, 5);
  assert.deepEqual(adapter.talent(1, 3, false, false, undefined), { ranks: [300, 301], rank: 1, requirements: [], learnable: true });
});

test("3.12: a quest link's objectives text is written for the player ($N, $C, $R, $G…;)", () => {
  const seam = {
    talentSnapshot: () => undefined,
    questLog: { indexOfQuest: () => undefined },
    unitName: (unit) => unit === "player" ? "Аэлинда" : undefined,
    unitClass: () => ["Жрица", "PRIEST"],
    unitRace: () => ["Эльфийка крови", "BloodElf"],
    unitSex: () => 3,
  };
  const world = {
    questTemplates: new Map([[5, { title: "Зов", objectivesText: "Иди, $N, $gмой брат:моя сестра;, |3-1($c).", rewardDisplaySpell: 0, objectives: [] }],
      [6, { title: "Без меток", objectivesText: "Просто текст.", rewardDisplaySpell: 0, objectives: [] }]]),
    state: { selfGuid: 0x10n },
    names: { declined: () => undefined },
  };
  const adapter = frameXmlTooltipExtrasAdapter(seam, () => ({ world, talentData }), () => undefined);
  assert.equal(adapter.quest(5).objectivesText, "Иди, Аэлинда, моя сестра, Жрица.");
  assert.equal(adapter.quest(6).objectivesText, "Просто текст.");
});

test("3.12: the adapter's item records come from the cache only; the merchant is the open vendor", () => {
  const world = { questTemplates: new Map(), itemTemplates: new Map([[7, { found: true, scalingStatValue: 3 }], [8, { found: false }]]), vendor: undefined };
  const adapter = frameXmlTooltipExtrasAdapter({ talentSnapshot: () => undefined }, () => ({ world }), () => undefined);
  assert.equal(adapter.itemStats(7)?.scalingStatValue, 3);
  assert.equal(adapter.itemStats(8), undefined, "a missing record");
  assert.equal(adapter.itemStats(9), undefined);
  assert.equal(adapter.merchantOpen(), false);
  world.vendor = { guid: 1n, items: [] };
  assert.equal(adapter.merchantOpen(), true);
});

test("2.10: the refund line or this draw's request leaves the sell price out", async () => {
  let refund;
  const { boot: b, run, rows } = await boot({ containerItemRefundSeconds: () => refund });
  try {
    run(`Money = nil GameTooltip:SetOwner(Owner) GameTooltip:SetBagItem(0, 1)`);
    assert.equal(b.vm.getGlobal("Money"), 10000, "no record: the price is written (OnTooltipAddMoney)");
    refund = 600;
    run(`Money = nil GameTooltip:SetOwner(Owner) GameTooltip:SetBagItem(0, 1)`);
    assert.equal(b.vm.getGlobal("Money"), undefined, "under the refund line: no price");
    assert.deepEqual(rows(), ["Новый шлем", "Голова", " ", "Можно вернуть: 10 мин."]);
    refund = 0;
    run(`Money = nil GameTooltip:SetOwner(Owner) GameTooltip:SetBagItem(0, 1)`);
    assert.equal(b.vm.getGlobal("Money"), undefined, "the draw that asked: no price, no line");
    assert.deepEqual(rows(), ["Новый шлем", "Голова"]);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

test("2.10: tooltipSeconds answers 0 only when the request went out with this call; the price filter keeps the rest", () => {
  const info = new Map();
  let sendNow = true;
  const model = new FrameXmlRefundModel({
    item: () => ({ guid: 5n, item: { guid: 5n, typeId: 1, fields: new Map() } }),
    info: (guid) => info.get(guid), played: () => 1000, lootGuid: () => undefined,
    itemTexture: () => undefined, itemLink: () => undefined, refund: () => undefined,
    ask: () => sendNow,
  });
  assert.equal(model.tooltipSeconds(0, 1, false), 0);
  sendNow = false;
  assert.equal(model.tooltipSeconds(0, 1, false), undefined, "asked before: the price shows again");
  info.set(5n, { money: 0, honor: 0, arena: 0, items: [], purchasedAtPlayed: 900 });
  assert.equal(model.tooltipSeconds(0, 1, false), 7100);
  const content = { title: "Шлем", lines: ["a", { text: "Цена", money: { copper: 5, label: "Цена" } }, { text: "b" }] };
  assert.deepEqual(tooltipContentWithoutPrice(content).lines, ["a", { text: "b" }]);
  const plain = { title: "x", lines: ["a"] };
  assert.equal(tooltipContentWithoutPrice(plain), plain, "nothing to drop: the same content");
  let redraw;
  const late = { title: "x", lines: [], refresh: { watch: (callback) => { redraw = callback; return () => {}; } } };
  let drawn;
  tooltipContentWithoutPrice(late).refresh.watch((next) => { drawn = next; });
  redraw({ title: "y", lines: [{ text: "Цена", money: { copper: 1, label: "Цена" } }] });
  assert.deepEqual(drawn.lines, [], "a late redraw comes back without the price too");
});

test("2.10: the native merchant's refund rows — a record, no enchantment, time left; worn, backpack, bags", () => {
  const offset = (name) => UPDATE_FIELDS[name].offset;
  const state = new WorldState();
  const PLAYER = 0x10n, HEAD = 0x201n, SWORD = 0x202n, ASKED = 0x203n, OLD = 0x204n;
  const object = (guid, typeId, entries) => ({ guid, typeId, fields: new Map(entries) });
  state.objects.set(PLAYER, object(PLAYER, 4, [
    [offset("PLAYER_FIELD_INV_SLOT_HEAD"), Number(HEAD)],
    [offset("PLAYER_FIELD_PACK_SLOT_1"), Number(SWORD)], [offset("PLAYER_FIELD_PACK_SLOT_1") + 2, Number(ASKED)],
    [offset("PLAYER_FIELD_PACK_SLOT_1") + 4, Number(OLD)], [offset("PLAYER_FIELD_PACK_SLOT_1") + 6, 0x205],
  ]));
  for (const [guid, entry] of [[HEAD, 1001], [SWORD, 1002], [ASKED, 1003], [OLD, 1004], [0x205n, 1005]]) {
    // L4-review: the realm's ITEM_FIELD_FLAG_REFUNDABLE (0x1000) on every purchase (tooltip-l4-review).
    state.objects.set(guid, object(guid, 1, [[offset("OBJECT_FIELD_ENTRY"), entry], [offset("ITEM_FIELD_FLAGS"), 0x1000]]));
  }
  state.objects.get(SWORD).fields.set(offset("ITEM_FIELD_ENCHANTMENT_1_1"), 1897);
  state.selfGuid = PLAYER;
  const record = (stamp) => ({ money: 0, honor: 1500, arena: 0, items: [], purchasedAtPlayed: stamp });
  const info = new Map([[HEAD, record(19_000)], [SWORD, record(19_000)], [OLD, record(10_000)], [0x205n, record(19_500)]]);
  const rows = vendorRefundRows({ state, itemRefunds: { info } }, 20_000);
  assert.deepEqual(rows.map((row) => [row.guid, row.entry, row.left]), [[HEAD, 1001, 6200], [0x205n, 1005, 6700]],
    "worn first, then the backpack; the enchanted sword, the item without a record and the expired one are not offered");
  assert.equal(vendorRefundTimeText(6200), "1 ч 43 мин");
  assert.equal(vendorRefundTimeText(3600), "1 ч 0 мин");
  assert.equal(vendorRefundTimeText(50), "1 мин");
  assert.equal(vendorRefundCostText({ money: 12345, honor: 1500, arena: 0, items: [{ itemId: 40752, count: 2 }, { itemId: 0, count: 0 }] },
    (copper) => `${copper}м`, (entry) => `Эмблема ${entry}`), "12345м, Очки чести: 1500, Эмблема 40752 ×2");
});

test("5.22: ITEM_DURATION_* by 0x0061a9e0 in seconds, rounding up; the object's time or the record's", () => {
  assert.deepEqual([0, 59, 60, 61, 3540, 3541, 3599, 3600, 3601, 82800, 82801, 86400, 86401, 172800]
    .map((seconds) => { const { key, count } = itemDurationParts(seconds); return `${key.slice(14)}${count}`; }),
  ["SEC0", "SEC59", "MIN1", "MIN2", "MIN59", "HOURS1", "HOURS1", "HOURS1", "HOURS2", "HOURS23", "DAYS1", "DAYS1", "DAYS2", "DAYS2"]);
  assert.equal(itemDurationSeconds(0, 50), undefined, "a record without Duration writes none");
  assert.equal(itemDurationSeconds(3600, undefined), 3600, "no object: the record's Duration");
  assert.equal(itemDurationSeconds(3600, 120), 120);
  assert.equal(itemDurationSeconds(3600, -5), 0, "past: 0 (0x007070b0)");
  assert.equal(itemDurationSeconds(-1, 10), undefined);
});

test("5.22: the line sits right after durability in the stock item tooltip, white", () => {
  const template = {
    found: true, entry: 9, name: "Временный посох", quality: 1, itemClass: 2, subClass: 10, flags: 0, inventoryType: 17,
    bonding: 0, stackable: 1, maxCount: 0, startQuest: 0, containerSlots: 0, damage: [{ min: 0, max: 0, type: 0 }], delay: 0,
    resistances: [0, 0, 0, 0, 0, 0, 0], block: 0, stats: [], sockets: [], socketBonus: 0, gemProperties: 0,
    maxDurability: 50, allowableClass: 0, allowableRace: 0, requiredLevel: 10, requiredSkill: 0, requiredSkillRank: 0,
    requiredReputationFaction: 0, requiredReputationRank: 0, itemLevel: 0, spells: [], description: "", sellPrice: 0,
    duration: 7200, pageText: 0,
  };
  const texts = (context) => itemTooltipContent({ entry: 9, template }, { layout: "stock", ...context }).lines
    .map((line) => typeof line === "string" ? line : line.text);
  const after = (lines) => lines[lines.findIndex((text) => text.startsWith("Прочность")) + 1];
  const withObject = texts({ durability: 40, durationLeft: 150 });
  assert.ok(withObject.includes("Прочность: 40 / 50"), withObject.join(" / "));
  assert.equal(after(withObject), "Срок действия: 3 минуты", "⌈150 / 60⌉ = 3, right after durability");
  assert.equal(after(texts({})), "Исчезнет через 2 ч.", "a link: the record's 7200 s");
  assert.equal(after(texts({ durationLeft: 0 })), "Срок действия: 0 секунд", "0 still writes a line");
  const native = itemTooltipContent({ entry: 9, template }, { durationLeft: 90000 }).lines
    .map((line) => typeof line === "string" ? line : line.text);
  assert.ok(native.includes("Исчезнет через 2 д."), native.join(" / "));
  assert.equal(itemTooltipContent({ entry: 9, template: { ...template, duration: 0 } }, { layout: "stock" }).lines.length,
    texts({}).length - 1, "no Duration: no line");
});
