import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

// 5.20 on the real dataset: `/dbc/spells?v=15` carries DispelType raw on every row and the string
// Wow.exe 0x006147c0 returns — SpellDispelType.InternalName where ImmunityPossible is set.

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("SpellDispelType.dbc: strings only for the rows with ImmunityPossible", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { parseDebuffTypeNames } = await import("../dist/code/gateway/SpellMetadata.js");
  const names = parseDebuffTypeNames(await readFile(join(dbcDirectory, "SpellDispelType.dbc")));
  assert.deepEqual([...names].sort(([a], [b]) => a - b),
    [[1, "Magic"], [2, "Curse"], [3, "Disease"], [4, "Poison"], [9, ""]]);
  assert.equal(parseDebuffTypeNames(new Uint8Array(8)).size, 0, "an unreadable table gives nothing");
});

test("served dispelType matches Spell.dbc on every row, debuffType follows it", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const [{ openDbcFile }, { loadSpellMetadata }] = await Promise.all([
    import("../dist/code/gateway/Dbc.js"),
    import("../dist/code/gateway/SpellMetadata.js"),
  ]);
  const [spells, metadata] = await Promise.all([openDbcFile(dbcDirectory, "Spell"), loadSpellMetadata(dbcDirectory)]);
  const expected = { 1: "Magic", 2: "Curse", 3: "Disease", 4: "Poison", 9: "" };
  let rows = 0;
  let tableRows = 0;
  for (const row of spells.rows()) {
    tableRows += 1;
    const id = spells.id(row);
    const served = metadata.get(id);
    if (!served) continue;
    rows += 1;
    const raw = spells.int(row, "DispelType");
    assert.equal(served.dispelType, raw, `spell ${id}`);
    assert.equal(served.debuffType, expected[raw], `spell ${id} type ${raw}`);
  }
  // Every Spell.dbc row is served and checked. The base dataset (08.10) is the stock table, 49,839
  // rows up to id 80864; the install with modules had more than 70,000.
  assert.equal(rows, tableRows, `${rows} of ${tableRows} rows checked`);
  assert.ok(rows >= 49_839, `${rows} rows checked`);
  const pick = (id) => [metadata.get(id).dispelType, metadata.get(id).debuffType];
  assert.deepEqual(pick(118), [1, "Magic"], "Превращение");
  assert.deepEqual(pick(172), [1, "Magic"], "Порча");
  assert.deepEqual(pick(1126), [1, "Magic"], "Знак дикой природы");
  assert.deepEqual(pick(702), [2, "Curse"], "Проклятие слабости");
  assert.deepEqual(pick(55095), [3, "Disease"], "Озноб");
  assert.deepEqual(pick(2818), [4, "Poison"]);
  assert.deepEqual(pick(3034), [4, "Poison"]);
  assert.deepEqual(pick(18499), [9, ""], "an enrage: the stock DebuffTypeColor[\"\"]");
  assert.deepEqual(pick(1784), [5, undefined], "stealth has no UnitAura type");
  assert.deepEqual(pick(6788), [0, undefined]);
  // Spellsteal is what gives a mage the steal mask the seam tests (Wow.exe 0x00542263).
  const steal = metadata.get(30449);
  assert.deepEqual([steal.effects[0], steal.implicitTargetA[0], steal.effectMiscValue[0]], [126, 6, 1]);
});

test("the browser asks v=17 (L13; v=16 before), and a v=15 batch is asked once more past the cache", async () => {
  const { SpellMetadataClient } = await import("../dist/code/browser/SpellMetadata.js");
  const row = (extra) => ({
    id: 172, name: "Порча", rank: "", description: "", iconId: 0, iconPath: "", passive: false, hidden: false,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [], effectMiscValue: [],
    effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0], effectRadius: [0, 0, 0], effectPeriod: [0, 0, 0],
    spellLevel: 0, spellClassSet: 0, spellClassMask: [0, 0, 0], schoolMask: 32,
    rangeMin: 0, rangeMax: 30, rangeFlags: 0, castTime: 0, duration: 0, procChance: 0,
    autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0, rangeMaxFriendly: 30, ...extra,
  });
  const calls = [];
  let rows = [row({})];
  const fetcher = async (url, init) => {
    calls.push([String(url), init?.cache]);
    return { ok: true, status: 200, json: async () => rows };
  };
  const old = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  assert.equal((await old.load([172])).get(172).debuffType, undefined);
  assert.deepEqual(calls, [
    ["http://127.0.0.1:8090/dbc/spells?ids=172&v=17", undefined], // L13: v=17
    ["http://127.0.0.1:8090/dbc/spells?ids=172&v=17", "reload"],
  ], "the v=15 shape is an older gateway for the v=17 key");

  calls.length = 0;
  rows = [row({ dispelType: 1, debuffType: "Magic", preventionType: 1, startRecoveryCategory: 0 })]; // L13: the v=17 marker
  const fresh = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  assert.equal((await fresh.load([172])).get(172).debuffType, "Magic");
  assert.equal(calls.length, 1, "a v=17 answer stands");
  rows = [row({ id: 173, dispelType: "Magic", preventionType: 1 })];
  await assert.rejects(fresh.load([173]), /invalid data/, "dispelType is the raw index");
});

test("the aura tooltip's dispel name: SpellDispelType's localised Name where ImmunityPossible is set (0x00625350)", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { parseDispelTypeNames, loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const names = parseDispelTypeNames(await readFile(join(dbcDirectory, "SpellDispelType.dbc")), "ruRU");
  assert.deepEqual([...names].sort(([a], [b]) => a - b),
    [[1, "Магия"], [2, "Проклятие"], [3, "Болезнь"], [4, "Яд"], [9, "Исступление"]]);
  assert.equal(parseDispelTypeNames(new Uint8Array(8), "ruRU").size, 0);
  const metadata = await loadSpellMetadata(dbcDirectory);
  const pick = (id) => metadata.get(id).dispelName;
  assert.equal(pick(118), "Магия");
  assert.equal(pick(702), "Проклятие");
  assert.equal(pick(18499), "Исступление", "Enrage has a name though its InternalName is empty");
  assert.equal(pick(1784), undefined, "stealth: no ImmunityPossible, no name");
  assert.equal(pick(6788), undefined, "DispelType 0");
});
