// 05.10-A7b-7 (7.06, 7.16): the browser half of `terrain-splat-v2` — `?v=2` on the files whose bytes
// changed, the layer array at the side `splat.json` names (256 when an older gateway names none),
// one decoded layer per id and side, and the baked-shadow strength per lighting preset.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  TERRAIN_SPLAT_CLIENT_VERSION, TerrainSplatClient, setTerrainBakedShadowStrength,
  terrainBakedShadowStrength, terrainBakedShadowStrengthValue, terrainSplatLayerSize,
} from "../dist/code/browser/TerrainSplat.js";

const layerId = (value) => value.repeat(40);
const settle = async (turns = 8) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

test("terrainSplatLayerSize: 256 or 512 as named, 256 for anything else (an older gateway names none)", () => {
  assert.equal(terrainSplatLayerSize({ layers: [], layerSize: 512 }), 512);
  assert.equal(terrainSplatLayerSize({ layers: [], layerSize: 256 }), 256);
  assert.equal(terrainSplatLayerSize({ layers: [] }), 256);
  for (const odd of [1024, 128, "512", 511.5, null, -1]) assert.equal(terrainSplatLayerSize({ layerSize: odd }), 256, String(odd));
  assert.equal(terrainSplatLayerSize(null), 256);
});

test("terrainBakedShadowStrength: full on the classic path, off on the enhanced and cinematic presets", () => {
  assert.equal(terrainBakedShadowStrength(0), 1);
  assert.equal(terrainBakedShadowStrength(1), 0);
  assert.equal(terrainBakedShadowStrength(2), 0);
  setTerrainBakedShadowStrength(0.25);
  assert.equal(terrainBakedShadowStrengthValue(), 0.25);
  setTerrainBakedShadowStrength(7);
  assert.equal(terrainBakedShadowStrengthValue(), 1);
  setTerrainBakedShadowStrength(-3);
  assert.equal(terrainBakedShadowStrengthValue(), 0);
  setTerrainBakedShadowStrength(Number.NaN);
  assert.equal(terrainBakedShadowStrengthValue(), 1, "a broken value falls back to the classic look");
});

/** Fetch, bitmap and canvas mocks that record what was asked and at which size layers decode. */
function installMocks(splats) {
  const saved = {
    fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap,
    OffscreenCanvas: globalThis.OffscreenCanvas, load: THREE.TextureLoader.prototype.load,
  };
  const urls = [];
  const canvasSides = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const path = new URL(String(url)).pathname;
    const splat = /^\/terrain-splat\/\d+\/(\d+)\/(\d+)$/.exec(path);
    if (splat) return new Response(JSON.stringify(splats[`${splat[1]}-${splat[2]}`]), { status: 200 });
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) {
      this.width = width;
      canvasSides.push(`${width}x${height}`);
    }
    getContext() {
      const side = this.width;
      return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(side * side * 4) }) };
    }
  };
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    urls.push(String(url));
    const texture = new THREE.Texture();
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  };
  return {
    urls, canvasSides,
    restore() {
      globalThis.fetch = saved.fetch;
      globalThis.createImageBitmap = saved.createImageBitmap;
      globalThis.OffscreenCanvas = saved.OffscreenCanvas;
      THREE.TextureLoader.prototype.load = saved.load;
    },
  };
}

test("TerrainSplatClient: ?v=2 on splat.json and alpha.png only; the array takes the named layerSize", async () => {
  const mocks = installMocks({
    "32-32": { layers: [layerId("a"), layerId("b")], layerSize: 512 },
    "33-32": { layers: [layerId("a")] },
  });
  try {
    assert.equal(TERRAIN_SPLAT_CLIENT_VERSION, 2);
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const big = { x: 32, y: 32 };
    const plain = { x: 33, y: 32 };
    client.setActiveTiles(1, [big, plain]);
    client.get(1, big);
    client.get(1, plain);
    await settle();
    const path = (url) => { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}`; };
    const asked = mocks.urls.map(path);
    assert.ok(asked.includes("/terrain-splat/1/32/32?v=2"));
    assert.ok(asked.includes("/terrain-splat/1/32/32/alpha.png?v=2"));
    assert.ok(asked.includes("/terrain-splat/1/32/32/index.png"), "index.png did not change: no version");
    assert.ok(!asked.some((url) => url.startsWith("/terrain-layer/") && url.includes("v=")), "layer ids carry their own version");

    const bigSplat = client.get(1, big);
    const plainSplat = client.get(1, plain);
    assert.equal(bigSplat?.layers.image.width, 512);
    assert.equal(bigSplat?.layers.image.depth, 2);
    assert.equal(bigSplat?.layers.image.data.length, 512 * 512 * 4 * 2);
    assert.equal(plainSplat?.layers.image.width, 256, "no layerSize is the 256 it always was");
    // Layer "a" is decoded once per side it is used at; "b" once.
    assert.deepEqual(mocks.canvasSides.sort(), ["256x256", "512x512", "512x512"]);
    assert.equal(client.stats.layerRequestEntries, 3);
    assert.equal(client.stats.decodedLayerBytes, 256 * 256 * 4 + 2 * 512 * 512 * 4);

    // Leaving releases both sizes of "a".
    client.setActiveTiles(1, [plain]);
    assert.equal(client.stats.layerRequestEntries, 1);
    assert.equal(client.stats.decodedLayerBytes, 256 * 256 * 4);
    client.dispose();
    assert.equal(client.stats.layerRequestEntries, 0);
  } finally {
    mocks.restore();
  }
});

test("the renderer sets the baked strength from the lighting preset, once per quality change", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  setLightingQuality(quality: number): void {"));
  const end = body.indexOf("\n  }\n");
  assert.match(body.slice(0, end), /setTerrainBakedShadowStrength\(terrainBakedShadowStrength\(next\.quality\)\)/);
  assert.equal(source.split("setTerrainBakedShadowStrength(").length - 1, 1, "and nowhere per frame");
});
