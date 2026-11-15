// 3.43 (15.11): Wow.exe 3.3.5a 12340's cost function 0x008012f0 and its per-second part 0x007ff100
// (src/browser/ui/SpellTextCost.ts), the weapon-skill swap 0x006d4920 (SpellTextCaster.ts), and the gateway columns
// they read (`/dbc/spells?v=22`). The spell rows are the base dataset's, read from its Spell.dbc on 2026-11-15:
// 6950 «Волшебный огонь» (ManaCost 15, ManaCostPerLevel 2, BaseLevel 1), 5938 «Отравляющий укол» (20 energy,
// AttributesEx4 0x400, AttributesEx3 0x1070000), 66842 «Зов Стихий» (effect 97, MiscValue 0, MiscValueB 4) with the
// totems 3599 (7 %), 5394 (3 %), 8071 (10 %) and 6742 «Жажда крови» (no totem bit), 20736 «Отвлекающий выстрел»
// (EquippedItemClass 2, mask 262156, 1.5 a level from 12, MaxLevel 19; SkillLineAbility 163) and 264 «Луки»
// (SkillLineAbility 45, ClassMask 13).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { spellPowerCostFor, spellPowerPerSecondFor, spellCostWeaponSpeed } = await import("../dist/code/browser/ui/SpellTextCost.js");
const { spellTextPlayerSpellLevel, spellTextWeaponSkillSpell, spellTextEffectRange } = await import("../dist/code/browser/ui/SpellTextCaster.js");
const { formatSpellDescription } = await import("../dist/code/browser/ui/SpellText.js");

/** A player whose update fields are `fields` (name → value, or name → [offset, value] pairs). */
function player(fields = {}, items = new Map(), extra = {}) {
  const words = new Map();
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const [offset, word] of value) words.set(UPDATE_FIELDS[name].offset + offset, word);
    else words.set(UPDATE_FIELDS[name].offset, value);
  }
  return { slot: (index) => words.get(index), item: (entry) => items.get(entry), basePower: () => 1000, ...extra };
}

const caster = (level) => ({ level: () => level });
const unit = (p, extra = {}) => ({ player: p, caster: caster(80), isPlayer: true, isActivePlayer: true, ...extra });

const FAERIE_FIRE = { id: 6950, powerType: 0, powerCost: 15, powerCostPercent: 0, manaCostPerLevel: 2, baseLevel: 1,
  schoolMask: 8, attributes: [0, 98304, 0, 0, 0, 0, 0, 0] };

test("ManaCostPerLevel grows the cost by the caster's level for the spell less BaseLevel (0x008012f0)", () => {
  assert.equal(spellPowerCostFor(FAERIE_FIRE, unit(player())), 15 + 2 * (80 - 1));
  assert.equal(spellPowerCostFor({ ...FAERIE_FIRE, manaCostPerLevel: undefined }, unit(player())), 15, "an older gateway: as before");
  assert.equal(spellPowerCostFor(FAERIE_FIRE, unit(player(), { caster: caster(undefined) })), undefined, "a level not known yet");
  // No clamp at 0: a spell with no skill line is level 0, and 0 − BaseLevel is taken off (then not below 0).
  assert.equal(spellPowerCostFor(FAERIE_FIRE, unit(player(), { caster: caster(0) })), 15 - 2);
  assert.equal(formatSpellDescription("$c", FAERIE_FIRE, { player: player(), caster: caster(80) }), "173", "$c is the same function");
  assert.equal(spellPowerCostFor(FAERIE_FIRE, undefined), 0xffffffff, "no unit");
});

test("ManaPerSecondPerLevel likewise grows the per-second part (0x007ff100); no dataset row carries one", () => {
  // Synthetic columns: the base dataset has no row with ManaPerSecondPerLevel.
  const channel = { id: 1, manaPerSecond: 10, manaPerSecondPerLevel: 1, baseLevel: 20 };
  assert.equal(spellPowerPerSecondFor(channel, unit(player())), 10 + (80 - 20));
  assert.equal(spellPowerPerSecondFor(channel, undefined), 0);
});

const SHIV = { id: 5938, powerType: 3, powerCost: 20, powerCostPercent: 0, manaCostPerLevel: 0, baseLevel: 70, schoolMask: 1,
  attributes: [2424848, 134217728, 537919488, 17235968, 1025, 0, 0, 0] };
const DAGGER = { flags: 1, durability: 50, maxDurability: 65, delay: 1800 };

test("AttributesEx4 0x400 adds the off hand's speed / 100 for the active player (0x008012f0)", () => {
  const offhand = (item) => (slot) => slot === 16 ? item : null;
  assert.equal(spellPowerCostFor(SHIV, unit(player(), { inventoryItem: offhand(DAGGER) })), 20 + 18);
  assert.equal(spellPowerCostFor(SHIV, unit(player(), { inventoryItem: offhand(null) })), 20 + 20, "an empty hand: 2000");
  assert.equal(spellPowerCostFor(SHIV, unit(player(), { inventoryItem: offhand({ ...DAGGER, durability: 0 }) })), 40,
    "a broken item: 2000");
  assert.equal(spellPowerCostFor(SHIV, unit(player({ UNIT_FIELD_FLAGS_2: 0x80 }), { inventoryItem: offhand(DAGGER) })), 40,
    "a disarmed off hand: 2000");
  assert.equal(spellPowerCostFor(SHIV, unit(player(), { inventoryItem: offhand({ ...DAGGER, delay: undefined }) })), undefined,
    "a template not cached: not known");
  assert.equal(spellPowerCostFor(SHIV, unit(player(), { inventoryItem: offhand(DAGGER), isActivePlayer: false })), 20,
    "only for the active player");
  // A form with a CombatRoundTime (Cat 1000) takes it instead of the weapon.
  const cat = unit(player({ UNIT_FIELD_BYTES_2: 1 << 24 }), { inventoryItem: offhand(DAGGER), formRoundTime: (form) => form === 1 ? 1000 : undefined });
  assert.equal(spellCostWeaponSpeed(SHIV, cat), 1000);
  assert.equal(spellPowerCostFor(SHIV, cat), 30);
});

const ROWS = new Map([
  [3599, { id: 3599, powerType: 0, powerCost: 0, powerCostPercent: 7, schoolMask: 1, attributes: [65536, 0, 0, 0, 0, 0, 0, 32] }],
  [5394, { id: 5394, powerType: 0, powerCost: 0, powerCostPercent: 3, schoolMask: 1, attributes: [65536, 0, 0, 0, 0, 0, 0, 32] }],
  [8071, { id: 8071, powerType: 0, powerCost: 0, powerCostPercent: 10, schoolMask: 1, attributes: [65536, 0, 0, 0, 0, 0, 67108864, 32] }],
  [6742, { id: 6742, powerType: 0, powerCost: 10, powerCostPercent: 0, schoolMask: 8, attributes: [0, 0, 0, 0, 0, 0, 0, 0] }],
]);
const CALL_OF_THE_ELEMENTS = { id: 66842, powerType: 0, powerCost: 0, powerCostPercent: 0, schoolMask: 0,
  attributes: [65536, 0, 0, 0, 0, 0, 0, 1], effects: [97, 0, 0], effectMiscValue: [0, 0, 0], effectMiscValueB: [4, 0, 0] };

test("a CAST_BUTTON spell costs the totems on its multi-cast buttons (0x008012f0 step 7)", () => {
  const bar = new Map([[132, 3599], [133, 5394], [134, 8071], [135, 6742], [136, 3599]]);
  const shaman = (extra = {}) => unit(player(), {
    actionSpell: (slot) => bar.get(slot) ?? 0, row: (id) => ROWS.get(id), ...extra });
  assert.equal(spellPowerCostFor(CALL_OF_THE_ELEMENTS, shaman()), 70 + 30 + 100,
    "buttons 132–135; 6742 has no SUMMON_PLAYER_TOTEM bit and 136 is past MiscValueB");
  assert.equal(spellPowerCostFor(CALL_OF_THE_ELEMENTS, shaman({ row: (id) => id === 5394 ? "pending" : ROWS.get(id) })), undefined);
  assert.equal(spellPowerCostFor(CALL_OF_THE_ELEMENTS, shaman({ isPlayer: false })), 0, "only a player");
});

const DISTRACTING_SHOT = { id: 20736, targets: 0, attributes: [65538, 131072, 131072, 0, 2048, 0, 8388608, 0],
  effects: [63, 6, 0], effectAura: [0, 0, 0], equippedItemClass: 2, equippedItemSubclass: 262156,
  effectBasePoints: [109, 0, 0], effectDieSides: [1, 0, 0], effectRealPointsPerLevel: [1.5, 0, 0], baseLevel: 12, maxLevel: 19,
  weaponSkillSpells: [0, 0, 264, 266, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5011, 0, 0] };
const BOWS = { id: 264, maxLevel: 0 };
const OWN_ABILITY = [{ skillLine: 163, raceMask: 0, classMask: 4, excludeRace: 0, excludeClass: 0 }];
const BOW_ABILITY = [{ skillLine: 45, raceMask: 0, classMask: 13, excludeRace: 0, excludeClass: 0 }];
const SKILLS = [
  { skillId: 163, value: 400, temporaryBonus: 0, permanentBonus: 0 },
  { skillId: 45, value: 300, temporaryBonus: 0, permanentBonus: 0 },
];

test("a weapon-requiring spell takes its level from the held weapon's proficiency (0x006d4920, 0x006dc330)", () => {
  const swap = (weapons) => ({
    weapon: (hand) => hand < weapons.length ? weapons[hand] : null, row: (id) => id === 264 ? BOWS : undefined,
    abilities: (id) => id === 264 ? BOW_ABILITY : undefined,
  });
  const bow = swap([null, null, { itemClass: 2, subClass: 2 }]);
  assert.equal(spellTextWeaponSkillSpell(DISTRACTING_SHOT, bow), 264);
  // A hunter (class 3) with Bows 300: level 60, not the Marksmanship line's 80.
  assert.equal(spellTextPlayerSpellLevel(DISTRACTING_SHOT, 3, 3, OWN_ABILITY, SKILLS, bow), 60);
  const range = spellTextEffectRange(DISTRACTING_SHOT, 0, 0, { level: () => 60 }, false);
  assert.equal(range.min, 110 + 1.5 * (60 - 12));
  // A sword (subclass 7) is outside the mask: no swap, the spell's own line (400) under its own MaxLevel 19 × 5;
  // swapped, the cap is the proficiency row's (MaxLevel 0, none).
  assert.equal(spellTextPlayerSpellLevel(DISTRACTING_SHOT, 3, 3, OWN_ABILITY, SKILLS, swap([{ itemClass: 2, subClass: 7 }])), 19);
  assert.equal(spellTextPlayerSpellLevel(DISTRACTING_SHOT, 3, 3, OWN_ABILITY, SKILLS, swap([undefined])), undefined,
    "a hand whose item is not known yet");
  assert.equal(spellTextPlayerSpellLevel({ ...DISTRACTING_SHOT, weaponSkillSpells: undefined }, 3, 3, OWN_ABILITY, SKILLS, bow),
    undefined, "an older gateway: not known, as before");
  assert.equal(spellTextWeaponSkillSpell({ ...DISTRACTING_SHOT, targets: 0x10 }, bow), 20736, "TARGET_FLAG_ITEM: never swapped");
});

const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";
test("the gateway serves the v=22 columns from the dataset's Spell.dbc", { skip: existsSync(`${DBC}/Spell.dbc`) ? false : "no dataset" }, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const rows = await loadSpellMetadata(DBC);
  assert.equal(rows.get(6950).manaCostPerLevel, 2);
  assert.equal(rows.get(6950).manaPerSecondPerLevel, 0);
  assert.equal(rows.get(20736).weaponSkillSpells[2], 264, "Bows: the first passive one-bit row of subclass 2");
  assert.equal(rows.get(20736).weaponSkillSpells[7], 0, "outside the mask");
  assert.equal(rows.get(264).weaponSkillSpells, undefined, "a proficiency (SPELL_EFFECT_WEAPON) is never swapped");
  const forms = [...rows.values()].filter((row) => row.shapeshiftCombatRoundTime === 1000);
  assert.ok(forms.length > 0 && forms.every((row) => row.effectMiscValue[row.effectAura.indexOf(36)] === 1), "Cat Form: 1000");
});
