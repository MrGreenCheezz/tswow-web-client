import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { ModelTextureLoader, registerPendingTextureView } from "../dist/code/browser/TextureLoad.js";

// Model textures are decoded off the main thread and shared by URL. An <img> handed to WebGL is
// decoded again inside the draw that first samples it; the bitmap has to carry the texels that
// upload produced (no flip, no premultiply, no colour conversion), and one decode serves every
// build of a URL for as long as any texture - a loaded base or a view cloned from it - samples it.

const A = "http://gateway.test/texture?path=a.blp";
const B = "http://gateway.test/texture?path=b.blp";
const C = "http://gateway.test/texture?path=c.blp";
const D = "http://gateway.test/texture?path=d.blp";
const BIG = "http://gateway.test/texture?path=big.blp";
const SMALL = "http://gateway.test/texture?path=small.blp";
const MISSING = "http://gateway.test/texture?path=missing.blp";
const BROKEN = "http://gateway.test/texture?path=broken.blp";

class FakeImageBitmap {
  constructor(width, height, url) {
    this.width = width;
    this.height = height;
    this.url = url;
    this.closed = false;
  }

  close() {
    this.closed = true;
    this.width = 0;
    this.height = 0;
  }
}

function restoreGlobal(name, value) {
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
}

/**
 * A page that decodes off the main thread. `fetch` answers `statuses[url]` (200 by default) with the
 * URL as its body; `createImageBitmap` turns that body into a bitmap of `sizes[url]` (4x2 by
 * default) or rejects for an `undecodable` URL. `TextureLoader` is poisoned: this is the browser.
 */
function withBitmapPage(run, { statuses = {}, sizes = {}, undecodable = new Set() } = {}) {
  return async () => {
    const originals = {
      fetch: globalThis.fetch,
      createImageBitmap: globalThis.createImageBitmap,
      ImageBitmap: globalThis.ImageBitmap,
      load: THREE.TextureLoader.prototype.load,
    };
    const page = { requests: [], attempts: [], decodes: [] };
    globalThis.ImageBitmap = FakeImageBitmap;
    globalThis.fetch = async (url, init) => {
      page.requests.push({ url: String(url), init });
      const status = statuses[url] ?? 200;
      return new Response(status === 200 ? new Blob([String(url)]) : null, { status });
    };
    globalThis.createImageBitmap = async (blob, options) => {
      const url = await blob.text();
      page.attempts.push(url);
      if (undecodable.has(url)) {
        throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      }
      const [width, height] = sizes[url] ?? [4, 2];
      const bitmap = new FakeImageBitmap(width, height, url);
      page.decodes.push({ url, options, bitmap });
      return bitmap;
    };
    THREE.TextureLoader.prototype.load = () => {
      throw new Error("the <img> path must not be used where createImageBitmap exists");
    };
    try {
      await run(page);
    } finally {
      restoreGlobal("fetch", originals.fetch);
      restoreGlobal("createImageBitmap", originals.createImageBitmap);
      restoreGlobal("ImageBitmap", originals.ImageBitmap);
      THREE.TextureLoader.prototype.load = originals.load;
    }
  };
}

/** Lets every fetch, body read and decode in flight run to completion. */
async function settle() {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function pick(object, ...keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

test("a model texture is fetched as its <img> was and decoded into the texels that upload produced",
  withBitmapPage(async (page) => {
    const loader = new ModelTextureLoader();
    const texture = loader.load(A);
    assert.equal(loader.status(texture), "pending");
    assert.deepEqual(loader.stats, { pending: 1, ready: 0, failed: 0, error: 0, generation: 0 });
    assert.equal(texture.image, null, "nothing to upload until the decode lands");
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].url, A);
    // crossorigin="anonymous": CORS mode, cookies for the page's own origin, an image's priority.
    assert.deepEqual({ ...page.requests[0].init },
      { mode: "cors", credentials: "same-origin", priority: "low" });

    await settle();
    assert.equal(page.decodes.length, 1);
    const { options, bitmap } = page.decodes[0];
    // three uploaded the <img> with flipY = false, UNPACK_PREMULTIPLY_ALPHA = false and
    // UNPACK_COLORSPACE_CONVERSION = NONE; it sets none of those for a bitmap.
    assert.deepEqual({ ...options }, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    assert.equal("imageOrientation" in options, false, "the rows stay in the file's own order");
    assert.strictEqual(texture.image, bitmap);
    assert.ok(texture.version > 0, "marked for upload");
    assert.equal(texture.premultiplyAlpha, false);
    assert.equal(loader.status(texture), "ready");
    assert.deepEqual(loader.stats, { pending: 0, ready: 1, failed: 0, error: 0, generation: 1 });
  }));

test("a refused or undecodable model texture is the opaque white pixel, and the next load asks again",
  withBitmapPage(async (page) => {
    const loader = new ModelTextureLoader();
    const refused = loader.load(MISSING);
    const broken = loader.load(BROKEN);
    await settle();
    for (const texture of [refused, broken]) {
      assert.equal(loader.status(texture), "failed");
      assert.equal(texture.isDataTexture, true);
      assert.deepEqual([...texture.image.data], [255, 255, 255, 255]);
    }
    assert.deepEqual(loader.stats, { pending: 0, ready: 0, failed: 2, error: 2, generation: 2 });
    assert.deepEqual(page.attempts, [BROKEN], "a refused answer is never decoded");
    assert.equal(loader.imageCacheStats.count, 0, "a failure is not remembered");

    const retried = loader.load(MISSING);
    assert.equal(page.requests.length, 3, "every <img> asked again, and so does this");
    assert.notStrictEqual(retried.source, refused.source);
    await settle();
    assert.equal(loader.status(retried), "failed");
    assert.deepEqual(loader.stats, { pending: 0, ready: 0, failed: 3, error: 3, generation: 3 });
  }, { statuses: { [MISSING]: 404 }, undecodable: new Set([BROKEN]) }));

test("one decode serves every build of a URL, and sharing it sends no pixels twice",
  withBitmapPage(async (page) => {
    const loader = new ModelTextureLoader();
    const first = loader.load(A);
    const second = loader.load(A);
    assert.equal(page.requests.length, 1, "two builds in flight share one request");
    assert.notStrictEqual(first, second, "each build still owns its own texture");
    assert.strictEqual(first.source, second.source);
    await settle();
    assert.equal(page.decodes.length, 1);
    assert.equal(loader.status(first), "ready");
    assert.equal(loader.status(second), "ready");
    assert.strictEqual(second.image, page.decodes[0].bitmap);
    const source = first.source;
    const published = source.version;
    assert.ok(published > 0, "the decoded image is one change of pixels");

    // A `privateTextureView` clone and a later build of the same appearance both bind the GL
    // texture three keeps for this source: `Texture.copy` and the completion mark would otherwise
    // bump `source.version`, and three re-sends a source whose version moved.
    const view = first.clone();
    assert.strictEqual(view.source, source);
    assert.ok(view.version > 0, "the view is still marked, so it binds on its first draw");
    const third = loader.load(A);
    assert.equal(loader.status(third), "ready", "a decoded URL settles at once");
    assert.strictEqual(third.image, page.decodes[0].bitmap);
    assert.ok(third.version > 0);
    assert.equal(source.version, published, "no pixel changed, so nothing is uploaded again");
    assert.equal(page.requests.length, 1);
    assert.deepEqual(loader.stats, { pending: 0, ready: 3, failed: 0, error: 0, generation: 3 });
    assert.deepEqual(loader.imageCacheStats, {
      count: 1, pending: 0, held: 1, heldDecodedBytes: 32, idle: 0, idleDecodedBytes: 0,
      requests: 1, hits: 2, closed: 0,
    });

    // Every build of that appearance evicted: the unit loader keeps the decode for the next one.
    for (const texture of [first, second, third, view]) texture.dispose();
    assert.deepEqual(pick(loader.imageCacheStats, "held", "idle", "closed"), { held: 0, idle: 1, closed: 0 });
    const rebuilt = loader.load(A);
    assert.equal(loader.status(rebuilt), "ready");
    assert.strictEqual(rebuilt.image, page.decodes[0].bitmap);
    assert.equal(page.requests.length, 1);
  }));

test("a decoded image stays open while any texture or view samples it, and closes once evicted idle",
  withBitmapPage(async (page) => {
    const loader = new ModelTextureLoader({ images: { count: 1, decodedBytes: 1 << 30 } });
    const base = loader.load(A);
    const view = base.clone();
    await settle();
    const imageA = base.image;
    base.dispose();
    base.dispose();
    assert.equal(loader.imageCacheStats.held, 1, "the view outlives its base and still samples it");
    assert.equal(imageA.closed, false);
    view.dispose();
    assert.deepEqual(pick(loader.imageCacheStats, "held", "idle", "closed"), { held: 0, idle: 1, closed: 0 });
    assert.equal(imageA.closed, false, "an idle image within the limits waits for the next build");

    const other = loader.load(B);
    await settle();
    const imageB = other.image;
    other.dispose();
    // Two idle images over a count of one: the one idle longest is closed.
    assert.equal(imageA.closed, true);
    assert.equal(imageB.closed, false);
    assert.deepEqual(pick(loader.imageCacheStats, "count", "idle", "closed"), { count: 1, idle: 1, closed: 1 });
    assert.equal(base.image, null, "a closed bitmap is never handed to WebGL");

    const again = loader.load(A);
    assert.equal(page.requests.length, 3, "an evicted URL is fetched again");
    assert.equal(loader.status(again), "pending");
  }));

test("idle images leave longest-idle first until the byte limit holds",
  withBitmapPage(async () => {
    const loader = new ModelTextureLoader({ images: { count: 10, decodedBytes: 1100 } });
    const big = loader.load(BIG);
    const small = loader.load(SMALL);
    await settle();
    const bigImage = big.image;
    const smallImage = small.image;
    small.dispose();
    assert.equal(smallImage.closed, false, "256 bytes fit");
    big.dispose();
    // 1024 + 256 bytes idle: the image released first goes, although it was loaded last.
    assert.equal(smallImage.closed, true);
    assert.equal(bigImage.closed, false);
    assert.deepEqual(pick(loader.imageCacheStats, "idle", "idleDecodedBytes"), { idle: 1, idleDecodedBytes: 1024 });
  }, { sizes: { [BIG]: [16, 16], [SMALL]: [8, 8] } }));

test("a texture disposed while its decode is in flight still settles, and its image idles from the moment it lands",
  withBitmapPage(async () => {
    const loader = new ModelTextureLoader({ images: { count: 1, decodedBytes: 1 << 30 } });
    const early = loader.load(A);
    await settle();
    const imageA = early.image;
    const late = loader.load(B);
    late.dispose();
    early.dispose();
    assert.equal(imageA.closed, false, "one idle image fits");
    await settle();
    assert.equal(loader.status(late), "ready", "a disposed texture's request still settles");
    assert.deepEqual(loader.stats, { pending: 0, ready: 2, failed: 0, error: 0, generation: 2 });
    // B went idle as it landed, after A was released: A is the one idle longest.
    assert.equal(imageA.closed, true);
    assert.equal(late.image.closed, false);
  }));

test("one waiter that throws on completion does not keep the others on the same decode waiting",
  withBitmapPage(async () => {
    const original = globalThis.queueMicrotask;
    const rethrown = [];
    globalThis.queueMicrotask = (task) => original(() => {
      try { task(); } catch (error) { rethrown.push(error); }
    });
    try {
      const loader = new ModelTextureLoader();
      const first = loader.load(A);
      // A parked view whose publication throws inside the first waiter's completion.
      registerPendingTextureView(first, {
        set version(_value) {},
        set needsUpdate(_value) { throw new Error("view refused its mark"); },
      });
      const second = loader.load(A);
      await settle();
      assert.equal(loader.status(first), "ready");
      assert.equal(loader.status(second), "ready", "the second request settled regardless");
      assert.deepEqual(loader.stats, { pending: 0, ready: 2, failed: 0, error: 0, generation: 2 });
      assert.deepEqual(rethrown.map((error) => error.message), ["view refused its mark"],
        "the throw still surfaces, as an <img> callback's did");
    } finally {
      globalThis.queueMicrotask = original;
    }
  }));

test("clear closes idle images now and held ones with their last texture, and a late decode moves nothing",
  withBitmapPage(async (page) => {
    const loader = new ModelTextureLoader();
    const idle = loader.load(A);
    const held = loader.load(B);
    await settle();
    const idleImage = idle.image;
    const heldImage = held.image;
    idle.dispose();
    const inFlight = loader.load(C);
    const abandoned = loader.load(D);
    abandoned.dispose();
    const generation = loader.stats.generation;

    loader.clear();
    assert.equal(idleImage.closed, true, "an idle image closes with the clear");
    assert.equal(heldImage.closed, false, "a texture still samples this one");
    held.dispose();
    assert.equal(heldImage.closed, true, "and it closes with its last texture");

    await settle();
    const decoded = new Map(page.decodes.map(({ url, bitmap }) => [url, bitmap]));
    assert.equal(decoded.get(D).closed, true, "nothing waits on it any more: closed as it lands");
    assert.equal(abandoned.image, null, "and never published");
    assert.strictEqual(inFlight.image, decoded.get(C), "a texture still on a cleared request gets its pixels");
    assert.ok(inFlight.version > 0, "marked for upload, as TextureLoader marks before its callback");
    assert.equal(loader.status(inFlight), "failed", "but the request is no longer current");
    assert.deepEqual(loader.stats, { pending: 0, ready: 0, failed: 0, error: 0, generation: generation + 1 },
      "and its late answer moves no counter");
    inFlight.dispose();
    assert.equal(decoded.get(C).closed, true);
    assert.equal(loader.imageCacheStats.count, 0);

    const reloaded = loader.load(A);
    assert.equal(page.requests.length, 5, "a cleared URL is fetched again");
    assert.equal(loader.status(reloaded), "pending");
  }));

test("a URL-cached loader keeps no decode past its own limits unless given idle room, and then reuses it",
  withBitmapPage(async (page) => {
    const strict = new ModelTextureLoader({ cache: true, limits: { count: 0, knownLogicalTextureBytes: 0 } });
    const cast = strict.acquire(A, "cast");
    const view = cast.texture.clone();
    await settle();
    const image = cast.texture.image;
    cast.release();
    assert.deepEqual(strict.evictUnleased(), [A]);
    assert.equal(image.closed, false, "a view of the evicted base still samples it");
    const recast = strict.acquire(A, "recast");
    assert.equal(strict.status(recast.texture), "ready", "a new base over the decode the view holds");
    assert.strictEqual(recast.texture.image, image);
    assert.equal(page.requests.length, 1);
    recast.release();
    view.dispose();
    assert.deepEqual(strict.evictUnleased(), [A]);
    assert.equal(image.closed, true, "by default the decode goes with the last base and view");

    const roomy = new ModelTextureLoader({
      cache: true,
      limits: { count: 0, knownLogicalTextureBytes: 0 },
      images: { count: 4, decodedBytes: 1 << 20 },
    });
    const first = roomy.acquire(A, "first cast");
    await settle();
    assert.equal(page.requests.length, 2, "a loader's decodes are its own");
    first.release();
    assert.deepEqual(roomy.evictUnleased(), [A]);
    assert.deepEqual(pick(roomy.imageCacheStats, "held", "idle", "closed"), { held: 0, idle: 1, closed: 0 });

    const second = roomy.acquire(A, "second cast");
    assert.equal(roomy.status(second.texture), "ready", "settled at once");
    assert.notStrictEqual(second.texture, first.texture, "a new base for a new request");
    assert.strictEqual(second.texture.source, first.texture.source, "over the same decoded source");
    assert.equal(page.requests.length, 2);
    assert.equal(page.decodes.length, 2);
    // 4x2 RGBA and its mips (4x2, 2x1, 1x1): measured on the spot, not after a callback.
    assert.equal(roomy.residencyStats.knownLogicalTextureBytes, 32 + 8 + 4);
    second.release();
  }));

test("a view parked on a pending base is published over the shared source, as pixels or as the white pixel",
  withBitmapPage(async (page) => {
    const loader = new ModelTextureLoader();
    const base = loader.load(A);
    const view = base.clone();
    registerPendingTextureView(base, view);
    assert.equal(view.version, 0, "parked until the pixels land");
    const refused = loader.load(MISSING);
    const refusedView = refused.clone();
    registerPendingTextureView(refused, refusedView);
    const before = refused.source.version;

    await settle();
    assert.ok(view.version > 0);
    assert.strictEqual(view.image, page.decodes[0].bitmap);
    assert.ok(refusedView.version > 0);
    assert.deepEqual([...refusedView.image.data], [255, 255, 255, 255], "the view samples the missing pixel");
    assert.ok(refused.source.version > before, "the missing pixel is a change of pixels");
  }, { statuses: { [MISSING]: 404 } }));

test("without a bitmap decoder the <img> loader remains the path", async () => {
  const originals = {
    createImageBitmap: globalThis.createImageBitmap,
    ImageBitmap: globalThis.ImageBitmap,
    load: THREE.TextureLoader.prototype.load,
  };
  const calls = [];
  // Node has `fetch`, and a test may install a decoder, but there is no ImageBitmap to upload.
  restoreGlobal("ImageBitmap", undefined);
  globalThis.createImageBitmap = async () => { throw new Error("must not decode"); };
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    calls.push(url);
    const texture = new THREE.Texture();
    onLoad?.(texture);
    return texture;
  };
  try {
    const loader = new ModelTextureLoader();
    const texture = loader.load(A);
    assert.deepEqual(calls, [A]);
    assert.equal(loader.status(texture), "ready");
    assert.equal(loader.imageCacheStats.requests, 0);
  } finally {
    restoreGlobal("createImageBitmap", originals.createImageBitmap);
    restoreGlobal("ImageBitmap", originals.ImageBitmap);
    THREE.TextureLoader.prototype.load = originals.load;
  }
});

test("image cache limits are validated like the texture cache's", () => {
  assert.throws(() => new ModelTextureLoader({ images: { count: -1 } }), RangeError);
  assert.throws(() => new ModelTextureLoader({ images: { decodedBytes: 0.5 } }), RangeError);
  assert.doesNotThrow(() => new ModelTextureLoader({ images: { count: 0, decodedBytes: 0 } }));
});
