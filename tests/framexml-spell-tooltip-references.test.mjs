import assert from "node:assert/strict";
import test from "node:test";

// 11.10: a stock spell tooltip asks for the rows its description's markers read. Only the
// spellbook's own load fetched them, so a talent's or a linked spell's `$/10;29131o1` stayed raw.

const { game } = await import("../dist/code/browser/game/Context.js");
const { clearSpellNames } = await import("../dist/code/browser/ui/SpellNames.js");
const { createFrameXmlCharacterTooltipAdapter, resetFrameXmlTooltipRedraws } = await import(
  "../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("11.10 the stock spell tooltip asks for the rows its description names", async () => {
  clearSpellNames();
  game.spells.clear();
  // 2687 «Кровавая ярость», its ruRU text as the dataset has it.
  game.spells.set(2687, {
    id: 2687, name: "Кровавая ярость", rank: "",
    description: "Воин накапливает $/10;2687s1 ед. ярости за счет здоровья, а затем дополнительно "
      + "$?s12296[${$29131m1*$29131d/10+$m2}][$/10;29131o1] ед. ярости за $29131d.",
  });
  const requested = [];
  game.world = { state: { selfGuid: undefined, objects: new Map() } };
  game.spellMetadataClient = { load: async (ids) => { requested.push([...ids]); return new Map(); } };
  try {
    const adapter = createFrameXmlCharacterTooltipAdapter({});
    adapter.spell(2687);
    await settle();
    assert.deepEqual(requested, [[29131]], "the referenced row, once; the spell's own row is already here");
  } finally {
    resetFrameXmlTooltipRedraws();
    game.world = undefined;
    game.spellMetadataClient = undefined;
    game.spells.clear();
    clearSpellNames();
  }
});
