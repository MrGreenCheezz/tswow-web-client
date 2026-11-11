// 3.68 (11.11): the order of a unit's aura list (Wow.exe 0x0072C510 → 0x00727C00; .runtime/re-2026-11-11/usable/u1.c,
// .runtime/re-2026-11-11/fxapi/d1.c, d3.c): own auras first, then the second class (0x0053D750), the rest at the end;
// each class in arrival order, auras arriving together by falling slot.
import assert from "node:assert/strict";
import test from "node:test";

import { AuraOrder } from "../dist/code/world/AuraOrder.js";

const UNIT = 0x20n;
const SELF = 0x10n;
const PET = 0x30n;
const OTHER = 0x40n;
const TOTEM = 0x50n;
const aura = (slot, spellId, casterGuid, flags = 0x11) => ({ slot, spellId, flags, casterLevel: 80, applications: 0, casterGuid });
const BOOK = new Map([[1243, [6, 0, 0]], [20217, [35, 0, 0]], [7000, [2, 0, 0]]]);
const rules = {
  listed: (entry) => (entry.flags & 7) !== 0,
  own: (caster) => caster === SELF || caster === PET,
  bookSpell: (spellId) => BOOK.get(spellId),
  summonedCaster: (caster) => caster === TOTEM,
};
const ids = (list) => list.map((entry) => entry.spellId);

test("own auras first, then the second class, then the rest; together by falling slot", () => {
  const order = new AuraOrder();
  const auras = [
    aura(0, 100, OTHER), // another's, not in the book: last
    aura(1, 1243, OTHER), // another's Fortitude, the player knows it (APPLY_AURA): second class
    aura(2, 200, SELF), // own
    aura(3, 300, PET), // own: the pet is the player's
    aura(4, 7000, OTHER), // in the book but no aura effect: last
    aura(5, 400, TOTEM), // a totem the book summons: second class
  ];
  assert.deepEqual(ids(order.order(UNIT, auras, rules)), [300, 200, 400, 1243, 7000, 100]);
});

test("an aura that arrives later goes after its class, not by its slot", () => {
  const order = new AuraOrder();
  let auras = [aura(5, 200, SELF), aura(6, 100, OTHER)];
  assert.deepEqual(ids(order.order(UNIT, auras, rules)), [200, 100]);
  auras = [aura(0, 201, SELF), ...auras, aura(1, 101, OTHER), aura(2, 20217, OTHER)];
  assert.deepEqual(ids(order.order(UNIT, auras, rules)), [200, 201, 20217, 100, 101]);
});

test("a gone aura leaves its place; one back in its slot is a new arrival", () => {
  const order = new AuraOrder();
  order.order(UNIT, [aura(0, 200, SELF), aura(1, 201, SELF)], rules);
  assert.deepEqual(ids(order.order(UNIT, [aura(1, 201, SELF)], rules)), [201]);
  assert.deepEqual(ids(order.order(UNIT, [aura(0, 200, SELF), aura(1, 201, SELF)], rules)), [201, 200]);
  assert.deepEqual(ids(order.order(UNIT, [aura(0, 999, SELF), aura(1, 201, SELF)], rules)), [201, 999], "another spell in the slot");
  assert.deepEqual(ids(order.order(UNIT, [aura(0, 999, SELF, 0x10), aura(1, 201, SELF)], rules)), [201],
    "no effect bit: out of the list");
});

test("the caster bit names the unit itself as the caster", () => {
  const order = new AuraOrder();
  const self = [aura(0, 100, OTHER), aura(1, 200, undefined, 0x19)];
  assert.deepEqual(ids(order.order(SELF, self, rules)), [200, 100], "on the player: its own");
  const other = [aura(0, 200, undefined, 0x19), aura(1, 100, OTHER)];
  assert.deepEqual(ids(new AuraOrder().order(UNIT, other, rules)), [100, 200], "on another unit: not the player's, by falling slot");
});
