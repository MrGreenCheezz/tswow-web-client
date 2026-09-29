import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  surfaceNormal, terrainGeometryData, terrainGeometrySteps, terrainHeightField, terrainNormals,
} from "../dist/code/browser/TerrainGeometry.js";
import { TERRAIN_GRID_SIZE } from "../dist/code/browser/Terrain.js";

// Captured from the original WorldRenderer3D terrain functions before extraction.
// Hashes cover every Float32 bit and the complete triangle index sequence.
const GOLDEN = {
  slope: {
    height: "55e8717465c875dc192711971f1869de902e7f116d40e0c630582486f2b56924",
    normal: "b954728a4725c0c153ee1b1ebb50e847079dcc98c64515c1648f2af50cd444ea",
    positions: "7dd74f014b6dad0b537ca2e080155220f49b571fbb6f9df428ed7a02da8e73f9",
    normals: "59953e4600663f6d628cbd76ea3801847cca7bf1233410457776b3fea3e0a7fc",
    uvs: "abca48ef903b3696ee06055a0f8d3439b759cc7a6bfba78acb8408078e43be69",
    indices: "fc0c7369bc157b3ee811fad1c203da8b3ad0ddfd307b010bc6141b48d9801920",
    indexCount: 196608,
  },
  holes: {
    height: "55e8717465c875dc192711971f1869de902e7f116d40e0c630582486f2b56924",
    normal: "b954728a4725c0c153ee1b1ebb50e847079dcc98c64515c1648f2af50cd444ea",
    positions: "7dd74f014b6dad0b537ca2e080155220f49b571fbb6f9df428ed7a02da8e73f9",
    normals: "15f83482e6181f8ae6233240a90c94e4787eb1ae630246a3dc37c600557002a0",
    uvs: "abca48ef903b3696ee06055a0f8d3439b759cc7a6bfba78acb8408078e43be69",
    indices: "fd5fed73caff43d244ab12e9072bb453f8cef5f9adcd63f25399d660cff796be",
    indexCount: 194328,
  },
  missing: {
    height: "a19eeeb9e53545f1405d662a46b9a9feb5ac53a2ee3cdfc0174bea968a5cafa3",
    normal: "30031e2501d77d8dcaf3cd06700c6ae63bb1fd66908d904bcfe46199700f4784",
    positions: "7ecf6c32f1a05af2f5dcc0db62618094b43d3a00fef265bd5f84c74c011daed0",
    normals: "24bc772302334d63c610a5e5ea222cda18f233cf2bf7d3cd0b3c8f96ecfeb155",
    uvs: "abca48ef903b3696ee06055a0f8d3439b759cc7a6bfba78acb8408078e43be69",
    indices: "fc0c7369bc157b3ee811fad1c203da8b3ad0ddfd307b010bc6141b48d9801920",
    indexCount: 196608,
  },
};

const grid = { x: 32, y: 32 };
const player = { x: -250, y: -250, z: 13 };
const slope = (x, y) => 7 + x * .04 - y * .03 + Math.sin(x * .1) * 2;
const holes = (x, y) => x < -200 && x > -240 && y < -90 && y > -170;
const missing = (x, y) =>
  x < -TERRAIN_GRID_SIZE || x > 0 || y < -TERRAIN_GRID_SIZE || y > 0
    ? undefined : slope(x, y);
const hash = value => createHash("sha256")
  .update(Buffer.from(value.buffer, value.byteOffset, value.byteLength)).digest("hex");
const geometryHashes = geometry => ({
  positions: hash(geometry.positions),
  normals: hash(geometry.normals),
  uvs: hash(geometry.uvs),
  indices: hash(Uint32Array.from(geometry.indices)),
  indexCount: geometry.indices.length,
});

for (const [name, sample, hole] of [
  ["slope", slope, undefined],
  ["holes", slope, holes],
  ["missing", missing, undefined],
]) {
  test(`terrain geometry preserves original ${name} data`, () => {
    const heights = terrainHeightField(grid, player, sample);
    assert.equal(hash(heights), GOLDEN[name].height);
    assert.equal(hash(terrainNormals(heights)), GOLDEN[name].normal);
    assert.deepEqual(geometryHashes(terrainGeometryData(grid, player, sample, hole)), {
      positions: GOLDEN[name].positions,
      normals: GOLDEN[name].normals,
      uvs: GOLDEN[name].uvs,
      indices: GOLDEN[name].indices,
      indexCount: GOLDEN[name].indexCount,
    });
  });
}

test("stepwise construction bounds each resume and reaches the original result", () => {
  let samples = 0;
  let holeChecks = 0;
  const steps = terrainGeometrySteps(grid, player,
    (x, y) => { samples++; return slope(x, y); },
    (x, y) => { holeChecks++; return holes(x, y); });
  let yields = 0;
  let result;
  while (true) {
    const beforeSamples = samples;
    const beforeHoles = holeChecks;
    result = steps.next();
    assert.ok(samples - beforeSamples <= 1024, "one resume sampled too much height data");
    assert.ok(holeChecks - beforeHoles <= 512, "one resume built too many fans");
    if (result.done) break;
    yields++;
  }
  assert.ok(yields >= 100, "construction must be split across many frames");
  assert.ok(samples > 30000 && holeChecks === 16384);
  assert.equal(result.value.indices.length, 194328);
  assert.equal(hash(result.value.positions), GOLDEN.holes.positions);
  assert.equal(hash(result.value.normals), GOLDEN.holes.normals);
});

test("single surface normal remains available", () => {
  assert.deepEqual(surfaceNormal(1, -1, 2, -2, 1), [-1 / Math.sqrt(6), 1 / Math.sqrt(6), 2 / Math.sqrt(6)]);
});





test("terrain indices retain the final bounded uint16 backing, including hole truncation", () => {
  const geometry = terrainGeometryData(grid, player, slope, holes);
  assert.ok(geometry.indices instanceof Uint16Array);
  assert.equal(geometry.indices.length, GOLDEN.holes.indexCount);
  assert.equal(geometry.indices.buffer.byteLength, 128 * 128 * 12 * 2);
  assert.ok(geometry.indices.every(index => index < geometry.positions.length / 3));
});
