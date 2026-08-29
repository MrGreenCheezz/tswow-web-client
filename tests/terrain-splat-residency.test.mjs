import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { TerrainSplatClient } from "../dist/code/browser/TerrainSplat.js";
import { ResourceAccountingLedger } from "../dist/code/browser/ResourceAccounting.js";

const LAYER_BYTES = 256 * 256 * 4;
const layerId = (value) => value.repeat(40);
const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

function installDecodedImageMocks() {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(LAYER_BYTES) }),
      };
    }
  };
  return () => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
  };
}

function countTextureDisposals() {
  const originalDispose = THREE.Texture.prototype.dispose;
  const counts = new Map();
  THREE.Texture.prototype.dispose = function () {
    counts.set(this, (counts.get(this) ?? 0) + 1);
    originalDispose.call(this);
  };
  return {
    counts,
    restore: () => { THREE.Texture.prototype.dispose = originalDispose; },
  };
}

function automaticTextureLoader(created) {
  return function (_url, onLoad) {
    const texture = new THREE.Texture();
    created.push(texture);
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  };
}

test("active tracking prevents direct get from starting an off-active splat request", () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    return new Promise(() => {});
  };
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    client.setActiveTiles(1, [{ x: 32, y: 32 }]);
    assert.equal(client.get(1, { x: 31, y: 32 }), undefined);
    assert.equal(requests, 0);
    assert.equal(client.stats.active, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TerrainSplatClient evicts active-only GPU tiles and their decoded layer leases", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const restoreImages = installDecodedImageMocks();
  const disposal = countTextureDisposals();
  const created = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/terrain-splat/")) {
      return new Response(JSON.stringify({ layers: [layerId("a")], mccv: true }), { status: 200 });
    }
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  THREE.TextureLoader.prototype.load = automaticTextureLoader(created);
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const grid = { x: 32, y: 32 };
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await settle();
    assert.deepEqual(client.stats, {
      resident: 1,
      failed: 0,
      active: 0,
      decodedLayerBytes: LAYER_BYTES,
      layerRequestEntries: 1,
    });

    client.setActiveTiles(undefined, []);
    assert.deepEqual(client.stats, {
      resident: 0,
      failed: 0,
      active: 0,
      decodedLayerBytes: 0,
      layerRequestEntries: 0,
    });
    const ledger = new ResourceAccountingLedger();
    client.visitRetainedResources(ledger);
    assert.equal(ledger.snapshot().cpu.uniqueResources, 0);
    assert.equal(ledger.snapshot().gpuTextures.uniqueResources, 0);
    assert.equal(disposal.counts.size, 4, "array, alpha, index, and MCCV are all disposed");
    assert.ok([...disposal.counts.values()].every((count) => count === 1), "each texture is disposed once");
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    restoreImages();
    disposal.restore();
  }
});

test("shared decoded splat layers live until the last active tile releases its lease", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const restoreImages = installDecodedImageMocks();
  const created = [];
  let layerFetches = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/terrain-splat/")) {
      return new Response(JSON.stringify({ layers: [layerId("b")] }), { status: 200 });
    }
    layerFetches++;
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  THREE.TextureLoader.prototype.load = automaticTextureLoader(created);
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const first = { x: 31, y: 32 };
    const second = { x: 32, y: 32 };
    client.setActiveTiles(1, [first, second]);
    client.get(1, first);
    client.get(1, second);
    await settle();
    assert.equal(layerFetches, 1);
    assert.deepEqual([client.stats.resident, client.stats.decodedLayerBytes, client.stats.layerRequestEntries], [2, LAYER_BYTES, 1]);

    client.setActiveTiles(1, [second]);
    assert.deepEqual([client.stats.resident, client.stats.decodedLayerBytes, client.stats.layerRequestEntries], [1, LAYER_BYTES, 1]);
    client.setActiveTiles(undefined, []);
    assert.deepEqual([client.stats.resident, client.stats.decodedLayerBytes, client.stats.layerRequestEntries], [0, 0, 0]);
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    restoreImages();
  }
});

test("deactivation cancels pending splat ownership and re-entry starts a new request", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const restoreImages = installDecodedImageMocks();
  const disposal = countTextureDisposals();
  const pendingTextures = [];
  let metadataRequests = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/terrain-splat/")) {
      metadataRequests++;
      return new Response(JSON.stringify({ layers: [layerId("c")] }), { status: 200 });
    }
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  THREE.TextureLoader.prototype.load = function (url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    pendingTextures.push({ url: String(url), texture, onLoad, onError });
    return texture;
  };
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const grid = { x: 32, y: 32 };
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await settle(2);
    assert.equal(pendingTextures.length, 2);
    assert.deepEqual([client.stats.active, client.stats.decodedLayerBytes, client.stats.layerRequestEntries], [1, LAYER_BYTES, 1]);
    const pendingLedger = new ResourceAccountingLedger();
    client.visitRetainedResources(pendingLedger);
    assert.equal(pendingLedger.snapshot().gpuTextures.uniqueResources, 2);

    client.setActiveTiles(undefined, []);
    assert.deepEqual([client.stats.active, client.stats.decodedLayerBytes, client.stats.layerRequestEntries], [0, 0, 0]);
    const cancelledLedger = new ResourceAccountingLedger();
    client.visitRetainedResources(cancelledLedger);
    assert.equal(cancelledLedger.snapshot().gpuTextures.uniqueResources, 0);
    for (const pending of pendingTextures.splice(0)) pending.onLoad?.(pending.texture);
    await settle();
    assert.equal(client.stats.resident, 0, "late texture completion cannot install the deactivated tile");
    assert.ok([...disposal.counts.values()].every((count) => count === 1));

    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await settle(2);
    assert.equal(metadataRequests, 2, "re-entry creates a new metadata request");
    assert.equal(pendingTextures.length, 2, "re-entry creates new texture requests");
    client.setActiveTiles(undefined, []);
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    restoreImages();
    disposal.restore();
  }
});

test("one failed splat texture waits for siblings then disposes every created handle", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const restoreImages = installDecodedImageMocks();
  const disposal = countTextureDisposals();
  const pending = new Map();
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/terrain-splat/")) {
      return new Response(JSON.stringify({ layers: [layerId("d")], mccv: true }), { status: 200 });
    }
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  THREE.TextureLoader.prototype.load = function (url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    pending.set(new URL(String(url)).pathname, { texture, onLoad, onError });
    return texture;
  };
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const grid = { x: 32, y: 32 };
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await settle(2);
    pending.get("/terrain-splat/1/32/32/alpha.png").onError?.(new Error("alpha"));
    await settle(2);
    assert.equal(client.stats.active, 1, "a failed sibling does not abandon still-created handles");
    const siblingLedger = new ResourceAccountingLedger();
    client.visitRetainedResources(siblingLedger);
    assert.equal(siblingLedger.snapshot().gpuTextures.uniqueResources, 2, "disposed sibling is not reported as live");
    for (const suffix of ["index.png", "mccv.png"]) {
      const texture = pending.get(`/terrain-splat/1/32/32/${suffix}`);
      texture.onLoad?.(texture.texture);
    }
    await settle();
    assert.deepEqual(client.stats, {
      resident: 0,
      failed: 1,
      active: 0,
      decodedLayerBytes: 0,
      layerRequestEntries: 0,
    });
    assert.equal(disposal.counts.size, 3);
    assert.ok([...disposal.counts.values()].every((count) => count === 1));
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    restoreImages();
    disposal.restore();
  }
});

test("an old released layer promise cannot mutate its replacement record", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const restoreImages = installDecodedImageMocks();
  const layers = [];
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/terrain-splat/")) {
      return new Response(JSON.stringify({ layers: [layerId("e")] }), { status: 200 });
    }
    const pending = deferred();
    layers.push(pending);
    return pending.promise;
  };
  THREE.TextureLoader.prototype.load = automaticTextureLoader([]);
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    const grid = { x: 32, y: 32 };
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await settle(2);
    client.setActiveTiles(undefined, []);
    client.setActiveTiles(1, [grid]);
    client.get(1, grid);
    await settle(2);
    assert.equal(layers.length, 2);

    layers[0].resolve(new Response(new Blob([new Uint8Array([1])]), { status: 200 }));
    await settle();
    assert.deepEqual([client.stats.decodedLayerBytes, client.stats.layerRequestEntries], [0, 1]);
    layers[1].resolve(new Response(new Blob([new Uint8Array([1])]), { status: 200 }));
    await settle();
    assert.deepEqual([client.stats.resident, client.stats.decodedLayerBytes, client.stats.layerRequestEntries], [1, LAYER_BYTES, 1]);
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    restoreImages();
  }
});

test("dispose is idempotent and late splat completions are inert", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const restoreImages = installDecodedImageMocks();
  const disposal = countTextureDisposals();
  const pendingTextures = [];
  let requests = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/terrain-splat/")) {
      requests++;
      return new Response(JSON.stringify({ layers: [layerId("f")] }), { status: 200 });
    }
    return new Response(new Blob([new Uint8Array([1])]), { status: 200 });
  };
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    const texture = new THREE.Texture();
    pendingTextures.push({ texture, onLoad });
    return texture;
  };
  try {
    const client = new TerrainSplatClient("ws://example.test:1234/world");
    client.get(1, { x: 32, y: 32 });
    assert.equal(requests, 1);
    await settle(2);
    assert.equal(pendingTextures.length, 2);
    client.dispose();
    client.dispose();
    for (const pending of pendingTextures) pending.onLoad?.(pending.texture);
    await settle();
    assert.deepEqual(client.stats, {
      resident: 0,
      failed: 0,
      active: 0,
      decodedLayerBytes: 0,
      layerRequestEntries: 0,
    });
    assert.equal(disposal.counts.size, 2);
    assert.ok([...disposal.counts.values()].every((count) => count === 1));
    client.get(1, { x: 32, y: 32 });
    assert.equal(requests, 1, "a disposed client cannot restart requests");
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    restoreImages();
    disposal.restore();
  }
});
