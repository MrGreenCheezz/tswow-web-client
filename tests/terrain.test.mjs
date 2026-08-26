import assert from "node:assert/strict";
import test from "node:test";
import { TerrainClient, TerrainTile, terrainGrid } from "../dist/code/browser/Terrain.js";

function fourCC(bytes, offset, value) {
  for (let index = 0; index < 4; index++) bytes[offset + index] = value.charCodeAt(index);
}

test("terrain readiness distinguishes a pending tile from an empty tile", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const terrain = new TerrainClient("ws://localhost:1234/world");
    assert.equal(terrain.isReady(1, 0, 0), false, "the destination must stay blocked while its tile is pending");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terrain.isReady(1, 0, 0), true, "a completed empty tile is a valid degraded answer");
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
    terrain.heightAt(1, cell(centre.x), cell(centre.y));
    await new Promise((resolve) => setImmediate(resolve));
    const before = terrain.tileRevision(1, centre);

    // The corner cell at (33, 33) is diagonal to the centre tile. Its arrival must invalidate the
    // centre tile even though terrain normals only borrow cardinal neighbours.
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
  assert.deepEqual(terrainGrid(0, 0), { x: 32, y: 32 });
  assert.ok(Math.abs(tile.heightAt(0, 0) - (10 + 1280 / 255)) < 0.0001);
  assert.equal(tile.isHole(0, 0), true);
  assert.equal(tile.isHole(-20, -20), false);
  // `cells` false: this tile carries one level for the whole of it, which is what 1,729 of the
  // world's 3,196 liquid tiles do, and it is why the ground test cannot be dropped there.
  assert.deepEqual(tile.liquidAt(0, 0), { height: 15, type: 1, entry: 81, cells: false });
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
