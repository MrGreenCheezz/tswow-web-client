import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

test("GetSpellInfo exposes only resolved DBC fields by id or exact cached name", () => {
  const spells = new Map([
    [133, { id: 133, name: "Огненный шар", rank: "Уровень 1",
      iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", castTime: 1500,
      rangeMin: 0, rangeMax: 30, spellLevel: 1, powerType: 0, powerCost: 30, powerCostPercent: 0 }],
    [42833, { id: 42833, name: "Огненный шар", rank: "Уровень 16",
      iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", castTime: 3500,
      rangeMin: 0, rangeMax: 35, spellLevel: 78, powerType: 0, powerCost: 0, powerCostPercent: 16 }],
  ]);
  const seam = new LiveWorldSeam({
    world: () => undefined, store: () => undefined,
    spell: (id) => spells.get(id), spells: () => spells.values(),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (...args) => FRAMEXML_SEAM_BINDINGS.GetSpellInfo(seam, args);

  assert.ok(FRAMEXML_SEAM_NAMES.includes("GetSpellInfo"));
  // 3.43 (15.11): 3.3.5's order (Wow.exe 0x00540a30): name, rank, icon, cost, isFunnel, powerType, castTime, and the
  // range pair only with a player. With none the cost function answers 0xffffffff, -1 over mana's scale of 1.
  assert.deepEqual(call(133), ["Огненный шар", "Уровень 1",
    "Interface\\Icons\\Spell_Fire_FlameBolt", -1, false, 0, 1500]);
  assert.deepEqual(call("Огненный шар"), ["Огненный шар", "Уровень 16",
    "Interface\\Icons\\Spell_Fire_FlameBolt", -1, false, 0, 3500]);
  assert.deepEqual(call("огненный шар"), []);
  assert.deepEqual(call(999999), []);
  assert.deepEqual(call(0), []);
  assert.deepEqual(call(null), []);
});

// 3.43 (15.11): with a player, the cost function's answer and the range pair (Wow.exe 0x00540a30). 755 «Канал
// здоровья» rank 1 (dataset row: PowerType -2, ManaCost 11, ManaPerSecond 5, BaseLevel 12) is a funnel: the
// per-second part replaces the cost and isFunnel is true; 6950 «Волшебный огонь» (15 + 2 a level from 1) is not.
test("GetSpellInfo answers the cost function's cost, isFunnel and powerType with a player", async () => {
  const { frameXmlSpellInfo } = await import("../dist/code/browser/framexml/FrameXmlSpellInfo.js");
  const context = { player: { slot: () => undefined, basePower: () => 1000 }, caster: { level: () => 80 } };
  const funnel = { id: 755, name: "Канал здоровья", rank: "Уровень 1", iconPath: "x", castTime: 0, rangeMin: 0, rangeMax: 20,
    powerType: -2, powerCost: 11, powerCostPercent: 0, manaPerSecond: 5, manaPerSecondPerLevel: 0, baseLevel: 12,
    schoolMask: 32, attributes: [65536, 0, 0, 0, 0, 0, 0, 0] };
  assert.deepEqual(frameXmlSpellInfo(funnel, context), ["Канал здоровья", "Уровень 1", "x", 5, true, -2, 0, 0, 20]);
  const faerieFire = { id: 6950, name: "Волшебный огонь", rank: "Уровень 1", iconPath: "y", castTime: 0, rangeMin: 0, rangeMax: 30,
    powerType: 0, powerCost: 15, powerCostPercent: 0, manaCostPerLevel: 2, manaPerSecond: 0, baseLevel: 1, schoolMask: 8,
    attributes: [0, 98304, 0, 0, 0, 0, 0, 0] };
  assert.deepEqual(frameXmlSpellInfo(faerieFire, context), ["Волшебный огонь", "Уровень 1", "y", 173, false, 0, 0, 0, 30]);
  assert.deepEqual(frameXmlSpellInfo({ ...faerieFire, attributes: [0x40, 0, 0, 0, 0, 0, 0, 0], castTime: 1500 }, context)[6], 0,
    "a passive spell's cast time is 0");
});

test("GetSpellInfo leaves unresolved or incomplete spell data nil", () => {
  const partial = { id: 133, name: "Огненный шар", rank: "Уровень 1",
    iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt" };
  const seam = new LiveWorldSeam({
    world: () => undefined, store: () => undefined,
    spell: (id) => id === 133 ? partial : undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSpellInfo(seam, [133]), []);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSpellInfo(seam, ["Огненный шар"]), []);
  assert.deepEqual(FRAMEXML_SEAM_BINDINGS.GetSpellInfo({}, [133]), []);
});
