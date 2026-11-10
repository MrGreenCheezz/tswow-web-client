import assert from "node:assert/strict";
import test from "node:test";

// 3.43 (11.11): GameTooltip:SetUnitAura's description takes the aura slot's caster level and count, as Wow.exe
// 0x00625f00 → 0x00625350 → 0x0057abc0 passes them (slot bytes +0xd/+0xe, 0x0061f890/0x0061f8d0): the count is
// the multiplier only for a CumulativeAura of 2 or more, and the level is not capped at MaxLevel on that path.
// Rows: Spell.dbc 58567 «Раскол брони» (debuff) and 17 «Слово силы: Щит» rank 1.

const { game } = await import("../dist/code/browser/game/Context.js");
const { clearSpellNames } = await import("../dist/code/browser/ui/SpellNames.js");
const { createFrameXmlCharacterTooltipAdapter, resetFrameXmlTooltipRedraws } = await import(
  "../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const row = (fields) => ({
  rank: "", description: "", powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
  castTime: 0, passive: false, rangeMin: 0, rangeMax: 0, rangeFlags: 0, effectChainTargets: [0, 0, 0],
  effectRadius: [0, 0, 0], effectPeriod: [0, 0, 0], procChance: 100, effectAura: [0, 0, 0], effects: [6, 0, 0],
  attributes: [0, 0, 0, 0, 0, 0, 0, 0], ...fields,
});

const SUNDER = row({
  id: 58567, name: "Раскол брони", auraDescription: "Броня ослаблена на $s1%.", effectAura: [101, 0, 0],
  effectBasePoints: [-5, 0, 0], effectDieSides: [1, 0, 0], effectRealPointsPerLevel: [0, 0, 0], baseLevel: 10, maxLevel: 0,
  duration: 30000, maxDuration: 30000, stackAmount: 5,
});
const SHIELD = row({
  id: 17, name: "Слово силы: Щит", auraDescription: "Поглощает $s1 ед. урона.", effectAura: [69, 0, 0],
  effectBasePoints: [43, 0, 0], effectDieSides: [1, 0, 0], effectRealPointsPerLevel: [Math.fround(0.8), 0, 0],
  baseLevel: 6, maxLevel: 11, duration: 30000, maxDuration: 30000, stackAmount: 0,
});

async function description(seam, id, slot) {
  const adapter = createFrameXmlCharacterTooltipAdapter(seam);
  adapter.aura(id, slot);
  await settle(); // the spellbook module lands
  const content = adapter.aura(id, slot);
  return content?.lines?.find((line) => typeof line !== "string" && line.tone === "description")?.text;
}

test("3.43 SetUnitAura: the slot's count multiplies a stacking aura, its caster level grows the numbers uncapped", async () => {
  clearSpellNames();
  game.spells.clear();
  game.spells.set(SUNDER.id, SUNDER);
  game.spells.set(SHIELD.id, SHIELD);
  game.world = { state: { selfGuid: undefined, objects: new Map() } };
  game.spellMetadataClient = { load: async () => new Map(), answered: () => true };
  try {
    const slot = { unit: "target", index: 1, filter: "HARMFUL", count: 3 };
    const asked = [];
    const seam = (casterLevel, applications) => ({
      unitAuraSlot: (unit, index, filter) => { asked.push([unit, index, filter]); return { casterLevel, applications }; },
    });
    assert.equal(await description(seam(80, 3), SUNDER.id, slot), "Броня ослаблена на 12%.");
    assert.deepEqual(asked[0], ["target", 1, "HARMFUL"], "the slot UnitAura read");
    // Without the seam's slot (the canned seams): UnitAura's count, level 0.
    assert.equal(await description({}, SUNDER.id, slot), "Броня ослаблена на 12%.");
    assert.equal(await description({}, SUNDER.id, undefined), "Броня ослаблена на 4%.", "no slot: one stack");
    // CumulativeAura 0: the count does not multiply; the slot's level 80 is used as it is (0x007ff770).
    assert.equal(await description(seam(80, 3), SHIELD.id, slot), "Поглощает 103 ед. урона.");
    assert.equal(await description(seam(0, 1), SHIELD.id, slot), "Поглощает 44 ед. урона.", "level 0, no player: no growth");
  } finally {
    resetFrameXmlTooltipRedraws();
    game.world = undefined;
    game.spellMetadataClient = undefined;
    game.spells.clear();
    clearSpellNames();
  }
});
