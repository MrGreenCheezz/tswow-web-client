import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// L13 (04.10): `/dbc/spells?v=17` adds the columns several plan items stopped at — StartRecoveryCategory
// (5.30: the realm keys its global cooldowns by it and starts none for 0, Spell.cpp:8698; Wow.exe
// 0x00807980 holds a spell while a global part of the same category runs), EffectMiscValueB[3] and, for a
// SPELL_EFFECT_SUMMON (28), the SummonProperties.dbc row it names (3.12: Wow.exe 0x0061e830's Title,
// TrinityCore DBCfmt.h "niiiii": ID, Control, Faction, Title, Slot, Flags). The columns are checked
// against tools/dbd (Spell 113-115, 205) and DBCStructure.h:1487, 1504, 1680-1688.

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const { DBC_LAYOUTS } = await import("../dist/code/generated/dbcLayouts.js");
const { parseSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
const { parseSummonProperties, spellSummonProperties } = await import("../dist/code/gateway/SummonPropertiesMetadata.js");

/** A WDBC image of `fields` 32-bit words a record. */
function image(fields, records, strings = Buffer.from([0])) {
  const recordSize = fields * 4;
  const out = Buffer.alloc(20 + records.length * recordSize + strings.length);
  out.write("WDBC", 0, "latin1");
  out.writeUInt32LE(records.length, 4);
  out.writeUInt32LE(fields, 8);
  out.writeUInt32LE(recordSize, 12);
  out.writeUInt32LE(strings.length, 16);
  records.forEach((words, row) => words.forEach((word, index) => out.writeInt32LE(word | 0, 20 + row * recordSize + index * 4)));
  strings.copy(out, 20 + records.length * recordSize);
  return out;
}
const empty = (table) => image(DBC_LAYOUTS[table].fieldCount, []);

/** A Spell.dbc record: Effect 71-73, EffectMiscValueB 113-115, StartRecoveryCategory 205, StartRecoveryTime 206. */
function spell(id, columns) {
  const words = Array(DBC_LAYOUTS.Spell.fieldCount).fill(0);
  words[0] = id;
  for (const [index, value] of Object.entries(columns)) words[Number(index)] = value;
  return words;
}
// The dataset's own values (Spell.dbc, SummonProperties.dbc, read 2026-10-04).
const SPELLS = [
  spell(133, { 71: 2, 72: 6, 205: 133, 206: 1500 }), // Огненный шар
  spell(45469, { 71: 6, 205: 0, 206: 1500 }), // Удар смерти: category 0 with a time
  spell(48941, { 71: 65, 205: 38, 206: 1500 }), // Аура благочестия: category 38
  spell(7744, { 71: 6, 72: 6, 73: 6, 205: 133, 206: 0 }), // Воля Отрекшихся: 133 without a time
  spell(3599, { 71: 28, 113: 63, 205: 133, 206: 1000 }), // Опаляющий тотем → SummonProperties 63
  spell(49206, { 71: 28, 72: 6, 73: 64, 113: 209, 205: 133, 206: 1500 }), // Призыв горгульи → 209
  spell(4242, { 71: 6, 72: 28, 114: 9999 }), // a summon in the second effect naming no row
];
const SUMMON_PROPERTIES = [[63, 1, 0, 4, 1, 2], [209, 1, 0, 7, 0, 512], [1021, 1, 0, 0, 0, 512], [61, 1, 0, -1, 0, 0]];

test("parseSummonProperties: every column, Title signed; another layout is not read", () => {
  const table = parseSummonProperties(image(6, SUMMON_PROPERTIES));
  assert.deepEqual(table.get(63), { id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 });
  assert.equal(table.get(61).title, -1, "-1 asks Wow.exe 0x0061e830 for the default title");
  assert.equal(table.size, 4);
  assert.equal(parseSummonProperties(image(5, [[63, 1, 0, 4, 1]])).size, 0, "five columns: not SummonProperties");
  const twelveHalves = image(6, SUMMON_PROPERTIES);
  twelveHalves.writeUInt32LE(12, 8); // the same 24 bytes a row, as twelve 16-bit columns
  assert.equal(parseSummonProperties(twelveHalves).size, 0, "the column count is checked, not only the size");
  assert.equal(parseSummonProperties(Buffer.from("WDBX")).size, 0);
  const truncated = image(6, SUMMON_PROPERTIES).subarray(0, 40);
  assert.equal(parseSummonProperties(truncated).size, 0, "a short file is refused whole");
  // Only SPELL_EFFECT_SUMMON effects name a row; the rest are null, a spell without one has none.
  assert.deepEqual(spellSummonProperties([6, 28, 0], [63, 209, 0], table), [null, table.get(209), null]);
  assert.deepEqual(spellSummonProperties([28, 0, 0], [5, 0, 0], table), [null, null, null], "an id the table lacks");
  assert.equal(spellSummonProperties([6, 2, 0], [63, 0, 0], table), undefined);
});

test("v=17 rows: StartRecoveryCategory and EffectMiscValueB on every row, summon rows resolved", () => {
  const spells = image(DBC_LAYOUTS.Spell.fieldCount, SPELLS);
  const parsed = parseSpellMetadata(spells, empty("SpellIcon"), undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, image(6, SUMMON_PROPERTIES));
  const row = (id) => parsed.get(id);
  assert.deepEqual([133, 45469, 48941, 7744].map((id) => [row(id).startRecoveryCategory, row(id).startRecoveryTime]),
    [[133, 1500], [0, 1500], [38, 1500], [133, 0]]);
  assert.deepEqual(row(133).effectMiscValueB, [0, 0, 0]);
  assert.equal(row(133).summonProperties, undefined, "no summon effect: no field");
  assert.deepEqual(row(3599).effectMiscValueB, [63, 0, 0]);
  assert.deepEqual(row(3599).summonProperties, [{ id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 }, null, null]);
  assert.equal(row(49206).summonProperties[0].title, 7, "the gargoyle: UNITNAME_SUMMON_TITLE7");
  assert.deepEqual(row(4242).summonProperties, [null, null, null], "the summon names no row: the default title");
  assert.deepEqual(row(4242).effectMiscValueB, [0, 9999, 0]);
  // A dataset without the table: the category and the raw column, but no summon rows (unknown, not «no row»).
  const bare = parseSpellMetadata(spells, empty("SpellIcon"));
  assert.equal(bare.get(3599).summonProperties, undefined);
  assert.equal(bare.get(3599).startRecoveryCategory, 133);
  assert.deepEqual(bare.get(3599).effectMiscValueB, [63, 0, 0]);
});

test("the /dbc/spells route answers the v=17 columns (in process, synthetic DBC directory)", async () => {
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const directory = await mkdtemp(join(tmpdir(), "l13-dbc-"));
  await writeFile(join(directory, "Spell.dbc"), image(DBC_LAYOUTS.Spell.fieldCount, SPELLS));
  for (const table of ["SpellIcon", "SpellDuration", "SpellRadius", "SpellCategory", "SpellRange", "SpellCastTimes"]) {
    await writeFile(join(directory, `${table}.dbc`), empty(table));
  }
  await writeFile(join(directory, "SummonProperties.dbc"), image(6, SUMMON_PROPERTIES));
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"], dbcDirectory: directory,
  });
  try {
    const base = `http://127.0.0.1:${gateway.port}/dbc/spells`;
    const headers = { origin: "http://127.0.0.1:5173" };
    const response = await fetch(`${base}?ids=45469,3599,133&v=17`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate", "revalidated like every dataset route");
    const rows = new Map((await response.json()).map((row) => [row.id, row]));
    assert.equal(rows.get(45469).startRecoveryCategory, 0);
    assert.equal(rows.get(133).startRecoveryCategory, 133);
    assert.deepEqual(rows.get(3599).summonProperties[0], { id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 });
    assert.equal((await fetch(`${base}?ids=133&v=17`)).status, 403, "the Origin rule");
    assert.equal((await fetch(`${base}?ids=&v=17`, { headers })).status, 400);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("served v=17 columns match Spell.dbc and SummonProperties.dbc on every row of the dataset", withDataset, async () => {
  const [{ openDbcFile }, { loadSpellMetadata }, { readFile }] = await Promise.all([
    import("../dist/code/gateway/Dbc.js"), import("../dist/code/gateway/SpellMetadata.js"), import("node:fs/promises"),
  ]);
  const [spells, metadata, summon] = await Promise.all([
    openDbcFile(dbcDirectory, "Spell"), loadSpellMetadata(dbcDirectory), readFile(join(dbcDirectory, "SummonProperties.dbc")),
  ]);
  const table = parseSummonProperties(summon);
  assert.ok(table.size > 100, `${table.size} SummonProperties rows`);
  let rows = 0;
  let tableRows = 0;
  let summons = 0;
  for (const row of spells.rows()) {
    tableRows += 1;
    const id = spells.id(row);
    const served = metadata.get(id);
    if (!served) continue;
    rows += 1;
    assert.equal(served.startRecoveryCategory, spells.int(row, "StartRecoveryCategory"), `spell ${id}`);
    const effects = [0, 1, 2].map((index) => spells.int(row, "Effect", index));
    const miscValueB = [0, 1, 2].map((index) => spells.int(row, "EffectMiscValueB", index));
    assert.deepEqual(served.effectMiscValueB, miscValueB, `spell ${id}`);
    if (!effects.includes(28)) {
      assert.equal(served.summonProperties, undefined, `spell ${id}`);
      continue;
    }
    summons += 1;
    assert.deepEqual(served.summonProperties,
      effects.map((effect, index) => (effect === 28 ? table.get(miscValueB[index]) ?? null : null)), `spell ${id}`);
  }
  // Every Spell.dbc row: 49,839 on the base dataset (08.10, the stock table), over 70,000 with modules.
  assert.equal(rows, tableRows, `${rows} of ${tableRows} rows`);
  assert.ok(rows >= 49_839, `${rows} rows`);
  assert.ok(summons > 2_000, `${summons} summon rows`);
  const at = (id) => metadata.get(id);
  assert.deepEqual([at(7744).startRecoveryCategory, at(7744).startRecoveryTime], [133, 0], "Воля Отрекшихся");
  assert.deepEqual([at(45469).startRecoveryCategory, at(45469).startRecoveryTime], [0, 1500], "Удар смерти");
  assert.equal(at(48941).startRecoveryCategory, 38, "Аура благочестия");
  assert.equal(at(3599).summonProperties[0].title, 4, "Опаляющий тотем: «Тотем»");
  assert.equal(at(58833).summonProperties[0].title, 0, "Зеркальное изображение: no title line");
  assert.equal((at(33395).attributes[4] & 0x20), 0x20, "Холод: AttributesEx4 0x20 (11.02-D)");
});

test("the browser asks v=17; a batch without startRecoveryCategory is asked once more past the cache", async () => {
  const { SpellMetadataClient } = await import("../dist/code/browser/SpellMetadata.js");
  const row = (extra) => ({
    id: 3599, name: "Опаляющий тотем", rank: "", description: "", iconId: 0, iconPath: "",
    passive: false, hidden: false, powerType: 0, powerCost: 0, powerCostPercent: 9, recoveryTime: 0,
    categoryRecoveryTime: 0, startRecoveryTime: 1000, cooldownStartedOnEvent: false,
    effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0],
    effectPeriod: [0, 0, 0], spellLevel: 10, spellClassSet: 11, spellClassMask: [0, 0, 0], schoolMask: 4,
    rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: 0, duration: 0, procChance: 0,
    autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0, effects: [28, 0, 0],
    dispelType: 0, dmgClass: 1, preventionType: 1, interruptFlags: 15, channelInterruptFlags: 0, totemSlotMask: 1,
    ...extra,
  });
  const calls = [];
  let rows = [row({})];
  const fetcher = async (url, init) => {
    calls.push([String(url), init?.cache]);
    return { ok: true, status: 200, json: async () => rows };
  };
  const old = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  assert.equal((await old.load([3599])).get(3599).startRecoveryCategory, undefined, "a v=16 row still loads");
  assert.deepEqual(calls, [
    ["http://127.0.0.1:8090/dbc/spells?ids=3599&v=17", undefined],
    ["http://127.0.0.1:8090/dbc/spells?ids=3599&v=17", "reload"],
  ], "the v=16 shape is an older gateway for the v=17 key");

  calls.length = 0;
  const totem = { id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 };
  rows = [row({ startRecoveryCategory: 133, effectMiscValueB: [63, 0, 0], summonProperties: [totem, null, null] })];
  const fresh = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  const loaded = (await fresh.load([3599])).get(3599);
  assert.equal(loaded.startRecoveryCategory, 133);
  assert.equal(loaded.summonProperties[0].title, 4);
  assert.equal(calls.length, 1, "a v=17 answer stands");
  const refused = async (id, extra, message) => {
    rows = [row({ id, startRecoveryCategory: 133, ...extra })];
    await assert.rejects(fresh.load([id]), /invalid data/, message);
  };
  await refused(3600, { startRecoveryCategory: "133" }, "a category is a number");
  await refused(3601, { startRecoveryCategory: -1 }, "and not negative");
  await refused(3602, { effectMiscValueB: [63, 0] }, "three effects");
  await refused(3603, { summonProperties: [{ ...totem, title: "4" }, null, null] }, "a summon row is numbers");
  await refused(3604, { summonProperties: [totem, null] }, "one entry per effect");
  await refused(3605, { summonProperties: [7, null, null] }, "an entry is a row or null");
});
