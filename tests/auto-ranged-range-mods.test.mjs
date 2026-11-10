import assert from "node:assert/strict";
import test from "node:test";

// 5.05 (11.11): the autoRangedCombat controller's range (Targeting.ts `autoRangedLimits`, Wow.exe 0x00802c30 →
// 0x007ff480) counts the ranged weapon's RangedModRange (ATTR0 0x2 on a player) and the class family's
// SPELLMOD_RANGE (op 5, 0x007fd970: Hawk Eye's flat yards) — the reads IsActionInRange's host already makes.
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
  location: { protocol: "http:", hostname: "localhost" } };
globalThis.document ??= {
  createElement: () => ({ getContext: () => ({}), style: {}, addEventListener() {} }),
  addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  body: { append() {} }, head: { append() {} },
};
globalThis.localStorage ??= { getItem() { return null; }, setItem() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { autoRangedLimits } = await import("../dist/code/browser/game/Targeting.js");
const { learnCreationNames } = await import("../dist/code/browser/ui/UnitSnapshot.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const HUNTER = 3;
const HUNTER_FAMILY = 9;
const BOW_GUID = 0x4000_0000_0000_0042n;
const BOW_ENTRY = 2504;
const RANGED_SLOT = UPDATE_FIELDS.PLAYER_FIELD_INV_SLOT_HEAD.offset + 17 * 2;
const float = (value) => new Uint32Array(new Float32Array([value]).buffer)[0];

function unit(guid, x, extra = []) {
  return {
    guid, typeId: guid === 1n ? 4 : 3, movementFlags: 0, position: { x, y: 0, z: 0, orientation: 0 },
    fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset, float(1.5)], ...extra]),
  };
}

test("5.05 (11.11): Auto Shot's controller range takes RangedModRange and SPELLMOD_RANGE (Hawk Eye)", () => {
  const previous = { spells: game.spells, world: game.world };
  learnCreationNames([], [{ id: HUNTER, name: "Охотник", spellClassSet: HUNTER_FAMILY }]);
  // Auto Shot: ATTR0 0x2 (ranged), SpellRange flag 2, 35 yards; family 9, mask bit 0 (a stand-in bit Hawk Eye names).
  game.spells = new Map([[75, {
    id: 75, attributes: [0x2, 0, 0x20, 0, 0x0100_0000, 0, 0, 0], rangeMin: 0, rangeMax: 35, rangeFlags: 2,
    spellClassSet: HUNTER_FAMILY, spellClassMask: [0x1, 0, 0],
  }]]);
  const classBytes = HUNTER << 8; // UNIT_FIELD_BYTES_0 byte 1
  const self = unit(1n, 0, [
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, classBytes],
    [RANGED_SLOT, Number(BOW_GUID & 0xffff_ffffn)], [RANGED_SLOT + 1, Number(BOW_GUID >> 32n)],
  ]);
  const bow = { guid: BOW_GUID, typeId: 1, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, BOW_ENTRY]]) };
  const spellModifiers = new Map();
  game.world = {
    state: { selfGuid: 1n, objects: new Map([[1n, self], [BOW_GUID, bow]]) },
    itemTemplates: new Map([[BOW_ENTRY, { entry: BOW_ENTRY, rangedModRange: 100 }]]),
    spellModifiers,
  };
  try {
    const target = unit(2n, 20);
    assert.equal(autoRangedLimits(75, self, target).max, 38, "35 yards + both reaches, RangedModRange 100 %");
    game.world.itemTemplates.set(BOW_ENTRY, { entry: BOW_ENTRY, rangedModRange: 120 });
    assert.equal(autoRangedLimits(75, self, target).max, 120 * 0.01 * 35 + 3, "RangedModRange 120 % lengthens the shot");
    game.world.itemTemplates.set(BOW_ENTRY, { entry: BOW_ENTRY, rangedModRange: 100 });
    spellModifiers.set("0:5:flat", { effectIndex: 0, op: 5, value: 6, pct: false });
    assert.equal(autoRangedLimits(75, self, target).max, 44, "Hawk Eye's +6 yards (SPELLMOD_RANGE flat)");
  } finally {
    game.spells = previous.spells;
    game.world = previous.world;
  }
});
