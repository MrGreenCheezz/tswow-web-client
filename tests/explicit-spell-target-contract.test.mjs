import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPLICIT_SPELL_TARGET_MASK as Mask,
  explicitSpellTargetContract,
} from "../dist/code/gateway/ExplicitSpellTargetContract.js";

const unavailable = {
  explicitTargetContractVersion: 2,
  explicitTargetMask: Mask.None,
  clientSelectionMask: Mask.None,
  supportsExplicitTarget: false,
};

function contract({
  targets = 0,
  effects = [10, 0, 0],
  implicitTargetA = [21, 0, 0],
  implicitTargetB = [0, 0, 0],
  rangeMaxHostile = 40,
  rangeMaxFriendly = 40,
} = {}) {
  return explicitSpellTargetContract({
    targets, effects, implicitTargetA, implicitTargetB, rangeMaxHostile, rangeMaxFriendly,
  });
}

function available(mask, clientSelectionMask = Mask.None) {
  return {
    explicitTargetContractVersion: 2,
    explicitTargetMask: mask,
    clientSelectionMask,
    supportsExplicitTarget: true,
  };
}

test("the bounded helper preserves Trinity's direct Unit and derived source/destination shapes", () => {
  assert.deepEqual(contract(), available(Mask.Unit));
  assert.deepEqual(contract({ effects: [3, 0, 0], implicitTargetA: [89, 0, 0] }),
    available(Mask.Source | Mask.Destination), "TARGET_DEST_TRAJ");
  assert.deepEqual(contract({ effects: [5, 0, 0], implicitTargetA: [0, 0, 0] }),
    available(Mask.Unit | Mask.Destination),
    "SPELL_EFFECT_TELEPORT_UNITS destination is derived by the core, not a new ground click");
  assert.deepEqual(contract({ effects: [2, 0, 0], implicitTargetA: [6, 0, 0], implicitTargetB: [22, 0, 0] }),
    available(Mask.Unit), "TARGET_SRC_CASTER marks the source as already supplied");
  assert.deepEqual(contract({ targets: 0x40, effects: [3, 0, 0], implicitTargetA: [0, 0, 0] }),
    available(Mask.Destination, Mask.Destination), "raw TARGET_FLAG_DEST_LOCATION is a direct ground choice");
});

test("GameObject, corpse and carried-item paths use one canonical semantic representation", () => {
  assert.deepEqual(contract({ effects: [86, 0, 0], implicitTargetA: [23, 0, 0] }),
    available(Mask.GameObject, Mask.GameObject), "TARGET_GAMEOBJECT_TARGET");
  assert.deepEqual(contract({ effects: [18, 0, 0], implicitTargetA: [0, 0, 0] }),
    available(Mask.CorpseAlly, Mask.CorpseAlly), "SPELL_EFFECT_RESURRECT");
  assert.deepEqual(contract({ effects: [116, 0, 0], implicitTargetA: [0, 0, 0] }),
    available(Mask.CorpseEnemy, Mask.CorpseEnemy), "SPELL_EFFECT_SKIN_PLAYER_CORPSE");
  assert.deepEqual(contract({ effects: [53, 0, 0], implicitTargetA: [0, 0, 0] }),
    available(Mask.Item, Mask.Item), "SPELL_EFFECT_ENCHANT_ITEM");
});

test("special, ambiguous, unknown and malformed generic paths fail closed", () => {
  const cases = [
    { name: "game-object-item selector", input: { implicitTargetA: [26, 0, 0] } },
    { name: "minipet", input: { implicitTargetA: [90, 0, 0] } },
    { name: "vehicle passenger", input: { implicitTargetA: [95, 0, 0] } },
    { name: "two world objects", input: { targets: 0x00000802 } },
    { name: "trade target flag", input: { targets: 0x00001000 } },
    { name: "unknown target code", input: { implicitTargetA: [111, 0, 0] } },
    { name: "unknown effect", input: { effects: [165, 0, 0] } },
    { name: "non-finite range", input: { rangeMaxHostile: Number.NaN } },
    { name: "wrong slot count", input: { effects: [10, 0] } },
  ];
  for (const { name, input } of cases) assert.deepEqual(contract(input), unavailable, name);

  assert.deepEqual(contract({
    effects: [18, 0, 0], implicitTargetA: [0, 0, 0], rangeMaxHostile: 0, rangeMaxFriendly: 0,
  }), unavailable, "Trinity suppresses a missing corpse requirement at zero range");
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

function inputFor(spells, ranges, row) {
  const range = ranges.rowOf(spells.int(row, "RangeIndex"));
  return {
    targets: spells.int(row, "Targets"),
    effects: [0, 1, 2].map((effect) => spells.int(row, "Effect", effect)),
    implicitTargetA: [0, 1, 2].map((effect) => spells.int(row, "ImplicitTargetA", effect)),
    implicitTargetB: [0, 1, 2].map((effect) => spells.int(row, "ImplicitTargetB", effect)),
    rangeMaxHostile: range === undefined ? 0 : ranges.float(range, "RangeMax", 0),
    rangeMaxFriendly: range === undefined ? 0 : ranges.float(range, "RangeMax", 1),
  };
}

test("the active 3.3.5a DBC and served metadata agree on every bounded target kind", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const [{ openDbcFile }, { loadSpellMetadata }] = await Promise.all([
    import("../dist/code/gateway/Dbc.js"),
    import("../dist/code/gateway/SpellMetadata.js"),
  ]);
  const [spells, ranges, metadata] = await Promise.all([
    openDbcFile(dbcDirectory, "Spell"),
    openDbcFile(dbcDirectory, "SpellRange"),
    loadSpellMetadata(dbcDirectory),
  ]);

  for (const id of [2050, 2061, 133]) {
    const row = spells.rowOf(id);
    assert.notEqual(row, undefined, `active DBC has spell ${id}`);
    const expected = contract(inputFor(spells, ranges, row));
    assert.deepEqual(expected, available(Mask.Unit), `raw DBC spell ${id}`);
    assert.deepEqual({
      explicitTargetContractVersion: metadata.get(id)?.explicitTargetContractVersion,
      explicitTargetMask: metadata.get(id)?.explicitTargetMask,
      clientSelectionMask: metadata.get(id)?.clientSelectionMask,
      supportsExplicitTarget: metadata.get(id)?.supportsExplicitTarget,
    }, expected, `served metadata spell ${id}`);
  }

  const required = new Map([
    ["gameObject", (mask) => (mask & Mask.GameObject) !== 0],
    ["corpseAlly", (mask) => (mask & Mask.CorpseAlly) !== 0],
    ["corpseEnemy", (mask) => (mask & Mask.CorpseEnemy) !== 0],
    ["item", (mask) => (mask & Mask.Item) !== 0],
    ["source", (mask) => (mask & Mask.Source) !== 0],
    ["mixedUnitDestination", (mask) => (mask & (Mask.Unit | Mask.Destination)) === (Mask.Unit | Mask.Destination)],
  ]);
  const candidates = new Map();
  for (const row of spells.rows()) {
    const expected = contract(inputFor(spells, ranges, row));
    if (!expected.supportsExplicitTarget) continue;
    for (const [kind, matches] of required) {
      if (!candidates.has(kind) && matches(expected.explicitTargetMask)) {
        candidates.set(kind, { id: spells.id(row), expected });
      }
    }
    if (candidates.size === required.size) break;
  }

  for (const [kind] of required) {
    const candidate = candidates.get(kind);
    assert.ok(candidate, `active DBC has a bounded ${kind} target shape`);
    assert.deepEqual({
      explicitTargetContractVersion: metadata.get(candidate.id)?.explicitTargetContractVersion,
      explicitTargetMask: metadata.get(candidate.id)?.explicitTargetMask,
      clientSelectionMask: metadata.get(candidate.id)?.clientSelectionMask,
      supportsExplicitTarget: metadata.get(candidate.id)?.supportsExplicitTarget,
    }, candidate.expected, `served ${kind} spell ${candidate.id}`);
  }
});
