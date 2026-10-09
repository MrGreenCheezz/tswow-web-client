import * as THREE from "three";
import { recencyStampLimit, renumberByUsed } from "./RecencyStamps.js";
import {
  ModelTextureLoader,
  type ModelTextureLease,
  type ModelTexturePressureRecord,
  type ModelTextureResidencyStats,
} from "./TextureLoad.js";
import {
  visitMaterialTextures, type RetainedResourceVisitor,
} from "./ResourceAccounting.js";

export const WORLD_MATERIAL_CACHE_COUNT_LIMIT = 256;

export interface WorldMaterialCacheLimits {
  readonly count: number;
}

export interface WorldMaterialCacheOptions {
  readonly limits?: Partial<WorldMaterialCacheLimits>;
  /**
   * P1-11: run the pre-P1-11 {@link WorldMaterialCache.commitPins} whole — every pass, a pressure
   * snapshot before each phase. The reference of the differential tests and of P2-05.
   */
  readonly legacyScan?: boolean;
}

/** The shared answer of a commit with nothing evicted on the unchanged-pins path. */
const EMPTY_EVICTIONS: readonly string[] = Object.freeze([]);

/** Everything required to publish one exact cache-key/material identity. */
export interface WorldMaterialSpec {
  readonly key: string;
  readonly kind: string;
  readonly textureUrl?: string;
  readonly createMaterial: (texture?: THREE.Texture) => THREE.Material;
  /** Creates the optional per-material sampling/transform view owned by this entry. */
  readonly createPrivateView?: (base: THREE.Texture) => THREE.Texture;
}

/** Opaque exact cache identity. Callers pin this object, not a reconstructed key. */
export interface WorldMaterialEntry {
  readonly key: string;
  readonly kind: string;
  readonly material: THREE.Material;
}

export interface WorldMaterialResidencyStats {
  readonly materials: Readonly<{
    readonly count: number;
    readonly pinnedCount: number;
    readonly pendingTextureCount: number;
    readonly overflowCount: number;
  }>;
  readonly textures: Readonly<ModelTextureResidencyStats>;
}

/** Formal-readiness fields for the shared texture lane after exact frame admission. */
export interface WorldMaterialTextureReadiness {
  /** Every in-flight request remains visible because its settlement can still mutate the lane. */
  readonly pending: number;
  /** Distinct failed bases borrowed by the current committed material footprint. */
  readonly error: number;
  /** Loader settlement generation; material publication/removal is exposed separately by revision. */
  readonly generation: number;
}

interface CachedWorldMaterial {
  readonly publicEntry: WorldMaterialEntry;
  readonly ownerToken: object;
  readonly lease: ModelTextureLease | undefined;
  readonly privateView: THREE.Texture | undefined;
  removed: boolean;
  /** P1-10b: recency stamp, written at creation and on every touch; the smallest is the oldest. */
  used: number;
  /**
   * P1-11: whether the texture request was pending when the count-limit pass began. That pass
   * judged "pending" from one snapshot taken before it removed anything, and still does.
   */
  pendingAtScan: boolean;
}

interface PressureIndex {
  readonly records: readonly ModelTexturePressureRecord[];
  readonly byOwner: ReadonlyMap<unknown, ModelTexturePressureRecord>;
}

/**
 * Exact bounded world-material ownership with post-admission frame pins.
 *
 * The injected cache-enabled texture loader is a dedicated owned lane. Material entries own exact
 * leases from it, and {@link dispose} clears that loader only after every material and private view
 * has been disposed and every lease released.
 */
export class WorldMaterialCache {
  readonly #textures: ModelTextureLoader;
  readonly #limits: WorldMaterialCacheLimits;
  /** Creation order; the true material LRU is the `used` stamp of each entry, oldest smallest. */
  readonly #entries = new Map<string, CachedWorldMaterial>();
  readonly #byPublicEntry = new WeakMap<WorldMaterialEntry, CachedWorldMaterial>();
  readonly #byMaterial = new WeakMap<THREE.Material, CachedWorldMaterial>();
  readonly #byOwner = new Map<unknown, CachedWorldMaterial>();
  #pins = new Set<WorldMaterialEntry>();
  /** Distinguishes a valid committed-empty footprint from construction before the first frame. */
  #pinsCommitted = false;
  #revision = 0;
  readonly #legacyScan: boolean;
  /**
   * P1-11: both revisions as they stood when the last full commit pass began. A pass that changed
   * nothing leaves them equal to the current ones; then the same pins again would find the same
   * fixed point, and {@link commitPins} only touches them.
   */
  #settledRevision = -1;
  #settledLoaderRevision = -1;
  /** Scratch flag of {@link #checkUnchangedPin}, so the pin walk needs no iterator or closure. */
  #pinsUnchanged = false;
  #clock = 0;
  #disposed = false;
  #activeBuilds = 0;
  #activeTeardowns = 0;
  #loaderClearPending = false;
  readonly #buildingKeys = new Set<string>();

  constructor(
    textures: ModelTextureLoader = new ModelTextureLoader({ cache: true }),
    options: WorldMaterialCacheOptions = {},
  ) {
    this.#textures = textures;
    const count = options.limits?.count ?? WORLD_MATERIAL_CACHE_COUNT_LIMIT;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("world material cache count limit must be a non-negative safe integer");
    }
    this.#limits = Object.freeze({ count });
    this.#legacyScan = options.legacyScan === true;
  }

  get revision(): number { return this.#revision; }

  /** Exact material-entry count, optionally restricted to one caller-owned residency kind. */
  entryCount(kind?: string): number {
    if (kind === undefined) return this.#entries.size;
    let count = 0;
    for (const entry of this.#entries.values()) {
      if (entry.publicEntry.kind === kind) count++;
    }
    return count;
  }

  get residencyStats(): Readonly<WorldMaterialResidencyStats> {
    const pressure = this.#pressureIndex();
    let pendingTextureCount = 0;
    let pinnedCount = 0;
    for (const entry of this.#entries.values()) {
      const pending = this.#pressureFor(entry, pressure)?.status === "pending";
      if (pending) pendingTextureCount++;
      if (this.#pins.has(entry.publicEntry)) pinnedCount++;
    }
    return Object.freeze({
      materials: Object.freeze({
        count: this.#entries.size,
        pinnedCount,
        pendingTextureCount,
        overflowCount: Math.max(0, this.#entries.size - this.#limits.count),
      }),
      textures: this.#textures.residencyStats,
    });
  }

  /**
   * Keeps async settlement global while scoping terminal failures to the exact admitted footprint.
   * Before the first commit there is no trustworthy footprint, so standalone/pre-frame callers see
   * the loader's complete error count rather than a false zero.
   */
  get textureReadiness(): Readonly<WorldMaterialTextureReadiness> {
    const loader = this.#textures.stats;
    if (!this.#pinsCommitted) {
      return Object.freeze({
        pending: loader.pending,
        error: loader.error,
        generation: loader.generation,
      });
    }

    const pressure = this.#pressureIndex();
    let error = 0;
    for (const record of pressure.records) {
      if (record.status !== "failed") continue;
      const active = record.ownerTokens.some((token) => {
        const entry = this.#byOwner.get(token);
        return entry !== undefined
          && !entry.removed
          && this.#entries.get(entry.publicEntry.key) === entry
          && this.#pins.has(entry.publicEntry)
          && this.#pressureFor(entry, pressure) === record;
      });
      if (active) error++;
    }
    return Object.freeze({
      pending: loader.pending,
      error,
      generation: loader.generation,
    });
  }

  /** Returns and touches the exact current entry, or removes an entry whose texture lease is stale. */
  get(key: string): WorldMaterialEntry | undefined {
    if (this.#disposed) return undefined;
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.lease && !this.#textures.touch(entry.lease)) {
      this.#removeEntry(entry, true);
      this.#textures.evictUnleased();
      return undefined;
    }
    this.#touch(entry);
    return entry.publicEntry;
  }

  /** Publishes one material on a miss; a hit returns the same exact entry and touches both LRUs. */
  getOrCreate(spec: WorldMaterialSpec): WorldMaterialEntry {
    if (this.#disposed) throw new Error("world material cache is disposed");
    if (spec.createPrivateView && spec.textureUrl === undefined) {
      throw new Error("a private world material texture view requires textureUrl");
    }
    const existing = this.#entries.get(spec.key);
    if (existing) {
      if (!existing.lease || this.#textures.touch(existing.lease)) {
        this.#touch(existing);
        return existing.publicEntry;
      }
      // The dedicated loader was cleared or this URL/request was replaced. Its old exact lease is
      // inert and must not keep a material sampling a disposed base alive.
      this.#removeEntry(existing, true);
      this.#textures.evictUnleased();
      if (this.#disposed) throw new Error("world material cache is disposed");
    }
    if (this.#buildingKeys.has(spec.key)) {
      throw new Error(`reentrant world material build for key ${spec.key}`);
    }

    this.#buildingKeys.add(spec.key);
    this.#activeBuilds++;
    const ownerToken = Object.freeze({});
    let lease: ModelTextureLease | undefined;
    let privateView: THREE.Texture | undefined;
    let material: THREE.Material | undefined;
    let materialOwned = false;
    let hasPrimaryError = false;
    try {
      lease = spec.textureUrl === undefined
        ? undefined
        : this.#textures.acquire(spec.textureUrl, ownerToken);
      if (lease && spec.createPrivateView) {
        const candidate = spec.createPrivateView(lease.texture);
        if (!isTexture(candidate)) {
          throw new TypeError("world material private view factory must return a THREE.Texture");
        }
        if (candidate !== lease.texture) privateView = candidate;
      }
      if (this.#disposed) throw new Error("world material cache is disposed");
      material = spec.createMaterial(privateView ?? lease?.texture);
      if (!isMaterial(material)) {
        throw new TypeError("world material factory must return one THREE.Material");
      }
      if (this.#byMaterial.has(material)) {
        throw new Error("a THREE.Material can belong to only one world material cache entry");
      }
      materialOwned = true;
      if (this.#disposed) throw new Error("world material cache is disposed");
      if (this.#entries.has(spec.key)) {
        throw new Error(`world material key was published reentrantly: ${spec.key}`);
      }

      const publicEntry: WorldMaterialEntry = Object.freeze({
        key: spec.key,
        kind: spec.kind,
        material,
      });
      const entry: CachedWorldMaterial = {
        publicEntry,
        ownerToken,
        lease,
        privateView,
        removed: false,
        used: this.#nextUsed(),
        pendingAtScan: false,
      };
      this.#entries.set(spec.key, entry);
      this.#byPublicEntry.set(publicEntry, entry);
      this.#byMaterial.set(material, entry);
      this.#byOwner.set(ownerToken, entry);
      this.#revision++;
      // Ownership has moved into the published entry; the catch/finally path must not tear it down.
      lease = undefined;
      privateView = undefined;
      material = undefined;
      materialOwned = false;
      return publicEntry;
    } catch (error) {
      hasPrimaryError = true;
      // A synchronous Three dispose listener may throw. Ownership still has to drain in the same
      // material -> private view -> lease -> base order; preserve the factory/publication error.
      try {
        if (materialOwned && material) material.dispose();
      } catch { /* continue exact cleanup */ }
      try {
        privateView?.dispose();
      } catch { /* continue exact cleanup */ }
      try {
        lease?.release();
      } catch { /* continue exact cleanup */ }
      try {
        this.#textures.evictUnleased();
      } catch { /* preserve the original error */ }
      throw error;
    } finally {
      this.#buildingKeys.delete(spec.key);
      this.#activeBuilds--;
      try {
        this.#finishDeferredLoaderClear();
      } catch (error) {
        if (!hasPrimaryError) throw error;
      }
    }
  }

  /**
   * Commits exact entries admitted during the current frame, then converges material and texture
   * pressure wherever pending/current-frame ownership permits. Pins themselves are not structural.
   */
  commitPins(pins: ReadonlySet<WorldMaterialEntry>): readonly string[] {
    if (this.#disposed) return Object.freeze([]);
    if (this.#legacyScan) return this.#commitPinsLegacy(pins);
    // P1-11: the same pins over an unchanged cache and loader give the same (empty) answer; only
    // their touches are due, and the walk below has made them in the full pass's order.
    if (this.#commitUnchanged(pins)) return EMPTY_EVICTIONS;
    const revision = this.#revision;
    const loaderRevision = this.#textures.revision;
    const committed = new Set<WorldMaterialEntry>();
    for (const pin of pins) {
      const entry = this.#byPublicEntry.get(pin);
      if (!entry || entry.removed || this.#entries.get(pin.key) !== entry) continue;
      if (entry.lease && !this.#textures.touch(entry.lease)) continue;
      this.#touch(entry);
      committed.add(pin);
    }
    this.#pins = committed;
    this.#pinsCommitted = true;
    const evicted: string[] = [];

    // An externally cleared dedicated loader makes old exact leases inert. Admission normally
    // replaces them before this point; prune any dormant stale entry as well. `owns` answers what
    // the owner index of a pressure snapshot did: the lease sits in the current record of its URL.
    let stale: CachedWorldMaterial[] | undefined;
    for (const entry of this.#entries.values()) {
      if (!entry.lease || this.#textures.owns(entry.lease)) continue;
      (stale ??= []).push(entry);
    }
    if (stale && stale.length > 1) stale.sort((left, right) => left.used - right.used);
    for (const entry of stale ?? []) {
      evicted.push(entry.publicEntry.key);
      this.#removeEntry(entry, true);
      if (this.#disposed) return Object.freeze(evicted);
    }

    if (this.#entries.size > this.#limits.count) {
      // "Pending" is judged as of this moment for the whole pass, as the snapshot it replaces did;
      // an entry a dispose listener publishes meanwhile starts with false, as it was absent then.
      for (const entry of this.#entries.values()) {
        entry.pendingAtScan = entry.lease !== undefined
          && this.#textures.leaseStatus(entry.lease) === "pending";
      }
      while (this.#entries.size > this.#limits.count) {
        let candidate: CachedWorldMaterial | undefined;
        for (const entry of this.#entries.values()) {
          if ((candidate === undefined || entry.used < candidate.used)
            && !entry.pendingAtScan && !this.#pins.has(entry.publicEntry)) {
            candidate = entry;
          }
        }
        if (!candidate) break;
        evicted.push(candidate.publicEntry.key);
        this.#removeEntry(candidate, true);
        if (this.#disposed) return Object.freeze(evicted);
      }
    }
    this.#textures.evictUnleased();
    if (this.#disposed) return Object.freeze(evicted);

    // Texture pressure is ordered by the base cache's own LRU rather than material LRU. Evict all
    // owners only when that exact base can become unleased; otherwise a pinned/shared foreign owner
    // makes the overflow honest rather than sacrificing a material without reducing pressure.
    for (;;) {
      const countOverflow = this.#textures.overflowCount > 0;
      const byteOverflow = this.#textures.overflowKnownLogicalTextureBytes > 0;
      if (!countOverflow && !byteOverflow) break;
      const pressure = this.#pressureIndex();
      const owners = this.#reducibleOwners(pressure, countOverflow, byteOverflow);
      if (!owners) break;
      for (const entry of owners) {
        evicted.push(entry.publicEntry.key);
        this.#removeEntry(entry, true);
        if (this.#disposed) return Object.freeze(evicted);
      }
      this.#textures.evictUnleased();
      if (this.#disposed) return Object.freeze(evicted);
    }
    // A pass that changed anything moved a revision past these, so the next one runs in full.
    this.#settledRevision = revision;
    this.#settledLoaderRevision = loaderRevision;
    return evicted.length === 0 ? EMPTY_EVICTIONS : Object.freeze(evicted);
  }

  /** True when `pins` is exactly the committed set and nothing moved since a pass that settled. */
  #commitUnchanged(pins: ReadonlySet<WorldMaterialEntry>): boolean {
    if (!this.#pinsCommitted || pins.size !== this.#pins.size
      || this.#revision !== this.#settledRevision
      || this.#textures.revision !== this.#settledLoaderRevision) return false;
    this.#pinsUnchanged = true;
    // `forEach` with a bound method: a `Set` iterator would allocate its step results.
    pins.forEach(this.#checkUnchangedPin);
    return this.#pinsUnchanged;
  }

  /**
   * One pin of the unchanged-pins walk: valid and already committed, then touched texture first and
   * material second, as the full pass touches it. A miss stops the walk; the full pass then touches
   * every pin again in the same order, which leaves the same recency order.
   */
  readonly #checkUnchangedPin = (pin: WorldMaterialEntry): void => {
    if (!this.#pinsUnchanged) return;
    const entry = this.#byPublicEntry.get(pin);
    if (!entry || entry.removed || this.#entries.get(pin.key) !== entry || !this.#pins.has(pin)
      || (entry.lease !== undefined && !this.#textures.touch(entry.lease))) {
      this.#pinsUnchanged = false;
      return;
    }
    this.#touch(entry);
  };

  /** The owners of the oldest texture record whose removal can reduce the violated limit. */
  #reducibleOwners(
    pressure: PressureIndex,
    countOverflow: boolean,
    byteOverflow: boolean,
  ): CachedWorldMaterial[] | undefined {
    for (const record of pressure.records) {
      if (!countOverflow && byteOverflow
        && (record.knownLogicalTextureBytes ?? 0) === 0) continue;
      if (record.status === "pending" || record.ownerTokens.length === 0) continue;
      const candidateOwners: CachedWorldMaterial[] = [];
      let reducible = true;
      for (const token of record.ownerTokens) {
        const entry = this.#byOwner.get(token);
        if (!entry || entry.removed || this.#pressureFor(entry, pressure) !== record
          || this.#isPinned(entry, pressure)) {
          reducible = false;
          break;
        }
        if (!candidateOwners.includes(entry)) candidateOwners.push(entry);
      }
      if (reducible && candidateOwners.length > 0) return candidateOwners;
    }
    return undefined;
  }

  /** The pre-P1-11 commit pass, kept whole: see {@link WorldMaterialCacheOptions.legacyScan}. */
  #commitPinsLegacy(pins: ReadonlySet<WorldMaterialEntry>): readonly string[] {
    const committed = new Set<WorldMaterialEntry>();
    for (const pin of pins) {
      const entry = this.#byPublicEntry.get(pin);
      if (!entry || entry.removed || this.#entries.get(pin.key) !== entry) continue;
      if (entry.lease && !this.#textures.touch(entry.lease)) continue;
      this.#touch(entry);
      committed.add(pin);
    }
    this.#pins = committed;
    this.#pinsCommitted = true;
    const evicted: string[] = [];
    let pressure = this.#pressureIndex();

    // An externally cleared dedicated loader makes old exact leases inert. Admission normally
    // replaces them before this point; prune any dormant stale entry as well.
    let stale: CachedWorldMaterial[] | undefined;
    for (const entry of this.#entries.values()) {
      if (!entry.lease || this.#pressureFor(entry, pressure)) continue;
      (stale ??= []).push(entry);
    }
    if (stale && stale.length > 1) stale.sort((left, right) => left.used - right.used);
    for (const entry of stale ?? []) {
      evicted.push(entry.publicEntry.key);
      this.#removeEntry(entry, true);
      if (this.#disposed) return Object.freeze(evicted);
    }

    pressure = this.#pressureIndex();
    while (this.#entries.size > this.#limits.count) {
      let candidate: CachedWorldMaterial | undefined;
      for (const entry of this.#entries.values()) {
        if ((candidate === undefined || entry.used < candidate.used) && !this.#isPinned(entry, pressure)) {
          candidate = entry;
        }
      }
      if (!candidate) break;
      evicted.push(candidate.publicEntry.key);
      this.#removeEntry(candidate, true);
      if (this.#disposed) return Object.freeze(evicted);
    }
    this.#textures.evictUnleased();
    if (this.#disposed) return Object.freeze(evicted);

    // Texture pressure is ordered by the base cache's own LRU rather than material LRU. Evict all
    // owners only when that exact base can become unleased; otherwise a pinned/shared foreign owner
    // makes the overflow honest rather than sacrificing a material without reducing pressure.
    for (;;) {
      const textureStats = this.#textures.residencyStats;
      const countOverflow = textureStats.overflowCount > 0;
      const byteOverflow = textureStats.overflowKnownLogicalTextureBytes > 0;
      if (!countOverflow && !byteOverflow) break;
      pressure = this.#pressureIndex();
      let owners: CachedWorldMaterial[] | undefined;
      for (const record of pressure.records) {
        if (!countOverflow && byteOverflow
          && (record.knownLogicalTextureBytes ?? 0) === 0) continue;
        if (record.status === "pending" || record.ownerTokens.length === 0) continue;
        const candidateOwners: CachedWorldMaterial[] = [];
        let reducible = true;
        for (const token of record.ownerTokens) {
          const entry = this.#byOwner.get(token);
          if (!entry || entry.removed || this.#pressureFor(entry, pressure) !== record
            || this.#isPinned(entry, pressure)) {
            reducible = false;
            break;
          }
          if (!candidateOwners.includes(entry)) candidateOwners.push(entry);
        }
        if (reducible && candidateOwners.length > 0) {
          owners = candidateOwners;
          break;
        }
      }
      if (!owners) break;
      for (const entry of owners) {
        evicted.push(entry.publicEntry.key);
        this.#removeEntry(entry, true);
        if (this.#disposed) return Object.freeze(evicted);
      }
      this.#textures.evictUnleased();
      if (this.#disposed) return Object.freeze(evicted);
    }
    return Object.freeze(evicted);
  }

  /** Registers both material views and the owned base-texture lane with exact shared identities. */
  visitRetainedResources(visitor: RetainedResourceVisitor): void {
    for (const entry of this.#entries.values()) {
      if (entry.privateView) {
        // Use the material owner id so the ordinary attached-map visit remains idempotent, while a
        // factory that retained but did not attach its supplied private view is still exact.
        visitor.referenceGpuTexture(entry.publicEntry.material, entry.privateView);
      }
      visitMaterialTextures(visitor, entry.publicEntry.material);
    }
    this.#textures.visitRetainedResources(visitor);
  }

  /** Exactly-once inert teardown. The owned texture lane clears after material-side ownership. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pins.clear();
    this.#pinsCommitted = true;
    this.#revision++;
    let firstError: unknown;
    for (const entry of this.#byRecency()) {
      try {
        this.#removeEntry(entry, false);
      } catch (error) {
        firstError ??= error;
      }
    }
    this.#loaderClearPending = true;
    try {
      this.#finishDeferredLoaderClear();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  }

  #touch(entry: CachedWorldMaterial): void {
    if (entry.removed || this.#entries.get(entry.publicEntry.key) !== entry) return;
    entry.used = this.#nextUsed();
  }

  #nextUsed(): number {
    if (this.#clock >= recencyStampLimit) this.#clock = renumberByUsed(this.#entries.values());
    return ++this.#clock;
  }

  /** The current entries oldest first, as the re-insertion LRU used to keep them. */
  #byRecency(): CachedWorldMaterial[] {
    return [...this.#entries.values()].sort((left, right) => left.used - right.used);
  }

  #removeEntry(entry: CachedWorldMaterial, bumpRevision: boolean): boolean {
    if (entry.removed || this.#entries.get(entry.publicEntry.key) !== entry) return false;
    entry.removed = true;
    this.#entries.delete(entry.publicEntry.key);
    this.#byPublicEntry.delete(entry.publicEntry);
    this.#byMaterial.delete(entry.publicEntry.material);
    this.#byOwner.delete(entry.ownerToken);
    this.#pins.delete(entry.publicEntry);
    if (bumpRevision) this.#revision++;

    this.#activeTeardowns++;
    let firstError: unknown;
    try {
      try {
        entry.publicEntry.material.dispose();
      } catch (error) {
        firstError ??= error;
      }
      try {
        entry.privateView?.dispose();
      } catch (error) {
        firstError ??= error;
      }
      try {
        entry.lease?.release();
      } catch (error) {
        firstError ??= error;
      }
      try {
        this.#textures.evictUnleased();
      } catch (error) {
        firstError ??= error;
      }
    } finally {
      this.#activeTeardowns--;
      try {
        this.#finishDeferredLoaderClear();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
    return true;
  }

  #pressureIndex(): PressureIndex {
    const records = this.#textures.pressureSnapshot();
    const byOwner = new Map<unknown, ModelTexturePressureRecord>();
    for (const record of records) {
      for (const owner of record.ownerTokens) byOwner.set(owner, record);
    }
    return { records, byOwner };
  }

  #pressureFor(
    entry: CachedWorldMaterial,
    pressure: PressureIndex,
  ): ModelTexturePressureRecord | undefined {
    if (!entry.lease) return undefined;
    const record = pressure.byOwner.get(entry.ownerToken);
    return record?.url === entry.lease.url && record.requestId === entry.lease.requestId
      ? record
      : undefined;
  }

  #isPinned(entry: CachedWorldMaterial, pressure: PressureIndex): boolean {
    return this.#pins.has(entry.publicEntry)
      || this.#pressureFor(entry, pressure)?.status === "pending";
  }

  #finishDeferredLoaderClear(): void {
    if (!this.#loaderClearPending || this.#activeBuilds > 0 || this.#activeTeardowns > 0) return;
    this.#loaderClearPending = false;
    const attempts = this.#textures.residencyStats.count + 1;
    let firstError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let cleared = false;
      try {
        this.#textures.clear();
        cleared = true;
      } catch (error) {
        firstError ??= error;
      }
      if (!cleared) continue;
      if (firstError !== undefined) throw firstError;
      return;
    }
    if (firstError !== undefined) throw firstError;
  }
}

function isTexture(value: unknown): value is THREE.Texture {
  return typeof value === "object" && value !== null
    && (value as { readonly isTexture?: unknown }).isTexture === true;
}

function isMaterial(value: unknown): value is THREE.Material {
  return typeof value === "object" && value !== null
    && (value as { readonly isMaterial?: unknown }).isMaterial === true;
}
