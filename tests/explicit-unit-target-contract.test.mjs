import assert from "node:assert/strict";
import test from "node:test";
import { explicitUnitTargetContract } from "../dist/code/gateway/ExplicitUnitTargetContract.js";

const supported = { unitTargetContractVersion: 1, supportsExplicitUnitTarget: true };
const unsupported = { unitTargetContractVersion: 1, supportsExplicitUnitTarget: false };

function contract({ targets = 0, effects = [10, 0, 0], implicitTargetA = [21, 0, 0], implicitTargetB = [0, 0, 0] } = {}) {
  return explicitUnitTargetContract({ targets, effects, implicitTargetA, implicitTargetB });
}

test("implicit direct Unit targets work with a zero legacy Targets seed", () => {
  assert.deepEqual(contract({ implicitTargetA: [6, 0, 0] }), supported, "TARGET_UNIT_TARGET_ENEMY");
  assert.deepEqual(contract({ implicitTargetA: [21, 0, 0] }), supported, "TARGET_UNIT_TARGET_ALLY");
  assert.deepEqual(contract({ implicitTargetA: [25, 0, 0] }), supported, "TARGET_UNIT_TARGET_ANY");
  assert.deepEqual(contract({ implicitTargetA: [35, 0, 0] }), supported, "TARGET_UNIT_TARGET_PARTY");
  assert.deepEqual(contract({ implicitTargetA: [45, 0, 0] }), supported, "chain heal still starts from one ally");
  assert.deepEqual(contract({ implicitTargetA: [57, 0, 0] }), supported, "TARGET_UNIT_TARGET_RAID");
});

test("inactive effects ignore stale implicit target columns", () => {
  assert.deepEqual(contract({
    effects: [10, 0, 0],
    implicitTargetA: [21, 1, 26],
    implicitTargetB: [0, 22, 17],
  }), supported);
});

test("self, area, source, destination, item, ground, unknown and mixed sources fail closed", () => {
  const cases = [
    { name: "self", input: { implicitTargetA: [1, 0, 0] } },
    { name: "area", input: { implicitTargetA: [16, 0, 0] } },
    { name: "source", input: { implicitTargetA: [22, 0, 0] } },
    { name: "destination", input: { implicitTargetA: [17, 0, 0] } },
    { name: "item", input: { implicitTargetA: [26, 0, 0] } },
    { name: "ground cursor", input: { targets: 0x40, implicitTargetA: [6, 0, 0] } },
    { name: "unknown", input: { implicitTargetA: [110, 0, 0] } },
    { name: "self plus target", input: { effects: [10, 6, 0], implicitTargetA: [6, 1, 0] } },
    { name: "minipet", input: { implicitTargetA: [90, 0, 0] } },
    { name: "passenger", input: { implicitTargetA: [95, 0, 0] } },
  ];
  for (const { name, input } of cases) {
    assert.deepEqual(contract(input), unsupported, name);
  }
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

function inputFor(table, row) {
  return {
    targets: table.int(row, "Targets"),
    effects: [0, 1, 2].map((effect) => table.int(row, "Effect", effect)),
    implicitTargetA: [0, 1, 2].map((effect) => table.int(row, "ImplicitTargetA", effect)),
    implicitTargetB: [0, 1, 2].map((effect) => table.int(row, "ImplicitTargetB", effect)),
  };
}

test("the active 3.3.5a DBC exposes real direct spells while self, ground and item rows remain blocked", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const [{ openDbcFile }, { loadSpellMetadata }] = await Promise.all([
    import("../dist/code/gateway/Dbc.js"),
    import("../dist/code/gateway/SpellMetadata.js"),
  ]);
  const table = await openDbcFile(dbcDirectory, "Spell");
  const metadata = await loadSpellMetadata(dbcDirectory);

  for (const id of [2050, 2061, 133]) {
    const row = table.rowOf(id);
    assert.notEqual(row, undefined, `active DBC has spell ${id}`);
    assert.equal(inputFor(table, row).targets, 0, `spell ${id} is the zero-seed regression`);
    assert.deepEqual(explicitUnitTargetContract(inputFor(table, row)), supported, `raw DBC spell ${id}`);
    assert.deepEqual({
      unitTargetContractVersion: metadata.get(id)?.unitTargetContractVersion,
      supportsExplicitUnitTarget: metadata.get(id)?.supportsExplicitUnitTarget,
    }, supported, `served metadata spell ${id}`);
  }

  const candidates = new Map();
  for (const row of table.rows()) {
    const input = inputFor(table, row);
    const activeTargets = input.effects.flatMap((effect, index) => effect === 0
      ? [] : [input.implicitTargetA[index], input.implicitTargetB[index]]);
    if (!candidates.has("self") && activeTargets.includes(1) && activeTargets.every((target) => target === 0 || target === 1)) {
      candidates.set("self", table.id(row));
    }
    if (!candidates.has("ground") && ((input.targets >>> 0) & 0x40) !== 0) candidates.set("ground", table.id(row));
    if (!candidates.has("item") && (((input.targets >>> 0) & 0x10) !== 0 || activeTargets.includes(26))) {
      candidates.set("item", table.id(row));
    }
    if (candidates.size === 3) break;
  }

  for (const kind of ["self", "ground", "item"]) {
    const id = candidates.get(kind);
    assert.ok(id, `active DBC has a ${kind} target shape`);
    const row = table.rowOf(id);
    assert.deepEqual(explicitUnitTargetContract(inputFor(table, row)), unsupported, `raw ${kind} spell ${id}`);
    assert.equal(metadata.get(id)?.supportsExplicitUnitTarget, false, `served ${kind} spell ${id}`);
  }
});
