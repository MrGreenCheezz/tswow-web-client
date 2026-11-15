import assert from "node:assert/strict";
import test from "node:test";

// range8 (15.11): the spellbook globals' argument forms (Wow.exe 0x00540670) and the spell questions without a binding
// before — IsSpellInRange 0x00541c60, SpellHasRange 0x00541af0, IsHelpfulSpell 0x00541800, IsHarmfulSpell 0x005418f0,
// IsAttackSpell 0x00541420, IsConsumableSpell 0x005419f0, GetSpellCount 0x00540df0, IsAutoRepeatSpell 0x005415d0 — and
// the item twins ItemHasRange 0x0051c870, IsHelpfulItem 0x005171f0, IsHarmfulItem 0x005172e0
// (src/browser/framexml/FrameXmlSpellQueries.ts, FrameXmlRangeQueries.ts). The spell rows are this dataset's
// (/dbc/spells?v=23, the columns the questions read); item 118 «Малое лечебное зелье» with its on-use spell 439 as
// tests/framexml-item.test.mjs has it.

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { frameXmlSpellHasRange } = await import("../dist/code/browser/framexml/FrameXmlSpellQueries.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { REACTION_FRIENDLY, REACTION_HOSTILE } = await import("../dist/code/world/FactionRules.js");

const F = (name) => UPDATE_FIELDS[name].offset;
const bits = (value) => new DataView(Float32Array.of(value).buffer).getUint32(0, true);

const row = (id, name, rank, iconPath, fields) => ({
  id, name, rank, iconPath, passive: false, hidden: false, spellLevel: 1, castTime: 0, powerType: 0, powerCost: 0,
  powerCostPercent: 0, targetCreatureType: 0, implicitTargetB: [0, 0, 0], effectAura: [0, 0, 0], reagents: [],
  rangeMin: 0, rangeMinFriendly: 0, ...fields,
});
const FIREBALL = row(133, "Огненный шар", "Уровень 1", "Interface\\Icons\\Spell_Fire_FlameBolt", {
  targets: 0, implicitTargetA: [6, 6, 0], effectAura: [0, 3, 0], effects: [2, 6, 0], rangeMax: 35, rangeMaxFriendly: 35,
  rangeFlags: 0, attributes: [65536, 0, 0, 0, 0, 0, 0, 0], spellClassSet: 3, spellClassMask: [1, 0, 8] });
const LESSER_HEAL = row(2050, "Малое исцеление", "Уровень 1", "Interface\\Icons\\Spell_Holy_LesserHeal", {
  targets: 0, implicitTargetA: [21, 0, 0], effects: [10, 0, 0], rangeMax: 40, rangeMaxFriendly: 40, rangeFlags: 0,
  attributes: [65536, 0, 524288, 0, 0, 0, 0, 0], spellClassSet: 6, spellClassMask: [262144, 0, 0] });
const ATTACK = row(6603, "Автоматическая атака", "", "Interface\\Icons\\INV_Sword_04", {
  targets: 0, implicitTargetA: [0, 0, 0], effects: [78, 0, 0], rangeMax: 0, rangeMaxFriendly: 0, rangeFlags: 0,
  attributes: [16, 0, 0, 0, 0, 0, 0, 0], spellClassSet: 0, spellClassMask: [0, 0, 0] });
const AUTO_SHOT = row(75, "Автоматическая стрельба", "", "Interface\\Icons\\Ability_Whirlwind", {
  targets: 0, implicitTargetA: [6, 0, 0], effects: [58, 0, 0], rangeMax: 35, rangeMaxFriendly: 35, rangeFlags: 2,
  attributes: [327698, 0, 32, 32768, 16777217, 0, 0, 0], spellClassSet: 9, spellClassMask: [1, 0, 0], autoRepeat: true });
const REBIRTH = row(20484, "Возрождение", "Уровень 1", "Interface\\Icons\\Spell_Nature_Reincarnation", {
  targets: 32768, implicitTargetA: [0, 0, 0], effects: [113, 0, 0], reagents: [{ itemId: 17034, count: 1 }],
  rangeMax: 30, rangeMaxFriendly: 30, rangeFlags: 0, attributes: [65536, 131072, 0, 16, 65536, 0, 0, 0],
  spellClassSet: 7, spellClassMask: [285212672, 0, 0] });
const SINISTER_STRIKE = row(1752, "Коварный удар", "Уровень 1", "Interface\\Icons\\Spell_Shadow_RitualOfSacrifice", {
  targets: 0, implicitTargetA: [6, 6, 0], effects: [121, 80, 0], rangeMax: 5, rangeMaxFriendly: 5, rangeFlags: 1,
  attributes: [327696, 134218240, 0, 1024, 0, 0, 0, 0], spellClassSet: 8, spellClassMask: [8388610, 0, 0] });
const HEALING_POTION = row(439, "Лечебное зелье", "", "x", {
  targets: 0, implicitTargetA: [1, 0, 0], effects: [10, 0, 0], rangeMax: 0, rangeMaxFriendly: 0, rangeFlags: 0,
  attributes: [671088640, 0, 0, 0, 0, 0, 0, 0], spellClassSet: 13, spellClassMask: [0, 0, 0] });
const ROWS = new Map([FIREBALL, LESSER_HEAL, ATTACK, AUTO_SHOT, REBIRTH, SINISTER_STRIKE, HEALING_POTION]
  .map((spell) => [spell.id, spell]));

let nextGuid = 0x100n;
function unit({ player = false, x = 0, faction = 1 } = {}) {
  const fields = new Map([
    [F("UNIT_FIELD_HEALTH"), 100], [F("UNIT_FIELD_FLAGS"), player ? 0x8 : 0], [F("UNIT_FIELD_COMBATREACH"), bits(1.5)],
    [F("UNIT_FIELD_FACTIONTEMPLATE"), faction],
  ]);
  return { guid: nextGuid++, typeId: player ? 4 : 3, position: { x, y: 0, z: 0 }, movementFlags: 0, fields };
}

/** The seam over a book of [Fireball, Lesser Heal, Attack, Auto Shot, Rebirth, Sinister Strike]; `bags` holds reagents. */
function fixture(bags = new Map()) {
  const me = unit({ player: true });
  const enemy = unit({ faction: 2, x: 20 });
  const far = unit({ faction: 2, x: 60 });
  const world = {
    state: { selfGuid: me.guid, objects: new Map([[me.guid, me], [enemy.guid, enemy], [far.guid, far]]) },
    knownSpells: [133, 2050, 6603, 75, 20484, 1752].map((id, slot) => ({ id, slot })),
    actionButtons: [], casts: new Map(), cooldownRemaining: () => 0, targetGuid: enemy.guid,
    itemTemplates: new Map([[118, { found: true, name: "Малое лечебное зелье", spells: [{ spellId: 439, trigger: 0 }] }],
      [90001, { found: true, name: "Огненный свиток", spells: [{ spellId: 133, trigger: 0 }] }]]),
    creatureTemplates: new Map(), spellModifiers: new Map(),
  };
  class Seam extends LiveWorldSeam {
    itemCount(entry) { return bags.get(entry) ?? 0; }
  }
  const seam = new Seam({
    world: () => world, store: () => undefined, spell: (id) => ROWS.get(id),
    monotonic: () => 1000, globalCooldownUntil: () => 0, castSpell: () => {},
    reaction: (left, right) => left.fields.get(F("UNIT_FIELD_FACTIONTEMPLATE")) === right.fields.get(F("UNIT_FIELD_FACTIONTEMPLATE"))
      ? REACTION_FRIENDLY : REACTION_HOSTILE,
  });
  const call = (name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
  return { seam, world, call, me, enemy, far };
}

test("0x00540670: a slot with its book, a name with `!`, `Name(Rank)` cut at the last bracket, a rank; a lone number is a name", () => {
  const { call } = fixture();
  assert.deepEqual(call("GetSpellName", 1, "spell"), ["Огненный шар", "Уровень 1"]);
  assert.deepEqual(call("GetSpellName", "Огненный шар"), ["Огненный шар", "Уровень 1"], "the name form");
  assert.deepEqual(call("GetSpellName", "!Огненный шар"), ["Огненный шар", "Уровень 1"]);
  assert.deepEqual(call("GetSpellName", "Огненный шар(Уровень 1)"), ["Огненный шар", "Уровень 1"]);
  assert.deepEqual(call("GetSpellName", "Огненный шар", "Уровень 1"), ["Огненный шар", "Уровень 1"], "a rank argument");
  assert.deepEqual(call("GetSpellName", "Огненный шар", "Уровень 2"), [], "a rank the book lacks");
  // 0x0076e720 searches from the end: «Name(Rank)()» is the name «Name(Rank)» with an empty rank (MSBT appends «()»).
  assert.deepEqual(call("GetSpellName", "Огненный шар(Уровень 1)()"), [], "no spell is named «Огненный шар(Уровень 1)»");
  assert.deepEqual(call("GetSpellName", 5), [], "a lone number with no book is the name «5»");
  assert.deepEqual(call("GetSpellName", "Чародейский взрыв"), [], "a name outside the book");
  assert.deepEqual(call("GetSpellTexture", "Малое исцеление"), ["Interface\\Icons\\Spell_Holy_LesserHeal"]);
  assert.deepEqual(call("IsPassiveSpell", "Огненный шар"), [false]);
  assert.deepEqual(call("GetSpellCooldown", "Огненный шар"), [0, 0, 1], "MSBT's GetSpellCooldown(name)");
  assert.deepEqual(call("GetSpellCooldown", 133), [0, 0, 1], "a lone number here is a spell id (0x00540e80)");
});

test("IsHelpfulSpell, IsHarmfulSpell, IsAttackSpell, IsConsumableSpell: 1 or nil by the row", () => {
  const { call } = fixture();
  assert.deepEqual(call("IsHarmfulSpell", "Огненный шар"), [1], "ImplicitTargetA 6");
  assert.deepEqual(call("IsHelpfulSpell", "Огненный шар"), []);
  assert.deepEqual(call("IsHelpfulSpell", 2, "spell"), [1], "ImplicitTargetA 21");
  assert.deepEqual(call("IsHarmfulSpell", 2, "spell"), []);
  assert.deepEqual(call("IsHelpfulSpell", "Автоматическая атака"), [], "neither");
  assert.deepEqual(call("IsHarmfulSpell", "Автоматическая атака"), []);
  assert.deepEqual(call("IsAttackSpell", "Автоматическая атака"), [1], "SPELL_EFFECT_ATTACK first");
  assert.deepEqual(call("IsAttackSpell", "Коварный удар"), []);
  assert.deepEqual(call("IsConsumableSpell", "Возрождение"), [1], "a reagent");
  assert.deepEqual(call("IsConsumableSpell", "Огненный шар"), []);
  assert.deepEqual(call("IsHarmfulSpell", 7, "spell"), [], "past the book");
});

test("GetSpellCount: the casts the bags hold, 0 without reagents; nothing for a name the book lacks", () => {
  assert.deepEqual(fixture(new Map([[17034, 3]])).call("GetSpellCount", "Возрождение"), [3]);
  assert.deepEqual(fixture().call("GetSpellCount", "Возрождение"), [0]);
  assert.deepEqual(fixture().call("GetSpellCount", 1, "spell"), [0], "no reagents");
  assert.deepEqual(fixture().call("GetSpellCount", 99, "spell"), [0], "a slot past the book is still a number");
  assert.deepEqual(fixture().call("GetSpellCount", "Нет такого"), []);
});

test("IsSpellInRange: 1, 0, nil — the action bar's rule, from the player; a text no unit parser takes is nil", () => {
  const { call, world, far } = fixture();
  assert.deepEqual(call("IsSpellInRange", "Огненный шар", "target"), [1]);
  assert.deepEqual(call("IsSpellInRange", 1, "spell", "target"), [1], "the slot form takes its unit third");
  assert.deepEqual(call("IsSpellInRange", "Малое исцеление", "target"), [], "a heal cannot take the enemy");
  assert.deepEqual(call("IsSpellInRange", "Малое исцеление", "player"), [1]);
  assert.deepEqual(call("IsSpellInRange", "Огненный шар", "чепуха"), [], "0x0060abf0 refuses it");
  assert.deepEqual(call("IsSpellInRange", "Огненный шар"), [], "no unit");
  world.targetGuid = far.guid;
  assert.deepEqual(call("IsSpellInRange", "Огненный шар", "target"), [0]);
  world.targetGuid = undefined;
  assert.deepEqual(call("IsSpellInRange", "Огненный шар", "target"), []);
});

test("SpellHasRange: either end of the range pair not 0; melee and ranged rows always", () => {
  const { call } = fixture();
  assert.deepEqual(call("SpellHasRange", "Огненный шар"), [1]);
  assert.deepEqual(call("SpellHasRange", "Автоматическая атака"), [], "0 and 0");
  assert.deepEqual(call("SpellHasRange", "Коварный удар"), [1], "a melee row");
  assert.deepEqual(call("SpellHasRange", "Автоматическая стрельба"), [1], "a ranged row");
  const host = { rangedModRange: () => undefined, playerSpellFamily: () => 3, spellModifiers: () => [] };
  assert.equal(frameXmlSpellHasRange(ATTACK, true, host), false);
  assert.equal(frameXmlSpellHasRange({ ...ATTACK, attributes: [0x400, 0, 0, 0, 0, 0, 0, 0] }, true, host), true,
    "an on-next-swing spell: 0..100");
  assert.equal(frameXmlSpellHasRange({ ...FIREBALL, rangeMax: 0, rangeMaxFriendly: 0 }, true,
    { ...host, spellModifiers: () => [{ effectIndex: 0, op: 5, value: 5, pct: false }] }), true, "SPELLMOD_RANGE flat");
});

test("IsAutoRepeatSpell: the player's book, the repeating or the wanted spell", () => {
  const { call, world } = fixture();
  assert.deepEqual(call("IsAutoRepeatSpell", "Автоматическая стрельба"), []);
  world.autoRepeatSpellId = 75;
  assert.deepEqual(call("IsAutoRepeatSpell", "Автоматическая стрельба"), [1]);
  assert.deepEqual(call("IsAutoRepeatSpell", 4, "spell"), [1]);
  assert.deepEqual(call("IsAutoRepeatSpell", 4, "pet"), [], "never the pet book");
  world.autoRepeatSpellId = undefined;
  world.autoRanged = { wantedSpellId: 75 };
  assert.deepEqual(call("IsAutoRepeatSpell", "Автоматическая стрельба"), [1], "the wanted one (0x007fe180)");
});

test("IsCurrentSpell takes a lone id, a slot or a name (0x00541500)", () => {
  const asked = [];
  const seam = {
    spellBookSlotByName: (text) => (text === "Огненный шар" ? { slot: 1, pet: false } : undefined),
    spellBookRowAt: (slot, pet) => (slot === 1 && !pet ? FIREBALL : undefined),
    multiCast: { isCurrentSpell: (id) => { asked.push(id); return id === 133; } },
  };
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.IsCurrentSpell(seam, [133])], [1]);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.IsCurrentSpell(seam, ["Огненный шар"])], [1]);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.IsCurrentSpell(seam, [1, "spell"])], [1]);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.IsCurrentSpell(seam, ["Нет такого"])], []);
  assert.deepEqual(asked, [133, 133, 133]);
});

test("GetSpellCooldown(id) of a pet spell reads the pet's cooldown (0x00540e80's book search)", () => {
  const { seam } = fixture();
  seam.petActions = {
    book: () => ({ count: 1, token: "PET" }),
    bookSpell: (index) => (index === 1 ? { spellId: 17253, name: "Укус", rank: "Уровень 1" } : undefined),
    bookCooldown: () => [5, 10, 1],
    spellAt: (index) => (index === 4 ? 990001 : undefined),
    cooldown: (index) => (index === 4 ? [7, 2, 1] : [0, 0, 0]),
  };
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetSpellCooldown(seam, [17253])], [5, 10, 1], "the pet book");
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetSpellCooldown(seam, [990001])], [7, 2, 1], "the pet bar");
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetSpellCooldown(seam, [133])], [0, 0, 1], "the player's book");
});

test("FindSpellBookSlotByID answers 0x0053b4e0's 0-based array index (0x0053b6c0 pushes it as it is)", () => {
  const { call, seam } = fixture();
  assert.deepEqual(call("FindSpellBookSlotByID", 2050), [1], "the second slot: index 1");
  assert.deepEqual(call("GetSpellName", 2, "spell"), ["Малое исцеление", "Уровень 1"], "which GetSpellName reads as slot 2");
  assert.deepEqual(call("FindSpellBookSlotByID", 17253), [], "not in the book");
  seam.petActions = { book: () => ({ count: 1, token: "PET" }), bookSpell: (index) => (index === 1 ? { spellId: 17253 } : undefined) };
  assert.deepEqual(call("FindSpellBookSlotByID", 17253, true), [0], "the pet's array");
  assert.deepEqual(call("FindSpellBookSlotByID", 17253, 1), [0]);
  assert.throws(() => call("FindSpellBookSlotByID", 0), /Usage: FindSpellBookSlotByID/);
  assert.throws(() => call("FindSpellBookSlotByID"), /Usage: FindSpellBookSlotByID/);
});

test("ItemHasRange, IsHelpfulItem, IsHarmfulItem by the item's on-use spell", () => {
  const { call } = fixture();
  assert.deepEqual(call("IsHelpfulItem", 118), [1], "ImplicitTargetA 1 with no dummy aura");
  assert.deepEqual(call("IsHarmfulItem", 118), []);
  assert.deepEqual(call("ItemHasRange", 118), [], "a self-cast potion has no range");
  assert.deepEqual(call("IsHarmfulItem", 90001), [1]);
  assert.deepEqual(call("ItemHasRange", "Огненный свиток"), [1], "by the item cache's name");
  assert.deepEqual(call("IsHelpfulItem", 4), [], "an item not cached");
});
