import assert from "node:assert/strict";
import test from "node:test";
import {
  CharacterAtlasClient,
  CHARACTER_ATLAS_KNOWN_LOGICAL_TEXTURE_BYTE_LIMIT,
} from "../dist/code/browser/CharacterAtlas.js";

function layer(path, section) {
  return [{ path, ...(section ? { section } : {}) }];
}

function installPage({ bitmapFor = (path) => ({ path, width: 8, height: 8, close() {} }), fetchHook } = {}) {
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap,
  };
  const fetches = [];
  const canvases = [];
  globalThis.fetch = async (url) => {
    const path = new URL(url).searchParams.get("path");
    fetches.push(path);
    if (fetchHook) return fetchHook(path, url);
    return { ok: true, status: 200, blob: async () => ({ size: 1, path }) };
  };
  globalThis.createImageBitmap = async (blob) => bitmapFor(blob.path);
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
      canvases.push(canvas);
      return canvas;
    },
  };
  return {
    fetches,
    canvases,
    restore() {
      globalThis.fetch = original.fetch;
      globalThis.document = original.document;
      globalThis.createImageBitmap = original.createImageBitmap;
    },
  };
}

function limits(overrides = {}) {
  return {
    limits: {
      atlasCount: 32,
      atlasKnownLogicalTextureBytes: CHARACTER_ATLAS_KNOWN_LOGICAL_TEXTURE_BYTE_LIMIT,
      sourceCount: 32,
      sourceDecodedPixels: 1_000_000,
      sourceResponseBytes: 1024,
      sourceEntryPixels: 1_000_000,
      ...overrides,
    },
  };
}

test("atlas true LRU touches hits, plateaus, and rebuilds an evicted appearance", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://residency.test", Date.now, limits({ atlasCount: 2 }));
    const first = await atlas.compose("first", layer("first.blp"));
    const second = await atlas.compose("second", layer("second.blp"));
    assert.ok(first && second);
    let firstDisposals = 0;
    let secondDisposals = 0;
    first.addEventListener("dispose", () => { firstDisposals++; });
    second.addEventListener("dispose", () => { secondDisposals++; });

    assert.equal(atlas.get("first"), first, "a cache hit promotes first to newest");
    assert.ok(await atlas.compose("third", layer("third.blp")));
    assert.equal(atlas.get("second"), undefined, "the untouched oldest entry is evicted");
    assert.equal(secondDisposals, 1);
    assert.equal(firstDisposals, 0);
    assert.equal(atlas.residencyStats.atlases.count, 2);

    const rebuilt = await atlas.compose("second", layer("second.blp"));
    assert.ok(rebuilt && rebuilt !== second);
    assert.equal(page.fetches.filter((path) => path === "second.blp").length, 1,
      "atlas re-entry can reuse an independently resident decoded source");
    assert.equal(atlas.residencyStats.atlases.count, 2);
  } finally {
    page.restore();
  }
});

test("active atlas pins may overflow both soft policy and converge after the footprint changes", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://pins.test", Date.now, limits({
      atlasCount: 1,
      atlasKnownLogicalTextureBytes: 1_398_100,
    }));
    atlas.commitPins(new Set(["one", "two"]));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.deepEqual(atlas.residencyStats.atlases, {
      count: 2,
      knownLogicalTextureBytes: 2_796_200,
      unknownLogicalTextureCount: 0,
      pinnedCount: 2,
      overflowCount: 1,
      overflowKnownLogicalTextureBytes: 1_398_100,
    });

    atlas.commitPins(new Set(["two"]));
    assert.equal(atlas.get("one"), undefined);
    assert.ok(atlas.get("two"));
    assert.equal(atlas.residencyStats.atlases.overflowCount, 0);
  } finally {
    page.restore();
  }
});

test("source pixel pressure evicts by exact decoded surface area independently of source count", async () => {
  const page = installPage({
    bitmapFor: (path) => ({ path, width: 8, height: 8, close() {} }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://pixels.test", Date.now, limits({
      sourceCount: 8,
      sourceDecodedPixels: 64,
    }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.equal(atlas.residencyStats.sources.count, 1);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 64);
    assert.equal(atlas.residencyStats.atlases.count, 2);
    assert.ok(await atlas.compose("one-reentry", layer("one.blp")));
    assert.equal(page.fetches.filter((path) => path === "one.blp").length, 2);
  } finally {
    page.restore();
  }
});

test("pending source pins may overflow count and converge immediately after their leases settle", async () => {
  const resolvers = new Map();
  const page = installPage({
    fetchHook: (path) => new Promise((resolve) => { resolvers.set(path, resolve); }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://source-pins.test", Date.now, limits({ sourceCount: 1 }));
    const one = atlas.compose("one", layer("one.blp"));
    const two = atlas.compose("two", layer("two.blp"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual({
      count: atlas.residencyStats.sources.count,
      activeLeases: atlas.residencyStats.sources.activeLeases,
      pinnedCount: atlas.residencyStats.sources.pinnedCount,
      overflowCount: atlas.residencyStats.sources.overflowCount,
    }, { count: 2, activeLeases: 2, pinnedCount: 2, overflowCount: 1 });

    resolvers.get("one.blp")({ ok: true, status: 200, blob: async () => ({ size: 1, path: "one.blp" }) });
    resolvers.get("two.blp")({ ok: true, status: 200, blob: async () => ({ size: 1, path: "two.blp" }) });
    assert.ok(await one);
    assert.ok(await two);
    assert.equal(atlas.residencyStats.sources.count, 1);
    assert.equal(atlas.residencyStats.sources.overflowCount, 0);
  } finally {
    page.restore();
  }
});

test("source cache hits touch true LRU order", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://source-lru.test", Date.now, limits({ sourceCount: 2 }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.ok(await atlas.compose("one-touch", layer("one.blp")));
    assert.ok(await atlas.compose("three", layer("three.blp")));
    assert.ok(await atlas.compose("one-still-resident", layer("one.blp")));
    assert.equal(page.fetches.filter((path) => path === "one.blp").length, 1);
    assert.ok(await atlas.compose("two-reentry", layer("two.blp")));
    assert.equal(page.fetches.filter((path) => path === "two.blp").length, 2,
      "the untouched oldest source was evicted after one was promoted");
  } finally {
    page.restore();
  }
});

test("atlas and source budgets are independent and source re-entry fetches after exact eviction", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://independent.test", Date.now, limits({
      atlasCount: 8,
      sourceCount: 1,
    }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.equal(atlas.residencyStats.atlases.count, 2);
    assert.equal(atlas.residencyStats.sources.count, 1);

    assert.ok(await atlas.compose("one-again", layer("one.blp")));
    assert.equal(page.fetches.filter((path) => path === "one.blp").length, 2);
    assert.equal(atlas.residencyStats.atlases.count, 3,
      "source eviction does not evict composed atlas textures");
    assert.equal(atlas.residencyStats.sources.count, 1);
  } finally {
    page.restore();
  }
});

test("aliased decoder identities count pixels once and close only after the last source owner leaves", async () => {
  let closes = 0;
  const shared = { width: 8, height: 8, close: () => { closes++; } };
  const page = installPage({ bitmapFor: () => shared });
  try {
    const atlas = new CharacterAtlasClient("http://alias.test", Date.now, limits({ sourceCount: 1 }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.equal(atlas.residencyStats.sources.count, 1);
    assert.equal(atlas.residencyStats.sources.uniqueReadyBitmaps, 1);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 64);
    assert.equal(closes, 0, "evicting one aliased path preserves the remaining owner");

    globalThis.createImageBitmap = async (blob) => ({ path: blob.path, width: 8, height: 8, close() {} });
    assert.ok(await atlas.compose("three", layer("three.blp")));
    assert.equal(closes, 1, "the shared identity closes exactly when its final path is evicted");
  } finally {
    page.restore();
  }
});

test("pixel-only eviction skips non-reducing aliases for the oldest ownership that frees pixels", async () => {
  let sharedCloses = 0;
  const shared = { width: 8, height: 8, close: () => { sharedCloses++; } };
  const page = installPage({
    bitmapFor: (path) => path === "one.blp" || path === "two.blp"
      ? shared
      : { path, width: 8, height: 8, close() {} },
  });
  try {
    const atlas = new CharacterAtlasClient("http://alias-pixels.test", Date.now, limits({
      sourceCount: 10,
      sourceDecodedPixels: 128,
    }));
    assert.ok(await atlas.compose("one", layer("one.blp")));
    assert.ok(await atlas.compose("two", layer("two.blp")));
    assert.ok(await atlas.compose("three", layer("three.blp")));
    assert.ok(await atlas.compose("four", layer("four.blp")));

    assert.equal(sharedCloses, 0, "removing one alias path would not improve pixel pressure");
    assert.equal(atlas.residencyStats.sources.count, 3,
      "both alias paths remain while the oldest unique owner is evicted");
    assert.equal(atlas.residencyStats.sources.decodedPixels, 128);
    assert.ok(await atlas.compose("three-reentry", layer("three.blp")));
    assert.equal(page.fetches.filter((path) => path === "three.blp").length, 2);
  } finally {
    page.restore();
  }
});

test("an entirely aliased unpinned ownership group is evicted together to converge pixel overflow", async () => {
  let closes = 0;
  const shared = { width: 8, height: 8, close: () => { closes++; } };
  const page = installPage({ bitmapFor: () => shared });
  try {
    const atlas = new CharacterAtlasClient("http://alias-group.test", Date.now, limits({
      sourceCount: 10,
      sourceDecodedPixels: 32,
      sourceEntryPixels: 64,
    }));
    const one = atlas.compose("one", layer("one.blp"));
    const two = atlas.compose("two", layer("two.blp"));
    assert.ok(await one);
    assert.ok(await two);
    assert.equal(atlas.residencyStats.sources.count, 0);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 0);
    assert.equal(atlas.residencyStats.sources.overflowDecodedPixels, 0);
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("pixel group fallback stops after the first aliased ownership restores the budget", async () => {
  let firstCloses = 0;
  let secondCloses = 0;
  const first = { width: 8, height: 8, close: () => { firstCloses++; } };
  const second = { width: 8, height: 8, close: () => { secondCloses++; } };
  const page = installPage({
    bitmapFor: (path) => path.startsWith("first-") ? first : second,
  });
  try {
    const atlas = new CharacterAtlasClient("http://alias-groups.test", Date.now, limits({
      sourceCount: 10,
      sourceDecodedPixels: 64,
    }));
    assert.ok(await atlas.compose("all", [
      { path: "first-one.blp" },
      { path: "first-two.blp" },
      { path: "second-one.blp" },
      { path: "second-two.blp" },
    ]));

    assert.equal(firstCloses, 1, "the oldest complete alias group is evicted");
    assert.equal(secondCloses, 0, "eviction stops as soon as decoded pixels converge");
    assert.equal(atlas.residencyStats.sources.count, 2);
    assert.equal(atlas.residencyStats.sources.uniqueReadyBitmaps, 1);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 64);
    assert.equal(atlas.residencyStats.sources.overflowDecodedPixels, 0);
    assert.ok(await atlas.compose("second-still-resident", layer("second-one.blp")));
    assert.equal(page.fetches.filter((path) => path === "second-one.blp").length, 1);
  } finally {
    page.restore();
  }
});

test("touching any alias promotes its shared bitmap for resource-level pixel LRU", async () => {
  let firstCloses = 0;
  let secondCloses = 0;
  let newestCloses = 0;
  const first = { width: 8, height: 8, close: () => { firstCloses++; } };
  const second = { width: 8, height: 8, close: () => { secondCloses++; } };
  const secondReplacement = { width: 8, height: 8, close() {} };
  const newest = { width: 8, height: 8, close: () => { newestCloses++; } };
  const page = installPage({
    bitmapFor: (path) => path.startsWith("first-") ? first
      : path.startsWith("second-") ? (secondCloses === 0 ? second : secondReplacement) : newest,
  });
  try {
    const atlas = new CharacterAtlasClient("http://alias-resource-lru.test", Date.now, limits({
      sourceCount: 10,
      sourceDecodedPixels: 128,
    }));
    assert.ok(await atlas.compose("seed", [
      { path: "first-one.blp" }, { path: "first-two.blp" },
      { path: "second-one.blp" }, { path: "second-two.blp" },
    ]));
    assert.ok(await atlas.compose("touch-first", layer("first-one.blp")));
    assert.ok(await atlas.compose("admit-newest", layer("newest.blp")));

    assert.equal(firstCloses, 0, "a hit through one alias promotes the shared decoded surface");
    assert.equal(secondCloses, 1, "pixel pressure evicts the least-recently used bitmap identity");
    assert.equal(newestCloses, 0);
    assert.equal(atlas.residencyStats.sources.decodedPixels, 128);
    assert.ok(await atlas.compose("second-reentry", layer("second-one.blp")));
    assert.equal(page.fetches.filter((path) => path === "second-one.blp").length, 2);
  } finally {
    page.restore();
  }
});

test("compose-owned source leases pin one shared pending request and release after stale/success paths", async () => {
  let resolveFetch;
  const fetchAnswer = new Promise((resolve) => { resolveFetch = resolve; });
  let closes = 0;
  const bitmap = { width: 8, height: 8, close: () => { closes++; } };
  const page = installPage({
    bitmapFor: () => bitmap,
    fetchHook: async () => fetchAnswer,
  });
  try {
    const atlas = new CharacterAtlasClient("http://leases.test", Date.now, limits({ sourceCount: 1 }));
    const dropped = atlas.compose("dropped", layer("shared.blp"));
    const kept = atlas.compose("kept", layer("shared.blp"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(page.fetches.length, 1);
    assert.equal(atlas.residencyStats.sources.activeLeases, 2);
    assert.equal(atlas.residencyStats.sources.pinnedCount, 1);

    atlas.release("dropped");
    resolveFetch({ ok: true, status: 200, blob: async () => ({ size: 1, path: "shared.blp" }) });
    assert.equal(await dropped, undefined);
    assert.ok(await kept);
    assert.equal(atlas.residencyStats.sources.activeLeases, 0);
    assert.equal(closes, 0, "release of one look does not close the shared source cache");
    atlas.dispose();
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("formal readiness scopes dormant cached partial failures to committed active raw keys", async () => {
  const missing = new Set(["missing-a.blp", "missing-b.blp"]);
  const page = installPage({
    fetchHook: async (path) => missing.has(path)
      ? { ok: false, status: 404 }
      : { ok: true, status: 200, blob: async () => ({ size: 1, path }) },
  });
  try {
    const atlas = new CharacterAtlasClient("http://readiness-scope.test", Date.now, limits());
    assert.ok(await atlas.compose("partial-a", [
      { path: "base-a.blp" }, { path: "missing-a.blp", section: "legUpper" },
    ]));
    assert.ok(await atlas.compose("partial-b", [
      { path: "base-b.blp" }, { path: "missing-b.blp", section: "legUpper" },
    ]));
    assert.equal(atlas.stats.error, 2, "standalone/pre-first-commit behavior remains fail-closed");

    const resident = new Set(["partial-a", "partial-b"]);
    atlas.commitPins(resident, new Set(["partial-a"]));
    assert.equal(atlas.stats.error, 1);
    atlas.commitPins(resident, new Set());
    assert.equal(atlas.stats.error, 0, "dormant built-cache-only failures do not block formal readiness");
    assert.equal(atlas.residencyStats.atlases.count, 2);
    atlas.commitPins(resident, new Set(["partial-b"]));
    assert.equal(atlas.stats.error, 1, "an active failure remains fail-closed on re-entry");
  } finally {
    page.restore();
  }
});

test("refresh retries only submitted partial atlases and resumes a dormant retry on re-entry", async () => {
  let now = 0;
  const attempts = new Map();
  const retryPaths = new Set(["active-missing.blp", "dormant-missing.blp"]);
  const page = installPage({
    fetchHook: async (path) => {
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      if (retryPaths.has(path) && attempt === 1) return { ok: false, status: 500 };
      return { ok: true, status: 200, blob: async () => ({ size: 1, path }) };
    },
  });
  try {
    const atlas = new CharacterAtlasClient("http://refresh-scope.test", () => now, limits());
    assert.ok(await atlas.compose("active", [
      { path: "active-base.blp" }, { path: "active-missing.blp", section: "legUpper" },
    ]));
    assert.ok(await atlas.compose("dormant", [
      { path: "dormant-base.blp" }, { path: "dormant-missing.blp", section: "legUpper" },
    ]));

    const resident = new Set(["active", "dormant"]);
    atlas.commitPins(resident, new Set(["active"]));
    now = 2_000;
    atlas.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts.get("active-missing.blp"), 2);
    assert.equal(attempts.get("dormant-missing.blp"), 1,
      "a residency-only atlas cannot inject background work into the submitted frame");

    atlas.commitPins(resident, new Set(["dormant"]));
    atlas.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts.get("dormant-missing.blp"), 2,
      "commitPins re-arms an already-due retry when its raw appearance becomes submitted again");
  } finally {
    page.restore();
  }
});

test("residency snapshots are deeply frozen and dispose resets every exact total", async () => {
  const page = installPage();
  try {
    const atlas = new CharacterAtlasClient("http://stats.test", Date.now, limits());
    assert.ok(await atlas.compose("one", layer("one.blp")));
    const before = atlas.residencyStats;
    assert.equal(Object.isFrozen(before), true);
    assert.equal(Object.isFrozen(before.atlases), true);
    assert.equal(Object.isFrozen(before.sources), true);
    atlas.dispose();
    assert.deepEqual(atlas.residencyStats, {
      atlases: {
        count: 0, knownLogicalTextureBytes: 0, unknownLogicalTextureCount: 0,
        pinnedCount: 0, overflowCount: 0, overflowKnownLogicalTextureBytes: 0,
      },
      sources: {
        count: 0, uniqueReadyBitmaps: 0, decodedPixels: 0,
        decodedByteSizeUnsupportedCount: 0, activeLeases: 0, pinnedCount: 0,
        terminalCount: 0, overflowCount: 0, overflowDecodedPixels: 0,
      },
    });
  } finally {
    page.restore();
  }
});

test("constructor preserves old callers and rejects non-positive or unsafe optional limits", () => {
  assert.doesNotThrow(() => new CharacterAtlasClient("http://compat.test"));
  assert.doesNotThrow(() => new CharacterAtlasClient("http://compat.test", () => 0));
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new CharacterAtlasClient(
      "http://compat.test", Date.now, { limits: { sourceCount: value } },
    ), RangeError);
  }
});
