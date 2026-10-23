// 23.10 (7.48 step 2): «Чёткие текстуры мира» in the browser — which URLs carry `hd=` (only with the setting, BC7
// support and a published generation; only ground layers and building textures), how a compressed answer becomes a
// BC7 texture (and a PNG answer stays the bitmap it always was), the ground array built from compressed layers,
// what it costs in the accounting, and the setting's plumbing (off by default, off in the comparison profile).
import assert from "node:assert/strict";
import test from "node:test";
import v8 from "node:v8";
import * as THREE from "three";

import { compressTexture } from "../tools/hd-texture-bc7.mjs";
import { noteGatewayAssetGenerations, resetGatewayGeneration } from "../dist/code/browser/GatewayGeneration.js";
import {
  compressedLayerArray, hdWorldTexturesActive, isHdWorldTextureUrl, setHdWorldTexturesEnabled, withHdWorldTexture,
} from "../dist/code/browser/HdWorldTextures.js";
import { parseHdTexture } from "../dist/code/browser/HdTextureContainer.js";
import { ModelTextureLoader, registerPendingTextureView } from "../dist/code/browser/TextureLoad.js";
import { TerrainSplatClient, setTerrainSpecularStrength, terrainGlintDrawn } from "../dist/code/browser/TerrainSplat.js";
import { knownLogicalTextureBytes } from "../dist/code/browser/ResourceAccounting.js";
import { ENHANCED_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/EnhancedGraphics.js";
import { COMPARISON_GRAPHICS_OVERRIDES } from "../dist/code/browser/ui/ComparisonProfile.js";
import { defaultSettings, settingDefinition } from "../dist/code/browser/ui/SettingsModel.js";
import { applyRendererGraphicsSettings } from "../dist/code/browser/RendererGraphicsSettings.js";
import { RENDER_WORKER_COMMANDS } from "../dist/code/browser/RenderWorkerClientProtocol.js";

const BASE = "http://gateway.test:8090";
const HG = "bbbbbbbbbbbbbbbbbbbb";
const LAYER = `${BASE}/terrain-layer/${"a".repeat(40)}.png`;
const WALL = `${BASE}/visual/texture/${"c".repeat(40)}-2.png?v=3`;

function picture(side, alpha = 255) {
  const data = new Uint8Array(side * side * 4);
  for (let texel = 0; texel < side * side; texel++) data.set([(texel * 7) % 256, (texel * 3) % 256, 90, alpha], texel * 4);
  return { width: side, height: side, data };
}

test("off, or without BC7, or without a generation: every world URL is what it was; on, only the two world routes gain hd=", () => {
  resetGatewayGeneration();
  noteGatewayAssetGenerations(BASE, undefined, undefined, HG);
  setHdWorldTexturesEnabled(false, true);
  assert.equal(withHdWorldTexture(LAYER), LAYER, "the setting off");
  setHdWorldTexturesEnabled(true, false);
  assert.equal(hdWorldTexturesActive(), false, "no EXT_texture_compression_bptc: the originals");
  assert.equal(withHdWorldTexture(WALL), WALL);
  setHdWorldTexturesEnabled(true, true);
  assert.equal(withHdWorldTexture(LAYER), `${LAYER}?hd=${HG}`);
  assert.equal(withHdWorldTexture(WALL), `${WALL}&hd=${HG}`);
  for (const other of [`${BASE}/texture?path=Tileset%5Cx.blp`, `${BASE}/terrain-splat/0/1/2`, `${BASE}/visual/model?path=x`]) {
    assert.equal(withHdWorldTexture(other), other, other);
  }
  assert.equal(withHdWorldTexture(`http://other:1/terrain-layer/${"a".repeat(40)}.png`), `http://other:1/terrain-layer/${"a".repeat(40)}.png`,
    "another gateway's URL is never decorated");
  noteGatewayAssetGenerations(BASE, undefined, undefined, undefined);
  assert.equal(withHdWorldTexture(LAYER), LAYER, "the gateway stopped publishing a generation");
  assert.equal(isHdWorldTextureUrl(`${BASE}/terrain-layer/zz.png`), false);
  setHdWorldTexturesEnabled(false, false);
  resetGatewayGeneration();
});

class FakeImageBitmap {
  constructor(width, height) { this.width = width; this.height = height; }
  close() {}
}

/** A page whose fetch answers `bodies[url]` (bytes) and whose decoder makes 4×4 bitmaps of anything else. */
async function withPage(bodies, run) {
  const saved = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, ImageBitmap: globalThis.ImageBitmap };
  const decoded = [];
  globalThis.ImageBitmap = FakeImageBitmap;
  globalThis.fetch = async (url) => {
    const body = bodies[String(url)];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
  };
  globalThis.createImageBitmap = async (blob) => {
    decoded.push(await blob.text());
    return new FakeImageBitmap(4, 4);
  };
  try {
    await run(decoded);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

const settle = async (turns = 10) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

test("a building texture answered with a container is a BC7 texture with its levels — for its clones too; a PNG answer stays a bitmap", async () => {
  const container = compressTexture(picture(16, 128)).bytes;
  const hdUrl = `${WALL}&hd=${HG}`;
  const pngUrl = `${BASE}/visual/texture/${"d".repeat(40)}-0.png?v=3&hd=${HG}`;
  const plainUrl = `${BASE}/visual/texture/${"c".repeat(40)}-2.png?v=3`;
  await withPage({ [hdUrl]: container, [pngUrl]: "PNG", [plainUrl]: "PLAIN" }, async (decoded) => {
    const loader = new ModelTextureLoader({ cache: true });
    const texture = loader.load(hdUrl);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    const view = texture.clone();
    registerPendingTextureView(texture, view);
    await settle();
    for (const candidate of [texture, view]) {
      assert.equal(candidate.isCompressedTexture, true);
      assert.equal(candidate.format, THREE.RGBA_BPTC_Format);
      assert.equal(candidate.generateMipmaps, false);
      assert.equal(candidate.flipY, false);
      assert.equal(candidate.mipmaps.length, 5);
      assert.deepEqual([candidate.image.width, candidate.image.height], [16, 16]);
      assert.equal(candidate.colorSpace, THREE.SRGBColorSpace, "sampled as the original: sRGB");
    }
    assert.equal(knownLogicalTextureBytes(texture), parseHdTexture(container).byteLength,
      "priced as its BC7 levels: one byte a texel, a ×2 copy costs what the RGBA original did");

    const fallback = loader.load(pngUrl);
    await settle();
    assert.equal(fallback.isCompressedTexture, false, "the gateway had no copy: the original PNG, decoded as before");
    assert.ok(fallback.image instanceof FakeImageBitmap);
    assert.equal(fallback.format, THREE.RGBAFormat);

    const plain = loader.load(plainUrl);
    await settle();
    assert.equal(plain.isCompressedTexture, false);
    assert.deepEqual(decoded, ["PNG", "PLAIN"], "only bitmaps went through the decoder");
    // A texture's own fields still read and write as before when its source is not compressed.
    plain.generateMipmaps = false;
    assert.equal(plain.generateMipmaps, false);
  });
});

test("perf: model textures keep V8's fast properties and one hidden class — the compressed view lives on the prototype", async () => {
  // Accessors defined on every instance (the first form of the view) put each model texture in dictionary mode, and
  // three reads these textures' fields on every draw; the setting is off by default, so that cost was everyone's.
  v8.setFlagsFromString("--allow-natives-syntax");
  const fast = new Function("o", "return %HasFastProperties(o)");
  const sameMap = new Function("a", "b", "return %HaveSameMap(a, b)");
  const first = `${BASE}/visual/texture/${"e".repeat(40)}-0.png?v=3`;
  const second = `${BASE}/visual/texture/${"f".repeat(40)}-1.png?v=3`;
  await withPage({ [first]: "A", [second]: "B" }, async () => {
    const loader = new ModelTextureLoader({ cache: true });
    const a = loader.load(first);
    const b = loader.load(second);
    a.flipY = false;
    b.flipY = false;
    await settle();
    const view = a.clone();
    for (const texture of [a, b, view]) {
      assert.equal(fast(texture), true, "a model texture is not a dictionary-mode object");
      for (const key of ["mipmaps", "format", "generateMipmaps", "flipY", "isCompressedTexture"]) {
        assert.equal(Object.getOwnPropertyDescriptor(texture, key), undefined, `${key} is read through the prototype`);
      }
    }
    assert.equal(sameMap(a, b), true, "two model textures share one hidden class");
    assert.equal(a.flipY, false);
    assert.equal(b.generateMipmaps, true, "the texture's own values read as before");
  });
});

test("compressed ground layers become one BC7 array, 512² with ten levels, each level every layer back to back", () => {
  const a = parseHdTexture(compressTexture(picture(512)).bytes);
  const b = parseHdTexture(compressTexture(picture(512, 200)).bytes);
  const array = compressedLayerArray([a, b, a]);
  assert.ok(array instanceof THREE.CompressedArrayTexture);
  assert.deepEqual([array.image.width, array.image.height, array.image.depth], [512, 512, 3]);
  assert.equal(array.mipmaps.length, 10);
  assert.equal(array.format, THREE.RGBA_BPTC_Format);
  assert.equal(array.colorSpace, THREE.SRGBColorSpace);
  assert.equal(array.generateMipmaps, false);
  assert.equal(array.wrapS, THREE.RepeatWrapping);
  assert.equal(array.minFilter, THREE.LinearMipmapLinearFilter);
  const size = a.levels[1].data.length;
  assert.deepEqual([...array.mipmaps[1].data.subarray(size, 2 * size)], [...b.levels[1].data]);
  // 256² RGBA8 with mips per layer today; 512² BC7 with mips now — the same bytes within a block's rounding.
  const original = 256 * 256 * 4 * 4 / 3;
  assert.ok(Math.abs(knownLogicalTextureBytes(array) / 3 - original) / original < 0.001, `${knownLogicalTextureBytes(array)}`);
  const small = parseHdTexture(compressTexture(picture(256)).bytes);
  assert.equal(compressedLayerArray([a, small]), undefined, "one array, one side: mixed sides take the original path");
});

test("a ground tile: all layers compressed → a BC7 array; one layer without a copy, or the glint drawn → the originals", async () => {
  resetGatewayGeneration();
  noteGatewayAssetGenerations(BASE, undefined, undefined, HG);
  setHdWorldTexturesEnabled(true, true);
  // The presets: the specular glint is not drawn (strength 0), the only place the HD ground is used.
  setTerrainSpecularStrength(0);
  assert.equal(terrainGlintDrawn(), false);
  const saved = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas,
    ImageBitmap: globalThis.ImageBitmap };
  globalThis.ImageBitmap = FakeImageBitmap;
  const layer = compressTexture(picture(512)).bytes;
  const asked = [];
  globalThis.fetch = async (url) => {
    const text = String(url);
    asked.push(text);
    const path = new URL(text).pathname;
    const tile = /^\/terrain-splat\/0\/(\d+)\/\d+$/.exec(path);
    if (tile) return new Response(JSON.stringify({ layers: tile[1] === "1" ? ["1".repeat(40), "2".repeat(40)] : ["1".repeat(40), "3".repeat(40)] }));
    if (text.includes("hd=") && (path.includes("1111") || path.includes("2222"))) return new Response(layer);
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  };
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return { drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }; }
  };
  try {
    const client = new TerrainSplatClient("ws://gateway.test:8090");
    const statuses = [];
    client.onStatus = (message, error) => { if (error) statuses.push(message); };
    client.get(0, { x: 1, y: 1 });
    client.get(0, { x: 2, y: 1 });
    await settle(30);
    const hd = client.get(0, { x: 1, y: 1 });
    const fallback = client.get(0, { x: 2, y: 1 });
    assert.deepEqual(statuses, []);
    assert.ok(hd.layers instanceof THREE.CompressedArrayTexture, "every layer had a copy");
    assert.equal(hd.layers.image.depth, 2);
    assert.ok(fallback.layers instanceof THREE.DataArrayTexture, "layer 3 had none: the tile is drawn from its originals");
    assert.equal(fallback.layers.image.width, 256);
    assert.equal(asked.filter((url) => url.includes("/terrain-layer/1111") && !url.includes("hd=")).length, 1,
      "only the fallback tile decoded the original of the shared layer");
    assert.equal(hd.specular, undefined, "an HD tile draws no glint (its layers are opaque)");

    // The classic look draws the glint from the original layers' alpha: there the ground stays the original.
    setTerrainSpecularStrength(1);
    assert.equal(terrainGlintDrawn(), true);
    const classic = new TerrainSplatClient("ws://gateway.test:8090");
    classic.get(0, { x: 1, y: 1 });
    await settle(30);
    assert.ok(classic.get(0, { x: 1, y: 1 }).layers instanceof THREE.DataArrayTexture);
    assert.deepEqual(classic.hdTileStats, { hd: 0, fallback: 0, missingLayers: [] }, "not even asked for");
    assert.deepEqual(client.hdTileStats, { hd: 1, fallback: 1, missingLayers: ["3".repeat(40)] });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
    setHdWorldTexturesEnabled(false, false);
    setTerrainSpecularStrength(1);
    resetGatewayGeneration();
  }
});

test("«Чёткие текстуры мира»: off by default, in the comparison profile and (opt-in) outside the enhanced preset; sent to the renderer", () => {
  const definition = settingDefinition("experimentalSharpWorldTextures");
  assert.equal(definition?.label, "Чёткие текстуры мира");
  assert.equal(definition?.fallback, false);
  assert.equal(defaultSettings().experimentalSharpWorldTextures, false);
  assert.equal(ENHANCED_GRAPHICS_OVERRIDES.experimentalSharpWorldTextures, undefined);
  assert.equal(COMPARISON_GRAPHICS_OVERRIDES.experimentalSharpWorldTextures, false);
  assert.equal(RENDER_WORKER_COMMANDS.setHdWorldTextures, "setting");
  const calls = [];
  const renderer = new Proxy({}, {
    get: (_target, name) => (...args) => { if (name === "setHdWorldTextures") calls.push(args[0]); },
  });
  applyRendererGraphicsSettings(renderer, { ...defaultSettings(), experimentalSharpWorldTextures: true }, undefined);
  applyRendererGraphicsSettings(renderer, { ...defaultSettings() }, undefined);
  assert.deepEqual(calls, [true, false]);
});
