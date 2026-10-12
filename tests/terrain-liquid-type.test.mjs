// 12.10 7.31 — «зеленая скверна стала красной магмой». Outland's terrain liquid is all old-format MCLQ,
// and the map extractor writes its magma as LiquidType 3; Wow.exe draws it as 15, Green Lava, while
// the map is 530 (CMapChunk 0x007c5690). See src/world/TerrainLiquidType.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { TerrainClient, terrainGrid } from "../dist/code/browser/Terrain.js";
import {
  LIQUID_TYPE_GREEN_LAVA, LIQUID_TYPE_MAGMA, OUTLAND_MAP, terrainLiquidEntry,
} from "../dist/code/world/TerrainLiquidType.js";

test("0x007c5690: on map 530 an MCLQ magma chunk is Green Lava; nothing else changes", () => {
  assert.equal(terrainLiquidEntry(OUTLAND_MAP, LIQUID_TYPE_MAGMA), LIQUID_TYPE_GREEN_LAVA);
  assert.equal(terrainLiquidEntry(OUTLAND_MAP, 2), 2, "Outland's ocean stays ocean");
  assert.equal(terrainLiquidEntry(OUTLAND_MAP, 1), 1);
  assert.equal(terrainLiquidEntry(0, LIQUID_TYPE_MAGMA), LIQUID_TYPE_MAGMA, "Blackrock's magma stays red");
  assert.equal(terrainLiquidEntry(571, 181), 181, "Northrend's MH2O rows are their own");
});

const fourCC = (bytes, offset, text) => { for (let index = 0; index < 4; index++) bytes[offset + index] = text.charCodeAt(index); };

/** A flat TrinityCore tile with one header-only liquid: magma flag, entry 3, level 5 — an MCLQ magma tile. */
function magmaTile() {
  const heightOffset = 44, liquidOffset = 60;
  const data = new ArrayBuffer(liquidOffset + 16);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  fourCC(bytes, 0, "MAPS");
  view.setUint32(4, 10, true);
  view.setUint32(20, heightOffset, true);
  view.setUint32(28, liquidOffset, true);
  view.setUint32(32, 16, true);
  fourCC(bytes, heightOffset, "MHGT");
  view.setUint32(heightOffset + 4, 0x01, true);
  fourCC(bytes, liquidOffset, "MLIQ");
  view.setUint8(liquidOffset + 4, 0x03); // no per-chunk arrays, no per-cell heights
  view.setUint8(liquidOffset + 5, 0x04); // MAP_LIQUID_TYPE_MAGMA
  view.setUint16(liquidOffset + 6, LIQUID_TYPE_MAGMA, true);
  view.setUint8(liquidOffset + 10, 128);
  view.setUint8(liquidOffset + 11, 128);
  view.setFloat32(liquidOffset + 12, 5, true);
  return data;
}

test("TerrainClient answers Green Lava over Outland's magma and Magma elsewhere", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(magmaTile(), { status: 200 });
  try {
    const terrain = new TerrainClient("ws://example.test:1234/world");
    assert.deepEqual(terrainGrid(0, 0), { x: 32, y: 32 });
    for (const map of [OUTLAND_MAP, 0]) {
      terrain.heightAt(map, 0, 0); // asks for the tile
      for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve));
    }
    const outland = terrain.liquidAt(OUTLAND_MAP, 0, 0);
    assert.equal(outland?.entry, LIQUID_TYPE_GREEN_LAVA);
    assert.equal(outland?.height, 5);
    assert.equal(terrain.liquidAt(0, 0, 0)?.entry, LIQUID_TYPE_MAGMA);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
