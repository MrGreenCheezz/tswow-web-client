import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { setRecencyStampLimitForTests } from "../dist/code/browser/RecencyStamps.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import { WorldMaterialCache } from "../dist/code/browser/WorldMaterialCache.js";

// P1-11 (ENV-2, first half): `commitPins` returns at once when it is handed the committed pins over
// a cache and loader that have not moved since a pass that changed nothing, and the full pass asks
// the loader point questions (`owns`, `leaseStatus`, numeric overflow) instead of building pressure
// snapshots. `legacyScan: true` keeps the old pass whole; the differential below holds them equal.

/** Texture side per URL; `z…` is an image-less texture of unknown size, `i…` settles inline. */
const side = (url) => 1 + (url.charCodeAt(1) % 4);

/** Where the mocked `TextureLoader.load` files its requests; switched per loader by the tests. */
let sink = [];

function withTextureLoader(run) {
  const original = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = function (url, onLoad, _progress, onError) {
    let texture;
    if (url.startsWith("z")) texture = new THREE.Texture();
    else {
      texture = new THREE.DataTexture(new Uint8Array(4 * side(url) * side(url)), side(url), side(url));
      texture.generateMipmaps = false;
    }
    const request = { url, texture, onLoad, onError, settled: false };
    if (url.startsWith("i")) {
      request.settled = true;
      onLoad?.(texture);
    }
    sink.push(request);
    return texture;
  };
  try {
    return run();
  } finally {
    THREE.TextureLoader.prototype.load = original;
    sink = [];
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

const spec = (key, textureUrl) => ({
  key,
  kind: "mesh",
  textureUrl,
  createMaterial(texture) { return new THREE.MeshBasicMaterial({ map: texture ?? null }); },
});

/** Counts the loader calls that only the full pass (or the old pass) makes. */
function spyOn(loader) {
  const calls = { pressureSnapshot: 0, owns: 0, leaseStatus: 0, residencyStats: 0 };
  for (const name of ["pressureSnapshot", "owns", "leaseStatus"]) {
    const original = loader[name].bind(loader);
    loader[name] = (...args) => {
      calls[name]++;
      return original(...args);
    };
  }
  const stats = Object.getOwnPropertyDescriptor(ModelTextureLoader.prototype, "residencyStats").get;
  Object.defineProperty(loader, "residencyStats", { get() { calls.residencyStats++; return stats.call(loader); } });
  return calls;
}

/** A cache over honest overflow: more pinned materials than its limit, textures pinned too. */
function overflowing() {
  sink = [];
  const loader = new ModelTextureLoader({ cache: true, limits: { count: 1, knownLogicalTextureBytes: 1 << 20 } });
  const cache = new WorldMaterialCache(loader, { limits: { count: 1 } });
  const a = cache.getOrCreate(spec("a", "ia.blp"));
  const b = cache.getOrCreate(spec("b", "ib.blp"));
  const pins = new Set([a, b]);
  const calls = spyOn(loader);
  assert.deepEqual(cache.commitPins(pins), []);
  return { loader, cache, a, b, pins, calls };
}

const fresh = (calls) => {
  for (const name of Object.keys(calls)) calls[name] = 0;
};

test("P1-11: the same pins over an unchanged cache return at once, with no pressure snapshot", () => {
  withTextureLoader(() => {
    const { cache, pins, calls, a, b } = overflowing();
    // The first commit ran in full (there was no settled pass before it) and changed nothing.
    assert.ok(calls.owns > 0 && calls.leaseStatus > 0, "the first commit ran the full pass");
    assert.equal(calls.pressureSnapshot, 1, "one snapshot, for the honest texture overflow round only");
    assert.equal(calls.residencyStats, 0, "overflow is read through the numeric getters");
    fresh(calls);
    const second = cache.commitPins(new Set([b, a]));
    assert.deepEqual(second, []);
    assert.ok(Object.isFrozen(second));
    assert.deepEqual(calls, { pressureSnapshot: 0, owns: 0, leaseStatus: 0, residencyStats: 0 },
      "a settled repeat asks the loader nothing but the touches");
    assert.deepEqual(cache.residencyStats.materials, { count: 2, pinnedCount: 2, pendingTextureCount: 0, overflowCount: 1 });
    cache.dispose();
  });
});

test("P1-11: a full pass builds no pressure snapshot once no texture overflow is left", () => {
  withTextureLoader(() => {
    const { cache, b, calls } = overflowing();
    fresh(calls);
    // Unpinning `a` makes it the count victim; the texture count then converges in the loader.
    assert.deepEqual(cache.commitPins(new Set([b])), ["a"]);
    assert.equal(calls.pressureSnapshot, 0, "no texture overflow is left after the count pass");
    cache.dispose();
  });
});

test("P1-11: the unchanged-pins walk touches the pins in the order the full pass does", () => {
  withTextureLoader(() => {
    sink = [];
    const loader = new ModelTextureLoader({ cache: true, limits: { count: 8, knownLogicalTextureBytes: 1 << 20 } });
    const cache = new WorldMaterialCache(loader, { limits: { count: 3 } });
    const a = cache.getOrCreate(spec("a", "ia.blp"));
    const b = cache.getOrCreate(spec("b", "ib.blp"));
    const c = cache.getOrCreate(spec("c", "ic.blp"));
    const pins = new Set([c, a]);
    cache.commitPins(pins);
    cache.commitPins(pins);
    cache.get("b");
    cache.get("c");
    // Settled: this walk alone touches a and c, a last; then d overflows and b is the oldest.
    cache.commitPins(new Set([c, a]));
    assert.deepEqual(loader.pressureSnapshot().map(({ url }) => url), ["ib.blp", "ic.blp", "ia.blp"]);
    cache.getOrCreate(spec("d", "id.blp"));
    assert.deepEqual(cache.commitPins(new Set()), ["b"]);
    cache.dispose();
  });
});

test("P1-11: any structural change between two identical commits sends the second down the full pass", () => {
  const actions = {
    "getOrCreate": ({ cache }) => { cache.getOrCreate(spec("x", "ix.blp")); },
    "foreign lease release": ({ foreign }) => { foreign.release(); },
    "foreign acquire": ({ loader }) => { loader.acquire("iq.blp", "foreign-2"); },
    "settling a pending texture": () => {
      const request = sink.find((candidate) => !candidate.settled);
      request.settled = true;
      request.onLoad(request.texture);
    },
    "failing a pending texture": () => {
      const request = sink.find((candidate) => !candidate.settled);
      request.settled = true;
      request.onError(new Error("missing"));
    },
    "loader.clear()": ({ loader }) => { loader.clear(); },
    "release then loader eviction": ({ loader, foreign }) => {
      foreign.release();
      assert.deepEqual(loader.evictUnleased(), ["if.blp"]);
    },
    "a different pin set": ({ pins, b }) => { pins.delete(b); },
  };
  for (const [name, act] of Object.entries(actions)) {
    withTextureLoader(() => {
      sink = [];
      const loader = new ModelTextureLoader({ cache: true, limits: { count: 1, knownLogicalTextureBytes: 1 << 20 } });
      const cache = new WorldMaterialCache(loader, { limits: { count: 1 } });
      const a = cache.getOrCreate(spec("a", "ia.blp"));
      const b = cache.getOrCreate(spec("b", "pb.blp"));
      const foreign = loader.acquire("if.blp", "foreign");
      const pins = new Set([a, b]);
      cache.commitPins(pins);
      cache.commitPins(pins);
      const calls = spyOn(loader);
      cache.commitPins(pins);
      assert.equal(calls.owns, 0, `${name}: settled before the action`);
      act({ loader, cache, foreign, pins, a, b });
      fresh(calls);
      cache.commitPins(pins);
      assert.ok(calls.owns > 0, `${name}: the next commit runs the full pass`);
      cache.dispose();
    });
  }
});

test("P1-11: a pass that evicted is not settled; the next identical commit runs in full once", () => {
  withTextureLoader(() => {
    const { cache, b, calls } = overflowing();
    const pins = new Set([b]);
    assert.deepEqual(cache.commitPins(pins), ["a"]);
    fresh(calls);
    assert.deepEqual(cache.commitPins(pins), []);
    assert.ok(calls.owns > 0, "the pass after an eviction is a full one");
    fresh(calls);
    assert.deepEqual(cache.commitPins(pins), []);
    assert.equal(calls.owns, 0, "and the one after that settles");
    cache.dispose();
  });
});

/** Runs one operation on both sides and returns both answers. */
function both(sides, run) {
  return sides.map((side) => {
    sink = side.requests;
    try {
      return { value: run(side) };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  });
}

test("P1-11: 3000 random operations: the early-exit pass evicts, reports and orders as the legacy scan", () => {
  withTextureLoader(() => {
    for (const stampLimit of [undefined, 7]) {
      setRecencyStampLimitForTests(stampLimit);
      try {
        for (const seed of [101, 102, 103]) {
          const next = random(seed);
          const materialLimit = 2 + Math.floor(next() * 4);
          const textureLimits = { count: 2 + Math.floor(next() * 3), knownLogicalTextureBytes: seed % 2 ? 1 << 30 : 24 + Math.floor(next() * 80) };
          const sides = [true, false].map((legacyScan) => {
            const loader = new ModelTextureLoader({ cache: true, limits: textureLimits });
            return {
              legacyScan,
              loader,
              cache: new WorldMaterialCache(loader, { limits: { count: materialLimit }, legacyScan }),
              requests: [],
              entries: new Map(), // key -> latest public entry (kept after eviction: stale pins)
              foreign: [],
            };
          });
          const calls = spyOn(sides[1].loader);
          const keys = Array.from({ length: materialLimit + 5 }, (_, index) => `m${index}`);
          const urls = ["pa.blp", "ib.blp", "zc.blp", "pd.blp", "ie.blp", "pf.blp", "zg.blp", undefined];
          let lastPins = [];
          let fastCommits = 0;
          let fullCommits = 0;
          let evictions = 0;
          for (let step = 0; step < 1000; step++) {
            const where = `stamps ${stampLimit ?? "default"} seed ${seed} step ${step}`;
            const roll = next();
            const key = keys[Math.floor(next() * keys.length)];
            const url = urls[Math.floor(next() * urls.length)];
            let answers;
            if (roll < 0.22) {
              answers = both(sides, (side) => {
                const entry = side.cache.getOrCreate(spec(key, url));
                side.entries.set(key, entry);
                return entry.key;
              });
            } else if (roll < 0.3) {
              answers = both(sides, (side) => side.cache.get(key)?.key);
            } else if (roll < 0.37) {
              // Settle (or fail) the oldest unsettled request of the same index on both sides.
              const fail = next() < 0.3;
              const index = sides[0].requests.findIndex((request) => !request.settled);
              answers = both(sides, (side) => {
                const request = side.requests[index];
                if (!request) return "none";
                request.settled = true;
                if (fail) request.onError(new Error("missing"));
                else request.onLoad(request.texture);
                return request.url;
              });
            } else if (roll < 0.41) {
              const owner = `foreign-${step}`;
              answers = both(sides, (side) => { side.foreign.push(side.loader.acquire(url, owner)); return owner; });
            } else if (roll < 0.46) {
              const index = Math.floor(next() * 4);
              answers = both(sides, (side) => {
                const lease = side.foreign.splice(index, 1)[0];
                lease?.release();
                return lease?.ownerToken;
              });
            } else if (roll < 0.48) {
              answers = both(sides, (side) => side.loader.evictUnleased());
            } else if (roll < 0.495) {
              answers = both(sides, (side) => { side.loader.clear(); return "cleared"; });
            } else {
              // Mostly the same pins again, as frames do; otherwise a fresh random footprint.
              if (next() >= 0.55 || lastPins.length === 0) {
                lastPins = [...sides[0].entries.keys()].filter(() => next() < 0.45).sort(() => next() - 0.5);
              }
              // A run of one to three frames with the same footprint; each answer is compared.
              const frames = 1 + Math.floor(next() * 3);
              const runs = [[], []];
              for (let frame = 0; frame < frames; frame++) {
                const before = calls.owns + calls.leaseStatus + calls.pressureSnapshot;
                const frameAnswers = both(sides, (side) => side.cache.commitPins(new Set(lastPins.map((pinned) => side.entries.get(pinned)))));
                if (calls.owns + calls.leaseStatus + calls.pressureSnapshot === before) fastCommits++;
                else fullCommits++;
                evictions += frameAnswers[1].value?.length ?? 0;
                runs[0].push(frameAnswers[0]);
                runs[1].push(frameAnswers[1]);
              }
              answers = runs;
            }
            assert.deepEqual(answers[1], answers[0], `${where}: answer (roll ${roll.toFixed(3)})`);
            assert.equal(sides[1].requests.length, sides[0].requests.length, `${where}: requests`);
            for (const property of ["residencyStats", "textureReadiness"]) {
              assert.deepEqual(sides[1].cache[property], sides[0].cache[property], `${where}: ${property}`);
            }
            assert.deepEqual(
              sides[1].loader.pressureSnapshot().map(({ url: record, status, ownerTokens }) => [record, status, ownerTokens.length]),
              sides[0].loader.pressureSnapshot().map(({ url: record, status, ownerTokens }) => [record, status, ownerTokens.length]),
              `${where}: texture order`,
            );
          }
          assert.ok(fastCommits > 80, `seed ${seed}: the early exit ran (${fastCommits})`);
          assert.ok(fullCommits > 50, `seed ${seed}: the full pass ran (${fullCommits})`);
          assert.ok(evictions > 20, `seed ${seed}: commits evicted (${evictions})`);
          for (const side of sides) side.cache.dispose();
        }
      } finally {
        setRecencyStampLimitForTests();
      }
    }
  });
});

test("P1-11: the full pass keeps a pending texture owner pinned through the count pass", () => {
  withTextureLoader(() => {
    for (const legacyScan of [true, false]) {
      sink = [];
      const loader = new ModelTextureLoader({ cache: true, limits: { count: 8, knownLogicalTextureBytes: 1 << 20 } });
      const cache = new WorldMaterialCache(loader, { limits: { count: 1 }, legacyScan });
      cache.getOrCreate(spec("pending", "pp.blp"));
      cache.getOrCreate(spec("ready", "ir.blp"));
      cache.getOrCreate(spec("plain"));
      assert.deepEqual(cache.commitPins(new Set()), ["ready", "plain"], `legacy ${legacyScan}`);
      cache.dispose();
    }
  });
});
