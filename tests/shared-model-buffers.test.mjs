import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import { buildModel, geosetList } from "../dist/code/browser/ModelBuild.js";
import { SharedModelBuffers } from "../dist/code/browser/SharedModelBuffers.js";
import { BuiltModelCache, disposeEvictedBuiltModels } from "../dist/code/browser/BuiltModelCache.js";

const batch = (submesh, texture = 0) => ({ submesh, blendMode: 0, materialFlags: 0,
  priorityPlane: 0, materialLayer: 0, textures: [texture], uvSets: [0], shaderId: 0,
  colorIndex: 65535, textureWeight: -1, textureTransform: -1 });

function model() {
  return {
    positions: Float32Array.from({ length: 36 }, (_, index) => index / 10),
    normals: new Float32Array(36), uv0: new Float32Array(24), uv1: new Float32Array(24),
    boneIndices: new Uint8Array(48), boneWeights: Float32Array.from({ length: 48 }, (_, index) => index % 4 === 0 ? 1 : 0),
    indices: Uint16Array.from({ length: 12 }, (_, index) => index),
    // Two geosets: an appearance picks one of them (100 or 200) besides the body.
    submeshes: [0, 100, 200, 0].map((geosetId, index) => ({ geosetId, indexStart: index * 3, indexCount: 3 })),
    batches: [batch(0), batch(1), batch(2), batch(3, 1)],
    textures: [{ type: 0, flags: 0, path: "Body.blp" }, { type: 0, flags: 0, path: "Cape.blp" }],
    attachments: [], bounds: { min: [0, 0, 0], max: [1, 1, 2], radius: 2 },
    colours: [], textureWeights: [], textureTransforms: [], globalSequences: new Uint32Array(),
  };
}

const VERTEX = ["position", "normal", "uv", "uv1", "skinIndex", "skinWeight"];

function build(source, geoset, sharedBuffers, skinned = true) {
  return buildModel(source, { modelPath: "Character/Test.m2", baseUrl: "http://test", skinned,
    geosets: geosetList([0, geoset]), coalesceAdjacentBatches: true, ...(sharedBuffers ? { sharedBuffers } : {}),
    loadTexture(url) { const texture = new THREE.Texture(); texture.name = url; return texture; } });
}

test("two appearances of one model share its vertex attributes; each owns its index", () => {
  const source = model();
  const store = new SharedModelBuffers();
  const a = build(source, 100, store), b = build(source, 200, store);
  for (const name of VERTEX) {
    assert.ok(a.geometry.getAttribute(name), name);
    assert.strictEqual(a.geometry.getAttribute(name), b.geometry.getAttribute(name), `${name} is one object`);
  }
  assert.notStrictEqual(a.geometry, b.geometry);
  assert.notStrictEqual(a.geometry.index, b.geometry.index);
  assert.notDeepEqual([...a.geometry.index.array], [...b.geometry.index.array], "different geosets, different indices");
  assert.deepEqual(store.stats, { models: 1, reused: 1 });
  // Without a store, every build wraps the arrays again — as before.
  const c = build(source, 100), d = build(source, 100);
  assert.notStrictEqual(c.geometry.getAttribute("position"), d.geometry.getAttribute("position"));
  assert.strictEqual(c.geometry.getAttribute("position").array, d.geometry.getAttribute("position").array);
});

test("the skin pair joins when the first skinned build asks; an unskinned build leaves it off", () => {
  const source = model();
  const store = new SharedModelBuffers();
  const plain = build(source, 100, store, false);
  assert.equal(plain.geometry.getAttribute("skinIndex"), undefined);
  const skinned = build(source, 200, store, true);
  assert.ok(skinned.geometry.getAttribute("skinIndex"));
  assert.strictEqual(plain.geometry.getAttribute("position"), skinned.geometry.getAttribute("position"));
  assert.equal(build(source, 100, store, false).geometry.getAttribute("skinIndex"), undefined);
});

test("evicting one appearance keeps the shared attributes on the other; the last takes them", () => {
  const source = model();
  const store = new SharedModelBuffers();
  const cache = new BuiltModelCache({ count: 8, knownBufferBytes: 1e9 });
  const a = build(source, 100, store), b = build(source, 200, store);
  cache.set("a", a);
  cache.set("b", b);
  const removed = [];
  const watch = (built) => built.geometry.addEventListener("dispose", () => removed.push(
    Object.keys(built.geometry.attributes).sort().join(",")));
  watch(a);
  watch(b);
  disposeEvictedBuiltModels([{ key: "a", built: a }], [b]);
  assert.deepEqual(removed, [""], "the dying wrapper was stripped of every shared attribute before dispose");
  for (const name of VERTEX) assert.ok(b.geometry.getAttribute(name), `${name} stays on the live wrapper`);
  disposeEvictedBuiltModels([{ key: "b", built: b }], []);
  assert.equal(removed.length, 2);
  assert.match(removed[1], /position/, "the last wrapper disposes with its attributes, so their GL buffers go");
});

test("known buffer bytes count a shared attribute once", () => {
  const source = model();
  const store = new SharedModelBuffers();
  const shared = new BuiltModelCache({ count: 8, knownBufferBytes: 1e9 });
  const apart = new BuiltModelCache({ count: 8, knownBufferBytes: 1e9 });
  for (const geoset of [100, 200]) {
    shared.set(`s${geoset}`, build(source, geoset, store));
    apart.set(`a${geoset}`, build(source, geoset));
  }
  const vertexBytes = source.positions.byteLength + source.normals.byteLength + source.uv0.byteLength
    + source.uv1.byteLength + source.boneIndices.byteLength + source.boneWeights.byteLength;
  assert.equal(apart.stats.knownBufferBytes - shared.stats.knownBufferBytes, vertexBytes);
});

test("only the unit cache builds through the store", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /\.\.\.\(cache === this\.#builtUnits \? \{ sharedBuffers: this\.#modelBuffers \} : \{\}\),/);
  assert.match(source, /this\.#builtUnits\.clear\(\);\s+this\.#modelBuffers = new SharedModelBuffers\(\);/,
    "a new store with every cache drop: the old attributes' GL buffers went with the builds");
  assert.equal(source.match(/sharedBuffers:/g)?.length, 1);
});
