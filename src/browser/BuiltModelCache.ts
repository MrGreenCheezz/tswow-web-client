import * as THREE from "three";
import type { BuiltModel } from "./ModelBuild.js";

export interface BuiltModelCacheLimits {
  readonly count: number;
  readonly knownBufferBytes: number;
}

/** Exact exposed direct geometry-buffer bytes. This is not object overhead or measured driver VRAM. */
export interface BuiltModelCacheStats {
  readonly count: number;
  readonly knownBufferBytes: number;
  readonly overflowCount: number;
  readonly overflowKnownBufferBytes: number;
}

export interface EvictedBuiltModel<T extends Pick<BuiltModel, "geometry"> = BuiltModel> {
  readonly key: string;
  readonly built: T;
}

type GeometryAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

interface GeometryBufferResource {
  readonly identity: object;
  readonly bytes: number;
}

function geometryAttributeBufferIdentity(
  attribute: GeometryAttribute,
): THREE.BufferAttribute | THREE.InterleavedBuffer {
  return "isInterleavedBufferAttribute" in attribute
    && attribute.isInterleavedBufferAttribute === true
    ? (attribute as THREE.InterleavedBufferAttribute).data
    : attribute as THREE.BufferAttribute;
}

/**
 * Enumerates Three.js direct GPU-buffer identities exposed by a geometry. Ordinary attributes are
 * separate uploads even when their CPU views share an ArrayBuffer; interleaved attributes share
 * their InterleavedBuffer upload. Morph attributes are deliberately absent: Three r185 packs them
 * into a renderer-owned DataArrayTexture rather than WebGLAttributes buffers.
 */
function geometryBufferResources(geometry: THREE.BufferGeometry): readonly GeometryBufferResource[] {
  const resources = new Map<object, number>();
  const visit = (attribute: GeometryAttribute | null | undefined): void => {
    if (!attribute) return;
    const identity = geometryAttributeBufferIdentity(attribute);
    const array = identity.array;
    if (ArrayBuffer.isView(array)) resources.set(identity, array.byteLength);
  };
  visit(geometry.index);
  for (const attribute of Object.values(geometry.attributes)) visit(attribute);
  return [...resources].map(([identity, bytes]) => ({ identity, bytes }));
}

/** Exact exposed Three.js geometry-buffer bytes, not object overhead or measured driver VRAM. */
export function knownGeometryBufferBytes(geometry: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const resource of geometryBufferResources(geometry)) bytes += resource.bytes;
  return bytes;
}

/** A small exact-byte, true-LRU cache. Eviction is explicitly invoked at a safe borrower point. */
export class BuiltModelCache<T extends Pick<BuiltModel, "geometry"> = BuiltModel> {
  readonly #limits: BuiltModelCacheLimits;
  readonly #entries = new Map<string, T>();
  readonly #entryResources = new Map<string, readonly GeometryBufferResource[]>();
  readonly #entryExternalKeys = new Map<string, readonly string[]>();
  readonly #resources = new Map<object, { readonly bytes: number; references: number }>();
  #knownBufferBytes = 0;

  constructor(limits: BuiltModelCacheLimits) {
    this.#limits = Object.freeze({ ...limits });
  }

  get size(): number { return this.#entries.size; }

  get stats(): Readonly<BuiltModelCacheStats> {
    return Object.freeze({
      count: this.#entries.size,
      knownBufferBytes: this.#knownBufferBytes,
      overflowCount: Math.max(0, this.#entries.size - this.#limits.count),
      overflowKnownBufferBytes: Math.max(0, this.#knownBufferBytes - this.#limits.knownBufferBytes),
    });
  }

  get(key: string): T | undefined {
    const built = this.#entries.get(key);
    if (!built) return undefined;
    // Map insertion order is the LRU list: a hit becomes newest.
    this.#entries.delete(key);
    this.#entries.set(key, built);
    return built;
  }

  set(key: string, built: T, externalKeys: Iterable<string> = []): this {
    this.delete(key);
    const resources = geometryBufferResources(built.geometry);
    this.#entries.set(key, built);
    this.#entryResources.set(key, resources);
    this.#entryExternalKeys.set(key, Object.freeze([...new Set(externalKeys)]));
    for (const resource of resources) {
      const retained = this.#resources.get(resource.identity);
      if (retained) {
        retained.references++;
      } else {
        this.#resources.set(resource.identity, { bytes: resource.bytes, references: 1 });
        this.#knownBufferBytes += resource.bytes;
      }
    }
    return this;
  }

  delete(key: string): boolean {
    if (!this.#entries.delete(key)) return false;
    for (const resource of this.#entryResources.get(key) ?? []) {
      const retained = this.#resources.get(resource.identity);
      if (!retained) continue;
      retained.references--;
      if (retained.references > 0) continue;
      this.#resources.delete(resource.identity);
      this.#knownBufferBytes -= retained.bytes;
    }
    this.#entryResources.delete(key);
    this.#entryExternalKeys.delete(key);
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#entryResources.clear();
    this.#entryExternalKeys.clear();
    this.#resources.clear();
    this.#knownBufferBytes = 0;
  }

  values(): MapIterator<T> { return this.#entries.values(); }
  entries(): MapIterator<[string, T]> { return this.#entries.entries(); }
  [Symbol.iterator](): MapIterator<[string, T]> { return this.#entries[Symbol.iterator](); }

  /** Exact external-owner keys required by every entry the cache still retains. */
  retainedExternalKeys(): ReadonlySet<string> {
    const retained = new Set<string>();
    for (const keys of this.#entryExternalKeys.values()) {
      for (const key of keys) retained.add(key);
    }
    return retained;
  }

  /** Removes oldest unpinned entries until both soft limits are met or only pins remain. */
  evictUnpinned(pinned: ReadonlySet<T>): readonly EvictedBuiltModel<T>[] {
    const evicted: EvictedBuiltModel<T>[] = [];
    for (const [key, built] of this.#entries) {
      if (this.#withinLimits()) break;
      if (pinned.has(built)) continue;
      this.delete(key);
      evicted.push({ key, built });
    }
    return evicted;
  }

  #withinLimits(): boolean {
    return this.#entries.size <= this.#limits.count
      && this.#knownBufferBytes <= this.#limits.knownBufferBytes;
  }
}

/**
 * Disposes only resources declared owned by evicted entries. Identities still owned by retained
 * entries are preserved, and identities shared by several evictions are disposed once.
 */
export function disposeEvictedBuiltModels(
  evicted: readonly EvictedBuiltModel<BuiltModel>[],
  retained: Iterable<BuiltModel>,
): void {
  const retainedGeometries = new Set<THREE.BufferGeometry>();
  const retainedMaterials = new Set<THREE.Material>();
  const retainedTextures = new Set<THREE.Texture>();
  const retainedGeometryBuffers = new Set<object>();
  for (const built of retained) {
    retainedGeometries.add(built.geometry);
    for (const resource of geometryBufferResources(built.geometry)) {
      retainedGeometryBuffers.add(resource.identity);
    }
    for (const material of built.materials) retainedMaterials.add(material);
    for (const texture of built.ownedTextures) retainedTextures.add(texture);
  }

  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();
  for (const { built } of evicted) {
    if (!retainedGeometries.has(built.geometry) && !disposedGeometries.has(built.geometry)) {
      disposedGeometries.add(built.geometry);
      // Three's geometry dispose handler removes WebGLAttributes by BufferAttribute (or
      // InterleavedBuffer) identity without ref-counting across distinct geometry wrappers. Strip
      // exact retained identities from this dead wrapper first, so its unique buffers are released
      // without deleting a live wrapper's shared GL buffer.
      const index = built.geometry.index;
      if (index && retainedGeometryBuffers.has(geometryAttributeBufferIdentity(index))) {
        built.geometry.setIndex(null);
      }
      for (const [name, attribute] of Object.entries(built.geometry.attributes)) {
        const identity = geometryAttributeBufferIdentity(attribute);
        if (retainedGeometryBuffers.has(identity)) built.geometry.deleteAttribute(name);
      }
      built.geometry.dispose();
    }
    for (const material of built.materials) {
      if (retainedMaterials.has(material) || disposedMaterials.has(material)) continue;
      disposedMaterials.add(material);
      material.dispose();
    }
    for (const texture of built.ownedTextures) {
      if (retainedTextures.has(texture) || disposedTextures.has(texture)) continue;
      disposedTextures.add(texture);
      texture.dispose();
    }
  }
}
