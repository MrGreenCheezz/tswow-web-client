import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { ResourceAccountingLedger, visitMaterialTextures } from "../dist/code/browser/ResourceAccounting.js";
import { visitModelEffectsResources } from "../dist/code/browser/ParticleRender.js";
import { EnvironmentClient } from "../dist/code/browser/Terrain.js";
import { LiquidTextureClient } from "../dist/code/browser/Water.js";
import { WeatherEffect } from "../dist/code/browser/WeatherEffect.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import {
  GROUND_COVER_SIZE, GROUND_COVER_MAGIC, GroundCoverClient,
} from "../dist/code/browser/GroundCover.js";
import { HorizonClient } from "../dist/code/browser/Horizon.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function rgbaTexture(width = 2, height = 1) {
  return new THREE.DataTexture(new Uint8Array(width * height * 4), width, height);
}

function wvm9WithVertices() {
  const data = new ArrayBuffer(112);
  const view = new DataView(data);
  view.setUint8(0, 0x57); view.setUint8(1, 0x56); view.setUint8(2, 0x4d); view.setUint8(3, 0x39);
  view.setUint32(4, 1, true); // vertex count
  view.setUint32(8, 0, true); // index count
  view.setUint8(12, 2); // index width
  view.setUint16(14, 0, true); // submeshes
  view.setUint16(16, 0, true); // batches
  view.setUint16(18, 0, true); // textures
  view.setUint32(24, data.byteLength, true);
  return data;
}

function wvm1WithNumberArrays() {
  const data = new ArrayBuffer(36);
  const view = new DataView(data);
  view.setUint8(0, 0x57); view.setUint8(1, 0x56); view.setUint8(2, 0x4d); view.setUint8(3, 0x31);
  view.setUint32(4, 1, true); // vertex count
  view.setUint32(8, 0, true); // index count
  return data;
}

test("model effects visit exact simulation backings once, including shared global sequences", () => {
  const globalSequences = new Uint32Array([250]);
  const effects = {
    emitters: [{
      particles: { matrix: new Float64Array(16), globalSequences },
      ribbon: { globalSequences },
    }],
  };
  const ledger = new ResourceAccountingLedger();

  visitModelEffectsResources(ledger, effects, effects);
  const first = ledger.snapshot();
  visitModelEffectsResources(ledger, effects, effects);
  const second = ledger.snapshot();

  assert.equal(first.cpu.uniqueRetainedBytes, 16 * Float64Array.BYTES_PER_ELEMENT
    + Uint32Array.BYTES_PER_ELEMENT);
  assert.equal(first.cpu.uniqueResources, 2);
  assert.deepEqual(second.cpu, first.cpu, "repeated effect visits remain idempotent");
});

test("EnvironmentClient counts only successful cached model typed backings, exactly once", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => String(url).includes("Numbers.m2") ? wvm1WithNumberArrays() : wvm9WithVertices(),
  });
  try {
    const client = new EnvironmentClient("ws://cache.test/world");
    client.model("Cached.m2");
    await settle();
    await settle();
    const ledger = new ResourceAccountingLedger();
    client.visitRetainedResources(ledger);
    const first = ledger.snapshot();
    client.visitRetainedResources(ledger);
    const second = ledger.snapshot();
    assert.equal(first.cpu.uniqueRetainedBytes, 40, "four WVM9 vertex/UV typed arrays: 12+12+8+8");
    assert.equal(first.cpu.uniqueResources, 6, "WVM9 also retains two empty typed-array backings");
    assert.deepEqual(second.cpu, first.cpu, "repeated cache visits are idempotent");

    const numberArraysOnly = new EnvironmentClient("ws://cache.test/world");
    numberArraysOnly.model("Numbers.m2");
    await settle();
    await settle();
    const numberLedger = new ResourceAccountingLedger();
    numberArraysOnly.visitRetainedResources(numberLedger);
    assert.equal(numberLedger.snapshot().cpu.uniqueResources, 0, "JS number arrays are not byte guesses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("liquid strips and cached model textures are visited only after successful cache hits", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/liquid/")) return { ok: true, status: 200, json: async () => ({ frames: 30 }) };
    return { ok: true, status: 200 };
  };
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    const texture = rgbaTexture();
    onLoad?.(texture);
    return texture;
  };
  try {
    const liquids = new LiquidTextureClient("ws://cache.test/world");
    liquids.get("water");
    await settle();
    await settle();
    const cached = new ModelTextureLoader({ cache: true });
    cached.load("spell.png");
    cached.load("spell.png");
    const uncached = new ModelTextureLoader();
    uncached.load("not-retained.png");
    const ledger = new ResourceAccountingLedger();
    // No liquid material is created here: the loaded strip is deliberately unbound, so the cache
    // visitor itself must keep it visible to resource accounting.
    liquids.visitRetainedResources(ledger);
    cached.visitRetainedResources(ledger);
    uncached.visitRetainedResources(ledger);
    const first = ledger.snapshot();
    liquids.visitRetainedResources(ledger);
    cached.visitRetainedResources(ledger);
    const second = ledger.snapshot();
    assert.equal(first.gpuTextures.uniqueResources, 2);
    assert.equal(first.gpuTextures.estimatedLogicalTextureBytes, 16, "two 2x1 RGBA textures");
    assert.deepEqual(second.gpuTextures, first.gpuTextures);
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});

test("a loaded liquid strip and its later material binding share one ledger resource", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/liquid/")) return { ok: true, status: 200, json: async () => ({ frames: 30 }) };
    return { ok: true, status: 200 };
  };
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    const texture = rgbaTexture();
    onLoad?.(texture);
    return texture;
  };
  let material;
  try {
    const liquids = new LiquidTextureClient("ws://cache.test/world");
    liquids.get("water");
    await settle();
    await settle();
    const strip = liquids.get("water");
    assert.ok(strip, "the strip must be loaded before it can be bound");
    material = new THREE.MeshBasicMaterial({ map: strip.texture });
    const ledger = new ResourceAccountingLedger();
    liquids.visitRetainedResources(ledger);
    visitMaterialTextures(ledger, material);
    const snapshot = ledger.snapshot().gpuTextures;
    assert.equal(snapshot.uniqueResources, 1);
    assert.equal(snapshot.owners, 2, "cache and bound material are distinct owners");
    assert.equal(snapshot.references, 2);
    assert.equal(snapshot.sharedResources, 1);
  } finally {
    material?.dispose();
    THREE.TextureLoader.prototype.load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});

test("weather, ground-cover, and horizon cache visitors retain their exact resource leaves", async () => {
  const weatherTexture = rgbaTexture();
  const weather = new WeatherEffect(() => weatherTexture);
  weather.set({ kind: "rain", density: 1, storm: 0 }, false);
  const ledger = new ResourceAccountingLedger();
  weather.visitRetainedResources(ledger);
  const before = ledger.snapshot();
  weather.visitRetainedResources(ledger);
  assert.equal(ledger.snapshot().gpuTextures.uniqueResources, before.gpuTextures.uniqueResources);
  assert.ok(before.gpuBuffers.uniqueResources > 0);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes("ground-effects")) return { ok: true, status: 200, json: async () => ({ models: [], effects: {} }) };
    if (path.includes("cover.bin")) {
      const data = new ArrayBuffer(GROUND_COVER_SIZE);
      const bytes = new Uint8Array(data);
      bytes.set([...GROUND_COVER_MAGIC].map((value) => value.charCodeAt(0)));
      bytes[4] = 1; bytes[5] = 40;
      new DataView(data).setUint16(6, 256, true);
      return { ok: true, status: 200, arrayBuffer: async () => data };
    }
    const mareOffset = 8 + 4096 * 4;
    const mareBytes = (17 * 17 + 16 * 16) * 2;
    const data = new ArrayBuffer(mareOffset + 8 + mareBytes);
    const bytes = new Uint8Array(data);
    bytes.set([0x46, 0x4f, 0x41, 0x4d]); // reversed on purpose: decoder reads MAOF
    new DataView(data).setUint32(4, 4096 * 4, true);
    new DataView(data).setUint32(8, mareOffset, true);
    bytes.set([0x45, 0x52, 0x41, 0x4d], mareOffset);
    new DataView(data).setUint32(mareOffset + 4, mareBytes, true);
    return { ok: true, status: 200, arrayBuffer: async () => data };
  };
  try {
    const ground = new GroundCoverClient("ws://cache.test/world");
    ground.get(1, { x: 0, y: 0 });
    const horizon = new HorizonClient("ws://cache.test/world");
    horizon.get(1);
    await settle();
    await settle();
    const cacheLedger = new ResourceAccountingLedger();
    ground.visitRetainedResources(cacheLedger);
    horizon.visitRetainedResources(cacheLedger);
    const snapshot = cacheLedger.snapshot();
    assert.equal(snapshot.cpu.uniqueRetainedBytes, 10240 + 1090);
    ground.visitRetainedResources(cacheLedger);
    horizon.visitRetainedResources(cacheLedger);
    assert.deepEqual(cacheLedger.snapshot().cpu, snapshot.cpu);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("R1 cache visitors are wired through the frame capture and renderer cache paths", async () => {
  const loop = await readFile("src/browser/game/Loop.ts", "utf8");
  const world = await readFile("src/browser/WorldRenderer3D.ts", "utf8");
  assert.match(loop, /game\.environment\?\.visitRetainedResources\(accounting\)/);
  assert.match(loop, /game\.liquids\?\.visitRetainedResources\(accounting\)/);
  assert.match(loop, /game\.groundCover\?\.visitRetainedResources\(accounting\)/);
  assert.match(loop, /game\.horizon\?\.visitRetainedResources\(accounting\)/);
  assert.match(world, /#spellTextures\.visitRetainedResources\(visitor\)/);
  assert.match(world, /#worldMaterials\.visitRetainedResources\(visitor\)/);
  assert.match(world, /#weather\?\.visitRetainedResources\(visitor\)/);
  assert.match(world, /#portraits\.visitRetainedResources\(visitor\)/);
  assert.match(world, /this\.\#liquidTextures\?\.visitRetainedResources\(visitor\)/);
  assert.match(world, /referenceGpuRenderTarget\(this\.#sun, shadow\.map\)/);
});
