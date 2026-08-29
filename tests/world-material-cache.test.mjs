import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { ResourceAccountingLedger } from "../dist/code/browser/ResourceAccounting.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import {
  WORLD_MATERIAL_CACHE_COUNT_LIMIT,
  WorldMaterialCache,
} from "../dist/code/browser/WorldMaterialCache.js";

function withTextureLoader(implementation, run) {
  const original = THREE.TextureLoader.prototype.load;
  THREE.TextureLoader.prototype.load = implementation;
  try {
    return run();
  } finally {
    THREE.TextureLoader.prototype.load = original;
  }
}

function rgbaTexture(width = 1, height = 1) {
  const texture = new THREE.DataTexture(new Uint8Array(width * height * 4), width, height);
  texture.generateMipmaps = false;
  return texture;
}

function spec(key, overrides = {}) {
  return {
    key,
    kind: "mesh",
    createMaterial(texture) {
      const material = new THREE.MeshBasicMaterial();
      if (texture) material.map = texture;
      return material;
    },
    ...overrides,
  };
}

test("world material defaults plateau at 256 through post-admission exact eviction", () => {
  const textures = new ModelTextureLoader({ cache: true });
  const cache = new WorldMaterialCache(textures);
  for (let index = 0; index < 270; index++) cache.getOrCreate(spec(`material-${index}`));
  assert.equal(cache.residencyStats.materials.count, 270);
  assert.equal(cache.residencyStats.materials.overflowCount, 14);
  assert.equal(WORLD_MATERIAL_CACHE_COUNT_LIMIT, 256);
  assert.deepEqual(cache.commitPins(new Set()),
    Array.from({ length: 14 }, (_, index) => `material-${index}`));
  assert.equal(cache.residencyStats.materials.count, 256);
  assert.equal(cache.residencyStats.materials.overflowCount, 0);
  cache.dispose();
});

test("material entry counts can preserve kind-specific telemetry on a shared lane", () => {
  const cache = new WorldMaterialCache(new ModelTextureLoader({ cache: true }));
  cache.getOrCreate(spec("wmo", { kind: "wmo-run" }));
  cache.getOrCreate(spec("legacy-a", { kind: "legacy-run" }));
  cache.getOrCreate(spec("legacy-b", { kind: "legacy-run" }));
  assert.deepEqual({
    combined: cache.entryCount(),
    wmo: cache.entryCount("wmo-run"),
    legacy: cache.entryCount("legacy-run"),
    missing: cache.entryCount("missing"),
  }, { combined: 3, wmo: 1, legacy: 2, missing: 0 });
  cache.dispose();
});

test("material hits and committed exact pins touch true LRU without changing revision", () => {
  const cache = new WorldMaterialCache(new ModelTextureLoader({ cache: true }), {
    limits: { count: 2 },
  });
  const a = cache.getOrCreate(spec("a"));
  cache.getOrCreate(spec("b"));
  const beforePin = cache.revision;
  cache.commitPins(new Set([a]));
  assert.equal(cache.revision, beforePin);
  const c = cache.getOrCreate(spec("c"));
  const beforeEviction = cache.revision;
  assert.deepEqual(cache.commitPins(new Set([a, c])), ["b"]);
  assert.equal(cache.revision, beforeEviction + 1);
  assert.strictEqual(cache.get("a"), a);
  assert.strictEqual(cache.get("c"), c);
  cache.dispose();
});

test("exact live pins may overflow and converge when the pin leaves", () => {
  const cache = new WorldMaterialCache(new ModelTextureLoader({ cache: true }), {
    limits: { count: 1 },
  });
  const a = cache.getOrCreate(spec("a"));
  const b = cache.getOrCreate(spec("b"));
  assert.deepEqual(cache.commitPins(new Set([a, b])), []);
  assert.deepEqual(cache.residencyStats.materials, {
    count: 2,
    pinnedCount: 2,
    pendingTextureCount: 0,
    overflowCount: 1,
  });
  assert.deepEqual(cache.commitPins(new Set([b])), ["a"]);
  assert.equal(cache.residencyStats.materials.overflowCount, 0);
  cache.dispose();
});

test("pending texture owners are honest pins until settlement permits convergence", () => {
  const requests = [];
  withTextureLoader(function (url, onLoad, _progress, onError) {
    const texture = rgbaTexture();
    requests.push({ url, texture, onLoad, onError });
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({
      cache: true,
      limits: { count: 1, knownLogicalTextureBytes: 1024 },
    });
    const cache = new WorldMaterialCache(textures, { limits: { count: 1 } });
    const a = cache.getOrCreate(spec("a", { textureUrl: "a.blp" }));
    const b = cache.getOrCreate(spec("b", { textureUrl: "b.blp" }));
    assert.deepEqual(cache.commitPins(new Set()), []);
    assert.deepEqual(cache.residencyStats.materials, {
      count: 2,
      pinnedCount: 0,
      pendingTextureCount: 2,
      overflowCount: 1,
    });
    assert.equal(cache.residencyStats.textures.overflowCount, 1);

    requests.find(({ url }) => url === "a.blp").onLoad(a.material.map);
    assert.deepEqual(cache.commitPins(new Set([b])), ["a"]);
    assert.equal(cache.residencyStats.materials.pendingTextureCount, 1);
    assert.equal(cache.residencyStats.materials.overflowCount, 0);
    cache.dispose();
  });
});

test("texture readiness keeps settlement global but scopes failed bases to committed exact pins", () => {
  const requests = [];
  withTextureLoader(function (url, onLoad, _progress, onError) {
    const texture = rgbaTexture();
    requests.push({ url, texture, onLoad, onError });
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({ cache: true });
    const cache = new WorldMaterialCache(textures);
    const badA = cache.getOrCreate(spec("bad-a", { textureUrl: "bad.blp" }));
    const badB = cache.getOrCreate(spec("bad-b", { textureUrl: "bad.blp" }));
    const pending = cache.getOrCreate(spec("pending", { textureUrl: "pending.blp" }));
    assert.equal(requests.length, 2, "shared material owners create one exact base request");

    requests.find(({ url }) => url === "bad.blp").onError(new Error("missing"));
    const beforeCommit = cache.textureReadiness;
    assert.ok(Object.isFrozen(beforeCommit));
    assert.deepEqual(beforeCommit, { pending: 1, error: 1, generation: 1 },
      "before the first footprint commit the complete loader failure remains observable");

    cache.commitPins(new Set());
    assert.deepEqual(cache.textureReadiness, { pending: 1, error: 0, generation: 1 },
      "old pending I/O remains a mutation barrier while its unpinned failure is no longer terminal");

    cache.commitPins(new Set([badA, badB]));
    assert.equal(cache.textureReadiness.error, 1,
      "two pinned materials sharing one failed request contribute one exact error");
    cache.commitPins(new Set([badB]));
    assert.equal(cache.textureReadiness.error, 1,
      "one pinned sibling still samples the same failed base");
    cache.commitPins(new Set());
    assert.equal(cache.textureReadiness.error, 0);

    requests.find(({ url }) => url === "pending.blp").onLoad(pending.material.map);
    assert.deepEqual(cache.textureReadiness, { pending: 0, error: 0, generation: 2 });
    cache.dispose();
    assert.deepEqual(cache.textureReadiness, { pending: 0, error: 0, generation: 3 },
      "disposed lanes publish an inert frozen readiness state");
    assert.ok(Object.isFrozen(cache.textureReadiness));
  });
});

test("a stale exact material pin cannot resurrect an evicted failed readiness record", () => {
  withTextureLoader(function (_url, _onLoad, _progress, onError) {
    const texture = rgbaTexture();
    onError?.(new Error("missing"));
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({
      cache: true,
      limits: { count: 0, knownLogicalTextureBytes: 0 },
    });
    const cache = new WorldMaterialCache(textures, { limits: { count: 0 } });
    const stale = cache.getOrCreate(spec("stale", { textureUrl: "stale.blp" }));
    assert.equal(cache.textureReadiness.error, 1);
    assert.deepEqual(cache.commitPins(new Set()), ["stale"]);
    assert.deepEqual(cache.textureReadiness, { pending: 0, error: 0, generation: 1 });
    assert.deepEqual(cache.commitPins(new Set([stale])), []);
    assert.equal(cache.textureReadiness.error, 0);
    cache.dispose();
  });
});

test("byte-only texture cascade skips unknown bases and evicts the oldest useful owner", () => {
  withTextureLoader(function (url, onLoad) {
    const texture = url === "unknown.blp" ? new THREE.Texture() : rgbaTexture(2, 1);
    onLoad?.(texture);
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({
      cache: true,
      limits: { count: 10, knownLogicalTextureBytes: 8 },
    });
    const cache = new WorldMaterialCache(textures);
    cache.getOrCreate(spec("unknown", { textureUrl: "unknown.blp" }));
    cache.getOrCreate(spec("a", { textureUrl: "a.blp" }));
    cache.getOrCreate(spec("b", { textureUrl: "b.blp" }));
    assert.equal(cache.residencyStats.textures.overflowKnownLogicalTextureBytes, 8);
    assert.deepEqual(cache.commitPins(new Set()), ["a"]);
    assert.ok(cache.get("unknown"));
    assert.ok(cache.get("b"));
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.residencyStats.textures.knownLogicalTextureBytes, 8);
    assert.equal(cache.residencyStats.textures.unknownLogicalTextureCount, 1);
    cache.dispose();
  });
});

test("one pinned shared-URL owner preserves unpinned siblings until the base can converge", () => {
  let requests = 0;
  let baseDisposals = 0;
  withTextureLoader(function (_url, onLoad) {
    requests++;
    const texture = rgbaTexture();
    texture.addEventListener("dispose", () => { baseDisposals++; });
    onLoad?.(texture);
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({
      cache: true,
      limits: { count: 0, knownLogicalTextureBytes: 1024 },
    });
    const cache = new WorldMaterialCache(textures);
    const a = cache.getOrCreate(spec("a", { textureUrl: "shared.blp" }));
    cache.getOrCreate(spec("b", { textureUrl: "shared.blp" }));
    assert.equal(requests, 1);
    assert.equal(textures.pressureSnapshot()[0].ownerTokens.length, 2);
    assert.deepEqual(cache.commitPins(new Set([a])), []);
    assert.equal(cache.residencyStats.materials.count, 2,
      "dropping one sibling could not release the pinned shared base");
    assert.equal(cache.residencyStats.textures.overflowCount, 1);

    assert.deepEqual(new Set(cache.commitPins(new Set())), new Set(["a", "b"]));
    assert.equal(cache.residencyStats.materials.count, 0);
    assert.equal(cache.residencyStats.textures.count, 0);
    assert.equal(baseDisposals, 1);
    cache.dispose();
  });
});

test("stale exact request replacement cannot be deleted by the old reentrant teardown", () => {
  let requests = 0;
  withTextureLoader(function (_url, onLoad) {
    requests++;
    const texture = rgbaTexture();
    onLoad?.(texture);
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({ cache: true });
    const cache = new WorldMaterialCache(textures);
    const old = cache.getOrCreate(spec("same", { textureUrl: "old.blp" }));
    const oldRequestId = textures.pressureSnapshot()[0].requestId;
    let replacement;
    old.material.addEventListener("dispose", () => {
      replacement = cache.getOrCreate(spec("same", { textureUrl: "new.blp" }));
    });
    textures.clear();
    assert.equal(cache.get("same"), undefined);
    assert.ok(replacement);
    assert.strictEqual(cache.get("same"), replacement);
    assert.notStrictEqual(replacement, old);
    assert.notEqual(textures.pressureSnapshot()[0].requestId, oldRequestId);
    assert.equal(requests, 2);
    cache.dispose();
  });
});

test("teardown removes ownership before synchronous listeners and disposes material-view-lease-base", () => {
  const events = [];
  let textures;
  withTextureLoader(function (_url, onLoad) {
    const texture = rgbaTexture();
    texture.addEventListener("dispose", () => {
      assert.equal(textures.residencyStats.activeLeases, 0);
      events.push("base");
    });
    onLoad?.(texture);
    return texture;
  }, () => {
    textures = new ModelTextureLoader({
      cache: true,
      limits: { count: 0, knownLogicalTextureBytes: 1024 },
    });
    const cache = new WorldMaterialCache(textures);
    const entry = cache.getOrCreate(spec("ordered", {
      textureUrl: "ordered.blp",
      createPrivateView(base) {
        const view = base.clone();
        view.addEventListener("dispose", () => {
          assert.equal(textures.residencyStats.activeLeases, 1);
          events.push("view");
        });
        return view;
      },
    }));
    entry.material.addEventListener("dispose", () => {
      assert.equal(cache.get("ordered"), undefined, "cache ownership is gone before listeners run");
      assert.equal(textures.residencyStats.activeLeases, 1);
      events.push("material");
      cache.dispose();
    });
    cache.commitPins(new Set());
    cache.dispose();
    assert.deepEqual(events, ["material", "view", "base"]);
    assert.deepEqual(cache.residencyStats.materials, {
      count: 0,
      pinnedCount: 0,
      pendingTextureCount: 0,
      overflowCount: 0,
    });
    assert.equal(cache.residencyStats.textures.count, 0);
    assert.equal(cache.get("ordered"), undefined);
    assert.deepEqual(cache.commitPins(new Set([entry])), []);
  });
});

test("throwing material dispose listeners cannot strand the private view, lease, or base", () => {
  const events = [];
  withTextureLoader(function (_url, onLoad) {
    const texture = rgbaTexture();
    texture.addEventListener("dispose", () => events.push("base"));
    onLoad?.(texture);
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({
      cache: true,
      limits: { count: 0, knownLogicalTextureBytes: 1024 },
    });
    const cache = new WorldMaterialCache(textures);
    const entry = cache.getOrCreate(spec("throwing-dispose", {
      textureUrl: "throwing-dispose.blp",
      createPrivateView(base) {
        const view = base.clone();
        view.addEventListener("dispose", () => events.push("view"));
        return view;
      },
    }));
    entry.material.addEventListener("dispose", () => {
      events.push("material");
      throw new Error("dispose listener failed");
    });
    assert.throws(() => cache.commitPins(new Set()), /dispose listener failed/);
    assert.deepEqual(events, ["material", "view", "base"]);
    assert.equal(textures.residencyStats.activeLeases, 0);
    assert.equal(textures.residencyStats.count, 0);
    assert.equal(cache.residencyStats.materials.count, 0);
    cache.dispose();
  });
});

test("throwing and reentrant factories clean unpublished views, leases, and bases without ghosts", () => {
  const events = [];
  withTextureLoader(function (_url, onLoad) {
    const texture = rgbaTexture();
    texture.addEventListener("dispose", () => events.push("base"));
    onLoad?.(texture);
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({
      cache: true,
      limits: { count: 0, knownLogicalTextureBytes: 1024 },
    });
    const cache = new WorldMaterialCache(textures);
    assert.throws(() => cache.getOrCreate(spec("throw", {
      textureUrl: "throw.blp",
      createPrivateView(base) {
        const view = base.clone();
        view.addEventListener("dispose", () => events.push("view"));
        return view;
      },
      createMaterial() { throw new Error("factory failed"); },
    })), /factory failed/);
    assert.deepEqual(events, ["view", "base"]);
    assert.equal(cache.revision, 0);
    assert.equal(cache.residencyStats.materials.count, 0);
    assert.equal(cache.residencyStats.textures.count, 0);

    let lateMaterialDisposals = 0;
    const late = new THREE.MeshBasicMaterial();
    late.addEventListener("dispose", () => { lateMaterialDisposals++; });
    assert.throws(() => cache.getOrCreate(spec("late", {
      textureUrl: "late.blp",
      createMaterial() {
        cache.dispose();
        return late;
      },
    })), /disposed/);
    assert.equal(lateMaterialDisposals, 1);
    assert.equal(cache.residencyStats.materials.count, 0);
    assert.equal(cache.residencyStats.textures.count, 0);
    assert.throws(() => cache.getOrCreate(spec("inert")), /disposed/);
  });
});

test("residency snapshots are deeply frozen/reset and accounting deduplicates shared bases", () => {
  withTextureLoader(function (_url, onLoad) {
    const texture = rgbaTexture(2, 1);
    onLoad?.(texture);
    return texture;
  }, () => {
    const textures = new ModelTextureLoader({ cache: true });
    const cache = new WorldMaterialCache(textures);
    const a = cache.getOrCreate(spec("a", { textureUrl: "shared.blp" }));
    const b = cache.getOrCreate(spec("b", { textureUrl: "shared.blp" }));
    cache.commitPins(new Set([a, b]));
    const stats = cache.residencyStats;
    assert.ok(Object.isFrozen(stats));
    assert.ok(Object.isFrozen(stats.materials));
    assert.ok(Object.isFrozen(stats.textures));

    const ledger = new ResourceAccountingLedger();
    cache.visitRetainedResources(ledger);
    cache.visitRetainedResources(ledger);
    const gpu = ledger.snapshot().gpuTextures;
    assert.deepEqual({
      bytes: gpu.estimatedLogicalTextureBytes,
      unique: gpu.uniqueResources,
      owners: gpu.owners,
      references: gpu.references,
      shared: gpu.sharedResources,
    }, { bytes: 8, unique: 1, owners: 3, references: 3, shared: 1 });

    const beforeDisposeRevision = cache.revision;
    cache.dispose();
    cache.dispose();
    assert.equal(cache.revision, beforeDisposeRevision + 1);
    assert.deepEqual(cache.residencyStats, {
      materials: {
        count: 0,
        pinnedCount: 0,
        pendingTextureCount: 0,
        overflowCount: 0,
      },
      textures: {
        count: 0,
        knownLogicalTextureBytes: 0,
        unknownLogicalTextureCount: 0,
        activeLeases: 0,
        pinnedCount: 0,
        overflowCount: 0,
        overflowKnownLogicalTextureBytes: 0,
      },
    });
  });
});
