import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  ResourceAccountingLedger,
  visitGeometryBuffers,
} from "../dist/code/browser/ResourceAccounting.js";
import { makeRenderTelemetrySnapshot } from "../dist/code/browser/RenderStats.js";
import { TerrainClient } from "../dist/code/browser/Terrain.js";
import { TerrainSplatClient } from "../dist/code/browser/TerrainSplat.js";

test("resource accounting deduplicates full CPU backing buffers by owner-resource pair", () => {
  const ledger = new ResourceAccountingLedger();
  const backing = new ArrayBuffer(64);
  const first = new Uint8Array(backing, 0, 8);
  const second = new Float32Array(backing, 16, 4);
  const opaque = {};

  ledger.referenceCpu("environment", first);
  ledger.referenceCpu("environment", first);
  ledger.referenceCpu("renderer", second);
  ledger.referenceUnsupported("environment", opaque);
  ledger.referenceUnsupported("environment", opaque);
  ledger.referenceUnsupported("renderer", opaque);

  const snapshot = ledger.snapshot();
  assert.deepEqual(snapshot.cpu, {
    uniqueRetainedBytes: 64,
    uniqueResources: 1,
    owners: 2,
    references: 2,
    sharedResources: 1,
  });
  assert.deepEqual(snapshot.gpuBuffers, {
    estimatedGpuBufferBytes: 0,
    uniqueResources: 0,
    owners: 0,
    references: 0,
    sharedResources: 0,
  });
  assert.deepEqual(snapshot.gpuTextures, {
    estimatedLogicalTextureBytes: 0,
    knownByteResources: 0,
    unknownByteResources: 0,
    uniqueResources: 0,
    owners: 0,
    references: 0,
    sharedResources: 0,
  });
  assert.deepEqual(snapshot.gpuRenderbuffers, {
    estimatedLogicalRenderbufferBytes: 0,
    knownByteResources: 0,
    unknownByteResources: 0,
    uniqueResources: 0,
    owners: 0,
    references: 0,
    sharedResources: 0,
  });
  assert.deepEqual(snapshot.unsupported, {
    uniqueResources: 1,
    owners: 2,
    references: 2,
    sharedResources: 1,
  });
  assert.equal(snapshot.coverage.complete, false);
  assert.ok(snapshot.coverage.gaps.some((gap) => gap.includes("multisampled")));
  assert.ok(snapshot.coverage.gaps.some((gap) => gap.includes("decoded image")));
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.cpu));
  assert.ok(Object.isFrozen(snapshot.gpuBuffers));
  assert.ok(Object.isFrozen(snapshot.gpuTextures));
  assert.ok(Object.isFrozen(snapshot.gpuRenderbuffers));
  assert.ok(Object.isFrozen(snapshot.unsupported));
  assert.ok(Object.isFrozen(snapshot.coverage));
  assert.ok(Object.isFrozen(snapshot.coverage.gaps));
});

test("geometry visitor uses BufferAttribute and InterleavedBuffer identities", () => {
  const ledger = new ResourceAccountingLedger();
  const geometry = new THREE.BufferGeometry();
  const positionArray = new Float32Array(9);
  const interleavedArray = new Float32Array(12);
  const interleaved = new THREE.InterleavedBuffer(interleavedArray, 4);
  geometry.setAttribute("position", new THREE.BufferAttribute(positionArray, 3));
  geometry.setAttribute("uv", new THREE.InterleavedBufferAttribute(interleaved, 2, 0));
  geometry.setAttribute("normal", new THREE.InterleavedBufferAttribute(interleaved, 2, 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(3), 1));
  geometry.morphAttributes.position = [new THREE.BufferAttribute(new Float32Array(9), 3)];
  const instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(32), 16);
  const instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(6), 3);

  visitGeometryBuffers(ledger, "mesh-a", geometry, { instanceMatrix, instanceColor });
  visitGeometryBuffers(ledger, "mesh-a", geometry, { instanceMatrix, instanceColor });
  visitGeometryBuffers(ledger, "mesh-b", geometry, { instanceMatrix, instanceColor });

  const morphBytes = geometry.morphAttributes.position[0].array.byteLength;
  const expectedBytes = positionArray.byteLength + interleavedArray.byteLength
    + geometry.index.array.byteLength + geometry.morphAttributes.position[0].array.byteLength
    + instanceMatrix.array.byteLength + instanceColor.array.byteLength;
  const expectedDirectGpuBytes = expectedBytes - morphBytes;
  let snapshot = ledger.snapshot();
  assert.deepEqual(snapshot.cpu, {
    uniqueRetainedBytes: expectedBytes,
    uniqueResources: 6,
    owners: 2,
    references: 12,
    sharedResources: 6,
  });
  assert.deepEqual(snapshot.gpuBuffers, {
    estimatedGpuBufferBytes: expectedDirectGpuBytes,
    uniqueResources: 5,
    owners: 2,
    references: 10,
    sharedResources: 5,
  });
  assert.deepEqual(snapshot.unsupported, {
    uniqueResources: 1,
    owners: 2,
    references: 2,
    sharedResources: 1,
  });

  ledger.referenceGpuBuffer("mesh-c", new THREE.BufferAttribute(positionArray, 3));
  snapshot = ledger.snapshot();
  assert.equal(snapshot.cpu.uniqueRetainedBytes, expectedBytes, "one CPU allocation remains one allocation");
  assert.equal(snapshot.gpuBuffers.uniqueResources, 6, "a new attribute identity implies another GPU buffer");
  assert.equal(snapshot.gpuBuffers.estimatedGpuBufferBytes,
    expectedDirectGpuBytes + positionArray.byteLength);
});

test("render telemetry defensively freezes the optional resource accounting snapshot", () => {
  const ledger = new ResourceAccountingLedger();
  ledger.referenceCpu("terrain", new Uint8Array(32));
  const frame = { count: 0, average: 0, worst: 0, longFrames: 0, p50: 0, p95: 0, p99: 0 };
  const capture = makeRenderTelemetrySnapshot(123, frame, undefined, { accounting: ledger.snapshot() });

  assert.equal(capture.resources.accounting.cpu.uniqueRetainedBytes, 32);
  assert.equal(capture.resources.accounting.coverage.complete, false);
  assert.ok(Object.isFrozen(capture.resources.accounting));
  assert.ok(Object.isFrozen(capture.resources.accounting.cpu));
  assert.ok(Object.isFrozen(capture.resources.accounting.coverage.gaps));
  assert.throws(() => { capture.resources.accounting.cpu.uniqueRetainedBytes = 0; }, TypeError);
});

test("terrain and splat visitors include exact retained typed buffers and logical textures", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  const terrainData = new ArrayBuffer(60);
  const terrainBytes = new Uint8Array(terrainData);
  const terrainView = new DataView(terrainData);
  for (const [offset, value] of [[0, "MAPS"], [44, "MHGT"]]) {
    for (let index = 0; index < 4; index++) terrainBytes[offset + index] = value.charCodeAt(index);
  }
  terrainView.setUint32(4, 10, true);
  terrainView.setUint32(20, 44, true);
  terrainView.setUint32(48, 1, true);

  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/terrain/")) return new Response(terrainData.slice(0));
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
    const terrain = new TerrainClient("ws://example.test:1234/world");
    const splat = new TerrainSplatClient("ws://example.test:1234/world");
    terrain.heightAt(1, 0, 0);
    splat.get(1, { x: 32, y: 32 });
    for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));

    const ledger = new ResourceAccountingLedger();
    terrain.visitRetainedResources(ledger);
    splat.visitRetainedResources(ledger);
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.cpu.uniqueRetainedBytes, 60 + 2 * 256 * 256 * 4);
    assert.equal(snapshot.cpu.uniqueResources, 3);
    assert.equal(snapshot.gpuTextures.knownByteResources, 1, "the exact DataArray allocation is known");
    assert.equal(snapshot.gpuTextures.unknownByteResources, 2,
      "mock image textures without dimensions stay explicitly unknown");
    assert.equal(snapshot.gpuTextures.uniqueResources, 3);
    assert.equal(snapshot.unsupported.uniqueResources, 0,
      "ordinary textures are no longer unconditional unsupported markers");
    assert.equal(snapshot.coverage.complete, false);
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
  }
});
