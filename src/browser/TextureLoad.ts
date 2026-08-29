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
 * A texture, and a visible answer when there is not one.
 *
 * `TextureLoader.load` is fire-and-forget: the object it returns is filled in later or is left
 * as it was, and nothing downstream is told which. The error callback is the only place that
 * knows, and swapping in an opaque pixel there is what keeps an alpha-keyed material — hair,
 * foliage, a cloth fringe — from disappearing entirely rather than merely looking wrong.
 */
export class ModelTextureLoader {
  readonly #loader = new THREE.TextureLoader();
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

  constructor(options: { cache?: boolean; limits?: Partial<ModelTextureCacheLimits> } = {}) {
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
    };
    try {
      texture = this.#loader.load(url, ready, undefined, failed);
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
