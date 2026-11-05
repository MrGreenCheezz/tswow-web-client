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

test("a row cached before the attributes reached the client is not held back by them", () => {
  assert.equal(auraListed({ flags: own }, { effectAura: [4, 0, 0] }, SELF, PET), true);
});
