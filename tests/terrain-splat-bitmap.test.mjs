import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { TerrainSplatClient } from "../dist/code/browser/TerrainSplat.js";

// The alpha, index and vertex-colour maps are decoded off the main thread. What WebGL's own <img>
// upload did to them has to be what the decoder is asked for: rows flipped (the Texture default),
// colour neither premultiplied nor colour-managed, and the unpack flip not applied a second time.
test("splat image maps are decoded as bitmaps with WebGL's own unpack rules", async () => {
  const originals = {
    fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap,
    ImageBitmap: globalThis.ImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas,
    load: THREE.TextureLoader.prototype.load,
  };
  const decoded = [];
  class FakeImageBitmap {
    constructor(width, height) { this.width = width; this.height = height; this.closed = false; }
    close() { this.closed = true; }
  }
  globalThis.ImageBitmap = FakeImageBitmap;
  globalThis.createImageBitmap = async (blob, options) => {
    const bitmap = new FakeImageBitmap(1024, 1024);
    decoded.push({ size: blob.size, options, bitmap });
    return bitmap;
  };
  globalThis.OffscreenCanvas = class {
    getContext() {
      return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4) }) };
    }
  };
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/32/32")) {
      return new Response(JSON.stringify({ layers: ["b".repeat(40)], mccv: true }), { status: 200 });
    }
    return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });
  };
  THREE.TextureLoader.prototype.load = () => { throw new Error("the <img> path must not be used"); };
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    assert.equal(client.get(0, { x: 32, y: 32 }), undefined);
    let splat;
    for (let turn = 0; turn < 20 && !splat; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
      splat = client.get(0, { x: 32, y: 32 });
    }
    assert.ok(splat, "the tile resolved");
    const maps = [splat.alpha, splat.index, splat.colours];
    // One layer decode (read back to pixels) plus the three maps kept as bitmaps.
    const kept = decoded.filter(({ options }) => options !== undefined);
    assert.equal(kept.length, 3);
    for (const { options } of kept) {
      assert.deepEqual(options, { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    }
    for (const texture of maps) {
      assert.ok(texture.image instanceof FakeImageBitmap);
      assert.equal(texture.flipY, false, "the decoder already flipped the rows");
      assert.equal(texture.premultiplyAlpha, false);
    }
    assert.equal(splat.alpha.colorSpace, THREE.NoColorSpace);
    assert.equal(splat.colours.colorSpace, THREE.NoColorSpace);
    client.dispose();
    for (const texture of maps) assert.equal(texture.image.closed, true, "disposing the texture frees its bitmap");
  } finally {
    globalThis.fetch = originals.fetch;
    globalThis.createImageBitmap = originals.createImageBitmap;
    globalThis.ImageBitmap = originals.ImageBitmap;
    globalThis.OffscreenCanvas = originals.OffscreenCanvas;
    THREE.TextureLoader.prototype.load = originals.load;
  }
});
