// The FrameXML tooltip adapter of a HUD with a world starts loading the spellbook module when it is
// built, so the first spell hovered is drawn in full rather than as its name while the module loads.
// A file of its own: the adapter's import of that module lands once per process, and this is about
// the adapter starting it before anything is hovered.

import assert from "node:assert/strict";
import test from "node:test";
import { installFakeUiDocument } from "./fixtures/fake-ui-document.mjs";

installFakeUiDocument();

const { game } = await import("../dist/code/browser/game/Context.js");
const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

test("a HUD with a world has the spellbook module before its first spell is hovered", async () => {
  game.world = { state: { selfGuid: undefined, objects: new Map() }, itemTemplate: () => undefined,
    events: { on: () => () => {} } };
  game.spells = new Map([[6673, {
    id: 6673, name: "Боевой крик", rank: "Уровень 1", description: "", iconId: 0, iconPath: "", passive: false,
    hidden: false, powerType: 1, powerCost: 100, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [],
    effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0], effectRadius: [0, 0, 0], spellLevel: 0,
    spellClassSet: 4, spellClassMask: [0, 0, 0], schoolMask: 1, rangeMin: 0, rangeMax: 0, rangeFlags: 0,
    castTime: 0, duration: 0, procChance: 0,
  }]]);
  try {
    const adapter = createFrameXmlCharacterTooltipAdapter({
      actionTooltip: (slot) => slot === 1 ? { kind: "spell", id: 6673, name: "Боевой крик", rank: "Уровень 1" } : undefined,
    });
    // The same module instance the adapter asked for; once it has evaluated, the adapter's own
    // import has resolved as well (its reaction was queued first).
    await import("../dist/code/browser/ui/Spellbook.js");
    await settle();
    const first = adapter.action(1);
    assert.equal(first.titleRight, "Уровень 1");
    assert.deepEqual(first.lines, [{ text: "Ярость: 10" }, { text: "Мгновенное действие" }],
      "the first hover is the full stock tooltip, not the name alone");
  } finally {
    game.world = undefined;
    game.spells = new Map();
  }
});
