import assert from "node:assert/strict";
import test from "node:test";

// 3.57 (11.11): the four gates of Spell_C_IsUsableAction / Spell_C_HaveSpellPower that were open until now
// (FrameXmlActionUsableGates.ts): a DK's runes (0x005ee5b0), flying-only spells (0x007261b0), the restricted
// player's 0x007fcc70 and the charm escape (0x004f5f00 + 0x008046c0). Each case flips one fact.
const { frameXmlSpellUsable } = await import("../dist/code/browser/framexml/FrameXmlActionUsable.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { parseSpellRuneCosts } = await import("../dist/code/gateway/SpellMetadata.js");

test("gateway: SpellRuneCost.dbc rows as [blood, unholy, frost]", () => {
  const rows = [[2, 1, 0, 0, 100], [21, 5, 4, 3, 0]];
  const bytes = Buffer.alloc(20 + rows.length * 20 + 1);
  bytes.write("WDBC", 0, "latin1");
  bytes.writeUInt32LE(rows.length, 4); bytes.writeUInt32LE(5, 8); bytes.writeUInt32LE(20, 12); bytes.writeUInt32LE(1, 16);
  rows.forEach((row, index) => row.forEach((value, column) => bytes.writeInt32LE(value, 20 + index * 20 + column * 4)));
  const costs = parseSpellRuneCosts(new Uint8Array(bytes));
  assert.deepEqual([...costs], [[2, [1, 0, 0]], [21, [5, 4, 3]]]);
  assert.equal(parseSpellRuneCosts(new Uint8Array(8)).size, 0, "not a table: none");
});

const PLAYER = 0x10n;
const offset = (name) => UPDATE_FIELDS[name].offset;

function unit(extra = []) {
  const fields = new Map([[offset("UNIT_FIELD_HEALTH"), 100], ...extra]);
  return { guid: PLAYER, typeId: 4, movementFlags: 0, fields };
}

function spell(overrides = {}) {
  return {
    id: 1, name: "Проба", passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0, schoolMask: 1,
    spellClassSet: 15, spellClassMask: [0x10, 0, 0], effects: [0, 0, 0], effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0],
    attributes: [0, 0, 0, 0, 0, 0, 0, 0], recoveryTime: 0, categoryRecoveryTime: 0, ...overrides,
  };
}

function host({ runes, modifiers = [], flight, control = true, auras = [], spells = new Map() } = {}) {
  return {
    range: {
      object: () => undefined, reaction: () => undefined, creatureType: () => 0, creatureTypeFlags: () => 0,
      selfGuid: PLAYER, inParty: () => false, inRaid: () => false, rangedModRange: () => undefined,
      playerSpellFamily: () => 15, spellModifiers: () => modifiers,
    },
    spell: (id) => spells.get(id),
    auras: () => auras,
    itemCount: () => 0,
    hasTotemCategory: () => true,
    equipped: () => undefined,
    comboPoints: () => 0,
    hasControl: () => control,
    onHold: () => false,
    instanceType: () => undefined,
    outdoors: () => undefined,
    cvar: (name) => name !== "autoDismountFlying",
    runes: runes === undefined ? undefined : () => runes,
    flight,
  };
}

const rune = (type, ready) => ({ type, ready });
// Blood 0-1, unholy 2-3, frost 4-5 by slot; `ready` per slot.
const sixRunes = (ready, types = [0, 0, 1, 1, 2, 2]) => types.map((type, index) => rune(type, ready[index]));

test("runes: a spell is short of power (blue) when its ready runes and death runes cannot pay it", () => {
  const strike = spell({ powerType: 5, runeCost: [1, 0, 1] });
  const self = unit();
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined, host({ runes: sixRunes([true, false, false, false, true, false]) })),
    [true, false], "one blood and one frost ready");
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined, host({ runes: sixRunes([false, false, true, true, true, true]) })),
    [false, true], "no blood rune ready: notEnoughMana");
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined,
    host({ runes: sixRunes([true, true, false, false, false, false], [3, 0, 1, 1, 2, 2]) })),
  [true, false], "a ready death rune stands in for the frost one");
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined,
    host({ runes: sixRunes([true, false, false, false, false, false], [3, 0, 1, 1, 2, 2]) })),
  [false, true], "the only ready rune is death: it pays one of two");
});

test("runes: the cost percentage — free at 0 %, the counts raised only above 100 %", () => {
  const self = unit();
  const none = sixRunes([false, false, false, false, false, false]);
  const strike = spell({ powerType: 5, runeCost: [1, 0, 0] });
  // SPELLMOD_COST −100 % on the spell's family bit 4: (100 + 0) × 0 / 100 = 0, the spell is free.
  const free = [{ effectIndex: 4, op: 14, value: -100, pct: true }];
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined, host({ runes: none, modifiers: free })), [true, false]);
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined, host({ runes: none })), [false, true]);
  // +100 %: one blood becomes two; one ready blood is not enough, a second (death) is.
  const doubled = [{ effectIndex: 4, op: 14, value: 100, pct: true }];
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined,
    host({ runes: sixRunes([true, false, false, false, false, false]), modifiers: doubled })), [false, true]);
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined,
    host({ runes: sixRunes([true, false, false, false, false, false], [0, 3, 1, 1, 2, 2]).map((r, i) => (i === 1 ? rune(3, true) : r)),
      modifiers: doubled })), [true, false]);
  // −50 % does not lower the counts (0x005ee5b0 scales only above 100).
  const half = [{ effectIndex: 4, op: 14, value: -50, pct: true }];
  assert.deepEqual(frameXmlSpellUsable(self, strike, undefined, host({ runes: none, modifiers: half })), [false, true]);
  // UNIT_FIELD_POWER_COST_MODIFIER −100 for the physical school: (100 − 100) × 1.0 = 0, free.
  const cheap = unit([[offset("UNIT_FIELD_POWER_COST_MODIFIER"), -100 >>> 0]]);
  assert.deepEqual(frameXmlSpellUsable(cheap, strike, undefined, host({ runes: none })), [true, false]);
});

test("runes: unknown stays open, and a unit other than the active player is short", () => {
  const strike = spell({ powerType: 5, runeCost: [1, 0, 0] });
  const none = sixRunes([false, false, false, false, false, false]);
  assert.deepEqual(frameXmlSpellUsable(unit(), spell({ powerType: 5 }), undefined, host({ runes: none })), [true, false],
    "no SpellRuneCost row (or an older gateway): free");
  assert.deepEqual(frameXmlSpellUsable(unit(), strike, undefined, host({})), [true, false], "runes not reported: open");
  const other = { ...unit(), guid: 0x20n };
  assert.deepEqual(frameXmlSpellUsable(other, strike, undefined, host({ runes: none })), [false, true]);
});

test("flying-only spells: AreaTable 0x400 without 0x20000000, and Cold Weather Flying in Northrend", () => {
  const mount = spell({ attributes: [0, 0, 0, 0, 0x4000000, 0, 0, 0] });
  const flight = (flags, map = 530, known = []) => ({
    areaFlags: () => flags, mapId: () => map, knowsSpell: (id) => known.includes(id),
  });
  const self = unit();
  assert.deepEqual(frameXmlSpellUsable(self, mount, undefined, host({ flight: flight(0x400) })), [true, false]);
  assert.deepEqual(frameXmlSpellUsable(self, mount, undefined, host({ flight: flight(0x40) })), [false, false]);
  assert.deepEqual(frameXmlSpellUsable(self, mount, undefined, host({ flight: flight(0x400 | 0x20000000) })), [false, false]);
  assert.deepEqual(frameXmlSpellUsable(self, mount, undefined, host({ flight: flight(0x400, 571) })), [false, false]);
  assert.deepEqual(frameXmlSpellUsable(self, mount, undefined, host({ flight: flight(0x400, 571, [54197]) })), [true, false]);
  assert.deepEqual(frameXmlSpellUsable(self, mount, undefined, host({ flight: flight(undefined) })), [true, false],
    "area flags not known yet: open");
  assert.deepEqual(frameXmlSpellUsable(self, spell(), undefined, host({ flight: flight(0) })), [true, false],
    "a spell without the bit ignores the area");
});

test("the restricted player (PLAYER_FLAGS 0x1000000): 0x007fcc70's spells are grey besides attacks", () => {
  const restricted = unit([[offset("PLAYER_FLAGS"), 0x1000000]]);
  const plain = spell();
  assert.deepEqual(frameXmlSpellUsable(restricted, plain, undefined, host()), [true, false]);
  for (const attributes of [[0x400, 0, 0], [0x4, 0, 0], [0, 0x200, 0], [0, 0, 0x100000]]) {
    const marked = spell({ attributes: [...attributes, 0, 0, 0, 0, 0] });
    assert.deepEqual(frameXmlSpellUsable(restricted, marked, undefined, host()), [false, false], attributes.join(","));
    assert.deepEqual(frameXmlSpellUsable(unit(), marked, undefined, host()), [true, false], "unrestricted");
  }
});

test("charm: without control, a charmed player may use a spell that lifts the charm", () => {
  // The charm aura: MOD_CHARM (6) with mechanic 1; the escape: APPLY_AURA MECHANIC_IMMUNITY (77) misc 1 and
  // AttributesEx 0x8000 (SpellCancelsAura 0x007fdfa0).
  const charm = spell({ id: 900, effectAura: [6, 0, 0], mechanic: 1 });
  const escape = spell({ id: 901, effects: [6, 0, 0], effectAura: [77, 0, 0], effectMiscValue: [1, 0, 0],
    attributes: [0, 0x8000, 0, 0, 0, 0, 0, 0] });
  const spells = new Map([[900, charm]]);
  const auras = [{ spellId: 900, flags: 1 }];
  const charmed = unit([[offset("UNIT_FIELD_CHARMEDBY"), 0x99]]);
  assert.deepEqual(frameXmlSpellUsable(charmed, escape, undefined, host({ control: false, auras, spells })), [true, false]);
  assert.deepEqual(frameXmlSpellUsable(charmed, spell(), undefined, host({ control: false, auras, spells })), [false, false]);
  assert.deepEqual(frameXmlSpellUsable(unit(), escape, undefined, host({ control: false, auras, spells })), [false, false],
    "not charmed: no escape");
});
