import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_RANGE,
  ENVIRONMENT_TILE_CACHE_LIMIT,
  TERRAIN_GRID_SIZE,
  EnvironmentClient,
  TerrainClient,
  TerrainTile,
  terrainGrid,
  terrainGridDependencyFootprint,
  terrainGridFootprint,
} from "../dist/code/browser/Terrain.js";
import * as TerrainModule from "../dist/code/browser/Terrain.js";
import { TerrainSplatClient } from "../dist/code/browser/TerrainSplat.js";
import { IMAGE_RETRY_BACKOFF_MS } from "../dist/code/browser/CharacterAtlas.js";
import * as THREE from "three";

const gridKeys = (grids) => grids.map(({ x, y }) => `${x}/${y}`);
const tileCentre = (grid) => (31.5 - grid) * TERRAIN_GRID_SIZE;

test("terrain footprint follows the circle around a tile centre", () => {
  assert.equal(ENVIRONMENT_RANGE, 400);
  const keys = gridKeys(terrainGridFootprint(tileCentre(32), tileCentre(32), ENVIRONMENT_RANGE));
  assert.deepEqual(keys, ["31/31", "31/32", "31/33", "32/31", "32/32", "32/33", "33/31", "33/32", "33/33"]);
  assert.deepEqual(gridKeys(terrainGridFootprint(tileCentre(32), tileCentre(32), 300)),
    ["31/32", "32/31", "32/32", "32/33", "33/32"],
    "a smaller circle still excludes diagonal tiles rather than always loading a square");
});

test("terrain footprint includes both tiles near a shared edge", () => {
  assert.deepEqual(gridKeys(terrainGridFootprint(1, tileCentre(32), 10)), ["31/32", "32/32"]);
});

test("terrain footprint includes four tiles near a shared corner", () => {
  assert.deepEqual(gridKeys(terrainGridFootprint(1, 1, 10)), ["31/31", "31/32", "32/31", "32/32"]);
});

test("zero-range terrain footprint contains only the tile at an interior point", () => {
  assert.deepEqual(gridKeys(terrainGridFootprint(tileCentre(32), tileCentre(32), 0)), ["32/32"]);
});

test("terrain footprint clamps both map edges", () => {
  assert.deepEqual(gridKeys(terrainGridFootprint(32 * TERRAIN_GRID_SIZE, tileCentre(32), 0)), ["0/32"]);
  assert.deepEqual(gridKeys(terrainGridFootprint(-32 * TERRAIN_GRID_SIZE, tileCentre(32), 0)), ["63/32"]);
});

test("terrain grid uses closed map bounds on both axes", () => {
  const mapMax = 32 * TERRAIN_GRID_SIZE;
  const mapMin = -32 * TERRAIN_GRID_SIZE;
  const inside = tileCentre(32);
  assert.deepEqual(terrainGrid(mapMax, inside), { x: 0, y: 32 });
  assert.deepEqual(terrainGrid(mapMin, inside), { x: 63, y: 32 });
  assert.deepEqual(terrainGrid(inside, mapMax), { x: 32, y: 0 });
  assert.deepEqual(terrainGrid(inside, mapMin), { x: 32, y: 63 });
  for (const [x, y] of [
    [mapMax + 1, inside],
    [(32 + 1) * TERRAIN_GRID_SIZE - 1, inside],
    [mapMin - 1, inside],
    [inside, mapMax + 1],
    [inside, (32 + 1) * TERRAIN_GRID_SIZE - 1],
    [inside, mapMin - 1],
  ]) {
    assert.equal(terrainGrid(x, y), undefined, `outside point ${x},${y} is rejected`);
    assert.deepEqual(terrainGridDependencyFootprint(x, y), [], `outside point ${x},${y} has no footprint`);
  }
});

test("terrain dependency footprint is a clipped conservative 5x5 square", () => {
  assert.equal(terrainGridDependencyFootprint(tileCentre(32), tileCentre(32)).length, 25);
  assert.equal(terrainGridDependencyFootprint(32 * TERRAIN_GRID_SIZE, tileCentre(32)).length, 15);
  assert.deepEqual(terrainGridDependencyFootprint(Number.NaN, 0), []);
});

test("EnvironmentClient loads the exact circular footprint and caches repeated requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const neighborPlacement = {
    id: 9001,
    kind: "m2",
    name: "World\\Tree.m2",
    x: 20,
    y: tileCentre(32),
    z: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scale: 1,
  };
  const duplicatePlacement = { ...neighborPlacement };
  const distinctPlacement = { ...neighborPlacement, id: 9002, x: 28 };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    const body = path.endsWith("/7/31/32")
      ? [neighborPlacement]
      : path.endsWith("/7/32/31")
        ? [duplicatePlacement, distinctPlacement]
        : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world");
    const x = tileCentre(32);
    const y = tileCentre(32);
    const first = client.objectsAround(7, x, y);
    const expected = ["31/31", "31/32", "31/33", "32/31", "32/32", "32/33", "33/31", "33/32", "33/33"]
      .map((grid) => `/visual/environment/7/${grid}`)
      .sort();
    assert.deepEqual(requests.slice().sort(), expected);
    assert.equal(new Set(requests).size, expected.length, "the first request wave has no duplicates");
    assert.deepEqual(client.stats, {
      residentTiles: 0,
      knownMissingTiles: 0,
      failedTiles: 0,
      activeTiles: expected.length,
      residentObjects: 0,
      residentModels: 0,
      knownMissingModels: 0,
      deferredModels: 0,
      failedModels: 0,
      queuedModels: 0,
      activeModels: 0,
      queuedGroups: 0,
      activeGroups: 0,
      deferredGroups: 0,
      failedGroups: 0,
      residentAnimations: 0,
      failedAnimations: 0,
      deferredAnimations: 0,
      queuedAnimations: 0,
      activeAnimations: 0,
      modelDecodedTypedBackingBytes: 0,
      modelDecodedNumericArrayElements: 0,
      modelDecodedTypedBackingOverflowBytes: 0,
      modelDecodedNumericArrayOverflowElements: 0,
      animationDecodedTypedBackingBytes: 0,
      animationDecodedNumericArrayElements: 0,
      animationDecodedTypedBackingOverflowBytes: 0,
    });
    assert.strictEqual(client.objectsAround(7, x, y), first, "the same footprint reuses the cache");
    assert.equal(requests.length, expected.length, "repeating a pending footprint does not refetch");

    await new Promise((resolve) => setImmediate(resolve));
    const loaded = client.objectsAround(7, x, y);
    assert.equal(loaded.find((object) => object.id === neighborPlacement.id)?.x, neighborPlacement.x,
      "a placement from the neighbouring tile inside the circle is returned after loading");
    assert.equal(client.stats.residentTiles, expected.length);
    assert.equal(client.stats.residentObjects, 2, "duplicate placement ids count once across resident tiles");
    assert.equal(new Set(loaded.map((object) => object.id)).size, 2);
    assert.equal(client.stats.activeTiles, 0);
    assert.ok(Object.isFrozen(client.stats), "resource stats are immutable snapshots");
    assert.equal(requests.length, expected.length, "repeating a loaded footprint does not refetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient does not request out-of-map tiles at the map edge", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world");
    client.objectsAround(7, 32 * TERRAIN_GRID_SIZE, tileCentre(32), ENVIRONMENT_RANGE);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests.slice().sort(), [
      "/visual/environment/7/0/31",
      "/visual/environment/7/0/32",
      "/visual/environment/7/0/33",
    ]);
    assert.ok(requests.every((path) => !/\/(?:-\d+|64)\//.test(path)), "all map tile indices stay in range");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient bounds terminal tiles with an LRU and refetches an evicted tile", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  const centre = (grid) => tileCentre(grid);
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world", Date.now, 2);
    const query = (grid) => client.objectsAround(7, centre(grid), centre(32), 0);

    query(32);
    await settle();
    query(31);
    await settle();
    assert.equal(client.stats.residentTiles, 2);

    // Touch 32 before loading 30. The oldest unpinned terminal tile must then be 31.
    query(32);
    query(30);
    await settle();
    assert.equal(client.stats.residentTiles, 2);
    assert.equal(requests.filter((path) => path.endsWith("/7/31/32")).length, 1);

    query(31);
    await settle();
    assert.equal(client.stats.residentTiles, 2);
    assert.equal(requests.filter((path) => path.endsWith("/7/31/32")).length, 2,
      "re-entering an evicted tile starts a fresh request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient validates its tile residency limit", () => {
  assert.equal(ENVIRONMENT_TILE_CACHE_LIMIT, 64, "production environment tile cap stays conservative");
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new EnvironmentClient("ws://example.test:1234/world", Date.now, limit),
      RangeError,
      `invalid tile limit ${String(limit)} is rejected`,
    );
  }
});

test("EnvironmentClient pins the exact active footprint above a smaller test limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world", Date.now, 1);
    const expected = terrainGridFootprint(tileCentre(32), tileCentre(32), ENVIRONMENT_RANGE).length;
    client.objectsAround(7, tileCentre(32), tileCentre(32), ENVIRONMENT_RANGE);
    await settle();
    assert.equal(client.stats.residentTiles, expected, "all currently active footprint tiles stay pinned");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient drops an off-footprint failure below the default cache cap", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path.endsWith("/visual/environment/7/32/32") || path.endsWith("/environment/7/32/32")) {
      return new Response(null, { status: 500 });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world", Date.now, 64);
    const query = (grid) => client.objectsAround(7, tileCentre(grid), tileCentre(32), 0);

    query(32);
    await settle();
    assert.equal(client.stats.failedTiles, 1);

    query(31);
    await settle();
    assert.equal(client.stats.failedTiles, 0, "off-footprint failures are purged below capacity");

    query(32);
    await settle();
    assert.equal(requests.filter((path) => path === "/visual/environment/7/32/32").length, 2,
      "re-entering the failed tile starts a new visual request");
    assert.equal(requests.filter((path) => path === "/environment/7/32/32").length, 2,
      "re-entering the failed tile starts a new fallback request");
    assert.equal(client.stats.failedTiles, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient removes missing and failed tile ledgers when their tiles are evicted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/visual/environment/7/32/32") || path.endsWith("/environment/7/32/32")) {
      return new Response(null, { status: 404 });
    }
    if (path.endsWith("/visual/environment/7/31/32")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path.endsWith("/visual/environment/7/30/32") || path.endsWith("/environment/7/30/32")) {
      return new Response(null, { status: 500 });
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world", Date.now, 1);
    const query = (grid) => client.objectsAround(7, tileCentre(grid), tileCentre(32), 0);

    query(32);
    await settle();
    assert.deepEqual([client.stats.knownMissingTiles, client.stats.failedTiles], [1, 0]);

    query(31);
    await settle();
    assert.deepEqual([client.stats.knownMissingTiles, client.stats.failedTiles], [0, 0]);

    query(30);
    await settle();
    assert.deepEqual([client.stats.knownMissingTiles, client.stats.failedTiles], [0, 1]);

    query(31);
    await settle();
    assert.deepEqual([client.stats.knownMissingTiles, client.stats.failedTiles], [0, 0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient keeps the current pinned tile when an old footprint resolves late", async () => {
  const originalFetch = globalThis.fetch;
  const pending = new Map();
  const requests = [];
  globalThis.fetch = (url) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    return new Promise((resolve) => pending.set(path, resolve));
  };
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world", Date.now, 1);
    client.objectsAround(7, tileCentre(32), tileCentre(32), 0);
    client.objectsAround(7, tileCentre(31), tileCentre(32), 0);
    assert.equal(requests.length, 2);

    pending.get("/visual/environment/7/31/32")(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await settle();
    assert.deepEqual([client.stats.residentTiles, client.stats.activeTiles], [1, 1]);

    pending.get("/visual/environment/7/32/32")(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await settle();
    assert.equal(client.stats.residentTiles, 1, "late old data cannot evict the current pin");

    client.objectsAround(7, tileCentre(31), tileCentre(32), 0);
    assert.equal(requests.filter((path) => path.endsWith("/7/31/32")).length, 1,
      "the pinned tile remains cached after the stale response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient separates known-missing tiles from gateway and decode failures", async () => {
  const originalFetch = globalThis.fetch;
  const loadOne = async (responses) => {
    let index = 0;
    const statuses = [];
    globalThis.fetch = async () => responses[index++];
    const client = new EnvironmentClient("ws://example.test:1234/world");
    client.onStatus = (message, error) => statuses.push({ message, error });
    client.objectsAround(7, tileCentre(32), tileCentre(32), 0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return { calls: index, stats: client.stats, statuses };
  };
  try {
    const knownMissing = await loadOne([
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
    ]);
    assert.equal(knownMissing.calls, 2, "a missing visual tile falls back before being classified");
    assert.deepEqual(
      [knownMissing.stats.knownMissingTiles, knownMissing.stats.failedTiles],
      [1, 0],
    );
    assert.equal(knownMissing.statuses.at(-1)?.error, false);

    const gatewayFailure = await loadOne([
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
    ]);
    assert.deepEqual([gatewayFailure.stats.knownMissingTiles, gatewayFailure.stats.failedTiles], [0, 1]);
    assert.equal(gatewayFailure.statuses.at(-1)?.error, true, "failed fallback is reported as an error");

    const invalidBody = await loadOne([
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    assert.deepEqual([invalidBody.stats.knownMissingTiles, invalidBody.stats.failedTiles], [0, 1]);
    assert.equal(invalidBody.statuses.at(-1)?.error, true, "invalid tile data is reported as an error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function fourCC(bytes, offset, value) {
  for (let index = 0; index < 4; index++) bytes[offset + index] = value.charCodeAt(index);
}

function flatTerrainTile(height = 0) {
  const data = new ArrayBuffer(60);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  fourCC(bytes, 0, "MAPS");
  view.setUint32(4, 10, true);
  view.setUint32(20, 44, true);
  fourCC(bytes, 44, "MHGT");
  view.setUint32(48, 0x01, true);
  view.setFloat32(52, height, true);
  view.setFloat32(56, height, true);
  return data;
}

const settleTerrain = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

test("TerrainClient validates its production residency limit", () => {
  assert.equal(TerrainModule.TERRAIN_TILE_CACHE_LIMIT, 64, "production terrain tile cap stays conservative");
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new TerrainClient("ws://example.test:1234/world", limit),
      RangeError,
      `invalid tile limit ${String(limit)} is rejected`,
    );
  }
});

test("TerrainClient bounds successful tiles with LRU, retries re-entry, and removes evicted revisions", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url)).pathname);
    return new Response(flatTerrainTile(requests.length), { status: 200 });
  };
  const grid = (x) => ({ x, y: 32 });
  const sample = (x) => tileCentre(x);
  try {
    const terrain = new TerrainClient("ws://example.test:1234/world", 2);

    terrain.setActiveTiles(7, [grid(32)]);
    terrain.heightAt(7, sample(32), sample(32));
    await settleTerrain();
    terrain.setActiveTiles(7, [grid(31)]);
    terrain.heightAt(7, sample(31), sample(32));
    await settleTerrain();
    assert.equal(terrain.stats.resident, 2);

    terrain.heightAt(7, sample(32), sample(32));
    terrain.setActiveTiles(7, [grid(30)]);
    terrain.heightAt(7, sample(30), sample(32));
    await settleTerrain();
    assert.equal(terrain.stats.resident, 2);
    assert.equal(terrain.ownRevision(7, grid(31)), 0, "eviction removes the tile revision ledger too");

    terrain.setActiveTiles(7, [grid(31)]);
    terrain.heightAt(7, sample(31), sample(32));
    await settleTerrain();
    assert.equal(requests.filter((path) => path.endsWith("/7/31/32")).length, 2,
      "re-entering an evicted tile starts a fresh request");
    assert.ok(terrain.ownRevision(7, grid(31)) > 0);
    assert.equal(terrain.stats.resident, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TerrainClient keeps every active tile resident above a smaller test limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(flatTerrainTile(), { status: 200 });
  const grids = [];
  for (let x = 30; x <= 34; x++) {
    for (let y = 30; y <= 34; y++) grids.push({ x, y });
  }
  try {
    const terrain = new TerrainClient("ws://example.test:1234/world", 1);
    terrain.setActiveTiles(7, grids);
    for (const grid of grids) terrain.heightAt(7, tileCentre(grid.x), tileCentre(grid.y));
    await settleTerrain();
    assert.equal(terrain.stats.resident, 25, "the complete renderer dependency ring stays pinned");
    assert.ok(grids.every((grid) => terrain.ownRevision(7, grid) > 0));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TerrainClient late old response cannot evict the current active pin", async () => {
  const originalFetch = globalThis.fetch;
  const pending = new Map();
  const requests = [];
  globalThis.fetch = (url) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    return new Promise((resolve) => pending.set(path, resolve));
  };
  const oldGrid = { x: 32, y: 32 };
  const currentGrid = { x: 31, y: 32 };
  try {
    const terrain = new TerrainClient("ws://example.test:1234/world", 1);
    terrain.setActiveTiles(7, [oldGrid]);
    terrain.heightAt(7, tileCentre(32), tileCentre(32));
    terrain.setActiveTiles(7, [currentGrid]);
    terrain.heightAt(7, tileCentre(31), tileCentre(32));

    pending.get("/terrain/7/31/32")(new Response(flatTerrainTile(31), { status: 200 }));
    await settleTerrain();
    assert.equal(terrain.stats.resident, 1);

    pending.get("/terrain/7/32/32")(new Response(flatTerrainTile(32), { status: 200 }));
    await settleTerrain();
    assert.equal(terrain.stats.resident, 1);
    assert.equal(terrain.ownRevision(7, oldGrid), 0, "the stale resolved entry is evicted with its revision");
    assert.ok(terrain.ownRevision(7, currentGrid) > 0, "the current pin survives stale completion");

    terrain.heightAt(7, tileCentre(31), tileCentre(32));
    assert.equal(requests.filter((path) => path.endsWith("/7/31/32")).length, 1);
  } finally {
    for (const [path, resolve] of pending) {
      if (path.endsWith("/7/31/32") || path.endsWith("/7/32/32")) continue;
      resolve(new Response(null, { status: 500 }));
    }
    globalThis.fetch = originalFetch;
  }
});

test("TerrainClient retains an active null but purges it off-active for re-entry retry", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url)).pathname);
    return new Response(null, { status: 404 });
  };
  const failed = { x: 32, y: 32 };
  try {
    const terrain = new TerrainClient("ws://example.test:1234/world");
    terrain.setActiveTiles(7, [failed]);
    terrain.heightAt(7, tileCentre(32), tileCentre(32));
    await settleTerrain();
    assert.equal(terrain.stats.failed, 1, "an active terminal null remains a readiness answer");
    assert.ok(terrain.ownRevision(7, failed) > 0);

    terrain.setActiveTiles(7, [{ x: 31, y: 32 }]);
    assert.equal(terrain.stats.failed, 0, "off-active null is purged even below the default cap");
    assert.equal(terrain.ownRevision(7, failed), 0);

    terrain.setActiveTiles(7, [failed]);
    terrain.heightAt(7, tileCentre(32), tileCentre(32));
    await settleTerrain();
    assert.equal(requests.filter((path) => path.endsWith("/7/32/32")).length, 2,
      "re-entering a failed tile starts a fresh request");
    assert.equal(terrain.stats.failed, 1);

    terrain.setActiveTiles(undefined, []);
    assert.equal(terrain.stats.failed, 0, "clearing the active map clears terminal failures");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terrain readiness distinguishes a pending tile from an empty tile", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const terrain = new TerrainClient("ws://localhost:1234/world");
    terrain.setActiveTiles(1, [{ x: 32, y: 32 }]);
    assert.equal(terrain.isReady(1, 0, 0), false, "the destination must stay blocked while its tile is pending");
    assert.deepEqual(terrain.stats, { resident: 0, failed: 0, active: 1, typedPayloadBytes: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terrain.isReady(1, 0, 0), true, "a completed empty tile is a valid degraded answer");
    assert.deepEqual(terrain.stats, { resident: 0, failed: 1, active: 0, typedPayloadBytes: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("standalone terrain readiness retains a terminal 404 until re-entry", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(null, { status: 404 });
  };
  try {
    const terrain = new TerrainClient("ws://localhost:1234/world");
    assert.equal(terrain.isReady(1, 0, 0), false, "the first readiness probe starts the request");
    await settleTerrain();
    assert.equal(terrain.isReady(1, 0, 0), true, "a terminal 404 remains a ready degraded answer");
    assert.equal(terrain.isReady(1, 0, 0), true, "repeated readiness sees the terminal answer");
    assert.equal(requests, 1, "standalone readiness does not refetch the same 404");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terrain invalidation includes a diagonal tile for water corner dependencies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const terrain = new TerrainClient("ws://localhost:1234/world");
    const cell = (grid) => (32 - grid - 0.5) * 533.3333333333334;
    const centre = { x: 32, y: 32 };
    terrain.setActiveTiles(1, [centre, { x: 33, y: 33 }]);
    terrain.heightAt(1, cell(centre.x), cell(centre.y));
    await new Promise((resolve) => setImmediate(resolve));
    const before = terrain.tileRevision(1, centre);

    // The corner cell at (33, 33) is diagonal to the centre tile. Its arrival invalidates both the
    // water corner and the canonical terrain endpoint shared by the four touching meshes.
    terrain.heightAt(1, cell(33), cell(33));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(terrain.tileRevision(1, centre) > before, "a diagonal arrival changes the rebuild revision");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terrain tile decodes TrinityCore uint8 heights", () => {
  const heightOffset = 44;
  const v9Offset = heightOffset + 16;
  const liquidOffset = v9Offset + 129 * 129 + 128 * 128;
  const holesOffset = liquidOffset + 16;
  const data = new ArrayBuffer(holesOffset + 16 * 16 * 2);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  fourCC(bytes, 0, "MAPS");
  view.setUint32(4, 10, true);
  view.setUint32(20, heightOffset, true);
  view.setUint32(28, liquidOffset, true);
  view.setUint32(32, 16, true);
  view.setUint32(36, holesOffset, true);
  view.setUint32(40, 16 * 16 * 2, true);
  fourCC(bytes, heightOffset, "MHGT");
  view.setUint32(heightOffset + 4, 0x04, true);
  view.setFloat32(heightOffset + 8, 10, true);
  view.setFloat32(heightOffset + 12, 20, true);
  bytes[v9Offset] = 128;
  fourCC(bytes, liquidOffset, "MLIQ");
  view.setUint8(liquidOffset + 4, 0x03);
  view.setUint8(liquidOffset + 5, 0x01);
  // Byte 6 is the LiquidType.dbc id, and on a tile with no per-chunk arrays it is the only place
  // the id appears at all. 81 is "Lake Wintergrasp - Water".
  view.setUint16(liquidOffset + 6, 81, true);
  view.setUint8(liquidOffset + 10, 128);
  view.setUint8(liquidOffset + 11, 128);
  view.setFloat32(liquidOffset + 12, 15, true);
  view.setUint16(holesOffset, 1, true);

  const tile = new TerrainTile(data);
  assert.equal(tile.byteLength, data.byteLength);
  assert.deepEqual(terrainGrid(0, 0), { x: 32, y: 32 });
  assert.ok(Math.abs(tile.heightAt(0, 0) - (10 + 1280 / 255)) < 0.0001);
  assert.equal(tile.isHole(0, 0), true);
  assert.equal(tile.isHole(-20, -20), false);
  // `cells` false: this tile carries one level for the whole of it, which is what 1,729 of the
  // world's 3,196 liquid tiles do, and it is why the ground test cannot be dropped there.
  assert.deepEqual(tile.liquidAt(0, 0), { height: 15, type: 1, entry: 81, cells: false });
});

test("EnvironmentClient stats split queued and active model and animation jobs and reject orphan groups", async () => {
  const originalFetch = globalThis.fetch;
  const releases = [];
  globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world");
    for (let index = 0; index < 5; index++) client.model(`Model${index}.m2`, "critical");
    client.requestModelGroups("Building.wmo", [0, 1, 2, 3, 4]);
    client.animations("Animated.m2", 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(client.stats, {
      residentTiles: 0,
      knownMissingTiles: 0,
      failedTiles: 0,
      activeTiles: 0,
      residentObjects: 0,
      residentModels: 0,
      knownMissingModels: 0,
      deferredModels: 0,
      failedModels: 0,
      queuedModels: 1,
      activeModels: 4,
      queuedGroups: 0,
      activeGroups: 0,
      deferredGroups: 0,
      failedGroups: 0,
      residentAnimations: 0,
      failedAnimations: 0,
      deferredAnimations: 0,
      // 10.21 (c): the four critical models fill the shared request budget, so the normal-priority
      // sidecar waits in its queue instead of opening a fifth connection beside them.
      queuedAnimations: 1,
      activeAnimations: 0,
      modelDecodedTypedBackingBytes: 0,
      modelDecodedNumericArrayElements: 0,
      modelDecodedTypedBackingOverflowBytes: 0,
      modelDecodedNumericArrayOverflowElements: 0,
      animationDecodedTypedBackingBytes: 0,
      animationDecodedNumericArrayElements: 0,
      animationDecodedTypedBackingOverflowBytes: 0,
    });

    while (releases.length > 0) {
      const batch = releases.splice(0);
      for (const release of batch) release(new Response(null, { status: 500 }));
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(client.stats.activeModels, 0);
    assert.equal(client.stats.activeGroups, 0);
    assert.equal(client.stats.activeAnimations, 0);
    assert.equal(client.stats.failedAnimations, 0);
    assert.equal(client.stats.deferredAnimations, 1);
    assert.equal(client.stats.deferredModels, 5);
    assert.equal(client.stats.failedModels, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient stats distinguish known-missing models from retry backoff", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  globalThis.fetch = async (url) => {
    const address = String(url);
    return new Response(null, {
      status: address.includes("path=Absent.m2") || address.includes("/environment/model/Absent.m2") ? 404 : 500,
    });
  };
  const settle = async () => {
    for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world", () => now);
    client.model("Retry.m2", "critical");
    await settle();
    assert.deepEqual(
      [client.stats.deferredModels, client.stats.failedModels, client.stats.knownMissingModels],
      [1, 0, 0],
    );

    for (const wait of IMAGE_RETRY_BACKOFF_MS) {
      now += wait;
      client.model("Retry.m2", "critical");
      await settle();
    }
    assert.deepEqual(
      [client.stats.deferredModels, client.stats.failedModels, client.stats.knownMissingModels],
      [0, 1, 0],
    );

    client.model("Absent.m2", "critical");
    await settle();
    assert.deepEqual(
      [client.stats.deferredModels, client.stats.failedModels, client.stats.knownMissingModels],
      [0, 1, 1],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient retries a failed visual-model hull fallback", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  let visualAttempts = 0;
  const artifact = new ArrayBuffer(16);
  new Uint8Array(artifact).set([0x57, 0x56, 0x4d, 0x31]);
  globalThis.fetch = async (url) => {
    const address = String(url);
    if (address.includes("/visual/model")) {
      visualAttempts++;
      return visualAttempts === 1
        ? new Response(null, { status: 404 })
        : { ok: true, status: 200, arrayBuffer: async () => artifact };
    }
    assert.ok(address.includes("/environment/model/"));
    return new Response(null, { status: 500 });
  };
  const settle = async () => {
    for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world", () => now);
    client.model("World\\Broken.wmo", "critical");
    await settle();
    assert.deepEqual(
      [client.stats.residentModels, client.stats.knownMissingModels, client.stats.deferredModels],
      [0, 0, 1],
    );

    now += IMAGE_RETRY_BACKOFF_MS[0];
    client.model("World\\Broken.wmo", "critical");
    await settle();
    assert.deepEqual(
      [client.stats.residentModels, client.stats.knownMissingModels, client.stats.deferredModels],
      [1, 0, 0],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("EnvironmentClient stats do not double-count a retry while its request is active", async () => {
  const originalFetch = globalThis.fetch;
  let now = 0;
  let attempts = 0;
  let release;
  globalThis.fetch = (url) => {
    assert.ok(String(url).includes("Retry.m2"));
    attempts++;
    if (attempts === 1) return Promise.resolve(new Response(null, { status: 500 }));
    return new Promise((resolve) => { release = resolve; });
  };
  const settle = async () => {
    for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = new EnvironmentClient("ws://example.test:1234/world", () => now);
    client.model("Retry.m2", "critical");
    await settle();
    assert.deepEqual([client.stats.deferredModels, client.stats.failedModels], [1, 0]);

    now += IMAGE_RETRY_BACKOFF_MS[0];
    client.model("Retry.m2", "critical");
    await settle();
    assert.equal(client.stats.activeModels, 1);
    assert.deepEqual([client.stats.deferredModels, client.stats.failedModels], [0, 0]);

    assert.ok(release, "the retry has an unresolved fetch to observe");
    release(new Response(null, { status: 500 }));
    release = undefined;
    await settle();
    assert.deepEqual([client.stats.deferredModels, client.stats.failedModels], [1, 0]);
  } finally {
    if (release) {
      release(new Response(null, { status: 500 }));
      await settle();
    }
    globalThis.fetch = originalFetch;
  }
});

test("TerrainSplatClient stats count resident tile and decoded shared layer bytes", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("/terrain-splat/")) {
      return new Response(JSON.stringify({ layers: ["a".repeat(40)] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    const texture = new THREE.Texture();
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  };
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4) }),
      };
    }
  };
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    client.get(1, { x: 32, y: 32 });
    assert.equal(client.stats.active, 1);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(client.stats, {
      resident: 1,
      failed: 0,
      active: 0,
      decodedLayerBytes: 256 * 256 * 4,
      layerRequestEntries: 1,
    });
    assert.ok(Object.isFrozen(client.stats), "resource stats are immutable snapshots");
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
  }
});

test("a per-cell liquid tile carries its type id, and its dry cells carry the extractor's sentinel", () => {
  // The other shape of the same section: `liquid_entry[16][16]` then `liquid_flags[16][16]`, then
  // a rectangle of per-cell heights whose dry corners are filled with exactly -500.
  const heightOffset = 44;
  const v9Offset = heightOffset + 16;
  const liquidOffset = v9Offset + 129 * 129 * 4 + 128 * 128 * 4;
  const entriesOffset = liquidOffset + 16;
  const flagsOffset = entriesOffset + 16 * 16 * 2;
  const heightsOffset = flagsOffset + 16 * 16;
  const cells = 128 * 128 * 4;
  const holesOffset = heightsOffset + cells;
  const data = new ArrayBuffer(holesOffset + 16 * 16 * 2);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  fourCC(bytes, 0, "MAPS");
  view.setUint32(4, 10, true);
  view.setUint32(20, heightOffset, true);
  view.setUint32(28, liquidOffset, true);
  view.setUint32(32, 16 + 16 * 16 * 3 + cells, true);
  view.setUint32(36, holesOffset, true);
  view.setUint32(40, 16 * 16 * 2, true);
  fourCC(bytes, heightOffset, "MHGT");
  view.setUint32(heightOffset + 4, 0, true);
  view.setFloat32(heightOffset + 8, 0, true);
  view.setFloat32(heightOffset + 12, 0, true);
  fourCC(bytes, liquidOffset, "MLIQ");
  view.setUint8(liquidOffset + 4, 0x00);
  // Deliberately the wrong answer in the header: on a tile with per-chunk arrays the extractor
  // leaves these two uninitialised, and byte 5 reads 2 — ocean — on all 1,635 of them.
  view.setUint8(liquidOffset + 5, 0x02);
  view.setUint16(liquidOffset + 6, 2, true);
  view.setUint8(liquidOffset + 8, 0);
  view.setUint8(liquidOffset + 9, 0);
  view.setUint8(liquidOffset + 10, 128);
  view.setUint8(liquidOffset + 11, 128);
  view.setFloat32(liquidOffset + 12, 0, true);
  // Chunk 0 is row 181, "Orange Slime": sound bank water, texture LavaOrange.
  view.setUint16(entriesOffset, 181, true);
  bytes[flagsOffset] = 0x01;
  for (let cell = 0; cell < 128 * 128; cell++) view.setFloat32(heightsOffset + cell * 4, -500, true);
  view.setFloat32(heightsOffset, 12.5, true);

  const tile = new TerrainTile(data);
  const wet = tile.liquidAt(0, 0);
  assert.deepEqual(wet, { height: 12.5, type: 1, entry: 181, cells: true });
  // One cell along is the filler, and it is not water however low it is.
  assert.equal(tile.liquidAt(-4.2, 0), undefined);
});
