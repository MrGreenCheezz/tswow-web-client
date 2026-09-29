import assert from "node:assert/strict";
import test from "node:test";

// ShowAllSpellRanks off (the browser's default, `spellbookHideLowerRanks`): the stock book reads
// GetSpellTabInfo's highest-rank offset/count and maps each shown row through
// GetKnownSlotFromHighestRankSlot (SpellBookFrame.lua:591-601, :656-663). Both used to repeat the
// unfolded numbers, so every lower rank stayed in the book and the checkbox changed nothing.
const { createFrameXmlSpellBookTabResolvers } = await import("../dist/code/browser/framexml/FrameXmlSpellBookTabs.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const call = (seam, name, ...args) => [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];

const row = (id, name, rank, spellLevel) => [id, {
  id, name, rank, spellLevel, spellClassSet: 3, spellClassMask: [1, 0, 0], passive: false, hidden: false,
  iconPath: `Interface\\Icons\\S${id}`,
}];

function book() {
  // Fireball ranks 1-3 and one Frost Armor, all on the mage's Fire/Frost line 8 → one class tab.
  const spells = new Map([
    row(133, "Огненный шар", "Уровень 1", 1), row(143, "Огненный шар", "Уровень 2", 6),
    row(145, "Огненный шар", "Уровень 3", 12), row(168, "Морозный доспех", "Уровень 1", 1),
  ]);
  const world = { knownSpells: [133, 143, 145, 168].map((id, slot) => ({ id, slot })) };
  const talent = {
    ready: true,
    skillOfSpell: () => 8,
    skillLine: (id) => id === 8 ? { id, name: "Огонь", categoryId: 7 } : undefined,
  };
  return { spells, world, talent, resolvers: createFrameXmlSpellBookTabResolvers(() => ({ world, talent, spells })) };
}

test("the tab tuple carries the rank-folded offset and count, from the native book's chains", () => {
  const { resolvers } = book();
  const [tab] = resolvers.spellTabs();
  assert.deepEqual(tab.slice(2), [0, 4, 0, 2], "four rows, two of them the top of their chain");
  assert.equal(resolvers.spellIsLowerRank(133), true);
  assert.equal(resolvers.spellIsLowerRank(143), true);
  assert.equal(resolvers.spellIsLowerRank(145), false);
  assert.equal(resolvers.spellIsLowerRank(168), false);
});

test("GetKnownSlotFromHighestRankSlot steps over lower ranks; the book's rows are the top ranks", () => {
  const { spells, world, resolvers } = book();
  const casts = [];
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: (id) => spells.get(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: (id) => casts.push(id),
    spellTabs: resolvers.spellTabs, spellTabFor: resolvers.spellTabFor, spellIsLowerRank: resolvers.spellIsLowerRank,
  });
  assert.deepEqual(call(seam, "GetKnownSlotFromHighestRankSlot", 1, "spell"), [3], "Fireball rank 3 is book slot 3");
  assert.deepEqual(call(seam, "GetKnownSlotFromHighestRankSlot", 2, "spell"), [4]);
  assert.deepEqual(call(seam, "GetKnownSlotFromHighestRankSlot", 3, "spell"), [], "past the folded book: nil");
  const [slot] = call(seam, "GetKnownSlotFromHighestRankSlot", 1, "spell");
  assert.deepEqual(call(seam, "GetSpellName", slot, "spell"), ["Огненный шар", "Уровень 3"]);
  call(seam, "CastSpell", slot, "spell");
  assert.deepEqual(casts, [145]);
  // A picked-up row names the slot the book really holds it at.
  call(seam, "PickupSpell", slot, "spell");
  assert.deepEqual(call(seam, "GetCursorInfo"), ["spell", 3, "spell"]);
});
