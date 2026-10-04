import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AreaClient } from "../dist/code/browser/AreaClient.js";
import {
  WORLD_MAP_ZONE_MAP_BYTES,
  WorldMapZoneMapClient,
  decodeWorldMapZoneMap,
  worldMapZoneCellCenter,
} from "../dist/code/browser/WorldMapZoneMap.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { openClientArchives } from "../tools/mpq.mjs";

let clientDirectory;
try {
  ({ clientDirectory } = await import("../tools/paths.mjs"));
  clientDirectory = clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no configured 3.3.5a client" };

function zoneFixture(entries) {
  const bytes = new Uint8Array(WORLD_MAP_ZONE_MAP_BYTES);
  const view = new DataView(bytes.buffer);
  for (const [row, column, areaId] of entries) {
    view.setUint32((row * 128 + column) * 4, areaId, true);
  }
  return bytes;
}

const AZEROTH = {
  id: 14,
  mapId: 0,
  areaId: 0,
  name: "Azeroth",
  left: 18171.970703125,
  right: -22569.2109375,
  top: 11176.34375,
  bottom: -15973.34375,
  displayMapId: -1,
  defaultDungeonFloor: 0,
  parentWorldMapId: 0,
};

test("a ZMP is exactly a 128x128 little-endian AreaTable grid", () => {
  const authored = zoneFixture([[52, 62, 168]]);
  const grid = decodeWorldMapZoneMap(authored.buffer);
  const point = worldMapZoneCellCenter(AZEROTH, 52, 62);
  assert.equal(grid.areaIdAt(AZEROTH, point.u, point.v), 168);

  // A zero is authored ocean/empty space, not an absent mask and not permission to guess from a
  // WorldMapArea rectangle that happens to overlap the point.
  const ocean = worldMapZoneCellCenter(AZEROTH, 0, 0);
  assert.equal(grid.areaIdAt(AZEROTH, ocean.u, ocean.v), 0);
  assert.throws(() => decodeWorldMapZoneMap(new ArrayBuffer(WORLD_MAP_ZONE_MAP_BYTES - 4)),
    /65536 bytes/);
});

test("authored ZMP wins a real overlapping-zone ambiguity and walks a sub-area to its map", async () => {
  // Stock Azeroth row 52, column 62 carries AreaTable 168 (North Coast), whose parent is
  // Tirisfal 85. Its world-cell centre is inside both authored WorldMapArea rectangles below;
  // bbox-smallest picks Western Plaguelands, while the original client's ZMP picks Tirisfal.
  const tirisfal = {
    id: 20, mapId: 0, areaId: 85, name: "Tirisfal",
    left: 3033.333251953125, right: -1485.4166259765625,
    top: 3837.499755859375, bottom: 824.9999389648438,
    displayMapId: -1, defaultDungeonFloor: 0, parentWorldMapId: 0,
  };
  const westernPlaguelands = {
    id: 22, mapId: 0, areaId: 28, name: "WesternPlaguelands",
    left: 416.6666564941406, right: -3883.333251953125,
    top: 3366.66650390625, bottom: 499.9999694824219,
    displayMapId: -1, defaultDungeonFloor: 0, parentWorldMapId: 0,
  };
  const eversong = {
    id: 462, mapId: 530, areaId: 3430, name: "EversongWoods",
    left: -4487, right: -9412, top: 11041, bottom: 7758,
    displayMapId: 0, defaultDungeonFloor: 0, parentWorldMapId: 0,
  };
  const payload = {
    areas: [
      { id: 168, parentId: 85, mapId: 0, areaBit: 245, explorationLevel: 0,
        name: "Северное побережье", zoneMusic: 0, ambienceId: 0, introSound: 0 },
      { id: 85, parentId: 0, mapId: 0, areaBit: 18, explorationLevel: 1,
        name: "Тирисфальские леса", zoneMusic: 0, ambienceId: 0, introSound: 0 },
      { id: 28, parentId: 0, mapId: 0, areaBit: 12, explorationLevel: 1,
        name: "Западные Чумные земли", zoneMusic: 0, ambienceId: 0, introSound: 0 },
      { id: 3430, parentId: 0, mapId: 530, areaBit: 0, explorationLevel: 1,
        name: "Леса Вечной Песни", zoneMusic: 0, ambienceId: 0, introSound: 0 },
    ],
    mapAreas: [AZEROTH, tirisfal, westernPlaguelands, eversong],
    overlays: [],
    continents: [{
      id: 1, mapId: 0, left: 3, right: 54, top: 7, bottom: 42,
      offsetX: 0, offsetY: 0, scale: 0.75, worldMapId: 1,
    }],
    transforms: [],
    maps: [
      { id: 0, directory: "Azeroth", name: "Восточные королевства", instanceType: 0 },
      { id: 530, directory: "Expansion01", name: "Запределье", instanceType: 0 },
    ],
  };
  const authored = zoneFixture([[52, 62, 168], [53, 62, 3430]]);
  const point = worldMapZoneCellCenter(AZEROTH, 52, 62);
  const worldX = AZEROTH.top - point.v * (AZEROTH.top - AZEROTH.bottom);
  const worldY = AZEROTH.left - point.u * (AZEROTH.left - AZEROTH.right);
  const contains = (area) => worldX <= Math.max(area.top, area.bottom)
    && worldX >= Math.min(area.top, area.bottom)
    && worldY <= Math.max(area.left, area.right)
    && worldY >= Math.min(area.left, area.right);
  assert.equal(contains(tirisfal), true);
  assert.equal(contains(westernPlaguelands), true);
  const size = (area) => Math.abs((area.left - area.right) * (area.top - area.bottom));
  assert.ok(size(westernPlaguelands) < size(tirisfal), "bbox-smallest would choose the wrong zone");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/dbc/areas")) {
      return { ok: true, status: 200, json: async () => payload };
    }
    if (String(url).endsWith("/world-map/0/zones.bin")) {
      return { ok: true, status: 200, arrayBuffer: async () => authored.buffer.slice(0) };
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  };
  try {
    const areas = new AreaClient("ws://127.0.0.1:8090/auth");
    const loaded = new Promise((resolve) => { areas.onLoaded = resolve; });
    areas.load();
    await loaded;

    assert.deepEqual(areas.worldMapAreaAt(AZEROTH, point.u, point.v), { status: "loading" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(areas.worldMapAreaAt(AZEROTH, point.u, point.v), {
      status: "ready", areaId: 168, mapArea: tirisfal,
    });

    const eversongPoint = worldMapZoneCellCenter(AZEROTH, 53, 62);
    assert.deepEqual(areas.worldMapAreaAt(AZEROTH, eversongPoint.u, eversongPoint.v), {
      status: "ready", areaId: 3430, mapArea: eversong,
    }, "DisplayMapID zones in the continent ZMP remain clickable on that display continent");

    const ocean = worldMapZoneCellCenter(AZEROTH, 0, 0);
    assert.deepEqual(areas.worldMapAreaAt(AZEROTH, ocean.u, ocean.v), {
      status: "ready", areaId: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing zone-map metadata is explicitly unavailable so the caller may use bbox fallback", async () => {
  const payload = { areas: [], mapAreas: [AZEROTH], overlays: [], continents: [], transforms: [], maps: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/dbc/areas")
    ? { ok: true, status: 200, json: async () => payload }
    : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  try {
    const areas = new AreaClient("ws://127.0.0.1:8090/auth");
    const loaded = new Promise((resolve) => { areas.onLoaded = resolve; });
    areas.load();
    await loaded;
    assert.deepEqual(areas.worldMapAreaAt(AZEROTH, 0.5, 0.5), { status: "loading" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(areas.worldMapAreaAt(AZEROTH, 0.5, 0.5), { status: "unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transient gateway failures stay non-clickable and retry instead of enabling bbox fallback", async () => {
  const authored = zoneFixture([[52, 62, 168]]);
  const point = worldMapZoneCellCenter(AZEROTH, 52, 62);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? { ok: false, status: 500 }
    : { ok: true, status: 200, arrayBuffer: async () => authored.buffer.slice(0) };
  const client = new WorldMapZoneMapClient("ws://127.0.0.1:8090/auth", 1);
  const statuses = [];
  client.onStatus = (message, error) => statuses.push({ message, error });
  try {
    assert.deepEqual(client.hit(0, AZEROTH, point.u, point.v), { status: "loading" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(client.hit(0, AZEROTH, point.u, point.v), { status: "loading" },
      "HTTP 500 must not become unavailable/bbox permission");
    for (let attempt = 0; attempt < 20 && calls < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(calls, 2, "the bounded retry runs after the transient failure");
    assert.deepEqual(client.hit(0, AZEROTH, point.u, point.v), { status: "ready", areaId: 168 });
    assert.deepEqual(statuses.map(({ error }) => error), [true, false],
      "a successful retry clears the transient error status");
  } finally {
    client.clear();
    globalThis.fetch = originalFetch;
  }
});

test("the narrow zone-map route serves exact bytes and collapses concurrent generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-world-map-zmp-"));
  const authored = zoneFixture([[52, 62, 168]]);
  await writeFile(join(directory, "0.bin"), authored.subarray(0, 64));
  let generated = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    worldMapZoneMapsDirectory: directory,
    generateWorldMapZoneMap: async (map) => {
      generated++;
      await writeFile(join(directory, `${map}.bin`), authored);
    },
  });
  try {
    const url = `http://127.0.0.1:${gateway.port}/world-map/0/zones.bin`;
    const refused = await fetch(url);
    assert.equal(refused.status, 403);
    await refused.arrayBuffer();
    const headers = { origin: "http://localhost:5173" };
    const [first, second] = await Promise.all([fetch(url, { headers }), fetch(url, { headers })]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(generated, 1, "one generation repairs a truncated cache for both requests");
    assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const etag = first.headers.get("etag");
    assert.match(etag ?? "", /^"e1-[0-9a-f]+-[0-9a-f]+(-[0-9a-f]+)?"$/);
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), authored);
    await second.arrayBuffer();

    const unchanged = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
    assert.equal(unchanged.status, 304);
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unstamped full-size zone map is regenerated before the active patch may serve it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-world-map-legacy-"));
  const dbc = await mkdtemp(join(tmpdir(), "webclient-world-map-dbc-"));
  const stale = zoneFixture([[52, 62, 7]]);
  const active = zoneFixture([[52, 62, 168]]);
  const destination = join(directory, "0.bin");
  await writeFile(destination, stale);
  let generated = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    dbcDirectory: dbc,
    worldMapZoneMapsDirectory: directory,
    generateWorldMapZoneMap: async () => {
      generated++;
      await writeFile(destination, active);
      await writeFile(`${destination}.src`, JSON.stringify({ chain: "test", sources: [], files: [] }));
    },
  });
  const url = `http://127.0.0.1:${gateway.port}/world-map/0/zones.bin`;
  const headers = { origin: "http://localhost:5173" };
  try {
    const first = await fetch(url, { headers });
    assert.equal(first.status, 200);
    assert.equal(generated, 1, "a correctly-sized legacy file still lacks patch provenance");
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), active);

    const etag = first.headers.get("etag");
    const unchanged = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(generated, 1);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
    await rm(dbc, { recursive: true, force: true });
  }
});

test("the active client's four authored continent ZMPs parse at measured stock cells", withClient, async () => {
  const archives = await openClientArchives(clientDirectory);
  try {
    const expected = [
      ["Azeroth", 52, 62, 168],
      ["Kalimdor", 48, 58, 414],
      ["Expansion01", 47, 50, 3721],
      ["Northrend", 43, 48, 4283],
    ];
    for (const [name, row, column, areaId] of expected) {
      const bytes = await archives.read(`Interface\\WorldMap\\${name}.zmp`);
      assert.equal(bytes?.byteLength, WORLD_MAP_ZONE_MAP_BYTES, `${name}.zmp size`);
      const grid = decodeWorldMapZoneMap(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      assert.equal(grid.areaId(row, column), areaId, `${name}.zmp ${row},${column}`);
    }
  } finally {
    archives.close();
  }
});
