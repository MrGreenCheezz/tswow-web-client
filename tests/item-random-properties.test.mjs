// 06.11 (3.12): an item's random property or suffix as Wow.exe 3.3.5a reads it (.runtime/re-2026-11-06/312):
// the name (0x00706d70), a link's slots 7..11 (0x0062799e), a suffix enchantment's amount (0x00707650) and an item
// object's factor (0x007075a0, 0x00707500, 0x0070757c), the `$i` line (0x00577260), the tooltip loop's order
// (0x006277f0) and the stat table (0x0061fa20 → 0x0061f940 / 0x0061f980 → 0x0061f2b0).
import assert from "node:assert/strict";
import test from "node:test";
import {
  readItemEnchantments, readItemRandomProperties, readItemRandomSuffixes, readRandPropPoints,
} from "../dist/code/gateway/ItemEnchantments.js";
import {
  itemEnchantText, itemLinkRandom, itemRandomDisplayName, itemRandomEnchantAmount, itemRandomEnchantSlots,
  itemRandomStatEffects, itemRandomTables, itemSuffixFactor,
} from "../dist/code/browser/ItemRandomProperties.js";
import { itemTooltipContent } from "../dist/code/browser/ui/ItemTooltip.js";
import { globalString } from "../dist/code/generated/globalStrings.js";
import {
  gameTooltipItemStats, gameTooltipStatTableKnown,
} from "../dist/code/browser/glue/GlueTooltipStatDelta.js";
import { frameXmlRandomEffects } from "../dist/code/browser/framexml/FrameXmlTooltipExtrasAdapter.js";

/** A 3.3.5 WDBC of `fields` words a row: each row a function (field) → number or string. */
function wdbc(fields, rows) {
  const strings = [""];
  const offsets = new Map([["", 0]]);
  let size = 1;
  const offsetOf = (text) => {
    if (!offsets.has(text)) { offsets.set(text, size); strings.push(text); size += Buffer.byteLength(text) + 1; }
    return offsets.get(text);
  };
  const body = Buffer.alloc(rows.length * fields * 4);
  rows.forEach((row, index) => {
    for (let field = 0; field < fields; field += 1) {
      const value = row(field) ?? 0;
      const at = (index * fields + field) * 4;
      if (typeof value === "string") body.writeUInt32LE(offsetOf(value), at);
      else body.writeInt32LE(value, at);
    }
  });
  const block = Buffer.concat(strings.map((text) => Buffer.from(`${text}\0`)));
  const header = Buffer.alloc(20);
  header.write("WDBC", 0, "ascii");
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt32LE(fields, 8);
  header.writeUInt32LE(fields * 4, 12);
  header.writeUInt32LE(block.length, 16);
  return Buffer.concat([header, body, block]);
}

test("the gateway reads the three tables and the enchantments' effects in their 3.3.5 layouts", () => {
  const properties = readItemRandomProperties(wdbc(24, [(field) => ({ 0: 24, 1: "of Strength", 2: 70, 7: "of Strength", 15: "со знаком силы" })[field]]));
  assert.deepEqual(properties, [{ id: 24, name: "со знаком силы", enchantments: [70, 0, 0, 0, 0] }], "ruRU (locale 8) first");
  const suffixes = readItemRandomSuffixes(wdbc(29, [(field) => ({
    0: 10, 1: "of the Gorilla", 9: "со знаком гориллы", 18: "Gorilla", 19: 2804, 20: 2805, 24: 6666, 25: 6667,
  })[field]]));
  assert.deepEqual(suffixes, [{ id: 10, name: "со знаком гориллы", enchantments: [2804, 2805, 0, 0, 0], allocation: [6666, 6667, 0, 0, 0] }]);
  const points = readRandPropPoints(wdbc(16, [(field) => field === 0 ? 200 : field]));
  assert.deepEqual(points, [{ level: 200, epic: [1, 2, 3, 4, 5], rare: [6, 7, 8, 9, 10], uncommon: [11, 12, 13, 14, 15] }]);
  const [enchant] = readItemEnchantments(wdbc(38, [(field) => ({ 0: 2804, 2: 5, 5: -3, 8: 7, 11: 5, 22: "+$i к интеллекту" })[field]]));
  assert.deepEqual(enchant.effects, [[5, -3, 7, 5], [0, 0, 0, 0], [0, 0, 0, 0]], "in place, the points signed");
  const [empty] = readItemEnchantments(wdbc(38, [(field) => ({ 0: 1, 22: "Пусто" })[field]]));
  assert.equal(empty.effects, undefined, "no effects key for three empty ones");
  assert.throws(() => readItemRandomSuffixes(wdbc(28, [])), /ItemRandomSuffix\.dbc layout/);
});

const TABLES = {
  property: (id) => ({
    24: { name: "со знаком силы", enchantments: [70, 0, 0, 0, 0] },
    25: { name: "", enchantments: [71, 0, 0, 0, 0] },
  })[id],
  suffix: (id) => ({ 10: { name: "со знаком гориллы", enchantments: [2804, 2805, 0, 0, 0], allocation: [6666, 3000, 0, 0, 0] } })[id],
  points: (level) => (level === 200 ? { epic: [91, 69, 51, 39, 29], rare: [80, 60, 45, 34, 25], uncommon: [70, 52, 39, 30, 22] } : undefined),
  enchantment: (id) => ({
    70: { name: "+10 к силе", effects: [[5, 10, 10, 4], [0, 0, 0, 0], [0, 0, 0, 0]] },
    71: { name: "+7 к ловкости", effects: [[5, 6, 9, 3], [4, 4, 5, 3], [0, 0, 0, 0]] },
    2804: { name: "+$i к интеллекту", effects: [[5, 0, 0, 5], [0, 0, 0, 0], [0, 0, 0, 0]] },
    2805: { name: "+$i к выносливости", effects: [[5, 0, 0, 7], [0, 0, 0, 0], [0, 0, 0, 0]] },
  })[id],
};

test("0x00706d70: a property's suffix, a nameless property's bare name, a suffix (empty when its row is missing)", () => {
  assert.equal(itemRandomDisplayName("Штаны", 24, TABLES, "%s %s"), "Штаны со знаком силы");
  assert.equal(itemRandomDisplayName("Штаны", 25, TABLES, "%s %s"), "Штаны", "a property without a name");
  assert.equal(itemRandomDisplayName("Штаны", 99, TABLES, "%s %s"), "Штаны", "a property row not there");
  assert.equal(itemRandomDisplayName("Штаны", 0, TABLES, "%s %s"), "Штаны");
  assert.equal(itemRandomDisplayName("Штаны", -10, TABLES, "%s %s"), "Штаны со знаком гориллы");
  assert.equal(itemRandomDisplayName("Штаны", -99, TABLES, "%s %s"), "Штаны ", "a missing suffix row still goes through the template");
});

test("0x0062799e and 0x00707650: a link's slots; the amount in float, cut toward zero; a property's amount 0", () => {
  assert.deepEqual(itemRandomEnchantSlots(-10, TABLES), [2804, 2805, 0, 0, 0]);
  assert.deepEqual(itemRandomEnchantSlots(24, TABLES), [70, 0, 0, 0, 0]);
  assert.deepEqual(itemRandomEnchantSlots(0, TABLES), [0, 0, 0, 0, 0]);
  // 6666 × 0.0001f × 30 = 19.998… → 19; 3000 × 0.0001f × 30 = 9.0000004 → 9.
  assert.equal(itemRandomEnchantAmount(7, -10, 30, TABLES), 19);
  assert.equal(itemRandomEnchantAmount(8, -10, 30, TABLES), 9);
  assert.equal(itemRandomEnchantAmount(8, -10, -30, TABLES), -9, "toward zero for a negative product");
  assert.equal(itemRandomEnchantAmount(12, -10, 30, TABLES), 0, "past slot 11");
  assert.equal(itemRandomEnchantAmount(7, 24, 30, TABLES), 0, "a property has no share");
});

test("0x007075a0: the object's factor by level, quality block and 0x0070757c's slot column", () => {
  const record = (inventoryType, quality = 2) => ({ itemLevel: 200, quality, inventoryType });
  assert.equal(itemSuffixFactor(record(1), TABLES), 70, "head: column 0");
  assert.equal(itemSuffixFactor(record(3), TABLES), 52, "shoulders: column 1");
  assert.equal(itemSuffixFactor(record(11), TABLES), 39, "finger: column 2");
  assert.equal(itemSuffixFactor(record(13), TABLES), 30, "one-hand: column 3");
  assert.equal(itemSuffixFactor(record(15), TABLES), 22, "ranged: column 4");
  assert.equal(itemSuffixFactor(record(4), TABLES), 70, "a shirt is column 0 in Wow.exe (TrinityCore says none)");
  assert.equal(itemSuffixFactor(record(28), TABLES), 0, "a relic has no column");
  assert.equal(itemSuffixFactor(record(1, 3), TABLES), 80, "Superior");
  assert.equal(itemSuffixFactor(record(1, 4), TABLES), 91, "Epic");
  assert.equal(itemSuffixFactor(record(1, 1), TABLES), 0, "Common has none");
  assert.equal(itemSuffixFactor({ itemLevel: 1, quality: 2, inventoryType: 1 }, TABLES), 0, "no row for the level");
});

test("0x00577260 and 0x0061fa20: `$i` is the amount; a suffix's amount goes to every effect, a property's is its own", () => {
  assert.equal(itemEnchantText("+$i к интеллекту", 19), "+19 к интеллекту");
  assert.equal(itemEnchantText("$$i и $n", 4), "$4 и $n", "a `$` before anything else stays");
  assert.deepEqual(itemRandomStatEffects(-10, 30, TABLES), [{ type: 5, arg: 5, amount: 19 }, { type: 5, arg: 7, amount: 9 }]);
  assert.deepEqual(itemRandomStatEffects(25, 0, TABLES), [{ type: 5, arg: 3, amount: 7 }, { type: 4, arg: 3, amount: 4 }],
    "(min + max) / 2, cut toward zero");
  assert.deepEqual(itemRandomStatEffects(-99, 30, TABLES), [], "a missing row gives nothing");
});

test("itemLinkRandom: the seventh and eighth numbers of a link", () => {
  assert.deepEqual(itemLinkRandom("|cff1eff00|Hitem:9999:0:0:0:0:0:-10:30:80|h[x]|h|r"), { id: -10, factor: 30 });
  assert.deepEqual(itemLinkRandom("item:9999"), { id: 0, factor: 0 });
  assert.deepEqual(itemLinkRandom(undefined), { id: 0, factor: 0 });
});

test("itemRandomTables: only an answer that carried the tables", () => {
  const maps = { randomProperties: new Map(), randomSuffixes: new Map(), randPropPoints: new Map(), enchantments: new Map() };
  assert.equal(itemRandomTables({ ...maps, randomReady: false }), undefined, "an older gateway");
  assert.ok(itemRandomTables({ ...maps, randomReady: true }));
  assert.equal(itemRandomTables(undefined), undefined);
});

function template(overrides = {}) {
  return {
    found: true, entry: 9999, name: "Штаны", quality: 2, itemClass: 4, subClass: 2, inventoryType: 7, itemLevel: 200,
    flags: 0, maxCount: 0, bonding: 0, containerSlots: 0, block: 0, damage: [{ min: 0, max: 0, type: 0 }], delay: 0,
    resistances: [100, 0, 0, 0, 0, 0, 0], stats: [{ type: 7, value: 12 }], requiredLevel: 1, maxDurability: 0, spells: [],
    requiredSkill: 0, requiredSkillRank: 0, requiredReputationFaction: 0, requiredReputationRank: 0,
    allowableClass: 0xffff_ffff, allowableRace: 0xffff_ffff, sockets: [{ color: 2, content: 0 }], socketBonus: 3000,
    gemProperties: 0, startQuest: 0, description: "", sellPrice: 0, stackable: 1, randomProperty: 0, randomSuffix: 0,
    duration: 0, ...overrides,
  };
}
const ENCHANTS = new Map([
  [2804, { name: "+$i к интеллекту" }], [2805, { name: "+$i к выносливости" }], [3000, { name: "+4 к силе" }],
]);
const stock = (random, extra = {}) => itemTooltipContent({ entry: 9999, template: template(extra.template) }, {
  layout: "stock", compare: false, enchantment: (id) => ENCHANTS.get(id), randomTables: TABLES,
  ...(random ? { random } : {}), ...(extra.context ?? {}),
});
const texts = (content) => (content.lines ?? []).map((line) => (typeof line === "string" ? line : line.text));

test("the stock tooltip: the suffixed title, slots 7..11 white after the sockets and before the socket bonus", () => {
  const suffixTemplate = globalString("ITEM_SUFFIX_TEMPLATE");
  const content = stock({ id: -10, factor: 30 });
  assert.equal(content.title, itemRandomDisplayName("Штаны", -10, TABLES, suffixTemplate));
  const rows = texts(content);
  const intellect = rows.indexOf("+19 к интеллекту");
  assert.ok(intellect >= 0, rows.join(" | "));
  assert.equal(rows[intellect + 1], "+9 к выносливости");
  const socket = rows.findIndex((text) => text === globalString("EMPTY_SOCKET_YELLOW"));
  const bonus = rows.findIndex((text) => text.includes("+4 к силе"));
  assert.ok(socket < intellect && intellect < bonus, rows.join(" | "));
  const line = content.lines.find((row) => typeof row !== "string" && row.text === "+19 к интеллекту");
  assert.equal(line.tone, undefined, "white like the base stats (0x00ad2d30)");
  assert.equal(line.color, undefined);
});

test("an object's slots and RandPropPoints factor; an object without a property; the record alone", () => {
  const object = stock({ id: -10, slots: [2804, 0, 0, 0, 0] });
  assert.ok(texts(object).includes("+46 к интеллекту"), "6666 × 0.0001 × 70 (uncommon legs, level 200) = 46.66 → 46");
  assert.equal(texts(object).filter((text) => text.includes("к выносливости")).length, 1,
    "the object's own slots, not the row's: only the record's stamina line");
  const plain = stock({ id: 0, slots: [0, 0, 0, 0, 0] }, { template: { randomSuffix: 5 } });
  assert.ok(!texts(plain).includes(globalString("ITEM_RANDOM_ENCHANT")), "an object never says it");
  const record = stock(undefined, { template: { randomSuffix: 5 } });
  const random = globalString("ITEM_RANDOM_ENCHANT");
  if (random) {
    const rows = texts(record);
    const at = rows.indexOf(random);
    assert.ok(at > rows.findIndex((text) => text.includes("+4 к силе")), "after the socket bonus");
    assert.equal(record.lines[at].tone, "spell", "green (0x00ad2d40)");
  }
  assert.ok(!texts(stock(undefined)).includes(random), "a record without a random property");
  const early = itemTooltipContent({ entry: 9999, template: template() }, {
    layout: "stock", compare: false, enchantment: (id) => ENCHANTS.get(id), random: { id: -10, factor: 30 },
  });
  assert.equal(early.title, "Штаны", "the bare name before the tables land");
  assert.ok(!texts(early).some((text) => text.includes("$i") || text.includes("к интеллекту")), "no `$i` line without them");
  const earlyObject = itemTooltipContent({ entry: 9999, template: template() }, {
    layout: "stock", compare: false, enchantment: (id) => ENCHANTS.get(id), random: { id: -10, slots: [2804, 3000, 0, 0, 0] },
  });
  assert.ok(!texts(earlyObject).some((text) => text.includes("к интеллекту")), "an object's `$i` line waits for the tables too");
  assert.equal(texts(earlyObject).filter((text) => text === "+4 к силе").length, 1,
    "a line without `$i` needs no amount (here also the socket bonus' name, which is drawn through its template)");
});

test("the stat table adds the link's random effects; a random link is known once its effects are", () => {
  const base = { stats: [], resistances: [0, 0, 0, 0, 0, 0, 0], block: 0, damage: [], delay: 0, sockets: [] };
  const table = gameTooltipItemStats({ ...base, randomEffects: [
    { type: 5, arg: 7, amount: 9 }, { type: 5, arg: 38, amount: 20 }, { type: 4, arg: 3, amount: 5 },
    { type: 3, arg: 9999, amount: 0, auras: [{ aura: 99, misc: 0, basePoints: 29 }] },
  ] });
  assert.equal(table[1 + 11 + 7], 9, "stamina");
  assert.equal(table[1 + 3], 5, "nature resistance");
  // ITEM_MOD_ATTACK_POWER 20 into melee and ranged, MOD_ATTACK_POWER 30 into melee; the merge shows the parts.
  assert.equal(table[1 + 8], 50);
  assert.equal(table[1 + 9], 20);
  const link = "|Hitem:9999:0:0:0:0:0:-10:30:80|h[x]|h";
  assert.equal(gameTooltipStatTableKnown({ ...base, randomEffects: null }, link), false, "the tables on their way");
  assert.equal(gameTooltipStatTableKnown({ ...base }, link), false);
  assert.equal(gameTooltipStatTableKnown({ ...base, randomEffects: [] }, link), true);
  assert.equal(gameTooltipStatTableKnown({ ...base, scalingStatValue: 1, randomEffects: [] }, link), false, "a heirloom still is not");
});

test("frameXmlRandomEffects: a type-3 spell's auras, whatever its attributes; null while a row is missing", () => {
  const tables = { ...TABLES, property: (id) => (id === 30 ? { name: "x", enchantments: [80, 0, 0, 0, 0] } : undefined),
    enchantment: (id) => (id === 80 ? { name: "x", effects: [[3, 0, 0, 555], [0, 0, 0, 0], [0, 0, 0, 0]] } : TABLES.enchantment(id)) };
  const row = { passive: false, effects: [6, 0, 0], effectAura: [99, 0, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [14, 0, 0] };
  const asked = [];
  assert.equal(frameXmlRandomEffects({ id: 30, factor: 0 }, tables, () => undefined, (ids) => asked.push(...ids)), null);
  assert.deepEqual(asked, [555]);
  assert.deepEqual(frameXmlRandomEffects({ id: 30, factor: 0 }, tables, () => row),
    [{ type: 3, arg: 555, amount: 0, auras: [{ aura: 99, misc: 0, basePoints: 14 }] }]);
  assert.equal(frameXmlRandomEffects({ id: -10, factor: 30 }, undefined, () => row), null, "no tables yet");
});

test("live: the adapter's link brings the random suffix — title, `$i` lines with the link's factor", async () => {
  const { game } = await import("../dist/code/browser/game/Context.js");
  const { itemEnchantments } = await import("../dist/code/browser/ItemEnchantments.js");
  const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");
  const { resetStockTooltipRedraws } = await import("../dist/code/browser/ui/ItemTooltip.js");
  const origin = "http://random-312.test";
  const client = itemEnchantments(origin);
  client.enchantments.set(2804, { id: 2804, name: "+$i к интеллекту", gemItemId: 0, conditionId: 0 });
  client.randomSuffixes.set(10, { id: 10, name: "со знаком гориллы", enchantments: [2804, 0, 0, 0, 0], allocation: [6666, 0, 0, 0, 0] });
  client.ready = true;
  client.randomReady = true;
  const previousOrigin = game.gatewayOrigin;
  game.gatewayOrigin = origin;
  game.world = {
    state: { selfGuid: undefined, objects: new Map() },
    itemTemplate: (entry) => (entry === 9999 ? template({ sockets: [], socketBonus: 0 }) : undefined),
    events: { on: () => () => {} },
  };
  try {
    const adapter = createFrameXmlCharacterTooltipAdapter({ itemInfo: () => undefined });
    const linked = adapter.item(9999, "|cff1eff00|Hitem:9999:0:0:0:0:0:-10:30:80|h[Штаны]|h|r");
    assert.equal(linked.title, itemRandomDisplayName("Штаны", -10, itemRandomTables(client), globalString("ITEM_SUFFIX_TEMPLATE")));
    assert.ok(texts(linked).includes("+19 к интеллекту"), texts(linked).join(" | "));
    const bare = adapter.item(9999, "item:9999:0:0:0:0:0:0:0:80");
    assert.equal(bare.title, "Штаны", "a link naming none is the record alone");
  } finally {
    resetStockTooltipRedraws();
    game.world = undefined;
    game.gatewayOrigin = previousOrigin;
  }
});

test("the enchantment client keeps the random tables and the effects; an older answer leaves them unready", async () => {
  const { ItemEnchantmentClient } = await import("../dist/code/browser/ItemEnchantments.js");
  const previous = globalThis.fetch;
  const answer = (body) => { globalThis.fetch = async () => ({ ok: true, json: async () => body }); };
  try {
    answer({
      enchantments: [{ id: 2804, name: "+$i", gemItemId: 0, conditionId: 0, effects: [[5, 0, 0, 5], [0, 0, 0, 0], [0, 0, 0, 0]] },
        { id: 2805, name: "x", gemItemId: 0, conditionId: 0, effects: [[5, 0]] }],
      gems: [],
      randomProperties: [{ id: 24, name: "со знаком силы", enchantments: [70, 0, 0, 0, 0] }, { id: 25, name: "x", enchantments: [1] }],
      randomSuffixes: [{ id: 10, name: "со знаком гориллы", enchantments: [2804, 0, 0, 0, 0], allocation: [6666, 0, 0, 0, 0] },
        { id: 11, name: "без долей", enchantments: [2804, 0, 0, 0, 0] }],
      randPropPoints: [{ level: 200, epic: [1, 2, 3, 4, 5], rare: [1, 2, 3, 4, 5], uncommon: [1, 2, 3, 4, 5] }],
    });
    const client = new ItemEnchantmentClient("http://a.test");
    await client.load();
    assert.equal(client.randomReady, true);
    assert.deepEqual(client.enchantments.get(2804).effects[0], [5, 0, 0, 5]);
    assert.equal(client.enchantments.get(2805).effects, undefined, "malformed effects dropped, the row kept");
    assert.equal(client.randomProperties.get(24).name, "со знаком силы");
    assert.equal(client.randomProperties.has(25), false, "a malformed row skipped");
    assert.deepEqual(client.randomSuffixes.get(10).allocation, [6666, 0, 0, 0, 0]);
    assert.equal(client.randomSuffixes.has(11), false, "a suffix without its shares is skipped");
    assert.ok(client.randPropPoints.has(200));
    answer({ enchantments: [{ id: 1, name: "x", gemItemId: 0, conditionId: 0 }], gems: [] });
    const older = new ItemEnchantmentClient("http://b.test");
    await older.load();
    assert.equal(older.ready, true);
    assert.equal(older.randomReady, false, "a gateway from before ?v=3");
  } finally {
    globalThis.fetch = previous;
  }
});

test("the tooltip extras adapter: a random link's itemStats carries its effects once the tables are there", async () => {
  const { frameXmlTooltipExtrasAdapter } = await import("../dist/code/browser/framexml/FrameXmlTooltipExtrasAdapter.js");
  const { itemEnchantments } = await import("../dist/code/browser/ItemEnchantments.js");
  const origin = "http://extras-312.test";
  const client = itemEnchantments(origin);
  client.ready = true;
  const record = { found: true, scalingStatValue: 0, spells: [], stats: [], resistances: [0, 0, 0, 0, 0, 0, 0], block: 0, damage: [], delay: 0, sockets: [] };
  const world = { world: { itemTemplates: new Map([[9999, record]]), questTemplates: new Map() }, spells: new Map(), gatewayOrigin: origin };
  const adapter = frameXmlTooltipExtrasAdapter({}, () => world, () => undefined, () => {});
  const link = "|Hitem:9999:0:0:0:0:0:-10:30:80|h[x]|h";
  assert.equal(adapter.itemStats(9999, link).randomEffects, null, "the tables not there yet");
  client.enchantments.set(2804, { id: 2804, name: "+$i", gemItemId: 0, conditionId: 0, effects: [[5, 0, 0, 5], [0, 0, 0, 0], [0, 0, 0, 0]] });
  client.randomSuffixes.set(10, { id: 10, name: "x", enchantments: [2804, 0, 0, 0, 0], allocation: [6666, 0, 0, 0, 0] });
  client.randomReady = true;
  assert.deepEqual(adapter.itemStats(9999, link).randomEffects, [{ type: 5, arg: 5, amount: 19 }]);
  assert.equal("randomEffects" in adapter.itemStats(9999, "item:9999"), false, "a link naming none");
});
