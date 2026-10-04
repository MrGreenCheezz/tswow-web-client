import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.12 (04.10, L4): the stat difference a shopping tooltip draws under the equipped item,
// as Wow.exe 3.3.5a 12340 builds it (read 2026-10-04): the per-item table 0x0061f4c0 (stats
// 0x0061b990, armour and resistances, sockets 0x0061b930, block, DPS 0x0061f410), the merges
// 0x0061ba90/0x0061b9e0, the difference 0x0061dbc0 (hovered − equipped, merged again) and the rows
// 0x0062d930/0x00623810/0x006237c0.
const {
  gameTooltipItemStats, gameTooltipStatDelta, gameTooltipStatDeltaRows, GAME_TOOLTIP_STAT_SLOTS,
} = await import("../dist/code/browser/glue/GlueTooltipStatDelta.js");

const STRINGS = {
  ITEM_DELTA_DESCRIPTION: "Если вы замените этот предмет, произойдут следующие изменения характеристик:",
  ITEM_MOD_DAMAGE_PER_SECOND_SHORT: "к урону в секунду",
  ITEM_MOD_STAMINA_SHORT: "к выносливости",
  ITEM_MOD_STRENGTH_SHORT: "к силе",
  ITEM_MOD_ATTACK_POWER_SHORT: "к силе атаки",
  ITEM_MOD_MELEE_ATTACK_POWER_SHORT: "к силе атаки в ближнем бою",
  ITEM_MOD_RANGED_ATTACK_POWER_SHORT: "к силе атаки дальнего боя",
  ITEM_MOD_SPELL_POWER_SHORT: "к силе заклинаний",
  ITEM_MOD_SPELL_HEALING_DONE_SHORT: "к исцелению",
  ITEM_MOD_SPELL_DAMAGE_DONE_SHORT: "к урону от заклинаний",
  ITEM_MOD_HIT_RATING_SHORT: "к рейтингу меткости",
  ITEM_MOD_HIT_MELEE_RATING_SHORT: "к рейтингу меткости в ближнем бою",
  ITEM_MOD_POWER_REGEN0_SHORT: "маны в 5 сек.",
  ITEM_MOD_BLOCK_VALUE_SHORT: "к показателю блокирования",
  RESISTANCE0_NAME: "к броне",
  RESISTANCE2_NAME: "к сопротивлению огню",
  EMPTY_SOCKET_RED: "красное гнездо",
  EMPTY_SOCKET_META: "особое гнездо",
};
const g = (key) => STRINGS[key];

const item = (over = {}) => ({
  stats: [], resistances: [0, 0, 0, 0, 0, 0, 0], block: 0, damage: [{ min: 0, max: 0 }, { min: 0, max: 0 }],
  delay: 0, sockets: [{ color: 0 }, { color: 0 }, { color: 0 }], ...over,
});
const at = (table, statIndex) => table[1 + statIndex];

test("the per-item table: stat types at 11+type, attack power split, armour, resistances, sockets, block, DPS", () => {
  const table = gameTooltipItemStats(item({
    stats: [{ type: 7, value: 20 }, { type: 38, value: 40 }, { type: 39, value: 10 }, { type: 4, value: 5 }],
    resistances: [300, 0, 12, 0, 0, 0, 0], block: 25,
    damage: [{ min: 100, max: 200 }, { min: 10, max: 20 }], delay: 3000,
    sockets: [{ color: 2 }, { color: 14 }, { color: 1 }],
  }));
  assert.equal(table.length, GAME_TOOLTIP_STAT_SLOTS);
  assert.equal(at(table, 18), 20, "stamina (type 7) at 11 + 7");
  assert.equal(at(table, 15), 5, "strength (type 4)");
  // Type 38 adds to melee (8) and ranged (9) attack power, type 39 to ranged only; the merge then
  // keeps them apart (40 against 50) and leaves the combined attack power (7) at 0.
  assert.equal(at(table, 8), 40);
  assert.equal(at(table, 9), 50);
  assert.equal(at(table, 7), 0);
  assert.equal(at(table, 0), 300, "armour");
  assert.equal(at(table, 2), 12, "fire resistance");
  assert.equal(at(table, 60), 25, "the shield's block value");
  assert.deepEqual([69, 70, 71, 72].map((index) => at(table, index)), [1, 2, 1, 1], "meta, red, yellow, blue sockets by colour bit");
  // (100+200)·0.5 / (3000·0.001) + (10+20)·0.5 / 3 in float32: 50 + 5, a hair under (0.001f is not 0.001).
  assert.ok(Math.abs(table[0] - 55) < 1e-4, String(table[0]));
  assert.equal(table[0].toFixed(1), "55.0");
});

test("the merges: equal melee/ranged attack power become attack power, spell power, ratings, mana per 5", () => {
  const table = gameTooltipItemStats(item({
    stats: [{ type: 38, value: 30 }, { type: 45, value: 19 }, { type: 31, value: 8 }, { type: 43, value: 6 }],
  }));
  assert.equal(at(table, 7), 30, "attack power shown as one");
  assert.equal(at(table, 8), 0);
  assert.equal(at(table, 9), 0);
  assert.equal(at(table, 56), 19, "spell power (type 45) stays spell power");
  assert.equal(at(table, 52), 0);
  assert.equal(at(table, 53), 0);
  assert.equal(at(table, 42), 8, "hit rating (type 31)");
  assert.equal(at(table, 61), 6, "mana regeneration (type 43) is shown as POWER_REGEN0");
  assert.equal(at(table, 54), 0);
  // An old item: healing 22 and damage 7 differ, so spell power stays 0 and both stay.
  const old = gameTooltipItemStats(item({ stats: [{ type: 41, value: 22 }, { type: 42, value: 7 }] }));
  assert.deepEqual([at(old, 56), at(old, 52), at(old, 53)], [0, 22, 7]);
  // Melee hit 5 alone: the three hit kinds differ (5, 0, 0), so nothing is merged.
  const melee = gameTooltipItemStats(item({ stats: [{ type: 16, value: 5 }] }));
  assert.deepEqual([at(melee, 42), at(melee, 27), at(melee, 28)], [0, 5, 0]);
});

test("the difference is hovered − equipped, merged again; the rows are the client's", () => {
  const hovered = gameTooltipItemStats(item({
    stats: [{ type: 7, value: 30 }, { type: 45, value: 10 }], resistances: [500, 0, 0, 0, 0, 0, 0],
    damage: [{ min: 50, max: 100 }, { min: 0, max: 0 }], delay: 2000, sockets: [{ color: 2 }, { color: 0 }, { color: 0 }],
  }));
  const worn = gameTooltipItemStats(item({
    stats: [{ type: 7, value: 40 }, { type: 4, value: 12 }, { type: 41, value: 19 }, { type: 42, value: 7 }],
    resistances: [500, 0, 0, 0, 0, 0, 0], damage: [{ min: 40, max: 80 }, { min: 0, max: 0 }], delay: 2000,
  }));
  const delta = gameTooltipStatDelta(hovered, worn);
  assert.equal(at(delta, 18), -10);
  assert.equal(at(delta, 15), -12);
  assert.equal(at(delta, 0), 0, "same armour: no row");
  // Spell power 10 against healing 19 / damage 7: spread again — healing −9, damage +3.
  assert.deepEqual([at(delta, 56), at(delta, 52), at(delta, 53)], [0, -9, 3]);
  const rows = gameTooltipStatDeltaRows(delta, g);
  assert.deepEqual(rows.map((row) => row.text), [
    " ",
    STRINGS.ITEM_DELTA_DESCRIPTION,
    "|cff00ff00+7.5|r к урону в секунду",
    "|cffff2020-12|r к силе",
    "|cffff2020-10|r к выносливости",
    "|cffff2020-9|r к исцелению",
    "|cff00ff00+3|r к урону от заклинаний",
    "|cff00ff00+1|r |TInterface\\ItemSocketingFrame\\UI-EmptySocket-Red.blp:12|t  красное гнездо",
  ]);
  assert.equal(rows[1].wrap, true, "the header wraps");
  assert.deepEqual([rows[0].color, rows[1].color].map((c) => [c.r, c.g, c.b].map((v) => Math.round(v * 255))),
    [[255, 210, 0], [255, 210, 0]], "blank row and header in the client's gold");
  assert.deepEqual([rows[2].color.r, rows[2].color.g, rows[2].color.b], [1, 1, 1], "each change on a white row");
});

test("no change, no rows; a weapon against armour has no DPS row (0/0 is not a number)", () => {
  const same = gameTooltipItemStats(item({ stats: [{ type: 7, value: 3 }] }));
  assert.deepEqual(gameTooltipStatDeltaRows(gameTooltipStatDelta(same, gameTooltipItemStats(item({ stats: [{ type: 7, value: 3 }] }))), g), []);
  const weapon = gameTooltipItemStats(item({ damage: [{ min: 10, max: 20 }, { min: 0, max: 0 }], delay: 1500, block: 0 }));
  const shield = gameTooltipItemStats(item({ resistances: [1000, 0, 0, 0, 0, 0, 0], block: 30 }));
  const rows = gameTooltipStatDeltaRows(gameTooltipStatDelta(shield, weapon), g).map((row) => row.text);
  assert.deepEqual(rows, [" ", STRINGS.ITEM_DELTA_DESCRIPTION, "|cff00ff00+1000|r к броне", "|cff00ff00+30|r к показателю блокирования"]);
  // The attack-power pair (49, 50) is never written as its own row.
  const ap = gameTooltipStatDeltaRows(gameTooltipStatDelta(gameTooltipItemStats(item({ stats: [{ type: 38, value: 20 }] })),
    gameTooltipItemStats(item())), g).map((row) => row.text);
  assert.deepEqual(ap.slice(2), ["|cff00ff00+20|r к силе атаки"]);
});
