import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PerformanceObserver, constants } from "node:perf_hooks";
import test from "node:test";
import { TERRAIN_GRID_SIZE, TerrainClient, TerrainTile, terrainGrid, EnvironmentClient } from "../dist/code/browser/Terrain.js";

// Merged 2026-10-20 from 3 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── terrain-probe-alloc.test.mjs
{
// 5.04 follow-up: TerrainClient.heightAt / isHole / groundHeightAt are called every frame for every
// extrapolated remote player (plus physics, ground cover, the camera). They must answer exactly as
// the old code did on real dataset tiles and allocate nothing beyond the returned height itself.

let mapsDirectory;
try {
  mapsDirectory = (await import("../tools/paths.mjs")).mapsDirectory();
} catch {
  mapsDirectory = undefined;
}
const MAP = 0;
// Elwynn around Goldshire: 3x3 tiles with mine mouths (terrain holes) among them.
const GRIDS = [];
for (let gx = 48; gx <= 50; gx++) for (let gy = 31; gy <= 33; gy++) GRIDS.push([gx, gy]);
const tileName = (map, gx, gy) => `${String(map).padStart(3, "0")}${String(gx).padStart(2, "0")}${String(gy).padStart(2, "0")}.map`;
const withMaps = {
  skip: mapsDirectory && GRIDS.every(([gx, gy]) => existsSync(join(mapsDirectory, tileName(MAP, gx, gy))))
    ? false : "no extracted Elwynn maps on this machine",
};

// ---- Reference: the pre-02.10 code, copied verbatim in behaviour --------------------------------
const GRID_CENTER = 32;
const GRID_COUNT = 64;
const MAP_MIN = -GRID_CENTER * TERRAIN_GRID_SIZE;
const MAP_MAX = GRID_CENTER * TERRAIN_GRID_SIZE;
const RESOLUTION = 128;

function oldTerrainGrid(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || x < MAP_MIN || x > MAP_MAX || y < MAP_MIN || y > MAP_MAX) return undefined;
  const grid = {
    x: Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(GRID_CENTER - x / TERRAIN_GRID_SIZE))),
    y: Math.max(0, Math.min(GRID_COUNT - 1, Math.floor(GRID_CENTER - y / TERRAIN_GRID_SIZE))),
  };
  return grid.x >= 0 && grid.x < GRID_COUNT && grid.y >= 0 && grid.y < GRID_COUNT ? grid : undefined;
}

/** The old TerrainTile height/hole readers over the raw map file. */
class OldTile {
  constructor(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.view = view;
    const holesOffset = view.getUint32(36, true);
    const holesSize = view.getUint32(40, true);
    this.holesOffset = holesOffset && holesSize >= 16 * 16 * 2 && holesOffset + 16 * 16 * 2 <= bytes.byteLength ? holesOffset : 0;
    const heightOffset = view.getUint32(20, true);
    const flags = view.getUint32(heightOffset + 4, true);
    this.baseHeight = view.getFloat32(heightOffset + 8, true);
    const maxHeight = view.getFloat32(heightOffset + 12, true);
    this.v9Offset = heightOffset + 16;
    if (flags & 0x01) { this.format = "flat"; return; }
    if (flags & 0x02) { this.format = "uint16"; this.stride = 2; this.multiplier = (maxHeight - this.baseHeight) / 65535; }
    else if (flags & 0x04) { this.format = "uint8"; this.stride = 1; this.multiplier = (maxHeight - this.baseHeight) / 255; }
    else { this.format = "float"; this.stride = 4; this.multiplier = 1; }
    this.v8Offset = this.v9Offset + 129 * 129 * this.stride;
  }
  height(offset, index) {
    const position = offset + index * this.stride;
    if (this.format === "uint8") return this.view.getUint8(position);
    if (this.format === "uint16") return this.view.getUint16(position, true);
    return this.view.getFloat32(position, true);
  }
  heightAt(worldX, worldY) {
    if (this.format === "flat") return this.baseHeight;
    let x = RESOLUTION * (GRID_CENTER - worldX / TERRAIN_GRID_SIZE);
    let y = RESOLUTION * (GRID_CENTER - worldY / TERRAIN_GRID_SIZE);
    let xIndex = Math.trunc(x);
    let yIndex = Math.trunc(y);
    x -= xIndex;
    y -= yIndex;
    xIndex &= RESOLUTION - 1;
    yIndex &= RESOLUTION - 1;
    const h1 = this.height(this.v9Offset, xIndex * 129 + yIndex);
    const h2 = this.height(this.v9Offset, (xIndex + 1) * 129 + yIndex);
    const h3 = this.height(this.v9Offset, xIndex * 129 + yIndex + 1);
    const h4 = this.height(this.v9Offset, (xIndex + 1) * 129 + yIndex + 1);
    const h5 = 2 * this.height(this.v8Offset, xIndex * 128 + yIndex);
    let a; let b; let c;
    if (x + y < 1) {
      if (x > y) { a = h2 - h1; b = h5 - h1 - h2; c = h1; } else { a = h5 - h1 - h3; b = h3 - h1; c = h1; }
    } else if (x > y) { a = h2 + h4 - h5; b = h4 - h2; c = h5 - h4; } else { a = h4 - h3; b = h3 + h4 - h5; c = h5 - h4; }
    return (a * x + b * y + c) * this.multiplier + this.baseHeight;
  }
  isHole(worldX, worldY) {
    if (!this.holesOffset) return false;
    const row = Math.trunc(RESOLUTION * (GRID_CENTER - worldX / TERRAIN_GRID_SIZE)) & (RESOLUTION - 1);
    const column = Math.trunc(RESOLUTION * (GRID_CENTER - worldY / TERRAIN_GRID_SIZE)) & (RESOLUTION - 1);
    const cellRow = Math.trunc(row / 8);
    const cellColumn = Math.trunc(column / 8);
    const holeRow = Math.trunc((row % 8) / 2);
    const holeColumn = Math.trunc((column % 8) / 2);
    const hole = this.view.getUint16(this.holesOffset + (cellRow * 16 + cellColumn) * 2, true);
    return (hole & [0x1111, 0x2222, 0x4444, 0x8888][holeColumn] & [0x000f, 0x00f0, 0x0f00, 0xf000][holeRow]) !== 0;
  }
}

// ---- Fixture: a TerrainClient over the real files ------------------------------------------------
/** 3x3 resident, 47/32 a 404, 51/32 never answers (still on the wire). */
async function residentClient() {
  const files = new Map();
  for (const [gx, gy] of GRIDS) files.set(`${gx}/${gy}`, readFileSync(join(mapsDirectory, tileName(MAP, gx, gy))));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const [, map, gx, gy] = new URL(String(url)).pathname.match(/\/terrain\/(\d+)\/(\d+)\/(\d+)/);
    if (Number(map) === MAP && gx === "51") return new Promise(() => {});
    const file = Number(map) === MAP ? files.get(`${gx}/${gy}`) : undefined;
    return Promise.resolve(file ? new Response(file) : new Response(null, { status: 404 }));
  };
  const client = new TerrainClient("ws://example.test:1/world");
  try {
    for (const [gx, gy] of [...GRIDS, [47, 32], [51, 32]]) client.heightAt(MAP, centre(gx), centre(gy));
    for (let wait = 0; wait < 400 && client.stats.resident + client.stats.failed < GRIDS.length + 1; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(client.stats.resident, GRIDS.length);
  assert.equal(client.stats.failed, 1, "the 404 tile is a terminal null");
  const old = new Map([...files].map(([key, bytes]) => [key, new OldTile(bytes)]));
  return { client, old, files };
}
const centre = (grid) => (31.5 - grid) * TERRAIN_GRID_SIZE;

function oldClient(old) {
  const tileFor = (map, x, y) => {
    const grid = map === MAP ? oldTerrainGrid(x, y) : undefined;
    if (!grid) return { grid };
    return { grid, tile: old.get(`${grid.x}/${grid.y}`) };
  };
  return {
    heightAt: (map, x, y) => (map === undefined ? undefined : tileFor(map, x, y).tile?.heightAt(x, y)),
    isHole: (map, x, y) => (map === undefined ? false : tileFor(map, x, y).tile?.isHole(x, y) ?? false),
  };
}

/** Every vertex, every half-cell, both tile edges and a little past the ring, plus the odd values. */
function samplePoints() {
  const points = [];
  const step = TERRAIN_GRID_SIZE / RESOLUTION / 2;
  const min = centre(51) - 3;
  const max = centre(47) + 3;
  for (let x = min; x <= max; x += step * 3.0001) {
    for (let y = centre(34) - 3; y <= centre(30) + 3; y += step * 3.0003) points.push([x, y]);
  }
  for (const [gx, gy] of GRIDS) {
    const edgeX = (32 - gx) * TERRAIN_GRID_SIZE;
    const edgeY = (32 - gy) * TERRAIN_GRID_SIZE;
    for (const dx of [0, -1e-9, 1e-9, -step, step]) for (const dy of [0, -1e-9, 1e-9, -step, step]) points.push([edgeX + dx, edgeY + dy]);
  }
  for (const odd of [Number.NaN, Infinity, -Infinity, MAP_MAX, MAP_MIN, MAP_MAX + 1, MAP_MIN - 1, -0, 0]) {
    points.push([odd, centre(49)], [centre(49), odd]);
  }
  return points;
}

test("terrainGrid is unchanged for map points, edges and junk", () => {
  for (const [x, y] of samplePoints()) assert.deepEqual(terrainGrid(x, y), oldTerrainGrid(x, y), `${x},${y}`);
});

test("heightAt / isHole / groundHeightAt answer bit-identically to the old code on real Elwynn tiles", withMaps, async () => {
  const { client, old } = await residentClient();
  const reference = oldClient(old);
  let unresolved = 0;
  let heights = 0;
  let holes = 0;
  for (const map of [MAP, undefined]) {
    for (const [x, y] of samplePoints()) {
      const expectedHeight = reference.heightAt(map, x, y);
      const expectedHole = reference.isHole(map, x, y);
      const height = client.heightAt(map, x, y);
      const hole = client.isHole(map, x, y);
      assert.ok(Object.is(height, expectedHeight), `heightAt ${map} ${x},${y}: ${height} vs ${expectedHeight}`);
      assert.equal(hole, expectedHole, `isHole ${map} ${x},${y}`);
      const expectedGround = !expectedHole ? expectedHeight : undefined;
      assert.ok(Object.is(client.groundHeightAt(map, x, y), expectedGround), `groundHeightAt ${map} ${x},${y}`);
      if (map === MAP && expectedHeight === undefined) unresolved++;
      if (expectedHeight !== undefined) heights++;
      if (expectedHole) holes++;
    }
  }
  assert.ok(heights > 50_000, `real heights compared (${heights})`);
  assert.ok(holes > 50, `real terrain holes compared (${holes})`);
  assert.ok(unresolved > 1000, `points off the resident ring (404, still loading, off-map) are compared too (${unresolved})`);
});

test("TerrainTile.isHole matches the old mask table over every cell of every Elwynn tile", withMaps, async () => {
  let holes = 0;
  for (const [gx, gy] of GRIDS) {
    const bytes = readFileSync(join(mapsDirectory, tileName(MAP, gx, gy)));
    const tile = new TerrainTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const old = new OldTile(bytes);
    const cell = TERRAIN_GRID_SIZE / RESOLUTION;
    for (let row = 0; row < RESOLUTION; row++) {
      for (let column = 0; column < RESOLUTION; column++) {
        const x = (32 - gx) * TERRAIN_GRID_SIZE - (row + 0.5) * cell;
        const y = (32 - gy) * TERRAIN_GRID_SIZE - (column + 0.5) * cell;
        const expected = old.isHole(x, y);
        assert.equal(tile.isHole(x, y), expected, `${gx}/${gy} cell ${row},${column}`);
        if (expected) holes++;
      }
    }
  }
  assert.ok(holes > 0, "the fixture contains real holes");
});

test("the client probes allocate nothing beyond the returned height (scavenge count, measured)", withMaps, async () => {
  const { client, files } = await residentClient();
  const bytes = files.get("48/31");
  const tile = new TerrainTile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  // Remote players spread over all nine tiles: consecutive probes miss the one-entry tile cache.
  // Integer coordinates are Smis, so the loop itself boxes nothing but the returned double.
  const xs = new Int32Array(27);
  const ys = new Int32Array(27);
  for (let i = 0; i < 27; i++) {
    const [gx, gy] = GRIDS[i % 9];
    xs[i] = Math.round(centre(gx)) + ((i * 37) % 200) - 100;
    ys[i] = Math.round(centre(gy)) + ((i * 53) % 200) - 100;
  }
  const loops = {
    // Baseline: the tile's own reader, whose only allocation is the boxed double it returns.
    tile: (n) => { let s = 0; for (let k = 0; k < n; k++) { const i = k % 27; const h = k < 0 ? undefined : tile.heightAt(xs[i] + (k & 7), ys[i]); if (h !== undefined) s += h; } return s; },
    heightAt: (n) => { let s = 0; for (let k = 0; k < n; k++) { const i = k % 27; const h = client.heightAt(MAP, xs[i] + (k & 7), ys[i]); if (h !== undefined) s += h; } return s; },
    groundHeightAt: (n) => { let s = 0; for (let k = 0; k < n; k++) { const i = k % 27; const h = client.groundHeightAt(MAP, xs[i] + (k & 7), ys[i]); if (h !== undefined) s += h; } return s; },
    isHole: (n) => { let s = 0; for (let k = 0; k < n; k++) { const i = k % 27; if (client.isHole(MAP, xs[i] + (k & 7), ys[i])) s++; } return s; },
  };
  let minor = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
  });
  observer.observe({ entryTypes: ["gc"] });
  const N = 4_000_000;
  const results = {};
  try {
    for (const run of Object.values(loops)) for (let warm = 0; warm < 20; warm++) run(50_000);
    for (const [name, run] of Object.entries(loops)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      minor = 0;
      const started = process.hrtime.bigint();
      run(N);
      const ns = Number(process.hrtime.bigint() - started) / N;
      await new Promise((resolve) => setTimeout(resolve, 50));
      results[name] = { scavenges: minor, ns: Number(ns.toFixed(1)) };
    }
  } finally {
    observer.disconnect();
  }
  console.log("terrain probe, per call over 4M calls across 9 tiles:", JSON.stringify(results));
  assert.ok(results.isHole.scavenges <= 1, `isHole allocates nothing: ${JSON.stringify(results)}`);
  for (const name of ["heightAt", "groundHeightAt"]) {
    assert.ok(results[name].scavenges <= results.tile.scavenges * 1.5 + 2,
      `${name} allocates no more than the tile reader's returned height: ${JSON.stringify(results)}`);
  }
});
}

// ── terrain-request-cap.test.mjs
{
// 10.21 (c): the three environment lanes (models 4, WMO groups 4, animation sidecars 2) share one
// budget of four requests, plus one for critical work — not ten requests against six sockets.

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function wmoHeader(groupCount) {
  const data = new ArrayBuffer(24 + groupCount * 40);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  bytes.set([0x57, 0x57, 0x4d, 0x31]);
  view.setUint32(4, groupCount, true);
  view.setUint32(16, data.byteLength, true);
  for (let group = 0; group < groupCount; group++) {
    const offset = 24 + group * 40;
    view.setFloat32(offset, -1, true);
    view.setFloat32(offset + 4, -1, true);
    view.setFloat32(offset + 8, -1, true);
    view.setFloat32(offset + 12, 1, true);
    view.setFloat32(offset + 16, 1, true);
    view.setFloat32(offset + 20, 1, true);
    view.setUint32(offset + 28, 1, true);
  }
  return data;
}

function classify(url) {
  const address = new URL(String(url));
  if (address.pathname.includes("animations")) return "animation";
  if (address.searchParams.has("group")) return "group";
  return "model";
}

test("20 models, 8 WMO groups and 4 animation sidecars never hold more than 4 (+1 critical) fetches", async () => {
  const originalFetch = globalThis.fetch;
  const pending = [];
  const started = { model: 0, group: 0, animation: 0 };
  const inits = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let parentServed = false;
  globalThis.fetch = (url, init) => {
    const kind = classify(url);
    // The WMO parent the groups belong to is answered at once, before the measured burst.
    if (!parentServed && kind === "model" && String(url).includes("City.wmo")) {
      parentServed = true;
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => wmoHeader(8) });
    }
    started[kind]++;
    inits.push({ kind, priority: init?.priority });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise((resolve) => pending.push({
      kind,
      resolve: () => {
        inFlight--;
        resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
      },
    }));
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    client.endResourceFrame();
    await settle();
    assert.ok(client.model("City.wmo")?.wmo, "the WMO parent is resident");

    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    for (let index = 0; index < 20; index++) client.model(`World\\Scenery${index}.m2`, index % 2 ? "background" : "normal");
    client.requestModelGroups("City.wmo", [0, 1, 2, 3, 4, 5, 6, 7]);
    for (let index = 0; index < 4; index++) client.animations(`Creature\\Rig${index}.m2`, 1, "normal");
    client.endResourceFrame();
    await settle();
    assert.equal(inFlight, 4, "the burst fills the shared budget");
    assert.equal(maxInFlight, 4, "and no more: the three lanes no longer add up to ten");

    client.model("Character\\Self.m2", "critical");
    await settle();
    assert.equal(maxInFlight, 5, "a critical model takes the one spare slot");
    assert.equal(inits.at(-1).kind, "model");

    // Drain everything one completion at a time: every request still starts (no lost wake-up),
    // and the ceiling holds throughout.
    for (let guard = 0; guard < 200 && pending.length > 0; guard++) {
      pending.shift().resolve();
      await settle();
      assert.ok(inFlight <= 5, `at most 4 + 1 in flight (saw ${inFlight})`);
    }
    assert.equal(pending.length, 0);
    assert.deepEqual(started, { model: 21, group: 8, animation: 4 }, "every queued request was made once");
    assert.equal(maxInFlight, 5);
    // The groups were not starved behind twenty models: the first group starts before the last model.
    const firstGroup = inits.findIndex((entry) => entry.kind === "group");
    const lastModel = inits.findLastIndex((entry) => entry.kind === "model");
    assert.ok(firstGroup >= 0 && firstGroup < lastModel, "lanes take turns for freed slots");
    // Scenery is marked low for Chromium's scheduler; normal and critical work keep the default.
    assert.ok(inits.some((entry) => entry.kind === "model" && entry.priority === "low"));
    assert.ok(inits.every((entry) => entry.priority === undefined || entry.priority === "low"));
    assert.ok(inits.filter((entry) => entry.kind === "group").every((entry) => entry.priority === undefined));
    client.dispose();
  } finally {
    for (const request of pending) request.resolve();
    await settle();
    globalThis.fetch = originalFetch;
  }
});
}

// ── terrain-request-fairness.test.mjs
{
// 10.21 (c) review (02.10): a slot freed by one lane goes to the other lanes first. The group lane
// re-drained itself synchronously after its own release, ahead of the wake-ups it had just queued,
// so a long group queue kept every slot and ordinary models waited until the last group had started.

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function wmoHeader(groupCount) {
  const data = new ArrayBuffer(24 + groupCount * 40);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  bytes.set([0x57, 0x57, 0x4d, 0x31]);
  view.setUint32(4, groupCount, true);
  view.setUint32(16, data.byteLength, true);
  for (let group = 0; group < groupCount; group++) {
    const offset = 24 + group * 40;
    view.setFloat32(offset, -1, true);
    view.setFloat32(offset + 4, -1, true);
    view.setFloat32(offset + 8, -1, true);
    view.setFloat32(offset + 12, 1, true);
    view.setFloat32(offset + 16, 1, true);
    view.setFloat32(offset + 20, 1, true);
    view.setUint32(offset + 28, 1, true);
  }
  return data;
}

function classify(url) {
  const address = new URL(String(url));
  if (address.pathname.includes("animations")) return "animation";
  if (address.searchParams.has("group")) return "group";
  return "model";
}

test("a long WMO group queue does not keep ordinary models waiting until the last group", async () => {
  const originalFetch = globalThis.fetch;
  const pending = [];
  const order = [];
  let parentServed = false;
  globalThis.fetch = (url) => {
    const kind = classify(url);
    if (!parentServed && kind === "model" && String(url).includes("City.wmo")) {
      parentServed = true;
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => wmoHeader(40) });
    }
    order.push(kind);
    return new Promise((resolve) => pending.push(() => resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) })));
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    client.endResourceFrame();
    await settle();
    assert.ok(client.model("City.wmo")?.wmo, "the WMO parent is resident");

    client.beginResourceFrame();
    client.model("City.wmo", "critical");
    for (let index = 0; index < 8; index++) client.model(`World\Scenery${index}.m2`, "normal");
    client.requestModelGroups("City.wmo", Array.from({ length: 40 }, (_, group) => group));
    client.endResourceFrame();
    await settle();
    for (let guard = 0; guard < 400 && pending.length > 0; guard++) {
      pending.shift()();
      await settle();
    }
    assert.equal(pending.length, 0);
    assert.equal(order.filter((kind) => kind === "model").length, 8);
    assert.equal(order.filter((kind) => kind === "group").length, 40);
    const lastModel = order.lastIndexOf("model");
    const lastGroup = order.lastIndexOf("group");
    assert.ok(lastModel < lastGroup, `the eighth model started at ${lastModel}, after every group (last ${lastGroup})`);
    client.dispose();
  } finally {
    for (const resolve of pending) resolve();
    await settle();
    globalThis.fetch = originalFetch;
  }
});
}
