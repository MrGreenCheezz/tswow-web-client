import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  ResourceAccountingLedger,
  visitMaterialTextures,
} from "../dist/code/browser/ResourceAccounting.js";
import { benchmarkResourceCheckpoint } from "../dist/code/browser/RenderBenchmarkRuntime.js";
import { CharacterAtlasClient } from "../dist/code/browser/CharacterAtlas.js";

function rgbaTexture(data = new Uint8Array(4 * 2 * 4)) {
  const texture = new THREE.DataTexture(data, 4, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.generateMipmaps = true;
  return texture;
}

test("texture GPU identity follows Source and renderer cache key, not UV transforms", () => {
  const ledger = new ResourceAccountingLedger();
  const original = rgbaTexture();
  const clone = original.clone();
  clone.offset.set(0.25, 0.5);
  clone.repeat.set(4, 8);
  clone.rotation = 0.75;

  ledger.referenceGpuTexture("original", original);
  ledger.referenceGpuTexture("clone", clone);
  let snapshot = ledger.snapshot();
  assert.deepEqual(snapshot.gpuTextures, {
    estimatedLogicalTextureBytes: 44,
    knownByteResources: 1,
    unknownByteResources: 0,
    uniqueResources: 1,
    owners: 2,
    references: 2,
    sharedResources: 1,
  });

  const samplerClone = original.clone();
  samplerClone.wrapS = THREE.RepeatWrapping;
  ledger.referenceGpuTexture("sampler", samplerClone);
  snapshot = ledger.snapshot();
  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 88);
  assert.equal(snapshot.gpuTextures.uniqueResources, 2, "a sampler cache-key change duplicates storage");
});

test("distinct Sources sharing pixels deduplicate CPU backing but not logical GPU allocation", () => {
  const ledger = new ResourceAccountingLedger();
  const pixels = new Uint8Array(4 * 2 * 4);
  const first = rgbaTexture(pixels);
  const second = rgbaTexture(pixels);

  ledger.referenceGpuTexture("first", first);
  ledger.referenceGpuTexture("second", second);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.cpu.uniqueRetainedBytes, pixels.buffer.byteLength);
  assert.equal(snapshot.cpu.uniqueResources, 1);
  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 88);
  assert.equal(snapshot.gpuTextures.uniqueResources, 2);
});

test("generated 2D and array mip chains use logical upload dimensions", () => {
  const ledger = new ResourceAccountingLedger();
  const texture2d = rgbaTexture();
  const array = new THREE.DataArrayTexture(new Uint8Array(4 * 2 * 3 * 4), 4, 2, 3);
  array.format = THREE.RGBAFormat;
  array.type = THREE.UnsignedByteType;
  array.generateMipmaps = true;

  ledger.referenceGpuTexture("2d", texture2d);
  ledger.referenceGpuTexture("array", array);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 44 + 132);
  assert.equal(snapshot.gpuTextures.knownByteResources, 2);
  assert.equal(snapshot.gpuTextures.unknownByteResources, 0);
});

test("manual mip allocation derives each level from its declared base", () => {
  const ledger = new ResourceAccountingLedger();
  const texture = new THREE.DataTexture(new Uint8Array(8 * 4 * 4), 8, 4);
  texture.generateMipmaps = false;
  texture.mipmaps = [
    { data: new Uint8Array(8 * 4 * 4), width: 8, height: 4 },
    { data: new Uint8Array(4 * 2 * 4), width: 4, height: 2 },
    { data: new Uint8Array(2 * 1 * 4), width: 2, height: 1 },
  ];

  ledger.referenceGpuTexture("manual", texture);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 128 + 32 + 8);
  assert.equal(snapshot.gpuTextures.knownByteResources, 1);
  assert.equal(snapshot.cpu.uniqueResources, 4, "source and every retained mip typed array are visited");
});

test("generated mip allocation keeps a manual mip base but derives levels from source dimensions", () => {
  const ledger = new ResourceAccountingLedger();
  const texture = new THREE.DataTexture(new Uint8Array(4 * 2 * 4), 4, 2);
  texture.generateMipmaps = true;
  texture.mipmaps = [
    { data: new Uint8Array(8 * 4 * 4), width: 8, height: 4 },
  ];

  ledger.referenceGpuTexture("manual-generated", texture);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 168,
    "three allocates three levels rooted at the first manual mip (8x4)");
});

test("compressed manual mip allocation uses TextureUtils block sizes", () => {
  const ledger = new ResourceAccountingLedger();
  const texture = new THREE.CompressedTexture([
    { data: new Uint8Array(32), width: 8, height: 4 },
    { data: new Uint8Array(16), width: 4, height: 2 },
    { data: new Uint8Array(16), width: 2, height: 1 },
  ], 8, 4, THREE.RGBA_S3TC_DXT5_Format);

  ledger.referenceGpuTexture("compressed", texture);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 64);
  assert.equal(snapshot.gpuTextures.knownByteResources, 1);
  assert.equal(snapshot.cpu.uniqueRetainedBytes, 64);
});

test("unknown layouts and conflicting observations are explicit and never counted as zero-byte known", () => {
  const ledger = new ResourceAccountingLedger();
  const internal = rgbaTexture();
  internal.internalFormat = "RGBA8";
  ledger.referenceGpuTexture("internal", internal);

  const changing = rgbaTexture();
  ledger.referenceGpuTexture("before", changing);
  changing.image.width = 8;
  ledger.referenceGpuTexture("after", changing.clone());

  const snapshot = ledger.snapshot();
  assert.deepEqual(snapshot.gpuTextures, {
    estimatedLogicalTextureBytes: 0,
    knownByteResources: 0,
    unknownByteResources: 2,
    uniqueResources: 2,
    owners: 3,
    references: 3,
    sharedResources: 1,
  });
});

test("unknown cube layouts retain Source and renderer cache-key identity", () => {
  const ledger = new ResourceAccountingLedger();
  const images = Array.from({ length: 6 }, () => ({ width: 4, height: 2 }));
  const original = new THREE.CubeTexture(images);
  const clone = original.clone();

  ledger.referenceGpuTexture("original", original);
  ledger.referenceGpuTexture("clone", clone);
  const snapshot = ledger.snapshot();

  assert.deepEqual(snapshot.gpuTextures, {
    estimatedLogicalTextureBytes: 0,
    knownByteResources: 0,
    unknownByteResources: 1,
    uniqueResources: 1,
    owners: 2,
    references: 2,
    sharedResources: 1,
  });
});

test("DOM-backed textures estimate GPU dimensions but report decoded CPU storage unsupported", () => {
  const ledger = new ResourceAccountingLedger();
  const canvas = { width: 4, height: 2, getContext() { return null; } };
  const texture = new THREE.CanvasTexture(canvas);
  texture.generateMipmaps = true;

  ledger.referenceGpuTexture("atlas", texture);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.cpu.uniqueRetainedBytes, 0, "decoded pixels are not invented as RGBA CPU bytes");
  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 44);
  assert.equal(snapshot.unsupported.uniqueResources, 1);
  assert.equal(snapshot.unsupported.references, 1);
});

test("character atlas visitor accounts every cached 512 texture and leaves canvas CPU bytes unsupported", async () => {
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap,
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: async () => ({}) });
  globalThis.createImageBitmap = async () => ({ width: 512, height: 512, close() {} });
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
      return canvas;
    },
  };
  try {
    const atlases = new CharacterAtlasClient("http://gateway.test");
    assert.ok(await atlases.compose("one", [{ path: "Character\\Human\\Male\\skin.blp" }]));
    const ledger = new ResourceAccountingLedger();
    atlases.visitRetainedResources(ledger);
    const snapshot = ledger.snapshot();

    assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 1_398_100);
    assert.equal(snapshot.gpuTextures.knownByteResources, 1);
    assert.equal(snapshot.unsupported.uniqueResources, 2,
      "the canvas and ready ImageBitmap remain distinct unsupported browser-owned allocations");
    assert.equal(snapshot.cpu.uniqueRetainedBytes, 0);
  } finally {
    globalThis.fetch = original.fetch;
    globalThis.document = original.document;
    globalThis.createImageBitmap = original.createImageBitmap;
  }
});

test("render-target textures derive current allocation and use texture object identity", () => {
  const ledger = new ResourceAccountingLedger();
  const first = new THREE.WebGLRenderTarget(4, 4).texture;
  const second = first.clone();
  second.source = first.source;
  // This is a standalone clone for the ordinary texture contract, not an attached render-target
  // texture. An attached clone is covered by the orphan regression below.
  second.renderTarget = null;
  second.isRenderTargetTexture = false;

  ledger.referenceGpuTexture("first", first);
  ledger.referenceGpuTexture("second", second);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 2 * 4 * 4 * 4);
  assert.equal(snapshot.gpuTextures.knownByteResources, 2);
  assert.equal(snapshot.gpuTextures.unknownByteResources, 0);
  assert.equal(snapshot.gpuTextures.uniqueResources, 2);
});

test("orphan render-target clones are explicit unknown GPU textures, not known allocations", () => {
  const target = new THREE.WebGLRenderTarget(4, 4);
  const attached = target.texture;
  const orphan = attached.clone();
  orphan.source = attached.source;

  const ledger = new ResourceAccountingLedger();
  ledger.referenceGpuTexture("attached", attached);
  ledger.referenceGpuTexture("orphan", orphan);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 64);
  assert.equal(snapshot.gpuTextures.knownByteResources, 1);
  assert.equal(snapshot.gpuTextures.unknownByteResources, 1);
  assert.equal(snapshot.gpuTextures.uniqueResources, 2);
  assert.equal(snapshot.unsupported.uniqueResources, 1);
  assert.equal(snapshot.unsupported.references, 1);
});

test("standalone DepthTexture ignores image.depth because r185 uploads TEXTURE_2D", () => {
  const texture = new THREE.DepthTexture(4, 2);
  texture.image.depth = 3;
  const ledger = new ResourceAccountingLedger();
  ledger.referenceGpuTexture("depth", texture);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 4 * 2 * 3);
  assert.equal(snapshot.gpuTextures.knownByteResources, 1);
  assert.equal(snapshot.gpuTextures.unknownByteResources, 0);
});

test("texture snapshot fields and benchmark flattening are immutable and complete", () => {
  const ledger = new ResourceAccountingLedger();
  ledger.referenceGpuTexture("texture", rgbaTexture());
  const accounting = ledger.snapshot();

  assert.ok(Object.isFrozen(accounting.gpuTextures));
  assert.throws(() => { accounting.gpuTextures.estimatedLogicalTextureBytes = 0; }, TypeError);

  const checkpoint = benchmarkResourceCheckpoint({ resources: { accounting } });
  assert.equal(checkpoint.bytes["accounting.gpuTextures.estimatedLogicalTextureBytes"], 44);
  assert.equal(checkpoint.counters["accounting.gpuTextures.knownByteResources"], 1);
  assert.equal(checkpoint.counters["accounting.gpuTextures.unknownByteResources"], 0);
  assert.equal(checkpoint.counters["accounting.gpuTextures.uniqueResources"], 1);
});

test("material visitor is array-safe and only follows direct maps plus shader uniform values", () => {
  const ledger = new ResourceAccountingLedger();
  const direct = rgbaTexture();
  const uniform = rgbaTexture();
  const ignoredNested = rgbaTexture();
  const plain = new THREE.MeshBasicMaterial({ map: direct });
  const shader = new THREE.ShaderMaterial({
    uniforms: {
      direct: { value: uniform },
      array: { value: [direct, [uniform]] },
      ignored: { nested: ignoredNested },
    },
  });

  visitMaterialTextures(ledger, [plain, shader]);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.uniqueResources, 2);
  assert.equal(snapshot.gpuTextures.owners, 2, "the Material, not each mesh, owns its references");
  assert.equal(snapshot.gpuTextures.references, 3, "repeat uniform references are idempotent per material");
});

test("shader uniform structs recurse through plain objects, arrays, and cycles", () => {
  const ledger = new ResourceAccountingLedger();
  const structTexture = rgbaTexture();
  const arrayTexture = rgbaTexture();
  const cycleTexture = rgbaTexture();
  const cyclicArray = [];
  cyclicArray.push(cyclicArray, { sampler: cycleTexture });
  const cycle = { self: null, nested: { map: cycleTexture }, array: cyclicArray };
  cycle.self = cycle;
  const shader = new THREE.ShaderMaterial({
    uniforms: {
      struct: { value: { layers: { albedo: structTexture } } },
      arrayOfStructs: { value: [{ sampler: arrayTexture }, { nested: [{ sampler: arrayTexture }] }] },
      cyclic: { value: cycle },
    },
  });

  visitMaterialTextures(ledger, shader);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.uniqueResources, 3);
  assert.equal(snapshot.gpuTextures.owners, 1);
  assert.equal(snapshot.gpuTextures.references, 3);
});

test("material visitor counts valid members of partial and sparse material arrays", () => {
  const ledger = new ResourceAccountingLedger();
  const valid = new THREE.MeshBasicMaterial({ map: rgbaTexture() });
  const materials = [];
  materials[0] = undefined;
  materials[2] = valid;
  materials[4] = undefined;

  visitMaterialTextures(ledger, materials);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.uniqueResources, 1);
  assert.equal(snapshot.gpuTextures.references, 1);
});
