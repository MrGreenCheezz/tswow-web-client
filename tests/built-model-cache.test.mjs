import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import {
  BuiltModelCache,
  disposeEvictedBuiltModels,
  knownGeometryBufferBytes,
} from "../dist/code/browser/BuiltModelCache.js";

function geometry(bytes) {
  const value = new THREE.BufferGeometry();
  value.setAttribute("position", new THREE.BufferAttribute(new Uint8Array(bytes), 1));
  return value;
}

function built(bytes, overrides = {}) {
  return {
    geometry: geometry(bytes),
    materials: [],
    ownedTextures: [],
    animatedBatches: [],
    height: 1,
    texturePaths: [],
    ...overrides,
  };
}

test("known geometry bytes follow Three direct-buffer identities and exclude renderer-packed morph textures", () => {
  const value = new THREE.BufferGeometry();
  const sharedCpuArray = new Uint8Array(24);
  const position = new THREE.BufferAttribute(sharedCpuArray, 3);
  const normal = new THREE.BufferAttribute(sharedCpuArray, 3);
  value.setAttribute("position", position);
  value.setAttribute("positionAlias", position);
  value.setAttribute("normal", normal);
  value.setIndex(new THREE.BufferAttribute(new Uint16Array(3), 1));

  const interleaved = new THREE.InterleavedBuffer(new Float32Array(6), 6);
  value.setAttribute("uv", new THREE.InterleavedBufferAttribute(interleaved, 2, 0));
  value.setAttribute("colour", new THREE.InterleavedBufferAttribute(interleaved, 4, 2));
  value.morphAttributes["position"] = [new THREE.BufferAttribute(new Float32Array(3), 3)];
  value.setAttribute("instanceWeight", new THREE.InstancedBufferAttribute(new Float32Array(4), 1));

  assert.equal(knownGeometryBufferBytes(value), 24 + 24 + 6 + 24 + 16,
    "ordinary attributes are distinct uploads, aliases/interleaving are shared, and morphs are not WebGLAttributes buffers");
});

test("cache byte totals ref-count shared GPU buffer identities across entries", () => {
  const cache = new BuiltModelCache({ count: 4, knownBufferBytes: 1024 });
  const shared = built(32);
  cache.set("a", shared);
  cache.set("b", { ...shared });
  assert.deepEqual(cache.stats, {
    count: 2, knownBufferBytes: 32, overflowCount: 0, overflowKnownBufferBytes: 0,
  });
  cache.delete("a");
  assert.equal(cache.stats.knownBufferBytes, 32);
  cache.delete("b");
  assert.equal(cache.stats.knownBufferBytes, 0);
  assert.ok(Object.isFrozen(cache.stats));
});

test("retained external dependencies follow cache entries rather than only live borrowers", () => {
  const cache = new BuiltModelCache({ count: 1, knownBufferBytes: 1024 });
  const inactive = built(8);
  cache.set("inactive", inactive, ["atlas:inactive"]);
  assert.deepEqual([...cache.retainedExternalKeys()], ["atlas:inactive"]);
  assert.deepEqual(cache.evictUnpinned(new Set()), [], "an in-budget inactive build stays resident");
  assert.deepEqual([...cache.retainedExternalKeys()], ["atlas:inactive"]);

  cache.set("new", built(8), ["atlas:new"]);
  assert.deepEqual(cache.evictUnpinned(new Set()).map(({ key }) => key), ["inactive"]);
  assert.deepEqual([...cache.retainedExternalKeys()], ["atlas:new"]);
  cache.clear();
  assert.deepEqual([...cache.retainedExternalKeys()], []);
});

test("LRU eviction obeys count and byte soft caps and cache hits touch", () => {
  const byCount = new BuiltModelCache({ count: 2, knownBufferBytes: 1024 });
  const a = built(8);
  const b = built(8);
  const c = built(8);
  byCount.set("a", a).set("b", b);
  assert.equal(byCount.needsEviction, false);
  assert.equal(byCount.get("a"), a);
  byCount.set("c", c);
  assert.equal(byCount.needsEviction, true);
  assert.deepEqual(byCount.evictUnpinned(new Set()).map(({ key }) => key), ["b"]);
  assert.equal(byCount.needsEviction, false);
  assert.equal(byCount.get("a"), a);
  assert.equal(byCount.get("c"), c);

  const byBytes = new BuiltModelCache({ count: 8, knownBufferBytes: 24 });
  byBytes.set("small", built(16)).set("large", built(24));
  assert.equal(byBytes.needsEviction, true, "byte overflow requires a pin pass even below the count cap");
  assert.equal(byBytes.stats.overflowKnownBufferBytes, 16);
  assert.deepEqual(byBytes.evictUnpinned(new Set()).map(({ key }) => key), ["small"]);
  assert.equal(byBytes.needsEviction, false);
  assert.equal(byBytes.stats.knownBufferBytes, 24);
});

test("active pins may overflow, then settle after leave and rebuild cleanly on re-entry", () => {
  const cache = new BuiltModelCache({ count: 1, knownBufferBytes: 16 });
  const first = built(16);
  const leaving = built(16);
  let leavingGeometryDisposals = 0;
  leaving.geometry.addEventListener("dispose", () => { leavingGeometryDisposals++; });
  cache.set("first", first).set("look", leaving);

  assert.deepEqual(cache.evictUnpinned(new Set([first, leaving])), []);
  assert.equal(cache.needsEviction, true, "pinned overflow must be retried after a borrower leaves");
  assert.deepEqual(cache.stats, {
    count: 2, knownBufferBytes: 32, overflowCount: 1, overflowKnownBufferBytes: 16,
  });

  const evicted = cache.evictUnpinned(new Set([first]));
  assert.deepEqual(evicted.map(({ key }) => key), ["look"]);
  disposeEvictedBuiltModels(evicted, cache.values());
  assert.equal(leavingGeometryDisposals, 1);
  assert.equal(cache.stats.overflowCount, 0);
  assert.equal(cache.needsEviction, false);

  const rebuilt = built(16);
  cache.set("look", rebuilt);
  assert.equal(cache.get("look"), rebuilt);
  assert.notEqual(rebuilt.geometry, leaving.geometry);
});

test("eviction preserves resources retained by another entry and never disposes external material maps", () => {
  const sharedGeometry = geometry(12);
  const sharedMaterial = new THREE.MeshBasicMaterial();
  const sharedOwned = new THREE.Texture();
  const external = new THREE.Texture();
  sharedMaterial.map = external;
  const first = built(0, {
    geometry: sharedGeometry,
    materials: [sharedMaterial],
    ownedTextures: [sharedOwned],
  });
  const second = { ...first };
  let geometryDisposals = 0;
  let materialDisposals = 0;
  let ownedDisposals = 0;
  let externalDisposals = 0;
  sharedGeometry.addEventListener("dispose", () => { geometryDisposals++; });
  sharedMaterial.addEventListener("dispose", () => { materialDisposals++; });
  sharedOwned.addEventListener("dispose", () => { ownedDisposals++; });
  external.addEventListener("dispose", () => { externalDisposals++; });

  disposeEvictedBuiltModels([{ key: "first", built: first }], [second]);
  assert.deepEqual([geometryDisposals, materialDisposals, ownedDisposals, externalDisposals], [0, 0, 0, 0]);
  disposeEvictedBuiltModels([{ key: "second", built: second }], []);
  assert.deepEqual([geometryDisposals, materialDisposals, ownedDisposals, externalDisposals], [1, 1, 1, 0]);
});

test("eviction detaches shared attribute identities before disposing a distinct geometry wrapper", () => {
  const sharedPosition = new THREE.BufferAttribute(new Float32Array(9), 3);
  const sharedIndex = new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1);
  const sharedInterleaved = new THREE.InterleavedBuffer(new Float32Array(12), 4);
  const firstGeometry = new THREE.BufferGeometry();
  firstGeometry.setAttribute("position", sharedPosition);
  firstGeometry.setAttribute("uv", new THREE.InterleavedBufferAttribute(sharedInterleaved, 2, 0));
  firstGeometry.setAttribute("unique", new THREE.BufferAttribute(new Float32Array(3), 1));
  firstGeometry.setIndex(sharedIndex);
  const retainedGeometry = new THREE.BufferGeometry();
  retainedGeometry.setAttribute("position", sharedPosition);
  retainedGeometry.setAttribute("normal", new THREE.InterleavedBufferAttribute(sharedInterleaved, 2, 2));
  retainedGeometry.setIndex(sharedIndex);

  let disposed = 0;
  firstGeometry.addEventListener("dispose", () => {
    disposed++;
    assert.equal(firstGeometry.getAttribute("position"), undefined);
    assert.equal(firstGeometry.getAttribute("uv"), undefined);
    assert.equal(firstGeometry.index, null);
    assert.ok(firstGeometry.getAttribute("unique"), "entry-owned direct buffers still reach disposal");
  });
  const first = built(0, { geometry: firstGeometry });
  const retained = built(0, { geometry: retainedGeometry });
  disposeEvictedBuiltModels([{ key: "first", built: first }], [retained]);
  assert.equal(disposed, 1);
  assert.equal(retainedGeometry.getAttribute("position"), sharedPosition);
  assert.equal(retainedGeometry.getAttribute("normal").data, sharedInterleaved);
  assert.equal(retainedGeometry.index, sharedIndex);
});

test("clear resets the exact ledger idempotently", () => {
  const cache = new BuiltModelCache({ count: 1, knownBufferBytes: 1 });
  cache.set("large", built(32));
  assert.equal(cache.stats.overflowKnownBufferBytes, 31);
  cache.clear();
  cache.clear();
  assert.equal(cache.needsEviction, false);
  assert.deepEqual(cache.stats, {
    count: 0, knownBufferBytes: 0, overflowCount: 0, overflowKnownBufferBytes: 0,
  });
});

test("production eviction is post-admission and pins exact renderer borrower identities", async () => {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const updates = source.indexOf("this.#updateVisuals(now, elapsed, environmentClient);");
  const eviction = source.indexOf("this.#evictBuiltModelCaches();");
  const submission = source.indexOf("this.#renderer.render(this.#skyScene, this.#camera);");
  assert.ok(updates >= 0 && updates < eviction && eviction < submission);
  for (const pin of [
    "this.#skyboxBuilt", "rendered.built", "entry.built", "unit.built", "unit.mount.built",
    'node.userData["builtModel"]', "this.#portraits.liveBuilds()",
  ]) assert.ok(source.includes(pin), `missing exact borrower pin: ${pin}`);
  assert.ok(source.includes("this.#skinnedTemplates.delete(entry.key)"));
  const evictionBody = source.slice(source.indexOf("  #evictBuiltModelCaches(): void {"), source.indexOf("\n  #drawUnit("));
  const retainedPortraitPin = evictionBody.indexOf("this.#portraits.retainedBuilds()");
  const retainedPortraitAtlasPin = evictionBody.indexOf("this.#portraits.retainedBuildKeys()");
  const prospectivePortraitGate = evictionBody.indexOf("if (!this.#formalBenchmarkIsolation)");
  assert.ok(retainedPortraitPin >= 0
    && retainedPortraitAtlasPin > retainedPortraitPin
    && prospectivePortraitGate > retainedPortraitAtlasPin,
  "physically retained portrait roots keep both their build and external atlas alive during isolation");
  const unitEviction = evictionBody.indexOf("this.#builtUnits.evictUnpinned(unitPins)");
  const retainedBuildAtlases = evictionBody.indexOf("this.#builtUnits.retainedExternalKeys()");
  const inactiveAtlasPrune = evictionBody.indexOf("atlases?.pruneInactiveWork(activeAtlases)");
  const atlasPrune = evictionBody.indexOf("atlases?.commitPins(liveAtlases, activeAtlases)");
  assert.ok(unitEviction >= 0 && retainedBuildAtlases > unitEviction
    && inactiveAtlasPrune > retainedBuildAtlases && atlasPrune > inactiveAtlasPrune,
    "every retained unit build keeps its external atlas dependency through pruning");
  assert.ok(source.includes("this.#atlasFrameDemands.add(key)")
    && evictionBody.includes("for (const key of this.#atlasFrameDemands)"),
  "a current no-paint unit pins its prospective raw atlas key before unit.applied exists");
  assert.ok(source.includes("this.#atlasFrameActive.add(rendered.applied)")
    && evictionBody.includes("for (const key of this.#atlasFrameActive) activeAtlases.add(key)"),
  "readiness follows appearances admitted through the current draw pass, not every dormant unit");
  assert.match(evictionBody,
    /retainedBuildKeys\(\)[\s\S]*if \(!this\.#formalBenchmarkIsolation\) activeAtlases\.add\(key\)/,
    "physical portrait roots always pin residency but do not enter formal-isolated readiness");
});

test("P1-10b: peek reads without touching and epoch moves only on set, delete and clear", () => {
  const cache = new BuiltModelCache({ count: 2, knownBufferBytes: 1024 });
  const a = built(8);
  const b = built(8);
  const start = cache.epoch;
  cache.set("a", a).set("b", b);
  assert.ok(cache.epoch > start, "set moves the epoch");
  let epoch = cache.epoch;
  assert.equal(cache.get("b"), b);
  assert.equal(cache.peek("a"), a, "peeked after b was touched: a stamp here would make b the oldest");
  assert.equal(cache.peek("missing"), undefined);
  assert.equal(cache.epoch, epoch, "get and peek leave the epoch alone");
  cache.set("c", built(8));
  assert.deepEqual(cache.evictUnpinned(new Set()).map(({ key }) => key), ["a"],
    "a peeked entry is still the oldest");
  epoch = cache.epoch;
  assert.equal(cache.delete("b"), true);
  assert.ok(cache.epoch > epoch, "delete moves the epoch");
  epoch = cache.epoch;
  assert.equal(cache.delete("b"), false);
  assert.equal(cache.epoch, epoch, "deleting nothing changes nothing");
  cache.clear();
  assert.ok(cache.epoch > epoch, "clear moves the epoch");
  assert.equal(cache.evictUnpinned(new Set()).length, 0);
});
