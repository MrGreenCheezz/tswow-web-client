// L12-review (04.10), plan item 5.30: how long the global cooldown a request starts is predicted to run,
// as a bound the realm's own never undercuts — so the local prediction never refuses a cast the realm
// would take.
//
// The realm (TrinityCore Spell::TriggerGlobalCooldown, Spell.cpp:8693-8723) and Wow.exe (0x00805d70) agree:
// StartRecoveryTime, minus SPELLMOD_GLOBAL_COOLDOWN (21); then, for StartRecoveryCategory 133 at exactly
// 1500 ms and a spell neither melee nor ranged (DmgClass 2/3) nor REQ_AMMO/ABILITY (Attributes 0x2/0x10),
// times UNIT_MOD_CAST_SPEED, kept within 1000..1500. The rows carry no StartRecoveryCategory, so 1500 is
// taken as category 133 (true for all but 12 of the 2,141 non-passive 1500-ms rows in the dataset's
// SkillLineAbility: 11 of category 0, one of 38) — the shorter answer for those. The rows below are the
// dataset's Spell.dbc values
// (StartRecoveryCategory/StartRecoveryTime, DefenseType, Attributes), read on 2026-10-04.
import assert from "node:assert/strict";
import test from "node:test";

const { predictedGlobalCooldownDuration, globalCooldownDurationIn, SPELLMOD_GLOBAL_COOLDOWN } =
  await import("../dist/code/browser/game/GlobalCooldownDuration.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const row = (startRecoveryTime, dmgClass, attr0, spellClassMask = [0, 0, 0]) =>
  ({ startRecoveryTime, dmgClass, attributes: [attr0, 0, 0, 0, 0, 0, 0, 0], spellClassMask });

// [name, row, the realm's duration at cast speed 1.0, 0.8 (≈25 % haste), 0.5 (the 1000 floor), 1.3 (slowed)]
const TABLE = [
  ["Огненный шар 133 (133/1500, magic)", row(1500, 1, 0x0), [1500, 1200, 1000, 1500]],
  ["Ледяная глыба 45438 (133/1500, magic)", row(1500, 1, 0x40000), [1500, 1200, 1000, 1500]],
  ["Жажда крови 2825 (133/1500, none)", row(1500, 0, 0x40000), [1500, 1200, 1000, 1500]],
  ["Смертельный удар 47486 (133/1500, melee)", row(1500, 2, 0x40010), [1500, 1500, 1500, 1500]],
  ["Верный выстрел 49052 (133/1500, ranged)", row(1500, 3, 0x400012), [1500, 1500, 1500, 1500]],
  ["Ярость берсерка 18499 (133/1500, ABILITY)", row(1500, 0, 0x40010), [1500, 1500, 1500, 1500]],
  ["Облик кошки 768 (133/1500, ABILITY)", row(1500, 0, 0x40010), [1500, 1500, 1500, 1500]],
  ["Удар грома 6343 (133/1500, ranged class)", row(1500, 3, 0x40010), [1500, 1500, 1500, 1500]],
  ["Коварный удар 1752 (133/1000)", row(1000, 2, 0x40010), [1000, 1000, 1000, 1000]],
  ["Плащ Теней 31224 (133/1000, none)", row(1000, 0, 0x40010), [1000, 1000, 1000, 1000]],
  ["Тотем элементаля земли 2062 (133/1000, magic: only 1500 is hasted)", row(1000, 1, 0x0), [1000, 1000, 1000, 1000]],
  ["Немота 65542 (133/2000, magic: not hasted, not capped)", row(2000, 1, 0x0), [2000, 2000, 2000, 2000]],
  ["Смертельный выстрел 46557 (133/1500, none, REQ_AMMO)", row(1500, 0, 0x410002), [1500, 1500, 1500, 1500]],
  ["Антимагия 2139 (0/0)", row(0, 1, 0x0), [0, 0, 0, 0]],
  ["Заморозка разума 47528 (0/0)", row(0, 1, 0x0), [0, 0, 0, 0]],
  ["Пинок 1766 (0/0)", row(0, 2, 0x40010), [0, 0, 0, 0]],
  ["Пронизывающий ветер 57994 (0/0)", row(0, 1, 0x40000), [0, 0, 0, 0]],
  ["Придание сил 10060 (0/0)", row(0, 0, 0x50000), [0, 0, 0, 0]],
  ["Воля Отрекшихся 7744 (133/0: starts none)", row(0, 0, 0x10), [0, 0, 0, 0]],
];

test("the case table: off the global cooldown, on it, hasted, melee, ranged, ability", () => {
  const speeds = [1, 0.8, 0.5, 1.3];
  for (const [name, spell, expected] of TABLE) {
    const got = speeds.map((speed) => predictedGlobalCooldownDuration(spell, speed, []));
    assert.deepEqual(got, expected, name);
  }
});

test("an older gateway's row (no DmgClass, no attributes) takes the shorter answer; a known part decides", () => {
  const bare = { startRecoveryTime: 1500 };
  // The realm hastes a caster's spell and not a melee one; not knowing which, the hasted one (shorter).
  assert.deepEqual([1, 0.8, 0.5, 1.3].map((speed) => predictedGlobalCooldownDuration(bare, speed, [])), [1500, 1200, 1000, 1500]);
  // Attributes alone (v=14, before v=16's DmgClass) already tell an ABILITY.
  assert.equal(predictedGlobalCooldownDuration({ startRecoveryTime: 1500, attributes: [0x10] }, 0.8, []), 1500);
  // DmgClass alone tells a melee spell.
  assert.equal(predictedGlobalCooldownDuration({ startRecoveryTime: 1500, dmgClass: 2 }, 0.8, []), 1500);
  assert.equal(predictedGlobalCooldownDuration({ startRecoveryTime: 1500, dmgClass: 1 }, 0.8, []), 1200);
  // No caster speed known: the base.
  assert.equal(predictedGlobalCooldownDuration(row(1500, 1, 0), undefined, []), 1500);
  assert.equal(predictedGlobalCooldownDuration(row(1500, 1, 0), Number.NaN, []), 1500);
  assert.equal(predictedGlobalCooldownDuration(undefined, 0.8, []), 0);
});

test("SPELLMOD_GLOBAL_COOLDOWN: only reductions, on a bit of the spell's family mask, before the haste", () => {
  assert.equal(SPELLMOD_GLOBAL_COOLDOWN, 21);
  // Власть нечестивости 48265: flat −500 on the death knight's spells (Удар чумы 45462, 133/1500 melee).
  const plagueStrike = row(1500, 2, 0x40010, [0x1, 0, 0]);
  const unholy = { effectIndex: 0, op: 21, value: -500, pct: false };
  assert.equal(predictedGlobalCooldownDuration(plagueStrike, 1, [unholy]), 1000);
  assert.equal(predictedGlobalCooldownDuration(plagueStrike, 1, [{ ...unholy, effectIndex: 5 }]), 1500, "another bit");
  assert.equal(predictedGlobalCooldownDuration(row(1500, 2, 0x40010, [0, 0, 0x80000000]), 1,
    [{ ...unholy, effectIndex: 95 }]), 1000, "the last bit of the third word");
  assert.equal(predictedGlobalCooldownDuration(plagueStrike, 1, [{ ...unholy, value: 500 }]), 1500,
    "a lengthening one is left out: the bound stays below the realm's");
  assert.equal(predictedGlobalCooldownDuration(plagueStrike, 1, [{ ...unholy, op: 10 }]), 1500, "SPELLMOD_CASTING_TIME");
  // Обратный поток 54277: −30 % on Стрела Тьмы 686 (133/1500 magic): 1050, hasted from there (floor 1000).
  const shadowBolt = row(1500, 1, 0x0, [0x1, 0, 0]);
  const backdraft = { effectIndex: 0, op: 21, value: -30, pct: true };
  assert.equal(predictedGlobalCooldownDuration(shadowBolt, 1, [backdraft]), 1050);
  assert.equal(predictedGlobalCooldownDuration(shadowBolt, 0.8, [backdraft]), 1000);
  // A row without a family mask takes every reduction (the shorter answer).
  assert.equal(predictedGlobalCooldownDuration({ startRecoveryTime: 1500, dmgClass: 2 }, 1, [unholy]), 1000);
  // Reductions past zero: no global cooldown at all.
  assert.equal(predictedGlobalCooldownDuration(plagueStrike, 1, [{ ...unholy, value: -2000 }]), 0);
});

// L13 (04.10): `/dbc/spells?v=17` carries StartRecoveryCategory, and the realm's own rule takes over where the
// row has it: no global cooldown for category 0 (Spell.cpp:8698, `if (!StartRecoveryCategory) return;`), the
// cast-speed rule only for category 133 (:8711; Wow.exe 0x00805d70 compares the category with 0x85).
test("L13: with StartRecoveryCategory — 0 starts none, only 133 is hasted, 133 without a time none", () => {
  const cat = (category, startRecoveryTime, dmgClass, attr0, mask) =>
    ({ ...row(startRecoveryTime, dmgClass, attr0, mask), startRecoveryCategory: category });
  const L13_TABLE = [
    ["Удар смерти 45469 (0/1500)", cat(0, 1500, 0, 0x50000), [0, 0, 0, 0]],
    ["Духовный удар 61193 (0/1500, magic)", cat(0, 1500, 1, 0x10000), [0, 0, 0, 0]],
    ["Большая ракета любви 71342 (0/1500)", cat(0, 1500, 0, 0x10118110), [0, 0, 0, 0]],
    ["Аура благочестия 48941 (38/1500, magic: not 133, not hasted)", cat(38, 1500, 1, 0x9040000), [1500, 1500, 1500, 1500]],
    ["Огненный шар 133 (133/1500, magic)", cat(133, 1500, 1, 0x0), [1500, 1200, 1000, 1500]],
    ["Смертельный удар 47486 (133/1500, melee)", cat(133, 1500, 2, 0x40010), [1500, 1500, 1500, 1500]],
    ["Воля Отрекшихся 7744 (133/0)", cat(133, 0, 0, 0x10), [0, 0, 0, 0]],
  ];
  for (const [name, spell, expected] of L13_TABLE) {
    assert.deepEqual([1, 0.8, 0.5, 1.3].map((speed) => predictedGlobalCooldownDuration(spell, speed, [])), expected, name);
  }
  // Without the column (an older gateway) the same 48941 row is hasted as if it were 133: the shorter answer.
  assert.equal(predictedGlobalCooldownDuration(row(1500, 1, 0x9040000), 0.8, []), 1200);
  // SPELLMOD_GLOBAL_COOLDOWN still applies to another category (Spell.cpp:8707), and category 0 stays none.
  const reduce = { effectIndex: 6, op: 21, value: -500, pct: false }; // bit 6: 48941's family mask 0x40
  assert.equal(predictedGlobalCooldownDuration(cat(38, 1500, 1, 0x9040000, [0x40, 0, 0]), 1, [reduce]), 1000);
  assert.equal(predictedGlobalCooldownDuration(cat(0, 1500, 1, 0x10000, [0x40, 0, 0]), 1, [reduce]), 0);
  assert.equal(globalCooldownDurationIn(undefined, cat(0, 1500, 0, 0)), 0);
});

test("the world's part: the player's UNIT_MOD_CAST_SPEED and SPELLMOD entries", () => {
  const bits = new DataView(new ArrayBuffer(4));
  bits.setFloat32(0, 0.8, true);
  const self = { guid: 1n, typeId: 4, fields: new Map([[UPDATE_FIELDS.UNIT_MOD_CAST_SPEED.offset, bits.getUint32(0, true)]]) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self]]) },
    spellModifiers: new Map(),
  };
  assert.equal(globalCooldownDurationIn(world, row(1500, 1, 0)), 1200);
  assert.equal(globalCooldownDurationIn(world, row(1500, 2, 0x40010)), 1500);
  world.spellModifiers.set("0:21:flat", { effectIndex: 0, op: 21, value: -500, pct: false });
  assert.equal(globalCooldownDurationIn(world, row(1500, 2, 0x40010, [1, 0, 0])), 1000);
  // No world, no self, no field: the row's own number.
  assert.equal(globalCooldownDurationIn(undefined, row(1500, 1, 0)), 1500);
  assert.equal(globalCooldownDurationIn({ state: { selfGuid: 2n, objects: new Map() } }, row(1500, 1, 0)), 1500);
  assert.equal(globalCooldownDurationIn(world, undefined), 0);
});
