import assert from "node:assert/strict";
import test from "node:test";

// L4-review (04.10): the adversarial review of lane L4's tooltips (plan items 3.12, 2.10, 5.22, 5.28).
// * 3.12: Wow.exe 3.3.5a 12340 builds a heirloom's stat table from ScalingStatDistribution (record
//   +0xbc set → 0x006265c0 / 0x006206d0 → 0x0061f550) and adds a random property's or suffix's
//   enchantments (→ 0x0061fa20); neither is served here, so such an item's bare template would draw a
//   wrong difference — none is drawn instead.
// * 2.10: the native merchant's refund rows follow the realm's own refundability — ITEM_FIELD_FLAGS
//   0x1000 (TrinityCore Item::IsRefundable; TSWoW's Transmogrification.cpp clears it on an item that
//   stays in the bags, after which HandleItemRefund → Player::RefundItem returns without an answer) —
//   and the confirm re-checks its row before CMSG_ITEM_REFUND.
// * What nothing new applies to draws as before (a regression table).
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { gameTooltipLinkRandomProperty, gameTooltipStatTableKnown } = await import("../dist/code/browser/glue/GlueTooltipStatDelta.js");
const { vendorRefundConfirm, vendorRefundRows } = await import("../dist/code/browser/ui/VendorRefundRows.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const FIXTURE = `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
Owner = CreateFrame("Button", "Owner", UIParent)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
ShoppingTooltip1 = CreateFrame("GameTooltip", "ShoppingTooltip1", UIParent)
CURRENTLY_EQUIPPED = "На персонаже"
ITEM_DELTA_DESCRIPTION = "Если вы замените этот предмет:"
ITEM_MOD_STAMINA_SHORT = "к выносливости"
ITEM_MOD_POWER_REGEN0_SHORT = "маны в 5 сек."
TOOLTIP_UNIT_LEVEL = "Уровень %s"
TOOLTIP_UNIT_LEVEL_TYPE = "Уровень %s (%s)"
TOOLTIP_UNIT_LEVEL_RACE_CLASS = "Уровень %s %s %s"
FACTION_STANDING_LABEL5 = "Дружелюбие"
UNITNAME_SUMMON_TITLE1 = "Питомец |3-1(%s)"
MASTER_LOOTER = "Ответственный за добычу"
Items = { [500] = "INVTYPE_HEAD", [501] = "INVTYPE_HEAD", [502] = "INVTYPE_HEAD" }
function GetItemInfo(link)
  local id = tonumber(tostring(link):match("item:(%d+)"))
  if id and Items[id] then return "Предмет", link, 3, 1, 1, "", "", 1, Items[id] end
end
Worn = { [1] = "|Hitem:501:0:0:0:0:0:0:0:80|h[Шлем]|h" }
BagLink = "|Hitem:500:0:0:0:0:0:0:0:80|h[Новый шлем]|h"
function GetInventoryItemLink(unit, slot) return Worn[slot] end
function GetContainerItemLink(bag, slot) return BagLink end
function GetContainerItemCooldown() return 0, 0, 0 end
function GetInventoryItemCooldown() return 0, 0, 0 end
Money = nil
GameTooltip:SetScript("OnTooltipAddMoney", function(self, cost) Money = cost end)
function GetCVarBool(name) return false end
function UnitSex() return 2 end
function UnitExists(unit) return unit == "target" or unit == "mouseover" end
function UnitName(unit) if unit == "target" then return "Волк" end if unit == "mouseover" then return "Чужак" end end
function UnitIsPlayer(unit) return unit == "mouseover" end
function UnitRace() return "Человек" end
function UnitClass() return "Воин" end
function UnitLevel() return 80 end
function UnitCreatureType(unit) if unit == "target" then return "Животное" end end
function UnitIsPVP() return false end
function UnitReaction() return 5 end
function UnitIsDead() return false end
Guild = nil
function GetGuildInfo(unit) return Guild end
`;

const STAT = (stamina, over = {}) => ({
  found: true, scalingStatValue: 0, stats: [{ type: 7, value: stamina }], resistances: [0, 0, 0, 0, 0, 0, 0], block: 0,
  damage: [{ min: 0, max: 0 }, { min: 0, max: 0 }], delay: 0, sockets: [{ color: 0 }, { color: 0 }, { color: 0 }], ...over,
});
const ITEMS = new Map([
  [500, { title: "Новый шлем", quality: 3, lines: [{ text: "Голова" }, { text: "Цена продажи: 1з", money: { copper: 10000, label: "Цена продажи:" } }] }],
  [501, { title: "Шлем", quality: 3, lines: [{ text: "Голова" }, { text: "Цена продажи: 5м", money: { copper: 5, label: "Цена продажи:" } }] }],
  [502, { title: "Наследный шлем", quality: 7, lines: [{ text: "Голова" }] }],
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
      inventoryItem: (unit, slot) => (unit === "player" && slot === 1 ? ITEMS.get(501) : undefined),
      containerItem: () => ITEMS.get(500),
      item: (entry) => ITEMS.get(entry),
      spell: () => undefined,
      ...adapter,
    },
  });
  await booted.load();
  const run = (source, results = 0) => {
    const chunk = booted.vm.compileFunction(source, "@tooltip-l4-review", []);
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

const WORN_ONLY = ["На персонаже", "Шлем", "Голова"];
const WITH_DELTA = [...WORN_ONLY, " ", "Если вы замените этот предмет:", "|cffff2020-12|r к выносливости"];

test("L4-review 3.12: the link's random property id and the table check", () => {
  assert.equal(gameTooltipLinkRandomProperty("|cff1eff00|Hitem:500:0:0:0:0:0:-39:12345:80|h[x]|h|r"), -39, "a suffix");
  assert.equal(gameTooltipLinkRandomProperty("item:500:0:0:0:0:0:1234:0:80"), 1234, "a property");
  assert.equal(gameTooltipLinkRandomProperty("|Hitem:500:0:0:0:0:0:0:0:80|h[x]|h"), 0);
  assert.equal(gameTooltipLinkRandomProperty("item:500"), 0, "a bare item string");
  assert.equal(gameTooltipLinkRandomProperty(undefined), 0);
  assert.equal(gameTooltipStatTableKnown({ scalingStatValue: 0 }, "item:500:0:0:0:0:0:0:0:80"), true);
  assert.equal(gameTooltipStatTableKnown({ scalingStatValue: 0 }, undefined), true, "no link: the template is the item");
  assert.equal(gameTooltipStatTableKnown({ scalingStatValue: 2 }, "item:500"), false, "ScalingStatValue: 0x0061f550's table");
  assert.equal(gameTooltipStatTableKnown({ scalingStatValue: 0 }, "item:500:0:0:0:0:0:-7:1:80"), false, "0x0061fa20's enchantments");
});

test("L4-review 3.12: the rows' edges — mana per 5 by POWER_REGEN0, a DPS change under 0.05 still writes «0.0»", async () => {
  const { gameTooltipItemStats, gameTooltipStatDelta, gameTooltipStatDeltaRows } = await import("../dist/code/browser/glue/GlueTooltipStatDelta.js");
  const g = (key) => ({ ITEM_DELTA_DESCRIPTION: "Δ", ITEM_MOD_POWER_REGEN0_SHORT: "маны в 5 сек.", ITEM_MOD_DAMAGE_PER_SECOND_SHORT: "УВС" })[key];
  const base = { stats: [], resistances: [0, 0, 0, 0, 0, 0, 0], block: 0, damage: [{ min: 0, max: 0 }, { min: 0, max: 0 }], delay: 0, sockets: [] };
  const mp5 = gameTooltipStatDeltaRows(gameTooltipStatDelta(
    gameTooltipItemStats({ ...base, stats: [{ type: 43, value: 8 }] }), gameTooltipItemStats(base)), g);
  assert.deepEqual(mp5.map((row) => row.text), [" ", "Δ", "|cff00ff00+8|r маны в 5 сек."], "index 61 is ITEM_MOD_POWER_REGEN0_SHORT (0x0061bb20)");
  // 0x0062d930 writes the DPS row whenever |Δ| > FLT_EPSILON, so a hair's change prints as 0.0.
  const weapon = (max) => gameTooltipItemStats({ ...base, damage: [{ min: 10, max }, { min: 0, max: 0 }], delay: 2000 });
  const tiny = gameTooltipStatDeltaRows(gameTooltipStatDelta(weapon(20.1), weapon(20)), g).map((row) => row.text);
  assert.deepEqual(tiny, [" ", "Δ", "|cff00ff00+0.0|r УВС"]);
});

test("L4-review 5.28: a corpse's allowed looter whose name is on its way is waited for too", async () => {
  const { frameXmlUnitPendingAnswers } = await import("../dist/code/browser/framexml/FrameXmlUnitTooltipExtras.js");
  const names = new Map();
  const world = { state: { objects: new Map() }, names: { get: (guid) => names.get(guid) }, creatureTemplates: new Map() };
  const corpse = { guid: 0xf130000123000001n, typeId: 3, fields: new Map() };
  const ready = frameXmlUnitPendingAnswers(world, corpse, { masterLooterGuid: 0n, allowedLooterGuid: 0x77n });
  assert.equal(typeof ready, "function", "LOOT's name pending");
  assert.equal(ready(), false);
  names.set(0x77n, "Вор");
  assert.equal(ready(), true);
});

test("L4-review 3.12: no difference for a heirloom or a random property, on either side", async () => {
  const stats = new Map([[500, STAT(30)], [501, STAT(42)], [502, STAT(0, { scalingStatValue: 3 })]]);
  const { boot: b, run, rows } = await boot({ itemStats: (entry) => stats.get(entry) });
  const compare = (bagLink, wornLink) => {
    run(`BagLink = "${bagLink}" Worn[1] = "${wornLink}" GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT") GameTooltip:SetBagItem(0, 1)`);
    run(`ShoppingTooltip1:SetHyperlinkCompareItem("item:500", 1, nil, GameTooltip)`);
    return rows("ShoppingTooltip1");
  };
  try {
    const plain = "|Hitem:500:0:0:0:0:0:0:0:80|h[x]|h";
    const worn = "|Hitem:501:0:0:0:0:0:0:0:80|h[y]|h";
    assert.deepEqual(compare(plain, worn), WITH_DELTA, "the control: plain links draw the difference");
    assert.deepEqual(compare("|Hitem:500:0:0:0:0:0:-39:12345:80|h[x]|h", worn), WORN_ONLY, "hovered with a random suffix");
    assert.deepEqual(compare(plain, "|Hitem:501:0:0:0:0:0:1234:0:80|h[y]|h"), WORN_ONLY, "worn with a random property");
    assert.deepEqual(compare("|Hitem:502:0:0:0:0:0:0:0:80|h[x]|h", worn), WORN_ONLY, "a hovered heirloom");
    assert.deepEqual(compare(plain, "|Hitem:502:0:0:0:0:0:0:0:80|h[y]|h").slice(3), [], "a worn heirloom: no rows after the item");
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});

const offset = (name) => UPDATE_FIELDS[name].offset;
const PLAYER = 0x10n, HEAD = 0x201n, PACK = 0x202n, BAGGED = 0x203n, BAG = 0x300n;
function refundWorld() {
  const state = new WorldState();
  const object = (guid, typeId, entries) => ({ guid, typeId, fields: new Map(entries) });
  state.objects.set(PLAYER, object(PLAYER, 4, [
    [offset("PLAYER_FIELD_INV_SLOT_HEAD"), Number(HEAD)], [offset("PLAYER_FIELD_PACK_SLOT_1"), Number(PACK)],
    [offset("PLAYER_FIELD_INV_SLOT_HEAD") + 19 * 2, Number(BAG)], // the first bag slot (19)
  ]));
  state.objects.set(BAG, object(BAG, 2, [[offset("CONTAINER_FIELD_NUM_SLOTS"), 4], [offset("CONTAINER_FIELD_SLOT_1") + 2, Number(BAGGED)]]));
  for (const [guid, entry] of [[HEAD, 1001], [PACK, 1002], [BAGGED, 1003]]) {
    state.objects.set(guid, object(guid, 1, [[offset("OBJECT_FIELD_ENTRY"), entry], [offset("ITEM_FIELD_FLAGS"), 0x1001]]));
  }
  state.selfGuid = PLAYER;
  const record = { money: 0, honor: 1500, arena: 0, items: [], purchasedAtPlayed: 19_000 };
  const sent = [];
  let refusal;
  const world = {
    state, itemRefunds: { info: new Map([[HEAD, record], [PACK, record], [BAGGED, record]]) },
    refundItem(guid) { if (refusal) return refusal; sent.push(guid); return undefined; },
    set refusal(value) { refusal = value; },
  };
  return { world, state, sent };
}

test("L4-review 2.10: the native rows need the realm's refundable flag (ITEM_FIELD_FLAGS 0x1000)", () => {
  const { world, state } = refundWorld();
  assert.deepEqual(vendorRefundRows(world, 20_000).map((row) => row.guid), [HEAD, PACK, BAGGED], "worn, backpack, a bag");
  // Transmogrified (Transmogrification.cpp:46 → Item::SetNotRefundable): the item stays, the flag goes.
  state.objects.get(PACK).fields.set(offset("ITEM_FIELD_FLAGS"), 0x0001);
  assert.deepEqual(vendorRefundRows(world, 20_000).map((row) => row.guid), [HEAD, BAGGED], "the realm would not refund it");
  state.objects.get(HEAD).fields.delete(offset("ITEM_FIELD_FLAGS"));
  state.objects.get(BAGGED).fields.set(offset("ITEM_FIELD_FLAGS"), 0);
  assert.deepEqual(vendorRefundRows(world, 20_000), [], "no flags field or a cleared one: not refundable");
});

test("L4-review 2.10: the confirm re-checks the row it was opened for; only then CMSG_ITEM_REFUND", () => {
  const { world, state, sent } = refundWorld();
  assert.equal(vendorRefundConfirm(world, HEAD, 20_000), undefined);
  assert.deepEqual(sent, [HEAD], "offered: sent");
  // Expired while the question was open (the realm would answer code 10, read as ERR_INV_FULL).
  assert.equal(vendorRefundConfirm(world, PACK, 19_000 + 7200), "ERR_INTERNAL_BAG_ERROR");
  // Enchanted, or no longer refundable to the realm.
  state.objects.get(PACK).fields.set(offset("ITEM_FIELD_ENCHANTMENT_1_1"), 1897);
  assert.equal(vendorRefundConfirm(world, PACK, 20_000), "ERR_INTERNAL_BAG_ERROR");
  state.objects.get(PACK).fields.delete(offset("ITEM_FIELD_ENCHANTMENT_1_1"));
  state.objects.get(PACK).fields.set(offset("ITEM_FIELD_FLAGS"), 0);
  assert.equal(vendorRefundConfirm(world, PACK, 20_000), "ERR_INTERNAL_BAG_ERROR");
  // Moved out of the carried slots (the bank) — the guid is the item, but it is not offered any more.
  state.objects.get(PLAYER).fields.set(offset("PLAYER_FIELD_INV_SLOT_HEAD"), 0);
  assert.equal(vendorRefundConfirm(world, HEAD, 20_000), "ERR_INTERNAL_BAG_ERROR");
  assert.equal(vendorRefundConfirm(world, 0x999n, 20_000), "ERR_INTERNAL_BAG_ERROR", "an unknown guid");
  assert.deepEqual(sent, [HEAD], "nothing more was sent");
  // The world's own refusal (no merchant open) passes through.
  state.objects.get(PLAYER).fields.set(offset("PLAYER_FIELD_INV_SLOT_HEAD"), Number(HEAD));
  world.refusal = "ERR_INTERNAL_BAG_ERROR";
  assert.equal(vendorRefundConfirm(world, HEAD, 20_000), "ERR_INTERNAL_BAG_ERROR");
  assert.deepEqual(sent, [HEAD]);
});

test("L4-review 3.12: TOOLTIP_TALENT_LEARN follows 0x006224f0's answer, not the requirement lines it could name", async () => {
  const { frameXmlTooltipExtrasAdapter } = await import("../dist/code/browser/framexml/FrameXmlTooltipExtrasAdapter.js");
  const cell = (index, id, tier, rank, prerequisites = []) => ({ index, id, tier, rank, prerequisites });
  const talentData = {
    talentsIn: (tab) => tab === 161 ? [{ id: 10, ranks: [100, 101, 102] }, { id: 11, ranks: [200] }] : [],
    glyph: () => undefined,
  };
  let tabName = "Оружие";
  let pointsSpent = 10;
  const snapshot = () => ({
    activeTalentGroup: 1, unspentPoints: 5,
    groups: [{ group: 1, tabs: [{ id: 161, name: tabName, pointsSpent, talents: [
      cell(1, 10, 1, 1), cell(2, 11, 2, 0, [{ talentId: 10, requiredRank: 3, meetsPrereq: false }]),
      cell(3, 10, 3, 0),
    ] }] }],
  });
  // The prerequisite's first rank (spell 100) has no row yet, so its line cannot be written — 0x006224f0
  // clears its answer before it looks the name up (0x00622610), so the talent is still not learnable.
  const adapter = frameXmlTooltipExtrasAdapter({ talentSnapshot: (pet) => pet ? undefined : snapshot() }, () => ({ talentData }), () => undefined);
  assert.deepEqual(adapter.talent(1, 2, false, false, undefined), { ranks: [200], rank: 0, requirements: [] },
    "an unmet prerequisite without its name: no line, and no TOOLTIP_TALENT_LEARN");
  // A tier the tab has not opened yet, its tab name unknown: the same.
  tabName = undefined;
  pointsSpent = 5;
  assert.equal(adapter.talent(1, 3, false, false, undefined)?.learnable, undefined, "tier 3 needs 10 points");
  pointsSpent = 10;
  assert.equal(adapter.talent(1, 3, false, false, undefined)?.learnable, true, "met: learnable");
  assert.equal(adapter.talent(1, 1, false, false, undefined)?.learnable, true, "a learned rank below its last");
});

test("L4-review: where nothing new applies, units, items and comparisons draw as before", async () => {
  // Every L4 hook present but answering nothing: the pre-L4 line lists.
  let refund;
  const watched = [];
  const { boot: b, run, rows } = await boot({
    unitGuildName: () => undefined, unitSummonTitle: () => undefined, unitLootOwners: () => [],
    watchUnitAnswers: (unit) => { watched.push(unit); return undefined; },
    containerItemRefundSeconds: () => refund, inventoryItemRefundSeconds: () => refund,
    itemStats: () => undefined, merchantOpen: () => false,
  });
  try {
    const table = [
      [`GameTooltip:SetUnit("target")`, ["Волк", "Уровень 80 (Животное)"], "an NPC: no summon title, no standing, no loot lines"],
      [`GameTooltip:SetUnit("mouseover")`, ["Чужак", "Уровень 80 Человек Воин"], "a player without a guild"],
      [`Guild = "Щит" GameTooltip:SetUnit("mouseover")`, ["Чужак", "Щит", "Уровень 80 Человек Воин"], "the own guild through GetGuildInfo"],
      [`Money = nil GameTooltip:SetBagItem(0, 1)`, ["Новый шлем", "Голова"], "a bag item without a refund"],
      [`Money = nil GameTooltip:SetInventoryItem("player", 1)`, ["Шлем", "Голова"], "a worn item without a refund"],
    ];
    run(`GameTooltip:SetOwner(Owner, "ANCHOR_RIGHT")`);
    for (const [source, expected, what] of table) {
      run(source);
      assert.deepEqual(rows(), expected, what);
    }
    assert.equal(b.vm.getGlobal("Money"), 5, "the sell price still goes to OnTooltipAddMoney");
    run(`Money = nil GameTooltip:SetBagItem(0, 1)`);
    assert.equal(b.vm.getGlobal("Money"), 10000);
    assert.deepEqual(watched, ["target", "mouseover", "mouseover"]);
    // A comparison with no cached records: the worn item alone, no price row, no difference.
    run(`ShoppingTooltip1:SetHyperlinkCompareItem("item:500", 1, nil, GameTooltip)`);
    assert.deepEqual(rows("ShoppingTooltip1"), WORN_ONLY);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
});
