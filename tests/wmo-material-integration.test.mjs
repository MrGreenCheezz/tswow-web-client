import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { ResourceAccountingLedger } from "../dist/code/browser/ResourceAccounting.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import { WorldMaterialCache } from "../dist/code/browser/WorldMaterialCache.js";
import {
  WMO_WORLD_TEXTURE_CACHE_COUNT_LIMIT,
  WMO_WORLD_TEXTURE_CACHE_KNOWN_BYTE_LIMIT,
  collectAttachedWmoGroupResourcePins,
  configureWmoCanonicalTexture,
  wmoRunMaterialCacheKey,
} from "../dist/code/browser/WorldRenderer3D.js";

function materialSpec(key, textureUrl) {
  return {
    key,
    kind: "wmo-run",
    ...(textureUrl ? { textureUrl } : {}),
    createMaterial(texture) {
      return new THREE.MeshBasicMaterial({ ...(texture ? { map: texture } : {}) });
    },
  };
}

test("WMO run keys use the exact decoded parent, not a same-name placement", () => {
  const signature = [3, "/textures/shared.blp", 2, 4, true];
  const parentA = "7|wmo-parent:1";
  const parentB = "7|wmo-parent:2";
  const keyA = wmoRunMaterialCacheKey(parentA, ...signature);
  const keyB = wmoRunMaterialCacheKey(parentB, ...signature);

  assert.notEqual(keyA, keyB, "two decoded parents with the same external name stay disjoint");
  assert.equal(wmoRunMaterialCacheKey(parentA, ...signature), keyA,
    "the same parent and exact run signature share one identity");
  assert.match(keyA, /wmo-run/);
  assert.ok(!keyA.includes("SameName.wmo"), "placement/model names are not part of the key");
});

test("distinct WMO parents share one canonical URL request but keep exact material leases", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  let requests = 0;
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    requests++;
    const texture = new THREE.DataTexture(new Uint8Array(8), 2, 1);
    onLoad?.(texture);
    return texture;
  };
  const textures = new ModelTextureLoader({
    cache: true,
    limits: {
      count: WMO_WORLD_TEXTURE_CACHE_COUNT_LIMIT,
      knownLogicalTextureBytes: WMO_WORLD_TEXTURE_CACHE_KNOWN_BYTE_LIMIT,
    },
  });
  const cache = new WorldMaterialCache(textures);
  try {
    const signature = [3, "/textures/shared.blp", 2, 4, true];
    const keyA = wmoRunMaterialCacheKey("7|wmo-parent:1", ...signature);
    const keyB = wmoRunMaterialCacheKey("7|wmo-parent:2", ...signature);
    const a = cache.getOrCreate(materialSpec(keyA, signature[1]));
    const b = cache.getOrCreate(materialSpec(keyB, signature[1]));
    const generation = textures.stats.generation;
    const revision = cache.revision;

    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.material, b.material);
    assert.strictEqual(a.material.map, b.material.map, "both material leases sample one canonical base");
    assert.equal(requests, 1);
    assert.equal(textures.residencyStats.activeLeases, 2);
    assert.strictEqual(cache.getOrCreate(materialSpec(keyA, signature[1])), a);
    cache.commitPins(new Set([a, b]));
    assert.deepEqual([textures.stats.generation, cache.revision], [generation, revision],
      "cache hits, touches, and pin commits do not advance readiness generation");

    const ledger = new ResourceAccountingLedger();
    cache.visitRetainedResources(ledger);
    cache.visitRetainedResources(ledger);
    assert.equal(ledger.snapshot().gpuTextures.uniqueResources, 1,
      "material maps and the dedicated base lane are identity-deduplicated");
  } finally {
    cache.dispose();
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});

test("canonical WMO bases receive the shared sampling policy immediately", () => {
  const texture = new THREE.Texture();
  const before = texture.version;
  configureWmoCanonicalTexture(texture, 16);
  const configured = texture.version;
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(texture.wrapS, THREE.RepeatWrapping);
  assert.equal(texture.wrapT, THREE.RepeatWrapping);
  assert.equal(texture.flipY, false);
  assert.equal(texture.anisotropy, 16);
  assert.ok(configured > before, "the configured canonical base is marked for upload");
  configureWmoCanonicalTexture(texture, 16);
  assert.equal(texture.version, configured,
    "repeating the same canonical policy does not provoke another upload");
});

test("only attached WMO wrappers pin; overflow converges and re-entry uses a fresh material", () => {
  const cache = new WorldMaterialCache(new ModelTextureLoader({ cache: true }), {
    limits: { count: 1 },
  });
  const a = cache.getOrCreate(materialSpec("a"));
  const b = cache.getOrCreate(materialSpec("b"));
  let oldADisposals = 0;
  a.material.addEventListener("dispose", () => { oldADisposals++; });

  const parent = new THREE.Group();
  const geometryA = Object.freeze({ key: "geometry-a" });
  const geometryB = Object.freeze({ key: "geometry-b" });
  const meshA = new THREE.Mesh(new THREE.BufferGeometry(), a.material);
  const meshB = new THREE.Mesh(new THREE.BufferGeometry(), b.material);
  const wrappers = [
    { entry: geometryA, materialEntries: Object.freeze([a, a]), mesh: meshA },
    { entry: geometryB, materialEntries: Object.freeze([b]), mesh: meshB },
  ];
  parent.add(meshA, meshB);

  let geometryPins = new Set();
  let materialPins = new Set();
  assert.equal(collectAttachedWmoGroupResourcePins(
    parent, wrappers, geometryPins, materialPins,
  ), 2);
  assert.deepEqual(geometryPins, new Set([geometryA, geometryB]));
  assert.deepEqual(materialPins, new Set([a, b]), "duplicate per-run refs become exact entry pins");
  assert.deepEqual(cache.commitPins(materialPins), []);
  assert.equal(cache.residencyStats.materials.overflowCount, 1,
    "live wrappers may exceed the material soft cap");

  parent.remove(meshA);
  geometryPins = new Set();
  materialPins = new Set();
  assert.equal(collectAttachedWmoGroupResourcePins(
    parent, wrappers, geometryPins, materialPins,
  ), 1, "a dormant/detached wrapper is no longer a borrower");
  assert.deepEqual(cache.commitPins(materialPins), ["a"]);
  assert.deepEqual([cache.residencyStats.materials.count, oldADisposals], [1, 1]);

  parent.remove(meshB);
  const freshA = cache.getOrCreate(materialSpec("a"));
  assert.notStrictEqual(freshA, a);
  assert.notStrictEqual(freshA.material, a.material);
  const reenteredMesh = new THREE.Mesh(new THREE.BufferGeometry(), freshA.material);
  parent.add(reenteredMesh);
  const reentered = [{
    entry: geometryA,
    materialEntries: Object.freeze([freshA]),
    mesh: reenteredMesh,
  }];
  materialPins = new Set();
  collectAttachedWmoGroupResourcePins(parent, reentered, new Set(), materialPins);
  assert.deepEqual(cache.commitPins(materialPins), ["b"]);
  assert.equal(cache.residencyStats.materials.count, 1);
  assert.strictEqual(cache.get("a"), freshA);
  cache.dispose();
});

test("renderer WMO cache wiring detaches before teardown and replaces the late-callback lane", async () => {
  const source = await readFile("src/browser/WorldRenderer3D.ts", "utf8");
  const clear = source.slice(
    source.indexOf("  clearWorldResources(): void {"),
    source.indexOf("\n  dispose(): void {"),
  );
  const detachEnvironment = clear.indexOf("this.#disposeEnvironment(rendered)");
  const detachGameObjects = clear.indexOf("this.#disposeGameObject(rendered)");
  const disposeCache = clear.indexOf("this.#worldMaterials.dispose()");
  const replaceLoader = clear.indexOf("this.#worldMaterialTextures = new ModelTextureLoader", disposeCache);
  const replaceCache = clear.indexOf("this.#worldMaterials = new WorldMaterialCache", replaceLoader);
  assert.ok(detachEnvironment >= 0 && detachEnvironment < disposeCache);
  assert.ok(detachGameObjects >= 0 && detachGameObjects < disposeCache);
  assert.ok(disposeCache < replaceLoader && replaceLoader < replaceCache);
  assert.equal(clear.match(/this\.#worldMaterials\.dispose\(\)/g)?.length, 1);
  assert.doesNotMatch(source, /#wmoRunMaterials/);

  const runMaterial = source.slice(
    source.indexOf("  #wmoRunMaterial("),
    source.indexOf("\n  #modelNode(", source.indexOf("  #wmoRunMaterial(")),
  );
  assert.match(runMaterial, /this\.#wmoModelKey\(model\)/);
  assert.match(runMaterial, /kind:\s*"wmo-run"/);
  assert.doesNotMatch(runMaterial, /createPrivateView/);
  assert.doesNotMatch(runMaterial, /#loadWorldTexture/);

  assert.match(source,
    /get worldMaterialResidencyStats\(\): Readonly<WorldMaterialResidencyStats>[\s\S]*return this\.#worldMaterials\.residencyStats/);
  assert.match(source,
    /materialEntries:\s*this\.#worldMaterials\.entryCount\("wmo-run"\)/);
  assert.match(source,
    /const materialEntries = Object\.freeze\(\[\.\.\.new Set\(runEntries\)\]\)/);
});

test("a disposed WMO lane makes old completions inert while a fresh lane can reuse the URL", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  const requests = [];
  THREE.TextureLoader.prototype.load = function (url, onLoad, _onProgress, onError) {
    const texture = new THREE.Texture();
    requests.push({ url, texture, onLoad, onError });
    return texture;
  };
  try {
    const oldTextures = new ModelTextureLoader({ cache: true });
    const oldCache = new WorldMaterialCache(oldTextures);
    const oldEntry = oldCache.getOrCreate(materialSpec("old", "shared.blp"));
    let materialDisposals = 0;
    let baseDisposals = 0;
    oldEntry.material.addEventListener("dispose", () => { materialDisposals++; });
    requests[0].texture.addEventListener("dispose", () => { baseDisposals++; });
    oldCache.dispose();

    const freshTextures = new ModelTextureLoader({ cache: true });
    const freshCache = new WorldMaterialCache(freshTextures);
    const freshEntry = freshCache.getOrCreate(materialSpec("fresh", "shared.blp"));
    requests[0].onLoad?.(requests[0].texture);
    requests[0].onError?.(new Error("late old failure"));

    assert.deepEqual([materialDisposals, baseDisposals], [1, 1]);
    assert.equal(oldCache.residencyStats.materials.count, 0);
    assert.equal(oldTextures.stats.pending, 0);
    assert.equal(requests.length, 2, "the next realm owns a fresh request record for the same URL");
    assert.strictEqual(freshCache.get("fresh"), freshEntry);
    freshCache.dispose();
  } finally {
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});
