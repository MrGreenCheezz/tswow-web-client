import assert from "node:assert/strict";
import test from "node:test";

const { createFrameXmlSpellBookTabResolvers } = await import(
  "../dist/code/browser/framexml/FrameXmlSpellBookTabs.js",
);

test("spellbook tabs reappear when metadata arrives after an authoritative empty snapshot", () => {
  const spells = new Map();
  const world = { knownSpells: [{ id: 133, slot: 0 }] };
  const talent = {
    ready: true,
    skillOfSpell: (id) => id === 133 ? 183 : undefined,
    skillLine: () => undefined,
  };
  const resolvers = createFrameXmlSpellBookTabResolvers(() => ({ world, talent, spells }));

  assert.deepEqual(resolvers.spellTabs(), [], "missing metadata must not fabricate a tab");
  assert.equal(resolvers.spellTabFor(133), undefined);

  spells.set(133, {
    id: 133,
    name: "Огненный шар",
    rank: "Уровень 1",
    iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt",
    hidden: false,
  });
  // The General tab is the client's own: `GENERAL_SPELLS` for its name and the book picture,
  // whatever the first spell in it looks like (SpellBookFrame draws `GetSpellTabInfo`'s texture).
  assert.deepEqual(resolvers.spellTabs(), [[
    "Общие", "Interface\\Icons\\INV_Misc_Book_09", 0, 1, 0, 1,
  ]]);
  assert.equal(resolvers.spellTabFor(133), 1);
});

test("a learned recipe (SPELL_ATTR0_TRADESPELL) stays out of the book, as in the client", () => {
  // The owner's realm: a custom cooking-style recipe row, «QA Test +2000 Spell Power Ring»
  // (98379, attributes 0x10030), was drawn in the General tab above the character's spells.
  // Conjure Water creates an item too and is not a trade spell: it keeps its place.
  const spells = new Map([
    [98379, { id: 98379, name: "QA Test +2000 Spell Power Ring", rank: "", iconPath: "Interface\\Icons\\INV_Jewelry_Ring_01", hidden: false, tradeSkill: true, effects: [24, 0, 0] }],
    [5504, { id: 5504, name: "Наколдовать воду", rank: "Уровень 1", iconPath: "Interface\\Icons\\INV_Drink_06", hidden: false, tradeSkill: false, effects: [24, 0, 0] }],
    [133, { id: 133, name: "Огненный шар", rank: "Уровень 1", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", hidden: false }],
  ]);
  const world = { knownSpells: [{ id: 98379, slot: 0 }, { id: 5504, slot: 1 }, { id: 133, slot: 2 }] };
  const talent = {
    ready: true,
    skillOfSpell: () => 183,
    skillLine: () => undefined,
  };
  const resolvers = createFrameXmlSpellBookTabResolvers(() => ({ world, talent, spells }));
  assert.deepEqual(resolvers.spellTabs(), [[
    "Общие", "Interface\\Icons\\INV_Misc_Book_09", 0, 2, 0, 2,
  ]], "the recipe is neither counted nor offset; the two real spells remain");
  assert.equal(resolvers.spellTabFor(98379), undefined, "no tab holds the recipe");
  assert.equal(resolvers.spellTabFor(5504), 1, "an item-creating class spell is still in its tab");
  assert.equal(resolvers.spellIsLowerRank(98379), false);
});
