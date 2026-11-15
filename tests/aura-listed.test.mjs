// 05.11 (3.68): which auras UnitAura lists. Every row was measured on Wow.exe with the spell named: the character got them by
// SMSG_AURA_UPDATE and Lua read them back (F:\WowOracle\tools\aura-list.mjs).
import assert from "node:assert/strict";
import test from "node:test";

import { auraListed } from "../dist/code/world/AuraListed.js";

const SELF = 1n;
const PET = 2n;
const OTHER = 5n;
const attr = (index, value) => { const row = [0, 0, 0, 0, 0, 0, 0, 0]; row[index] = value; return row; };
const spell = (attributes, effectAura = [4, 0, 0]) => ({ attributes, effectAura });
const own = 0x19; // effect 0, the caster bit, positive
const others = 0x11;

const MEASURED = [
  ["17, plain", { flags: own }, spell(attr(0, 0)), true],
  ["601, Attributes 0x80", { flags: own }, spell(attr(0, 0x80)), false],
  ["10, AttributesEx 0x10000000", { flags: own }, spell(attr(1, 0x10000000)), false],
  ["742, passive of aura 42", { flags: own }, spell(attr(0, 0x40), [42, 0, 0]), false],
  ["2895, passive of aura 65", { flags: own }, spell(attr(0, 0x40), [65, 0, 0]), true],
  ["15407, AttributesExE 0x08000000, own", { flags: own }, spell(attr(5, 0x08000000)), false],
  ["15407, AttributesExE 0x08000000, another's", { flags: others, casterGuid: OTHER }, spell(attr(5, 0x08000000)), true],
  ["12021, AttributesExE 0x10000000, own", { flags: own }, spell(attr(5, 0x10000000)), true],
  ["12021, AttributesExE 0x10000000, another's", { flags: others, casterGuid: OTHER }, spell(attr(5, 0x10000000)), false],
  ["13, no effect bit", { flags: 0x18 }, spell(attr(0, 0)), false],
  ["999999, not in Spell.dbc", { flags: own }, undefined, false],
  ["58371, AttributesExF 0x00100000, another's", { flags: others, casterGuid: OTHER }, spell(attr(6, 0x00100000)), false],
  ["62218, AttributesExF 0x00100000, own", { flags: own }, spell(attr(6, 0x00100000)), true],
  ["12, negative", { flags: 0x89 }, spell(attr(0, 0)), true],
  ["18, neither positive nor negative", { flags: 0x09 }, spell(attr(0, 0)), true],
];

for (const [name, aura, row, expected] of MEASURED) {
  test(`Wow.exe's answer: ${name}`, () => {
    assert.equal(auraListed(aura, row, SELF, PET), expected);
  });
}

test("a pet's aura for the caster: 0x0053D580 takes the player or the pet", () => {
  const row = spell(attr(6, 0x00100000));
  assert.equal(auraListed({ flags: others, casterGuid: PET }, row, SELF, PET), true);
  assert.equal(auraListed({ flags: others, casterGuid: SELF }, row, SELF, PET), true);
});

test("3.68 (11.11): a passive is shown by its Effect column (record +0x11C), an area aura's, not by its aura type", () => {
  const passive = attr(0, 0x40);
  assert.equal(auraListed({ flags: own }, { attributes: passive, effects: [6, 0, 0], effectAura: [65, 0, 0] }, SELF, PET), false,
    "APPLY_AURA with aura type 65: hidden");
  assert.equal(auraListed({ flags: own }, { attributes: passive, effects: [35, 0, 0], effectAura: [4, 0, 0] }, SELF, PET), true,
    "APPLY_AREA_AURA_PARTY: shown");
});

test("a row cached before the attributes reached the client is not held back by them", () => {
  assert.equal(auraListed({ flags: own }, { effectAura: [4, 0, 0] }, SELF, PET), true);
});

// 3.68 (15.11): RequiredAuraVision (Wow.exe 0x0053D580 → 0x004F72E0, .runtime/re-2026-11-15/spell7/s1.c). Rows from the base
// dataset's Spell.dbc: 26869 «Влюбленный» (vision 1, aura 23) and 44067 «Значок поставщика» (vision 2, Attributes 0x180 — so
// hidden anyway by 0x80), here with its 0x80 bit off to show the vision step alone.
test("RequiredAuraVision lists the aura only while bit (v − 1) of the player's aura-vision byte is set", () => {
  const lovesick = { attributes: attr(0, 0x100), effects: [6, 0, 0], effectAura: [23, 0, 0], requiredAuraVision: 1 };
  assert.equal(auraListed({ flags: own }, lovesick, SELF, PET, 0), false, "no vision bit");
  assert.equal(auraListed({ flags: own }, lovesick, SELF, PET, 0x01), true, "bit 0");
  assert.equal(auraListed({ flags: own }, lovesick, SELF, PET, 0x02), false, "another bit");
  assert.equal(auraListed({ flags: own }, lovesick, SELF, PET), false, "no active player");
  const badge = { attributes: attr(0, 0x100), effects: [6, 0, 0], effectAura: [4, 0, 0], requiredAuraVision: 2 };
  assert.equal(auraListed({ flags: others, casterGuid: OTHER }, badge, SELF, PET, 0x02), true);
  assert.equal(auraListed({ flags: others, casterGuid: OTHER }, badge, SELF, PET, 0x01), false);
  assert.equal(auraListed({ flags: own }, { ...badge, requiredAuraVision: 0 }, SELF, PET), true, "0: no requirement");
  assert.equal(auraListed({ flags: own }, { ...badge, requiredAuraVision: undefined }, SELF, PET), true, "an older gateway's row");
});
