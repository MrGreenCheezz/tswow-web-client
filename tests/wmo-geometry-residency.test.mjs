import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { BuiltModelCache, knownGeometryBufferBytes } from "../dist/code/browser/BuiltModelCache.js";
import {
  WMO_GROUP_GEOMETRY_CACHE_COUNT_LIMIT,
  WMO_GROUP_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
} from "../dist/code/browser/WorldRenderer3D.js";

function geometry(vertices = 4, indices = new Uint16Array([0, 1, 2, 1, 3, 2])) {
  const value = new THREE.BufferGeometry();
  value.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  value.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  value.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(vertices * 2), 2));
  value.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  value.setIndex(new THREE.BufferAttribute(indices, 1));
  return value;
}

function entry(cacheKey, groupIndex, value = geometry()) {
  return Object.freeze({ cacheKey, epoch: 1, groupIndex, geometry: value });
}

function disposeGeometryEntries(evicted) {
  for (const { built } of evicted) built.geometry.dispose();
}

test("WMO group caps and exact converted buffer bytes are explicit", () => {
  assert.equal(WMO_GROUP_GEOMETRY_CACHE_COUNT_LIMIT, 256);
  assert.equal(WMO_GROUP_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT, 64 * 1024 * 1024);
  const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
  assert.equal(knownGeometryBufferBytes(geometry(4, indices)), 44 * 4 + indices.byteLength);
});

test("WMO group residency plateaus by count and disposes each inactive geometry once", () => {
  const cache = new BuiltModelCache({
    count: WMO_GROUP_GEOMETRY_CACHE_COUNT_LIMIT,
    knownBufferBytes: WMO_GROUP_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT,
  });
  let disposals = 0;
  for (let index = 0; index < 320; index++) {
    const value = entry(`1|parent:${index >> 7}#${index}`, index & 127);
    value.geometry.addEventListener("dispose", () => { disposals++; });
    cache.set(value.cacheKey, value);
    disposeGeometryEntries(cache.evictUnpinned(new Set()));
  }
  assert.equal(cache.stats.count, WMO_GROUP_GEOMETRY_CACHE_COUNT_LIMIT);
  assert.ok(cache.stats.knownBufferBytes <= WMO_GROUP_GEOMETRY_CACHE_KNOWN_BUFFER_BYTE_LIMIT);
  assert.deepEqual(
    [cache.stats.overflowCount, cache.stats.overflowKnownBufferBytes, disposals],
    [0, 0, 320 - WMO_GROUP_GEOMETRY_CACHE_COUNT_LIMIT],
  );
});

test("WMO group byte pressure keeps exact live pins as a visible soft overflow", () => {
  const bytes = knownGeometryBufferBytes(geometry());
  const cache = new BuiltModelCache({ count: 8, knownBufferBytes: bytes });
  const first = entry("first", 0);
  const second = entry("second", 0);
  cache.set(first.cacheKey, first).set(second.cacheKey, second);
  assert.deepEqual(cache.evictUnpinned(new Set([first, second])), []);
  assert.deepEqual(cache.stats, {
    count: 2,
    knownBufferBytes: bytes * 2,
    overflowCount: 0,
    overflowKnownBufferBytes: bytes,
  });
  disposeGeometryEntries(cache.evictUnpinned(new Set([second])));
  assert.deepEqual(cache.stats, {
    count: 1,
    knownBufferBytes: bytes,
    overflowCount: 0,
    overflowKnownBufferBytes: 0,
  });
});

test("two placements share one exact WMO entry until the last wrapper detaches", () => {
  const cache = new BuiltModelCache({ count: 1, knownBufferBytes: 1024 });
  const shared = entry("1|parent:1#0", 0);
  const material = new THREE.MeshBasicMaterial();
  const first = new THREE.Mesh(shared.geometry, material);
  const second = new THREE.Mesh(shared.geometry, material);
  cache.set(shared.cacheKey, shared);

  assert.notEqual(first, second);
  assert.equal(first.geometry, second.geometry);
  assert.equal(first.material, second.material);

  const pressure = entry("1|parent:2#0", 0);
  cache.set(pressure.cacheKey, pressure);
  let materialDisposals = 0;
  material.addEventListener("dispose", () => { materialDisposals++; });
  const pressureEvicted = cache.evictUnpinned(new Set([shared]));
  assert.deepEqual(pressureEvicted.map(({ built }) => built), [pressure],
    "one remaining placement keeps the exact shared entry pinned");
  disposeGeometryEntries(pressureEvicted);

  let sharedDisposals = 0;
  shared.geometry.addEventListener("dispose", () => { sharedDisposals++; });
  const next = entry("1|parent:3#0", 0);
  cache.set(next.cacheKey, next);
  const evicted = cache.evictUnpinned(new Set());
  assert.deepEqual(evicted.map(({ built }) => built), [shared]);
  disposeGeometryEntries(evicted);
  assert.deepEqual([sharedDisposals, materialDisposals], [1, 0],
    "geometry eviction never takes the shared run material with it");
});

test("geometry-only eviction can rebuild a WMO group without disposing its material borrower", () => {
  const cache = new BuiltModelCache({ count: 1, knownBufferBytes: 1024 });
  const material = new THREE.MeshBasicMaterial();
  const old = entry("1|parent:1#7", 7);
  let oldDisposals = 0;
  old.geometry.addEventListener("dispose", () => { oldDisposals++; });
  cache.set(old.cacheKey, old);
  cache.set("pressure", entry("pressure", 0));
  disposeGeometryEntries(cache.evictUnpinned(new Set()));
  assert.equal(oldDisposals, 1);

  const rebuilt = entry(old.cacheKey, 7);
  cache.set(rebuilt.cacheKey, rebuilt);
  const mesh = new THREE.Mesh(rebuilt.geometry, material);
  assert.notEqual(mesh.geometry, old.geometry);
  assert.equal(mesh.material, material);
});

test("renderer WMO integration detaches final-demand borrowers and evicts resources post-admission", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const groupUpdate = source.slice(
    source.indexOf("  #updateWmoGroups("),
    source.indexOf("\n  /** Keep the one collision-proven room answer"),
  );
  assert.ok(groupUpdate.includes("const wanted = new Set(selected);"), "portal-refined selection is authoritative");
  assert.ok(groupUpdate.includes("node.remove(built.mesh);"));
  assert.ok(groupUpdate.includes("placed.built.delete(index);"));
  assert.ok(groupUpdate.includes("this.#wmoGeometries.get(this.#wmoGroupCacheKey(placed.model, index))"),
    "a live hit touches the exact current-parent LRU entry");

  const entryType = source.slice(
    source.indexOf("interface WmoGroupGeometryEntry {"),
    source.indexOf("\n}\n\n/** One placement-local borrower"),
  );
  assert.ok(entryType.includes("readonly cacheKey: string"));
  assert.ok(!entryType.includes("WmoModel"), "an inactive renderer entry must not retain its decoded CPU parent");
  assert.ok(!entryType.includes("readonly parent"));

  const clear = source.slice(
    source.indexOf("  #clearWmoGroups("),
    source.indexOf("\n  /** Builds and attaches only the rooms"),
  );
  assert.ok(clear.includes("node.remove(mesh)"));
  assert.ok(clear.includes("placed.built.clear()"));
  assert.ok(!clear.includes("dispose"), "detaching a wrapper does not dispose borrowed resources");
  assert.ok(!clear.includes("dropWmoLiquid"), "group demand does not own placement liquid geometry");

  const wmoEviction = source.slice(
    source.indexOf("  #evictWmoResources(): void {"),
    source.indexOf("\n\n  /**\n   * Soft-caps both built caches"),
  );
  assert.ok(wmoEviction.includes("this.#wmoGeometries.evictUnpinned(wmo.geometryPins)"));
  assert.ok(wmoEviction.includes("built.geometry.dispose()"));
  assert.ok(wmoEviction.includes("this.#worldMaterials.commitPins(materialPins)"));
  assert.ok(!wmoEviction.includes("wmoRunMaterials"));
  assert.ok(!wmoEviction.includes("material.dispose"));

  const admission = source.indexOf("this.#updateEffects(player.position, now, elapsed);");
  const eviction = source.indexOf("this.#evictWmoResources();");
  const submission = source.indexOf("this.#renderer.render(this.#skyScene, this.#camera);");
  assert.ok(admission >= 0 && admission < eviction && eviction < submission);
});

test("renderer WMO parent and session guards cover dormancy, replacement, and reset", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.equal(source.match(/model\?\.wmo === rendered\.wmo\.model/g)?.length, 2,
    "environment and game-object WMO updates both require the current exact parent");
  assert.equal(source.match(/const replacesWmo =/g)?.length, 2);
  assert.ok(source.includes("if (rendered.wmo) this.#clearWmoGroups(rendered.wmo, rendered.node);"));

  const gameObjects = source.slice(
    source.indexOf("  #updateGameObjects("),
    source.indexOf("\n  /** Releases one live game-object rig"),
  );
  const dormant = gameObjects.indexOf("if (inRange.has(guid) && !drawn.has(guid))");
  const dormantClear = gameObjects.indexOf("this.#clearWmoGroups(rendered.wmo, rendered.node)", dormant);
  const dormantHide = gameObjects.indexOf("rendered.node.visible = false", dormant);
  assert.ok(dormant >= 0 && dormant < dormantClear && dormantClear < dormantHide);

  const clearWorld = source.slice(
    source.indexOf("  clearWorldResources(): void {"),
    source.indexOf("\n  dispose(): void {"),
  );
  const borrowers = clearWorld.indexOf("this.#disposeEnvironment(rendered)");
  const materialCache = clearWorld.indexOf("this.#worldMaterials.dispose()");
  const geometries = clearWorld.indexOf("for (const entry of this.#wmoGeometries.values())");
  const reset = clearWorld.indexOf("this.#wmoModelKeys = new WeakMap<WmoModel, string>()");
  assert.ok(borrowers >= 0 && borrowers < materialCache && materialCache < geometries && geometries < reset);
  assert.equal(clearWorld.match(/this\.#worldMaterials\.dispose\(\)/g)?.length, 1);
  assert.ok(clearWorld.indexOf("this.#worldMaterialTextures = new ModelTextureLoader", materialCache)
    > materialCache);
  assert.ok(clearWorld.indexOf("this.#worldMaterials = new WorldMaterialCache", materialCache)
    > materialCache);
  assert.ok(clearWorld.includes("this.#wmoModelSerial = 0"));
});
