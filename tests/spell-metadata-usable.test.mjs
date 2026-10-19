import assert from "node:assert/strict";
import test from "node:test";

// 19.10: the `/dbc/spells?v=20` rows (19.10) add what IsUsableAction's per-slot check reads (src/browser/framexml/FrameXmlActionUsable.ts,
// Wow.exe 0x0080b5d0 / 0x0072bac0): ShapeshiftMask/ShapeshiftExclude (Spell 12-15), the aura states (20-23) and aura
// spells (24-27), AuraInterruptFlags (32), Mechanic (3), EffectMechanic (83-85), EffectSpellClassMaskA/B/C (122-130),
// and a MOD_SHAPESHIFT effect's SpellShapeshiftForm.dbc Flags (column 19). Values are this dataset's own rows.

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const { parseSpellShapeshiftFormFlags } = await import("../dist/code/gateway/SpellShapeshiftForms.js");

test("parseSpellShapeshiftFormFlags reads column 19 of the 35-word record", () => {
  const fields = 35;
  const rows = [[17, 0], [30, 0], [1, 0]];
  const flags = [7, 1, 760];
  const out = Buffer.alloc(20 + rows.length * fields * 4 + 1);
  out.write("WDBC", 0, "latin1");
  out.writeUInt32LE(rows.length, 4);
  out.writeUInt32LE(fields, 8);
  out.writeUInt32LE(fields * 4, 12);
  out.writeUInt32LE(1, 16);
  rows.forEach(([id], row) => {
    out.writeUInt32LE(id, 20 + row * fields * 4);
    out.writeUInt32LE(flags[row], 20 + row * fields * 4 + 19 * 4);
  });
  assert.deepEqual([...parseSpellShapeshiftFormFlags(out)], [[17, 7], [30, 1], [1, 760]]);
});

test("served usability columns on the dataset's rogue, warrior and druid rows", withDataset, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await loadSpellMetadata(dbcDirectory);
  const ambush = spells.get(8676);
  assert.deepEqual(ambush?.shapeshiftMask, [0x20000000, 0], "Внезапный удар: form 30 (stealth)");
  assert.deepEqual(ambush?.shapeshiftExclude, [0, 0]);
  assert.equal(spells.get(7384)?.shapeshiftMask?.[0], 0x10000, "Превосходство: form 17 (Battle Stance)");
  assert.equal(spells.get(1784)?.shapeshiftFormFlags, 1, "Незаметность: a stance-type form");
  assert.equal(spells.get(1784)?.auraInterruptFlags, 146436);
  assert.equal(spells.get(2457)?.shapeshiftFormFlags, 7, "Боевая стойка");
  assert.equal(spells.get(768)?.shapeshiftFormFlags, 760, "Облик кошки: a shapeshift (no 0x1)");
  assert.deepEqual(spells.get(768)?.shapeshiftExclude, [0x40000002, 0]);
  for (const id of [8676, 1784, 768]) {
    const masks = spells.get(id)?.effectSpellClassMask;
    assert.ok(Array.isArray(masks) && masks.length === 3 && masks.every((words) => words.length === 3), `spell ${id}`);
    assert.equal(spells.get(id)?.effectMechanic?.length, 3);
    for (const key of ["casterAuraState", "targetAuraState", "excludeCasterAuraState", "excludeTargetAuraState",
      "casterAuraSpell", "targetAuraSpell", "excludeCasterAuraSpell", "excludeTargetAuraSpell", "mechanic"]) {
      assert.ok(Number.isInteger(spells.get(id)?.[key]), `spell ${id} ${key}`);
    }
  }
  // An aura-state row: Execute (5308) asks the target's HEALTHLESS_20_PERCENT state.
  assert.equal(spells.get(5308)?.targetAuraState, 2, "Казнь");
});
