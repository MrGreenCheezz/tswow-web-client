import assert from "node:assert/strict";
import test from "node:test";

// L15 5.05: the browser hands the world client the autoRangedCombat controller's spell — the book's
// SPELL_ATTR4 0x01000000 spell (Wow.exe 0x00542030 → 0x00be5d84: Auto Shot 75 in the dataset, not the
// wand's Shoot 5019) — and its range (0x00802c30 → 0x007ff480, FrameXmlActionRange.ts).
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
  location: { protocol: "http:", hostname: "localhost" } };
globalThis.document ??= {
  createElement: () => ({ getContext: () => ({}), style: {}, addEventListener() {} }),
  addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  body: { append() {} }, head: { append() {} },
};
globalThis.localStorage ??= { getItem() { return null; }, setItem() {} };

const { game } = await import("../dist/code/browser/game/Context.js");
const { syncMountSpellIds } = await import("../dist/code/browser/MountSpells.js");
const { autoRangedLimits } = await import("../dist/code/browser/game/Targeting.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

function spellRow(id, { ex4 = 0, autoRepeat = false, rangeMin = 0, rangeMax = 0, rangeFlags = 0 } = {}) {
  return {
    id, autoRepeat, effectAura: [0, 0, 0], attributes: [0, 0, autoRepeat ? 0x20 : 0, 0, ex4, 0, 0, 0],
    rangeMin, rangeMax, rangeFlags, spellClassSet: 0, spellClassMask: [0, 0, 0],
  };
}

test("L15 5.05: the book's SPELL_ATTR4 0x01000000 spell and its range reach the world client", () => {
  const previous = game.spells;
  game.spells = new Map([
    [75, spellRow(75, { ex4: 0x0100_0000, autoRepeat: true, rangeMin: 0, rangeMax: 35, rangeFlags: 2 })],
    [5019, spellRow(5019, { autoRepeat: true, rangeMax: 30 })],
  ]);
  const handed = [];
  const world = {
    knownSpells: [{ id: 5019 }, { id: 75 }],
    setMountSpellIds() {},
    setAutoRepeatSpellIds() {},
    setAutoRangedCombatSpellIds(ids) { handed.push([...ids]); },
    autoRangedLimits: undefined,
  };
  try {
    syncMountSpellIds(world);
    assert.deepEqual(handed, [[75]], "Auto Shot only: Shoot has no such bit");
    assert.equal(world.autoRangedLimits, autoRangedLimits);
    // Auto Shot's SpellRange is ranged (flag 2): min max(5, reaches + 4/3) + RangeMin, max RangeMax + reaches.
    const unit = (guid, x, reach) => ({
      guid, typeId: guid === 1n ? 4 : 3, movementFlags: 0, position: { x, y: 0, z: 0, orientation: 0 },
      fields: new Map([[UPDATE_FIELDS.UNIT_FIELD_COMBATREACH.offset, new Uint32Array(new Float32Array([reach]).buffer)[0]]]),
    });
    const limits = autoRangedLimits(75, unit(1n, 0, 1.5), unit(2n, 20, 1.5));
    assert.equal(limits.min, 5);
    assert.equal(limits.max, 38);
    assert.equal(autoRangedLimits(12345, unit(1n, 0, 1.5), unit(2n, 20, 1.5)), undefined, "an unknown row");
  } finally {
    game.spells = previous;
  }
});
