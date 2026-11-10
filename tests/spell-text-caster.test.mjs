import assert from "node:assert/strict";
import test from "node:test";

// 3.43 (11.11): the caster side of Wow.exe 3.3.5a 12340's spell description numbers (SpellTextCaster.ts; Ghidra
// dumps in .runtime/re-2026-11-11/spelltext/): the caster-level growth (0x007ff070, 0x006dc330, 0x007ff770), the
// spell modifiers (0x007fd970 and its three appliers), the aura-316 haste of `$d` (0x00800a70, 0x007283a0) and an
// aura tooltip's level and stack multiplier (0x00625350 → 0x0057abc0). The spell rows are this dataset's own
// Spell.dbc rows (Fireball 133, Power Word: Shield 17, Sunder Armor's debuff 58567), the expected numbers worked
// out by hand from their columns.

const { formatSpellDescription } = await import("../dist/code/browser/ui/SpellText.js");
const {
  spellTextEffectRange, spellTextModifierTotals, spellTextPlayerSpellLevel, spellTextPeriodicHaste, spellTextEffectKind,
} = await import("../dist/code/browser/ui/SpellTextCaster.js");
const { spellTextLiveContext } = await import("../dist/code/browser/ui/SpellTextLiveContext.js");
const { evaluateSpellExpression } = await import("../dist/code/browser/ui/SpellTextExpression.js");
const { auraDescriptionContext } = await import("../dist/code/browser/ui/SpellTooltip.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { GLOBAL_STRING_DATA_AVAILABLE, GLOBAL_STRINGS } = await import("../dist/code/generated/globalStrings.js");

if (!GLOBAL_STRING_DATA_AVAILABLE || GLOBAL_STRINGS.INT_SPELL_DURATION_SEC === undefined) {
  Object.assign(GLOBAL_STRINGS, { INT_SPELL_DURATION_SEC: "%d сек", INT_SPELL_DURATION_MIN: "%d мин" });
}

const common = {
  effectChainTargets: [0, 0, 0], effectRadius: [0, 0, 0], procChance: 100, procTypeMask: 0, procCharges: 0,
  maxTargetLevel: 0, maxAffectedTargets: 0, manaPerSecond: 0, effectMultipleValue: [0, 0, 0],
  effectPointsPerCombo: [0, 0, 0], effectDamageMultiplier: [0, 0, 0], effectBonusMultiplier: [0, 0, 0],
  targets: 0, equippedItemClass: -1, equippedItemSubclass: 0, durationPerLevel: 0,
};

/** Spell.dbc 133, «Огненный шар» rank 1. */
const FIREBALL = {
  ...common, id: 133, effects: [2, 6, 0], effectAura: [0, 3, 0], effectBasePoints: [13, 0, 0], effectDieSides: [9, 1, 0],
  effectRealPointsPerLevel: [Math.fround(0.6), 0, 0], effectPeriod: [0, 2000, 0], baseLevel: 1, maxLevel: 5,
  duration: 4000, maxDuration: 4000, spellClassSet: 3, spellClassMask: [1, 0, 8], stackAmount: 0,
  attributes: [0, 0, 0, 0, 0, 0, 0, 0],
};
/** Spell.dbc 17, «Слово силы: Щит» rank 1 (aura 69, SCHOOL_ABSORB: neither damage nor rounded). */
const SHIELD = {
  ...common, id: 17, effects: [6, 0, 0], effectAura: [69, 0, 0], effectBasePoints: [43, 0, 0], effectDieSides: [1, 0, 0],
  effectRealPointsPerLevel: [Math.fround(0.8), 0, 0], effectPeriod: [0, 0, 0], baseLevel: 6, maxLevel: 11,
  duration: 30000, maxDuration: 30000, spellClassSet: 6, spellClassMask: [1, 0, 0x400], stackAmount: 0,
  attributes: [0, 0, 0x280000, 0, 0, 0, 0, 0],
};
/** Spell.dbc 58567, «Раскол брони» (the debuff): CumulativeAura 5, `$s1` = -4. */
const SUNDER = {
  ...common, id: 58567, effects: [6, 63, 0], effectAura: [101, 0, 0], effectBasePoints: [-5, 0, 0], effectDieSides: [1, 0, 0],
  effectRealPointsPerLevel: [0, 0, 0], effectPeriod: [0, 0, 0], baseLevel: 10, maxLevel: 0,
  duration: 30000, maxDuration: 30000, spellClassSet: 4, spellClassMask: [0x4000, 0, 0], stackAmount: 5,
  attributes: [0, 0, 0x1000, 0x40400, 0, 0, 0, 0],
};

/** A caster whose spells grow by `level`; `family` and `modifiers` as SMSG_SET_*_SPELL_MODIFIER left them. */
function caster(level, family, modifiers = [], periodicHaste = () => false) {
  return { level: () => level, family, modifiers: () => modifiers, periodicHaste };
}

test("0x007ff770: Fireball rank 1 grows 0.6 a level above BaseLevel 1, floored and raised out (a damage effect)", () => {
  // Level 1: no growth, 14..22 as the table writes it.
  assert.equal(formatSpellDescription("$s1", FIREBALL, { caster: caster(1) }), "14–22");
  // Level 5: 4 × 0.6 = 2.4 — 16.4 floored to 16, 24.4 raised to 25.
  assert.equal(formatSpellDescription("$s1", FIREBALL, { caster: caster(5) }), "16–25");
  assert.equal(formatSpellDescription("$m1/$M1", FIREBALL, { caster: caster(5) }), "16/25");
  // Without an active player the level is 0: no growth.
  assert.equal(formatSpellDescription("$s1", FIREBALL, {}), "14–22");
});

test("0x007ff770: an absorb is neither floored nor raised, and the 1/128 grid keeps a fraction", () => {
  // Level 11: 5 × 0.8 = 4 — 48 (the server's 43 + 4 + 1).
  assert.equal(formatSpellDescription("$s1", SHIELD, { caster: caster(11) }), "48");
  // Level 8: 2 × 0.8 = 1.6 — 45.6 on the 1/128 grid, which `s` writes as the integer below it (the server's 45).
  assert.equal(formatSpellDescription("$s1", SHIELD, { caster: caster(8) }), "45");
  assert.equal(formatSpellDescription("$m1", SHIELD, { caster: caster(8) }), "45.6");
  const range = spellTextEffectRange(SHIELD, 0, 0, caster(8), true);
  assert.equal(range.min, 5837 / 128, "floor(45.6 × 128 + 0.5) / 128");
});

test("0x007ff770: DieSides 0 makes the maximum BasePoints, one below the minimum, as the client computes it", () => {
  const row = { ...SHIELD, effectDieSides: [0, 0, 0], effectRealPointsPerLevel: [0, 0, 0] };
  assert.deepEqual(spellTextEffectRange(row, 0, 0, undefined, true), { min: 44, max: 43 });
});

test("0x007fd440: which effects take the damage ops and which are rounded out", () => {
  assert.deepEqual(spellTextEffectKind(2, 0), { damage: true, dot: false, round: true });
  assert.deepEqual(spellTextEffectKind(6, 3), { damage: true, dot: true, round: true });
  assert.deepEqual(spellTextEffectKind(6, 15), { damage: true, dot: false, round: true });
  assert.deepEqual(spellTextEffectKind(6, 24), { damage: false, dot: false, round: true });
  assert.deepEqual(spellTextEffectKind(30, 0), { damage: false, dot: false, round: true });
  assert.deepEqual(spellTextEffectKind(6, 69), { damage: false, dot: false, round: false });
});

test("0x007fd970: a modifier needs the player's family and the spell's family bit, and SPELL_ATTR3 0x20000000 refuses all", () => {
  const plus10 = [{ effectIndex: 0, op: 0, value: 10, pct: true }];
  assert.deepEqual(spellTextModifierTotals(FIREBALL, 0, caster(5, 3, plus10)), { flat: 0, pct: 110 });
  assert.equal(spellTextModifierTotals(FIREBALL, 0, caster(5, 6, plus10)), undefined, "another class's family");
  assert.equal(spellTextModifierTotals(FIREBALL, 0, caster(5, 3, [{ ...plus10[0], effectIndex: 1 }])), undefined, "bit not in the mask");
  const noMods = { ...FIREBALL, attributes: [0, 0, 0, 0x20000000, 0, 0, 0, 0] };
  assert.equal(spellTextModifierTotals(noMods, 0, caster(5, 3, plus10)), undefined);
  assert.deepEqual(spellTextModifierTotals(FIREBALL, 0, caster(5, 3, [{ effectIndex: 0, op: 0, value: -150, pct: true }])),
    { flat: 0, pct: 0 }, "the percent is not below 0");
});

test("0x007ff770 with modifiers: SPELLMOD_DAMAGE on a direct hit, SPELLMOD_DOT on a periodic one, none on an aura's tooltip", () => {
  const mods = [
    { effectIndex: 0, op: 0, value: 10, pct: true }, // +10% damage
    { effectIndex: 0, op: 22, value: 3, pct: false }, // +3 periodic
  ];
  const live = caster(5, 3, mods);
  // 16.4 × 1.1 = 18.04 → 18; 24.4 × 1.1 = 26.84 → 27.
  assert.equal(formatSpellDescription("$s1", FIREBALL, { caster: live }), "18–27");
  // The DoT: (1 + 3) per tick, two ticks.
  assert.equal(formatSpellDescription("$s2 $o2", FIREBALL, { caster: live }), "4 8");
  // An aura's tooltip (0x0057abc0's last argument 1) skips them.
  assert.equal(formatSpellDescription("$s1 $s2", FIREBALL, { caster: live, aura: true }), "16–25 1");
});

test("0x00800a70: SPELLMOD_DURATION on `$d` and `$o`, but not on an aura's tooltip", () => {
  const live = caster(5, 3, [{ effectIndex: 0, op: 1, value: 2000, pct: false }]);
  assert.equal(formatSpellDescription("$d", FIREBALL, { caster: live }), "6 сек");
  assert.equal(formatSpellDescription("$o2", FIREBALL, { caster: live }), "3", "6000 / 2000 ticks of 1");
  assert.equal(formatSpellDescription("$d", FIREBALL, { caster: live, aura: true }), "4 сек");
});

test("0x00800a70: DurationPerLevel grows with the caster's level and stops at MaxDuration", () => {
  const row = { ...SHIELD, durationPerLevel: 1000, maxDuration: 33000 };
  assert.equal(formatSpellDescription("$d", row, { caster: caster(8) }), "32 сек", "30 s + 2 levels");
  assert.equal(formatSpellDescription("$d", row, { caster: caster(11) }), "33 сек", "capped");
});

/** The active player's words: UNIT_MOD_CAST_SPEED (float) and UNIT_FIELD_LEVEL. */
function player(speed, level = 80) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, speed, true);
  const words = new Map([[UPDATE_FIELDS.UNIT_MOD_CAST_SPEED.offset, view.getUint32(0, true)], [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, level]]);
  return { slot: (index) => words.get(index) };
}

test("0x00800a70 with 0x007283a0(316): a periodic-haste aura hastes `$d` like SPELL_ATTR5_HASTE_AFFECT_DURATION", () => {
  const without = caster(5, 3, [], () => false);
  const withAura = caster(5, 3, [], () => true);
  assert.equal(formatSpellDescription("$d", FIREBALL, { player: player(0.8), caster: without }), "4 сек");
  assert.equal(formatSpellDescription("$d", FIREBALL, { player: player(0.8), caster: withAura }), "3.20 сек");
  // SPELL_ATTR3_NO_DONE_BONUS still refuses it.
  const noBonus = { ...FIREBALL, attributes: [0, 0, 0, 0x20000000, 0, 0, 0, 0] };
  assert.equal(formatSpellDescription("$d", noBonus, { player: player(0.8), caster: withAura }), "4 сек");
});

test("0x007283a0: an active SPELL_AURA_PERIODIC_HASTE effect whose effect-major class mask meets the spell's", () => {
  // Spell.dbc 71167-like: effect 0 aura 316, family 3, effect 0's three words in `effectSpellClassMask[0]`.
  const hasteAura = {
    id: 9, effectAura: [316, 0, 0], spellClassSet: 3,
    effectSpellClassMask: [[1, 0, 0], [0, 0, 0], [0, 0, 0]],
  };
  const rows = (id) => (id === 9 ? hasteAura : undefined);
  assert.equal(spellTextPeriodicHaste(FIREBALL, [{ spellId: 9, flags: 0x1 }], rows), true);
  assert.equal(spellTextPeriodicHaste(FIREBALL, [{ spellId: 9, flags: 0x2 }], rows), false, "effect 0 not active");
  assert.equal(spellTextPeriodicHaste(SHIELD, [{ spellId: 9, flags: 0x1 }], rows), false, "another family");
  // Word 2 of effect 0 is effectSpellClassMask[0][2], not effectSpellClassMask[2][0] (another effect's word 0).
  const wordOne = { ...hasteAura, effectSpellClassMask: [[0, 0, 0], [0, 0, 0], [8, 0, 0]] };
  assert.equal(spellTextPeriodicHaste(FIREBALL, [{ spellId: 9, flags: 0x1 }], () => wordOne), false);
  const wordTwo = { ...hasteAura, effectSpellClassMask: [[0, 0, 8], [0, 0, 0], [0, 0, 0]] };
  assert.equal(spellTextPeriodicHaste(FIREBALL, [{ spellId: 9, flags: 0x1 }], () => wordTwo), true, "word 2 of effect 0");
});

test("`$t`: SPELLMOD_ACTIVATION_TIME before the haste; `$h`, `$n`, `$x`, `$a`, `$r`, `$e` through their ops", () => {
  const live = caster(5, 3, [
    { effectIndex: 0, op: 19, value: -500, pct: false },
    { effectIndex: 0, op: 18, value: 10, pct: false },
    { effectIndex: 0, op: 4, value: 2, pct: false },
    { effectIndex: 0, op: 17, value: 1, pct: false },
    { effectIndex: 0, op: 6, value: 50, pct: true },
    { effectIndex: 0, op: 5, value: 5, pct: false },
    { effectIndex: 0, op: 27, value: 100, pct: true },
  ]);
  const row = {
    ...FIREBALL, procChance: 20, procCharges: 1, effectChainTargets: [2, 0, 0], effectRadius: [Math.fround(8.5), 0, 0],
    rangeMax: 35, effectMultipleValue: [Math.fround(1.5), 0, 0],
  };
  assert.equal(formatSpellDescription("$t2 $h $n $x1 $a1 $r $e1", row, { caster: live }), "1.50 30 3 3 12 40 3.0");
  assert.equal(formatSpellDescription("$t2 $h $n $x1 $a1 $r $e1", row, {}), "2 20 1 2 8 35 1.5");
});

test("0x005782d0: `${$m1}` reads the grown, modified value times the multiplier; `${$t2}` is not hasted", () => {
  const environment = (fields) => ({
    spell: FIREBALL, row: () => undefined, player: player(0.5), variable: () => 0, duration: () => 4000, cost: () => 0,
    caster: caster(5), level: 0, multiplier: 1, modified: true, ...fields,
  });
  assert.deepEqual(evaluateSpellExpression("$m1", environment({})), { kind: "value", value: 16 });
  assert.deepEqual(evaluateSpellExpression("$M1", environment({ multiplier: 2 })), { kind: "value", value: 50 });
  assert.deepEqual(evaluateSpellExpression("$t2", environment({})), { kind: "value", value: 2000 });
});

test("0x00579e50: a written id with SPELL_ATTR2 0x1000000 grows by UNIT_FIELD_LEVEL, capped at its MaxLevel", () => {
  const referenced = { ...FIREBALL, id: 500, attributes: [0, 0, 0x1000000, 0, 0, 0, 0, 0] };
  const context = { player: player(1, 3), caster: caster(1), spells: new Map([[500, referenced]]) };
  // Level 3 from the player's field (not the caster's 1): 2 × 0.6 = 1.2 → 15.2..23.2 → 15–24.
  assert.equal(formatSpellDescription("$500s1", SHIELD, context), "15–24");
  // The player at 80: capped at MaxLevel 5 → 16–25.
  assert.equal(formatSpellDescription("$500s1", SHIELD, { ...context, player: player(1, 80) }), "16–25");
});

test("0x006dc330: the player's level for a spell is its skill line's value over 5, capped at MaxLevel × 5", () => {
  const ability = [{ skillLine: 8, raceMask: 0, classMask: 128, excludeRace: 0, excludeClass: 0 }];
  const skill = (value, temporaryBonus = 0, permanentBonus = 0) => [{ skillId: 8, value, temporaryBonus, permanentBonus }];
  assert.equal(spellTextPlayerSpellLevel(FIREBALL, 1, 8, ability, skill(15)), 3);
  assert.equal(spellTextPlayerSpellLevel(FIREBALL, 1, 8, ability, skill(400)), 5, "MaxLevel 5 × 5");
  assert.equal(spellTextPlayerSpellLevel(FIREBALL, 1, 8, ability, skill(15, 5, 5)), 5, "both bonuses");
  assert.equal(spellTextPlayerSpellLevel(FIREBALL, 1, 8, ability, skill(0, 0, 50)), 0, "the permanent bonus needs a value");
  assert.equal(spellTextPlayerSpellLevel(FIREBALL, 1, 1, ability, skill(25)), 0, "not the class's row");
  assert.equal(spellTextPlayerSpellLevel(FIREBALL, 1, 8, undefined, skill(25)), 0, "no SkillLineAbility row");
  const excluded = [{ ...ability[0], excludeClass: 1 }];
  assert.equal(spellTextPlayerSpellLevel(FIREBALL, 1, 8, excluded, skill(25)), 0, "ExcludeClass inverts the mask");
  // 0x006d4920 would swap a weapon-requiring spell for a weapon skill's: not modelled, unknown.
  const weapon = { ...FIREBALL, equippedItemClass: 2, equippedItemSubclass: 0x4000c };
  assert.equal(spellTextPlayerSpellLevel(weapon, 1, 8, ability, skill(25)), undefined);
  assert.equal(formatSpellDescription("$s1", weapon, { caster: { level: () => undefined } }), "$s1", "left as written");
});

test("spellTextLiveContext: the live caster from the skill fields, the SPELLMOD map and the player's auras", () => {
  const self = 1n;
  const fields = new Map();
  // Human (1) mage (8).
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (8 << 8));
  const skills = UPDATE_FIELDS.PLAYER_SKILL_INFO_1_1.offset;
  fields.set(skills, 8);
  fields.set(skills + 1, 25 | (25 << 16));
  fields.set(skills + 2, 0);
  const world = {
    state: { selfGuid: self, objects: new Map([[self, { guid: self, typeId: 4, fields }]]) },
    knownSpells: [], itemTemplates: new Map(), auras: new Map(),
    spellModifiers: new Map([["0:0:pct", { effectIndex: 0, op: 0, value: 10, pct: true }]]),
  };
  const options = {
    spellAbilities: (id) => (id === 133 ? [{ skillLine: 8, raceMask: 0, classMask: 128, excludeRace: 0, excludeClass: 0 }] : undefined),
    spellFamily: (classId) => (classId === 8 ? 3 : undefined),
  };
  const context = spellTextLiveContext(world, new Map([[133, FIREBALL]]), options);
  assert.equal(formatSpellDescription("$s1", FIREBALL, context), "18–27", "level 5 and +10%");
  const plain = spellTextLiveContext({ ...world, spellModifiers: new Map() }, new Map(), options);
  assert.equal(formatSpellDescription("$s1", FIREBALL, plain), "16–25");
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("the dataset's own rows through the gateway's parser: the hand-worked numbers, and no new `$` with a caster", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const rows = await loadSpellMetadata(dbcDirectory);
  const at = (level) => ({ spells: rows, caster: { level: (record) => Math.min(level, record.maxLevel > 0 ? record.maxLevel : level) } });
  assert.equal(formatSpellDescription("$s1 $o2 $d", rows.get(133), at(1)), "14–22 2 4 сек", "Fireball rank 1 at level 1");
  assert.equal(formatSpellDescription("$s1", rows.get(133), at(80)), "16–25", "… capped at MaxLevel 5");
  assert.equal(formatSpellDescription("$s1", rows.get(17), at(80)), "48", "Power Word: Shield rank 1, MaxLevel 11");
  assert.equal(formatSpellDescription("$s1", rows.get(17), at(8)), "45");
  // Smite rank 1 (585: 12 + 1..5, 0.5 a level from 1, MaxLevel 6): 5 × 0.5 = 2.5 → 15.5..19.5 → 15–20.
  assert.equal(formatSpellDescription("$s1", rows.get(585), at(80)), "15–20");
  // Over every description, a level-80 caster leaves no marker that the level-less writer did not.
  const plain = { spells: rows };
  const added = [];
  for (const [id, row] of rows) {
    for (const text of [row.description, row.auraDescription ?? ""]) {
      if (!text.includes("$")) continue;
      const before = (formatSpellDescription(text, row, plain).match(/\$/g) ?? []).length;
      const after = (formatSpellDescription(text, row, at(80)).match(/\$/g) ?? []).length;
      if (after > before && added.length < 10) added.push(id);
    }
  }
  assert.deepEqual(added, []);
});

test("0x00625350: an aura's tooltip — the slot's caster level, and its count as the multiplier only when CumulativeAura ≥ 2", () => {
  const base = { caster: caster(1) };
  const sunder = auraDescriptionContext(base, SUNDER, { aura: true, auraLevel: 80, auraCount: 3 });
  assert.equal(sunder.multiplier, 3);
  assert.equal(formatSpellDescription("Броня ослаблена на $s1%.", SUNDER, sunder), "Броня ослаблена на 12%.");
  const shield = auraDescriptionContext(base, SHIELD, { aura: true, auraLevel: 80, auraCount: 3 });
  assert.equal(shield.multiplier, 1, "CumulativeAura 0");
  // The slot's level is used as it is: 74 levels above BaseLevel, no MaxLevel cap here (0x007ff770 caps nothing).
  assert.equal(formatSpellDescription("$s1", SHIELD, shield), "103");
  // Level 0 in the slot: the caster's own level (0x007ff070).
  const own = auraDescriptionContext({ caster: caster(11) }, SHIELD, { aura: true });
  assert.equal(formatSpellDescription("$s1", SHIELD, own), "48");
});
