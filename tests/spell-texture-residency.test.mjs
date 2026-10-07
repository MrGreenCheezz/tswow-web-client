import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { EVERY_GEOSET, buildModel } from "../dist/code/browser/ModelBuild.js";
import { buildModelEffects, disposeModelEffects } from "../dist/code/browser/ParticleRender.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";

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

test("R2.4 concurrent spell owners share one request but retain distinct exact leases", () => {
  const requests = [];
  withTextureLoader(function (_url, onLoad, _progress, onError) {
    const texture = rgbaTexture();
    requests.push({ texture, onLoad, onError });
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({
      cache: true,
      limits: { count: 0, knownLogicalTextureBytes: 0 },
    });
    const firstOwner = {};
    const secondOwner = {};
    const first = loader.acquire("shared.blp", firstOwner);
    const second = loader.acquire("shared.blp", secondOwner);
    assert.equal(requests.length, 1);
    assert.strictEqual(first.texture, second.texture);
    assert.equal(first.requestId, second.requestId);
    assert.notStrictEqual(first, second);
    assert.deepEqual(loader.residencyStats, {
      count: 1,
      knownLogicalTextureBytes: 0,
      unknownLogicalTextureCount: 1,
      activeLeases: 2,
      pinnedCount: 1,
      overflowCount: 1,
      overflowKnownLogicalTextureBytes: 0,
    });

    let disposals = 0;
    first.texture.addEventListener("dispose", () => { disposals++; });
    requests[0].onLoad(first.texture);
    first.release();
    first.release();
    loader.evictUnleased();
    assert.equal(disposals, 0, "one cast cannot evict another cast's exact base");
    assert.equal(loader.residencyStats.activeLeases, 1);

    second.release();
    assert.deepEqual(loader.evictUnleased(), ["shared.blp"]);
    assert.equal(disposals, 1);
    assert.equal(loader.residencyStats.count, 0);
  });
});

test("R2.4 released URL cache plateaus at 256 and an evicted URL refetches", () => {
  let requestCount = 0;
  withTextureLoader(function (_url, onLoad) {
    requestCount++;
    const texture = rgbaTexture();
    onLoad?.(texture);
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({ cache: true });
    for (let index = 0; index < 270; index++) {
      loader.acquire(`texture-${index}.blp`, index).release();
    }
    assert.equal(loader.residencyStats.count, 270);
    assert.equal(loader.residencyStats.overflowCount, 14);
    assert.equal(loader.evictUnleased().length, 14);
    assert.equal(loader.residencyStats.count, 256);
    assert.equal(loader.residencyStats.overflowCount, 0);

    const replacement = loader.acquire("texture-0.blp", "replacement");
    assert.equal(requestCount, 271, "the oldest evicted URL starts a fresh exact request");
    assert.equal(loader.residencyStats.count, 257);
    loader.evictUnleased();
    assert.equal(loader.residencyStats.count, 256, "a different released LRU converges around the pin");
    replacement.release();
  });
});

test("R2.4 known logical byte pressure evicts safely while unknown layouts stay explicit", () => {
  const sizes = new Map([
    ["unknown.blp", undefined],
    ["a.blp", [2, 1]],
    ["b.blp", [2, 1]],
  ]);
  withTextureLoader(function (url, onLoad) {
    const size = sizes.get(url);
    const texture = size ? rgbaTexture(...size) : new THREE.Texture();
    onLoad?.(texture);
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({
      cache: true,
      limits: { count: 3, knownLogicalTextureBytes: 12 },
    });
    for (const url of sizes.keys()) loader.acquire(url, url).release();
    assert.deepEqual(loader.residencyStats, {
      count: 3,
      knownLogicalTextureBytes: 16,
      unknownLogicalTextureCount: 1,
      activeLeases: 0,
      pinnedCount: 0,
      overflowCount: 0,
      overflowKnownLogicalTextureBytes: 4,
    });
    loader.evictUnleased();
    assert.equal(loader.residencyStats.knownLogicalTextureBytes, 8);
    assert.equal(loader.residencyStats.count, 2);
    assert.equal(loader.residencyStats.unknownLogicalTextureCount, 1,
      "byte-only pressure skips an unknown LRU that cannot reduce the violated byte metric");
    assert.equal(loader.statusOf("unknown.blp"), "ready");
  });
});

test("R2.4 active overflow is allowed and release plus safe eviction converges", () => {
  withTextureLoader(function (_url, onLoad) {
    const texture = rgbaTexture();
    onLoad?.(texture);
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({
      cache: true,
      limits: { count: 1, knownLogicalTextureBytes: 1024 },
    });
    const first = loader.acquire("first.blp", {});
    const second = loader.acquire("second.blp", {});
    loader.evictUnleased();
    assert.equal(loader.residencyStats.count, 2);
    assert.equal(loader.residencyStats.pinnedCount, 2);
    assert.equal(loader.residencyStats.overflowCount, 1);
    first.release();
    loader.evictUnleased();
    assert.equal(loader.residencyStats.count, 1);
    assert.equal(loader.residencyStats.overflowCount, 0);
    second.release();
  });
});

test("R2.4 exact lease touches drive true texture LRU without mutating readiness counters", () => {
  withTextureLoader(function (_url, onLoad) {
    const texture = rgbaTexture();
    onLoad?.(texture);
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({
      cache: true,
      limits: { count: 2, knownLogicalTextureBytes: 1024 },
    });
    const a = loader.acquire("a.blp", "owner-a");
    const b = loader.acquire("b.blp", "owner-b");
    b.release();
    const before = loader.stats;
    assert.equal(loader.touch(a), true);
    assert.deepEqual(loader.stats, before, "touch is not a request or settlement generation");
    loader.acquire("c.blp", "owner-c").release();
    assert.deepEqual(loader.pressureSnapshot().map(({ url }) => url), ["b.blp", "a.blp", "c.blp"]);
    assert.deepEqual(loader.evictUnleased(), ["b.blp"]);
    assert.equal(loader.statusOf("a.blp"), "ready");
    assert.equal(loader.statusOf("b.blp"), undefined);
    a.release();
    assert.equal(loader.touch(a), false, "released exact leases cannot promote a base");
  });
});

test("R2.4 pressure snapshots are deeply frozen exact records and stale touches are inert", () => {
  const requests = [];
  withTextureLoader(function (_url, onLoad) {
    const texture = rgbaTexture();
    requests.push({ texture, onLoad });
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({ cache: true });
    const firstOwner = { name: "first" };
    const secondOwner = { name: "second" };
    const first = loader.acquire("exact.blp", firstOwner);
    const second = loader.acquire("exact.blp", secondOwner);
    requests[0].onLoad(first.texture);
    const snapshot = loader.pressureSnapshot();
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot[0]));
    assert.ok(Object.isFrozen(snapshot[0].ownerTokens));
    assert.deepEqual(snapshot[0], {
      url: "exact.blp",
      requestId: first.requestId,
      status: "ready",
      knownLogicalTextureBytes: 4,
      ownerTokens: [firstOwner, secondOwner],
    });
    assert.equal(Object.isFrozen(firstOwner), false, "snapshotting never freezes caller-owned tokens");

    const before = loader.stats;
    loader.clear();
    loader.clear();
    assert.equal(loader.touch(first), false);
    first.release();
    second.release();
    requests[0].onLoad(first.texture);
    assert.deepEqual(loader.stats, {
      pending: 0,
      ready: 0,
      failed: 0,
      error: 0,
      generation: before.generation + 2,
    });

    const replacement = loader.acquire("exact.blp", "replacement");
    assert.notEqual(replacement.requestId, first.requestId);
    assert.equal(loader.touch(first), false, "an old release cannot touch the replacement request");
    assert.deepEqual(loader.pressureSnapshot()[0].ownerTokens, ["replacement"]);
    replacement.release();
  });
});

test("R2.4 uncached same-URL requests retain exact independent terminal errors", () => {
  const requests = [];
  withTextureLoader(function (_url, onLoad, _progress, onError) {
    const texture = rgbaTexture();
    requests.push({ texture, onLoad, onError });
    return texture;
  }, () => {
    const loader = new ModelTextureLoader();
    const failed = loader.load("same.blp");
    const ready = loader.load("same.blp");
    requests[0].onError?.(new Error("first failed"));
    requests[1].onLoad?.(ready);
    assert.equal(loader.status(failed), "failed");
    assert.equal(loader.status(ready), "ready");
    assert.deepEqual(loader.stats, {
      pending: 0, ready: 1, failed: 1, error: 1, generation: 2,
    });
    loader.clear();
  });
});

for (const terminal of ["ready", "failed"]) {
  test(`R2.4 uncached inline ${terminal} followed by throw leaves no terminal ghost`, () => {
    let callbackTexture;
    let disposals = 0;
    withTextureLoader(function (_url, onLoad, _progress, onError) {
      callbackTexture = rgbaTexture();
      callbackTexture.addEventListener("dispose", () => { disposals++; });
      if (terminal === "ready") onLoad?.(callbackTexture);
      else onError?.(new Error("inline failure"));
      throw new Error("loader threw");
    }, () => {
      const loader = new ModelTextureLoader();
      assert.throws(() => loader.load("inline-throw.blp"), /loader threw/);
      assert.deepEqual(loader.stats, {
        pending: 0, ready: 0, failed: 0, error: 0, generation: 1,
      });
      assert.equal(disposals, terminal === "ready" ? 1 : 0,
        "only a callback-provided texture handle is owned after the underlying throw");
    });
  });
}

for (const duplicateOrder of ["error then load", "two loads"]) {
  test(`R2.4 uncached inline ${duplicateOrder} followed by throw disposes every orphan once`, () => {
    const disposals = [];
    withTextureLoader(function (_url, onLoad, _progress, onError) {
      const first = rgbaTexture();
      const duplicate = rgbaTexture();
      first.addEventListener("dispose", () => disposals.push("first"));
      duplicate.addEventListener("dispose", () => disposals.push("duplicate"));
      if (duplicateOrder === "error then load") {
        onError?.(new Error("inline failure"));
        onLoad?.(duplicate);
      } else {
        onLoad?.(first);
        onLoad?.(duplicate);
        onLoad?.(first);
      }
      throw new Error("loader threw");
    }, () => {
      const loader = new ModelTextureLoader();
      assert.throws(() => loader.load("uncached-duplicate-throw.blp"), /loader threw/);
      assert.deepEqual(loader.stats, {
        pending: 0, ready: 0, failed: 0, error: 0, generation: 1,
      });
      assert.deepEqual(
        disposals.sort(),
        duplicateOrder === "error then load" ? ["duplicate"] : ["duplicate", "first"],
      );
    });
  });
}

test("R2.4 uncached throw cleanup survives dispose listeners and preserves the loader error", () => {
  const disposed = [];
  withTextureLoader(function (_url, onLoad) {
    const first = rgbaTexture();
    const duplicate = rgbaTexture();
    first.addEventListener("dispose", () => disposed.push("first"));
    duplicate.addEventListener("dispose", () => {
      disposed.push("duplicate");
      throw new Error("dispose threw");
    });
    onLoad?.(first);
    onLoad?.(duplicate);
    throw new Error("loader threw");
  }, () => {
    const loader = new ModelTextureLoader();
    assert.throws(() => loader.load("uncached-throwing-dispose.blp"), /loader threw/);
    assert.deepEqual(disposed, ["duplicate", "first"]);
    assert.deepEqual(loader.stats, {
      pending: 0, ready: 0, failed: 0, error: 0, generation: 1,
    });
  });
});

test("R2.4 clear detaches old ownership before a dispose listener reacquires the same URL", () => {
  let loader;
  let replacement;
  let requests = 0;
  withTextureLoader(function (_url, onLoad) {
    requests++;
    const texture = rgbaTexture();
    onLoad?.(texture);
    return texture;
  }, () => {
    loader = new ModelTextureLoader({ cache: true });
    const old = loader.acquire("reentrant-clear.blp", "old");
    old.texture.addEventListener("dispose", () => {
      replacement = loader.acquire("reentrant-clear.blp", "replacement");
    });
    loader.clear();

    assert.ok(replacement);
    assert.notStrictEqual(replacement.texture, old.texture);
    assert.notEqual(replacement.requestId, old.requestId);
    assert.equal(loader.touch(old), false);
    assert.equal(loader.touch(replacement), true);
    assert.equal(loader.status(replacement.texture), "ready");
    assert.equal(loader.residencyStats.count, 1,
      "the listener's new-epoch request survives the outer clear");
    assert.equal(requests, 2);
    replacement.release();
    loader.clear();
  });
});

test("R2.4 an evicted record's late callbacks cannot mutate its replacement", () => {
  const requests = [];
  withTextureLoader(function (_url, onLoad, _progress, onError) {
    const texture = rgbaTexture();
    requests.push({ texture, onLoad, onError });
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({
      cache: true,
      limits: { count: 0, knownLogicalTextureBytes: 1024 },
    });
    const old = loader.acquire("same.blp", "old");
    requests[0].onError?.(new Error("old failure"));
    old.release();
    loader.evictUnleased();

    const replacement = loader.acquire("same.blp", "new");
    assert.notStrictEqual(replacement.texture, old.texture);
    assert.notEqual(replacement.requestId, old.requestId);
    requests[0].onLoad?.(old.texture);
    requests[0].onError?.(new Error("duplicate old failure"));
    assert.equal(loader.status(replacement.texture), "pending");
    assert.deepEqual(loader.stats, {
      pending: 1, ready: 0, failed: 0, error: 0, generation: 1,
    });
    requests[1].onLoad?.(replacement.texture);
    assert.equal(loader.status(replacement.texture), "ready");
    replacement.release();
  });
});

test("R2.4 clear makes pending success/error and old lease releases inert", () => {
  const requests = [];
  withTextureLoader(function (_url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    requests.push({ texture, onLoad, onError });
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({ cache: true });
    const lease = loader.acquire("pending.blp", {});
    let disposals = 0;
    lease.texture.addEventListener("dispose", () => { disposals++; });
    loader.clear();
    loader.clear();
    lease.release();
    lease.release();
    requests[0].onLoad?.(lease.texture);
    requests[0].onError?.(new Error("late"));
    assert.equal(disposals, 1);
    assert.deepEqual(loader.stats, {
      pending: 0, ready: 0, failed: 0, error: 0, generation: 2,
    });
    assert.equal(loader.residencyStats.count, 0);
  });
});

for (const callbackIdentity of ["returned", "distinct"]) {
  test(`R2.4 uncached clear keeps caller-owned A and cleans a late ${callbackIdentity} callback exactly`, () => {
    let request;
    let returnedDisposals = 0;
    let callbackDisposals = 0;
    withTextureLoader(function (_url, onLoad) {
      const returned = rgbaTexture();
      const distinct = rgbaTexture();
      returned.addEventListener("dispose", () => { returnedDisposals++; });
      distinct.addEventListener("dispose", () => { callbackDisposals++; });
      request = { returned, distinct, onLoad };
      return returned;
    }, () => {
      const loader = new ModelTextureLoader();
      const returned = loader.load("uncached-stale.blp");
      loader.clear();
      request.onLoad?.(callbackIdentity === "returned" ? returned : request.distinct);

      assert.deepEqual(loader.stats, {
        pending: 0, ready: 0, failed: 0, error: 0, generation: 1,
      });
      assert.equal(loader.status(returned), "failed");
      assert.equal(returnedDisposals, 0, "clear never owns an uncached returned handle");
      assert.equal(callbackDisposals, callbackIdentity === "distinct" ? 1 : 0,
        "only a callback-only identity is orphan cleanup");
      returned.dispose();
      assert.equal(returnedDisposals, 1);
    });
  });
}

for (const ordering of ["complete then clear", "clear then complete"]) {
  test(`R2.4 uncached inline ${ordering} never republishes stale status`, () => {
    let loader;
    let returnedDisposals = 0;
    let callbackDisposals = 0;
    withTextureLoader(function (_url, onLoad) {
      const returned = rgbaTexture();
      const distinct = rgbaTexture();
      returned.addEventListener("dispose", () => { returnedDisposals++; });
      distinct.addEventListener("dispose", () => { callbackDisposals++; });
      if (ordering === "complete then clear") {
        onLoad?.(returned);
        loader.clear();
      } else {
        loader.clear();
        onLoad?.(distinct);
      }
      return returned;
    }, () => {
      loader = new ModelTextureLoader();
      const returned = loader.load("uncached-inline-clear.blp");
      assert.equal(loader.status(returned), "failed");
      assert.deepEqual(loader.stats, {
        pending: 0, ready: 0, failed: 0, error: 0,
        generation: ordering === "complete then clear" ? 2 : 1,
      });
      assert.equal(returnedDisposals, 0, "the uncached return remains caller-owned");
      assert.equal(callbackDisposals, ordering === "clear then complete" ? 1 : 0);
      returned.dispose();
      assert.equal(returnedDisposals, 1);
    });
  });
}

test("R2.4 a cached loader throw cannot leave an inline terminal ghost", () => {
  const disposals = [];
  withTextureLoader(function (_url, onLoad) {
    const first = rgbaTexture();
    const duplicate = rgbaTexture();
    first.addEventListener("dispose", () => disposals.push("first"));
    duplicate.addEventListener("dispose", () => disposals.push("duplicate"));
    onLoad?.(first);
    onLoad?.(duplicate);
    onLoad?.(first);
    throw new Error("inline completion then throw");
  }, () => {
    const loader = new ModelTextureLoader({ cache: true });
    assert.throws(() => loader.acquire("ghost.blp", {}), /inline completion then throw/);
    assert.deepEqual(loader.stats, {
      pending: 0, ready: 0, failed: 0, error: 0, generation: 1,
    });
    assert.equal(loader.residencyStats.count, 0);
    assert.deepEqual(disposals.sort(), ["duplicate", "first"],
      "primary and duplicate inline handles are each disposed exactly once when no base returns");
  });
});

test("R2.4 a reentrant clear makes the eventual returned cached handle inert", () => {
  let loader;
  let disposals = 0;
  withTextureLoader(function (_url, onLoad) {
    const texture = rgbaTexture();
    texture.addEventListener("dispose", () => { disposals++; });
    onLoad?.(texture);
    loader.clear();
    return texture;
  }, () => {
    loader = new ModelTextureLoader({ cache: true });
    assert.throws(() => loader.acquire("cleared-inline.blp", {}), /lost the request/);
    assert.equal(disposals, 1);
    assert.equal(loader.residencyStats.count, 0);
    assert.deepEqual(loader.stats, {
      pending: 0, ready: 0, failed: 0, error: 0, generation: 2,
    });
  });
});

test("R2.4 stale cached return cleanup drains callback handles after a throwing dispose listener", () => {
  let loader;
  const disposed = [];
  withTextureLoader(function (_url, onLoad) {
    const returned = rgbaTexture();
    const primary = rgbaTexture();
    const duplicate = rgbaTexture();
    returned.addEventListener("dispose", () => {
      disposed.push("returned");
      throw new Error("returned dispose threw");
    });
    primary.addEventListener("dispose", () => disposed.push("primary"));
    duplicate.addEventListener("dispose", () => disposed.push("duplicate"));
    onLoad?.(primary);
    onLoad?.(duplicate);
    loader.clear();
    return returned;
  }, () => {
    loader = new ModelTextureLoader({ cache: true });
    assert.throws(() => loader.acquire("stale-drain.blp", {}), /lost the request/);
    assert.deepEqual(disposed, ["returned", "primary", "duplicate"]);
    assert.deepEqual(loader.stats, {
      pending: 0, ready: 0, failed: 0, error: 0, generation: 2,
    });
  });
});

test("R2.4 duplicate synchronous terminal callbacks never dispose the returned cached base early", () => {
  const cases = [
    {
      name: "error then load",
      complete(texture, onLoad, onError) {
        onError?.(new Error("first terminal callback"));
        onLoad?.(texture);
      },
    },
    {
      name: "load then error",
      complete(texture, onLoad, onError) {
        onLoad?.(texture);
        onError?.(new Error("duplicate terminal callback"));
      },
    },
    {
      name: "double load",
      complete(texture, onLoad) {
        onLoad?.(texture);
        onLoad?.(texture);
      },
    },
  ];

  for (const scenario of cases) {
    withTextureLoader(function (_url, onLoad, _progress, onError) {
      const texture = rgbaTexture();
      scenario.complete(texture, onLoad, onError);
      return texture;
    }, () => {
      const loader = new ModelTextureLoader({
        cache: true, limits: { count: 0, knownLogicalTextureBytes: 1024 },
      });
      const lease = loader.acquire(`${scenario.name}.blp`, scenario.name);
      let disposals = 0;
      lease.texture.addEventListener("dispose", () => { disposals++; });
      assert.equal(disposals, 0, `${scenario.name}: the pinned returned base remains live`);
      lease.release();
      loader.evictUnleased();
      assert.equal(disposals, 1, `${scenario.name}: eviction disposes the base exactly once`);
    });
  }
});

for (const timing of ["inline", "async"]) {
  test(`R2.4 ${timing} distinct success handle is rejected and disposed without publishing an empty base`, () => {
    let complete;
    let returnedDisposals = 0;
    let callbackDisposals = 0;
    withTextureLoader(function (_url, onLoad) {
      const returned = rgbaTexture();
      const delivered = rgbaTexture();
      returned.addEventListener("dispose", () => { returnedDisposals++; });
      delivered.addEventListener("dispose", () => { callbackDisposals++; });
      complete = () => onLoad?.(delivered);
      if (timing === "inline") complete();
      return returned;
    }, () => {
      const loader = new ModelTextureLoader({ cache: true });
      const lease = loader.acquire(`distinct-${timing}.blp`, timing);
      if (timing === "async") complete();

      assert.equal(loader.status(lease.texture), "failed");
      assert.deepEqual(loader.stats, {
        pending: 0, ready: 0, failed: 1, error: 1, generation: 1,
      });
      assert.equal(callbackDisposals, 1, "the callback-only handle has no surviving owner");
      assert.equal(returnedDisposals, 0, "the leased returned identity stays live until release");
      lease.release();
      loader.clear();
      assert.equal(returnedDisposals, 1);
    });
  });
}

function batch(overrides = {}) {
  return {
    submesh: 0, blendMode: 0, materialFlags: 0, priorityPlane: 0, materialLayer: 0,
    textures: [0], uvSets: [0], shaderId: 0, colorIndex: 0xffff, textureWeight: -1,
    textureTransform: -1, ...overrides,
  };
}

function privateCloneModel() {
  const still3 = { interpolation: 0, globalSequence: -1, components: 3, tracks: [] };
  return {
    positions: new Float32Array(9), normals: new Float32Array(9),
    uv0: new Float32Array(6), uv1: Float32Array.from([0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0, 1, 2]),
    submeshes: [{ geosetId: 0, indexStart: 0, indexCount: 3 }],
    batches: [batch({ textures: [0, 1], uvSets: [0, 1], textureTransform: 0 })],
    textures: [
      { type: 0, flags: 0, path: "Spells\\Base.blp" },
      { type: 0, flags: 0, path: "Spells\\Layer.blp" },
    ],
    attachments: [], bounds: { min: [0, 0, 0], max: [1, 1, 1], radius: 1 },
    globalSequences: new Uint32Array(0), particleEmitters: [], ribbonEmitters: [],
    colours: [], textureWeights: [],
    textureTransforms: [{
      translation: still3,
      rotation: { interpolation: 0, globalSequence: -1, components: 4, tracks: [] },
      scaling: still3,
    }],
  };
}

test("R2.4 borrowed spell bases stay shared while transform and second-layer clones stay owned", () => {
  const base = new THREE.Texture();
  const layer = new THREE.Texture();
  let baseClones = 0;
  let layerClones = 0;
  base.clone = function () {
    baseClones++;
    return THREE.Texture.prototype.clone.call(this);
  };
  layer.clone = function () {
    layerClones++;
    return THREE.Texture.prototype.clone.call(this);
  };
  const built = buildModel(privateCloneModel(), {
    modelPath: "Spells\\Private.m2",
    baseUrl: "http://cache.test",
    loadTexture: (url) => url.includes("Base") ? base : layer,
    borrowLoadedTextures: true,
    privateLoadedTextureViews: true,
    geosets: EVERY_GEOSET,
  });
  const material = built.materials[0];
  assert.notStrictEqual(material.map, base);
  assert.notStrictEqual(material.alphaMap, layer);
  assert.deepEqual(new Set(built.ownedTextures), new Set([material.map, material.alphaMap]));
  assert.ok(!built.ownedTextures.includes(base));
  assert.ok(!built.ownedTextures.includes(layer));
  assert.deepEqual([baseClones, layerClones], [1, 1],
    "transform and second-layer paths do not create a leaked intermediate clone");

  const disposed = new Map([[base, 0], [layer, 0], [material.map, 0], [material.alphaMap, 0]]);
  for (const texture of disposed.keys()) {
    texture.addEventListener("dispose", () => disposed.set(texture, disposed.get(texture) + 1));
  }
  for (const texture of new Set(built.ownedTextures)) texture.dispose();
  assert.equal(disposed.get(material.map), 1);
  assert.equal(disposed.get(material.alphaMap), 1);
  assert.equal(disposed.get(base), 0);
  assert.equal(disposed.get(layer), 0);
});

test("R2.4 one spell URL with two authored flag sets gets independent private sampling views", () => {
  const base = new THREE.Texture();
  const model = {
    ...privateCloneModel(),
    positions: new Float32Array(18), normals: new Float32Array(18),
    uv0: new Float32Array(12), uv1: new Float32Array(12),
    indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
    submeshes: [
      { geosetId: 0, indexStart: 0, indexCount: 3 },
      { geosetId: 0, indexStart: 3, indexCount: 3 },
    ],
    batches: [batch({ textures: [0] }), batch({ submesh: 1, textures: [1] })],
    textures: [
      { type: 0, flags: 0, path: "Spells\\Alias.blp" },
      { type: 0, flags: 3, path: "Spells\\Alias.blp" },
    ],
    textureTransforms: [],
  };
  const built = buildModel(model, {
    modelPath: "Spells\\Alias.m2",
    baseUrl: "http://cache.test",
    loadTexture: () => base,
    borrowLoadedTextures: true,
    privateLoadedTextureViews: true,
    geosets: EVERY_GEOSET,
    anisotropy: 8,
  });
  const [clamped, repeated] = built.materials.map((material) => material.map);
  assert.notStrictEqual(clamped, repeated);
  assert.strictEqual(clamped.source, base.source);
  assert.strictEqual(repeated.source, base.source);
  assert.equal(clamped.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(clamped.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(repeated.wrapS, THREE.RepeatWrapping);
  assert.equal(repeated.wrapT, THREE.RepeatWrapping);
  assert.equal(base.flipY, true, "canonical base sampling is never mutated by a mesh");
  assert.equal(base.anisotropy, 1);
  assert.deepEqual(new Set(built.ownedTextures), new Set([clamped, repeated]));
});

test("R2.4 a pending canonical base publishes completion through every private Source view", () => {
  const requests = [];
  withTextureLoader(function (_url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    requests.push({ texture, onLoad, onError });
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({ cache: true });
    const lease = loader.acquire("pending-view.blp", {});
    const built = buildModel({
      ...privateCloneModel(), batches: [batch()], textureTransforms: [],
    }, {
      modelPath: "Spells\\Pending.m2",
      baseUrl: "http://cache.test",
      loadTexture: () => lease.texture,
      borrowLoadedTextures: true,
      privateLoadedTextureViews: true,
      geosets: EVERY_GEOSET,
    });
    const view = built.materials[0].map;
    const sourceVersion = view.source.version;
    lease.texture.image = { data: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 };
    requests[0].onLoad?.(lease.texture);
    assert.strictEqual(view.source, lease.texture.source);
    assert.strictEqual(view.image, lease.texture.image);
    assert.ok(view.source.version > sourceVersion);
    assert.equal(view.isDataTexture, true);
    view.dispose();
    lease.release();
    loader.clear();
  });
});

test("R2.4 a pending private view uploads nothing until its canonical resolves", () => {
  const requests = [];
  withTextureLoader(function (_url, onLoad, _progress, onError) {
    const texture = new THREE.Texture();
    requests.push({ texture, onLoad, onError });
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({ cache: true });
    const lease = loader.acquire("pending-view-version.blp", {});
    const built = buildModel({
      ...privateCloneModel(), batches: [batch()], textureTransforms: [],
    }, {
      modelPath: "Spells\\PendingVersion.m2",
      baseUrl: "http://cache.test",
      loadTexture: () => lease.texture,
      borrowLoadedTextures: true,
      privateLoadedTextureViews: true,
      geosets: EVERY_GEOSET,
    });
    const view = built.materials[0].map;
    assert.equal(view.version, 0,
      "an imageless view must not be marked for upload: three warns once per view per draw");
    lease.texture.image = { data: new Uint8Array([5, 6, 7, 8]), width: 1, height: 1 };
    requests[0].onLoad?.(lease.texture);
    assert.ok(view.version > 0,
      "completion publishes the parked view together with its canonical");
    assert.strictEqual(view.image, lease.texture.image);
    view.dispose();
    lease.release();
    loader.clear();
  });
});

function effectEmitter() {
  const blankTrack = { interpolation: 0, globalSequence: -1, components: 1, tracks: [] };
  const blankRamp = (components) => ({
    components, times: new Float32Array(0), values: new Float32Array(0),
  });
  return {
    id: 1, flags: 0, position: [0, 0, 0], bone: 0, texture: 0, blendType: 4,
    emitterType: 1, particleType: 0, headTail: 0, particleColorIndex: 0,
    textureTileRotation: 0, textureRows: 1, textureColumns: 1, lifespanVary: 0,
    emissionRateVary: 0, scaleVary: [0, 0], tailLength: 0, twinkleSpeed: 0,
    twinklePercent: 0, twinkleScaleMin: 0, twinkleScaleMax: 0, burstMultiplier: 0,
    drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0,
    followSpeed2: 0, followScale2: 0, splinePoints: new Float32Array(0),
    emissionSpeed: blankTrack, speedVariation: blankTrack, verticalRange: blankTrack,
    horizontalRange: blankTrack, gravity: blankTrack, lifespan: blankTrack,
    emissionRate: blankTrack, emissionAreaLength: blankTrack, emissionAreaWidth: blankTrack,
    zSource: blankTrack, enabledIn: blankTrack,
    color: blankRamp(3), opacity: blankRamp(1), scale: blankRamp(2),
    headCell: blankRamp(1), tailCell: blankRamp(1),
  };
}

test("R2.4 mesh and emitter isolate Texture state while sharing one leased Source", () => {
  let requests = 0;
  withTextureLoader(function (_url, onLoad) {
    requests++;
    const texture = new THREE.Texture();
    texture.image = { data: new Uint8Array([1, 2, 3, 4]), width: 1, height: 1 };
    onLoad?.(texture);
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({
      cache: true, limits: { count: 0, knownLogicalTextureBytes: 1024 },
    });
    const lease = loader.acquire("mesh-emitter.blp", {});
    const model = {
      ...privateCloneModel(),
      batches: [batch()],
      textures: [{ type: 0, flags: 3, path: "Spells\\Shared.blp" }],
      textureTransforms: [],
      particleEmitters: [effectEmitter()],
    };
    const built = buildModel(model, {
      modelPath: "Spells\\Shared.m2",
      baseUrl: "http://cache.test",
      loadTexture: () => lease.texture,
      borrowLoadedTextures: true,
      privateLoadedTextureViews: true,
      geosets: EVERY_GEOSET,
    });
    const effects = buildModelEffects(model, {
      baseUrl: "http://cache.test",
      loadTexture: () => lease.texture,
      privateTextureViews: true,
    });
    assert.ok(effects);
    const meshView = built.materials[0].map;
    const emitterView = effects.emitters[0].material.map;
    assert.notStrictEqual(meshView, emitterView);
    assert.strictEqual(meshView.source, lease.texture.source);
    assert.strictEqual(emitterView.source, lease.texture.source);
    assert.equal(meshView.wrapS, THREE.RepeatWrapping);
    assert.equal(emitterView.wrapS, THREE.ClampToEdgeWrapping);
    assert.equal(lease.texture.flipY, true, "canonical base remains an immutable request handle");
    assert.equal(requests, 1);
    assert.equal(effects.textures.length, 1, "effect-local path dedup retains one private view");
    assert.equal(effects.disposeTextures, true);

    const order = [];
    emitterView.addEventListener("dispose", () => order.push("effect-view"));
    meshView.addEventListener("dispose", () => order.push("mesh-view"));
    lease.texture.addEventListener("dispose", () => order.push("base"));
    disposeModelEffects(effects);
    for (const texture of new Set(built.ownedTextures)) texture.dispose();
    lease.release();
    loader.evictUnleased();
    assert.deepEqual(order, ["effect-view", "mesh-view", "base"],
      "all private borrowers dispose before the exact base lease can be evicted");
  });
});

test("R2.4 ordinary build ownership remains historical while spell production uses exact pins", async () => {
  const ordinaryBase = new THREE.Texture();
  const ordinary = buildModel({
    ...privateCloneModel(),
    batches: [batch()],
    textureTransforms: [],
  }, {
    modelPath: "Creature\\Ordinary.m2",
    baseUrl: "http://cache.test",
    loadTexture: () => ordinaryBase,
    geosets: EVERY_GEOSET,
  });
  assert.deepEqual(ordinary.ownedTextures, [ordinaryBase]);

  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /#acquireSpellTexture\(visual: RenderedVisual, url: string\)[\s\S]*textureLeases\.get\(url\)[\s\S]*#spellTextures\.acquire\(url, visual\)/);
  assert.match(source, /#spellAssetState\(visual: RenderedVisual\)[\s\S]*#acquireSpellTexture\(visual,/);
  assert.match(source, /buildModel\(model\.wvm,[\s\S]*borrowLoadedTextures: true[\s\S]*privateLoadedTextureViews: true/);
  assert.match(source, /buildModelEffects\(entry\.wvm,[\s\S]*#acquireSpellTexture\(entry\.spell, url\)[\s\S]*privateTextureViews: true/);
  assert.match(source, /#updateEffects\([\s\S]*#spellTextures\.evictUnleased\(\);[\s\S]*#renderer\.render\(this\.#scene/);
  assert.match(source, /#disposeRenderedVisual\(visual: RenderedVisual\)[\s\S]*built\.ownedTextures[\s\S]*lease\.release\(\)/,
    "private clones are disposed before cached-base release");
  assert.match(source, /clearSpellVisuals\(\): void[\s\S]*#dropEffects\(visual\.key\);\s*this\.#disposeRenderedVisual\(visual\);/,
    "effect borrowers detach before visual leases release");
  const clear = source.slice(source.indexOf("  clearWorldResources(): void {"), source.indexOf("\n  dispose(): void {"));
  assert.ok(clear.indexOf("this.clearSpellVisuals();") < clear.indexOf("this.#spellTextures.clear();"));
  assert.match(source, /#spellTextures\.visitRetainedResources\(visitor\)/);
});

test("world model URL deduplication shares pixels and preserves private wrap, UV and transform state", () => {
  const loads = [];
  const model = {
    ...privateCloneModel(),
    textures: [
      { type: 0, flags: 0, path: "Creature\\Same.blp" },
      { type: 0, flags: 3, path: "Creature\\Same.blp" },
    ],
    batches: [
      batch({ textures: [0, 1], uvSets: [0, 1], textureTransform: 0 }),
      batch({ textures: [1] }), batch({ textures: [0] }),
    ],
  };
  const built = buildModel(model, {
    modelPath: "Creature\\Shared.m2", baseUrl: "http://cache.test", geosets: EVERY_GEOSET,
    deduplicateLoadedTextures: true,
    loadTexture: (url) => { const texture = new THREE.Texture(); loads.push({ url, texture }); return texture; },
  });
  const [first, repeated, last] = built.materials;
  assert.equal(loads.length, 1, "primary maps and the second layer share one request per build");
  const views = [first.map, first.alphaMap, repeated.map, last.map];
  assert.equal(new Set(views).size, 4, "each map keeps its own Texture properties");
  for (const view of views) assert.strictEqual(view.source, loads[0].texture.source);
  assert.deepEqual(views.map(t => t.wrapS), [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping,
    THREE.RepeatWrapping, THREE.ClampToEdgeWrapping]);
  assert.deepEqual(views.map(t => t.channel), [0, 1, 0, 0]);
  first.map.offset.x = 0.25;
  for (const view of views.slice(1)) assert.equal(view.offset.x, 0);
  assert.deepEqual(new Set(built.ownedTextures), new Set([loads[0].texture, ...views]),
    "both the uncached source and every material view have a disposal owner");
  const disposed = new Map(built.ownedTextures.map(t => [t, 0]));
  for (const texture of disposed.keys()) texture.addEventListener("dispose", () => disposed.set(texture, disposed.get(texture) + 1));
  built.geometry.dispose();
  for (const material of built.materials) material.dispose();
  for (const texture of new Set(built.ownedTextures)) texture.dispose();
  assert.ok([...disposed.values()].every(n => n === 1));
});

for (const outcome of ["ready", "failed"]) {
  test(`world deduplicated texture views receive asynchronous ${outcome} completion together`, () => {
    const requests = [];
    withTextureLoader(function (_url, onLoad, _progress, onError) {
      const texture = new THREE.Texture();
      requests.push({ texture, onLoad, onError });
      return texture;
    }, () => {
      const loader = new ModelTextureLoader();
      const built = buildModel({ ...privateCloneModel(), batches: [batch(), batch(), batch()], textureTransforms: [] }, {
        modelPath: "Creature\\Pending.m2", baseUrl: "http://cache.test", geosets: EVERY_GEOSET,
        loadTexture: url => loader.load(url), deduplicateLoadedTextures: true,
      });
      assert.equal(requests.length, 1);
      const views = built.materials.map(m => m.map);
      assert.ok(views.every(t => t.version === 0));
      const { texture, onLoad, onError } = requests[0];
      if (outcome === "ready") {
        texture.image = { data: new Uint8Array([1, 2, 3, 255]), width: 1, height: 1 };
        onLoad(texture);
      } else onError(new Error("texture unavailable"));
      assert.equal(loader.status(texture), outcome);
      for (const view of views) {
        assert.strictEqual(view.image, texture.image);
        assert.equal(view.isDataTexture, true);
        assert.ok(view.version > 0);
      }
      built.geometry.dispose();
      built.materials.forEach(m => m.dispose());
      new Set(built.ownedTextures).forEach(t => t.dispose());
    });
  });
}

test("model URL deduplication stays local and does not own directly supplied or borrowed textures", () => {
  const supplied = new THREE.Texture(), loaded = [];
  const model = { ...privateCloneModel(), textures: [
    { type: 0, flags: 0, path: "Creature\\Shared.blp" }, { type: 1, flags: 0, path: "" },
  ], batches: [batch(), batch(), batch({ textures: [1] })], textureTransforms: [] };
  const options = { modelPath: "Creature\\Shared.m2", baseUrl: "http://cache.test", geosets: EVERY_GEOSET,
    deduplicateLoadedTextures: true, slotTextures: new Map([[1, supplied]]),
    loadTexture: () => { const texture = new THREE.Texture(); loaded.push(texture); return texture; } };
  const a = buildModel(model, options), b = buildModel(model, options);
  assert.equal(loaded.length, 2, "there is no unbounded global URL cache");
  assert.notStrictEqual(a.materials[0].map.source, b.materials[0].map.source);
  for (const built of [a, b]) {
    assert.ok(!built.ownedTextures.includes(supplied));
    assert.strictEqual(built.materials[2].map, supplied);
  }
  const cached = new THREE.Texture();
  const borrowed = buildModel(model, { ...options, borrowLoadedTextures: true, loadTexture: () => cached });
  assert.ok(!borrowed.ownedTextures.includes(cached));
  assert.ok(!borrowed.ownedTextures.includes(supplied));
  assert.equal(borrowed.ownedTextures.length, 2);
  for (const built of [a, b, borrowed]) {
    built.geometry.dispose(); built.materials.forEach(m => m.dispose());
    new Set(built.ownedTextures).forEach(t => t.dispose());
  }
  cached.dispose(); supplied.dispose();
});

test("P1-11: revision moves on acquire, release, settle, eviction and clear, never on touch or stats", () => {
  const requests = [];
  withTextureLoader(function (_url, onLoad, _progress, onError) {
    const texture = rgbaTexture();
    requests.push({ texture, onLoad, onError });
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({ cache: true, limits: { count: 1, knownLogicalTextureBytes: 1024 } });
    let revision = loader.revision;
    const moved = (what) => {
      assert.ok(loader.revision > revision, `${what} moves the revision`);
      revision = loader.revision;
    };
    const still = (what) => assert.equal(loader.revision, revision, `${what} leaves the revision`);

    const a = loader.acquire("a.blp", "owner-a");
    moved("acquire of a new URL");
    assert.equal(loader.leaseStatus(a), "pending");
    const again = loader.acquire("a.blp", "owner-again");
    moved("a second lease on the same request");
    assert.equal(loader.touch(a), true);
    still("touch");
    void loader.stats;
    void loader.residencyStats;
    void loader.pressureSnapshot();
    void loader.overflowCount;
    still("reading stats, residency, pressure and overflow");
    requests[0].onLoad(a.texture);
    moved("settlement");
    assert.equal(loader.leaseStatus(a), "ready");
    again.release();
    moved("release");
    again.release();
    still("a repeated release");
    assert.equal(loader.owns(again), false, "a released lease is not owned");
    assert.equal(loader.leaseStatus(again), undefined);

    const b = loader.acquire("b.blp", "owner-b");
    moved("acquire of b");
    requests[1].onError();
    moved("failure");
    assert.equal(loader.leaseStatus(b), "failed");
    a.release();
    moved("release of a");
    assert.deepEqual(loader.residencyStats.overflowCount, loader.overflowCount);
    assert.equal(loader.overflowCount, 1);
    assert.deepEqual(loader.evictUnleased(), ["a.blp"]);
    moved("eviction");
    assert.deepEqual(loader.evictUnleased(), []);
    still("an eviction pass with nothing to do");
    assert.equal(loader.owns(b), true);
    loader.clear();
    moved("clear");
    assert.equal(loader.owns(b), false, "a lease from before clear is stale");
    assert.equal(loader.touch(b), false);
    assert.equal(loader.leaseStatus(b), undefined);

    // A replacement request for the same URL: the old lease is stale even though the URL is cached.
    const fresh = loader.acquire("b.blp", "owner-fresh");
    assert.equal(loader.owns(fresh), true);
    assert.equal(loader.owns(b), false);
    assert.equal(loader.leaseStatus(fresh), "pending");
  });
});

test("P1-11: the numeric overflow getters equal the residency stats fields", () => {
  const sizes = new Map([["unknown.blp", undefined], ["a.blp", [2, 1]], ["b.blp", [2, 2]], ["c.blp", [1, 1]]]);
  withTextureLoader(function (url, onLoad) {
    const size = sizes.get(url);
    const texture = size ? rgbaTexture(...size) : new THREE.Texture();
    onLoad?.(texture);
    return texture;
  }, () => {
    const loader = new ModelTextureLoader({ cache: true, limits: { count: 2, knownLogicalTextureBytes: 12 } });
    const leases = [];
    const check = () => {
      const stats = loader.residencyStats;
      assert.equal(loader.overflowCount, stats.overflowCount);
      assert.equal(loader.overflowKnownLogicalTextureBytes, stats.overflowKnownLogicalTextureBytes);
    };
    check();
    for (const url of sizes.keys()) {
      leases.push(loader.acquire(url, url));
      check();
    }
    assert.ok(loader.overflowCount > 0 && loader.overflowKnownLogicalTextureBytes > 0);
    for (const lease of leases) {
      lease.release();
      loader.evictUnleased();
      check();
    }
    loader.clear();
    check();
  });
});
