import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 11.02-E-review: `GET /dbc/spell-missiles?v=1` — a CatalogRoutes.ts row over gateway/SpellMissileMetadata.ts — and
// the page's SpellMissileClient over it. The contract is world/SpellMissileDbc.ts: `{ version: 1, missiles: [[ID, Flags,
// 13 floats in file order], …], spells: [[spellId, SpellMissileID], …] }`, SpellMissileID being Spell.dbc column 227
// (tools/dbd 3.3.5.12340; DBCStructure.h:1521 names it and the core skips it). The gateway listens on 127.0.0.1 port 0
// over synthetic DBC files; nothing here talks to the running gateway, which answers 404 until the owner restarts it.
const { createGatewayAssetHandler } = await import("../dist/code/gateway/Gateway.js");
const { CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { SPELL_MISSILES_VERSION, SPELL_MISSILE_LAYOUT } = await import("../dist/code/gateway/SpellMissileMetadata.js");
const { SPELL_MISSILE_CATALOG_PATHNAME, SPELL_MISSILE_CATALOG_VERSION, SPELL_MISSILE_COLUMN } = await import("../dist/code/world/SpellMissileDbc.js");
const { SPELL_MISSILE_ROUTE_PATH, forgetSpellMissileClient, spellMissileClient } = await import("../dist/code/browser/SpellMissileClient.js");

const ORIGIN = "http://127.0.0.1:5173";
const ROUTE = "/dbc/spell-missiles";
const SPELL_FIELDS = 234;
const SPELL_MISSILE_ID = 227;

/** A WDBC image of `fields` 4-byte columns; `f` columns are floats, the rest unsigned words; no strings. */
function dbc(rows, { fields, floats = new Set() }) {
  const recordSize = fields * 4;
  const body = Buffer.alloc(rows.length * recordSize);
  rows.forEach((row, index) => {
    for (const [column, value] of row.entries()) {
      if (column >= fields) break;
      const at = index * recordSize + column * 4;
      if (floats.has(column)) body.writeFloatLE(value, at);
      else body.writeUInt32LE(value >>> 0, at);
    }
  });
  const header = Buffer.alloc(20);
  header.write("WDBC", 0, "latin1");
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt32LE(fields, 8);
  header.writeUInt32LE(recordSize, 12);
  header.writeUInt32LE(1, 16);
  return Buffer.concat([header, body, Buffer.from([0])]);
}

const MISSILE_FLOATS = new Set(Array.from({ length: 13 }, (_, index) => index + 2));
const missileFile = (rows, fields = 15) => dbc(rows, { fields, floats: MISSILE_FLOATS });

/** A Spell.dbc row: the id and the SpellMissileID, everything else zero. */
function spell(id, missileId) {
  const row = new Array(SPELL_FIELDS).fill(0);
  row[0] = id;
  row[SPELL_MISSILE_ID] = missileId;
  return row;
}

// Wintergrasp's siege turret: Fire Cannon 57609 → 1023 (pitch −0.2617994…1.0471976, 65 yd/s, gravity 40).
const CANNON_ROW = [1023, 1, -0.2617994, 1.0471976, 65, 65, 0, 0, 0, 0, 0, 0, 40, 0, 0];
const ODD_ROW = [61, 0x8000_0013, 0.6981317, 0.8726646, 30, 40, -0.1, 0.1, 0.2, 0.3, -5, 5, 19.29, 1.15, 4];
const NAN_ROW = [77, 1, Number.NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const SPELLS = [spell(78, 0), spell(57609, 1023), spell(133, 0), spell(44854, 61), spell(66223, 1823), spell(9001, 77)];

async function dataset({ missileFields } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "spell-missiles-route-"));
  await writeFile(join(directory, "SpellMissile.dbc"), missileFile([ODD_ROW, CANNON_ROW, NAN_ROW], missileFields));
  await writeFile(join(directory, "Spell.dbc"), dbc(SPELLS, { fields: SPELL_FIELDS }));
  return directory;
}

async function listen(dbcDirectory) {
  const assets = await createGatewayAssetHandler({
    host: "127.0.0.1", port: 0,
    auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    ...(dbcDirectory ? { dbcDirectory } : {}),
    datasetPollMs: 3_600_000,
  });
  const server = createServer(assets.handle);
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    get: (path, origin = ORIGIN) => fetch(`${base}${path}`, origin ? { headers: { origin } } : {}),
    async close() {
      await new Promise((resolve) => { server.close(resolve); });
      assets.close();
    },
  };
}

test("11.02-E-review: the route is a catalog row at the version the page asks for", () => {
  const route = CATALOG_ROUTES.find((candidate) => candidate.pathname === ROUTE);
  assert.ok(route, "/dbc/spell-missiles is a row of CATALOG_ROUTES");
  assert.equal(route.version, SPELL_MISSILES_VERSION);
  assert.equal(SPELL_MISSILES_VERSION, SPELL_MISSILE_CATALOG_VERSION);
  assert.equal(SPELL_MISSILE_CATALOG_PATHNAME, ROUTE);
  assert.equal(SPELL_MISSILE_ROUTE_PATH, "/dbc/spell-missiles?v=1");
  assert.deepEqual({ ...SPELL_MISSILE_LAYOUT }, { fieldCount: 15, recordSize: 60 });
});

test("11.02-E-review: 403 without the Origin, 400 for another ?v=, 200 JSON never cached — the contract's shape", async () => {
  const directory = await dataset();
  const gateway = await listen(directory);
  try {
    assert.equal((await gateway.get(`${ROUTE}?v=1`, null)).status, 403, "no Origin at all");
    assert.equal((await gateway.get(`${ROUTE}?v=1`, "http://evil.example")).status, 403);
    const wrong = await gateway.get(`${ROUTE}?v=2`);
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal((await gateway.get(ROUTE)).status, 400, "a request that names no shape");

    const response = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body), ["version", "missiles", "spells"]);
    assert.equal(body.version, 1);
    assert.deepEqual(body.missiles.map((row) => row[SPELL_MISSILE_COLUMN.ID]), [61, 1023, 77], "every row, in file order");
    assert.ok(body.missiles.every((row) => row.length === 15));
    const [odd, cannon, nan] = body.missiles;
    assert.equal(odd[SPELL_MISSILE_COLUMN.Flags], 0x8000_0013, "Flags as an unsigned word");
    assert.equal(odd[SPELL_MISSILE_COLUMN.DefaultPitchMin], 0.6981317, "the shortest decimal of the float32");
    assert.ok(!text.includes("0.698131680"), "not the double the float widens to");
    assert.deepEqual(odd.slice(SPELL_MISSILE_COLUMN.RandomizeFacingMin), [-0.1, 0.1, 0.2, 0.3, -5, 5, 19.29, 1.15, 4], "columns 6-14 in order");
    assert.deepEqual(cannon, [1023, 1, -0.2617994, 1.0471976, 65, 65, 0, 0, 0, 0, 0, 0, 40, 0, 0]);
    assert.equal(nan[SPELL_MISSILE_COLUMN.DefaultPitchMin], null, "a float that is not finite travels as null");
    assert.deepEqual(body.spells, [[57609, 1023], [44854, 61], [66223, 1823], [9001, 77]],
      "Spell.dbc column 227 where it is not zero, in file order — an id with no row included");
    const again = await gateway.get(`${ROUTE}?v=1&ids=1,2`);
    assert.equal(await again.text(), text, "memoised; the whole table at once");
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("11.02-E-review: 500 for a table of another layout, and the next request reads the disk again", async () => {
  const directory = await dataset({ missileFields: 14 });
  const gateway = await listen(directory);
  try {
    const broken = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(broken.status, 500, "SpellMissile.dbc of 14 fields");
    assert.equal(broken.headers.get("access-control-allow-origin"), ORIGIN);
    await writeFile(join(directory, "SpellMissile.dbc"), missileFile([CANNON_ROW]));
    await writeFile(join(directory, "Spell.dbc"), dbc(SPELLS, { fields: SPELL_FIELDS - 1 }));
    assert.equal((await gateway.get(`${ROUTE}?v=1`)).status, 500, "Spell.dbc of 233 fields");
    await writeFile(join(directory, "Spell.dbc"), dbc(SPELLS, { fields: SPELL_FIELDS }));
    const fixed = await gateway.get(`${ROUTE}?v=1`);
    assert.equal(fixed.status, 200, "a rejected read is not what the next request is served");
    assert.deepEqual((await fixed.json()).missiles.map((row) => row[0]), [1023]);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("11.02-E-review: a missing table is a 500, not a crash; without a DBC directory the route is not there", async () => {
  const directory = await dataset();
  await rm(join(directory, "SpellMissile.dbc"));
  const gateway = await listen(directory);
  try {
    assert.equal((await gateway.get(`${ROUTE}?v=1`)).status, 500);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
  const bare = await listen(undefined);
  try {
    assert.equal((await bare.get(`${ROUTE}?v=1`)).status, 404);
  } finally {
    await bare.close();
  }
});

test("11.02-E-review: the page's client over the real handler — the trajectory rows by spell, a row with null dropped", async () => {
  const directory = await dataset();
  const gateway = await listen(directory);
  try {
    forgetSpellMissileClient();
    // A browser sends the page's Origin by itself; Node's fetch is told to.
    const client = spellMissileClient(gateway.base, { fetch: (url) => fetch(url, { headers: { origin: ORIGIN } }) });
    await client.load();
    assert.equal(client.state, "ready");
    const catalog = client.catalog;
    assert.equal(catalog.trajectoryMissile(57609)?.gravity, 40);
    assert.equal(catalog.trajectoryMissile(44854)?.maxDuration, 1.15, "the float32's shortest decimal");
    assert.equal(catalog.trajectoryMissile(44854)?.flags, 0x8000_0013);
    assert.equal(catalog.trajectoryMissile(66223), undefined, "an id with no row: cast as before");
    assert.equal(catalog.trajectoryMissile(9001), undefined, "the row with a null float is dropped");
    assert.equal(catalog.trajectoryMissile(78), undefined);
    assert.equal(catalog.size, 2);
  } finally {
    forgetSpellMissileClient();
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("11.02-E-review: a gateway without the route (404) — no tables, no complaint, one retry; a later prime asks again", async () => {
  const bare = await listen(undefined);
  const timers = [];
  const clock = { setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; }, clearTimeout: () => {} };
  let asked = 0;
  try {
    forgetSpellMissileClient();
    const client = spellMissileClient(bare.base, {
      clock, fetch: (url) => { asked++; return fetch(url, { headers: { origin: ORIGIN } }); },
    });
    await client.load();
    assert.equal(client.catalog, undefined);
    assert.deepEqual(timers.map(({ ms }) => ms), [15_000], "one more attempt after 15 s");
    timers.shift().callback();
    await client.load();
    assert.equal(client.state, "failed", "then quiet");
    assert.equal(asked, 2);
    await client.retry();
    assert.equal(asked, 3, "a vehicle bar arriving (prime → retry) asks again");
  } finally {
    forgetSpellMissileClient();
    await bare.close();
  }
});
