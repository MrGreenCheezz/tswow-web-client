import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import zlib from "node:zlib";

// 3.43 (15.11, names10): `/dbc/spell-info` — every spell of the dataset as the compact table the by-id spell globals
// answer from (src/world/SpellInfoTable.ts), its route, its browser client and what GetSpellInfo / GetSpellLink /
// GetSpellCooldown answer with it. In Wow.exe `GetSpellInfo(id)` answers at once for any id (0x00540a30 reads Spell.dbc
// in memory); here an id whose `/dbc/spells` row was never asked for answered nil.

const { encodeSpellInfoTable, SpellInfoTable, SPELL_INFO_ROW_KEYS, SPELL_INFO_TABLE_PATH, SPELL_INFO_TABLE_VERSION } =
  await import("../dist/code/world/SpellInfoTable.js");
const { serveSpellInfoTable } = await import("../dist/code/gateway/SpellInfoTableRoute.js");
const { SpellInfoTableClient } = await import("../dist/code/browser/SpellInfoTableClient.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

let dbc;
try {
  dbc = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbc = undefined;
}
const withDataset = { skip: dbc && existsSync(join(dbc, "Spell.dbc")) ? false : "no dataset Spell.dbc" };
let dataset;
async function datasetRows() {
  if (!dataset) {
    const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
    dataset = await loadSpellMetadata(dbc);
  }
  return dataset;
}

function pick(row) {
  const out = {};
  for (const key of SPELL_INFO_ROW_KEYS) if (row[key] !== undefined) out[key] = row[key];
  return out;
}

test("the compact table agrees with every /dbc/spells row of the dataset, field by field", withDataset, async (t) => {
  const rows = await datasetRows();
  let started = performance.now();
  const bytes = encodeSpellInfoTable(rows.values());
  const encodeMs = performance.now() - started;
  const buffer = bytes.slice().buffer;
  started = performance.now();
  const table = SpellInfoTable.decode(buffer);
  const decodeMs = performance.now() - started;
  assert.ok(table, "decodes");
  assert.equal(table.rows, rows.size);
  let compared = 0;
  for (const full of rows.values()) {
    const compact = table.row(full.id);
    assert.deepEqual({ ...compact }, pick(full), `row ${full.id}`);
    compared++;
  }
  assert.equal(compared, rows.size);
  // Rows looked at on this dataset: 1949 «Адское Пламя» (MSBTMain.lua's SPELL_HELLFIRE), 133 «Огненный шар» rank 1.
  assert.equal(table.row(1949)?.name, rows.get(1949)?.name);
  assert.equal(table.row(133)?.rank, rows.get(133)?.rank);
  assert.equal(table.row(0), undefined);
  assert.equal(table.row(2 ** 31), undefined);
  t.diagnostic(`${rows.size} rows: ${bytes.byteLength} B raw, ${zlib.gzipSync(bytes, { level: 6 }).byteLength} B gzip 6, `
    + `${zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }).byteLength} B br 4; `
    + `encode ${encodeMs.toFixed(0)} ms, decode ${decodeMs.toFixed(2)} ms`);
});

/** Two rows in the shape of the dataset's (1949 and 133, values as /dbc/spells serves them). */
async function smallTable() {
  const rows = withDataset.skip ? undefined : await datasetRows();
  if (rows) return [rows.get(1949), rows.get(133)];
  const base = {
    passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0, manaCostPerLevel: 0, manaPerSecond: 0,
    manaPerSecondPerLevel: 0, schoolMask: 4, spellLevel: 1, baseLevel: 1, maxLevel: 0, spellClassSet: 3,
    spellClassMask: [1, 0, 0], castTime: 0, castTimePerLevel: 0, castTimeMinimum: 0, rangeMin: 0, rangeMax: 30,
    rangeMinFriendly: 0, rangeMaxFriendly: 0, rangeFlags: 0, targets: 0, implicitTargetA: [6, 0, 0], implicitTargetB: [0, 0, 0],
    attributes: [0, 0, 0, 0, 0, 0, 0, 0], effects: [2, 0, 0], effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0],
    effectMiscValueB: [0, 0, 0], equippedItemClass: -1, equippedItemSubclass: 0, startRecoveryTime: 1500,
    startRecoveryCategory: 133, dmgClass: 1,
  };
  return [{ ...base, id: 1949, name: "Адское Пламя", rank: "Уровень 1", iconPath: "Interface\\Icons\\Spell_Fire_Incinerate" },
    { ...base, id: 133, name: "Огненный шар", rank: "Уровень 1", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt", castTime: 1500 }];
}

function fakeResponse() {
  const response = { status: 0, headers: {}, body: undefined };
  response.writeHead = (status, headers = {}) => { response.status = status; response.headers = headers; return response; };
  response.end = (body) => { response.body = body; return response; };
  return response;
}

test("the route: Origin, shape, one encoding per parse, immutable under the metadata generation", async () => {
  const rows = await smallTable();
  let parses = 0;
  const parse = Promise.resolve(new Map(rows.map((row) => [row.id, row])));
  const options = (generation) => ({
    dbcDirectory: "x", allowedOrigins: ["http://127.0.0.1:5173"], metadataGeneration: generation,
    spells: () => { parses++; return parse; },
  });
  const ask = async (query, origin = "http://127.0.0.1:5173", generation = "abc") => {
    const response = fakeResponse();
    const url = new URL(`http://127.0.0.1:8090${SPELL_INFO_TABLE_PATH}${query}`);
    const handled = await serveSpellInfoTable({ method: "GET", headers: { origin } }, response, url, options(generation));
    return { handled, response };
  };
  assert.equal((await ask("?v=1", "http://evil.example")).response.status, 403);
  assert.equal((await ask(`?v=${SPELL_INFO_TABLE_VERSION + 1}`)).response.status, 400);
  const plain = (await ask(`?v=${SPELL_INFO_TABLE_VERSION}`)).response;
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["cache-control"], "public, max-age=0, must-revalidate", "no mg: revalidated (304 by ContentEtag)");
  assert.equal(plain.headers["content-type"], "application/octet-stream");
  const pinned = (await ask(`?v=${SPELL_INFO_TABLE_VERSION}&mg=abc`)).response;
  assert.equal(pinned.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(pinned.body, plain.body, "encoded once for the parse");
  const other = (await ask(`?v=${SPELL_INFO_TABLE_VERSION}&mg=old`)).response;
  assert.equal(other.headers["cache-control"], "public, max-age=0, must-revalidate");
  const table = SpellInfoTable.decode(plain.body.slice().buffer);
  assert.equal(table.row(1949).name, rows[0].name);
  const elsewhere = await serveSpellInfoTable({ method: "GET", headers: {} }, fakeResponse(), new URL("http://h/dbc/spells?ids=1"), options("abc"));
  assert.equal(elsewhere, false, "another path is left to the gateway");
  assert.ok(parses >= 3);
});

test("the client: a 404 (older gateway) is no table, the wait ends at its cap, an answer is the table", async () => {
  const rows = await smallTable();
  const bytes = encodeSpellInfoTable(rows);
  const old = new SpellInfoTableClient("http://127.0.0.1:8090", async () => new Response(null, { status: 404 }));
  assert.equal(await old.ready(1000), false);
  assert.equal(old.state, "absent");
  assert.equal(old.row(1949), undefined);

  let release;
  const slow = new SpellInfoTableClient("http://127.0.0.1:8090", () => new Promise((resolve) => { release = resolve; }));
  const started = performance.now();
  assert.equal(await slow.ready(30), false, "the cap passes, the mount goes on");
  assert.ok(performance.now() - started < 1000);
  assert.equal(slow.state, "loading");
  release(new Response(bytes, { status: 200 }));
  await slow.start();
  assert.equal(slow.state, "ready", "a late table still lands for later calls");
  assert.equal(slow.row(1949).name, rows[0].name);

  const asked = [];
  const good = new SpellInfoTableClient("http://127.0.0.1:8090", async (url) => { asked.push(String(url)); return new Response(bytes); });
  assert.equal(await good.ready(), true);
  assert.equal(await good.ready(), true);
  assert.deepEqual(asked, [`http://127.0.0.1:8090${SPELL_INFO_TABLE_PATH}?v=${SPELL_INFO_TABLE_VERSION}`], "asked once");
});

test("GetSpellInfo(id) and GetSpellLink(id) answer a spell whose full row was never asked for", async () => {
  const rows = await smallTable();
  const table = SpellInfoTable.decode(encodeSpellInfoTable(rows).buffer);
  let compact = (id) => table.row(id);
  const seam = new LiveWorldSeam({
    world: () => undefined, store: () => undefined, spell: () => undefined, spellInfoRow: (id) => compact(id),
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const call = (name, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);
  const hellfire = rows[0];
  // No player: the cost function's 0xffffffff over mana's scale, seven values (0x00540a30; FrameXmlSpellInfo.ts).
  assert.deepEqual(call("GetSpellInfo", 1949), [hellfire.name, hellfire.rank, hellfire.iconPath, -1, false, hellfire.powerType,
    (hellfire.attributes?.[0] ?? 0) & 0x40 ? 0 : hellfire.castTime]);
  assert.deepEqual(call("GetSpellLink", 1949), [`|cff71d5ff|Hspell:1949|h[${hellfire.name}]|h|r`]);
  assert.deepEqual(call("GetSpellInfo", 999999999), [], "an id the dataset has no row for");
  assert.deepEqual(call("GetSpellInfo", "Адское Пламя"), [], "a name still needs a book (0x00540670)");
  // Without the table (an older gateway, or before it lands): nil, as before.
  compact = () => undefined;
  assert.deepEqual(call("GetSpellInfo", 1949), []);
  assert.deepEqual(call("GetSpellLink", 1949), []);
});
