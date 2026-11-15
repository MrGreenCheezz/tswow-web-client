// 3.43 (15.11): Wow.exe 3.3.5a 12340's cast time 0x007ff180 and GetSpellInfo's range pair (0x00540a30 → 0x00801650,
// 0x007ff380, 0x007ff400), src/browser/ui/SpellCastTimeRange.ts, plus the cost function's gtNPCManaCostScaler step for a
// pet (0x008012f0 step 6, SpellTextCost.ts and SpellTextPetCost.ts) and the multi-cast step's macro buttons
// (SpellTextActionSpell.ts). Rows are the base dataset's, read from the running gateway (`/dbc/spells?v=22`) and its
// Spell.dbc / SpellCastTimes.dbc on 2026-11-15:
// 2166 «Укрепленный кожаный доспех» (SpellCastTimes 35: 12500, −250 a level, minimum 5000; Attributes 0x10020),
// 133 «Огненный шар» (1500; Attributes 0x10000; family 3, mask [1, 0, 8]), 56641 «Верный выстрел» (SpellCastTimes 16:
// 1500, minimum 1500; Attributes 0x410012; ranged range row 0–35), 3044 «Чародейский выстрел» (SpellCastTimes 18:
// −1000000; Attributes 0x10002), 78 «Удар героя» (melee range row), 9053 «Огненный шар» of a creature (ManaCost 90,
// SpellLevel 20, Attributes 0x90000), 66842 «Зов Стихий» and 3599 «Опаляющий тотем» (7 % of base mana, AttributesExG 0x20).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { spellCastTimeFor, spellInfoRangeFor } = await import("../dist/code/browser/ui/SpellCastTimeRange.js");
const { spellPowerCostFor } = await import("../dist/code/browser/ui/SpellTextCost.js");
const { spellTextPetCostUnit, spellTextUnitSpellLevel } = await import("../dist/code/browser/ui/SpellTextPetCost.js");
const { installSpellTextActionSpell } = await import("../dist/code/browser/ui/SpellTextActionSpell.js");
const { spellTextLivePlayer } = await import("../dist/code/browser/ui/SpellTextLiveContext.js");

const DBC = "F:/tswowRoot/tswow-install/modules/default/datasets/dataset/dbc";

const floatBits = (value) => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
function words(fields) {
  const map = new Map();
  for (const [name, value] of Object.entries(fields)) map.set(UPDATE_FIELDS[name].offset, value);
  return map;
}
const unitOf = (fields, extra = {}) => {
  const map = words(fields);
  return { player: { slot: (index) => map.get(index) }, caster: { level: () => 80 }, isPlayer: true, isActivePlayer: true, ...extra };
};

const LEATHER = { id: 2166, castTime: 12500, castTimePerLevel: -250, castTimeMinimum: 5000, baseLevel: 0,
  attributes: [0x10020, 1024, 0, 0, 0, 0, 0, 0] };
const FIREBALL = { id: 133, castTime: 1500, castTimePerLevel: 0, castTimeMinimum: 1500, baseLevel: 1, spellClassSet: 3,
  spellClassMask: [1, 0, 8], attributes: [0x10000, 0, 0, 0, 0, 0, 0, 0], rangeMin: 0, rangeMax: 35, rangeFlags: 0 };
const STEADY = { id: 56641, castTime: 1500, castTimePerLevel: 0, castTimeMinimum: 1500, baseLevel: 50, spellClassSet: 9,
  spellClassMask: [0, 1, 0], attributes: [4259858, 0, 131072, 0, 134217728, 0, 0, 0], rangeMin: 0, rangeMax: 35,
  rangeMinFriendly: 0, rangeMaxFriendly: 35, rangeFlags: 2, targets: 0, implicitTargetA: [6, 0, 0], implicitTargetB: [0, 0, 0] };
const ARCANE = { id: 3044, castTime: -1000000, castTimePerLevel: 0, castTimeMinimum: -1000000, baseLevel: 6,
  attributes: [65538, 0, 131072, 0, 0, 0, 0, 0] };

test("the SpellCastTimes growth and floor by the unit's level for the spell; TRADESPELL skips the cast speed (0x007ff180)", () => {
  const at = (level, speed) => spellCastTimeFor(LEATHER, unitOf(speed === undefined ? {} : { UNIT_MOD_CAST_SPEED: floatBits(speed) },
    { caster: { level: () => level } }));
  assert.equal(at(10), 12500 - 250 * 10);
  assert.equal(at(60), 5000, "not below Minimum");
  assert.equal(at(10, 0.5), 10000, "Attributes 0x20: no cast speed");
  assert.equal(spellCastTimeFor({ ...LEATHER, castTimePerLevel: undefined, castTimeMinimum: undefined }, unitOf({})), 12500,
    "an older gateway: the base, as before");
  assert.equal(spellCastTimeFor(LEATHER, unitOf({}, { caster: { level: () => undefined } })), undefined, "a level not known yet");
});

test("UNIT_MOD_CAST_SPEED and SPELLMOD_CASTING_TIME on an ordinary spell (0x007ff180)", () => {
  assert.equal(spellCastTimeFor(FIREBALL, unitOf({ UNIT_MOD_CAST_SPEED: floatBits(0.8) })), 1200);
  assert.equal(spellCastTimeFor(FIREBALL, unitOf({ UNIT_MOD_CAST_SPEED: floatBits(1) })), 1500);
  assert.equal(spellCastTimeFor(FIREBALL, unitOf({})), 1500, "a field never sent is left alone");
  assert.equal(spellCastTimeFor(FIREBALL, undefined), 1500, "no player: the row's time");
  // Family bit 0 of SpellClassMask word 0 (Fireball's bit 1), op 10, flat −500 then 10 % faster.
  const modifiers = [{ effectIndex: 0, op: 10, value: -500, pct: false }, { effectIndex: 0, op: 10, value: -10, pct: true }];
  const caster = { level: () => 80, family: 3, modifiers: () => modifiers };
  assert.equal(spellCastTimeFor(FIREBALL, unitOf({ UNIT_MOD_CAST_SPEED: floatBits(1) }, { caster })), Math.trunc((1500 - 500) * 90 / 100));
  assert.equal(spellCastTimeFor(FIREBALL, unitOf({}, { caster: { ...caster, family: 4 } })), 1500, "another family's modifiers");
});

test("a ranged spell: + 500, then × RangedAttackTime / the ranged weapon's Delay (0x007ff29b..0x007ff354)", () => {
  const bow = (delay) => (slot) => slot === 17 ? { flags: 1, durability: 10, maxDurability: 10, delay } : null;
  const hasted = unitOf({ UNIT_FIELD_RANGEDATTACKTIME: 2520, UNIT_MOD_CAST_SPEED: floatBits(0.5) }, { inventoryItem: bow(2800) });
  assert.equal(spellCastTimeFor(STEADY, hasted), Math.trunc((2520 / 2800) * 2000), "ABILITY: no cast speed, the bow's haste only");
  assert.equal(spellCastTimeFor(STEADY, unitOf({ UNIT_FIELD_RANGEDATTACKTIME: 2520 }, { inventoryItem: () => null })), 2000,
    "no ranged weapon: + 500 alone");
  assert.equal(spellCastTimeFor(STEADY, unitOf({}, { inventoryItem: bow(undefined) })), undefined, "a template not cached");
  assert.equal(spellCastTimeFor(STEADY, unitOf({}, { inventoryItem: bow(2800) }), true), 2000, "a pet spell: no weapon");
  // SpellCastTimes 18 is −1000000 with a −1000000 floor: the shot stays far below 1, which the tooltip calls instant.
  assert.equal(spellCastTimeFor(ARCANE, unitOf({ UNIT_FIELD_RANGEDATTACKTIME: 2800 }, { inventoryItem: bow(2800) })), -999500);
});

test("GetSpellInfo's range: melee 0/0, a ranged row's min 5 + RangeMin, RangedModRange and SPELLMOD_RANGE (0x00540a30)", () => {
  const player = unitOf({});
  assert.deepEqual(spellInfoRangeFor({ rangeFlags: 1, rangeMin: 0, rangeMax: 5, attributes: [327700] }, player, false, () => undefined),
    [0, 0], "78 «Удар героя»: a melee row");
  assert.deepEqual(spellInfoRangeFor(STEADY, player, false, () => undefined), [5, 35]);
  assert.deepEqual(spellInfoRangeFor(STEADY, player, false, () => 110), [5, Math.fround(Math.fround(110 * Math.fround(0.01)) * 35)],
    "SPELL_ATTR0 0x2 on a player: the ranged weapon's percent");
  assert.deepEqual(spellInfoRangeFor(STEADY, { ...player, isPlayer: false }, false, () => 110), [5, 35], "not on a pet");
  const caster = { level: () => 80, family: 3, modifiers: () => [{ effectIndex: 0, op: 5, value: 5, pct: false }] };
  assert.deepEqual(spellInfoRangeFor(FIREBALL, { ...player, caster }, false, () => undefined), [0, 40], "SPELLMOD_RANGE");
  assert.deepEqual(spellInfoRangeFor({ ...FIREBALL, attributes: [0x400] }, player, false, () => undefined), [0, 100],
    "an on-next-swing spell");
});

test("GetSpellInfo's castTime is the cast-time function's (FrameXmlSpellInfo.ts)", async () => {
  const { frameXmlSpellInfo } = await import("../dist/code/browser/framexml/FrameXmlSpellInfo.js");
  const map = words({ UNIT_MOD_CAST_SPEED: floatBits(0.8) });
  const context = { player: { slot: (index) => map.get(index), basePower: () => 1000 }, caster: { level: () => 80 } };
  const row = { ...FIREBALL, name: "Огненный шар", rank: "Уровень 1", iconPath: "x", powerType: 0, powerCost: 30,
    powerCostPercent: 0, manaPerSecond: 0, schoolMask: 4 };
  assert.deepEqual(frameXmlSpellInfo(row, context), ["Огненный шар", "Уровень 1", "x", 30, false, 0, 1200, 0, 35]);
});

test("a non-player's level for a spell is UNIT_FIELD_LEVEL capped at MaxLevel (0x0071aa70)", () => {
  const pet = { typeId: 3, fields: words({ UNIT_FIELD_LEVEL: 30 }) };
  assert.equal(spellTextUnitSpellLevel(pet, { maxLevel: 0 }), 30);
  assert.equal(spellTextUnitSpellLevel(pet, { maxLevel: 20 }), 20);
});

test("gtNPCManaCostScaler scales a pet's cost by its level against SpellLevel (0x008012f0 step 6)",
  { skip: existsSync(`${DBC}/gtNPCManaCostScaler.dbc`) ? false : "no dataset" }, async () => {
    const { loadNpcManaCostScaler } = await import("../dist/code/gateway/NpcManaCostScalerMetadata.js");
    const { NPC_MANA_COST_SCALER_ROUTE_VERSION, npcManaCostScalerFrom } = await import("../dist/code/browser/NpcManaCostScalerClient.js");
    const catalog = await loadNpcManaCostScaler(DBC);
    assert.equal(catalog.version, NPC_MANA_COST_SCALER_ROUTE_VERSION, "the gateway and the browser agree on the route's shape");
    const scaler = npcManaCostScalerFrom(JSON.parse(JSON.stringify(catalog)));
    assert.equal(scaler.length, 100);
    const npcFireball = { id: 9053, powerType: 0, powerCost: 90, powerCostPercent: 0, manaCostPerLevel: 0, baseLevel: 20,
      spellLevel: 20, schoolMask: 4, attributes: [589824, 0, 0, 0, 0, 0, 0, 0] };
    const pet = (level, table = scaler) => spellTextPetCostUnit({ typeId: 3, fields: words({ UNIT_FIELD_LEVEL: level }) }, {},
      table ?? undefined);
    const expected = Math.round(Math.fround((scaler[29] / Math.fround(scaler[19])) * 90));
    assert.equal(spellPowerCostFor(npcFireball, pet(30)), expected);
    assert.notEqual(expected, 90, "the table moves it");
    assert.equal(spellPowerCostFor(npcFireball, pet(20)), 90, "at SpellLevel the ratio is 1");
    assert.equal(spellPowerCostFor(npcFireball, pet(30, null)), undefined, "the table not landed: unknown");
    assert.equal(spellPowerCostFor(npcFireball, pet(0)), undefined, "a row outside the table: unknown");
    assert.equal(spellPowerCostFor({ ...npcFireball, attributes: [0x10000, 0, 0, 0, 0, 0, 0, 0] }, pet(30)), 90,
      "without SPELL_ATTR0 0x80000 the cost stays");
    assert.equal(spellPowerCostFor(npcFireball, { ...pet(30), isPlayer: true }), 90, "a player is never scaled");
  });

test("the multi-cast step counts a macro button's spell through the installed resolver (0x005a8c30 → 0x005a89f0)", () => {
  const self = { typeId: 4, fields: words({ UNIT_FIELD_BASE_MANA: 1000 }) };
  const world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self]]) }, knownSpells: [], auras: new Map(), itemTemplates: new Map(),
    actionButtons: [{ slot: 132, action: 3599, type: 0 }, { slot: 133, action: 7, type: 0x40 }],
  };
  const totem = { id: 3599, powerType: 0, powerCost: 0, powerCostPercent: 7, schoolMask: 1, attributes: [65536, 0, 0, 0, 0, 0, 0, 32] };
  const call = { id: 66842, powerType: 0, powerCost: 0, powerCostPercent: 0, schoolMask: 0, attributes: [65536, 0, 0, 0, 0, 0, 0, 1],
    effects: [97, 0, 0], effectMiscValue: [0, 0, 0], effectMiscValueB: [2, 0, 0] };
  const spells = new Map([[3599, totem], [66842, call]]);
  const player = spellTextLivePlayer(world, spells);
  const unit = { player, caster: { level: () => 80 }, isPlayer: true, isActivePlayer: true, actionSpell: player.actionSpell,
    row: (id) => spells.get(id) };
  assert.equal(player.actionSpell(133), undefined, "no resolver: a macro button is unknown");
  assert.equal(spellPowerCostFor(call, unit), undefined);
  const off = installSpellTextActionSpell((slot) => slot === 133 ? 3599 : 0);
  try {
    assert.equal(player.actionSpell(133), 3599);
    assert.equal(spellPowerCostFor(call, unit), 70 + 70, "the macro's totem counts like the plain one");
  } finally {
    off();
  }
});
