import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Plan item 2.02, the price half: DurabilityCosts/DurabilityQuality through the gateway's catalog
// route (gateway/DurabilityMetadata.ts), the client's arithmetic over them (world/DurabilityCost.ts,
// read off Wow.exe 0x00708540 and 0x00584b20) and the packet (world/RepairProtocol.ts). The worked
// examples are docs/implementation/probes/A3/probe-durability.out.txt's, on this dataset's tables.
const {
  DURABILITY_VERSION, DURABILITY_COSTS_LAYOUT, DURABILITY_QUALITY_LAYOUT, durabilityCatalog, loadDurability,
} = await import("../dist/code/gateway/DurabilityMetadata.js");
const { parseFixed } = await import("../dist/code/gateway/DbcFixed.js");
const { serveCatalogRoute, CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const {
  DurabilityTables, baseRepairCost, itemRepairCost, itemNeedsRepair, repairPriceFactor, roundHalfEven,
} = await import("../dist/code/world/DurabilityCost.js");
const { DURABILITY_ROUTE_VERSION, DURABILITY_ROUTE_PATH, durabilityTablesFrom } =
  await import("../dist/code/browser/DurabilityClient.js");
const { buildRepairItem } = await import("../dist/code/world/RepairProtocol.js");

const PLATE = { itemClass: 4, subClass: 4 };
const SWORD = { itemClass: 2, subClass: 7 };
const CLOTH = { itemClass: 4, subClass: 1 };
const item = (template, lost, max = 100, flags = 0) => ({
  durability: max - lost, maxDurability: max, flags, template,
});

/** A WDBC image of integer rows (and one float column for the quality table). */
function dbc(rows, fields, floatColumns = []) {
  const recordSize = fields * 4;
  const data = Buffer.alloc(20 + rows.length * recordSize + 1);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(fields, 8);
  data.writeUInt32LE(recordSize, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach((row, index) => row.forEach((value, field) => {
    const at = 20 + index * recordSize + field * 4;
    if (floatColumns.includes(field)) data.writeFloatLE(value, at);
    else data.writeInt32LE(value, at);
  }));
  return data;
}

/** Two cost rows (ids 10, 11) and the 16 quality rows of the dataset, synthetic. */
function syntheticTables() {
  const row10 = [10, ...Array.from({ length: 21 }, (_, index) => 100 + index), ...Array.from({ length: 8 }, (_, index) => 200 + index)];
  const row11 = [11, ...Array.from({ length: 29 }, () => 7)];
  const quality = [[1, 1], [2, 0.6], [3, 1], [4, 0.8], [5, 1], [6, 1], [7, 1.2], [8, 1.25], [9, 1.44], [10, 2.5],
    [11, 1.728], [12, 3], [13, 0], [14, 0], [15, 1.2], [16, 1.25]];
  const catalog = durabilityCatalog(
    parseFixed("DurabilityCosts", dbc([row10, row11], 30), DURABILITY_COSTS_LAYOUT),
    parseFixed("DurabilityQuality", dbc(quality, 2, [1]), DURABILITY_QUALITY_LAYOUT),
  );
  return { catalog, tables: new DurabilityTables(catalog) };
}

test("2.02 packet: CMSG_REPAIR_ITEM is u64 merchant, u64 item (0 for all), u8 guild bank", () => {
  assert.deepEqual([...buildRepairItem(0x1234n, 0n, true)],
    [0x34, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...buildRepairItem(0xf130_0000_1a54_0001n, 0x4000_0000_0000_0102n, false)],
    [0x01, 0x00, 0x54, 0x1a, 0x00, 0x00, 0x30, 0xf1, 0x02, 0x01, 0, 0, 0, 0, 0, 0x40, 0]);
});

test("2.02 route and client agree on the shape; a row of the wrong width is refused whole", () => {
  assert.equal(DURABILITY_ROUTE_VERSION, DURABILITY_VERSION);
  assert.equal(DURABILITY_ROUTE_PATH, `/dbc/durability?v=${DURABILITY_VERSION}`);
  assert.ok(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/durability" && route.version === DURABILITY_VERSION));
  const { catalog } = syntheticTables();
  const round = JSON.parse(JSON.stringify(catalog));
  assert.ok(durabilityTablesFrom(round) instanceof DurabilityTables);
  assert.equal(durabilityTablesFrom({ ...round, version: 2 }), undefined);
  assert.equal(durabilityTablesFrom({ ...round, costs: [...round.costs, [12, 1, 2]] }), undefined,
    "a short row would shift the client's read into the next row");
  assert.equal(durabilityTablesFrom({ ...round, quality: [...round.quality, [17, "x"]] }), undefined);
  assert.equal(durabilityTablesFrom(undefined), undefined);
});

test("2.02 the client's arithmetic on synthetic tables: columns, bounds, nothing-cases and the 0 → 1 floor", () => {
  const { tables } = syntheticTables();
  const at = (itemClass, subClass, quality = 1, lost = 1) =>
    baseRepairCost(item({ itemLevel: 10, quality, itemClass, subClass }, lost), tables);
  // Common (quality 1) reads row index 3 (id 4, Data 0.8): 1 × 0.8 × column.
  assert.equal(at(2, 0), Math.trunc(Math.fround(0.8 * 100) + 0.5), "weapon subclass 0 is field 1");
  assert.equal(at(2, 20), Math.trunc(Math.fround(0.8 * 120) + 0.5), "weapon subclass 20 is field 21");
  assert.equal(at(2, 21), Math.trunc(Math.fround(0.8 * 200) + 0.5), "subclass 21 reads the first armour column");
  assert.equal(at(2, 22), 0, "past the client's weapon bound");
  assert.equal(at(4, 7), Math.trunc(Math.fround(0.8 * 207) + 0.5), "armour subclass 7 is field 29");
  assert.equal(at(4, 8), Math.trunc(Math.fround(0.8 * 11) + 0.5), "armour subclass 8 reads the next row's id");
  assert.equal(at(4, 9), 0, "past the client's armour bound");
  assert.equal(at(15, 0), 0, "neither weapon nor armour");
  assert.equal(baseRepairCost(item({ itemLevel: 11, quality: 1, itemClass: 4, subClass: 8 }, 1), tables), 0,
    "subclass 8 of the last row reads past the table: nothing");
  assert.equal(baseRepairCost(item({ itemLevel: 12, quality: 1, ...PLATE }, 1), tables), 0, "no row for the item level");
  assert.equal(baseRepairCost(item(undefined, 5), tables), 0, "no cached template");
  assert.equal(baseRepairCost(item({ itemLevel: 10, quality: 1, ...PLATE }, 0), tables), 0, "not worn");
  assert.equal(baseRepairCost(item({ itemLevel: 10, quality: 1, ...PLATE }, 5, 100, 0x8), tables), 0, "wrapped");
  assert.equal(itemNeedsRepair(item(undefined, 5)), true, "worn even while the price is unknown");
  assert.equal(itemNeedsRepair(item(undefined, 5, 100, 0x8)), false, "a wrapped item is not worn to the client");
  assert.equal(itemNeedsRepair({ durability: 0, maxDurability: 0, flags: 0, template: undefined }), false);
  // Artifact (6) reads row 13, Data 0; weapon subclass 9 of a row with a zero column: both 0 → 1.
  assert.equal(at(2, 0, 6, 40), 1, "artifact: Data 0 still costs 1");
  assert.equal(at(3, 0), 0, "class 3 (gem)");
  // Round half away from zero before the discount: 0.5 → 1, 1.5 → 2, 2.5 → 3 (not ties-to-even).
  assert.equal(baseRepairCost(item({ itemLevel: 11, quality: 0, ...PLATE }, 5), tables), Math.trunc(Math.fround(0.6 * 7 * 5) + 0.5));
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
  assert.equal(roundHalfEven(-0.5), 0);
  assert.equal(roundHalfEven(79562.5), 79562);
  assert.equal(roundHalfEven(71187.5), 71188);
});

test("2.02 the discount factor: 1 − 0.05 · (rank − neutral) as the client's four floats", () => {
  assert.equal(repairPriceFactor(undefined), 1);
  assert.equal(repairPriceFactor(3), 1, "neutral");
  assert.equal(repairPriceFactor(0), 1, "hated pays no more");
  assert.equal(repairPriceFactor(4), Math.fround(1 - Math.fround(0.05)));
  assert.equal(repairPriceFactor(7), Math.fround(1 - Math.fround(0.2)));
});

// ---- this dataset's tables ---------------------------------------------------------------------

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = {
  skip: dbcDirectory && existsSync(`${dbcDirectory}/DurabilityCosts.dbc`) && existsSync(`${dbcDirectory}/DurabilityQuality.dbc`)
    ? false : "no dataset DBCs on this machine",
};

test("this dataset's tables: 300 cost rows, 16 quality rows, and the probe's worked prices", withDataset, async () => {
  const catalog = await loadDurability(dbcDirectory);
  assert.equal(catalog.version, DURABILITY_VERSION);
  assert.equal(catalog.costs.length, 300);
  assert.deepEqual(catalog.quality.map(([id]) => id), Array.from({ length: 16 }, (_, index) => index + 1),
    "ids 1..16 in order: the client's row index quality·2+1 is the core's id (quality+1)·2");
  const tables = durabilityTablesFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(tables);
  const price = (template, lost, rank) => itemRepairCost(item(template, lost, 200), tables, repairPriceFactor(rank));
  const epicPlate = { itemLevel: 200, quality: 4, ...PLATE };
  assert.equal(price(epicPlate, 100), 83_750, "335 × 2.5 × 100");
  assert.equal(price({ itemLevel: 60, quality: 3, ...SWORD }, 50), 3_688, "59 × 1.25 × 50 = 3687.5, half away from zero");
  assert.equal(price({ itemLevel: 1, quality: 1, ...CLOTH }, 1), 1, "1 × 0.8 × 1 rounds to 1");
  assert.equal(price({ itemLevel: 1, quality: 0, ...CLOTH }, 1), 1, "poor cloth: 0.6 → 1");
  assert.equal(price({ itemLevel: 60, quality: 6, ...SWORD }, 50), 1, "artifact: Data 0 → 1");
  assert.equal(price({ itemLevel: 301, quality: 4, ...PLATE }, 50), 0, "no DurabilityCosts row past 300");
  // The discount, rounded ties-to-even by the client; the core truncates, so revered differs by one.
  assert.equal(price(epicPlate, 100, 4), 79_562, "friendly: 79562.5 → 79562");
  assert.equal(price(epicPlate, 100, 5), 75_375, "honored");
  assert.equal(price(epicPlate, 100, 6), 71_188, "revered: 71187.5 → 71188 (the core charges 71187)");
  assert.equal(price(epicPlate, 100, 7), 67_000, "exalted");
});

test("the gateway serves /dbc/durability?v=1 from the dataset directory; a foreign layout is a 500", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durability-route-"));
  const { catalog } = syntheticTables();
  await writeFile(join(directory, "DurabilityCosts.dbc"), dbc(catalog.costs, 30));
  await writeFile(join(directory, "DurabilityQuality.dbc"), dbc(catalog.quality, 2, [1]));
  const origin = "http://127.0.0.1:5173";
  let cache = new Map();
  let dbcDir = directory;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    void serveCatalogRoute(request, response, url, cache, { dbcDirectory: dbcDir, allowedOrigins: [origin] })
      .then((handled) => { if (!handled) response.writeHead(404).end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}${DURABILITY_ROUTE_PATH}`, { headers: { origin } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = await ok.json();
    assert.deepEqual(body, JSON.parse(JSON.stringify(catalog)));
    assert.equal((await fetch(`${base}/dbc/durability?v=2`, { headers: { origin } })).status, 400);
    const broken = await mkdtemp(join(tmpdir(), "durability-route-bad-"));
    await writeFile(join(broken, "DurabilityCosts.dbc"), dbc(catalog.costs.map((row) => row.slice(0, 29)), 29));
    await writeFile(join(broken, "DurabilityQuality.dbc"), dbc(catalog.quality, 2, [1]));
    dbcDir = broken;
    cache = new Map();
    assert.equal((await fetch(`${base}${DURABILITY_ROUTE_PATH}`, { headers: { origin } })).status, 500);
    await rm(broken, { recursive: true, force: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
