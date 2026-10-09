import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

// 4.03: the native character sheet's rows (ui/CharacterSheetModel.ts) — the stock PaperDoll's four
// combat categories with its values and tooltips, and the title picker's list.
const { characterStatSections, damageText, titleChoices } = await import("../dist/code/browser/ui/CharacterSheetModel.js");
const { setStringSource } = await import("../dist/code/browser/ui/Strings.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const scratch = new DataView(new ArrayBuffer(4));
const floatBits = (value) => { scratch.setFloat32(0, value, true); return scratch.getUint32(0, true); };

function player(entries) {
  const fields = new Map();
  for (const [name, value, index = 0] of entries) {
    fields.set(UPDATE_FIELDS[name].offset + index, UPDATE_FIELDS[name].type === "FLOAT" ? floatBits(value) : value >>> 0);
  }
  return { guid: 1n, typeId: 4, fields };
}

// No local GlobalStrings: every label is the fallback, so the test reads the same on any checkout.
setStringSource(() => undefined);
afterEach(() => setStringSource(() => undefined));

const PALADIN = 2;
/** Every rating worth 1 % per 10 points at any level: divisor 10, class scalar 1 (CharacterStatData). */
const catalog = {
  spellCritBase: [0, 0], spellCritPerIntellect: Array(200).fill(0),
  combatRatingPerLevel: Array(2500).fill(10),
  combatRatingScalar: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [32 + index + 1, 1])),
};
const context = (overrides = {}) => ({
  classId: PALADIN, level: 80, catalog: undefined, defenseSkill: { value: 400, temporaryBonus: 0, permanentBonus: 0 },
  hasMana: true, rangedWeapon: true, ...overrides,
});
const sectionOf = (sections, key) => sections.find((entry) => entry.key === key);
const rowOf = (sections, key, label) => sectionOf(sections, key).rows.find((entry) => entry.label === label);

test("the four stock categories in stock order, after the base stats", () => {
  const sections = characterStatSections(player([]), context());
  assert.deepEqual(sections.map((entry) => entry.key), ["base", "melee", "ranged", "spell", "defenses"]);
  assert.deepEqual(sections.map((entry) => entry.title), ["Основные", "Ближний бой", "Дальний бой", "Магия", "Защита"]);
  assert.deepEqual(sectionOf(sections, "melee").rows.map((entry) => entry.label),
    ["Урон", "Скорость", "Сила атаки", "Рейт. меткости", "Крит. удар", "Мастерство"]);
  assert.deepEqual(sectionOf(sections, "spell").rows.map((entry) => entry.label),
    ["Доп. урон", "Доп. лечение", "Рейт. меткости", "Крит. удар", "Рейт. скорости", "Восп. маны"]);
});

test("attack power prints base + both modifiers, with the breakdown and the DPS sentence in the tooltip", () => {
  const sections = characterStatSections(player([
    ["UNIT_FIELD_ATTACK_POWER", 1500], ["UNIT_FIELD_ATTACK_POWER_MODS", ((0xfff6 << 16) | 100) >>> 0],
  ]), context());
  const power = rowOf(sections, "melee", "Сила атаки");
  assert.equal(power.value, "1590");
  assert.equal(power.tone, "debuff", "a negative modifier tints the total red, as PaperDollFormatStat does");
  assert.equal(power.tip.split("\n")[0], "Сила атаки ближнего боя: 1590 (1500 +100 -10)");
  assert.match(power.tip, /на 113\.6 ед\. урона в секунду/);
});

test("rating rows: the rating always, its percentage only with the rating tables", () => {
  const object = player([["PLAYER_FIELD_COMBAT_RATING_1", 263, 5], ["PLAYER_FIELD_COMBAT_RATING_1", 40, 24]]);
  const bare = rowOf(characterStatSections(object, context()), "melee", "Рейт. меткости");
  assert.equal(bare.value, "263");
  assert.equal(bare.tip, undefined, "no table, no invented percentage");
  const full = rowOf(characterStatSections(object, context({ catalog })), "melee", "Рейт. меткости");
  assert.match(full.tip, /цели 80-го уровня .* на 26\.30%\.\n\nРейтинг пробивания брони 40 \(\+4\.00%\)/s);
});

test("defence needs the rating tables for its rating points; without them the row is left out", () => {
  const object = player([["PLAYER_FIELD_COMBAT_RATING_1", 49, 1]]); // CR_DEFENSE_SKILL
  assert.equal(rowOf(characterStatSections(object, context()), "defenses", "Защита"), undefined);
  const row = rowOf(characterStatSections(object, context({ catalog })), "defenses", "Защита");
  assert.equal(row.value, "404", "400 skill + trunc(4.9) rating points");
  assert.match(row.tip, /Рейтинг защиты: 49 \(\+4 защиты\)/);
  assert.match(row.tip, /повышена на 0\.16%/, "(404 − 400) × 0.04");
});

test("spell rows: the lowest magic school, every school in the tooltip; mana regen per five seconds", () => {
  const object = player([
    ...[2, 3, 4, 5, 6, 7].map((school) => ["PLAYER_FIELD_MOD_DAMAGE_DONE_POS", 400 + school, school - 1]),
    ["PLAYER_FIELD_MOD_DAMAGE_DONE_POS", 5, 0], // physical is not a spell school
    ...[2, 3, 4, 5, 6, 7].map((school) => ["PLAYER_SPELL_CRIT_PERCENTAGE1", 10 + school / 4, school - 1]),
    ["UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER", 12.99], ["UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER", 3.1],
  ]);
  const sections = characterStatSections(object, context());
  const damage = rowOf(sections, "spell", "Доп. урон");
  assert.equal(damage.value, "402");
  assert.deepEqual(damage.tip.split("\n").slice(1), ["свет: 402", "огонь: 403", "природа: 404", "лед: 405", "тьма: 406", "тайная магия: 407"]);
  assert.equal(rowOf(sections, "spell", "Крит. удар").value, "10.50%");
  const mana = rowOf(sections, "spell", "Восп. маны");
  assert.equal(mana.value, "64");
  assert.match(mana.tip, /Восполнение маны: 64 .*\n15 /s);
  assert.equal(rowOf(characterStatSections(object, context({ hasMana: false })), "spell", "Восп. маны").value, "НЕТ");
});

test("ranged rows say «НЕТ» without a ranged weapon; damage text as the stock row writes it", () => {
  const sections = characterStatSections(player([]), context({ rangedWeapon: false }));
  assert.equal(sectionOf(sections, "ranged").rows[0].value, "НЕТ");
  assert.equal(sectionOf(sections, "ranged").rows[1].value, "НЕТ");
  assert.equal(damageText({ min: 50.6, max: 80.2 }), "50 - 81");
  assert.equal(damageText({ min: 150, max: 220.01 }), "150-221");
  assert.equal(damageText({ min: 0, max: 0 }), "1 - 1");
});

test("armour: the stock reduction sentence (%0.2f) at the player's level, and a hunter's pet share", () => {
  const object = player([
    ["UNIT_FIELD_RESISTANCES", 520], ["UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE", 25], ["UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE", -5],
  ]);
  const armor = rowOf(characterStatSections(object, context()), "defenses", "Броня");
  assert.equal(armor.value, "520");
  // PaperDollFrame_GetArmorReduction(520, 80): 0.1·520 / (8.5·174.5 + 40), then t/(1+t) → 3.30 %.
  assert.deepEqual(armor.tip.split("\n"), ["Броня: 520 (500 +25 -5)", "Получаемый физический урон снижен на 3.30%."]);
  const hunter = rowOf(characterStatSections(object, context({ classId: 3 })), "defenses", "Броня");
  assert.equal(hunter.tip.split("\n")[2], "Увеличивает броню питомца на 182.", "ComputePetBonus: 520 × 0.35");
  assert.equal(rowOf(characterStatSections(player([["UNIT_FIELD_RESISTANCES", 1e6]]), context()), "defenses", "Броня")
    .tip.split("\n")[1], "Получаемый физический урон снижен на 75.00%.", "capped at 75");
});

test("resilience: the stock three-part sentence, the middle part capped by GetMaxCombatRatingBonus", () => {
  const object = player([
    ["PLAYER_FIELD_COMBAT_RATING_1", 250, 14], ["PLAYER_FIELD_COMBAT_RATING_1", 260, 15], ["PLAYER_FIELD_COMBAT_RATING_1", 270, 16],
  ]);
  assert.equal(rowOf(characterStatSections(object, context()), "defenses", "Устойчивость").tip, undefined);
  const row = rowOf(characterStatSections(object, context({ catalog })), "defenses", "Устойчивость");
  assert.equal(row.value, "250");
  // Bonus 25.00; 25 × 2.2 = 55 capped at Wow.exe's 33 (0x006082c0); 25 × 2.0 = 50.
  assert.deepEqual(row.tip.split("\n"), ["Устойчивость: 250",
    "Снижает вероятность того, что противник нанесет вам критический удар, на 25.00%",
    "Понижает эффективность похищения маны и урон, получаемый от критических ударов, на 33.00%.",
    "Снижает весь урон, получаемый от других игроков, их питомцев и прислужников, еще на 50.00%."]);
});

test("L7 4.03: a hunter's and a warlock's pet shares in the stamina, intellect and ranged attack power rows", () => {
  // ComputePetBonus (PaperDollFrame.lua:46-64, :1662-1680): HUNTER RAP→AP 0.22, RAP→spell 0.1287, STAM 0.3;
  // WARLOCK STAM 0.3, INT 0.3; any other class nothing.
  const object = player([
    ["UNIT_FIELD_STAT0", 100, 2], ["UNIT_FIELD_STAT0", 200, 3],
    ["UNIT_FIELD_RANGED_ATTACK_POWER", 2000], ["UNIT_FIELD_RANGED_ATTACK_POWER_MODS", 100],
  ]);
  const lines = (sections, key, label) => rowOf(sections, key, label).tip?.split("\n") ?? [];
  const hunter = characterStatSections(object, context({ classId: 3 }));
  assert.deepEqual(lines(hunter, "base", "Выносливость").slice(1), ["Увеличивает выносливость питомца на 30."]);
  assert.deepEqual(lines(hunter, "base", "Интеллект").slice(1), [], "a hunter's table has PET_BONUS_INT 0");
  assert.deepEqual(lines(hunter, "ranged", "Сила атаки").slice(1), [
    "Увеличивает урон от оружия дальнего боя на 150.0 ед. урона в секунду.",
    "Увеличивает силу атаки питомца на 462.",
    "Увеличивает урон от заклинаний питомца на 270.",
  ], "2100 × 0.22 = 462, 2100 × 0.1287 = 270.27 → %d 270");
  const warlock = characterStatSections(object, context({ classId: 9 }));
  assert.deepEqual(lines(warlock, "base", "Выносливость").slice(1), ["Увеличивает выносливость питомца на 30."]);
  assert.deepEqual(lines(warlock, "base", "Интеллект").slice(1), ["Увеличивает интеллект питомца на 60."]);
  assert.equal(lines(warlock, "ranged", "Сила атаки").length, 2, "a warlock's RAP shares are 0: the stock line alone");
  const paladin = characterStatSections(object, context());
  assert.equal(rowOf(paladin, "base", "Выносливость").tip.includes("питомца"), false);
});

test("L7 4.03: GetMaxCombatRatingBonus answers Wow.exe's two doubles, never nil", async () => {
  const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
  const { maxCombatRatingBonus } = await import("../dist/code/browser/ui/CharacterSheetModel.js");
  for (const index of [1, 14, 15, 16, 17, 18, 25]) {
    assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMaxCombatRatingBonus({}, [index]), [maxCombatRatingBonus(index)], `CR ${index}`);
  }
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMaxCombatRatingBonus({}, [1]), [-1]);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetMaxCombatRatingBonus({}, [16]), [33.000001311302185]);
});

test("L7 4.03: the spell formula operand $AP rounds each part as UnitAttackPower does", async () => {
  const fields = await import("../dist/code/world/Fields.js");
  const stats = await import("../dist/code/world/CharacterStatFields.js");
  // +10 % attack power: 1501 × 1.1 = 1651.1 → 1651, 101 × 1.1 = 111.1 → 111, −11 × 1.1 = −12.1 → −12.
  const cases = [
    [1501, 101, -11, 0.1], [1000, 0, 0, 0], [1335, 45, 0, 0.1], [7, 0, 0, 0.5], [9, 0, 0, 0.5], [0, 0, -50, 0],
  ];
  for (const [base, positive, negative, multiplier] of cases) {
    const object = player([
      ["UNIT_FIELD_ATTACK_POWER", base], ["UNIT_FIELD_ATTACK_POWER_MODS", ((negative & 0xffff) << 16 | (positive & 0xffff)) >>> 0],
      ["UNIT_FIELD_ATTACK_POWER_MULTIPLIER", multiplier],
    ]);
    assert.equal(fields.attackPower(object), stats.attackPower(object).effective, JSON.stringify([base, positive, negative, multiplier]));
  }
  const buffed = player([["UNIT_FIELD_ATTACK_POWER", 1501], ["UNIT_FIELD_ATTACK_POWER_MODS", (((-11) & 0xffff) << 16 | 101) >>> 0],
    ["UNIT_FIELD_ATTACK_POWER_MULTIPLIER", 0.1]]);
  assert.equal(fields.attackPower(buffed), 1651 + 111 - 12, "summed then scaled it was 1750.1");
  assert.equal(fields.attackPower(player([])), undefined, "no field: no operand");
});

test("the client's \\n escape in a GlobalStrings template becomes a tooltip line break", () => {
  setStringSource((key) => key === "BONUS_HEALING_TOOLTIP" ? "Первая\\nвторая %d" : undefined);
  const row = rowOf(characterStatSections(player([["PLAYER_FIELD_MOD_HEALING_DONE_POS", 7]]), context()), "spell", "Доп. лечение");
  assert.deepEqual(row.tip.split("\n"), ["Доп. лечение", "Первая", "вторая 7"]);
});

test("title picker: «Нет» first, known titles by name, nothing at all without a known title", () => {
  const names = { 1: "Рядовой ", 5: "Чемпион Наару", 9: " Анти-герой", 12: "Безымянный" };
  const source = (known, current = -1) => ({
    count: () => 13,
    isKnown: (index) => known.includes(index),
    name: (index) => names[index],
    current: () => current,
  });
  assert.equal(titleChoices(source([])), undefined);
  assert.deepEqual(titleChoices(source([1, 5, 9], 5)), {
    current: 5,
    options: [{ value: -1, label: "Нет" }, { value: 9, label: "Анти-герой" }, { value: 1, label: "Рядовой" },
      { value: 5, label: "Чемпион Наару" }],
  });
});
