import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { buildSkinnedTemplate } from "../dist/code/browser/AnimatedModel.js";
import { BuiltModelCache } from "../dist/code/browser/BuiltModelCache.js";
import { ModelTextureLoader } from "../dist/code/browser/TextureLoad.js";
import { WorldMaterialCache } from "../dist/code/browser/WorldMaterialCache.js";
import {
  LEGACY_GEOMETRY_CACHE_COUNT_LIMIT,
  LEGACY_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
  collectLegacyResourcePins,
  legacyDecodedModelReplaced,
  legacyGeometryCacheKey,
  legacyRunMaterialCacheKey,
} from "../dist/code/browser/WorldRenderer3D.js";

function geometry() {
  const value = new THREE.BufferGeometry();
  value.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  value.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(9), 3));
  value.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(6), 2));
  value.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  return value;
}

function geometryEntry(cacheKey, domain = "static", value = geometry(), template) {
  return Object.freeze({
    cacheKey,
    epoch: 1,
    domain,
    geometry: value,
    ...(template ? { template } : {}),
  });
}

function materialSpec(key, kind, textureUrl) {
  return {
    key,
    kind,
    ...(textureUrl ? { textureUrl } : {}),
    createMaterial(texture) {
      return new THREE.MeshBasicMaterial({ ...(texture ? { map: texture } : {}) });
    },
  };
}

function legacyRig(groups) {
  return {
    vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1],
    indices: [0, 1, 2],
    uvs: [0, 0, 1, 0, 0, 1],
    textureUrls: ["zero.blp", "one.blp", "two.blp", "three.blp", "four.blp", "five.blp"],
    groups,
    visual: true,
    skeleton: {
      parents: Int16Array.from([-1]),
      pivots: Float32Array.from([0, 0, 0]),
      skinIndices: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      skinWeights: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
      clips: [{
        animationId: 0,
        duration: 1,
        looping: true,
        channels: [{
          bone: 0,
          kind: 0,
          times: Float32Array.from([0]),
          values: Float32Array.from([0, 0, 0]),
        }],
      }],
    },
  };
}

test("legacy keys separate exact same-path parents and static/skinned ownership domains", () => {
  const parentA = "4|legacy-parent:1";
  const parentB = "4|legacy-parent:2";
  const signature = [0, 5, "/shared/model.blp", 2, 4];
  assert.notEqual(
    legacyRunMaterialCacheKey(parentA, ...signature),
    legacyRunMaterialCacheKey(parentB, ...signature),
    "replacement parents using the same external path cannot alias",
  );
  assert.notEqual(
    legacyGeometryCacheKey(parentA, "static"),
    legacyGeometryCacheKey(parentA, "skinned"),
    "unit skin attributes never alias the converted static geometry",
  );
  assert.notEqual(
    legacyRunMaterialCacheKey(parentA, 0, 5, "/shared/model.blp", 2, 4),
    legacyRunMaterialCacheKey(parentA, 1, 5, "/shared/model.blp", 2, 4),
    "repeated material indexes remain distinct per run ordinal",
  );
});

test("legacy decoded replacement detects same-key re-entry and legacy/WVM transitions", () => {
  const legacyA = { vertices: [], indices: [], visual: true };
  const legacyB = { vertices: [], indices: [], visual: true };
  const wvm = { vertices: [], indices: [], visual: true, wvm: {} };

  assert.equal(legacyDecodedModelReplaced(undefined, false, undefined), false);
  assert.equal(legacyDecodedModelReplaced(undefined, false, wvm), false,
    "an ordinary WVM identity is still governed by its appearance/build key");
  assert.equal(legacyDecodedModelReplaced(undefined, false, legacyA), true,
    "a WVM/stand-in to legacy transition invalidates the old body");
  assert.equal(legacyDecodedModelReplaced(legacyA, true, legacyA), false);
  assert.equal(legacyDecodedModelReplaced(legacyA, true, legacyB), true,
    "the same logical path re-decoded as a new legacy parent must rebuild");
  assert.equal(legacyDecodedModelReplaced(legacyA, true, wvm), true,
    "a retained legacy body must yield when the path becomes WVM");
});

test("legacy geometry plateaus at the explicit caps and re-entry owns a fresh geometry", () => {
  assert.deepEqual([
    LEGACY_GEOMETRY_CACHE_COUNT_LIMIT,
    LEGACY_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
  ], [256, 64 * 1024 * 1024]);
  const cache = new BuiltModelCache({
    count: LEGACY_GEOMETRY_CACHE_COUNT_LIMIT,
    knownBufferBytes: LEGACY_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
  });
  let disposals = 0;
  const first = geometryEntry("first");
  first.geometry.addEventListener("dispose", () => { disposals++; });
  cache.set(first.cacheKey, first);
  for (let index = 1; index < 300; index++) {
    const entry = geometryEntry(`entry-${index}`);
    entry.geometry.addEventListener("dispose", () => { disposals++; });
    cache.set(entry.cacheKey, entry);
    for (const { built } of cache.evictUnpinned(new Set())) built.geometry.dispose();
  }
  assert.equal(cache.stats.count, LEGACY_GEOMETRY_CACHE_COUNT_LIMIT);
  assert.equal(cache.stats.overflowCount, 0);
  assert.equal(disposals, 300 - LEGACY_GEOMETRY_CACHE_COUNT_LIMIT);

  const rebuilt = geometryEntry("first");
  assert.notStrictEqual(rebuilt.geometry, first.geometry);
  cache.set(rebuilt.cacheKey, rebuilt);
  for (const { built } of cache.evictUnpinned(new Set())) built.geometry.dispose();
  assert.strictEqual(cache.get("first"), rebuilt);
});

test("environment, dormant game object, unit fallback, and sky all contribute exact pins", () => {
  const staticGeometry = geometryEntry("static");
  const unitGeometry = geometryEntry("skinned", "skinned");
  const skyGeometry = geometryEntry("sky");
  const envMaterial = Object.freeze({ key: "env", kind: "legacy-run", material: new THREE.MeshBasicMaterial() });
  const gameMaterial = Object.freeze({ key: "game", kind: "legacy-run", material: new THREE.MeshBasicMaterial() });
  const unitMaterial = Object.freeze({ key: "unit", kind: "legacy-run", material: new THREE.MeshBasicMaterial() });
  const skyMaterial = Object.freeze({ key: "sky", kind: "legacy-run", material: new THREE.MeshBasicMaterial() });
  const borrowers = [
    { legacyGeometry: staticGeometry, materialEntries: [envMaterial] },
    { legacyGeometry: staticGeometry, materialEntries: [gameMaterial], hidden: true },
    { legacyGeometry: unitGeometry, materialEntries: [unitMaterial] },
    { legacyGeometry: skyGeometry, materialEntries: [skyMaterial] },
  ];
  const geometryPins = new Set();
  const materialPins = new Set();
  assert.equal(collectLegacyResourcePins(borrowers, geometryPins, materialPins), 4);
  assert.deepEqual(geometryPins, new Set([staticGeometry, unitGeometry, skyGeometry]));
  assert.deepEqual(materialPins, new Set([envMaterial, gameMaterial, unitMaterial, skyMaterial]));
});

test("WMO and legacy materials share one URL base while a sky clone pin keeps it alive", () => {
  const originalLoad = THREE.TextureLoader.prototype.load;
  let requests = 0;
  THREE.TextureLoader.prototype.load = function (_url, onLoad) {
    requests++;
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    onLoad?.(texture);
    return texture;
  };
  const textures = new ModelTextureLoader({ cache: true });
  const cache = new WorldMaterialCache(textures, { limits: { count: 2 } });
  try {
    const legacy = cache.getOrCreate(materialSpec("legacy", "legacy-run", "shared.blp"));
    const wmo = cache.getOrCreate(materialSpec("wmo", "wmo-run", "shared.blp"));
    assert.strictEqual(legacy.material.map, wmo.material.map);
    assert.equal(requests, 1);

    const clone = legacy.material.clone();
    assert.strictEqual(clone.map, legacy.material.map, "the private sky view still samples the canonical base");
    let baseDisposals = 0;
    legacy.material.map.addEventListener("dispose", () => { baseDisposals++; });
    const pressure = cache.getOrCreate(materialSpec("pressure", "legacy-run"));
    const geometryPins = new Set();
    const materialPins = new Set();
    collectLegacyResourcePins([{
      legacyGeometry: geometryEntry("sky"),
      materialEntries: [legacy],
    }], geometryPins, materialPins);
    assert.deepEqual(cache.commitPins(materialPins), ["wmo"]);
    assert.strictEqual(cache.get("legacy"), legacy);
    assert.equal(baseDisposals, 0, "a retained sky clone borrower keeps its base lease alive");
    assert.deepEqual({
      combined: cache.entryCount(),
      wmo: cache.entryCount("wmo-run"),
      legacy: cache.entryCount("legacy-run"),
    }, { combined: 2, wmo: 0, legacy: 2 });
    assert.strictEqual(cache.get("pressure"), pressure);
    clone.dispose();
  } finally {
    cache.dispose();
    THREE.TextureLoader.prototype.load = originalLoad;
  }
});

test("legacy unit template geometry is evicted and disposed exactly once after its borrower leaves", () => {
  const cache = new BuiltModelCache({ count: 1, knownBufferBytes: 1024 * 1024 });
  const template = buildSkinnedTemplate(legacyRig([{ start: 0, count: 3, material: 0 }]));
  assert.ok(template);
  const unit = geometryEntry("unit", "skinned", template.geometry, template);
  let disposals = 0;
  unit.geometry.addEventListener("dispose", () => { disposals++; });
  cache.set(unit.cacheKey, unit);
  const pressure = geometryEntry("pressure");
  cache.set(pressure.cacheKey, pressure);
  assert.deepEqual(cache.evictUnpinned(new Set([unit])).map(({ built }) => built), [pressure]);
  pressure.geometry.dispose();

  const next = geometryEntry("next");
  cache.set(next.cacheKey, next);
  const evicted = cache.evictUnpinned(new Set());
  assert.deepEqual(evicted.map(({ built }) => built), [unit]);
  for (const { built } of evicted) built.geometry.dispose();
  assert.equal(disposals, 1);
  assert.equal(cache.delete("unit"), false, "the dead owner cannot dispose the same geometry again");
});

test("legacy skinned groups address per-run material arrays by ordinal", () => {
  const template = buildSkinnedTemplate(legacyRig([
    { start: 0, count: 3, material: 5 },
    { start: 0, count: 3, material: 2 },
    { start: 0, count: 3, material: 5 },
  ]));
  assert.ok(template);
  assert.deepEqual(template.geometry.groups.map(({ materialIndex }) => materialIndex), [0, 1, 2]);
});

test("failed legacy template construction releases its geometry and is weakly tombstoned", async () => {
  const originalDispose = THREE.BufferGeometry.prototype.dispose;
  let disposals = 0;
  THREE.BufferGeometry.prototype.dispose = function () {
    disposals++;
    return originalDispose.call(this);
  };
  try {
    const malformed = legacyRig([{ start: 0, count: 3, material: 0 }]);
    malformed.skeleton.clips = [{ animationId: 0, duration: 1, looping: true, channels: [] }];
    assert.equal(buildSkinnedTemplate(malformed), undefined);
    assert.equal(disposals, 1);
  } finally {
    THREE.BufferGeometry.prototype.dispose = originalDispose;
  }

  const source = await readFile("src/browser/WorldRenderer3D.ts", "utf8");
  const method = source.slice(
    source.indexOf("  #legacySkinnedGeometry("),
    source.indexOf("\n  /** One exact material", source.indexOf("  #legacySkinnedGeometry(")),
  );
  assert.ok(method.indexOf("this.#legacySkinnedFailures.has(model)")
    < method.indexOf("buildSkinnedTemplate(model)"));
  assert.match(method, /this\.#legacySkinnedFailures\.add\(model\)/);
});

test("renderer wiring unions WMO and legacy pins once and tears borrowers down before owners", async () => {
  const source = await readFile("src/browser/WorldRenderer3D.ts", "utf8");
  assert.doesNotMatch(source, /#geometries\b|#modelMaterials\b|disposeCachedMaterial/);
  const legacyEntry = source.slice(
    source.indexOf("interface LegacyGeometryEntry {"),
    source.indexOf("\n}\n\n/** One placement-local borrower", source.indexOf("interface LegacyGeometryEntry {")),
  );
  assert.doesNotMatch(legacyEntry, /EnvironmentModel|readonly parent/,
    "dormant geometry entries retain only the compact parent token embedded in their key");
  assert.equal(source.match(/this\.#worldMaterials\.commitPins\(/g)?.length, 1,
    "the combined world lane has one post-admission pin commit");

  const eviction = source.slice(
    source.indexOf("  #evictWmoResources(): void {"),
    source.indexOf("\n\n  /**\n   * Soft-caps both built caches"),
  );
  assert.match(eviction, /const wmo = this\.#wmoGroupBorrowers\(\)/);
  assert.match(eviction, /const legacy = this\.#legacyResourceBorrowers\(\)/);
  assert.match(eviction, /this\.#legacyGeometries\.evictUnpinned\(legacy\.geometryPins\)/);
  assert.match(eviction, /for \(const entry of legacy\.materialPins\) materialPins\.add\(entry\)/);

  const clear = source.slice(
    source.indexOf("  clearWorldResources(): void {"),
    source.indexOf("\n  dispose(): void {"),
  );
  const environment = clear.indexOf("this.#disposeEnvironment(rendered)");
  const game = clear.indexOf("this.#disposeGameObject(rendered)");
  const units = clear.indexOf("this.#clearUnitNode(unit)");
  const sky = clear.indexOf("this.#clearSkybox()");
  const materials = clear.indexOf("this.#worldMaterials.dispose()");
  const legacyGeometry = clear.indexOf("for (const entry of this.#legacyGeometries.values())");
  const reset = clear.indexOf("this.#legacyModelKeys = new WeakMap<EnvironmentModel, string>()");
  const freshLane = clear.indexOf("this.#worldMaterialTextures = new ModelTextureLoader", materials);
  assert.ok(environment < units && game < units && units < sky && sky < materials);
  assert.ok(materials < legacyGeometry && legacyGeometry < reset && reset < freshLane);
  assert.match(clear, /this\.#worldMaterialGenerationOffset \+= this\.#worldMaterialTextures\.stats\.generation/);
  assert.match(clear, /this\.#legacySkinnedFailures = new WeakSet<EnvironmentModel>\(\)/);

  assert.equal(source.match(/const replacesLegacy =/g)?.length, 4,
    "environment, game-object, unit, and same-path sky transitions compare exact decoded identity");
  const unitAttach = source.slice(
    source.indexOf("  #drawUnit("),
    source.indexOf("\n  /**\n   * A name for exactly what will be built", source.indexOf("  #drawUnit(")),
  );
  assert.match(unitAttach, /const decodedModel = client\?\.model\(metadata\.model, "critical"\)/);
  assert.match(unitAttach, /legacyDecodedModelReplaced\([\s\S]*unit\.decodedModel[\s\S]*unit\.legacyGeometry/);
  assert.match(unitAttach, /#attachSkinnedModel\(unit, metadata, key, decodedModel\)/);
  assert.match(source, /unit\.decodedModel = model;\s*unit\.legacyGeometry = legacy/);
  assert.match(source,
    /delete unit\.wvm;\s*delete unit\.visual;\s*delete unit\.decodedModel;\s*delete unit\.legacyGeometry/,
    "format replacement cannot retain old WVM attachment, portrait, height, or emitter sources");
  assert.match(source, /materialEntries:\s*this\.#worldMaterials\.entryCount\("wmo-run"\)/);
  assert.match(source,
    /worldTexturesGeneration:\s*this\.#worldTextureGeneration\s*\+\s*this\.#worldMaterialGenerationOffset/);

  const accounting = source.slice(
    source.indexOf("  visitRetainedResources(visitor: RetainedResourceVisitor): void {"),
    source.indexOf("\n  /**\n   * What the last frame cost"),
  );
  assert.match(accounting, /for \(const entry of this\.#legacyGeometries\.values\(\)\)/);
  assert.match(accounting, /if \(entry\.template\) visitSkinnedTemplateResources/);
  assert.match(accounting, /else visitGeometryBuffers\(visitor, entry, entry\.geometry\)/);
});
