import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.24 (11.11): which battlegrounds a character may queue for, the holiday mark and the type list's order,
// as Wow.exe 3.3.5a 12340 answers GetBattlegroundInfo (0x0054e010), GetBattlefieldInfo (0x0054d770) and SortBGList
// (0x0054c9f0): canEnter through PvpDifficulty.dbc (0x0054ba00; the random battleground at level 80 exactly),
// isHoliday = the world state named by BattlemasterList.HolidayWorldState is non-zero (0x00548d10), the order
// random → holiday → MinLevel → id (0x0054a650). Dumps: .runtime/re-2026-11-11/pvpui/.
const { pvpDifficultyCatalog, loadPvpDifficulty, PVP_DIFFICULTY_VERSION, PVP_DIFFICULTY_LAYOUT } =
  await import("../dist/code/gateway/PvpDifficultyMetadata.js");
const { parseFixed } = await import("../dist/code/gateway/DbcFixed.js");
const { CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { pvpDifficultyTableFrom, PVP_DIFFICULTY_ROUTE_VERSION } = await import("../dist/code/browser/PvpDifficultyClient.js");
const { frameXmlBattlegroundCanEnter, frameXmlBattlegroundHoliday, frameXmlSortBattlegrounds } =
  await import("../dist/code/browser/framexml/FrameXmlBattlegroundRules.js");
const { FRAMEXML_CANNED_BATTLEGROUNDS } = await import("../dist/code/browser/framexml/FrameXmlBattlegrounds.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

/** A WDBC image of "diiiii" records, no strings. */
function pvpDifficultyImage(rows) {
  const data = Buffer.alloc(20 + rows.length * 24 + 1);
  data.write("WDBC", 0, "latin1");
  data.writeUInt32LE(rows.length, 4);
  data.writeUInt32LE(6, 8);
  data.writeUInt32LE(24, 12);
  data.writeUInt32LE(1, 16);
  rows.forEach((row, index) => row.forEach((value, field) => data.writeInt32LE(value, 20 + index * 24 + field * 4)));
  return data;
}

// Warsong Gulch (489) has a first run 10..29 and a second run later that the scan never reaches.
const ROWS = [
  [1, 489, 0, 10, 19, 0], [2, 489, 1, 20, 29, 0], [3, 30, 0, 51, 60, 0], [4, 30, 1, 61, 80, 1],
  [5, 489, 7, 80, 80, 0], [6, 529, 0, 20, 85, 0],
];
const table = pvpDifficultyTableFrom(pvpDifficultyCatalog(parseFixed("PvpDifficulty", pvpDifficultyImage(ROWS), PVP_DIFFICULTY_LAYOUT)));

test("the route: every record in file order, the client and the gateway agree on ?v=", () => {
  const catalog = pvpDifficultyCatalog(parseFixed("PvpDifficulty", pvpDifficultyImage(ROWS), PVP_DIFFICULTY_LAYOUT));
  assert.deepEqual(catalog.rows[0], [489, 0, 10, 19]);
  assert.equal(catalog.rows.length, 6);
  assert.equal(PVP_DIFFICULTY_VERSION, PVP_DIFFICULTY_ROUTE_VERSION);
  assert.ok(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/pvp-difficulty" && route.version === PVP_DIFFICULTY_VERSION));
  assert.equal(pvpDifficultyTableFrom({ version: 2, rows: [] }), undefined);
  assert.equal(pvpDifficultyTableFrom({ version: 1, rows: [[1, 2, 3]] }), undefined);
});

test("0x0054ba00: the first run of the map's rows, both ends included; a later run is never reached", () => {
  assert.equal(table.bracket(489, 10), 0);
  assert.equal(table.bracket(489, 19), 0);
  assert.equal(table.bracket(489, 20), 1);
  assert.equal(table.bracket(489, 29), 1);
  assert.equal(table.bracket(489, 9), undefined);
  assert.equal(table.bracket(489, 80), undefined, "the scan stops at the first row after the 489 run");
  assert.equal(table.bracket(30, 80), 1);
  assert.equal(table.bracket(607, 80), undefined, "no rows for the map");
});

const row = (id) => FRAMEXML_CANNED_BATTLEGROUNDS.find((candidate) => candidate.bgTypeId === id);

test("canEnter: the random battleground at level 80 only; others by the bracket of MapID[0]", () => {
  for (const [level, expected] of [[79, false], [80, true], [81, false]]) {
    assert.equal(frameXmlBattlegroundCanEnter(row(32), level, table), expected, `random at ${level}`);
  }
  assert.equal(frameXmlBattlegroundCanEnter(row(2), 25, table), true);
  assert.equal(frameXmlBattlegroundCanEnter(row(2), 80, table), false, "BattlemasterList 10..80 does not decide");
  assert.equal(frameXmlBattlegroundCanEnter(row(1), 55, table), true);
  assert.equal(frameXmlBattlegroundCanEnter(row(9), 80, table), false, "a map without brackets");
  assert.equal(frameXmlBattlegroundCanEnter(row(2), 80, undefined), true, "without the table: the BattlemasterList range");
});

test("isHoliday and the sort: random, holiday rows, MinLevel, id", () => {
  const catalog = FRAMEXML_CANNED_BATTLEGROUNDS.map((entry) => ({
    ...entry,
    minLevel: { 1: 51, 2: 10, 3: 20, 7: 61, 9: 71, 30: 71, 32: 10 }[entry.bgTypeId],
    holidayWorldState: entry.bgTypeId === 3 ? 1941 : entry.bgTypeId === 7 ? 2851 : 0,
  }));
  const ab = catalog.find((entry) => entry.bgTypeId === 3);
  assert.equal(frameXmlBattlegroundHoliday(ab, undefined), false);
  assert.equal(frameXmlBattlegroundHoliday(ab, new Map([[1941, 0]])), false);
  assert.equal(frameXmlBattlegroundHoliday(ab, new Map([[1941, 1]])), true);
  assert.deepEqual(frameXmlSortBattlegrounds(catalog, new Map()).map((entry) => entry.bgTypeId), [32, 2, 3, 1, 7, 9, 30]);
  assert.deepEqual(frameXmlSortBattlegrounds(catalog, new Map([[2851, 1]])).map((entry) => entry.bgTypeId), [32, 7, 2, 3, 1, 9, 30]);
});

function api(seam, name, ...args) {
  return [...FRAMEXML_SEAM_BINDINGS[name](seam, args)];
}

test("the live seam: indices over the sorted list, holiday from world states, SortBGList re-sorts and answers true", () => {
  const catalog = FRAMEXML_CANNED_BATTLEGROUNDS.map((entry) => ({
    ...entry,
    minLevel: { 1: 51, 2: 10, 3: 20, 7: 61, 9: 71, 30: 71, 32: 10 }[entry.bgTypeId],
    holidayWorldState: entry.bgTypeId === 3 ? 1941 : 0,
  }));
  const guid = 0x10n;
  const fields = new Map([[UPDATE_FIELDS.UNIT_FIELD_LEVEL.offset, 25]]);
  const requests = [];
  const world = {
    state: { selfGuid: guid, objects: new Map([[guid, { guid, typeId: 4, fields }]]) },
    worldStates: new Map(),
    battlefieldQueues: new Map(),
    requestBattlefieldList(bgTypeId, fromWhere) { requests.push([bgTypeId, fromWhere]); },
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined,
    battlegroundCatalog: () => catalog,
    pvpDifficulty: { table: () => table },
  });
  const list = () => Array.from({ length: api(seam, "GetNumBattlegroundTypes")[0] }, (_, index) => api(seam, "GetBattlegroundInfo", index + 1));
  assert.deepEqual(list().map((info) => [info[4], info[1], info[2]]), [
    [32, false, false], [2, true, false], [3, true, false], [1, false, false],
    [7, false, false], [9, false, false], [30, false, false],
  ]);
  world.worldStates.set(1941, 1);
  assert.deepEqual(api(seam, "GetBattlegroundInfo", 3), [row(3).name, true, true, false, 3],
    "isHoliday is read at once; the order waits for SortBGList");
  assert.deepEqual(api(seam, "SortBGList"), [true]);
  assert.deepEqual(list().map((info) => info[4]), [32, 3, 2, 1, 7, 9, 30]);
  api(seam, "RequestBattlegroundInstanceInfo", 2);
  assert.deepEqual(requests, [[3, 1]], "the index names the sorted list's row");
  assert.deepEqual(api(seam, "GetBattlefieldInfo").slice(2), [5, true, true, false]);
});

test("on the dataset: PvpDifficulty reads with DBCfmt's layout, and Warsong Gulch has a bracket at 80", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const catalog = await loadPvpDifficulty(dbcDirectory);
  assert.ok(catalog.rows.length > 0);
  const live = pvpDifficultyTableFrom(catalog);
  assert.notEqual(live.bracket(489, 80), undefined);
  assert.equal(live.bracket(489, 5), undefined);
});
