import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

// 05.10-A7b-4 (7.13, 7.01, 7.14 drawing): WMOAreaTable through `/dbc/wmo-areas?v=1`, the core's area and
// outdoors rule (TrinityCore Map.cpp GetAreaId :2694-2728, the outdoors block :2882-2911,
// DBCStores.cpp:725-731 `GetWMOAreaTableEntryByTripple` with its int16/int8 key), the client's room
// names (benilla 1.12.1 reading) and the WMO minimap's geometry. Nothing here talks to a running gateway.
const { WMO_AREAS_VERSION, loadWmoAreas, wmoAreaCatalog } = await import("../dist/code/gateway/WmoAreaMetadata.js");
const { serveCatalogRoute, CATALOG_ROUTES } = await import("../dist/code/gateway/CatalogRoutes.js");
const { loadAreaData } = await import("../dist/code/gateway/AreaMetadata.js");
const { WMO_AREAS_ROUTE_PATH, WMO_AREAS_ROUTE_VERSION, wmoAreaTableFrom, wmoAreaRootKey } = await import("../dist/code/browser/WmoAreaClient.js");
const {
  AREA_FLAG_INSIDE, AREA_FLAG_OUTSIDE, AreaLocator, emptyAreaLocation, indoorZoneTexts, locateArea, wmoFloorWins,
} = await import("../dist/code/browser/AreaLocator.js");
const {
  drawWmoMinimap, wmoMinimapCellAffine, wmoMinimapGroupDrawn, wmoMinimapPictureFrame, wmoModelToWorld, wmoWorldToModel,
  WMO_MINIMAP_PICTURE_READING, WMO_MINIMAP_GROUPS,
} = await import("../dist/code/browser/WmoMinimapDraw.js");
const { inverseTransformCollisionPoint, transformCollisionMesh } = await import("../dist/code/browser/game/Collision.js");
const { frameXmlResolveZone } = await import("../dist/code/browser/framexml/FrameXmlZoneInfo.js");

let dbcDirectory;
try { dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory(); } catch { dbcDirectory = undefined; }
const withDataset = {
  skip: dbcDirectory && existsSync(`${dbcDirectory}/WMOAreaTable.dbc`) ? false : "no dataset DBCs on this machine",
};

/** Synthetic WMOAreaTable rows: [ID, WMOID, NameSetID, WMOGroupID, Flags, AreaTableID, ruRU name]. */
function fixedRows(rows) {
  return {
    records: rows.length,
    int: (row, field) => {
      const [id, wmo, set, group, flags, area] = rows[row];
      return ({ 0: id, 1: wmo, 2: set, 3: group, 9: flags, 10: area })[field] ?? 0;
    },
    float: () => 0,
    // Field 11 + 8 is the ruRU slot (DBC_LOCALES order), 11 enUS.
    string: (row, field) => (field === 19 ? rows[row][6] ?? "" : ""),
  };
}

const TABLE_ROWS = {
  version: 1,
  rows: [
    // The Goldshire inn: only a whole-building row, named, area 0.
    [53, 2, -1, 0, 0, "Таверна"],
    // The abbey: the whole row named like the yard sub-zone, a named hall, an unnamed room.
    [59, 0, -1, 0, 0, "Аббатство"],
    [59, 0, 1934, 24, 0, "Главный зал"],
    [59, 0, 1935, 24, 0, ""],
    // A room forced outdoors and one forced indoors, and a name set over 127 (stored cut to int8).
    [100, 0, 7, 0, 4, ""],
    [100, 0, 8, 0, 2, ""],
    [100, 0, 9, 0, 6, ""],
    [101, -56, 1, 555, 0, ""],
    // An unnamed whole row with an area, and one with nothing but area 0 (the leaf names it).
    [102, 0, -1, 12, 0, ""],
  ],
};

test("route and client agree; the catalog cuts the key as the core does, keeps the last row, drops dead rows", () => {
  assert.equal(WMO_AREAS_ROUTE_VERSION, WMO_AREAS_VERSION);
  assert.equal(WMO_AREAS_ROUTE_PATH, `/dbc/wmo-areas?v=${WMO_AREAS_VERSION}`);
  assert.ok(CATALOG_ROUTES.some((route) => route.pathname === "/dbc/wmo-areas" && route.version === WMO_AREAS_VERSION));
  const catalog = wmoAreaCatalog(fixedRows([
    [1, 70_000, 200, 5, 0, 9, "первая"],
    // Same cut key (70000 → 4464, 200 → -56): the core's `map[key] = entry` keeps the later row.
    [2, 4464, -56, 5, 4, 10, "вторая"],
    [3, 7, 0, 1, 0, 0, ""], // area 0, no 2/4 flag, no name: no row at all
    [4, 7, 0, 2, 1, 0, ""], // flag 1 alone is not read by anything
    [5, 7, 0, 3, 2, 0, ""],
  ]), "ruRU");
  assert.equal(catalog.version, WMO_AREAS_VERSION);
  assert.deepEqual(catalog.rows, [[4464, -56, 5, 10, 4, "вторая"], [7, 0, 3, 0, 2, ""]]);
});

test("the client table: validated shape, lookups by the cut key, the whole-building row", () => {
  const table = wmoAreaTableFrom(TABLE_ROWS);
  assert.ok(table);
  assert.equal(wmoAreaTableFrom({ ...TABLE_ROWS, version: 2 }), undefined);
  assert.equal(wmoAreaTableFrom({ ...TABLE_ROWS, rows: [[1, 2, 3, 4, 5]] }), undefined);
  assert.equal(wmoAreaTableFrom({ ...TABLE_ROWS, rows: [[1, 2, 3, 4, "x", ""]] }), undefined);
  assert.equal(table.lookup(59, 0, 1934)?.name, "Главный зал");
  assert.equal(table.whole(53, 2)?.name, "Таверна");
  assert.equal(table.lookup(53, 2, 0), undefined, "exact key only");
  // A MODF name set of 200 (u16 on the wire) is the row stored under −56; a root id over 65535 wraps too.
  assert.equal(table.lookup(101, 200, 1)?.areaId, 555);
  assert.equal(table.lookup(101 + 65_536, 200 + 256, 1)?.areaId, 555);
  assert.equal(table.lookup(101, 56, 1), undefined, "56 is not −56");
  assert.equal(wmoAreaRootKey(-1, -1), 0xffff * 256 + 0xff);
  assert.equal(wmoAreaRootKey(65_535, 255), wmoAreaRootKey(-1, -1));
});

function input(over = {}) {
  return {
    z: 10, wmo: undefined, gridAreaId: 12, gridHeight: 0, mapAreaTableId: 718,
    table: wmoAreaTableFrom(TABLE_ROWS), areaFlags: () => 0, ...over,
  };
}
const wmo = (over = {}) => ({ floorZ: 10, groupFlags: 0, groupId: 1934, wmoId: 59, nameSet: 0, ...over });

test("locateArea: a room's area beats the grid, the grid beats the map's", () => {
  const out = emptyAreaLocation();
  assert.equal(locateArea(input({ wmo: wmo() }), out).areaId, 24, "the room's AreaTableID");
  assert.equal(out.onWmo, true);
  assert.equal(out.row?.name, "Главный зал");
  assert.equal(locateArea(input({ wmo: wmo({ groupId: 1 }) }), out).areaId, 12, "a room without a row: the grid");
  assert.equal(locateArea(input({ wmo: wmo({ wmoId: undefined, nameSet: undefined }) }), out).areaId, 12, "a v4 tile: the grid");
  assert.equal(locateArea(input({ gridAreaId: 0 }), out).areaId, 718, "no grid area: Map.AreaTableID");
  assert.equal(locateArea(input({ gridAreaId: undefined, mapAreaTableId: undefined }), out).areaId, 0, "an old gateway: nothing");
  assert.equal(locateArea(input({ wmo: wmo({ groupId: 1 }), gridAreaId: 0 }), out).areaId, 718);
});

test("locateArea: the floor counts only where the server takes it over the terrain", () => {
  assert.equal(wmoFloorWins(10, 10, 0), true);
  assert.equal(wmoFloorWins(9.96, 10, 0), true, "within 0.05 under the floor");
  assert.equal(wmoFloorWins(9.9, 10, 0), false);
  assert.equal(wmoFloorWins(30, 10, 20), false, "standing on terrain above a cellar");
  assert.equal(wmoFloorWins(15, 10, 20), true, "under the terrain: inside the hill");
  assert.equal(wmoFloorWins(10, 10, undefined), true, "no terrain at all (a single-WMO map)");
  const out = locateArea(input({ z: 30, gridHeight: 20, wmo: wmo() }), emptyAreaLocation());
  assert.equal(out.onWmo, false);
  assert.equal(out.areaId, 12);
});

test("outdoors: MOGP 0x8, then WMOAreaTable Flags 4 before 2; off a building AreaTable INSIDE/OUTSIDE", () => {
  const out = emptyAreaLocation();
  assert.equal(locateArea(input({ wmo: wmo({ groupFlags: 0x8 }) }), out).outdoors, true, "exterior group, no flags");
  assert.equal(locateArea(input({ wmo: wmo({ groupFlags: 0 }) }), out).outdoors, false, "interior group, no flags");
  assert.equal(locateArea(input({ wmo: wmo({ wmoId: 100, groupId: 7 }) }), out).outdoors, true, "Flags 4 on an interior group");
  assert.equal(locateArea(input({ wmo: wmo({ wmoId: 100, groupId: 8, groupFlags: 0x8 }) }), out).outdoors, false, "Flags 2 on an exterior group");
  assert.equal(locateArea(input({ wmo: wmo({ wmoId: 100, groupId: 9 }) }), out).outdoors, true, "both bits: 4 is read first");
  const flags = (value) => () => value;
  assert.equal(locateArea(input({ areaFlags: flags(AREA_FLAG_INSIDE) }), out).outdoors, false, "a cave flagged INSIDE");
  assert.equal(locateArea(input({ areaFlags: flags(AREA_FLAG_INSIDE | AREA_FLAG_OUTSIDE) }), out).outdoors, true);
  assert.equal(locateArea(input({ areaFlags: flags(AREA_FLAG_OUTSIDE) }), out).outdoors, true);
  assert.equal(locateArea(input({ areaFlags: flags(undefined) }), out).outdoors, true, "an old gateway: open air");
});

test("indoorZoneTexts: the whole-building row takes the zone text, the group's row the sub-zone", () => {
  const table = wmoAreaTableFrom(TABLE_ROWS);
  const name = (id) => ({ 12: "Элвиннский лес", 24: "Аббатство" })[id];
  const run = (keys, zone, sub, leaf) => indoorZoneTexts(table, keys, zone, sub, leaf, name);
  assert.deepEqual(run({ wmoId: 53, nameSet: 2, groupId: 0 }, "Элвиннский лес", "Златоземье", "Златоземье"),
    { zoneText: "Таверна", subZoneText: "" }, "the inn: named unlike the street");
  assert.deepEqual(run({ wmoId: 59, nameSet: 0, groupId: 1934 }, "Элвиннский лес", "Аббатство", "Аббатство"),
    { zoneText: "Элвиннский лес", subZoneText: "Главный зал" }, "the abbey: same name as the yard, the hall names the sub-zone");
  assert.deepEqual(run({ wmoId: 59, nameSet: 0, groupId: 1935 }, "Элвиннский лес", "Аббатство", "Аббатство"),
    { zoneText: "Элвиннский лес", subZoneText: "Аббатство" }, "an unnamed room keeps the sub-zone");
  assert.deepEqual(run({ wmoId: 102, nameSet: 0, groupId: 3 }, "Z", "S", "Leaf"),
    { zoneText: "Элвиннский лес", subZoneText: "" }, "an unnamed whole row: its area's name");
  assert.deepEqual(run({ wmoId: 999, nameSet: 0, groupId: 3 }, "Z", "S", "Leaf"), { zoneText: "Z", subZoneText: "S" }, "no row");
  assert.deepEqual(indoorZoneTexts(undefined, { wmoId: 53, nameSet: 2, groupId: 0 }, "Z", "S", "L", name),
    { zoneText: "Z", subZoneText: "S" }, "no table (an old gateway)");
});

test("frameXmlResolveZone applies the room's names to the stock texts", () => {
  const areas = {
    area: (id) => ({ 12: { id: 12, parentId: 0, name: "Элвиннский лес" }, 87: { id: 87, parentId: 12, name: "Златоземье" } })[id],
    zoneOf: (id) => (id === 87 || id === 12 ? { id: 12, parentId: 0, name: "Элвиннский лес" } : undefined),
    map: () => ({ id: 0, name: "Азерот" }),
  };
  const base = { mapId: 0, zoneId: 12, areaId: 87, terrainAreaId: 87, factionName: () => "" };
  assert.equal(frameXmlResolveZone(areas, base)?.minimapZoneText, "Златоземье");
  const inn = frameXmlResolveZone(areas, { ...base, indoorTexts: () => ({ zoneText: "Таверна", subZoneText: "" }) });
  assert.equal(inn?.zoneText, "Таверна");
  assert.equal(inn?.subZoneText, undefined);
  assert.equal(inn?.minimapZoneText, "Таверна");
});

/** A fake world: one vmap spawn, its visual twin, a counter of floor walks. */
function locatorFixture() {
  const placement = Object.freeze({
    map: 0, key: "0:7", modelName: "Abbey.wmo", canonicalModelName: "abbey.wmo",
    x: 100, y: 200, z: 10, rotationX: 0, rotationY: 30, rotationZ: 0, scale: 1,
  });
  const visual = { kind: "wmo", name: "World\\wmo\\Abbey.wmo", x: 100, y: 200, z: 10, rotationX: 0, rotationY: 30, rotationZ: 0, scale: 1, wmoId: 59, nameSet: 0 };
  const state = { floor: { placement, floorZ: 10, groupIndex: 3, groupId: 1934, groupFlags: 0 }, walks: 0 };
  const sources = {
    objects: [{ ...visual, x: 0 }, visual],
    floor: () => { state.walks++; return state.floor; },
    gridAreaId: () => 12,
    gridHeight: () => 0,
    mapAreaTableId: () => 0,
    areaFlags: () => 0,
    table: () => wmoAreaTableFrom(TABLE_ROWS),
  };
  const table = sources.table();
  sources.table = () => table;
  return { state, sources, visual, placement };
}

test("AreaLocator: matches the visual placement, names the room, and walks the floor only when due", () => {
  const { state, sources, visual } = locatorFixture();
  const locator = new AreaLocator();
  assert.equal(locator.update(0, 0, 100, 200, 10, sources), true);
  assert.equal(locator.location.areaId, 24);
  assert.equal(locator.indoors, true);
  assert.equal(locator.visual === visual, true, "the visual twin, not the other WMO");
  assert.deepEqual({ ...locator.interiorKeys }, { wmoId: 59, nameSet: 0, groupId: 1934 });
  const revision = locator.revision;
  assert.equal(locator.update(100, 0, 100.2, 200, 10, sources), false, "100 ms and 0.2 yd: nothing");
  assert.equal(state.walks, 1);
  assert.equal(locator.update(260, 0, 100.2, 200, 10, sources), true, "250 ms: again");
  assert.equal(state.walks, 2);
  assert.equal(locator.revision, revision, "the same answer does not move the revision");
  assert.equal(locator.update(270, 0, 101, 200, 10, sources), true, "half a yard: again");
  // Not current: the last answer stands.
  state.floor = undefined;
  assert.equal(locator.update(600, 0, 101, 200, 10, sources), false);
  assert.equal(locator.location.areaId, 24);
  assert.equal(locator.indoors, true);
  // Off the building: grid, open air, no room.
  state.floor = null;
  locator.update(900, 0, 101, 200, 10, sources);
  assert.equal(locator.location.areaId, 12);
  assert.equal(locator.indoors, false);
  assert.equal(locator.interiorKeys, undefined);
  assert.equal(locator.floor, undefined);
  assert.ok(locator.revision > revision);
});

test("AreaLocator: an exterior floor is no room; a new map forgets the old answer; not current at first is the grid", () => {
  const { state, sources } = locatorFixture();
  const locator = new AreaLocator();
  state.floor = { ...state.floor, groupFlags: 0x8 };
  locator.update(0, 0, 100, 200, 10, sources);
  assert.equal(locator.interiorKeys, undefined);
  assert.equal(locator.indoors, false);
  assert.ok(locator.floor, "the floor still took part");
  state.floor = undefined;
  locator.update(10, 1, 100, 200, 10, sources);
  assert.equal(locator.map, 1);
  assert.equal(locator.indoors, undefined, "a new map waits for a current answer");
  assert.equal(locator.floor, undefined);
  assert.equal(locator.location.areaId, 12, "the grid half meanwhile");
});

test("WMO minimap: the model transform is the collision mesh's, both ways", () => {
  const placement = { x: 1000, y: -200, z: 50, rotationX: 3, rotationY: 77, rotationZ: -4, scale: 1.25 };
  const world = wmoModelToWorld(placement, 12, -34, 5, { x: 0, y: 0, z: 0 });
  const mesh = transformCollisionMesh(Float32Array.of(12, -34, 5), Uint32Array.of(0), placement);
  assert.ok(Math.abs(world.x - mesh[0]) < 1e-3 && Math.abs(world.y - mesh[1]) < 1e-3 && Math.abs(world.z - mesh[2]) < 1e-3);
  const back = wmoWorldToModel(placement, world.x, world.y, world.z, { x: 0, y: 0, z: 0 });
  const reference = inverseTransformCollisionPoint(world, placement);
  for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(back[axis] - reference[axis]) < 1e-9, axis);
  assert.ok(Math.abs(back.x - 12) < 1e-9 && Math.abs(back.y + 34) < 1e-9 && Math.abs(back.z - 5) < 1e-9);
});

test("WMO minimap: both picture readings are frames of the same 128-yard cell, and they differ", () => {
  assert.equal(WMO_MINIMAP_PICTURE_READING, "north-up", "14.25 has not settled it: the default is recorded");
  assert.equal(WMO_MINIMAP_GROUPS, "floor-group");
  const north = [...wmoMinimapPictureFrame("north-up", 0, 0, new Float64Array(6))];
  const model = [...wmoMinimapPictureFrame("model-xy", 0, 0, new Float64Array(6))];
  assert.deepEqual(north, [128, 128, 0, -128, -128, 0], "top-left (maxX, maxY); right −Y; down −X");
  assert.deepEqual(model, [0, 128, 128, 0, 0, -128], "top-left (minX, maxY); right +X; down −Y");
  // An unturned placement at the origin, the character at the cell's centre, 1 screen pixel a sheet pixel.
  const placement = { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 };
  const box = { minX: -64, minY: -64 };
  const k = 256 / (1600 / 3);
  const affine = (reading) => [...wmoMinimapCellAffine(placement, box, 0, 0, 0, { x: 0, y: 0 }, 1, reading, new Float64Array(6))];
  // vmap's frame negates x and y: model (64, 64) is world (−64, −64) — south-east, bottom-right on the sheet.
  const n = affine("north-up");
  assert.ok(Math.abs(n[4] - 64 * k) < 1e-9 && Math.abs(n[5] - 64 * k) < 1e-9, "north-up origin");
  // Picture right is model −Y, which vmap's negation makes world +Y: west, leftwards on the sheet; picture
  // down is model −X, world +X: north, upwards. The reading only says how the bake lies in model space.
  assert.ok(Math.abs(n[0] + 128 * k) < 1e-9 && Math.abs(n[1]) < 1e-9, "north-up: picture right runs left");
  assert.ok(Math.abs(n[2]) < 1e-9 && Math.abs(n[3] + 128 * k) < 1e-9, "north-up: picture down runs up");
  const m = affine("model-xy");
  assert.ok(Math.abs(m[4] - 64 * k) < 1e-9 && Math.abs(m[5] + 64 * k) < 1e-9, "model-xy origin");
  assert.notDeepEqual(n, m);
});

test("WMO minimap: group choice, and the draw walks only the chosen group's cells", () => {
  const box = { minX: 0, minY: 0, minZ: 0, maxX: 256, maxY: 128, maxZ: 20 };
  assert.equal(wmoMinimapGroupDrawn("floor-group", 2, 2, box, 5), true);
  assert.equal(wmoMinimapGroupDrawn("floor-group", 1, 2, box, 5), false);
  assert.equal(wmoMinimapGroupDrawn("storey", 1, 2, box, 5), true);
  assert.equal(wmoMinimapGroupDrawn("storey", 1, 2, box, 50), false);
  const calls = [];
  const context = {
    save: () => calls.push("save"), restore: () => calls.push("restore"),
    transform: (...values) => calls.push(["transform", ...values.map((value) => Math.round(value * 1000) / 1000)]),
    drawImage: (picture) => calls.push(["draw", picture]),
  };
  const source = {
    placement: { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1 },
    groups: [{ bounds: box }, { bounds: box }],
    floorGroup: 1,
    cells: (index) => (index === 1 ? new Map([["0-0", "a"], ["1-0", "b"], ["bad", "c"]]) : new Map([["0-0", "z"]])),
    picture: (hash) => (hash === "b" ? undefined : `pic-${hash}`),
  };
  assert.equal(drawWmoMinimap(context, source, { x: 0, y: 0, z: 0 }, 1, "north-up", "floor-group"), 1);
  assert.deepEqual(calls.filter((call) => call[0] === "draw").map((call) => call[1]), ["pic-a"],
    "group 0 is not the floor's; a picture still on its way and a malformed cell are skipped");
  calls.length = 0;
  assert.equal(drawWmoMinimap(context, source, { x: 0, y: 0, z: 0 }, 1, "north-up", "storey"), 2);
});

test("dataset: WMOAreaTable rows, the Goldshire inn's whole row, Map.AreaTableID of the single-WMO dungeons", withDataset, async () => {
  const catalog = await loadWmoAreas(dbcDirectory);
  const table = wmoAreaTableFrom(JSON.parse(JSON.stringify(catalog)));
  assert.ok(table);
  assert.equal(catalog.rows.length, 10_112, "22,550 rows less the ones that answer nothing (probe-wmoarea.out.txt)");
  const inn = table.whole(53, 2);
  assert.equal(inn?.areaId, 0);
  assert.match(inn?.name ?? "", /Гордость льва/);
  assert.equal(table.whole(53, 1)?.areaId, 2104);
  const areas = await loadAreaData(dbcDirectory);
  const map = (id) => areas.maps.find((entry) => entry.id === id);
  assert.equal(map(43)?.areaTableId, 718, "Wailing Caverns");
  assert.equal(map(34)?.areaTableId, 717, "the Stockade");
  assert.equal(map(559)?.areaTableId, 0);
  assert.equal(areas.areas.find((area) => area.id === 718)?.mapId, 43);
});

test("the route answers through the catalog table with the Origin and version checks", withDataset, async () => {
  const run = async (path, origin) => {
    const url = new URL(path, "http://127.0.0.1");
    const response = { status: 0, body: "", writeHead(status) { this.status = status; return this; }, end(body = "") { this.body = body; return this; } };
    await serveCatalogRoute({ method: "GET", headers: { origin } }, response, url, new Map(),
      { dbcDirectory, allowedOrigins: ["http://127.0.0.1:5173"] });
    return response;
  };
  const ok = await run(WMO_AREAS_ROUTE_PATH, "http://127.0.0.1:5173");
  assert.equal(ok.status, 200);
  assert.ok(wmoAreaTableFrom(JSON.parse(ok.body)));
  assert.ok(ok.body.length < 320_000, `the answer is ${ok.body.length} bytes`);
  assert.equal((await run("/dbc/wmo-areas?v=9", "http://127.0.0.1:5173")).status, 400);
  assert.equal((await run(WMO_AREAS_ROUTE_PATH, "http://evil.test")).status, 403);
});

// 05.10: ревью A7b-4 — a same-map teleport (hearthstone, a near GM teleport, a flight landing) resets the
// collision; until the tiles around the new point land, the locator used to hold the room it left behind,
// so the minimap, GetZoneText and the zone sound named the old place.
test("05.10 review A7b-4: a far move while the collision is not current answers the grid, not the room left behind", () => {
  const { state, sources } = locatorFixture();
  const locator = new AreaLocator();
  locator.update(0, 0, 100, 200, 10, sources);
  assert.equal(locator.location.areaId, 24);
  state.floor = undefined;
  sources.gridAreaId = () => 1519;
  assert.equal(locator.update(300, 0, 2000, 200, 10, sources), true);
  assert.equal(locator.location.areaId, 1519, "the new place's grid area");
  assert.equal(locator.interiorKeys, undefined, "no room names from the building left behind");
  assert.equal(locator.floor, undefined);
  assert.equal(locator.indoors, undefined, "indoors waits for a current answer");
  // The same along the other axis.
  const north = locatorFixture();
  const jumped = new AreaLocator();
  jumped.update(0, 0, 100, 200, 10, north.sources);
  north.state.floor = undefined;
  north.sources.gridAreaId = () => 1519;
  jumped.update(300, 0, 100, 900, 10, north.sources);
  assert.equal(jumped.location.areaId, 1519);
  // A step inside the same room while a group is still on its way keeps the room.
  const near = locatorFixture();
  const held = new AreaLocator();
  held.update(0, 0, 100, 200, 10, near.sources);
  near.state.floor = undefined;
  assert.equal(held.update(300, 0, 101, 200, 10, near.sources), false);
  assert.equal(held.location.areaId, 24);
  assert.equal(held.indoors, true);
});

test("05.10 review A7b-4: off a building, a sub-zone border crossed while a tile arrives is answered at once", () => {
  const { state, sources } = locatorFixture();
  const locator = new AreaLocator();
  state.floor = null;
  locator.update(0, 0, 100, 200, 10, sources);
  assert.equal(locator.location.areaId, 12);
  assert.equal(locator.indoors, false);
  state.floor = undefined;
  sources.gridAreaId = () => 87;
  locator.update(300, 0, 100.6, 200, 10, sources);
  assert.equal(locator.location.areaId, 87, "the grid's new sub-zone");
  assert.equal(locator.indoors, false, "the grid's answer stands for open ground");
});

test("05.10 review A7b-4: ZONE_CHANGED_INDOORS reads the group's MOGP flag (Wow.exe 0x007A1480), not the server's outdoors", () => {
  const { state, sources, visual } = locatorFixture();
  const locator = new AreaLocator();
  sources.objects = [{ ...visual, wmoId: 100 }];
  state.floor = { ...state.floor, groupId: 7 }; // WMOAreaTable Flags 4 on an interior group
  locator.update(0, 0, 100, 200, 10, sources);
  assert.equal(locator.indoors, false, "the server's outdoors (rain, mounts)");
  assert.equal(locator.wmoInterior, true, "the client's interior group");
  state.floor = { ...state.floor, groupId: 8, groupFlags: 0x8 }; // Flags 2 on an exterior group
  locator.update(300, 0, 100, 200, 10, sources);
  assert.equal(locator.indoors, true);
  assert.equal(locator.wmoInterior, false);
  state.floor = null;
  locator.update(600, 0, 100, 200, 10, sources);
  assert.equal(locator.wmoInterior, false, "no building");
  assert.equal(new AreaLocator().wmoInterior, undefined, "no answer yet");
});

test("05.10 review A7b-4: the locator answers only for the point it follows (a far-sight eye is not the character)", () => {
  const { sources } = locatorFixture();
  const locator = new AreaLocator();
  assert.equal(locator.answersAt(0, 100, 200), false);
  locator.update(0, 0, 100, 200, 10, sources);
  assert.equal(locator.answersAt(0, 100, 200), true);
  assert.equal(locator.answersAt(0, 103, 198), true, "a few yards: the same answer");
  assert.equal(locator.answersAt(0, 400, 200), false, "far away: someone else's place");
  assert.equal(locator.answersAt(1, 100, 200), false, "another map");
  assert.equal(locator.answersAt(undefined, 100, 200), false);
});
