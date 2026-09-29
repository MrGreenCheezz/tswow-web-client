import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCharacterStatTable, parseCharacterRatingScalar, isCharacterStatCatalog, spellCritFromIntellect,
  characterCombatRatingBonus } from "../dist/code/world/CharacterStatData.js";
import { loadCharacterStatData } from "../dist/code/gateway/CharacterStatMetadata.js";
import { loadFrameXmlCharacterStats } from "../dist/code/browser/framexml/FrameXmlCharacterStats.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { LiveWorldSeam } from "../dist/code/browser/framexml/LiveWorldSeam.js";
import { FRAMEXML_SEAM_BINDINGS } from "../dist/code/browser/framexml/FrameXmlWorldSeam.js";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

function table(values) {
  const data = Buffer.alloc(21 + values.length * 4);
  data.write("WDBC");
  data.writeUInt32LE(values.length, 4);
  data.writeUInt32LE(1, 8);
  data.writeUInt32LE(4, 12);
  data.writeUInt32LE(1, 16);
  values.forEach((value, index) => data.writeFloatLE(value, 20 + index * 4));
  return data;
}

function catalog() {
  const ratio = Array(200).fill(0);
  ratio[100] = 0.005;
  ratio[168] = 0.001;
  ratio[199] = 0.0005;
  return { spellCritBase: [0, 0.03], spellCritPerIntellect: ratio,
    combatRatingPerLevel: Array(2500).fill(5), combatRatingScalar: { 34: 1.5, 38: 2 } };
}

function scalarTable(values) {
  const rows = Object.entries(values);
  const data = Buffer.alloc(21 + rows.length * 8);
  data.write("WDBC");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(2, 8);
  data.writeUInt32LE(8, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach(([id, value], index) => {
    data.writeUInt32LE(Number(id), 20 + index * 8);
    data.writeFloatLE(value, 24 + index * 8);
  });
  return data;
}

test("combat rating bonus uses explicit class IDs, one-based rating and the core's level cap", () => {
  const rows = catalog();
  rows.combatRatingPerLevel[179] = 4;
  rows.combatRatingPerLevel[199] = 10;
  assert.equal(characterCombatRatingBonus(rows, 2, 80, 2, 100), 37.5);
  assert.equal(characterCombatRatingBonus(rows, 2, 120, 2, 100), 15);
  assert.equal(characterCombatRatingBonus(rows, 2, 80, 6, 100), 40);
  for (const args of [[undefined, 2, 80, 2, 100], [rows, 1, 80, 2, 100], [rows, 2, 0, 2, 100],
    [rows, 2, 80, 0, 100], [rows, 2, 80, 26, 100], [rows, 2, 80, 2, -1]]) {
    assert.equal(characterCombatRatingBonus(...args), undefined);
  }
  rows.combatRatingPerLevel[179] = 0;
  assert.equal(characterCombatRatingBonus(rows, 2, 80, 2, 100), undefined);
});

test("class rating scalar parser preserves sparse IDs and rejects duplicate/non-finite rows", () => {
  assert.deepEqual(parseCharacterRatingScalar(scalarTable({ 34: 1.5, 38: 2 })), { 34: 1.5, 38: 2 });
  const duplicate = scalarTable({ 34: 1.5, 38: 2 });
  duplicate.writeUInt32LE(34, 28);
  assert.throws(() => parseCharacterRatingScalar(duplicate), /invalid ID/);
  assert.throws(() => parseCharacterRatingScalar(scalarTable({ 34: NaN })), /coefficient/);
  assert.throws(() => parseCharacterRatingScalar(table([1])), /layout/);
  assert.equal(isCharacterStatCatalog({ ...catalog(), combatRatingScalar: { 34: NaN } }), false);
});

test("browser requests the new metadata cache version and still accepts a running older gateway", async () => {
  const { spellCritBase, spellCritPerIntellect } = catalog();
  const oldCatalog = { spellCritBase, spellCritPerIntellect };
  const loaded = await loadFrameXmlCharacterStats("http://127.0.0.1:8090", async (url) => {
    assert.equal(new URL(url).pathname, "/dbc/character-stats");
    assert.equal(new URL(url).searchParams.get("version"), "2");
    return new Response(JSON.stringify(oldCatalog));
  });
  assert.deepEqual(loaded, oldCatalog);
  assert.equal(characterCombatRatingBonus(loaded, 2, 80, 2, 100), undefined,
    "missing coefficients remain unknown instead of inventing a conversion");
  assert.equal(isCharacterStatCatalog({ ...oldCatalog, combatRatingPerLevel: Array(2500).fill(1) }), false,
    "a partial new catalog cannot silently mix table versions");
});

test("intellect spell crit follows TC class base, level index and level100 cap", () => {
  const rows = catalog();
  assert.equal(isCharacterStatCatalog(rows), true);
  assert.equal(spellCritFromIntellect(rows, 2, 69, 200), 23);
  assert.equal(spellCritFromIntellect(rows, 2, 1, 200), 103);
  assert.equal(spellCritFromIntellect(rows, 2, 101, 200), 13);
  assert.equal(spellCritFromIntellect(rows, 2, 69, 0), 3, "class base remains at zero intellect");
  for (const args of [[undefined, 2, 69, 200], [rows, 0, 69, 200], [rows, 3, 69, 200],
    [rows, 2, 0, 200], [rows, 2, 69, NaN]]) assert.equal(spellCritFromIntellect(...args), undefined);
  assert.equal(isCharacterStatCatalog({ ...rows, spellCritPerIntellect: [0] }), false);
});

test("GT parser rejects foreign layouts, truncation and non-finite coefficients", () => {
  const bytes = table([0, 0.25]);
  assert.deepEqual(parseCharacterStatTable(bytes), [0, 0.25]);
  const wrong = Buffer.from(bytes);
  wrong.writeUInt32LE(2, 8);
  assert.throws(() => parseCharacterStatTable(wrong), /layout/);
  assert.throws(() => parseCharacterStatTable(bytes.subarray(0, bytes.length - 1)), /layout/);
  assert.throws(() => parseCharacterStatTable(table([NaN])), /non-finite/);
});

test("live intellect API uses effective server STAT3 without readding buffs, and adds nothing without metadata", () => {
  const fields = new Map([
    [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, 1 | (2 << 8)],
    [UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 69],
    [UPDATE_FIELDS.UNIT_FIELD_STAT0.offset + 3, 200],
    [UPDATE_FIELDS.UNIT_FIELD_POSSTAT0.offset + 3, 50],
  ]);
  const player = { guid: 1n, typeId: 4, fields };
  const world = { state: { selfGuid: 1n, objects: new Map([[1n, player]]) } };
  let rows;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
    characterStats: () => rows,
  });
  const call = (unit) => FRAMEXML_SEAM_BINDINGS.GetSpellCritChanceFromIntellect(seam, [unit]);
  // PaperDollFrame.lua:296 formats this unguarded; without the catalog the answer is «no known
  // contribution», never a missing value that aborts UpdatePaperdollStats.
  assert.deepEqual(call("player"), [0]);
  rows = catalog();
  assert.deepEqual(call("player"), [23]);
  assert.deepEqual(call("target"), [0]);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_STAT0.offset + 3, 100);
  assert.deepEqual(call("player"), [13], "a server stat update is reflected on the next read");
});

test("character stat endpoint serves configured DBC rows behind the gateway origin check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "framexml-character-stat-"));
  const origin = "http://127.0.0.1:5173";
  let gateway;
  try {
    const rows = catalog();
    await Promise.all([
      writeFile(join(directory, "gtChanceToSpellCritBase.dbc"), table(rows.spellCritBase)),
      writeFile(join(directory, "gtChanceToSpellCrit.dbc"), table(rows.spellCritPerIntellect)),
      writeFile(join(directory, "gtCombatRatings.dbc"), table(rows.combatRatingPerLevel)),
      writeFile(join(directory, "gtOCTClassCombatRatingScalar.dbc"), scalarTable(rows.combatRatingScalar)),
    ]);
    const expected = await loadCharacterStatData(directory);
    gateway = await startGateway({
      host: "127.0.0.1", port: 0,
      auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
      allowedOrigins: [origin], dbcDirectory: directory, datasetPollMs: 0,
    });
    const base = `http://127.0.0.1:${gateway.port}`;
    assert.equal((await fetch(`${base}/dbc/character-stats`)).status, 403);
    const response = await fetch(`${base}/dbc/character-stats`, { headers: { origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.deepEqual(await response.json(), expected);
    const fromBrowser = await loadFrameXmlCharacterStats(base,
      (url, options) => fetch(url, { ...options, headers: { origin } }));
    assert.deepEqual(fromBrowser, expected);
    await assert.rejects(loadFrameXmlCharacterStats(base, async () => new Response("{}")), /invalid catalog/);
  } finally {
    await gateway?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
