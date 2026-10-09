import assert from "node:assert/strict";
import test from "node:test";

// 4.03: the native character sheet's readers (world/CharacterStatFields.ts). Two things are pinned:
// the field arithmetic the core defines (signed TWO_SHORT halves, float words, one-based indices),
// and that every reader answers what LiveWorldSeam answers the stock PaperDoll for the same fields.
const stats = await import("../dist/code/world/CharacterStatFields.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { characterCombatRatingBonus } = await import("../dist/code/world/CharacterStatData.js");
const { readSkills } = await import("../dist/code/browser/ui/Skills.js");

const scratch = new DataView(new ArrayBuffer(4));
const floatBits = (value) => { scratch.setFloat32(0, value, true); return scratch.getUint32(0, true); };

function player(entries) {
  const fields = new Map();
  for (const [name, value, index = 0, float = false] of entries) {
    fields.set(UPDATE_FIELDS[name].offset + index,
      float || UPDATE_FIELDS[name].type === "FLOAT" ? floatBits(value) : value >>> 0);
  }
  return { guid: 1n, typeId: 4, fields };
}

test("attack power: the low half is the positive modifier, the high half the negative, both int16", () => {
  const object = player([
    ["UNIT_FIELD_ATTACK_POWER", 1500],
    ["UNIT_FIELD_ATTACK_POWER_MODS", ((0xfff6 << 16) | 0x0064) >>> 0],
    ["UNIT_FIELD_RANGED_ATTACK_POWER", 40],
    ["UNIT_FIELD_RANGED_ATTACK_POWER_MODS", (0xff9c << 16) >>> 0], // -100
  ]);
  assert.deepEqual(stats.attackPower(object), { base: 1500, positive: 100, negative: -10, effective: 1590 });
  assert.deepEqual(stats.attackPower(object, true), { base: 40, positive: 0, negative: -100, effective: 0 },
    "the printed total never goes below zero (PaperDollFormatStat's max(0, …))");
  assert.deepEqual(stats.signedShorts(0x8000_7fff), [32767, -32768]);
});

test("attack power is scaled by the multiplier field and rounded half to even, as Wow.exe answers it", () => {
  // UnitAttackPower 0x610b60 / UnitRangedAttackPower 0x610ca0: each of base, positive and negative is
  // round((1.0f + MULTIPLIER) * value) in float — the core's TOTAL_PCT (StatSystem.cpp, attPowerMultiplier).
  const object = player([
    ["UNIT_FIELD_ATTACK_POWER", 1500],
    ["UNIT_FIELD_ATTACK_POWER_MODS", ((0xfff6 << 16) | 0x0064) >>> 0],
    ["UNIT_FIELD_ATTACK_POWER_MULTIPLIER", 0.1],
    ["UNIT_FIELD_RANGED_ATTACK_POWER", 3],
    ["UNIT_FIELD_RANGED_ATTACK_POWER_MODS", 5],
    ["UNIT_FIELD_RANGED_ATTACK_POWER_MULTIPLIER", 0.5],
  ]);
  assert.deepEqual(stats.attackPower(object), { base: 1650, positive: 110, negative: -11, effective: 1749 });
  assert.deepEqual(stats.attackPower(object, true), { base: 4, positive: 8, negative: 0, effective: 12 },
    "4.5 rounds to 4 and 7.5 to 8: the x87 default, nearest-even");
  const world = { state: { selfGuid: 1n, objects: new Map([[1n, object]]) }, actionButtons: [], casts: new Map(),
    channels: new Map(), events: { on: () => () => {} }, itemTemplates: new Map(), cooldownRemaining: () => 0 };
  const seam = new LiveWorldSeam({ world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {} });
  assert.deepEqual(seam.unitAttackPower("player"), [1650, 110, -11], "the stock PaperDoll gets the same numbers");
  assert.deepEqual(seam.unitRangedAttackPower("player"), [4, 8, 0]);
});

test("UnitHasMana is FrameXML's own: the displayed power is mana and its maximum is above zero", () => {
  // UIParent.lua:3221 — UnitPowerType's token "MANA" (UNIT_FIELD_BYTES_0 byte 3 = 0) and UnitPowerMax > 0.
  assert.equal(stats.unitHasMana(player([["UNIT_FIELD_MAXPOWER1", 4000]])), true);
  assert.equal(stats.unitHasMana(player([["UNIT_FIELD_MAXPOWER1", 0]])), false, "a warrior: no mana pool");
  assert.equal(stats.unitHasMana(player([["UNIT_FIELD_MAXPOWER1", 4000], ["UNIT_FIELD_BYTES_0", 1 << 24]])), false,
    "a druid in bear form shows rage: the stock row says «НЕТ»");
});

test("ratings are one-based, spell crit is a float word per one-based school, bonus damage sums both arrays", () => {
  const object = player([
    ["PLAYER_FIELD_COMBAT_RATING_1", 321, 19], // CR_HASTE_SPELL = 20
    ["PLAYER_SPELL_CRIT_PERCENTAGE1", 7.25, 2], // school 3, fire
    ["PLAYER_FIELD_MOD_DAMAGE_DONE_POS", 450, 5],
    ["PLAYER_FIELD_MOD_DAMAGE_DONE_NEG", -20, 5], // school 6, shadow
    ["PLAYER_FIELD_MOD_TARGET_RESISTANCE", -35],
    ["PLAYER_EXPERTISE", 26],
    ["PLAYER_OFFHAND_EXPERTISE", 10],
  ]);
  assert.equal(stats.combatRating(object, stats.CR.HASTE_SPELL), 321);
  assert.equal(stats.combatRating(object, 19), 0);
  assert.equal(stats.combatRating(object, 26), 0, "past the 25 slots is nothing");
  assert.equal(stats.spellCritChance(object, 3), 7.25);
  assert.equal(stats.spellCritChance(object, 2), 0);
  assert.equal(stats.spellBonusDamage(object, 6), 430);
  assert.equal(stats.spellPenetration(object), 35);
  assert.deepEqual(stats.expertisePercent(object), [6.5, 2.5]);
  const spread = stats.magicSchoolSpread((school) => stats.spellBonusDamage(object, school));
  assert.equal(spread.min, 0);
  assert.deepEqual([...spread.bySchool.keys()], [2, 3, 4, 5, 6, 7], "physical is not a spell school row");
});

test("resilience is the lowest crit-taken rating, melee first on a tie; defence adds whole rating points", () => {
  const object = player([
    ["PLAYER_FIELD_COMBAT_RATING_1", 300, 14],
    ["PLAYER_FIELD_COMBAT_RATING_1", 250, 15],
    ["PLAYER_FIELD_COMBAT_RATING_1", 250, 16],
  ]);
  assert.deepEqual(stats.resilience(object), { rating: 250, index: stats.CR.CRIT_TAKEN_RANGED });
  assert.equal(stats.defense({ value: 400, temporaryBonus: 0, permanentBonus: 5 }, undefined), undefined,
    "without the rating table the defence row is not answered");
  assert.deepEqual(stats.defense({ value: 400, temporaryBonus: 0, permanentBonus: 5 }, 12.9), [400, 17]);
  assert.equal(stats.avoidanceFromDefense([400, 17], 80), 0.68);
  assert.equal(stats.avoidanceFromDefense([300, 0], 80), 0);
});

test("helm and cloak: shown unless PLAYER_FLAGS carries the hide bit; the toggle body is one byte", () => {
  assert.equal(stats.showingHelm(player([])), true);
  const hidden = player([["PLAYER_FLAGS", stats.PLAYER_FLAGS_HIDE_HELM | 0x20]]);
  assert.equal(stats.showingHelm(hidden), false);
  assert.equal(stats.showingCloak(hidden), true);
  assert.equal(stats.showingCloak(player([["PLAYER_FLAGS", 0x800]])), false);
  assert.deepEqual([...stats.buildShowingToggle(true)], [1]);
  assert.deepEqual([...stats.buildShowingToggle(false)], [0]);
});

test("every reader answers what LiveWorldSeam answers the stock PaperDoll on the same fields", () => {
  const object = player([
    ["UNIT_FIELD_BYTES_0", 1 | (2 << 8)],
    ["UNIT_FIELD_LEVEL", 80],
    ["UNIT_FIELD_STAT0", 123, 1], ["UNIT_FIELD_POSSTAT0", 10, 1], ["UNIT_FIELD_NEGSTAT0", -3, 1],
    ["UNIT_FIELD_RESISTANCES", 500], ["UNIT_FIELD_RESISTANCEBUFFMODSPOSITIVE", 25],
    ["UNIT_FIELD_RESISTANCEBUFFMODSNEGATIVE", -5],
    ["UNIT_FIELD_RESISTANCES", 40, 3],
    ["UNIT_FIELD_ATTACK_POWER", 2000], ["UNIT_FIELD_ATTACK_POWER_MODS", ((0xffce << 16) | 300) >>> 0],
    ["UNIT_FIELD_RANGED_ATTACK_POWER", 1800], ["UNIT_FIELD_RANGED_ATTACK_POWER_MODS", 77],
    ["PLAYER_CRIT_PERCENTAGE", 12.5], ["PLAYER_RANGED_CRIT_PERCENTAGE", 13.25],
    ["PLAYER_DODGE_PERCENTAGE", 18.5], ["PLAYER_PARRY_PERCENTAGE", 11], ["PLAYER_BLOCK_PERCENTAGE", 22.75],
    ["PLAYER_SHIELD_BLOCK", 900], ["PLAYER_EXPERTISE", 22], ["PLAYER_OFFHAND_EXPERTISE", 18],
    ["PLAYER_FIELD_MOD_HEALING_DONE_POS", 600], ["PLAYER_FIELD_MOD_TARGET_RESISTANCE", -40],
    ["UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER", 80], ["UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER", 40],
    ["UNIT_FIELD_BASEATTACKTIME", 2600], ["UNIT_FIELD_BASEATTACKTIME", 1800, 1], ["UNIT_FIELD_RANGEDATTACKTIME", 3000],
    ["UNIT_FIELD_MINDAMAGE", 501.5], ["UNIT_FIELD_MAXDAMAGE", 702.25],
    ["UNIT_FIELD_MINOFFHANDDAMAGE", 200], ["UNIT_FIELD_MAXOFFHANDDAMAGE", 300],
    ["UNIT_FIELD_MINRANGEDDAMAGE", 400], ["UNIT_FIELD_MAXRANGEDDAMAGE", 500],
    ["PLAYER_SKILL_INFO_1_1", 95], ["PLAYER_SKILL_INFO_1_1", 400 | (400 << 16), 1],
    ["PLAYER_SKILL_INFO_1_1", ((3 << 16) | 2) >>> 0, 2],
    ...Array.from({ length: 25 }, (_, index) => ["PLAYER_FIELD_COMBAT_RATING_1", 10 * index + 3, index]),
    ...Array.from({ length: 7 }, (_, index) => ["PLAYER_SPELL_CRIT_PERCENTAGE1", 5 + index * 0.5, index]),
    ...Array.from({ length: 7 }, (_, index) => ["PLAYER_FIELD_MOD_DAMAGE_DONE_POS", 100 + index, index]),
    ["PLAYER_FIELD_MOD_DAMAGE_DONE_NEG", -7, 4],
  ]);
  const catalog = { spellCritBase: [0, 0.03], spellCritPerIntellect: Array(200).fill(0.001),
    combatRatingPerLevel: Array(2500).fill(5), combatRatingScalar: { 34: 2 } };
  const selfGuid = 1n;
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, object]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), events: { on: () => () => {} },
    itemTemplates: new Map(), cooldownRemaining: () => 0,
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    characterStats: () => catalog,
  });
  for (let index = 1; index <= 5; index++) {
    const [, effective, positive, negative] = seam.unitStat("player", index);
    assert.deepEqual(stats.unitStat(object, index), { effective, positive, negative }, `stat ${index}`);
  }
  for (let school = 0; school < 7; school++) {
    const [base, effective, positive, negative] = seam.unitResistance("player", school);
    assert.deepEqual(stats.unitResistance(object, school), { base, effective, positive, negative }, `resistance ${school}`);
  }
  for (const ranged of [false, true]) {
    const [base, positive, negative] = ranged ? seam.unitRangedAttackPower("player") : seam.unitAttackPower("player");
    const mine = stats.attackPower(object, ranged);
    assert.deepEqual([mine.base, mine.positive, mine.negative], [base, positive, negative]);
  }
  for (let index = 1; index <= 25; index++) assert.equal(stats.combatRating(object, index), seam.combatRating(index));
  for (let school = 1; school <= 7; school++) {
    assert.equal(stats.spellCritChance(object, school), seam.spellCritChance(school), `crit ${school}`);
    assert.equal(stats.spellBonusDamage(object, school), seam.spellBonusDamage(school), `damage ${school}`);
  }
  assert.equal(stats.spellBonusHealing(object), seam.spellBonusHealing());
  assert.equal(stats.spellPenetration(object), seam.spellPenetration());
  assert.deepEqual(stats.manaRegen(object), seam.manaRegen());
  assert.deepEqual(stats.expertise(object), seam.expertise());
  assert.deepEqual(stats.expertisePercent(object), seam.expertisePercent());
  assert.equal(stats.meleeCritChance(object), seam.critChance());
  assert.equal(stats.rangedCritChance(object), seam.rangedCritChance());
  assert.equal(stats.dodgeChance(object), seam.dodgeChance());
  assert.equal(stats.parryChance(object), seam.parryChance());
  assert.equal(stats.blockChance(object), seam.blockChance());
  assert.equal(stats.shieldBlock(object), seam.shieldBlock());
  assert.deepEqual(stats.attackSpeed(object), seam.unitAttackSpeed("player"));
  const damage = seam.unitDamage("player");
  const melee = stats.meleeDamage(object);
  assert.deepEqual([melee.main.min, melee.main.max, melee.off.min, melee.off.max], damage.slice(0, 4));
  const ranged = seam.unitRangedDamage("player");
  assert.deepEqual([stats.rangedAttackSpeed(object), stats.rangedDamage(object).min, stats.rangedDamage(object).max],
    ranged.slice(0, 3));
  // The defence row: the skill, its bonuses and the whole points CR_DEFENSE_SKILL adds by the table.
  const skill = readSkills(object).find((entry) => entry.skillId === stats.SKILL_DEFENSE);
  const bonus = characterCombatRatingBonus(catalog, 2, 80, stats.CR.DEFENSE_SKILL, stats.combatRating(object, stats.CR.DEFENSE_SKILL));
  assert.deepEqual(stats.defense(skill, bonus), seam.unitDefense("player"));
  assert.equal(stats.avoidanceFromDefense(seam.unitDefense("player"), 80), seam.dodgeBlockParryChanceFromDefense());
});
