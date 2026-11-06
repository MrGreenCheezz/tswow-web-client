// 06.11 (3.12): a heirloom as Wow.exe 3.3.5a scales it (.runtime/re-2026-11-06/312): the level (0x0061e740), the
// multiplier, armour and damage columns (0x0061a650, 0x0061a6b0, 0x0061a830), the tooltip's rows (0x006277f0: the
// hit and speed, the armour, the white stats in 0x00a262f0's order, ITEM_LEVEL_RANGE_CURRENT, the green ratings,
// the spell power) and the comparison table (0x0061f550).
import assert from "node:assert/strict";
import test from "node:test";
import { readScalingStatDistributions, readScalingStatValues } from "../dist/code/gateway/ItemEnchantments.js";
import {
  itemScaledStats, itemScaling, itemScalingArmor, itemScalingDps, itemScalingLevel, itemScalingMultiplier,
  itemScalingTables,
} from "../dist/code/browser/ItemScaling.js";
import { itemTooltipContent } from "../dist/code/browser/ui/ItemTooltip.js";
import { globalString } from "../dist/code/generated/globalStrings.js";
import { gameTooltipItemStats, gameTooltipStatTableKnown } from "../dist/code/browser/glue/GlueTooltipStatDelta.js";
import { frameXmlScaled } from "../dist/code/browser/framexml/FrameXmlTooltipExtrasAdapter.js";

function wdbc(fields, rows) {
  const body = Buffer.alloc(rows.length * fields * 4);
  rows.forEach((row, index) => row.forEach((value, field) => body.writeInt32LE(value, (index * fields + field) * 4)));
  const header = Buffer.alloc(20);
  header.write("WDBC", 0, "ascii");
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt32LE(fields, 8);
  header.writeUInt32LE(fields * 4, 12);
  header.writeUInt32LE(1, 16);
  return Buffer.concat([header, body, Buffer.from([0])]);
}

/** This dataset's ScalingStatValues row for level 80 (id 200) and ScalingStatDistribution 1. */
const ROW_80 = [200, 80, 97, 97, 56, 41, 210, 395, 878, 1570, 120, 156, 86, 112, 108, 220, 343, 131, 73, 140, 280, 527, 1171, 2093];
const ROW_70 = [190, 70, 80, 81, 47, 35, 180, 340, 760, 1360, 100, 130, 72, 94, 90, 185, 290, 110, 61, 120, 240, 450, 1000, 1800];
const DIST = { stats: [7, 4, 32, -1, -1, -1, -1, -1, -1, -1], bonuses: [7888, 5259, 5259, 0, 0, 0, 0, 0, 0, 0], maxLevel: 80 };
const TABLES = {
  distribution: (id) => (id === 1 ? DIST : id === 2 ? { ...DIST, maxLevel: 70 } : undefined),
  values: (level) => (level === 80 ? ROW_80 : level === 70 ? ROW_70 : undefined),
};

test("the gateway reads both tables in their 3.3.5 layouts; ScalingStatValues whole and in file order", () => {
  const distributions = readScalingStatDistributions(wdbc(22, [[1, 4, 7, 32, -1, -1, -1, -1, -1, -1, -1, 5259, 7888, 5259, 0, 0, 0, 0, 0, 0, 0, 80]]));
  assert.deepEqual(distributions, [{ id: 1, stats: [4, 7, 32, -1, -1, -1, -1, -1, -1, -1], bonuses: [5259, 7888, 5259, 0, 0, 0, 0, 0, 0, 0], maxLevel: 80 }]);
  assert.deepEqual(readScalingStatValues(wdbc(24, [ROW_80, ROW_70])), [ROW_80, ROW_70], "file order, not by id or level");
  assert.throws(() => readScalingStatValues(wdbc(23, [])), /ScalingStatValues\.dbc layout/);
});

test("0x0061e740: the unit's level, at least RequiredLevel, at most Maxlevel, at least 1", () => {
  assert.equal(itemScalingLevel(1, 80, 71), 71);
  assert.equal(itemScalingLevel(1, 70, 75), 70, "above Maxlevel");
  assert.equal(itemScalingLevel(10, 80, 5), 10, "below RequiredLevel");
  assert.equal(itemScalingLevel(1, undefined, 85), 85, "no distribution row: the level itself");
  assert.equal(itemScalingLevel(0, 80, 0), 1);
});

test("0x0061a650, 0x0061a6b0, 0x0061a830: the columns by the masked flags, exactly; the hit's spread in float", () => {
  assert.equal(itemScalingMultiplier(ROW_80, 0x1), 97);
  assert.equal(itemScalingMultiplier(ROW_80, 0x4), 56);
  assert.equal(itemScalingMultiplier(ROW_80, 0x8), 131, "ssdMultiplier2");
  assert.equal(itemScalingMultiplier(ROW_80, 0x10), 41, "ssdMultiplier[3]");
  assert.equal(itemScalingMultiplier(ROW_80, 0x40000), 73, "ssdMultiplier3");
  assert.equal(itemScalingMultiplier(ROW_80, 0x3), 0, "two bits: none, as the equality reads them");
  assert.equal(itemScalingMultiplier(undefined, 0x1), 0);
  assert.equal(itemScalingArmor(ROW_80, 0x20 | 0x1), 210);
  assert.equal(itemScalingArmor(ROW_80, 0x100), 1570);
  assert.equal(itemScalingArmor(ROW_80, 0x80000), 140);
  assert.equal(itemScalingArmor(ROW_80, 0x800000), 2093);
  const one = itemScalingDps(ROW_80, 0x200);
  assert.deepEqual(one, { min: Math.fround(120 - 120 * Math.fround(0.3)), max: Math.fround((Math.fround(0.3) + 1) * 120) });
  const two = itemScalingDps(ROW_80, 0x400);
  assert.deepEqual(two, { min: Math.fround(156 - 156 * Math.fround(0.2)), max: Math.fround((Math.fround(0.2) + 1) * 156) }, "two-handed: 0.2f");
  assert.equal(itemScalingDps(ROW_80, 0x1000).min, Math.fround(112 - 112 * Math.fround(0.2)));
  assert.deepEqual(itemScalingDps(ROW_80, 0x600), { min: 0, max: 0 });
});

test("itemScaling and itemScaledStats: Bonus × multiplier / 10000, cut, in the distribution's order", () => {
  const record = { scalingStatDistribution: 1, scalingStatValue: 0x1, requiredLevel: 1 };
  const scaling = itemScaling(record, 80, TABLES);
  assert.equal(scaling.level, 80);
  assert.equal(scaling.multiplier, 97);
  assert.deepEqual(itemScaledStats(scaling).slice(0, 4), [{ type: 7, value: 76 }, { type: 4, value: 51 }, { type: 32, value: 51 }, { type: -1, value: 0 }]);
  assert.equal(itemScaling({ ...record, scalingStatValue: 0 }, 80, TABLES), undefined, "not a heirloom");
  assert.deepEqual(itemScaledStats(itemScaling({ ...record, scalingStatDistribution: 9 }, 80, TABLES)), [], "no distribution row");
  assert.equal(itemScaling({ ...record, scalingStatDistribution: 2 }, 75, TABLES).level, 70);
  const client = { scalingReady: true, scalingDistributions: new Map([[1, DIST]]), scalingValues: [ROW_70, ROW_80] };
  assert.equal(itemScalingTables(client).values(2), ROW_80, "row level − 1");
  assert.equal(itemScalingTables({ ...client, scalingReady: false }), undefined);
});

function template(overrides = {}) {
  return {
    found: true, entry: 42, name: "Фамильный", quality: 7, itemClass: 4, subClass: 2, inventoryType: 5, itemLevel: 1,
    flags: 0, maxCount: 0, bonding: 0, containerSlots: 0, block: 0, damage: [{ min: 0, max: 0, type: 0 }], delay: 0,
    resistances: [0, 0, 0, 0, 0, 0, 0], stats: [{ type: 7, value: 99 }], requiredLevel: 1, maxDurability: 0, spells: [],
    requiredSkill: 0, requiredSkillRank: 0, requiredReputationFaction: 0, requiredReputationRank: 0,
    allowableClass: 0xffff_ffff, allowableRace: 0xffff_ffff, sockets: [], socketBonus: 0, gemProperties: 0, startQuest: 0,
    description: "", sellPrice: 0, stackable: 1, randomProperty: 0, randomSuffix: 0, duration: 0,
    scalingStatDistribution: 1, scalingStatValue: 0x1 | 0x20, ...overrides,
  };
}
const texts = (content) => (content.lines ?? []).map((line) => (typeof line === "string" ? line : line.text));
const stock = (overrides, context = {}) => itemTooltipContent({ entry: 42, template: template(overrides) },
  { layout: "stock", compare: false, playerLevel: 80, scalingTables: TABLES, ...context });

test("a heirloom chest: scaled armour, white stats in 0x00a262f0's order, the level range, the green rating", () => {
  const rows = texts(stock());
  assert.ok(rows.includes((globalString("ARMOR_TEMPLATE") ?? "").replace("%d", "210")), rows.join(" | "));
  const strength = rows.findIndex((text) => text.includes("+51 ") && !text.startsWith(globalString("ITEM_SPELL_TRIGGER_ONEQUIP") ?? "@"));
  const stamina = rows.findIndex((text) => text.includes("+76 "));
  assert.ok(strength >= 0 && stamina > strength, `strength before stamina, whatever the distribution's order: ${rows.join(" | ")}`);
  assert.ok(!rows.some((text) => text.includes("99")), "the template's own stats are not read");
  const range = rows.find((text) => text.includes("80") && text !== rows[strength] && /1\D+80\D+80/.test(text));
  assert.ok(range, `ITEM_LEVEL_RANGE_CURRENT (1, 80, 80): ${rows.join(" | ")}`);
  const onEquip = globalString("ITEM_SPELL_TRIGGER_ONEQUIP");
  const greens = stock().lines.filter((line) => line.tone === "spell" && line.text.startsWith(onEquip));
  assert.equal(greens.length, 1, "the crit rating, green");
  assert.ok(greens[0].text.includes("51"));
});

test("the level range is red outside RequiredLevel..Maxlevel; a missing distribution writes ITEM_MIN_LEVEL", () => {
  const capped = stock({ scalingStatDistribution: 2 }, { playerLevel: 75 });
  const line = capped.lines.find((row) => /1\D+70\D+70/.test(row.text));
  assert.ok(line, texts(capped).join(" | "));
  assert.equal(line.tone, "unmet", "75 is above Maxlevel 70");
  assert.ok(texts(capped).includes((globalString("ARMOR_TEMPLATE") ?? "").replace("%d", "180")), "the numbers are the row of 70, not 75");
  const fine = stock({}, { playerLevel: 80 }).lines.find((row) => /1\D+80\D+80/.test(row.text));
  assert.equal(fine.tone, undefined);
  const lost = texts(stock({ scalingStatDistribution: 9, requiredLevel: 5 }));
  assert.ok(lost.includes((globalString("ITEM_MIN_LEVEL") ?? "").replace("%d", "5")), lost.join(" | "));
});

test("a heirloom weapon: the hit from the row's DPS × the delay, cut; SPEED; DPS_TEMPLATE; and spell power", () => {
  const content = stock({ itemClass: 2, subClass: 7, inventoryType: 13, delay: 2600, scalingStatValue: 0x1 | 0x200 | 0x8000 });
  const hit = content.lines.find((line) => line.right !== undefined && line.right.includes("2.60"));
  // 120 × (1 ∓ 0.3f) per second × 2.6 s: 218.40001 and 405.60002, cut.
  assert.equal(hit.text, (globalString("DAMAGE_TEMPLATE") ?? "").replace("%d", "218").replace("%d", "405"));
  const rows = texts(content);
  assert.ok(rows.some((text) => text.includes("120.0") || text.includes("120,0")), `DPS_TEMPLATE: ${rows.join(" | ")}`);
  const onEquip = globalString("ITEM_SPELL_TRIGGER_ONEQUIP");
  const power = (globalString("ITEM_MOD_SPELL_POWER") ?? "").replace("%d", "343");
  assert.ok(rows.includes(`${onEquip} ${power}`), "ITEM_MOD_SPELL_POWER with the row's spellPower, green");
  assert.ok(!rows.some((text) => text === (globalString("ARMOR_TEMPLATE") ?? "").replace("%d", "0")), "no armour flag, no armour row");
  const zeroArmor = texts(stock({ scalingStatValue: 0x1 | 0x20 }, { scalingTables: { ...TABLES, values: () => undefined } }));
  assert.ok(zeroArmor.includes((globalString("ARMOR_TEMPLATE") ?? "").replace("%d", "0")), "a scaled armour is written even at 0");
});

test("before the tables a heirloom shows no scaled rows; an ordinary item's whites follow 0x00a262f0 too", () => {
  const early = texts(itemTooltipContent({ entry: 42, template: template() }, { layout: "stock", compare: false, playerLevel: 80 }));
  assert.ok(!early.some((text) => text.includes("+76 ") || text.includes("+51 ")));
  const plain = texts(stock({ scalingStatValue: 0, stats: [{ type: 7, value: 10 }, { type: 2, value: 3 }, { type: 4, value: 5 }, { type: 11, value: 4 }] }));
  const strength = plain.findIndex((text) => text.includes("5") && !text.includes("10"));
  const stamina = plain.findIndex((text) => text.includes("10"));
  assert.ok(strength >= 0 && strength < stamina, plain.join(" | "));
  const onEquip = globalString("ITEM_SPELL_TRIGGER_ONEQUIP");
  assert.ok(!plain.some((text) => text.startsWith(onEquip)), "types 2 and 11 are neither white nor green (0x00a25f78 lists 12-48)");
});

test("0x0061f550: the scaled table, nothing without both rows; known once `scaled` is", () => {
  const base = { stats: [{ type: 7, value: 99 }], resistances: [50, 7, 0, 0, 0, 0, 0], block: 30, damage: [{ min: 10, max: 20 }], delay: 2000,
    sockets: [{ color: 2 }], scalingStatValue: 1 };
  const table = gameTooltipItemStats({ ...base, scaled: {
    valid: true, stats: [{ type: 7, value: 765 }, { type: 38, value: 40 }, { type: 0, value: 9 }], armor: 210,
    dps: { min: 84, max: 156 }, spellPower: 343,
  } });
  assert.equal(table[1 + 11 + 7], 765, "the distribution's, not the template's");
  assert.equal(table[1 + 11], 0, "type 0 is not added (0 < StatID)");
  assert.equal(table[1 + 7], 40, "attack power into melee and ranged, equal, so the merge shows them as 7");
  assert.equal(table[1 + 8], 0);
  assert.equal(table[1], 210, "the scaled armour, not the record's");
  assert.equal(table[2], 0, "the record's resistances are not read with an armour flag");
  assert.equal(table[0], 120, "0.5 × (84 + 156)");
  assert.equal(table[1 + 56], 343, "spell power into the combined slot");
  assert.equal(table[1 + 60], 0, "no block");
  assert.equal(table[1 + 70], 0, "no sockets");
  const record = gameTooltipItemStats({ ...base, scaled: { valid: true, stats: [] } });
  assert.equal(record[1], 50, "without an armour flag the record's armour …");
  assert.equal(record[2], 7, "… and resistances (0x0061b8e0)");
  assert.equal(record[0], Math.fround(Math.fround(15) / Math.fround(2)), "without a damage flag the record's DPS");
  assert.ok(gameTooltipItemStats({ ...base, scaled: { valid: false, stats: [{ type: 7, value: 765 }] } }).every((value) => value === 0),
    "nothing at all without both rows");
  assert.equal(gameTooltipStatTableKnown({ ...base, scaled: null }, undefined), false);
  assert.equal(gameTooltipStatTableKnown(base, undefined), false);
  assert.equal(gameTooltipStatTableKnown({ ...base, scaled: { valid: true, stats: [] } }, undefined), true);
});

test("frameXmlScaled: what the flags take from the level's row; null before the tables", () => {
  const record = { scalingStatDistribution: 1, scalingStatValue: 0x1 | 0x20 | 0x400 | 0x8000, requiredLevel: 1 };
  const scaled = frameXmlScaled(record, TABLES, 80);
  assert.equal(scaled.valid, true);
  assert.equal(scaled.armor, 210);
  assert.deepEqual(scaled.dps, itemScalingDps(ROW_80, 0x400));
  assert.equal(scaled.spellPower, 343);
  assert.deepEqual(scaled.stats.slice(0, 2), [{ type: 7, value: 76 }, { type: 4, value: 51 }]);
  assert.equal("armor" in frameXmlScaled({ ...record, scalingStatValue: 0x1 }, TABLES, 80), false);
  assert.equal(frameXmlScaled(record, undefined, 80), null);
  assert.equal(frameXmlScaled(record, TABLES, 50).valid, false, "no row for the level");
});

/** The page's enchantment client with this test's heirloom tables, as a gateway since `?v=4` answers. */
async function loadedClient(origin) {
  const { itemEnchantments } = await import("../dist/code/browser/ItemEnchantments.js");
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    enchantments: [], gems: [],
    scalingStatDistributions: [{ id: 1, ...DIST }, { id: 3, stats: [1], bonuses: [1], maxLevel: 80 }],
    scalingStatValues: [...Array.from({ length: 69 }, (_, index) => [index, index + 1, ...new Array(22).fill(0)]), ROW_70,
      ...Array.from({ length: 9 }, (_, index) => [index, 71 + index, ...new Array(22).fill(0)]), ROW_80],
  }) });
  try {
    const client = itemEnchantments(origin);
    await client.load(true);
    return client;
  } finally {
    globalThis.fetch = previous;
  }
}

test("the client keeps both tables; a malformed distribution is skipped; values by level − 1", async () => {
  const client = await loadedClient("http://scaling-client.test");
  assert.equal(client.scalingReady, true);
  assert.ok(client.scalingDistributions.has(1));
  assert.equal(client.scalingDistributions.has(3), false, "stats and bonuses must be ten each");
  assert.equal(itemScalingTables(client).values(80), ROW_80);
  assert.equal(itemScalingTables(client).values(70), ROW_70);
});

test("live: the adapters draw a heirloom at the wearer's level and compare it at the player's", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");
  const { frameXmlTooltipExtrasAdapter } = await import("../dist/code/browser/framexml/FrameXmlTooltipExtrasAdapter.js");
  const { resetStockTooltipRedraws } = await import("../dist/code/browser/ui/ItemTooltip.js");
  const origin = "http://scaling-live.test";
  await loadedClient(origin);
  const record = template();
  const previousOrigin = game.gatewayOrigin;
  game.gatewayOrigin = origin;
  const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
  const self = { guid: 1n, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 80]]) };
  game.world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self]]) }, itemTemplate: (entry) => (entry === 42 ? record : undefined),
    events: { on: () => () => {} },
  };
  try {
    const seam = {
      itemInfo: () => undefined,
      inventoryItemTooltip: () => ({ entry: 42, template: record, enchantments: [], unitLevel: 70 }),
    };
    const worn = createFrameXmlCharacterTooltipAdapter(seam).inventoryItem("target", 5);
    const rows = texts(worn);
    assert.ok(rows.some((text) => /1\D+80\D+70/.test(text)), `drawn at the wearer's 70: ${rows.join(" | ")}`);
    assert.ok(rows.includes((globalString("ARMOR_TEMPLATE") ?? "").replace("%d", "180")), "ROW_70's armour");
    const linked = texts(createFrameXmlCharacterTooltipAdapter({ itemInfo: () => undefined }).item(42, "item:42:0:0:0:0:0:0:0:80"));
    assert.ok(linked.includes((globalString("ARMOR_TEMPLATE") ?? "").replace("%d", "210")), "a link: the player's level, 80");
    const extras = frameXmlTooltipExtrasAdapter({ unitLevel: () => 80 }, () => ({
      world: { itemTemplates: new Map([[42, record]]), questTemplates: new Map() }, spells: new Map(), gatewayOrigin: origin,
    }), () => undefined, () => {});
    const stats = extras.itemStats(42, "item:42");
    assert.equal(stats.scaled.valid, true);
    assert.equal(stats.scaled.armor, 210, "the player's level 80");
    assert.equal(stats.randomEffects, undefined, "a heirloom takes no random property");
  } finally {
    resetStockTooltipRedraws();
    game.world = undefined;
    game.gatewayOrigin = previousOrigin;
  }
});
