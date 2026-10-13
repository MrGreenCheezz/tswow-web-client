import assert from "node:assert/strict";
import test from "node:test";

// Plan item 4.03 (13.10): the first line of the stock stamina and intellect tooltips reads two C APIs, answered
// here as Wow.exe 3.3.5a 12340 answers them (read-only Ghidra, .runtime/re-2026-10-11/glue-1110/t1013-b.txt, -c.txt):
// GetUnitMaxHealthModifier 0x00612870 (UNIT_FIELD_MAXHEALTHMODIFIER + 1.0f for the player or a pet, else 0) and
// GetSpellCritChanceFromIntellect 0x0060e1b0 → 0x0071bb70 ((ratio · max(0, INT) + base) · 100 for the player or a
// pet, 0 when the class ratio at the level is 0, 0 for any other unit).
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { maxHealthModifierOf, spellCritFromIntellectOf } = await import("../dist/code/world/StatTooltipValues.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const F = (name) => UPDATE_FIELDS[name].offset;
const floatWord = (value) => { const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true); return view.getUint32(0, true); };
const unit = (guid, typeId, fields) => ({ guid, typeId, fields: new Map(Object.entries(fields).map(([name, value]) => [F(name), value])) });

/** Mage (8) at level 80 and an imp's class (8) at 70; warrior (1) has no ratio. */
function catalog() {
  const ratio = Array(800).fill(0);
  ratio[7 * 100 + 79] = 0.00006;
  ratio[7 * 100 + 69] = 0.0001;
  const base = [0, 0, 0, 0, 0, 0, 0, 0.0091];
  return { spellCritBase: base, spellCritPerIntellect: ratio };
}

test("GetUnitMaxHealthModifier: the field + 1 for the player or a pet, 0 for anyone else", () => {
  const SELF = 0x10n;
  const player = unit(SELF, 4, {});
  assert.equal(maxHealthModifierOf(player, SELF), 1, "the realm never writes the field: 0 + 1");
  const pet = unit(0xf14n, 3, { UNIT_FIELD_PETNUMBER: 3, UNIT_FIELD_MAXHEALTHMODIFIER: floatWord(0.2) });
  assert.equal(maxHealthModifierOf(pet, SELF), Math.fround(1.2));
  assert.equal(maxHealthModifierOf(unit(0xf13n, 3, {}), SELF), 0, "a creature");
  assert.equal(maxHealthModifierOf(undefined, SELF), 0);
});

test("GetSpellCritChanceFromIntellect: (ratio · INT + base) · 100, zero ratio 0, negative INT as 0, player and pet", () => {
  const SELF = 0x10n;
  const stats = catalog();
  const mage = unit(SELF, 4, { UNIT_FIELD_BYTES_0: 1 | (8 << 8), UNIT_FIELD_LEVEL: 80 });
  mage.fields.set(F("UNIT_FIELD_STAT0") + 3, 500);
  assert.equal(spellCritFromIntellectOf(mage, SELF, stats), (0.00006 * 500 + 0.0091) * 100);
  mage.fields.set(F("UNIT_FIELD_STAT0") + 3, 0xffffffff);
  assert.equal(spellCritFromIntellectOf(mage, SELF, stats), 0.0091 * 100, "a negative intellect reads 0");
  const warrior = unit(SELF, 4, { UNIT_FIELD_BYTES_0: 1 | (1 << 8), UNIT_FIELD_LEVEL: 80 });
  warrior.fields.set(F("UNIT_FIELD_STAT0") + 3, 500);
  assert.equal(spellCritFromIntellectOf(warrior, SELF, { ...stats, spellCritBase: [0.05] }), 0, "a zero ratio: 0, not the base");
  const imp = unit(0xf14n, 3, { UNIT_FIELD_PETNUMBER: 2, UNIT_FIELD_BYTES_0: 1 | (8 << 8), UNIT_FIELD_LEVEL: 70 });
  imp.fields.set(F("UNIT_FIELD_STAT0") + 3, 100);
  assert.equal(spellCritFromIntellectOf(imp, SELF, stats), (0.0001 * 100 + 0.0091) * 100, "the pet paper doll's «pet»");
  assert.equal(spellCritFromIntellectOf(unit(0xf13n, 3, { UNIT_FIELD_BYTES_0: 8 << 8, UNIT_FIELD_LEVEL: 80 }), SELF, stats), 0, "a creature");
  assert.equal(spellCritFromIntellectOf(mage, SELF, undefined), 0, "no table yet");
});

test("the live seam answers both through the stock bindings", () => {
  const SELF = 0x10n;
  const player = unit(SELF, 4, { UNIT_FIELD_BYTES_0: 1 | (8 << 8), UNIT_FIELD_LEVEL: 80 });
  player.fields.set(F("UNIT_FIELD_STAT0") + 3, 500);
  const imp = unit(0xf140000001000002n, 3, { UNIT_FIELD_PETNUMBER: 2, UNIT_FIELD_BYTES_0: 1 | (8 << 8), UNIT_FIELD_LEVEL: 70 });
  imp.fields.set(F("UNIT_FIELD_STAT0") + 3, 100);
  const world = { targetGuid: 0xf13n, petSpells: { guid: imp.guid }, state: { selfGuid: SELF, objects: new Map([[SELF, player], [imp.guid, imp], [0xf13n, unit(0xf13n, 3, {})]]) } };
  const seam = new LiveWorldSeam({ world: () => world, spell: () => undefined, characterStats: () => catalog() });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  assert.deepEqual(call("GetUnitMaxHealthModifier", "player"), [1]);
  assert.deepEqual(call("GetUnitMaxHealthModifier", "target"), [0]);
  assert.deepEqual(call("GetSpellCritChanceFromIntellect", "player"), [(0.00006 * 500 + 0.0091) * 100]);
  assert.deepEqual(call("GetSpellCritChanceFromIntellect", "target"), [0]);
  assert.deepEqual(call("GetSpellCritChanceFromIntellect", "pet"), [(0.0001 * 100 + 0.0091) * 100], "PetPaperDollFrame.lua:599");
  assert.deepEqual(call("GetUnitMaxHealthModifier", "pet"), [1]);
});
