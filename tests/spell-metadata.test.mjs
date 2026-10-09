import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SpellMetadataClient,
  spellButtonUsable,
} from "../dist/code/browser/SpellMetadata.js";
import {
  SPELL_REQUIRED_TARGET_MASK,
  SPELL_REQUIRED_TARGET_MODE,
  spellRequiredTargeting,
} from "../dist/code/gateway/SpellMetadata.js";
import { parseSpellShapeshiftFormBonuses } from "../dist/code/gateway/SpellShapeshiftForms.js";

test("a spell placeholder stays disabled until metadata arrives", () => {
  assert.equal(spellButtonUsable(undefined), false);
  assert.equal(spellButtonUsable({ passive: true }), false);
  assert.equal(spellButtonUsable({ passive: false }), true);
});

/** v=11 retains auto-repeat/recipe metadata and adds bounded target-selection metadata. */
const fireball = {
  id: 133, name: "Огненный шар", rank: "Уровень 1", description: "", iconId: 7, iconPath: "",
  targetingContractVersion: 1, requiredTargetMask: 0, requiredTargetMode: 0,
  passive: false, powerType: 0, powerCost: 0, powerCostPercent: 8, recoveryTime: 0,
  categoryRecoveryTime: 0, startRecoveryTime: 1500, cooldownStartedOnEvent: false,
  effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [13, 0, 0],
  effectDieSides: [9, 0, 0], effectPeriod: [0, 0, 0], duration: 0, procChance: 100,
  spellLevel: 1, spellClassSet: 3, spellClassMask: [1, 0, 0], schoolMask: 4,
  rangeMin: 0, rangeMax: 35, rangeFlags: 0, castTime: 1500, autoRepeat: false,
  displayInStanceBar: false, stanceBarOrder: 0,
};

async function loadOne(payload) {
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/auth");
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /&v=17$/, // L13: v=17
      "the marker expires cached responses before the stock tooltip fields while retaining earlier fixes");
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
  const { autoRepeat, ...withoutAutoRepeat } = fireball;
  await assert.rejects(loadOne([withoutAutoRepeat]), /invalid data/);
  const { displayInStanceBar, ...withoutStances } = fireball;
  await assert.rejects(loadOne([withoutStances]), /invalid data/);
  await assert.rejects(loadOne([{ ...fireball, stanceBarOrder: -1 }]), /invalid data/);
  await assert.rejects(loadOne([{ ...fireball, bonusActionBarOffset: -1 }]), /invalid data/);
  await assert.rejects(loadOne([{ ...fireball, bonusActionBarOffset: 1.5 }]), /invalid data/);
});

test("v11 only opens a special selection flow for an unambiguous DBC requirement", () => {
  assert.deepEqual(spellRequiredTargeting(0x40), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.Ground,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Ground,
  });
  assert.deepEqual(spellRequiredTargeting(0x10), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.Item,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Item,
  });
  assert.deepEqual(spellRequiredTargeting(0x42), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.Unit | SPELL_REQUIRED_TARGET_MASK.Ground,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Unknown,
  });
  assert.deepEqual(spellRequiredTargeting(0x60), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.Ground,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Unknown,
  });
  assert.deepEqual(spellRequiredTargeting(0x200), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.None,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Unknown,
  });
  assert.deepEqual(spellRequiredTargeting(0x800), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.None,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Unknown,
  });
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("Auto Shot and wand Shoot carry the DBC auto-repeat bit, ordinary Attack does not", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await loadSpellMetadata(dbcDirectory);
  assert.equal(spells.get(75)?.autoRepeat, true, "Auto Shot is a repeat container, not a recast loop");
  assert.equal(spells.get(5019)?.autoRepeat, true, "wand Shoot uses the same repeat container");
  assert.equal(spells.get(6603)?.autoRepeat, false, "the melee Attack client action uses ATTACK_SWING instead");
});

test("stance metadata preserves DBC order without mistaking the extra bar flag for all forms", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await loadSpellMetadata(dbcDirectory);
  assert.deepEqual([2457, 71, 2458].map((id) => spells.get(id)?.stanceBarOrder), [0, 1, 2]);
  for (const id of [2457, 71, 2458, 768, 5487]) {
    const spell = spells.get(id);
    assert.equal(spell.displayInStanceBar, false);
    assert.ok(spell.effectAura.includes(36), "ordinary forms are identified by MOD_SHAPESHIFT");
  }
  assert.equal(spells.get(465)?.displayInStanceBar, true, "Devotion Aura is an extra bar entry");
  assert.equal(spells.get(133)?.displayInStanceBar, false, "Fireball does not belong on the bar");
  const bonuses = parseSpellShapeshiftFormBonuses(await readFile(join(dbcDirectory,
    "SpellShapeshiftForm.dbc")));
  assert.deepEqual([17, 18, 19, 5, 8, 3].map((form) => bonuses.get(form)), [1, 2, 3, 3, 3, 0]);
  assert.deepEqual([2457, 71, 2458, 5487, 9634, 768, 783].map((id) =>
    spells.get(id)?.bonusActionBarOffset), [1, 2, 3, 3, 3, 1, 0],
  "spell aura form ID resolves through the authored BonusActionBar column");
  assert.equal(spells.get(465)?.bonusActionBarOffset, undefined,
    "flagged non-shapeshift auras do not invent a form action page");
  assert.throws(() => parseSpellShapeshiftFormBonuses(new Uint8Array([87, 68, 66, 67])),
    /SpellShapeshiftForm.dbc/);
});
