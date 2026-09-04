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
  assert.deepEqual(resolvers.spellTabs(), [[
    "Общий", "Interface\\Icons\\Spell_Fire_FlameBolt", 0, 1, 0, 1,
  ]]);
  assert.equal(resolvers.spellTabFor(133), 1);
});
