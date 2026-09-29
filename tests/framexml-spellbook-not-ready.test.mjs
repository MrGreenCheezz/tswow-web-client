import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");

test("an authoritative empty tab provider does not fabricate a fallback spellbook tab", () => {
  const world = {
    knownSpells: [{ id: 133, slot: 0 }],
    cooldownSnapshots: new Map(),
    actionButtons: [],
    casts: new Map(),
    state: { selfGuid: 1n, objects: new Map() },
    events: { on() { return () => {}; } },
  };
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => undefined,
    spell: () => ({ id: 133, name: "Огненный шар", rank: "", iconPath: "", hidden: false }),
    monotonic: () => 0,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    spellTabs: () => [],
    spellTabFor: () => undefined,
  });
  assert.equal(seam.spellTabCount(), 0);
  assert.equal(seam.spellTabInfo(1), undefined);
  assert.equal(seam.spellName(1, "spell"), undefined);
});
