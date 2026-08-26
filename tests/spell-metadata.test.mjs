import assert from "node:assert/strict";
import test from "node:test";
import { SpellMetadataClient, spellButtonUsable } from "../dist/code/browser/SpellMetadata.js";

test("a spell placeholder stays disabled until metadata arrives", () => {
  assert.equal(spellButtonUsable(undefined), false);
  assert.equal(spellButtonUsable({ passive: true }), false);
  assert.equal(spellButtonUsable({ passive: false }), true);
});

/** The v=7 shape, which is what the gateway serves after К1 and its review. */
const fireball = {
  id: 133, name: "Огненный шар", rank: "Уровень 1", description: "", iconId: 7, iconPath: "",
  passive: false, powerType: 0, powerCost: 0, powerCostPercent: 8, recoveryTime: 0,
  categoryRecoveryTime: 0, startRecoveryTime: 1500, cooldownStartedOnEvent: false,
  effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [13, 0, 0],
  effectDieSides: [9, 0, 0], effectPeriod: [0, 0, 0], duration: 0, procChance: 100,
  spellLevel: 1, spellClassSet: 3, spellClassMask: [1, 0, 0], schoolMask: 4,
  rangeMin: 0, rangeMax: 35, rangeFlags: 0, castTime: 1500,
};

async function loadOne(payload) {
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/auth");
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /&v=7$/, "the marker that keeps an hour-old v=6 response out");
    return { ok: true, json: async () => payload };
  };
  try {
    return await client.load([133]);
  } finally {
    globalThis.fetch = previous;
  }
}

test("К1 the guard refuses a record from before the rank key existed", async () => {
  assert.equal((await loadOne([fireball])).get(133).spellClassMask.length, 3);

  // The response cache is an hour long, so a browser can be handed the previous shape by its own
  // disk after the gateway has moved on. `rankChainKey` joins `spellClassMask`, and joining
  // `undefined` throws in the middle of a repaint rather than drawing a wrong book.
  const { spellClassMask, ...withoutMask } = fireball;
  await assert.rejects(loadOne([withoutMask]), /invalid data/);
  const { powerCostPercent, ...withoutPercent } = fireball;
  await assert.rejects(loadOne([withoutPercent]), /invalid data/);
  const { spellLevel, ...withoutLevel } = fireball;
  await assert.rejects(loadOne([withoutLevel]), /invalid data/);
});
