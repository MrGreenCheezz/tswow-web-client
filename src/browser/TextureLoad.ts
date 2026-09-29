// Loading one client texture into three.js, and what happens when it is not there.
//
// This lived as a private method on `WorldRenderer3D` until the character lab needed it. The lab's
// whole point is to exercise the shipping path rather than a copy of it, and a copy is exactly
// what a second `TextureLoader` in the lab would have been — with its own idea of what a failed
// fetch looks like, which is the one behaviour the lab exists to observe.

import * as THREE from "three";
import {
  knownLogicalTextureBytes, type RetainedResourceVisitor,
} from "./ResourceAccounting.js";
import { suspectPatchChainChange } from "./PatchChainChanged.js";

export type ModelTextureStatus = "pending" | "ready" | "failed";

export interface ModelTextureLoaderStats {
  readonly pending: number;
  readonly ready: number;
  readonly failed: number;
  /** Current terminal failures owned by this loader, not the lifetime attempt total. */
  readonly error: number;
  /** Monotonic settlement generation, including synchronous throws. */
  readonly generation: number;
}

export interface ModelTextureCacheLimits {
  readonly count: number;
  readonly knownLogicalTextureBytes: number;
}

/** Exact current cached-base residency. Unknown layouts are counted, never priced as zero. */
export interface ModelTextureResidencyStats {
  readonly count: number;
  readonly knownLogicalTextureBytes: number;
  readonly unknownLogicalTextureCount: number;
  readonly activeLeases: number;
  /** Records protected either by an active lease or by an unsettled request. */
  readonly pinnedCount: number;
  readonly overflowCount: number;
  readonly overflowKnownLogicalTextureBytes: number;
}

/** One exact borrow of one exact cached URL request. Release is safe to repeat. */
export interface ModelTextureLease {
  readonly url: string;
  readonly texture: THREE.Texture;
  readonly ownerToken: unknown;
  readonly requestId: number;
  readonly released: boolean;
  release(): void;
}

/** Immutable exact cached-base pressure in oldest-to-newest texture LRU order. */
export interface ModelTexturePressureRecord {
  readonly url: string;
  readonly requestId: number;
  readonly status: ModelTextureStatus;
  readonly knownLogicalTextureBytes: number | undefined;
  /** Current unreleased owners. The collection is frozen; owner tokens remain caller-owned. */
  readonly ownerTokens: readonly unknown[];
}

interface TextureEntry {
  readonly url: string;
  readonly epoch: number;
  readonly requestId: number;
  readonly cached: boolean;
  texture: THREE.Texture | undefined;
  status: ModelTextureStatus;
  knownLogicalTextureBytes: number | undefined;
  readonly leases: Set<ModelTextureLease>;
}

const DEFAULT_CACHE_LIMITS: ModelTextureCacheLimits = Object.freeze({
  count: 256,
  knownLogicalTextureBytes: 128 * 1024 * 1024,
});

/** One opaque white pixel, RGBA. Shared: every failure wants the same four bytes. */
const MISSING_PIXEL = new Uint8Array([255, 255, 255, 255]);

/**
 * Private views waiting on their canonical's pixels, by canonical texture.
 *
 * `THREE.Texture.clone()` marks the clone for upload (`needsUpdate` in `copy()`), so a view
 * cloned from a still-pending canonical reaches its first draw with `version > 0` and no image —
 * exactly what three's uploader warns about (`Texture marked for update but no image data
 * found`), once per view per frame until the fetch lands. The registration below parks such a
 * view at version 0; `#applyCompletion` publishes it when the shared source resolves. Weak keys:
 * a view whose canonical never settles (world switch, eviction of a dead scene) dies with it.
 */
const pendingTextureViews = new WeakMap<THREE.Texture, Set<THREE.Texture>>();

/**
 * Parks a `privateTextureView`-style clone until its canonical's pixels arrive.
 *
 * A no-op when the canonical already holds an image: the clone's own upload mark then covers
 * its first draw. Otherwise the clone's mark is withdrawn (version 0 renders nothing and warns
 * about nothing) and re-issued by `#applyCompletion` together with the canonical's own.
 */
export function registerPendingTextureView(canonical: THREE.Texture, view: THREE.Texture): void {
  if (canonical.image !== null && canonical.image !== undefined) return;
  let views = pendingTextureViews.get(canonical);
  if (!views) {
    views = new Set();
    pendingTextureViews.set(canonical, views);
  }
  views.add(view);
  view.version = 0;
}

/** Publishes every parked view of a settled canonical. Idempotent: the set is dropped first. */
function releasePendingTextureViews(canonical: THREE.Texture): void {
  const views = pendingTextureViews.get(canonical);
  if (!views) return;
  pendingTextureViews.delete(canonical);
  for (const view of views) view.needsUpdate = true;
}

/** Idle decoded images one loader keeps for reuse; see `ModelImageCache`. */
export interface ModelImageCacheLimits {
  /** Decoded images no texture holds any more, kept so the next build of that URL neither fetches nor decodes. */
  readonly count: number;
  /** Their decoded RGBA bytes, `width * height * 4` each. */
  readonly decodedBytes: number;
}

/** Exact current decoded-image sharing, plus three lifetime counters. */
export interface ModelImageCacheStats {
  /** URL records a load can still reach: in flight, held by textures, or idle. */
  readonly count: number;
  readonly pending: number;
  /** Records at least one live texture (a loaded base or any clone of it) still samples. */
  readonly held: number;
  readonly heldDecodedBytes: number;
  /** Decoded images nothing samples, kept within {@link ModelImageCacheLimits}. */
  readonly idle: number;
  readonly idleDecodedBytes: number;
  /** Fetch-and-decode starts. */
  readonly requests: number;
  /** Loads answered by an existing record, in flight or decoded. */
  readonly hits: number;
  /** Bitmaps closed. */
  readonly closed: number;
}

const DEFAULT_IMAGE_CACHE_LIMITS: ModelImageCacheLimits = Object.freeze({
  count: 256,
  decodedBytes: 64 * 1024 * 1024,
});

/**
 * A URL-cached loader already has residency limits of its own (spell and world-material lanes set
 * theirs), so by default it keeps no decode beyond them: an evicted base with no views left closes
 * its bitmap. A base re-acquired while views of the old one live still shares their decode.
 */
const CACHED_LOADER_IMAGE_CACHE_LIMITS: ModelImageCacheLimits = Object.freeze({
  count: 0,
  decodedBytes: 0,
});

/**
 * The decode that yields the texels the `<img>` upload produced for these textures.
 *
 * `THREE.TextureLoader` hands WebGL an `<img>`, and Chrome decodes it a second time, synchronously
 * and inside the draw that first samples it, because WebGL asks for pixels its image cache does not
 * hold: unpremultiplied and not colour-managed. That is the `Decode Image` inside the frame in a
 * `city-arrival` trace (2.7-15.3 ms). `createImageBitmap` decodes on a worker instead, and three
 * uploads an ImageBitmap without its unpack `pixelStorei` calls (`WebGLTextures.js:918-930` in
 * 0.185.1; WebGL does not apply them to a bitmap), so orientation, alpha and colour are the
 * bitmap's creation options, chosen as three's `<img>` upload set those flags:
 *
 * - no `imageOrientation`: every consumer uploads these with `flipY = false` (the client's v = 0 is
 *   the top row), and the default keeps the file's own orientation — not flipped;
 * - `premultiplyAlpha: "none"`: the textures keep three's default `premultiplyAlpha = false`, so
 *   the `<img>` went up with `UNPACK_PREMULTIPLY_ALPHA_WEBGL = false`;
 * - `colorSpaceConversion: "none"`: three sets `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` for an
 *   sRGB or NoColorSpace texture whose primaries match the working space's, and the client never
 *   moves the working space off linear sRGB (the same Rec. 709 primaries).
 */
const MODEL_IMAGE_DECODE: ImageBitmapOptions = Object.freeze({
  premultiplyAlpha: "none",
  colorSpaceConversion: "none",
});

/**
 * The request `THREE.TextureLoader`'s `<img crossorigin="anonymous">` made: CORS mode, cookies for
 * the page's own origin only, and so an `Origin` header wherever the gateway is another origin,
 * which is what its `/texture` route checks. `fetch` is read from the page at call time so the
 * patch-chain watch sees every answer. `priority: "low"` is the priority Chrome gives an image, so
 * texture requests keep their place behind the model fetches an arriving crowd waits on.
 */
const MODEL_IMAGE_REQUEST: RequestInit = Object.freeze({
  mode: "cors",
  credentials: "same-origin",
  priority: "low",
});

/** The browser path. Node has `fetch` but no decoder, and there the `<img>` loader stays in use. */
function bitmapDecodingAvailable(): boolean {
  return typeof fetch === "function"
    && typeof createImageBitmap === "function"
    && typeof ImageBitmap === "function";
}

async function decodeModelImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, MODEL_IMAGE_REQUEST);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return createImageBitmap(await response.blob(), MODEL_IMAGE_DECODE);
}

function decodedImageBytes(image: { readonly width?: unknown; readonly height?: unknown }): number {
  const { width, height } = image;
  if (typeof width !== "number" || typeof height !== "number") return 0;
  const bytes = width * height * 4;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
}

function closeImage(image: ImageBitmap): void {
  try {
    if (typeof (image as { close?: unknown }).close === "function") image.close();
  } catch { /* closing is best effort; the bitmap is unreachable either way */ }
}

/**
 * One shared decode answers many requests. A throwing callback must not starve the rest, and an
 * `<img>` callback that threw surfaced as an uncaught error, so this one still does.
 */
function deliver(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    queueMicrotask(() => { throw error; });
  }
}

interface ModelImageWaiter {
  readonly texture: THREE.Texture;
  readonly onLoad: (texture: THREE.Texture) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * The one `THREE.Source` every texture of one decoded URL shares.
 *
 * three keys a GL texture on (source, sampler settings) and counts the Textures using it
 * (`WebGLTextures.initTexture` / `deallocateTexture`), so builds that share this source and sample
 * it alike draw one GL texture, uploaded once, and a build's `dispose` only drops its own count.
 * What would still re-send the pixels is `source.version`: `Texture.copy` — every
 * `privateTextureView` — and every completion mark bump it, and the next draw then uploads the
 * same texels into the texture three already holds. `data` here is written once (the decoded
 * image, or the missing pixel on failure) and never changes, so only a changed `data` counts.
 * A new sampler variant is a new cache key, which three always uploads, whatever the version.
 */
class ModelImageSource extends THREE.Source<unknown> {
  readonly record: ModelImageRecord;
  #markedData: unknown = undefined;

  constructor(record: ModelImageRecord) {
    super(null);
    this.record = record;
  }

  override set needsUpdate(value: boolean) {
    if (value !== true || this.data === this.#markedData) return;
    this.#markedData = this.data;
    this.version++;
  }
}

class ModelImageRecord {
  readonly url: string;
  readonly cache: ModelImageCache;
  readonly source: ModelImageSource;
  status: ModelTextureStatus = "pending";
  bitmap: ImageBitmap | undefined = undefined;
  bytes = 0;
  /** Live textures on `source`: loaded bases and every clone of them. */
  holders = 0;
  waiters: ModelImageWaiter[] = [];
  /** Reachable through the cache's URL map; false once evicted, failed or cleared. */
  pooled = true;

  constructor(url: string, cache: ModelImageCache) {
    this.url = url;
    this.cache = cache;
    this.source = new ModelImageSource(this);
  }
}

/**
 * A texture over a {@link ModelImageSource}. It differs from `THREE.Texture` in one thing: a clone
 * counts as a holder, because `privateTextureView` clones the loaded base and a view can outlive
 * it (a spell build, a world material, a unit whose base was disposed first).
 */
class ModelImageTexture extends THREE.Texture {
  override copy(source: THREE.Texture): this {
    super.copy(source);
    holdModelImage(this);
    return this;
  }
}

/** The record each live holder counts against; a texture holds at most one. */
const modelImageHolders = new WeakMap<THREE.Texture, ModelImageRecord>();

/**
 * A holder dropped without `dispose()` still gives its count back once it is collected, so its
 * record can go idle and be closed on eviction. A backstop, never the ordinary release.
 */
const modelImageFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry<ModelImageRecord>((record) => record.cache.release(record))
  : undefined;

function holdModelImage(texture: THREE.Texture): void {
  const source = texture.source;
  const record = source instanceof ModelImageSource ? source.record : undefined;
  const previous = modelImageHolders.get(texture);
  if (previous === record) return;
  if (previous) releaseModelImageHolder(texture, previous);
  if (!record) return;
  modelImageHolders.set(texture, record);
  record.holders++;
  texture.addEventListener("dispose", onModelImageHolderDispose);
  modelImageFinalizer?.register(texture, record, texture);
}

function releaseModelImageHolder(texture: THREE.Texture, record: ModelImageRecord): void {
  modelImageHolders.delete(texture);
  texture.removeEventListener("dispose", onModelImageHolderDispose);
  modelImageFinalizer?.unregister(texture);
  record.cache.release(record);
}

/** `Texture.dispose` emits on every call; the holder map makes the release exactly once. */
function onModelImageHolderDispose(event: { readonly target: THREE.Texture }): void {
  const texture = event.target;
  const record = modelImageHolders.get(texture);
  if (record) releaseModelImageHolder(texture, record);
}

/**
 * Decoded model images by URL, shared by every texture one loader hands out for that URL.
 *
 * A crowd names the same hair, cape and eye-glow files across displayIds, and the ordinary unit
 * loader keeps no URL cache: each build owns and disposes its own textures. So the decode is
 * shared rather than the Texture. Every `load` still returns a new Texture its caller owns, but
 * all of them sit on one {@link ModelImageSource}: a repeated appearance neither fetches, decodes
 * nor uploads again. A record lives while any texture holds it and, once idle, within
 * {@link ModelImageCacheLimits}. Its bitmap is closed only when it is out of the map *and* nothing
 * holds it, because a live texture may need it again: a new sampler variant, a restored context.
 * A failed record leaves the map at once, so the next load asks again, as every `<img>` did.
 */
class ModelImageCache {
  readonly #limits: ModelImageCacheLimits;
  /** Insertion order is the idle order: a release, or a landing nobody waits on, moves a record last. */
  readonly #records = new Map<string, ModelImageRecord>();
  #requests = 0;
  #hits = 0;
  #closed = 0;

  constructor(limits: ModelImageCacheLimits) {
    this.#limits = limits;
  }

  /** `TextureLoader.load`'s contract: a Texture now, exactly one callback when its pixels settle. */
  load(
    url: string,
    onLoad: (texture: THREE.Texture) => void,
    onError: (error: unknown) => void,
  ): THREE.Texture {
    // A hit needs no LRU touch: it makes the record held, and only idle records are evicted, in
    // the order they were released or landed.
    let record = this.#records.get(url);
    const fresh = record === undefined;
    if (record) {
      this.#hits++;
    } else {
      record = new ModelImageRecord(url, this);
      this.#records.set(url, record);
      this.#requests++;
    }
    const texture = new ModelImageTexture();
    texture.source = record.source;
    holdModelImage(texture);
    if (record.status === "ready") {
      // Decoded already: settle inline, as a cache layer may. Marking this texture binds the shared
      // GL texture; the source mark it carries is not a change of pixels and uploads nothing.
      texture.needsUpdate = true;
      onLoad(texture);
    } else {
      record.waiters.push({ texture, onLoad, onError });
    }
    if (fresh) void this.#decode(record);
    return texture;
  }

  /** One holder went away: disposed, re-pointed, or collected without either. */
  release(record: ModelImageRecord): void {
    if (record.holders > 0) record.holders--;
    if (record.holders > 0) return;
    if (!record.pooled) {
      this.#close(record);
      return;
    }
    if (record.status !== "ready") return;
    this.#touch(record);
    this.#trim();
  }

  /**
   * Forgets every record. Idle bitmaps close now; held ones close when their last texture goes;
   * a decode still in flight is published only if a texture still waits on it.
   */
  clear(): void {
    const records = [...this.#records.values()];
    this.#records.clear();
    for (const record of records) {
      record.pooled = false;
      if (record.holders === 0) this.#close(record);
    }
  }

  get stats(): Readonly<ModelImageCacheStats> {
    let pending = 0;
    let held = 0;
    let heldDecodedBytes = 0;
    let idle = 0;
    let idleDecodedBytes = 0;
    for (const record of this.#records.values()) {
      if (record.status === "pending") pending++;
      if (record.holders > 0) {
        held++;
        heldDecodedBytes += record.bytes;
      } else if (record.status === "ready") {
        idle++;
        idleDecodedBytes += record.bytes;
      }
    }
    return Object.freeze({
      count: this.#records.size,
      pending,
      held,
      heldDecodedBytes,
      idle,
      idleDecodedBytes,
      requests: this.#requests,
      hits: this.#hits,
      closed: this.#closed,
    });
  }

  async #decode(record: ModelImageRecord): Promise<void> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await decodeModelImage(record.url);
    } catch (error) {
      this.#fail(record, error);
      return;
    }
    this.#publish(record, bitmap);
  }

  #publish(record: ModelImageRecord, bitmap: ImageBitmap): void {
    const waiters = record.waiters;
    record.waiters = [];
    if (!record.pooled && record.holders === 0) {
      // Cleared while in flight, and every texture that waited has been disposed since: nothing
      // can draw it, and the stale requests it would answer were already reset by that clear.
      closeImage(bitmap);
      this.#closed++;
      return;
    }
    record.bitmap = bitmap;
    record.bytes = decodedImageBytes(bitmap);
    record.status = "ready";
    // One write reaches every texture on this source, and every view cloned from one of them.
    record.source.data = bitmap;
    for (const waiter of waiters) {
      deliver(() => {
        // What `TextureLoader` does before its callback; the loader's own completion marks again.
        waiter.texture.needsUpdate = true;
        waiter.onLoad(waiter.texture);
      });
    }
    if (record.pooled && record.holders === 0) {
      this.#touch(record);
      this.#trim();
    }
  }

  #fail(record: ModelImageRecord, error: unknown): void {
    record.status = "failed";
    if (this.#records.get(record.url) === record) this.#records.delete(record.url);
    record.pooled = false;
    const waiters = record.waiters;
    record.waiters = [];
    for (const waiter of waiters) deliver(() => waiter.onError(error));
  }

  #touch(record: ModelImageRecord): void {
    if (this.#records.get(record.url) !== record) return;
    this.#records.delete(record.url);
    this.#records.set(record.url, record);
  }

  /** Closes the longest-idle decoded images until both limits hold. Held and pending ones stay. */
  #trim(): void {
    const limits = this.#limits;
    let count = 0;
    let bytes = 0;
    for (const record of this.#records.values()) {
      if (record.holders > 0 || record.status !== "ready") continue;
      count++;
      bytes += record.bytes;
    }
    for (const record of this.#records.values()) {
      if (count <= limits.count && bytes <= limits.decodedBytes) break;
      if (record.holders > 0 || record.status !== "ready") continue;
      // With the count met, an image of unknown size cannot reduce the byte overflow.
      if (count <= limits.count && record.bytes === 0) continue;
      this.#records.delete(record.url);
      record.pooled = false;
      count--;
      bytes -= record.bytes;
      this.#close(record);
    }
  }

  #close(record: ModelImageRecord): void {
    const bitmap = record.bitmap;
    if (!bitmap) return;
    record.bitmap = undefined;
    // Nothing samples it any more; a texture that did would now upload nothing and say so, rather
    // than hand WebGL a closed bitmap.
    if (record.source.data === bitmap) record.source.data = null;
    closeImage(bitmap);
    this.#closed++;
  }
}

/**
 * A texture, and a visible answer when there is not one.
 *
 * `TextureLoader.load` is fire-and-forget: the object it returns is filled in later or is left
 * as it was, and nothing downstream is told which. The error callback is the only place that
 * knows, and swapping in an opaque pixel there is what keeps an alpha-keyed material — hair,
 * foliage, a cloth fringe — from disappearing entirely rather than merely looking wrong.
 *
 * In a browser the pixels come from `ModelImageCache` instead — fetched, decoded off the main
 * thread and shared by URL — through the same callbacks; `TextureLoader` remains the path where
 * there is no `createImageBitmap` (Node tests).
 */
export class ModelTextureLoader {
  readonly #loader = new THREE.TextureLoader();
  /** Decoded images shared by every texture this loader hands out for one URL. */
  readonly #images: ModelImageCache;
  /** Whether this loader owns a URL cache. The ordinary model loader keeps its historical per-build ownership. */
  readonly #cacheEnabled: boolean;
  readonly #cacheLimits: ModelTextureCacheLimits;
  /** One in-flight/GPU texture per URL, so geometry and emitters cannot race separate placeholders. */
  readonly #entries = new Map<string, TextureEntry>();
  #byTexture = new WeakMap<THREE.Texture, TextureEntry>();
  /** Invalidates callbacks captured by a previous renderer world/session. */
  #epoch = 0;
  #pending = 0;
  #ready = 0;
  #failed = 0;
  /** Exact terminal request ids; numbers avoid retaining uncached failed Texture handles. */
  readonly #errors = new Set<number>();
  #generation = 0;
  #requestSequence = 0;
  #knownLogicalTextureBytes = 0;
  /** Texture.dispose emits on every call, so cached-base ownership needs its own exact-once guard. */
  readonly #disposedTextures = new WeakSet<THREE.Texture>();

  constructor(options: {
    cache?: boolean;
    limits?: Partial<ModelTextureCacheLimits>;
    images?: Partial<ModelImageCacheLimits>;
  } = {}) {
    this.#cacheEnabled = options.cache === true;
    const count = options.limits?.count ?? DEFAULT_CACHE_LIMITS.count;
    const knownBytes = options.limits?.knownLogicalTextureBytes
      ?? DEFAULT_CACHE_LIMITS.knownLogicalTextureBytes;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("model texture cache count limit must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(knownBytes) || knownBytes < 0) {
      throw new RangeError("model texture cache byte limit must be a non-negative safe integer");
    }
    this.#cacheLimits = Object.freeze({ count, knownLogicalTextureBytes: knownBytes });
    const imageDefaults = this.#cacheEnabled ? CACHED_LOADER_IMAGE_CACHE_LIMITS : DEFAULT_IMAGE_CACHE_LIMITS;
    const imageCount = options.images?.count ?? imageDefaults.count;
    const imageBytes = options.images?.decodedBytes ?? imageDefaults.decodedBytes;
    if (!Number.isSafeInteger(imageCount) || imageCount < 0) {
      throw new RangeError("model image cache count limit must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(imageBytes) || imageBytes < 0) {
      throw new RangeError("model image cache byte limit must be a non-negative safe integer");
    }
    this.#images = new ModelImageCache(Object.freeze({ count: imageCount, decodedBytes: imageBytes }));
  }

  /**
   * What a texture becomes when its fetch fails: one opaque white pixel.
   *
   * A failed load leaves `map` pointing at a transparent placeholder, and a hair card is drawn
   * with `alphaTest = 224/255` — so every fragment of it is discarded and the character is bald.
   * Not untextured, not pink, not a missing-texture chequer: *bald*, which is indistinguishable
   * from a character who chose to be. One opaque pixel makes the failure look like a failure.
   *
   * It never worked. Until now this assigned a `DataTexture`'s `{data, width, height}` onto the
   * plain `THREE.Texture` that `TextureLoader.load` hands back, and three decides which upload
   * path an image takes by the `isDataTexture` flag alone (`WebGLTextures.js:972` in 0.185.1) —
   * so the pixel went down the `HTMLImageElement` branch, `texSubImage2D` was called with a bare
   * object, and `WebGLState.js:1004-1016` caught the resulting `TypeError` and turned it into a
   * console line. What was left bound was the 1×1 storage three had just allocated, zero-filled:
   * transparent black, which is the very thing the opaque pixel exists to avoid.
   *
   * The object the material holds is therefore turned into a data texture rather than handed one:
   * the flag, the image shape and the four settings `DataTexture`'s own constructor applies. It is
   * a one-way change — a texture that failed is never filled in afterwards — so nothing can end up
   * flagged as data while holding an image.
   */
  load(url: string): THREE.Texture {
    if (this.#cacheEnabled) {
      const existing = this.#entries.get(url);
      if (existing?.texture) {
        this.#touch(existing);
        return existing.texture;
      }
    }

    // The callbacks run after the binding is initialised in the browser, so naming the entry here
    // is safe and is the only way to reach the object the loader is filling in.  Keep the failed
    // state separate from the opaque diagnostic pixel: spell phases must suppress a failed asset,
    // while ordinary world models may still use that pixel as their visible fallback.
    const epoch = this.#epoch;
    const requestId = ++this.#requestSequence;
    const entry: TextureEntry = {
      url,
      epoch,
      requestId,
      cached: this.#cacheEnabled,
      texture: undefined,
      status: "pending",
      knownLogicalTextureBytes: undefined,
      leases: new Set(),
    };
    if (this.#cacheEnabled) this.#entries.set(url, entry);
    let texture: THREE.Texture;
    // The browser loader is asynchronous, but keeping completion until the returned texture is
    // assigned also makes this safe for test loaders and cache layers that invoke callbacks inline.
    let completionTexture: THREE.Texture | undefined;
    // A non-standard loader may report more than one terminal callback inline. Until `load`
    // returns, one of those callback arguments may be the exact Texture that will become the
    // canonical cached base, so it cannot be classified as stale yet.
    const duplicateCompletionTextures = new Set<THREE.Texture>();
    let settled = false;
    this.#pending++;
    const finish = (
      status: Exclude<ModelTextureStatus, "pending">,
      completedTexture?: THREE.Texture,
    ): void => {
      // A loader callback is terminal exactly once. This matters for a failed request whose
      // transport layer reports a late success: it must not resurrect the entry or decrement the
      // pending count a second time.
      if (settled) {
        if (completedTexture) {
          if (entry.texture === undefined) {
            if (completedTexture !== completionTexture) {
              duplicateCompletionTextures.add(completedTexture);
            }
          } else if (completedTexture !== entry.texture) {
            try {
              this.#disposeCachedTexture(completedTexture);
            } catch { /* a duplicate callback must not surface cleanup-listener failures */ }
          }
        }
        return;
      }
      settled = true;
      if (!this.#isCurrent(entry)) {
        // Cached stale handles have no caller-owned lifetime after clear. For uncached requests the
        // returned identity still belongs to the caller, so release only a distinct callback-only
        // handle; an inline stale callback is deferred until the return identity is knowable.
        if (!entry.cached && completedTexture && entry.texture === undefined) {
          completionTexture = completedTexture;
        } else if (completedTexture && (entry.cached || completedTexture !== entry.texture)) {
          try {
            this.#disposeCachedTexture(completedTexture);
          } catch { /* stale completion cleanup is best effort */ }
        }
        return;
      }
      // Three's loader returns and completes the same Texture. A non-standard loader that reports
      // a different handle has not populated the object already handed to the caller/material, so
      // accepting that callback as ready would publish an empty base and orphan the delivered one.
      const completionMismatch = status === "ready"
        && completedTexture !== undefined
        && entry.texture !== undefined
        && completedTexture !== entry.texture;
      const terminalStatus = completionMismatch ? "failed" : status;
      completionTexture = completedTexture;
      this.#pending--;
      this.#generation++;
      if (terminalStatus === "ready") this.#ready++;
      else this.#failed++;
      if (terminalStatus === "ready") this.#errors.delete(entry.requestId);
      else this.#errors.add(entry.requestId);
      entry.status = terminalStatus;
      if (entry.texture) this.#applyCompletion(entry);
      if (completionMismatch) {
        try {
          this.#disposeCachedTexture(completedTexture);
        } catch { /* terminal state is already published; orphan cleanup is best effort */ }
      }
    };
    const ready = (loaded: THREE.Texture) => {
      finish("ready", loaded);
    };
    const failed = () => {
      finish("failed");
      // An <img> never shows its 409 body: if the gateway's patch latch is why, say so once.
      suspectPatchChainChange(url);
    };
    try {
      texture = bitmapDecodingAvailable()
        ? this.#images.load(url, ready, failed)
        : this.#loader.load(url, ready, undefined, failed);
    } catch (error) {
      // No usable texture handle exists when the underlying loader itself throws. Keep the
      // historical throw while restoring exact current counters for subsequent readiness checks.
      if (this.#isCurrent(entry)) {
        if (entry.cached) {
          if (!settled) {
            settled = true;
            this.#generation++;
          }
          // Also rolls back an inline completion followed by a non-standard throw: no returned
          // handle means there is no retained/current terminal record to count.
          this.#removeCachedEntry(entry);
        } else if (!settled) {
          settled = true;
          this.#pending--;
          this.#generation++;
          this.#failed++;
          entry.status = "failed";
          this.#errors.add(entry.requestId);
        } else if (entry.status === "ready") {
          // An inline terminal callback followed by a throw published no usable handle. Preserve
          // its one settlement generation, but roll back the terminal record itself.
          this.#ready--;
        } else {
          this.#failed--;
          this.#errors.delete(entry.requestId);
        }
      }
      const abandonedCallbackTextures = new Set(duplicateCompletionTextures);
      if (completionTexture) abandonedCallbackTextures.add(completionTexture);
      for (const abandoned of abandonedCallbackTextures) {
        try {
          this.#disposeCachedTexture(abandoned);
        } catch { /* preserve the loader error and continue exact orphan cleanup */ }
      }
      throw error;
    }
    entry.texture = texture;
    // A reentrant clear/replacement may have invalidated the request before the underlying loader
    // returned. Keep the identity locally for exact orphan comparison, but never republish a stale
    // uncached status record (cached status already has the URL-map guard as a second defence).
    if (this.#isCurrent(entry)) this.#byTexture.set(texture, entry);
    if (this.#isCurrent(entry) && entry.status === "ready"
      && completionTexture !== undefined && completionTexture !== texture) {
      // Inline completion happened before the returned identity was knowable. Preserve the one
      // settlement generation, but reject the mismatched success exactly as the async path does.
      this.#ready--;
      this.#failed++;
      this.#errors.add(entry.requestId);
      entry.status = "failed";
    }
    if (entry.status !== "pending") this.#applyCompletion(entry);
    // `clear()` or an exact-URL replacement can occur reentrantly inside a non-standard loader.
    // The returned handle then never became the current cached base and belongs to nobody.
    if (entry.cached && !this.#isCurrent(entry)) {
      try {
        this.#disposeCachedTexture(texture);
      } catch { /* continue draining callback-only handles before acquire reports the lost request */ }
    }
    if (completionTexture && completionTexture !== texture) {
      try {
        this.#disposeCachedTexture(completionTexture);
      } catch { /* the returned handle remains the caller's result */ }
    }
    for (const duplicate of duplicateCompletionTextures) {
      if (duplicate === texture) continue;
      try {
        this.#disposeCachedTexture(duplicate);
      } catch { /* duplicate callback cleanup is best effort */ }
    }
    return texture;
  }

  /**
   * Borrows one exact cached request. Concurrent owners share its base Texture/Source but receive
   * distinct release handles, so an old owner's release cannot touch a replacement URL record.
   */
  acquire(url: string, ownerToken: unknown): ModelTextureLease {
    if (!this.#cacheEnabled) throw new Error("model texture leases require cache mode");
    const texture = this.load(url);
    const entry = this.#entries.get(url);
    if (!entry || entry.texture !== texture) {
      throw new Error("model texture cache lost the request during acquisition");
    }
    let released = false;
    let lease: ModelTextureLease;
    lease = Object.freeze({
      url,
      texture,
      ownerToken,
      requestId: entry.requestId,
      get released() { return released; },
      release: () => {
        if (released) return;
        released = true;
        // Delete from the captured exact record, never whichever request now occupies this URL.
        entry.leases.delete(lease);
      },
    });
    entry.leases.add(lease);
    return lease;
  }

  /** Promotes only the exact current unreleased cached request borrowed by this lease. */
  touch(lease: ModelTextureLease): boolean {
    if (!this.#cacheEnabled || lease.released) return false;
    const entry = this.#entries.get(lease.url);
    if (!entry || entry.requestId !== lease.requestId || entry.texture !== lease.texture
      || !entry.leases.has(lease)) return false;
    this.#touch(entry);
    return true;
  }

  /** Exact current pressure records in true texture LRU order. */
  pressureSnapshot(): readonly ModelTexturePressureRecord[] {
    if (!this.#cacheEnabled) return Object.freeze([]);
    const records: ModelTexturePressureRecord[] = [];
    for (const entry of this.#entries.values()) {
      records.push(Object.freeze({
        url: entry.url,
        requestId: entry.requestId,
        status: entry.status,
        knownLogicalTextureBytes: entry.knownLogicalTextureBytes,
        ownerTokens: Object.freeze([...entry.leases].map((lease) => lease.ownerToken)),
      }));
    }
    return Object.freeze(records);
  }

  /** Removes oldest settled, unleased cached bases until both soft limits are met. */
  evictUnleased(): readonly string[] {
    if (!this.#cacheEnabled) return Object.freeze([]);
    const evicted: string[] = [];
    for (const [url, entry] of this.#entries) {
      if (this.#withinCacheLimits()) break;
      if (entry.status === "pending" || entry.leases.size > 0) continue;
      const countOverflow = this.#entries.size > this.#cacheLimits.count;
      const knownByteOverflow = this.#knownLogicalTextureBytes
        > this.#cacheLimits.knownLogicalTextureBytes;
      // With count already within budget, an unknown/zero-byte record cannot reduce the only
      // violated metric. Preserve true LRU order among useful candidates by scanning onward to the
      // oldest entry whose known allocation can actually converge byte pressure.
      if (!countOverflow && knownByteOverflow
        && (entry.knownLogicalTextureBytes ?? 0) === 0) continue;
      this.#removeCachedEntry(entry);
      evicted.push(url);
    }
    return Object.freeze(evicted);
  }

  /** Releases cached textures and starts a new async-completion epoch. Safe to repeat. */
  clear(): void {
    this.#epoch++;
    const detached = [...this.#entries.values()];
    for (const entry of detached) entry.leases.clear();
    // Publish the new empty epoch before synchronous Texture.dispose listeners run. A listener may
    // acquire the same URL for the new epoch; it must receive a fresh request that survives this
    // clear, never a lease on the exact texture currently being disposed.
    this.#entries.clear();
    // The decoded images go with them, before the same listeners: idle bitmaps close now, held ones
    // when the last texture on them is disposed, and a reentrant load starts a fresh record.
    this.#images.clear();
    this.#byTexture = new WeakMap();
    this.#pending = 0;
    this.#ready = 0;
    this.#failed = 0;
    this.#errors.clear();
    this.#knownLogicalTextureBytes = 0;
    this.#generation++;
    let firstError: unknown;
    for (const entry of detached) {
      if (!entry.texture) continue;
      try {
        this.#disposeCachedTexture(entry.texture);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /** Current network/GPU readiness for the texture returned by {@link load}. */
  status(texture: THREE.Texture): ModelTextureStatus {
    const entry = this.#byTexture.get(texture);
    if (!entry) return "failed";
    if (entry.cached && this.#entries.get(entry.url) !== entry) return "failed";
    return entry.status;
  }

  /** Current status for a URL, without starting a request. */
  statusOf(url: string): ModelTextureStatus | undefined {
    return this.#entries.get(url)?.status;
  }

  /** Immutable current request totals; cache hits do not create another request. */
  get stats(): Readonly<ModelTextureLoaderStats> {
    return Object.freeze({
      pending: this.#pending,
      ready: this.#ready,
      failed: this.#failed,
      error: this.#errors.size,
      generation: this.#generation,
    });
  }

  /** Decoded-image sharing behind this loader's textures. All zero where `TextureLoader` is used. */
  get imageCacheStats(): Readonly<ModelImageCacheStats> {
    return this.#images.stats;
  }

  /** Immutable current cached-base count/bytes/pins and soft-limit overflow. */
  get residencyStats(): Readonly<ModelTextureResidencyStats> {
    let activeLeases = 0;
    let pinnedCount = 0;
    let unknownLogicalTextureCount = 0;
    for (const entry of this.#entries.values()) {
      activeLeases += entry.leases.size;
      if (entry.status === "pending" || entry.leases.size > 0) pinnedCount++;
      if (entry.knownLogicalTextureBytes === undefined) unknownLogicalTextureCount++;
    }
    return Object.freeze({
      count: this.#entries.size,
      knownLogicalTextureBytes: this.#knownLogicalTextureBytes,
      unknownLogicalTextureCount,
      activeLeases,
      pinnedCount,
      overflowCount: Math.max(0, this.#entries.size - this.#cacheLimits.count),
      overflowKnownLogicalTextureBytes: Math.max(
        0,
        this.#knownLogicalTextureBytes - this.#cacheLimits.knownLogicalTextureBytes,
      ),
    });
  }

  /** Visits only strong URL-cache entries; uncached loads intentionally have no retention ledger. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const entry of this.#entries.values()) {
      if (entry.texture) visitor.referenceGpuTexture(this, entry.texture);
    }
  }

  #isCurrent(entry: TextureEntry): boolean {
    return entry.epoch === this.#epoch
      && (!entry.cached || this.#entries.get(entry.url) === entry);
  }

  #touch(entry: TextureEntry): void {
    if (!entry.cached || this.#entries.get(entry.url) !== entry) return;
    this.#entries.delete(entry.url);
    this.#entries.set(entry.url, entry);
  }

  #applyCompletion(entry: TextureEntry): void {
    const texture = entry.texture;
    if (!texture || !this.#isCurrent(entry)) return;
    if (entry.status === "ready") texture.needsUpdate = true;
    else substituteMissingPixel(texture);
    // Parked private views share this source: publish them after the canonical's own mark (or
    // its missing pixel), so their first upload reads resolved pixels rather than nothing.
    releasePendingTextureViews(texture);
    if (!entry.cached) return;
    const measured = knownLogicalTextureBytes(texture);
    if (entry.knownLogicalTextureBytes !== undefined) {
      this.#knownLogicalTextureBytes -= entry.knownLogicalTextureBytes;
    }
    entry.knownLogicalTextureBytes = measured;
    if (measured !== undefined) this.#knownLogicalTextureBytes += measured;
  }

  #removeCachedEntry(entry: TextureEntry): void {
    if (this.#entries.get(entry.url) !== entry) return;
    this.#entries.delete(entry.url);
    if (entry.status === "pending") this.#pending--;
    else if (entry.status === "ready") this.#ready--;
    else {
      this.#failed--;
      this.#errors.delete(entry.requestId);
    }
    if (entry.knownLogicalTextureBytes !== undefined) {
      this.#knownLogicalTextureBytes -= entry.knownLogicalTextureBytes;
    }
    entry.leases.clear();
    if (entry.texture) this.#disposeCachedTexture(entry.texture);
  }

  #disposeCachedTexture(texture: THREE.Texture): void {
    if (this.#disposedTextures.has(texture)) return;
    this.#disposedTextures.add(texture);
    texture.dispose();
  }

  #withinCacheLimits(): boolean {
    return this.#entries.size <= this.#cacheLimits.count
      && this.#knownLogicalTextureBytes <= this.#cacheLimits.knownLogicalTextureBytes;
  }
}

/**
 * Turns one texture into the opaque white pixel, in place.
 *
 * Exported so a test can assert the shape three's uploader requires without a WebGL context: the
 * flag that picks the branch, and the four fields `DataTexture` sets that a `Texture` does not.
 */
export function substituteMissingPixel(texture: THREE.Texture): void {
  texture.image = { data: MISSING_PIXEL, width: 1, height: 1 };
  (texture as THREE.Texture & { isDataTexture?: boolean }).isDataTexture = true;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
}
