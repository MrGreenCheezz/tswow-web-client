// 11.11 (v=21): `/dbc/spells` serves `effectSpellClassMask` effect-major, as the Spell.dbc record lies (+0x1e8,
// +0x1f4, +0x200; Wow.exe 0x007fde80 reads one 96-bit mask per effect). WoWDBDefs names the nine words
// EffectSpellClassMaskA/B/C[3]: column A is effect 0's three words. The rows used to come out transposed, so a
// modifier aura matched the wrong spells. Pinned on this dataset's own rows.
import assert from "node:assert/strict";
import test from "node:test";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("effectSpellClassMask[e] is effect e's three words", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const rows = await loadSpellMetadata(dbcDirectory);
  const affects = (aura, effect, spell) => aura.spellClassSet === spell.spellClassSet
    && aura.effectSpellClassMask[effect].some((word, index) => (word & (spell.spellClassMask[index] ?? 0)) !== 0);

  const improved = rows.get(11069); // «Улучшенный огненный шар» rank 1: effect 0, ADD_FLAT_MODIFIER on Fireball
  const fireball = rows.get(133);
  const frostbolt = rows.get(116);
  assert.ok(improved && fireball && frostbolt, "the stock rows are in the dataset");
  assert.equal(improved.effectAura[0], 107, "SPELL_AURA_ADD_FLAT_MODIFIER");
  assert.equal(affects(improved, 0, fireball), true, "Improved Fireball's effect 0 names Fireball");
  assert.equal(affects(improved, 0, frostbolt), false, "and not Frostbolt");

  // A mask with a bit outside word 0: «Прокол» (12308) lowers the rage cost of «Раскол брони» (7386, warrior
  // family word 0 bit 0x4000) and of «Сокрушение» (20243, word 1 bit 0x40) with its one effect, so both words
  // belong to effect 0. Transposed, word 1 landed in effect 1 and Devastate was not named at all.
  const puncture = rows.get(12308);
  const sunder = rows.get(7386);
  const devastate = rows.get(20243);
  assert.ok(puncture && sunder && devastate);
  assert.deepEqual(puncture.effectSpellClassMask, [[0x4000, 0x40, 0], [0, 0, 0], [0, 0, 0]]);
  assert.equal(affects(puncture, 0, sunder), true, "Puncture → Sunder Armor (word 0)");
  assert.equal(affects(puncture, 0, devastate), true, "Puncture → Devastate (word 1 of the same effect)");
  assert.equal(affects(puncture, 1, devastate), false, "its second effect names nothing");
});
