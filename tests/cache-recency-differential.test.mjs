import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { BuiltModelCache } from "../dist/code/browser/BuiltModelCache.js";
import { setRecencyStampLimitForTests } from "../dist/code/browser/RecencyStamps.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import { WorldMaterialCache } from "../dist/code/browser/WorldMaterialCache.js";

// P1-10b (MEM-2): the texture loader, the world-material cache and the built-model cache stamp a
// touch in place instead of re-inserting the entry into their `Map`. What they evict, and the
// order the texture pressure records come in, must stay exactly what the re-insertion LRU gave:
// reference LRUs below (plain `Map`s, a hit moves the key to the back) replay the same random
// operations. Each run is repeated with a 5-touch stamp limit, so the caches renumber mid-run.

/** Texture side length per URL; a `z…` URL is an image-less texture of unknown byte size. */
const side = (url) => 1 + (url.charCodeAt(1) % 5);
const textureBytes = (url) => (url.startsWith("z") ? undefined : 4 * side(url) * side(url));

function withTextureLoader(run) {
  const original = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (url, onLoad) {
    let texture;
    if (url.startsWith("z")) texture = new THREE.Texture();
    else {
      texture = new THREE.DataTexture(new Uint8Array(4 * side(url) * side(url)), side(url), side(url));
      texture.generateMipmaps = false;
    }
    onLoad?.(texture);
    return texture;
  };
  try {
    return run();
  } finally {
    THREE.TextureLoader.prototype.load = original;
  }
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Map order oldest first; a touch moves the key to the back. */
const touch = (map, key) => {
  if (!map.has(key)) return;
  const value = map.get(key);
  map.delete(key);
  map.set(key, value);
};

const withStampLimits = (run) => {
  for (const limit of [undefined, 5]) {
    setRecencyStampLimitForTests(limit);
    try {
      run(limit === undefined ? "default stamps" : "5-touch stamps");
    } finally {
      setRecencyStampLimitForTests();
    }
  }
};

/** The re-insertion texture LRU: url -> { leases: owner[] in acquire order, bytes }. */
class ReferenceTextures {
  constructor(limits) { this.limits = limits; this.records = new Map(); }
  get bytes() {
    let total = 0;
    for (const record of this.records.values()) total += record.bytes ?? 0;
    return total;
  }
  within() { return this.records.size <= this.limits.count && this.bytes <= this.limits.knownLogicalTextureBytes; }
  acquire(url, owner) {
    if (this.records.has(url)) touch(this.records, url);
    else this.records.set(url, { leases: [], bytes: textureBytes(url) });
    this.records.get(url).leases.push(owner);
  }
  release(url, owner) {
    const record = this.records.get(url);
    if (!record) return;
    const at = record.leases.indexOf(owner);
    if (at >= 0) record.leases.splice(at, 1);
  }
  evictUnleased() {
    const evicted = [];
    for (const [url, record] of [...this.records]) {
      if (this.within()) break;
      if (record.leases.length > 0) continue;
      const countOverflow = this.records.size > this.limits.count;
      const byteOverflow = this.bytes > this.limits.knownLogicalTextureBytes;
      if (!countOverflow && byteOverflow && (record.bytes ?? 0) === 0) continue;
      this.records.delete(url);
      evicted.push(url);
    }
    return evicted;
  }
}

test("P1-10b: texture eviction and pressure order follow the re-insertion LRU, byte limits included", () => {
  withTextureLoader(() => withStampLimits((stamps) => {
    for (const seed of [11, 12, 13, 14]) {
      const next = random(seed);
      const limits = {
        count: 3 + Math.floor(next() * 4),
        // Every other seed overflows on bytes first, so unknown-size records are skipped there.
        knownLogicalTextureBytes: seed % 2 ? 1 << 30 : 40 + Math.floor(next() * 120),
      };
      const loader = new ModelTextureLoader({ cache: true, limits });
      const urls = Array.from({ length: limits.count + 5 }, (_, index) => `${index % 3 ? "t" : "z"}${index}.blp`);
      const reference = new ReferenceTextures(limits);
      const leases = []; // { url, owner, lease }
      let skippedUnknown = 0;
      for (let step = 0; step < 300; step++) {
        const roll = next();
        const where = `${stamps} seed ${seed} step ${step}`;
        if (roll < 0.4) {
          const url = urls[Math.floor(next() * urls.length)];
          const owner = { step };
          leases.push({ url, owner, lease: loader.acquire(url, owner) });
          reference.acquire(url, owner);
        } else if (roll < 0.6 && leases.length) {
          const { url, owner, lease } = leases[Math.floor(next() * leases.length)];
          const live = reference.records.get(url)?.leases.includes(owner) ?? false;
          assert.equal(loader.touch(lease), live, `${where}: touch ${url}`);
          if (live) touch(reference.records, url);
        } else if (roll < 0.85 && leases.length) {
          const [{ url, owner, lease }] = leases.splice(Math.floor(next() * leases.length), 1);
          lease.release();
          reference.release(url, owner);
        } else {
          const byteOnly = reference.records.size <= limits.count && reference.bytes > limits.knownLogicalTextureBytes;
          if (byteOnly) skippedUnknown++;
          assert.deepEqual(loader.evictUnleased(), reference.evictUnleased(), `${where}: evicted`);
        }
        assert.deepEqual(loader.pressureSnapshot().map(({ url }) => url), [...reference.records.keys()], `${where}: pressure order`);
        assert.equal(loader.residencyStats.knownLogicalTextureBytes, reference.bytes, `${where}: bytes`);
      }
      if (seed % 2 === 0) assert.ok(skippedUnknown > 0, `${stamps} seed ${seed}: a byte-only overflow happened`);
    }
  }));
});

test("P1-10b: a record a dispose listener touches mid-eviction goes behind the others, as before", () => {
  withTextureLoader(() => withStampLimits(() => {
    const loader = new ModelTextureLoader({ cache: true, limits: { count: 2, knownLogicalTextureBytes: 1 << 30 } });
    const a = loader.load("tA.blp");
    for (const url of ["tB.blp", "tC.blp", "tD.blp"]) loader.load(url);
    a.addEventListener("dispose", () => loader.load("tB.blp"));
    // The re-insertion LRU walked the live map: B, touched while A was disposed, moved to the back.
    assert.deepEqual(loader.evictUnleased(), ["tA.blp", "tC.blp"]);
    assert.deepEqual(loader.pressureSnapshot().map(({ url }) => url), ["tD.blp", "tB.blp"]);

    // A record a listener creates mid-pass is reached after the older ones, like an appended key.
    const fresh = new ModelTextureLoader({ cache: true, limits: { count: 1, knownLogicalTextureBytes: 1 << 30 } });
    const first = fresh.load("tE.blp");
    fresh.load("tF.blp");
    fresh.load("tG.blp");
    first.addEventListener("dispose", () => fresh.load("tH.blp"));
    assert.deepEqual(fresh.evictUnleased(), ["tE.blp", "tF.blp", "tG.blp"]);
    assert.deepEqual(fresh.pressureSnapshot().map(({ url }) => url), ["tH.blp"]);

    // Every remaining record touched mid-pass: the walk goes on over them in their new order.
    const touched = new ModelTextureLoader({ cache: true, limits: { count: 1, knownLogicalTextureBytes: 1 << 30 } });
    const oldest = touched.load("tI.blp");
    touched.load("tJ.blp");
    touched.load("tK.blp");
    oldest.addEventListener("dispose", () => {
      touched.load("tJ.blp");
      touched.load("tK.blp");
    });
    assert.deepEqual(touched.evictUnleased(), ["tI.blp", "tJ.blp"]);
    assert.deepEqual(touched.pressureSnapshot().map(({ url }) => url), ["tK.blp"]);
  }));
});

test("P1-10b: material eviction, stale pruning and texture-owner pressure follow the re-insertion LRU", () => {
  withTextureLoader(() => withStampLimits((stamps) => {
    for (const seed of [21, 22, 23, 24]) {
      const next = random(seed);
      const limit = 2 + Math.floor(next() * 5);
      const textureLimits = { count: 2 + Math.floor(next() * 3), knownLogicalTextureBytes: seed % 2 ? 1 << 30 : 30 + Math.floor(next() * 60) };
      const loader = new ModelTextureLoader({ cache: true, limits: textureLimits });
      const cache = new WorldMaterialCache(loader, { limits: { count: limit } });
      const keys = Array.from({ length: limit + 5 }, (_, index) => `m${index}`);
      const urls = ["tu0.blp", "tu1.blp", "zu2.blp", "tu3.blp", "tu4.blp"]; // shared between materials
      const textures = new ReferenceTextures(textureLimits);
      const materials = new Map(); // key -> { entry, url, owner, live }
      const pins = new Set(); // committed material keys
      let ownerEvictions = 0;
      let staleEvictions = 0;

      const leaseLive = (record) => textures.records.get(record.url)?.leases.includes(record.owner) ?? false;
      const remove = (key, evicted) => {
        const record = materials.get(key);
        materials.delete(key);
        pins.delete(key);
        textures.release(record.url, record.owner);
        textures.evictUnleased();
        evicted?.push(key);
      };
      const isPinned = (key) => pins.has(key);
      const create = (key, url) => {
        const owner = {};
        textures.acquire(url, owner);
        materials.set(key, { url, owner });
      };
      const hit = (key) => {
        const record = materials.get(key);
        if (!record) return false;
        if (!leaseLive(record)) {
          remove(key);
          return false;
        }
        touch(textures.records, record.url);
        touch(materials, key);
        return true;
      };

      for (let step = 0; step < 250; step++) {
        const roll = next();
        const where = `${stamps} seed ${seed} step ${step}`;
        const key = keys[Math.floor(next() * keys.length)];
        if (roll < 0.4) {
          const url = urls[Math.floor(next() * urls.length)];
          let urlUsed = url;
          const wasHit = hit(key);
          if (wasHit) urlUsed = materials.get(key).url;
          const entry = cache.getOrCreate({
            key, kind: "mesh", textureUrl: urlUsed,
            createMaterial(texture) { return new THREE.MeshBasicMaterial({ map: texture ?? null }); },
          });
          if (!wasHit) create(key, urlUsed);
          materials.get(key).entry = entry;
        } else if (roll < 0.55) {
          const entry = cache.get(key);
          assert.equal(entry !== undefined, hit(key), `${where}: get ${key}`);
        } else if (roll < 0.6) {
          loader.clear();
          textures.records.clear();
        } else {
          const wanted = [...materials.keys()].filter(() => next() < 0.35).sort(() => next() - 0.5);
          const pinEntries = new Set(wanted.map((pinned) => materials.get(pinned).entry));
          const expected = [];
          pins.clear();
          for (const pinned of wanted) {
            const record = materials.get(pinned);
            if (!leaseLive(record)) continue;
            touch(textures.records, record.url);
            touch(materials, pinned);
            pins.add(pinned);
          }
          for (const [stale, record] of [...materials]) {
            if (textures.records.get(record.url)?.leases.includes(record.owner)) continue;
            staleEvictions++;
            remove(stale, expected);
          }
          while (materials.size > limit) {
            const victim = [...materials.keys()].find((candidate) => !isPinned(candidate));
            if (victim === undefined) break;
            remove(victim, expected);
          }
          textures.evictUnleased();
          for (;;) {
            const countOverflow = textures.records.size > textureLimits.count;
            const byteOverflow = textures.bytes > textureLimits.knownLogicalTextureBytes;
            if (!countOverflow && !byteOverflow) break;
            let owners;
            for (const [, record] of textures.records) {
              if (!countOverflow && byteOverflow && (record.bytes ?? 0) === 0) continue;
              if (record.leases.length === 0) continue;
              const candidates = [];
              let reducible = true;
              for (const owner of record.leases) {
                const ownerKey = [...materials].find(([, value]) => value.owner === owner)?.[0];
                if (ownerKey === undefined || isPinned(ownerKey)) { reducible = false; break; }
                if (!candidates.includes(ownerKey)) candidates.push(ownerKey);
              }
              if (reducible && candidates.length > 0) { owners = candidates; break; }
            }
            if (!owners) break;
            ownerEvictions += owners.length;
            for (const owner of owners) remove(owner, expected);
            textures.evictUnleased();
          }
          assert.deepEqual(cache.commitPins(pinEntries), expected, `${where}: commitPins evictions`);
        }
        assert.deepEqual(loader.pressureSnapshot().map(({ url }) => url), [...textures.records.keys()], `${where}: texture order`);
        assert.equal(cache.residencyStats.materials.count, materials.size, `${where}: material count`);
      }
      if (seed === 22) assert.ok(ownerEvictions > 0 && staleEvictions > 0, `${stamps}: owner and stale passes ran`);
      cache.dispose();
    }
  }));
});

/** The re-insertion built-model LRU, with direct-buffer bytes ref-counted by attribute identity. */
class ReferenceBuilt {
  constructor(limits) { this.limits = limits; this.entries = new Map(); }
  bytes() {
    const seen = new Set();
    let total = 0;
    for (const built of this.entries.values()) {
      for (const attribute of Object.values(built.geometry.attributes)) {
        if (seen.has(attribute)) continue;
        seen.add(attribute);
        total += attribute.array.byteLength;
      }
    }
    return total;
  }
  within() { return this.entries.size <= this.limits.count && this.bytes() <= this.limits.knownBufferBytes; }
  evict(pinned) {
    const evicted = [];
    for (const [key, built] of [...this.entries]) {
      if (this.within()) break;
      if (pinned.has(built)) continue;
      this.entries.delete(key);
      evicted.push(key);
    }
    return evicted;
  }
}

test("P1-10b: built-model eviction follows the re-insertion LRU; peek does not touch", () => {
  withStampLimits((stamps) => {
    for (const seed of [31, 32, 33, 34]) {
      const next = random(seed);
      const limits = { count: 2 + Math.floor(next() * 6), knownBufferBytes: seed % 2 ? 1 << 30 : 64 + Math.floor(next() * 600) };
      const cache = new BuiltModelCache(limits);
      const reference = new ReferenceBuilt(limits);
      const keys = Array.from({ length: limits.count + 6 }, (_, index) => `k${index}`);
      const shared = [];
      for (let step = 0; step < 400; step++) {
        const roll = next();
        const key = keys[Math.floor(next() * keys.length)];
        const where = `${stamps} seed ${seed} step ${step}`;
        if (roll < 0.35) {
          const geometry = new THREE.BufferGeometry();
          const attribute = next() < 0.3 && shared.length ? shared[Math.floor(next() * shared.length)]
            : new THREE.BufferAttribute(new Float32Array(1 + Math.floor(next() * 64)), 1);
          shared.push(attribute);
          geometry.setAttribute("position", attribute);
          const built = { geometry };
          cache.set(key, built);
          reference.entries.delete(key);
          reference.entries.set(key, built);
        } else if (roll < 0.6) {
          assert.equal(cache.get(key), reference.entries.get(key), where);
          touch(reference.entries, key);
        } else if (roll < 0.66) {
          assert.equal(cache.peek(key), reference.entries.get(key), where);
        } else if (roll < 0.72) {
          assert.equal(cache.delete(key), reference.entries.delete(key), where);
        } else if (roll < 0.74) {
          cache.clear();
          reference.entries.clear();
        } else {
          const pinned = new Set([...reference.entries.values()].filter(() => next() < 0.3));
          assert.deepEqual(cache.evictUnpinned(pinned).map(({ key: evicted }) => evicted), reference.evict(pinned), `${where}: evicted`);
        }
        assert.equal(cache.stats.knownBufferBytes, reference.bytes(), `${where}: bytes`);
        assert.deepEqual(new Set(cache.values()), new Set(reference.entries.values()), `${where}: entries`);
      }
    }
  });
});

test("P1-10b: the caches stamp touches instead of re-inserting", async () => {
  for (const [path, head] of [["TextureLoad.ts", "#touch(entry: TextureEntry)"],
    ["WorldMaterialCache.ts", "#touch(entry: CachedWorldMaterial)"], ["BuiltModelCache.ts", "get(key: string)"]]) {
    const source = await readFile(new URL(`../src/browser/${path}`, import.meta.url), "utf8");
    const start = source.indexOf(`  ${head}`);
    assert.ok(start >= 0, `${path}: ${head}`);
    assert.doesNotMatch(source.slice(start, source.indexOf("\n  }\n", start)), /\.delete\(/, `${path}: ${head} re-inserts nothing`);
  }
});
