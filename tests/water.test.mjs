import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { LiquidTextureClient } from "../dist/code/browser/Water.js";

const settle = async (turns = 4) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

function countTextureDisposals() {
  const originalDispose = THREE.Texture.prototype.dispose;
  const counts = new Map();
  THREE.Texture.prototype.dispose = function () {
    counts.set(this, (counts.get(this) ?? 0) + 1);
    return originalDispose.call(this);
  };
  return {
    counts,
    restore: () => { THREE.Texture.prototype.dispose = originalDispose; },
  };
}

test("liquid disposal releases each retained strip once and is idempotent", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const disposal = countTextureDisposals();
  const pending = [];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ frames: 30 }) });
  THREE.TextureLoader.prototype.load = function (_url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    pending.push({ texture, onLoad, onError });
    return texture;
  };
  try {
    const client = new LiquidTextureClient("ws://water.test/world");
    assert.equal(client.get("water"), undefined);
    await settle();
    assert.equal(pending.length, 1);
    pending[0].onLoad(pending[0].texture);
    await settle();
    assert.ok(client.get("water"));

    client.dispose();
    client.dispose();
    assert.equal(disposal.counts.get(pending[0].texture), 1);
    assert.equal(client.get("water"), undefined);
    assert.equal(client.classes, undefined);
    assert.deepEqual(client.stats, { pending: 0, success: 1, error: 0, generation: 1 });
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    disposal.restore();
  }
});

test("current liquid image errors dispose their loader handle exactly once", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const disposal = countTextureDisposals();
  const pending = [];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ frames: 30 }) });
  THREE.TextureLoader.prototype.load = function (_url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    pending.push({ texture, onLoad, onError });
    return texture;
  };
  try {
    const client = new LiquidTextureClient("ws://water.test/world", () => Number.POSITIVE_INFINITY);
    client.get("slime");
    await settle();
    assert.equal(pending.length, 1);
    pending[0].onError(new Error("current image failure"));
    await settle();
    assert.equal(disposal.counts.get(pending[0].texture), 1);
    assert.deepEqual(client.stats, { pending: 0, success: 0, error: 1, generation: 1 });
    client.dispose();
    assert.equal(disposal.counts.get(pending[0].texture), 1);
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    disposal.restore();
  }
});

test("dispose releases a never-callback liquid loader handle immediately", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const disposal = countTextureDisposals();
  const pending = [];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ frames: 30 }) });
  THREE.TextureLoader.prototype.load = function (_url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    pending.push({ texture, onLoad, onError });
    return texture;
  };
  try {
    const client = new LiquidTextureClient("ws://water.test/world");
    client.get("magma");
    await settle();
    assert.equal(pending.length, 1);
    assert.equal(client.stats.pending, 1);
    client.dispose();
    assert.equal(disposal.counts.get(pending[0].texture), 1);
    assert.deepEqual(client.stats, { pending: 0, success: 0, error: 0, generation: 0 });
    client.dispose();
    assert.equal(disposal.counts.get(pending[0].texture), 1);
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    disposal.restore();
  }
});

test("sync non-standard liquid loaders release handle A while retaining callback texture B", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const disposal = countTextureDisposals();
  let handleA;
  let textureB;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ frames: 30 }) });
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    handleA = new THREE.Texture();
    textureB = new THREE.Texture();
    onLoad(textureB);
    return handleA;
  };
  try {
    const client = new LiquidTextureClient("ws://water.test/world");
    client.get("ocean");
    await settle();
    assert.equal(client.get("ocean")?.texture, textureB);
    assert.equal(disposal.counts.get(handleA), 1);
    assert.equal(disposal.counts.get(textureB), undefined);
    client.dispose();
    assert.equal(disposal.counts.get(handleA), 1);
    assert.equal(disposal.counts.get(textureB), 1);
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    disposal.restore();
  }
});

test("late liquid success and error after disposal cannot repopulate or mutate readiness", async () => {
  const originalFetch = globalThis.fetch;
  const originalLoad = THREE.TextureLoader.prototype.load;
  const disposal = countTextureDisposals();
  const pending = [];
  const requests = new Map();
  globalThis.fetch = (url) => {
    const request = deferred();
    requests.set(String(url), request);
    return request.promise;
  };
  THREE.TextureLoader.prototype.load = function (_url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    const callbackTexture = new THREE.Texture();
    pending.push({ texture, callbackTexture, onLoad, onError });
    return texture;
  };
  try {
    const successClient = new LiquidTextureClient("ws://water.test/world");
    const successBefore = successClient.stats;
    successClient.get("ocean");
    requests.get("http://water.test/liquid/ocean").resolve({
      ok: true, status: 200, json: async () => ({ frames: 30 }),
    });
    await settle();
    assert.equal(pending.length, 1);
    const successTexture = pending[0];
    successClient.dispose();
    const successAfterDispose = successClient.stats;
    successTexture.onLoad(successTexture.callbackTexture);
    await settle();
    assert.equal(disposal.counts.get(successTexture.texture), 1);
    assert.equal(disposal.counts.get(successTexture.callbackTexture), 1);
    assert.equal(successClient.get("ocean"), undefined);
    assert.deepEqual(successClient.stats, successAfterDispose);
    assert.deepEqual(successAfterDispose, successBefore);

    const errorClient = new LiquidTextureClient("ws://water.test/world");
    errorClient.get("magma");
    requests.get("http://water.test/liquid/magma").resolve({
      ok: true, status: 200, json: async () => ({ frames: 30 }),
    });
    await settle();
    assert.equal(pending.length, 2);
    const errorTexture = pending[1];
    errorClient.dispose();
    const errorAfterDispose = errorClient.stats;
    errorTexture.onError(new Error("late image failure"));
    errorTexture.onLoad(errorTexture.callbackTexture);
    await settle();
    assert.equal(disposal.counts.get(errorTexture.texture), 1);
    assert.equal(disposal.counts.get(errorTexture.callbackTexture), 1);
    assert.equal(errorClient.get("magma"), undefined);
    assert.deepEqual(errorClient.stats, errorAfterDispose);
    assert.deepEqual(errorAfterDispose, { pending: 0, success: 0, error: 0, generation: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = originalLoad;
    disposal.restore();
  }
});

test("late liquid class response after disposal cannot change readiness or classes", async () => {
  const originalFetch = globalThis.fetch;
  const classRequest = deferred();
  globalThis.fetch = () => classRequest.promise;
  try {
    const client = new LiquidTextureClient("ws://water.test/world");
    client.classes;
    client.dispose();
    const afterDispose = client.stats;
    classRequest.resolve({ ok: true, status: 200, json: async () => ({ 7: "water" }) });
    await settle();
    assert.equal(client.classes, undefined);
    assert.deepEqual(client.stats, afterDispose);
    assert.deepEqual(afterDispose, { pending: 0, success: 0, error: 0, generation: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("world teardown disposes liquids after renderer borrowers and before dropping the client", async () => {
  const source = await readFile(new URL("../src/browser/game/Context.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function clearWorldContext(): void {");
  const end = source.indexOf("\n}", start);
  const clear = source.slice(start, end);
  const renderer = clear.indexOf("game.renderer?.clearWorldResources();");
  const liquids = clear.indexOf("game.liquids?.dispose();");
  const drop = clear.indexOf("game.liquids = undefined;");
  assert.ok(renderer >= 0 && liquids > renderer && drop > liquids);
});

// 21.10 ARC-2 S1: the liquid strip is no longer an `<img>` (the render worker has no DOM). It goes
// through the model bitmap path, and since three does not apply UNPACK_FLIP_Y to an ImageBitmap the
// flip its `<img>` upload made (the strip keeps three's default `flipY = true`) is made by the decoder.
test("the liquid strip is decoded as a flipped bitmap and samples as its <img> did", async () => {
  const originals = {
    fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap,
    ImageBitmap: globalThis.ImageBitmap, load: THREE.TextureLoader.prototype.load,
  };
  class FakeImageBitmap { constructor() { this.width = 512; this.height = 15360; } close() {} }
  const requests = [];
  const decodes = [];
  globalThis.ImageBitmap = FakeImageBitmap;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith(".png")) return new Response(new Blob(["png"]), { status: 200 });
    return { ok: true, status: 200, json: async () => ({ frames: 30 }) };
  };
  globalThis.createImageBitmap = async (_blob, options) => {
    const bitmap = new FakeImageBitmap();
    decodes.push({ options, bitmap });
    return bitmap;
  };
  THREE.TextureLoader.prototype.load = () => { throw new Error("no <img> where createImageBitmap exists"); };
  try {
    const client = new LiquidTextureClient("ws://water.test/world");
    assert.equal(client.get("water"), undefined);
    await settle(20);
    const strip = client.get("water");
    assert.ok(strip, "the strip loaded");
    assert.equal(strip.frames, 30);
    const png = requests.find((request) => request.url.endsWith(".png"));
    assert.deepEqual({ ...png.init }, { mode: "cors", credentials: "same-origin", priority: "low" });
    assert.equal(decodes.length, 1);
    assert.deepEqual({ ...decodes[0].options },
      { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "flipY" });
    const texture = strip.texture;
    assert.equal(texture.image, decodes[0].bitmap);
    // What `TextureLoader` handed back plus Water's own settings: every other sampler field default.
    const fresh = new THREE.Texture();
    for (const key of ["flipY", "premultiplyAlpha", "generateMipmaps", "minFilter", "magFilter", "anisotropy", "unpackAlignment", "format", "type"]) {
      assert.equal(texture[key], fresh[key], key);
    }
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
    assert.equal(texture.wrapS, THREE.RepeatWrapping);
    assert.equal(texture.wrapT, THREE.ClampToEdgeWrapping);
    client.dispose();
  } finally {
    for (const name of ["fetch", "createImageBitmap", "ImageBitmap"]) {
      if (originals[name] === undefined) delete globalThis[name];
      else globalThis[name] = originals[name];
    }
    THREE.TextureLoader.prototype.load = originals.load;
  }
});
