import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_NAMES } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

test("GetSpellInfo exposes only resolved DBC fields by id or exact cached name", () => {
  const spells = new Map([
    [133, { id: 133, name: "Огненный шар", rank: "Уровень 1",
      iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", castTime: 1500,
      rangeMin: 0, rangeMax: 30, spellLevel: 1 }],
    [42833, { id: 42833, name: "Огненный шар", rank: "Уровень 16",
      iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", castTime: 3500,
      rangeMin: 0, rangeMax: 35, spellLevel: 78 }],
  ]);
  const seam = new LiveWorldSeam({
    world: () => undefined, store: () => undefined,
    spell: (id) => spells.get(id), spells: () => spells.values(),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (...args) => FRAMEXML_SEAM_BINDINGS.GetSpellInfo(seam, args);

  assert.ok(FRAMEXML_SEAM_NAMES.includes("GetSpellInfo"));
  assert.deepEqual(call(133), ["Огненный шар", "Уровень 1",
    "Interface\\Icons\\Spell_Fire_FlameBolt", 1500, 0, 30, 133]);
  assert.deepEqual(call("Огненный шар"), ["Огненный шар", "Уровень 16",
    "Interface\\Icons\\Spell_Fire_FlameBolt", 3500, 0, 35, 42833]);
  assert.deepEqual(call("огненный шар"), []);
  assert.deepEqual(call(999999), []);
  assert.deepEqual(call(0), []);
  assert.deepEqual(call(null), []);
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
