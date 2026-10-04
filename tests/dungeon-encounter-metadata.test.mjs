import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Plan item 2.09's boss table (docs/implementation/line-A3.ru.md «2.09», М2): DungeonEncounter.dbc
// served as `/dbc/dungeon-encounters?v=1` (gateway/DungeonEncounterMetadata.ts) and indexed by the
// browser as the original client walks it (browser/DungeonEncounterClient.ts): the rows of a map
// and difficulty in file order, a boss killed by its own Bit in the lock packet's mask (Wow.exe
// 0x00553830, 0x005538b0). Synthetic tables for the route and the client; the dataset's own table
// when it is on this machine. Nothing here talks to the running gateway.
const {
  DUNGEON_ENCOUNTERS_VERSION, DUNGEON_ENCOUNTER_LAYOUT, dungeonEncounterCatalog, loadDungeonEncounters,
} = await import("../dist/code/gateway/DungeonEncounterMetadata.js");
const { parseFixed } = await import("../dist/code/gateway/DbcFixed.js");
const { serveCatalogRoute, CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const {
  DUNGEON_ENCOUNTERS_ROUTE_PATH, DUNGEON_ENCOUNTERS_ROUTE_VERSION, DungeonEncounterClient,
  dungeonEncounterTableFrom, encounterKilled,
} = await import("../dist/code/browser/DungeonEncounterClient.js");

const ORIGIN = "http://127.0.0.1:5173";
const RU = 8;

/**
 * A WDBC image of DungeonEncounter rows `{id, map, difficulty, order, bit, names: {slot: text}}`,
 * `niixissssssssssssssssxx` unless another field count is asked for.
 */
function dbc(rows, fields = 23) {
  const recordSize = fields * 4;
  const strings = [Buffer.from([0])];
  let stringsSize = 1;
  const offsetOf = (text) => {
    const bytes = Buffer.from(`${text}\0`, "utf8");
    const at = stringsSize;
    strings.push(bytes);
    stringsSize += bytes.length;
    return at;
  };
  const records = Buffer.alloc(rows.length * recordSize);
  rows.forEach((row, index) => {
    const at = index * recordSize;
    [row.id, row.map, row.difficulty, row.order, row.bit].forEach((value, field) => {
      if (field < fields) records.writeInt32LE(value, at + field * 4);
    });
    for (const [slot, text] of Object.entries(row.names ?? {})) {
      const field = 5 + Number(slot);
      if (field < fields) records.writeUInt32LE(offsetOf(text), at + field * 4);
    }
  });
  const header = Buffer.alloc(20);
  header.write("WDBC", 0, "latin1");
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt32LE(fields, 8);
  header.writeUInt32LE(recordSize, 12);
  header.writeUInt32LE(stringsSize, 16);
  return Buffer.concat([header, records, ...strings]);
}

// Map 47 as this dataset has it: the file (OrderIndex) order is not the Bit order.
const ROWS = [
  { id: 440, map: 47, difficulty: 0, order: -1000, bit: 2, names: { [RU]: "Третий бит" } },
  { id: 438, map: 47, difficulty: 0, order: 0, bit: 0, names: { [RU]: "Нулевой бит" } },
  { id: 439, map: 47, difficulty: 0, order: 1000, bit: 1, names: { 0: "Bit one", [RU]: "Первый бит" } },
  { id: 900, map: 47, difficulty: 1, order: 0, bit: 0, names: { 0: "Heroic only in enUS" } },
];

test("the catalog: every row in file order, [id, map, difficulty, bit, name]; ruRU, else enUS", () => {
  const rows = parseFixed("DungeonEncounter", dbc(ROWS), DUNGEON_ENCOUNTER_LAYOUT);
  assert.deepEqual(dungeonEncounterCatalog(rows, "ruRU"), {
    version: DUNGEON_ENCOUNTERS_VERSION,
    encounters: [
      [440, 47, 0, 2, "Третий бит"], [438, 47, 0, 0, "Нулевой бит"], [439, 47, 0, 1, "Первый бит"],
      [900, 47, 1, 0, "Heroic only in enUS"],
    ],
  });
  assert.throws(() => parseFixed("DungeonEncounter", dbc(ROWS, 22), DUNGEON_ENCOUNTER_LAYOUT), /DBCfmt\.h/,
    "a layout other than DungeonEncounterfmt is refused, not read at the wrong offsets");
});

test("the browser table: a map's bosses in file order, killed by their own Bit; unknown map is the client's 0/0", () => {
  const table = dungeonEncounterTableFrom(JSON.parse(JSON.stringify(
    dungeonEncounterCatalog(parseFixed("DungeonEncounter", dbc(ROWS), DUNGEON_ENCOUNTER_LAYOUT), "ruRU"))));
  assert.ok(table);
  const bosses = table.encounters(47, 0);
  assert.deepEqual(bosses.map(({ name }) => name), ["Третий бит", "Нулевой бит", "Первый бит"]);
  const mask = 0b100;
  assert.deepEqual(bosses.map(({ bit }) => encounterKilled(mask, bit)), [true, false, false],
    "the first row is killed: its Bit is 2, its row index 0");
  assert.deepEqual(table.encounters(47, 1).map(({ name }) => name), ["Heroic only in enUS"], "difficulty is part of the key");
  assert.deepEqual(table.encounters(999, 0), [], "no rows: 0 bosses, as the client counts them");
  for (const bad of [undefined, null, 1, {}, { version: 2, encounters: [] }, { version: 1 },
    { version: 1, encounters: [[1, 2, 3, 4]] }, { version: 1, encounters: [[1, 2, 3, 4, 5]] },
    { version: 1, encounters: [[1, 2, 3, 1.5, "x"]] }]) {
    assert.equal(dungeonEncounterTableFrom(bad), undefined, JSON.stringify(bad));
  }
});

test("the route: one row in CATALOG_ROUTES at the version the browser asks; 200 no-store, 400 another ?v=, 403 a foreign Origin, 500 a foreign layout", async () => {
  assert.equal(DUNGEON_ENCOUNTERS_ROUTE_VERSION, DUNGEON_ENCOUNTERS_VERSION);
  const route = CATALOG_ROUTES.find(({ pathname }) => pathname === "/dbc/dungeon-encounters");
  assert.ok(route);
  assert.equal(route.version, DUNGEON_ENCOUNTERS_VERSION);
  assert.equal(DUNGEON_ENCOUNTERS_ROUTE_PATH, `/dbc/dungeon-encounters?v=${DUNGEON_ENCOUNTERS_VERSION}`);

  const directory = await mkdtemp(join(tmpdir(), "encounter-route-"));
  await writeFile(join(directory, "DungeonEncounter.dbc"), dbc(ROWS));
  let cache = new Map();
  let dbcDirectory = directory;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    void serveCatalogRoute(request, response, url, cache, { dbcDirectory, allowedOrigins: [ORIGIN] })
      .then((handled) => { if (!handled) response.writeHead(404).end(); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const broken = await mkdtemp(join(tmpdir(), "encounter-route-bad-"));
  try {
    const ok = await fetch(`${base}${DUNGEON_ENCOUNTERS_ROUTE_PATH}`, { headers: { origin: ORIGIN } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const body = await ok.json();
    assert.equal(body.encounters.length, ROWS.length);
    assert.ok(dungeonEncounterTableFrom(body));
    assert.equal((await fetch(`${base}/dbc/dungeon-encounters?v=2`, { headers: { origin: ORIGIN } })).status, 400);
    assert.equal((await fetch(`${base}${DUNGEON_ENCOUNTERS_ROUTE_PATH}`, { headers: { origin: "http://evil.test" } })).status, 403);
    await writeFile(join(broken, "DungeonEncounter.dbc"), dbc(ROWS, 22));
    dbcDirectory = broken;
    cache = new Map();
    assert.equal((await fetch(`${base}${DUNGEON_ENCOUNTERS_ROUTE_PATH}`, { headers: { origin: ORIGIN } })).status, 500);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    await rm(broken, { recursive: true, force: true });
  }
});

/** A fetch answering from `answers` in turn, and a clock whose timers run when told. */
function scripted(answers) {
  const requests = [];
  const timers = [];
  const fetch = async (url) => {
    requests.push(String(url));
    const answer = answers.shift() ?? { status: 404 };
    return {
      ok: answer.status === 200, status: answer.status,
      json: async () => answer.body,
    };
  };
  const clock = {
    setTimeout: (callback, milliseconds) => { timers.push({ callback, milliseconds }); return timers.length; },
    clearTimeout: () => {},
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const fire = async () => { const timer = timers.shift(); timer?.callback(); await flush(); return timer?.milliseconds; };
  return { requests, timers, fetch, clock, flush, fire };
}

const BODY = { version: 1, encounters: [[571, 574, 0, 0, "Принц Келесет"], [573, 574, 0, 1, "Скарвальд и Далронн"]] };

test("the client: undefined until the table lands, one request however often it is read; an older gateway is not asked every frame", async () => {
  const s = scripted([{ status: 404 }, { status: 404 }, { status: 200, body: BODY }]);
  const client = new DungeonEncounterClient(ORIGIN, { fetch: s.fetch, clock: s.clock });
  assert.equal(client.encounters(574, 0), undefined, "nothing invented while the table is on its way");
  assert.equal(client.encounters(574, 0), undefined);
  await s.flush();
  assert.equal(s.requests.length, 1, "read twice, asked once");
  assert.equal(s.requests[0], `${ORIGIN}${DUNGEON_ENCOUNTERS_ROUTE_PATH}`);
  assert.equal(await s.fire(), 15_000, "a 404 is an older gateway: one more try after 15 s");
  assert.equal(client.state, "failed", "the second 404 ends the cycle");
  for (let frame = 0; frame < 5; frame++) assert.equal(client.encounters(574, 0), undefined);
  await s.flush();
  assert.equal(s.requests.length, 2, "a pending lock read every frame does not restart a failed cycle");
  client.retry();
  await s.flush();
  assert.equal(s.requests.length, 3, "the next world mount does");
  assert.deepEqual(client.encounters(574, 0)?.map(({ name }) => name), ["Принц Келесет", "Скарвальд и Далронн"]);
  assert.deepEqual(client.encounters(575, 0), []);
  client.retry();
  await s.flush();
  assert.equal(s.requests.length, 3, "a landed table is not asked again");
});

// ---- this dataset's table ------------------------------------------------------------------------

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = {
  skip: dbcDirectory && existsSync(`${dbcDirectory}/DungeonEncounter.dbc`) ? false : "no dataset DBCs on this machine",
};

test("this dataset's table: 612 rows, 117 groups; Utgarde Keep normal is three bosses at bits 0, 1, 2; mask 0b101 kills two", withDataset, async () => {
  const catalog = await loadDungeonEncounters(dbcDirectory);
  assert.equal(catalog.encounters.length, 612);
  const table = dungeonEncounterTableFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(table);
  const groups = new Set(catalog.encounters.map(([, map, difficulty]) => `${map}/${difficulty}`));
  assert.equal(groups.size, 117);
  for (const group of groups) {
    const [map, difficulty] = group.split("/").map(Number);
    const bits = table.encounters(map, difficulty).map(({ bit }) => bit);
    assert.equal(new Set(bits).size, bits.length, `${group}: Bit unique within the group`);
  }
  const keep = table.encounters(574, 0);
  assert.deepEqual(keep, [
    { bit: 0, name: "Принц Келесет" }, { bit: 1, name: "Скарвальд и Далронн" }, { bit: 2, name: "Ингвар Расхититель" },
  ]);
  assert.equal(keep.filter(({ bit }) => encounterKilled(0b101, bit)).length, 2);
  assert.deepEqual(table.encounters(47, 0).slice(0, 2).map(({ bit }) => bit), [2, 0],
    "Razorfen Kraul: file order, not Bit order — the client numbers the tooltip's rows by it");
  assert.ok(JSON.stringify(catalog).length < 40_000, "one small answer per page");
});
