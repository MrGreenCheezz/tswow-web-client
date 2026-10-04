import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { AreaClient } from "../dist/code/browser/AreaClient.js";

const encoder = new TextEncoder();

function stringBlock(values) {
  const offsets = new Map();
  const bytes = [0];
  for (const value of values) {
    offsets.set(value, bytes.length);
    bytes.push(...encoder.encode(value), 0);
  }
  return { bytes: Uint8Array.from(bytes), offsets };
}

function dbcFixture(fields, rows, strings) {
  const result = new Uint8Array(20 + rows.length * fields * 4 + strings.byteLength);
  result.set(encoder.encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.byteLength, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) {
      view.setUint32(20 + (row * fields + field) * 4, rows[row][field] ?? 0, true);
    }
  }
  result.set(strings, 20 + rows.length * fields * 4);
  return result;
}

/** A float written into a uint32 slot, which is how every column of a fixture is laid out. */
function f32Bits(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

/** The value a DBC float column returns after its deliberate float32 round-trip. */
function f32(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getFloat32(0, true);
}

/**
 * The eight tables `/dbc/areas` opens. Column positions are the ones the generated layout declares,
 * so a fixture that drifts from the real table fails to open rather than reading the wrong slot.
 */
function areaDbcs() {
  const areaStrings = stringBlock(["Элвиннский лес", "Ривер"]);
  // AreaTable: ID, ContinentID, ParentAreaID, AreaBit, … AmbienceID(7), ZoneMusic(8),
  // IntroSound(9), ExplorationLevel(10), AreaName_lang(11).
  const forest = Array(36).fill(0);
  forest[0] = 12;
  forest[1] = 0;
  forest[2] = 0;
  forest[3] = 126;
  // Elwynn's real `AmbienceID` on this dataset, and deliberately not the same number as its music:
  // the two columns are neighbours, and a fixture that gave them one value would pass whether the
  // gateway read field 7 or field 8.
  forest[7] = 35;
  forest[8] = 3;
  forest[9] = 7;
  forest[10] = 5;
  forest[11] = areaStrings.offsets.get("Элвиннский лес");
  // Flags (4) and FactionGroupMask (28, after the seventeen AreaName_lang slots): Elwynn's real
  // 0x40 and Alliance 2. Neither is the neighbour of the other, nor of anything above.
  forest[4] = 0x40;
  forest[28] = 2;
  const river = Array(36).fill(0);
  river[0] = 87;
  river[1] = 0;
  river[2] = 12;
  river[3] = 200;
  river[11] = areaStrings.offsets.get("Ривер");
  // Goldshire's real flags; its mask is 0 — a sub-area inherits the zone's.
  river[4] = 0x40300040;

  const mapAreaStrings = stringBlock(["Elwynn"]);
  // WorldMapArea: ID, MapID, AreaID, AreaName, LocLeft, LocRight, LocTop, LocBottom, DisplayMapID.
  const elwynn = Array(11).fill(0);
  elwynn[0] = 30;
  elwynn[1] = 0;
  elwynn[2] = 12;
  elwynn[3] = mapAreaStrings.offsets.get("Elwynn");
  elwynn[4] = f32Bits(1535.4166);
  elwynn[5] = f32Bits(-1935.4166);
  elwynn[6] = f32Bits(-7939.583);
  elwynn[7] = f32Bits(-10254.166);
  elwynn[8] = 0xffffffff; // DisplayMapID is -1 on every ground row, not a map id.

  const overlayStrings = stringBlock(["STORMWIND"]);
  // WorldMapOverlay: ID, MapAreaID, AreaID[4] at 2..5, TextureName(8), sizes and offsets.
  const stormwind = Array(17).fill(0);
  stormwind[0] = 121;
  stormwind[1] = 30;
  stormwind[2] = 1519;
  stormwind[6] = 101;
  stormwind[7] = 202;
  stormwind[8] = overlayStrings.offsets.get("STORMWIND");
  stormwind[9] = 485;
  stormwind[10] = 405;
  stormwind[11] = 12;
  stormwind[12] = 34;
  // A row with no picture at all: 102 of the shipped 988 look like this and cannot be drawn.
  const blank = Array(17).fill(0);
  blank[0] = 999;
  blank[1] = 30;

  // DungeonMap: the ground map links a dungeon floor to its WorldMapArea parent.
  const dungeonMap = Array(8).fill(0);
  dungeonMap[0] = 42;
  dungeonMap[1] = 530;
  dungeonMap[2] = 1;
  dungeonMap[3] = f32Bits(-50);
  dungeonMap[4] = f32Bits(50);
  dungeonMap[5] = f32Bits(-30);
  dungeonMap[6] = f32Bits(30);
  dungeonMap[7] = 30;

  const poiStrings = stringBlock(["Застава", "Описание заставы"]);
  const poi = Array(54).fill(0);
  poi[0] = 700;
  poi[1] = 3;
  poi[2] = 7;
  poi[10] = 9;
  poi[11] = 35;
  poi[12] = f32Bits(100.25);
  poi[13] = f32Bits(-200.5);
  poi[14] = f32Bits(5);
  poi[15] = 0;
  poi[16] = 2;
  poi[17] = 12;
  poi[18] = poiStrings.offsets.get("Застава");
  poi[35] = poiStrings.offsets.get("Описание заставы");
  poi[52] = 2473;
  poi[53] = 30;

  const continent = Array(14).fill(0);
  continent[0] = 1;
  continent[1] = 0;
  continent[2] = 10;
  continent[3] = 20;
  continent[4] = 30;
  continent[5] = 40;
  continent[6] = f32Bits(1.5);
  continent[7] = f32Bits(2.5);
  continent[8] = f32Bits(0.5);
  continent[13] = 1;

  // WorldMapTransforms: map 530's northern island is presented on map 0 after this translation.
  const transform = Array(10).fill(0);
  transform[0] = 2;
  transform[1] = 530;
  transform[2] = f32Bits(4800);
  transform[3] = f32Bits(-10133.333);
  transform[4] = f32Bits(16000);
  transform[5] = f32Bits(-2666.666);
  transform[6] = 0;
  transform[7] = f32Bits(-2400);
  transform[8] = f32Bits(2400);

  const mapStrings = stringBlock(["Azeroth", "Восточные королевства"]);
  const azeroth = Array(66).fill(0);
  azeroth[0] = 0;
  azeroth[1] = mapStrings.offsets.get("Azeroth");
  // `InstanceType`, and deliberately not the 0 the row would hold anyway: it is the column
  // `IsInInstance()` reads, and a fixture that left it at the default would pass whether the
  // gateway carried the column or dropped it.
  azeroth[2] = 2;
  azeroth[5] = mapStrings.offsets.get("Восточные королевства");

  return {
    AreaTable: dbcFixture(36, [forest, river], areaStrings.bytes),
    WorldMapArea: dbcFixture(11, [elwynn], mapAreaStrings.bytes),
    WorldMapOverlay: dbcFixture(17, [stormwind, blank], overlayStrings.bytes),
    DungeonMap: dbcFixture(8, [dungeonMap], Uint8Array.of(0)),
    AreaPOI: dbcFixture(54, [poi], poiStrings.bytes),
    WorldMapContinent: dbcFixture(14, [continent], Uint8Array.of(0)),
    WorldMapTransforms: dbcFixture(10, [transform], Uint8Array.of(0)),
    Map: dbcFixture(66, [azeroth], mapStrings.bytes),
  };
}

async function withAreaGateway(run) {
  const dbcDirectory = await mkdtemp(join(tmpdir(), "webclient-areas-"));
  for (const [table, bytes] of Object.entries(areaDbcs())) {
    await writeFile(join(dbcDirectory, `${table}.dbc`), bytes);
  }
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    dbcDirectory,
  });
  try {
    await run(gateway);
  } finally {
    await gateway.close();
    await rm(dbcDirectory, { recursive: true, force: true });
  }
}

test("the areas endpoint serves all eight authored map tables", async () => {
  await withAreaGateway(async (gateway) => {
    const url = `http://127.0.0.1:${gateway.port}/dbc/areas`;
    // The origin gate applies here as everywhere: a request without one is refused outright.
    const refused = await fetch(url);
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();

    const response = await fetch(url, { headers: { origin: "http://localhost:5173" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const data = await response.json();

    // AreaTable has no MapID: the map an area belongs to is called ContinentID.
    assert.deepEqual(data.areas[0], {
      id: 12, parentId: 0, mapId: 0, areaBit: 126, explorationLevel: 5, name: "Элвиннский лес",
      zoneMusic: 3, ambienceId: 35, introSound: 7, flags: 0x40, factionGroupMask: 2,
    });
    // Route version 8: `GetZonePVPInfo` reads both columns (FrameXmlZoneInfo.ts).
    assert.deepEqual([data.areas[1].flags, data.areas[1].factionGroupMask], [0x40300040, 0]);
    assert.equal(data.areas[1].parentId, 12, "a sub-area names the zone it sits in");
    // A sub-area usually names no music of its own and inherits the zone's; carrying the zero is
    // what lets `zoneMusicOf` know to look upwards rather than fall silent in a tavern.
    assert.equal(data.areas[1].zoneMusic, 0);
    // And the same for the wind, which is a different column and a different channel: 445 of the
    // 2,307 rows carry an `AmbienceID`, so inheriting it is the usual case.
    assert.equal(data.areas[1].ambienceId, 0);

    // The rectangle is in WoW's axes: top and bottom bound X, left and right bound Y, and both
    // pairs run backwards. DisplayMapID is -1 rather than a map id, so truthiness is the wrong test.
    const [mapArea] = data.mapAreas;
    assert.equal(mapArea.name, "Elwynn", "AreaName is a plain string and the texture directory");
    assert.ok(mapArea.left > mapArea.right && mapArea.top > mapArea.bottom);
    assert.equal(mapArea.displayMapId, -1);

    // An overlay with no texture cannot be drawn and is left out; the rest keep their area list.
    assert.equal(data.overlays.length, 1);
    assert.deepEqual(data.overlays[0], {
      id: 121, mapAreaId: 30, areaIds: [1519], textureName: "STORMWIND",
      width: 485, height: 405, offsetX: 12, offsetY: 34, mapPointX: 101, mapPointY: 202,
    });

    assert.deepEqual(Object.keys(data).sort(), [
      "areaPois", "areas", "continents", "dungeonMaps", "mapAreas", "maps", "overlays", "transforms",
    ]);
    assert.deepEqual(data.dungeonMaps, [{
      id: 42, mapId: 530, floorIndex: 1,
      minX: -50, maxX: 50, minY: -30, maxY: 30, parentWorldMapId: 30,
    }]);
    assert.deepEqual(data.areaPois, [{
      id: 700, importance: 3, icons: [7, 0, 0, 0, 0, 0, 0, 0, 9], factionId: 35,
      x: 100.25, y: -200.5, mapId: 0, flags: 2, areaId: 12,
      name: "Застава", description: "Описание заставы", worldStateId: 2473, worldMapLink: 30,
    }]);

    assert.equal(data.continents[0].scale, 0.5);
    assert.equal(data.continents[0].worldMapId, 1,
      "WorldMapID is the parent edge from a continent to the global World/Cosmic level");
    assert.deepEqual(data.transforms[0], {
      id: 2, mapId: 530,
      regionBottom: 4800, regionRight: f32(-10133.333),
      regionTop: 16000, regionLeft: f32(-2666.666),
      newMapId: 0, offsetX: -2400, offsetY: 2400, newDungeonMapId: 0,
    });
    // `instanceType` is carried because nothing on the wire ever says «you are in an instance», and
    // a module window's `inInstance` condition is exactly that question.
    assert.deepEqual(data.maps[0], {
      id: 0, directory: "Azeroth", name: "Восточные королевства", instanceType: 2,
    });
  });
});

test("the area client indexes what a map needs to ask", async () => {
  // Against a stubbed fetch rather than the gateway: the gateway refuses a request with no
  // `Origin` header, and Node's fetch does not send one — only a browser does. What is worth
  // testing here is the indexing, and the route above already proves the payload.
  const payload = {
    areas: [
      { id: 12, parentId: 0, mapId: 0, areaBit: 126, explorationLevel: 5, name: "Элвиннский лес", zoneMusic: 3, introSound: 7 },
      { id: 87, parentId: 12, mapId: 0, areaBit: 200, explorationLevel: 0, name: "Ривер", zoneMusic: 0, introSound: 0 },
      { id: 5000, parentId: 0, mapId: 0, areaBit: 0, explorationLevel: 0, name: "Без бита", zoneMusic: 0, introSound: 0 },
    ],
    mapAreas: [{
      id: 30, mapId: 0, areaId: 12, name: "Elwynn",
      left: 1535.4166, right: -1935.4166, top: -7939.583, bottom: -10254.166,
      displayMapId: -1, defaultDungeonFloor: 0, parentWorldMapId: 0,
    }, {
      id: 14, mapId: 0, areaId: 0, name: "Azeroth",
      left: 18171.97, right: -22569.21, top: 11176.34, bottom: -15973.34,
      displayMapId: -1, defaultDungeonFloor: 0, parentWorldMapId: 0,
    }],
    overlays: [{ id: 121, mapAreaId: 30, areaIds: [1519], textureName: "STORMWIND", width: 485, height: 405, offsetX: 12, offsetY: 34 }],
    continents: [{
      id: 1, mapId: 0, left: 10, right: 20, top: 30, bottom: 40,
      offsetX: 1.5, offsetY: 2.5, scale: 0.5, worldMapId: 1,
    }],
    transforms: [{
      id: 2, mapId: 530,
      regionBottom: 4800, regionRight: -10133.333, regionTop: 16000, regionLeft: -2666.666,
      newMapId: 0, offsetX: -2400, offsetY: 2400, newDungeonMapId: 0,
    }],
    maps: [{ id: 0, directory: "Azeroth", name: "Восточные королевства" }],
  };
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    // The `v` is this route's cache-buster: the reply is held for an hour, so a field added to
    // `AreaInfo` would otherwise be missing for an hour after the gateway learned to send it.
    // Version 8 carries AreaTable.Flags and FactionGroupMask for GetZonePVPInfo.
    assert.match(String(url), /\/dbc\/areas\?v=8$/);
    return { ok: true, status: 200, json: async () => payload };
  };
  try {
    const client = new AreaClient("ws://127.0.0.1:8090/auth");
    const loaded = new Promise((resolve) => { client.onLoaded = resolve; });
    client.load();
    client.load(); // Idempotent: the second call must not start a second fetch.
    await loaded;
    assert.equal(client.ready, true);
    assert.equal(requests, 1);

    // A sub-area answers with the zone above it, and a zone answers with itself.
    assert.equal(client.zoneOf(87)?.id, 12);
    assert.equal(client.zoneOf(12)?.id, 12);
    assert.equal(client.zoneOf(4242), undefined);

    // The exploration bit is a reverse index, and zero is never a key: it means "no bit", and
    // indexing the mask with it would mark every unbitted area explored at once.
    assert.equal(client.areaOfBit(126)?.id, 12);
    assert.equal(client.areaOfBit(200)?.id, 87);
    assert.equal(client.areaOfBit(0), undefined);

    // A sub-area with no rectangle of its own is drawn on its zone's.
    assert.equal(client.mapAreaOfArea(87)?.id, 30);
    assert.equal(client.mapAreaOfArea(12)?.id, 30);
    assert.equal(client.overlaysOf(30).length, 1);
    assert.equal(client.mapAreasOf(0).length, 2);
    assert.equal(client.continentOf(0)?.scale, 0.5);
    assert.equal(client.map(0)?.directory, "Azeroth");
    assert.equal(client.worldMapHierarchy()?.parent(client.worldMapHierarchy().node("area:14"))?.key,
      "cosmic");
    // The continent-wide row is the one whose areaId is zero, not the first in the list.
    assert.equal(client.continentMapArea(0)?.name, "Azeroth");
  } finally {
    globalThis.fetch = original;
  }
});

test("the minimap index is served from disk and generated at most once when it is missing", async () => {
  const minimapDirectory = await mkdtemp(join(tmpdir(), "webclient-minimap-"));
  let generated = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    minimapDirectory,
    generateMinimapIndex: async (map) => {
      generated++;
      await writeFile(join(minimapDirectory, `${map}.json`), JSON.stringify({
        map, directory: "Azeroth", tiles: { "49-31": "e63e31460d03784c923ddf09b8040232" },
      }));
    },
  });
  try {
    const headers = { origin: "http://localhost:5173" };
    const url = `http://127.0.0.1:${gateway.port}/minimap/0/index.json`;
    const refused = await fetch(url);
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();

    // Two callers arriving together are one generation, not two: the lane holds the second.
    const [first, second] = await Promise.all([fetch(url, { headers }), fetch(url, { headers })]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(generated, 1);
    const index = await first.json();
    await second.arrayBuffer();
    // The cell key is the repository's own <gridX>-<gridY>, whichever order the BLP was named in.
    assert.equal(index.tiles["49-31"], "e63e31460d03784c923ddf09b8040232");

    // Already on disk: served without touching the generator again.
    const cached = await fetch(url, { headers });
    assert.equal(cached.status, 200);
    await cached.arrayBuffer();
    assert.equal(generated, 1);
  } finally {
    await gateway.close();
    await rm(minimapDirectory, { recursive: true, force: true });
  }
});

test("a map with no minimap at all answers 404 rather than hanging", async () => {
  const minimapDirectory = await mkdtemp(join(tmpdir(), "webclient-minimap-empty-"));
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    minimapDirectory,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/minimap/9999/index.json`, {
      headers: { origin: "http://localhost:5173" },
    });
    assert.equal(response.status, 404);
    // Error responses still carry the header, or the browser reports every failure as CORS.
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    await response.arrayBuffer();
  } finally {
    await gateway.close();
    await rm(minimapDirectory, { recursive: true, force: true });
  }
});
